/**
 * Ingest modules — no network, no wrangler, no D1.
 *
 *     node workers/orbit-ingest/test/ingest.test.mjs
 *
 * Everything upstream is the committed fixtures, which is deliberate: GP is
 * capped at one call per hour and iterating an ingest script means running it
 * dozens of times, so the test suite must never touch Space-Track.
 *
 * What these assert is the behaviour that would otherwise be discovered in
 * production, at a 6-hourly cadence, silently:
 *
 *   - the delta streams and upserts in bounded batches rather than buffering;
 *   - the budget guard still fires on the streaming path;
 *   - a bootstrap-sized run does not emit 28,000 feed events;
 *   - the SATCAT cursor advances, and survives a cleared KV;
 *   - a decayed object is written back onto `objects`, so it stops being
 *     served in the group bundles as if still on orbit;
 *   - boxscore's delete and reload ship in one transaction.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fakeDB, fakeKV, fakeR2, matching, chunkedResponse } from './fakes.mjs';
import { MAX_CALLS_PER_HOUR } from '../src/spacetrack.js';
import { ingestGP } from '../src/ingest-gp.js';
import { ingestSatcat } from '../src/ingest-satcat.js';
import { ingestDecay } from '../src/ingest-decay.js';
import { ingestBoxscore } from '../src/ingest-boxscore.js';
import { buildGroupArtifacts, GROUPS, CITATION } from '../src/derive.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const raw = (n) => fs.readFileSync(path.join(HERE, '../fixtures', n), 'utf8');
const fixture = (n) => JSON.parse(raw(n));

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS  ' + name); }
  catch (e) { results.push(false); console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); }
}

/* ── Harness ────────────────────────────────────────────────────────────── */

/**
 * @param {object} opts
 * @param {string} opts.body      the upstream payload for the query
 * @param {function} [opts.respond] D1 read responses, see fakes.fakeDB
 * @param {number} [opts.chunk]   response chunk size, to exercise the streamer
 */
function makeEnv({ body = '[]', respond, chunk = 1024, kv = {} } = {}) {
  const apiCalls = [];
  const db = fakeDB((sql, args) => {
    if (/COUNT\(\*\) AS n FROM api_calls/i.test(sql)) {
      return { n: apiCalls.filter((c) => c.ts > args[0]).length };
    }
    return respond ? respond(sql, args) : undefined;
  });

  // Track api_calls inserts so the budget guard reads real arithmetic.
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const stmt = prepare(sql);
    const run = stmt.run.bind(stmt);
    stmt.run = async () => {
      if (/^INSERT INTO api_calls/i.test(sql)) apiCalls.push({ ts: stmt.args[0] });
      return run();
    };
    return stmt;
  };

  const env = {
    ORBIT_DB: db,
    ORBIT_KV: fakeKV({ 'spacetrack:cookie': 'chocolatechip=test', ...kv }),
    ORBIT_R2: fakeR2(),
    SPACETRACK_IDENTITY: 'someone@example.com',
    SPACETRACK_PASSWORD: 'hunter2',
    apiCalls,
  };

  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return chunkedResponse(body, chunk);
  };
  env.seen = seen;
  return env;
}

/* ── GP ─────────────────────────────────────────────────────────────────── */

console.log('\n-- GP delta --');

await test('every fixture object is upserted, in batches, from a chunked stream', async () => {
  const env = makeEnv({ body: raw('sample_gp.json'), chunk: 97 });
  const out = await ingestGP(env);

  assert.equal(out.rows, 20);
  assert.equal(out.written, 20);
  const upserts = matching(env.ORBIT_DB, /INSERT INTO objects/);
  assert.equal(upserts.length, 20);
  assert.ok(upserts.every((s) => s.batched), 'upserts must go through batch()');
});

await test('the request asks for JSON and carries NO predicates projection', async () => {
  // Found in production 2026-07-27: a predicates/ projection on class/gp with
  // format/json comes back with TLE_LINE0/1/2 silently absent, even when they
  // are listed. GP always takes the full record now — see spacetrack.js.
  const env = makeEnv({ body: '[]' });
  await ingestGP(env);
  const url = env.seen.find((u) => u.includes('/basicspacedata/'));
  assert.ok(!url.includes('predicates/'), url);
  assert.match(url, /format\/json/);
  assert.ok(!url.includes('format/tle'), url);
});

