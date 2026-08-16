/**
 * `/api/brief?date=` and `/api/brief?index` (plan 38 task 6).
 *
 *     node workers/orbit-ingest/test/brief-index.test.mjs
 *
 * The archive/index writer is `rebuildIndex`/`archiveKey` in
 * `workers/orbit-ingest/src/brief.js`, already covered by `brief.test.mjs`.
 * This file covers the READ side added on top of it: `functions/api/brief.js`
 * must serve an archived day, the index, and preserve the no-D1-fallback
 * invariant for both new query forms exactly as it already does for the
 * default `latest.json` read.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');

const { onRequest: brief } = await import(pathToFileURL(path.join(ROOT, 'functions/api/brief.js')));
const { archiveKey, BRIEF_INDEX_KEY } = await import(pathToFileURL(path.join(HERE, '../src/brief.js')));

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS  ' + name); }
  catch (e) { results.push(false); console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); }
}

const get = (url) => new Request(url);
const body = async (resp) => JSON.parse(await resp.text());

/** An R2 double that never touches D1 — the read path must not need it. */
function fakeR2(objects = {}) {
  return {
    async get(key) {
      const v = objects[key];
      return v === undefined ? null : { text: async () => (typeof v === 'string' ? v : JSON.stringify(v)) };
    },
  };
}

const queryingD1 = { prepare() { throw new Error('the read path must not query D1'); } };

const LATEST = {
  generated_at: '2026-08-03T00:00:00.000Z',
  facts: { tracked_on_orbit: 31700, new_objects: 5 },
  narrative: 'Five objects were newly catalogued today.',
  narrative_status: 'ok',
  narrative_source: 'ai',
};

const OLD_DAY = {
  generated_at: '2026-07-20T00:00:00.000Z',
  facts: { tracked_on_orbit: 31600, new_objects: 2 },
  narrative: null,
  narrative_status: 'disabled',
  narrative_source: 'none',
};

const MANUAL_DAY = {
  generated_at: '2026-07-25T00:00:00.000Z',
  facts: { tracked_on_orbit: 31650, new_objects: 1 },
  narrative: 'Edited by an operator to correct a phrasing issue.',
  narrative_status: 'ok',
  narrative_source: 'manual',
};

const INDEX = {
  generated_at: '2026-08-03T00:10:00.000Z',
  total: 3,
  days: [
    { date: '2026-08-03', new_objects: 5, decays: 0, narrative_source: 'ai', headline: 'Five objects were newly catalogued today.' },
    { date: '2026-07-25', new_objects: 1, decays: 0, narrative_source: 'manual', headline: 'Edited by an operator to correct a phrasing issue.' },
    { date: '2026-07-20', new_objects: 2, decays: 1, narrative_source: 'none', headline: null },
  ],
};

/* ── ?date= ─────────────────────────────────────────────────────────────── */

console.log('\n-- /api/brief?date= --');

await test('an archived day is served by date, distinct from latest.json', async () => {
  const r2 = fakeR2({ 'brief/latest.json': LATEST, [archiveKey('2026-07-20')]: OLD_DAY });
  const j = await body(await brief({
    request: get('https://x/api/brief?date=2026-07-20'), env: { ORBIT_DB: queryingD1, ORBIT_R2: r2 } }));
  assert.equal(j.available, true);
  assert.equal(j.facts.new_objects, 2);
  assert.notEqual(j.facts.new_objects, LATEST.facts.new_objects, 'must not silently fall back to latest');
});

await test('latest.json is unaffected by an archive lookup and stays current', async () => {
  const r2 = fakeR2({ 'brief/latest.json': LATEST, [archiveKey('2026-07-20')]: OLD_DAY });
  const j = await body(await brief({ request: get('https://x/api/brief'), env: { ORBIT_R2: r2 } }));
  assert.equal(j.facts.new_objects, LATEST.facts.new_objects);
});

await test('a missing day is available:false at 200, not 404 — not built yet is normal', async () => {
  const r2 = fakeR2({ 'brief/latest.json': LATEST });
  const r = await brief({
    request: get('https://x/api/brief?date=2026-01-01'), env: { ORBIT_DB: queryingD1, ORBIT_R2: r2 } });
  assert.equal(r.status, 200);
  const j = await body(r);
  assert.equal(j.available, false);
  assert.match(j.note, /No brief was built for that day/);
});

await test('a malformed date is a 400, never treated as a lookup key', async () => {
  const r2 = fakeR2({ 'brief/latest.json': LATEST });
  const r = await brief({ request: get('https://x/api/brief?date=not-a-date'), env: { ORBIT_R2: r2 } });
  assert.equal(r.status, 400);
  const j = await body(r);
  assert.equal(j.available, false);
});

