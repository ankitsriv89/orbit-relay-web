/**
 * Pipeline orchestration — four resumable stages, per-step failure isolation.
 *
 *     node --no-warnings workers/orbit-profiles/test/pipeline.test.mjs
 *
 * Mirrors workers/orbit-ingest/src/index.js's step() pattern: a stage that
 * throws is captured, the run continues, the report records it. A stuck image
 * fetch must not cost the prose that was already generated. A resumed run
 * starts from the checkpoint and does not reprocess earlier NORADs.
 *
 * The real stages hit D1/R2/Groq; here they are injected via opts.stages, and
 * the checkpoint store via opts.checkpointIO, so the orchestration is tested
 * without any of that.
 */
import assert from 'node:assert/strict';
import { runProfiles, STAGES } from '../src/index.js';

const results = [];
function test(name, fn) {
  Promise.resolve().then(fn)
    .then(() => { results.push(true); console.log('  PASS  ' + name); })
    .catch((e) => { results.push(false); console.log('  FAIL  ' + name + '\n        ' + e.message); });
}

/** opts wiring a checkpoint Map + injected stage impls. */
function harness(stages, checkpoints = {}) {
  const cp = new Map(Object.entries(checkpoints));
  return {
    cp,
    opts: {
      stages,
      checkpointIO: {
        read: async (_db, stage) => cp.get(stage) ?? 0,
        write: async (_db, stage, norad) => { cp.set(stage, norad); },
      },
    },
  };
}
const ENV = { PROFILE_DB: {}, ORBIT_R2: {}, ORBIT_AI: null };

console.log('\n-- the four stages --');

test('STAGES is exactly match, facts, prose, images in order', () => {
  assert.deepEqual(STAGES, ['match', 'facts', 'prose', 'images']);
});

console.log('\n-- a failing stage does not abort the rest --');

test('a stage that throws is marked failed; later stages still run', async () => {
  const ran = [];
  const { opts } = harness({
    match: async () => { ran.push('match'); return { processed: 10 }; },
    facts: async () => { ran.push('facts'); throw new Error('D1 down'); },
    prose: async () => { ran.push('prose'); return { processed: 8 }; },
    images: async () => { ran.push('images'); return { processed: 3 }; },
  });
  const report = await runProfiles(ENV, opts);
  assert.deepEqual(ran, ['match', 'facts', 'prose', 'images']);
  assert.equal(report.ok, false);
  const facts = report.steps.find((s) => s.name === 'facts');
  assert.equal(facts.ok, false);
  assert.match(facts.error, /D1 down/);
  assert.ok(report.steps.find((s) => s.name === 'prose').ok);
});

test('an all-clean run reports ok', async () => {
  const { opts } = harness({
    match: async () => ({ processed: 1 }), facts: async () => ({ processed: 1 }),
    prose: async () => ({ processed: 1 }), images: async () => ({ processed: 1 }),
  });
  const report = await runProfiles(ENV, opts);
  assert.equal(report.ok, true);
  assert.equal(report.steps.length, 4);
});

console.log('\n-- resuming from a checkpoint --');

test('a stage receives its checkpoint as the starting NORAD', async () => {
  const seen = {};
  const { opts } = harness({
    match: async (ctx) => { seen.match = ctx.fromNorad; return { processed: 0 }; },
    facts: async (ctx) => { seen.facts = ctx.fromNorad; return { processed: 0 }; },
    prose: async (ctx) => { seen.prose = ctx.fromNorad; return { processed: 0 }; },
    images: async (ctx) => { seen.images = ctx.fromNorad; return { processed: 0 }; },
  }, { match: 5000, prose: 9000 });
  await runProfiles(ENV, opts);
  assert.equal(seen.match, 5000);
  assert.equal(seen.facts, 0);
  assert.equal(seen.prose, 9000);
});

test('a completed stage advances its checkpoint; a failed stage does not', async () => {
  const { opts, cp } = harness({
    match: async (ctx) => { await ctx.checkpoint(20000); return { processed: 5 }; },
    facts: async () => { throw new Error('boom'); },
    prose: async () => ({ processed: 0 }),
    images: async () => ({ processed: 0 }),
  });
  await runProfiles(ENV, opts);
  assert.equal(cp.get('match'), 20000);
  assert.ok(!cp.has('facts'));
});

console.log('\n-- chunking by NORAD range --');

test('a toNorad bound is passed through to each stage', async () => {
  let bound = null;
  const { opts } = harness({
    match: async (ctx) => { bound = ctx.toNorad; return { processed: 0 }; },
    facts: async () => ({ processed: 0 }), prose: async () => ({ processed: 0 }),
    images: async () => ({ processed: 0 }),
  });
  await runProfiles(ENV, { ...opts, toNorad: 15000 });
  assert.equal(bound, 15000);
});

test('a single stage can be selected with { only }', async () => {
  const ran = [];
  const { opts } = harness({
    match: async () => { ran.push('match'); return { processed: 0 }; },
    facts: async () => { ran.push('facts'); return { processed: 0 }; },
    prose: async () => { ran.push('prose'); return { processed: 0 }; },
    images: async () => { ran.push('images'); return { processed: 0 }; },
  });
  await runProfiles(ENV, { ...opts, only: 'prose' });
  assert.deepEqual(ran, ['prose']);
});

process.on('exit', () => {
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  if (passed !== results.length) process.exitCode = 1;
});