await test('the delta window matches the 6-hourly cron, not the 1-hour example', async () => {
  const env = makeEnv({ body: '[]' });
  await ingestGP(env);
  const url = env.seen.find((u) => u.includes('/basicspacedata/'));
  assert.match(url, /CREATION_DATE\/%3Enow-0\.28/);
});

await test('the api_calls row is closed out with the streamed row count', async () => {
  const env = makeEnv({ body: raw('sample_gp.json') });
  await ingestGP(env);
  const close = matching(env.ORBIT_DB, /UPDATE api_calls/).pop();
  assert.ok(close, 'no api_calls completion');
  assert.equal(close.args[1], 20, 'row count');
});

await test('the budget guard still fires on the streaming path', async () => {
  const env = makeEnv({ body: '[]' });
  for (let i = 0; i < MAX_CALLS_PER_HOUR; i++) env.apiCalls.push({ ts: Date.now() });
  await assert.rejects(() => ingestGP(env), /budget guard/);
  assert.equal(env.seen.length, 0, 'no request may be sent after the abort');
});

await test('a runaway response is cut off rather than allowed to run the invocation dry', async () => {
  // 40k+ rows means the window predicate was lost and we are pulling history.
  const rows = Array.from({ length: 40001 }, (_, i) => ({ NORAD_CAT_ID: i + 1 }));
  const env = makeEnv({ body: JSON.stringify(rows) });
  await assert.rejects(() => ingestGP(env), /aborted at 40000 rows/);
});

await test('a handful of new objects each produce a feed event', async () => {
  const fresh = [
    { NORAD_CAT_ID: 99001, OBJECT_NAME: 'NEWSAT 1', OBJECT_TYPE: 'PAYLOAD' },
    { NORAD_CAT_ID: 99002, OBJECT_NAME: 'NEWSAT 2', OBJECT_TYPE: 'PAYLOAD' },
  ];
  const env = makeEnv({
    body: raw('sample_gp.json'),
    respond: (sql) => (/FROM objects WHERE first_seen/.test(sql) ? { results: fresh } : undefined),
  });
  const out = await ingestGP(env);

  assert.equal(out.newObjects, 2);
  const events = matching(env.ORBIT_DB, /INSERT OR IGNORE INTO events/);
  assert.equal(events.length, 2);
  assert.equal(events[0].args[1], 'new_object');
  assert.equal(events[0].args[2], 99001);
});

await test('a bootstrap-sized run records ONE seed event, not 28,000', async () => {
  // Otherwise the first run buries the signal feed under a meaningless flood.
  const fresh = Array.from({ length: 28000 }, (_, i) => ({
    NORAD_CAT_ID: i + 1, OBJECT_NAME: `OBJ ${i}`,
  }));
  const env = makeEnv({
    body: '[]',
    respond: (sql) => (/FROM objects WHERE first_seen/.test(sql) ? { results: fresh } : undefined),
  });
  await ingestGP(env);

  const events = matching(env.ORBIT_DB, /INSERT OR IGNORE INTO events/);
  assert.equal(events.length, 1);
  assert.equal(events[0].args[1], 'catalog_seed');
});

await test('new-object detection keys on this run\'s timestamp', async () => {
  const env = makeEnv({ body: raw('sample_gp.json') });
  await ingestGP(env);
  const probe = matching(env.ORBIT_DB, /FROM objects WHERE first_seen/)[0];
  assert.ok(probe, 'no first_seen probe');
  // Same value the upsert wrote — one equality query instead of holding 28k
  // ids in memory to diff against.
  const upsert = matching(env.ORBIT_DB, /INSERT INTO objects/)[0];
  assert.equal(probe.args[0], upsert.args[upsert.args.length - 2]);
});

/* ── SATCAT ─────────────────────────────────────────────────────────────── */

console.log('\n-- SATCAT delta --');

await test('the cursor advances to the highest FILE seen', async () => {
  const env = makeEnv({ body: raw('sample_satcat.json'), kv: { 'satcat:file': '9000' } });
  const out = await ingestSatcat(env);
  const max = Math.max(...fixture('sample_satcat.json').map((r) => Number(r.FILE)));
  assert.equal(out.cursor, max);
  assert.equal(await env.ORBIT_KV.get('satcat:file'), String(max));
});