await test('the read path never touches D1 for an archived day either', async () => {
  const r2 = fakeR2({ [archiveKey('2026-07-20')]: OLD_DAY });
  const j = await body(await brief({
    request: get('https://x/api/brief?date=2026-07-20'), env: { ORBIT_DB: queryingD1, ORBIT_R2: r2 } }));
  assert.equal(j.available, true); // would have thrown from queryingD1 if it were consulted
});

await test('narrative_source round-trips "manual" through the archive read', async () => {
  const r2 = fakeR2({ [archiveKey('2026-07-25')]: MANUAL_DAY });
  const j = await body(await brief({ request: get('https://x/api/brief?date=2026-07-25'), env: { ORBIT_R2: r2 } }));
  assert.equal(j.narrative_source, 'manual');
  assert.equal(j.narrative, MANUAL_DAY.narrative);
});

await test('a corrupt archived day says so rather than serving an empty card', async () => {
  const r2 = fakeR2({ [archiveKey('2026-07-20')]: 'not json{' });
  const j = await body(await brief({ request: get('https://x/api/brief?date=2026-07-20'), env: { ORBIT_R2: r2 } }));
  assert.equal(j.available, false);
  assert.match(j.note, /could not be parsed/);
});

/* ── ?index ─────────────────────────────────────────────────────────────── */

console.log('\n-- /api/brief?index --');

await test('the index is served whole, newest day first', async () => {
  const r2 = fakeR2({ [BRIEF_INDEX_KEY]: INDEX });
  const j = await body(await brief({
    request: get('https://x/api/brief?index'), env: { ORBIT_DB: queryingD1, ORBIT_R2: r2 } }));
  assert.equal(j.available, true);
  assert.equal(j.total, 3);
  assert.equal(j.days.length, 3);
  assert.equal(j.days[0].date, '2026-08-03');
});

await test('the index respects the 90-day cap already enforced by rebuildIndex', async () => {
  const days = Array.from({ length: 90 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 0, 1) + i * 86400_000).toISOString().slice(0, 10),
    new_objects: i, decays: 0, narrative_source: 'none', headline: null,
  })).reverse();
  const r2 = fakeR2({ [BRIEF_INDEX_KEY]: { generated_at: LATEST.generated_at, total: 130, days } });
  const j = await body(await brief({ request: get('https://x/api/brief?index'), env: { ORBIT_R2: r2 } }));
  assert.equal(j.days.length, 90, 'the endpoint serves the index as built, capped at 90');
  assert.equal(j.total, 130, '`total` still reports every archived day, capped or not');
});

await test('a missing index is available:false at 200, not an error', async () => {
  const r2 = fakeR2({});
  const r = await brief({ request: get('https://x/api/brief?index'), env: { ORBIT_DB: queryingD1, ORBIT_R2: r2 } });
  assert.equal(r.status, 200);
  const j = await body(r);
  assert.equal(j.available, false);
  assert.deepEqual(j.days, []);
});

await test('a corrupt index says so rather than serving a broken list', async () => {
  const r2 = fakeR2({ [BRIEF_INDEX_KEY]: 'not json{' });
  const j = await body(await brief({ request: get('https://x/api/brief?index'), env: { ORBIT_R2: r2 } }));
  assert.equal(j.available, false);
  assert.match(j.note, /could not be parsed/);
});

await test('?index takes precedence over ?date if both are somehow present', async () => {
  const r2 = fakeR2({ [BRIEF_INDEX_KEY]: INDEX, [archiveKey('2026-07-20')]: OLD_DAY });
  const j = await body(await brief({
    request: get('https://x/api/brief?index&date=2026-07-20'), env: { ORBIT_R2: r2 } }));
  assert.equal(j.total, 3, 'index shape, not a day-card shape');
});

/* ── citation parity ───────────────────────────────────────────────────── */

console.log('\n-- citation parity --');

await test('every new response carries the X-Data-Source header and body citation', async () => {
  const r2 = fakeR2({ [archiveKey('2026-07-20')]: OLD_DAY, [BRIEF_INDEX_KEY]: INDEX });
  for (const url of ['https://x/api/brief?date=2026-07-20', 'https://x/api/brief?index',
                     'https://x/api/brief?date=1999-01-01']) {
    const r = await brief({ request: get(url), env: { ORBIT_R2: r2 } });
    assert.ok(r.headers.get('x-data-source'), `missing citation header for ${url}`);
    const j = await body(r.clone ? r.clone() : r);
    assert.ok(j.citation, `missing body citation for ${url}`);
  }
});

/* ── Report ─────────────────────────────────────────────────────────────── */

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