await test('the query asks only for records past the cursor', async () => {
  const env = makeEnv({ body: '[]', kv: { 'satcat:file': '12345' } });
  await ingestSatcat(env);
  assert.match(env.seen[0], /FILE\/%3E12345/);
});

await test('a cleared KV falls back to the table, not to a full re-download', async () => {
  const env = makeEnv({
    body: '[]',
    respond: (sql) => (/MAX\(FILE\)/.test(sql) ? { f: 4242 } : undefined),
  });
  await ingestSatcat(env);
  assert.match(env.seen[0], /FILE\/%3E4242/);
});

await test('decayed objects are written back onto the objects table', async () => {
  // Without this they sit in `objects` with a NULL DECAY_DATE forever and keep
  // appearing in the group bundles as if still on orbit — the GP query filters
  // decay_date/null-val, so it never reports the transition.
  const env = makeEnv({ body: raw('sample_satcat.json') });
  const out = await ingestSatcat(env);
  const marks = matching(env.ORBIT_DB, /UPDATE objects SET DECAY_DATE/);
  const expected = fixture('sample_satcat.json').filter((r) => r.DECAY).length;
  assert.ok(expected > 0, 'fixture has no decayed objects to check');
  assert.equal(out.marked, expected);
  assert.equal(marks.length, expected);
  assert.match(marks[0].sql, /DECAY_DATE IS NULL/, 'must not overwrite a known decay date');
});

await test('a changed watched field produces one satcat_change event', async () => {
  const rows = fixture('sample_satcat.json').slice(0, 2);
  const env = makeEnv({
    body: JSON.stringify(rows),
    respond: (sql) => (/FROM satcat\s+WHERE NORAD_CAT_ID IN/.test(sql)
      ? { results: [{ NORAD_CAT_ID: rows[0].NORAD_CAT_ID, OBJECT_NAME: 'OLD NAME',
                      DECAY: rows[0].DECAY, CURRENT: rows[0].CURRENT,
                      COUNTRY: rows[0].COUNTRY, RCS_SIZE: rows[0].RCS_SIZE }] }
      : undefined),
  });
  const out = await ingestSatcat(env);
  assert.equal(out.changes, 1);
  const ev = matching(env.ORBIT_DB, /INSERT OR IGNORE INTO events/)[0];
  assert.equal(ev.args[1], 'satcat_change');
  assert.match(ev.args[4], /OLD NAME/);
});

await test('an object absent from our satcat is not reported as "changed"', async () => {
  // It is a debut, and the GP ingest owns debuts. Reporting it here would
  // double-post every new object into the feed.
  const env = makeEnv({ body: raw('sample_satcat.json') });
  const out = await ingestSatcat(env);
  assert.equal(out.changes, 0);
});

/* ── Decay ──────────────────────────────────────────────────────────────── */

console.log('\n-- decay + reentry --');

const decayRows = [
  { NORAD_CAT_ID: '60001', OBJECT_NAME: 'DEBRIS A', MSG_EPOCH: '2026-07-25 12:00:00',
    DECAY_EPOCH: '2026-07-26 04:12:00', SOURCE: 'decay_msg', MSG_TYPE: 'Historical' },
];
const predictionRows = [
  { NORAD_CAT_ID: '60002', OBJECT_NAME: 'ROCKET B', MSG_EPOCH: '2026-07-22 12:00:00',
    DECAY_EPOCH: '2026-08-30 00:00:00', SOURCE: '60day_msg', MSG_TYPE: 'Prediction' },
];

await test('the daily feed writes DECAY_DATE back onto the object', async () => {
  const env = makeEnv({ body: JSON.stringify(decayRows) });
  const out = await ingestDecay(env, 'daily');
  assert.equal(out.marked, 1);
  const mark = matching(env.ORBIT_DB, /UPDATE objects SET DECAY_DATE/)[0];
  assert.equal(mark.args[0], '2026-07-26', 'date only, not the full epoch');
  assert.equal(mark.args[1], 60001);
});

await test('a 60-day PREDICTION never marks an object decayed', async () => {
  // It has not reentered. Marking it would remove a live object from every
  // group bundle weeks early.
  const env = makeEnv({ body: JSON.stringify(predictionRows) });
  const out = await ingestDecay(env, '60day');
  assert.equal(out.marked, 0);
  assert.equal(matching(env.ORBIT_DB, /UPDATE objects SET DECAY_DATE/).length, 0);
  assert.match(env.seen[0], /source\/60day_msg/);
});

await test('the two feeds produce distinct event kinds', async () => {
  const a = makeEnv({ body: JSON.stringify(decayRows) });
  await ingestDecay(a, 'daily');
  assert.equal(matching(a.ORBIT_DB, /INSERT OR IGNORE INTO events/)[0].args[1], 'decay');

  const b = makeEnv({ body: JSON.stringify(predictionRows) });
  await ingestDecay(b, '60day');
  assert.equal(matching(b.ORBIT_DB, /INSERT OR IGNORE INTO events/)[0].args[1], 'reentry_predicted');
});

await test('a message we already announced is not announced again', async () => {
  // The daily window overlaps by design, so yesterday's rows come back.
  const env = makeEnv({
    body: JSON.stringify(decayRows),
    respond: (sql) => (/FROM events\s+WHERE kind = \?/.test(sql)
      ? { results: [{ NORAD_CAT_ID: 60001,
                      detail: JSON.stringify({ msg_epoch: '2026-07-25 12:00:00' }) }] }
      : undefined),
  });
  const out = await ingestDecay(env, 'daily');
  assert.equal(out.events, 0);
  assert.equal(matching(env.ORBIT_DB, /INSERT OR IGNORE INTO events/).length, 0);
});

/* ── Boxscore ───────────────────────────────────────────────────────────── */

console.log('\n-- boxscore --');

await test('the table is replaced in a single batch, delete first', async () => {
  // D1 runs a batch as one transaction, so a failure mid-reload rolls back
  // rather than leaving the stats panel blank until tomorrow.
  const env = makeEnv({ body: raw('sample_boxscore.json') });
  const out = await ingestBoxscore(env);
  assert.equal(out.rows, 122);
  const stmts = env.ORBIT_DB.executed.filter((e) => e.batched);
  assert.match(stmts[0].sql, /DELETE FROM boxscore/);
  assert.equal(stmts.length, 123);
});

await test('an empty upstream response replaces nothing', async () => {
  const env = makeEnv({ body: '[]' });
  const out = await ingestBoxscore(env);
  assert.equal(out.rows, 0);
  assert.equal(matching(env.ORBIT_DB, /DELETE FROM boxscore/).length, 0);
});

/* ── Artifacts ──────────────────────────────────────────────────────────── */

console.log('\n-- R2 artifacts --');

await test('each group is written as a 3LE bundle carrying the citation', async () => {
  const rows = [{ NORAD_CAT_ID: 25544, OBJECT_NAME: 'ISS (ZARYA)',
                  TLE_LINE1: '1 25544U ...', TLE_LINE2: '2 25544 ...' }];
  const env = makeEnv({ respond: (sql) => (/FROM objects/.test(sql) ? { results: rows } : undefined) });
  const counts = await buildGroupArtifacts(env, { slugs: ['stations'] });

  assert.equal(counts.stations, rows.length);
  const put = env.ORBIT_R2.puts.get('tle/spacetrack/stations.txt');
  assert.ok(put, 'nothing written to R2');
  assert.equal(put.body.split('\n')[0], 'ISS (ZARYA)');
  assert.equal(put.opts.customMetadata.citation, CITATION);
});

await test('an empty result leaves the previous bundle in place', async () => {
  // A broken predicate must degrade to stale data, never to a blank sky.
  const env = makeEnv({ respond: () => ({ results: [] }) });
  const counts = await buildGroupArtifacts(env, { slugs: ['starlink'] });
  assert.equal(counts.starlink, 0);
  assert.equal(env.ORBIT_R2.puts.size, 0);
});

await test('the bundle query excludes decayed objects', async () => {
  const env = makeEnv({ respond: () => ({ results: [] }) });
  await buildGroupArtifacts(env, { slugs: ['starlink'] });
  const q = matching(env.ORBIT_DB, /FROM objects/)[0];
  assert.match(q.sql, /DECAY_DATE IS NULL/);
  assert.match(q.sql, /TLE_LINE1 IS NOT NULL/);
  assert.ok(q.sql.includes(GROUPS.starlink.where));
});

// Whether the 20 group predicates are valid SQL is checked against a real
// SQLite engine in test/sqlite.test.mjs — counting parentheses here would only
// prove that `LIKE 'ISS (%'` contains a bracket.

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
