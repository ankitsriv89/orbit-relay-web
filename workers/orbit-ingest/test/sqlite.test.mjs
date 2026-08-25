/**
 * The schema and every generated statement, against a real SQLite engine.
 *
 *     node workers/orbit-ingest/test/sqlite.test.mjs
 *
 * D1 is SQLite, and `node:sqlite` ships with Node 22+, so `d1/orbit.sql` can be
 * applied to an in-memory database and every statement this Worker generates
 * can actually be prepared and run. That closes the gap the other suites leave
 * open: they assert the SQL we *emit*, this one asserts the SQL *works*.
 *
 * It covers the plan's verification items directly —
 *   "assert row counts after a fixture ingest and confirm a second run upserts
 *    rather than duplicates"
 * — without needing wrangler or a network.
 *
 * `node:sqlite` is flagged experimental and prints a warning; the API used here
 * is exec/prepare/run/get/all, which is stable enough for a test dependency. If
 * it is ever removed, this file is the only thing to port.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
  GROUPS, OBJECT_COLUMNS, OBJECT_UPSERT_SQL, deriveObjectRow, regimeOf,
} from '../src/derive.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const SCHEMA = fs.readFileSync(path.join(ROOT, 'd1/orbit.sql'), 'utf8');
const fixture = (n) => JSON.parse(fs.readFileSync(path.join(HERE, '../fixtures', n), 'utf8'));

const results = [];
function test(name, fn) {
  try { fn(); results.push(true); console.log('  PASS  ' + name); }
  catch (e) { results.push(false); console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); }
}

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return db;
}

const NOW = '2026-07-26T12:00:00.000Z';
const LATER = '2026-07-26T18:00:00.000Z';

function seed(db, rows, when) {
  const stmt = db.prepare(OBJECT_UPSERT_SQL);
  for (const r of rows) stmt.run(...deriveObjectRow(r, when));
}

/* ── Schema ─────────────────────────────────────────────────────────────── */

console.log('\n-- d1/orbit.sql applies to a real engine --');

test('the schema executes', () => { freshDb(); });

test('the schema is re-runnable — it is a migration, not a one-shot', () => {
  const db = freshDb();
  db.exec(SCHEMA);   // every statement is IF NOT EXISTS
  db.exec(SCHEMA);
});

test('every table the ingest writes to exists', () => {
  const db = freshDb();
  const have = new Set(db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
  for (const t of ['objects', 'satcat', 'decay', 'boxscore', 'events', 'api_calls']) {
    assert.ok(have.has(t), `missing table ${t}`);
  }
});

/* ── Upsert semantics ───────────────────────────────────────────────────── */

console.log('\n-- the objects upsert --');

test('a fixture ingest lands the expected row count', () => {
  const db = freshDb();
  const rows = fixture('sample_gp.json');
  seed(db, rows, NOW);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM objects').get().n, rows.length);
});

test('a second run upserts rather than duplicating', () => {
  // The 6-hourly window overlaps by design (0.28 days for a 0.25-day cadence),
  // so re-ingesting the same elsets happens on every single run.
  const db = freshDb();
  const rows = fixture('sample_gp.json');
  seed(db, rows, NOW);
  seed(db, rows, LATER);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM objects').get().n, rows.length);
});

test('first_seen survives the re-ingest and updated_at moves', () => {
  const db = freshDb();
  const rows = fixture('sample_gp.json');
  seed(db, rows, NOW);
  seed(db, rows, LATER);
  const r = db.prepare('SELECT first_seen, updated_at FROM objects WHERE NORAD_CAT_ID = 5').get();
  assert.equal(r.first_seen, NOW, 'first_seen must never be overwritten');
  assert.equal(r.updated_at, LATER);
});

test('"new this run" is exactly the rows the run inserted', () => {
  const db = freshDb();
  const rows = fixture('sample_gp.json');
  seed(db, rows.slice(0, 15), NOW);
  seed(db, rows, LATER);          // 15 updates + 5 inserts
  const fresh = db.prepare('SELECT COUNT(*) AS n FROM objects WHERE first_seen = ?').get(LATER);
  assert.equal(fresh.n, 5);
});

/* ── Typing ─────────────────────────────────────────────────────────────── */

console.log('\n-- numeric typing (Space-Track sends everything as strings) --');

test('numeric columns store as numbers, so range predicates work', () => {
  // This is the bug that would make the geo group silently empty: stored as
  // text, '132.594' BETWEEN 1430 AND 1450 is a string comparison.
  const db = freshDb();
  seed(db, fixture('sample_gp.json'), NOW);
  const t = db.prepare(
    "SELECT typeof(PERIOD) AS p, typeof(NORAD_CAT_ID) AS n, typeof(ECCENTRICITY) AS e " +
    'FROM objects WHERE NORAD_CAT_ID = 5').get();
  assert.equal(t.p, 'real');
  assert.equal(t.n, 'integer');
  assert.equal(t.e, 'real');
});

test('a range query over PERIOD actually matches', () => {
  const db = freshDb();
  seed(db, [{ NORAD_CAT_ID: '99999', OBJECT_NAME: 'GEOSAT', OBJECT_TYPE: 'PAYLOAD',
              PERIOD: '1436.1', ECCENTRICITY: '0.0002',
              TLE_LINE1: '1 x', TLE_LINE2: '2 x' }], NOW);
  const n = db.prepare(
    'SELECT COUNT(*) AS n FROM objects WHERE PERIOD BETWEEN 1430 AND 1450').get().n;
  assert.equal(n, 1);
});

test('a NULL DECAY_DATE is SQL NULL, not the text "null"', () => {
  const db = freshDb();
  seed(db, fixture('sample_gp.json'), NOW);
  const n = db.prepare('SELECT COUNT(*) AS n FROM objects WHERE DECAY_DATE IS NULL').get().n;
  assert.equal(n, fixture('sample_gp.json').length);
});

/* ── Group predicates ───────────────────────────────────────────────────── */

console.log('\n-- all group predicates against the real schema --');

// One synthetic object per group, named the way Space-Track names them, so
// membership is asserted rather than assumed. A predicate that compiles but
// matches nothing is the failure this catches.
const SPECIMENS = {
  stations:              { NORAD_CAT_ID: 25544, OBJECT_NAME: 'ISS (ZARYA)', OBJECT_TYPE: 'PAYLOAD', PERIOD: '92.9' },
  starlink:              { NORAD_CAT_ID: 44713, OBJECT_NAME: 'STARLINK-1007', OBJECT_TYPE: 'PAYLOAD', PERIOD: '95.6' },
  oneweb:                { NORAD_CAT_ID: 44057, OBJECT_NAME: 'ONEWEB-0012', OBJECT_TYPE: 'PAYLOAD', PERIOD: '109.5' },
  qianfan:               { NORAD_CAT_ID: 60540, OBJECT_NAME: 'QIANFAN-1', OBJECT_TYPE: 'PAYLOAD', PERIOD: '105.0' },
  hulianwang:            { NORAD_CAT_ID: 61234, OBJECT_NAME: 'GUOWANG-01', OBJECT_TYPE: 'PAYLOAD', PERIOD: '106.0' },
  'gps-ops':             { NORAD_CAT_ID: 48859, OBJECT_NAME: 'NAVSTAR 80 (USA 309)', OBJECT_TYPE: 'PAYLOAD', PERIOD: '717.9' },
  'glo-ops':             { NORAD_CAT_ID: 32275, OBJECT_NAME: 'COSMOS 2569', OBJECT_TYPE: 'PAYLOAD', COUNTRY_CODE: 'CIS', PERIOD: '675.7', INCLINATION: '64.8' },
  galileo:               { NORAD_CAT_ID: 41859, OBJECT_NAME: 'GSAT0210 (GALILEO 20)', OBJECT_TYPE: 'PAYLOAD', PERIOD: '844.7' },
  beidou:                { NORAD_CAT_ID: 44231, OBJECT_NAME: 'BEIDOU-3 M23', OBJECT_TYPE: 'PAYLOAD', PERIOD: '773.2' },
  irnss:                 { NORAD_CAT_ID: 41384, OBJECT_NAME: 'IRNSS-1F', OBJECT_TYPE: 'PAYLOAD', PERIOD: '1436.0' },
  sbas:                  { NORAD_CAT_ID: 42917, OBJECT_NAME: 'QZS-2 (MICHIBIKI-2)', OBJECT_TYPE: 'PAYLOAD', PERIOD: '1436.0' },
  'iridium-next':        { NORAD_CAT_ID: 41917, OBJECT_NAME: 'IRIDIUM 106', OBJECT_TYPE: 'PAYLOAD', LAUNCH_DATE: '2017-01-14', PERIOD: '100.4' },
  weather:               { NORAD_CAT_ID: 43013, OBJECT_NAME: 'NOAA 20', OBJECT_TYPE: 'PAYLOAD', PERIOD: '101.4' },
  resource:              { NORAD_CAT_ID: 39084, OBJECT_NAME: 'LANDSAT 8', OBJECT_TYPE: 'PAYLOAD', PERIOD: '98.8' },
  geo:                   { NORAD_CAT_ID: 41866, OBJECT_NAME: 'GOES 16', OBJECT_TYPE: 'PAYLOAD', PERIOD: '1436.1' },
  'last-30-days':        { NORAD_CAT_ID: 99123, OBJECT_NAME: 'BRAND NEW', OBJECT_TYPE: 'PAYLOAD', LAUNCH_DATE: new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10), PERIOD: '95.0' },
  'cosmos-2251-debris':  { NORAD_CAT_ID: 34000, OBJECT_NAME: 'COSMOS 2251 DEB', OBJECT_TYPE: 'DEBRIS', OBJECT_ID: '1993-036AZ', PERIOD: '97.0' },
  'cosmos-1408-debris':  { NORAD_CAT_ID: 50000, OBJECT_NAME: 'COSMOS 1408 DEB', OBJECT_TYPE: 'DEBRIS', OBJECT_ID: '1982-092BQ', PERIOD: '92.0' },
  'fengyun-1c-debris':   { NORAD_CAT_ID: 30000, OBJECT_NAME: 'FENGYUN 1C DEB', OBJECT_TYPE: 'DEBRIS', OBJECT_ID: '1999-025DKV', PERIOD: '99.0' },
  'iridium-33-debris':   { NORAD_CAT_ID: 33800, OBJECT_NAME: 'IRIDIUM 33 DEB', OBJECT_TYPE: 'DEBRIS', OBJECT_ID: '1997-051KM', PERIOD: '96.0' },
  active:                { NORAD_CAT_ID: 45000, OBJECT_NAME: 'ANYSAT-1', OBJECT_TYPE: 'PAYLOAD', PERIOD: '100.0' },
  military:              { NORAD_CAT_ID: 39088, OBJECT_NAME: 'SAPPHIRE', OBJECT_TYPE: 'PAYLOAD', PERIOD: '101.7' },
};

const specimenDb = (() => {
  const db = freshDb();
  seed(db, Object.values(SPECIMENS).map((s) => ({
    ECCENTRICITY: '0.001', TLE_LINE1: `1 ${s.NORAD_CAT_ID}`, TLE_LINE2: `2 ${s.NORAD_CAT_ID}`, ...s,
  })), NOW);
  return db;
})();

// Mirrors buildGroupArtifacts()'s real query shape, indexHint included — a
// test built from `where` alone would compile fine but never catch an
// INDEXED BY clause naming an index that doesn't exist or can't satisfy the
// predicate, which SQLite only rejects at prepare time with the hint present.
//
// `cursor` mirrors pagedRows()'s keyset clause. It is part of the real shape:
// adding `AND NORAD_CAT_ID > ?` is exactly the kind of non-name predicate that
// can demote a forced idx_objects_name SEARCH to a full SCAN, so the plan test
// below has to see it or it would be proving something the Worker never runs.
const bundleSql = (g, { cursor = false } = {}) =>
  `SELECT NORAD_CAT_ID FROM objects${g.indexHint ? ` INDEXED BY ${g.indexHint}` : ''}
   WHERE DECAY_DATE IS NULL AND TLE_LINE1 IS NOT NULL AND (${g.where})${cursor ? ' AND NORAD_CAT_ID > 0' : ''}
   ORDER BY NORAD_CAT_ID`;

test('every group predicate compiles', () => {
  const db = freshDb();
  for (const [slug, g] of Object.entries(GROUPS)) {
    try { db.prepare(bundleSql(g)); }
    catch (e) { throw new Error(`${slug}: ${e.message}`); }
  }
});

test('every group matches its specimen — no predicate is silently empty', () => {
  const missing = [];
  for (const [slug, g] of Object.entries(GROUPS)) {
    const ids = specimenDb.prepare(bundleSql(g)).all().map((r) => r.NORAD_CAT_ID);
    if (!ids.includes(SPECIMENS[slug].NORAD_CAT_ID)) missing.push(slug);
  }
  assert.deepEqual(missing, []);
});

test('every indexHint actually gets used, not silently ignored by a mixed predicate', () => {
  // The whole point of the hint is to stop the planner from picking
  // idx_objects_decay's ~86%-selective seek over a much cheaper name-prefix
  // one. A group whose `where` mixes in a non-name clause (NORAD_CAT_ID IN,
  // an OBJECT_TYPE/PERIOD filter) degrades the forced index to a full SCAN
  // instead of a SEARCH — worse than no hint — which is why `stations` and
  // `military` deliberately carry no indexHint. This asserts every group that
  // DOES carry one actually gets a SEARCH, catching a future edit that adds a
  // mixed clause to one of these `where`s without removing its hint.
  const db = freshDb();
  for (const [slug, g] of Object.entries(GROUPS)) {
    if (!g.indexHint) continue;
    // Checked WITH the keyset cursor, because that is what pagedRows() runs.
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${bundleSql(g, { cursor: true })}`).all();
    const usesHintedIndex = plan.some((row) =>
      String(row.detail).includes(`SEARCH objects USING INDEX ${g.indexHint}`));
    assert.ok(usesHintedIndex, `${slug}: indexHint '${g.indexHint}' did not produce a SEARCH — ${JSON.stringify(plan)}`);
  }
});

test('a decayed object drops out of every bundle', () => {
  // The whole point of writing DECAY_DATE back from SATCAT and the decay feed.
  const db = freshDb();
  seed(db, [{ ...SPECIMENS.starlink, TLE_LINE1: '1 x', TLE_LINE2: '2 x' }], NOW);
  db.prepare('UPDATE objects SET DECAY_DATE = ? WHERE NORAD_CAT_ID = ?')
    .run('2026-07-20', SPECIMENS.starlink.NORAD_CAT_ID);
  assert.equal(db.prepare(bundleSql(GROUPS.starlink)).all().length, 0);
});

test('Iridium NEXT excludes the original 1997 block', () => {
  const db = freshDb();
  seed(db, [
    { NORAD_CAT_ID: 24793, OBJECT_NAME: 'IRIDIUM 8', OBJECT_TYPE: 'PAYLOAD',
      LAUNCH_DATE: '1997-05-05', TLE_LINE1: '1 a', TLE_LINE2: '2 a' },
    { NORAD_CAT_ID: 41917, OBJECT_NAME: 'IRIDIUM 106', OBJECT_TYPE: 'PAYLOAD',
      LAUNCH_DATE: '2017-01-14', TLE_LINE1: '1 b', TLE_LINE2: '2 b' },
  ], NOW);
  const ids = db.prepare(bundleSql(GROUPS['iridium-next'])).all().map((r) => r.NORAD_CAT_ID);
  assert.deepEqual(ids, [41917]);
});

test('debris families take fragments and leave their parent payload', () => {
  const db = freshDb();
  seed(db, [
    { NORAD_CAT_ID: 25730, OBJECT_NAME: 'FENGYUN 1C', OBJECT_TYPE: 'PAYLOAD',
      OBJECT_ID: '1999-025A', TLE_LINE1: '1 a', TLE_LINE2: '2 a' },
    { NORAD_CAT_ID: 30000, OBJECT_NAME: 'FENGYUN 1C DEB', OBJECT_TYPE: 'DEBRIS',
      OBJECT_ID: '1999-025DKV', TLE_LINE1: '1 b', TLE_LINE2: '2 b' },
  ], NOW);
  const ids = db.prepare(bundleSql(GROUPS['fengyun-1c-debris'])).all().map((r) => r.NORAD_CAT_ID);
  assert.deepEqual(ids, [30000]);
});

/* ── Paging cost ────────────────────────────────────────────────────────── */

console.log('\n-- catalog paging does not re-scan what it already returned --');

/**
 * Rows the engine actually visits for a full paged walk of `objects`.
 *
 * Measured, not reasoned about: a `visit()` scalar UDF is ANDed onto the tail
 * of the WHERE clause, so SQLite calls it exactly once per row that reaches
 * that point of the predicate. LIMIT/OFFSET is applied *after* the WHERE, so
 * rows that OFFSET discards still fire the counter — which is precisely the
 * cost D1 bills as "rows read" and the thing this test exists to pin down.
 */
function walkCost(db, pager) {
  let visited = 0;
  db.function('visit', () => { visited++; return 1; });
  const sql = `SELECT NORAD_CAT_ID FROM objects
               WHERE DECAY_DATE IS NULL AND TLE_LINE1 IS NOT NULL AND visit() = 1`;
  const returned = pager(db, sql);
  return { visited, returned };
}

// The two pagers, each walking the whole table in pages of PAGE_N.
const PAGE_N = 100;

const offsetPager = (db, sql) => {
  let n = 0;
  for (let offset = 0; ; offset += PAGE_N) {
    const rows = db.prepare(`${sql} ORDER BY NORAD_CAT_ID LIMIT ${PAGE_N} OFFSET ${offset}`).all();
    n += rows.length;
    if (rows.length < PAGE_N) return n;
  }
};

const keysetPager = (db, sql) => {
  let n = 0;
  let after = -1;
  for (;;) {
    const rows = db.prepare(
      `${sql} AND NORAD_CAT_ID > ${after} ORDER BY NORAD_CAT_ID LIMIT ${PAGE_N}`).all();
    n += rows.length;
    if (rows.length < PAGE_N) return n;
    after = rows[rows.length - 1].NORAD_CAT_ID;
  }
};

function seedManyLive(db, count) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    rows.push({ NORAD_CAT_ID: 10000 + i, OBJECT_NAME: `OBJ ${i}`, OBJECT_TYPE: 'PAYLOAD',
                TLE_LINE1: `1 ${i}`, TLE_LINE2: `2 ${i}` });
  }
  seed(db, rows, NOW);
}

test('both pagers return the identical row set', () => {
  const a = freshDb(); seedManyLive(a, 1000);
  const b = freshDb(); seedManyLive(b, 1000);
  assert.equal(walkCost(a, offsetPager).returned, 1000);
  assert.equal(walkCost(b, keysetPager).returned, 1000);
});

test('OFFSET paging re-reads discarded rows; keyset paging does not', () => {
  // 1,000 rows in pages of 100 is 10 pages. OFFSET re-walks the prefix every
  // page — 100+200+...+1000 = 5,500 visits for 1,000 rows. Keyset seeks past
  // what it already returned, so it visits each row about once. The real
  // catalog is ~27k rows in pages of 1,000, where the same quadratic lands at
  // ~392k visits for 27k rows — the 1.05M-rows-read line in the D1 dashboard.
  const off = walkCost((() => { const d = freshDb(); seedManyLive(d, 1000); return d; })(), offsetPager);
  const key = walkCost((() => { const d = freshDb(); seedManyLive(d, 1000); return d; })(), keysetPager);

  assert.equal(off.returned, key.returned, 'the two pagers must agree on the result');
  assert.ok(off.visited >= 5000,
    `expected OFFSET paging to re-scan (got ${off.visited} visits for ${off.returned} rows)`);
  assert.ok(key.visited <= off.returned * 1.2,
    `keyset paging should visit each row ~once, got ${key.visited} for ${key.returned} rows`);
  assert.ok(key.visited * 4 < off.visited,
    `keyset must be dramatically cheaper: ${key.visited} vs ${off.visited}`);
});

/* ── Derived columns round-trip ─────────────────────────────────────────── */

console.log('\n-- derived columns survive the round trip --');

test('regime is stored and queryable', () => {
  const db = freshDb();
  seed(db, fixture('sample_gp.json'), NOW);
  const rows = db.prepare('SELECT NORAD_CAT_ID, PERIOD, ECCENTRICITY, regime FROM objects').all();
  for (const r of rows) assert.equal(r.regime, regimeOf(r), `NORAD ${r.NORAD_CAT_ID}`);
  const leo = db.prepare("SELECT COUNT(*) AS n FROM objects WHERE regime = 'LEO'").get().n;
  assert.ok(leo > 0, 'no LEO objects in a 20-row sample of the oldest catalog entries');
});

test('every OBJECT_COLUMNS name exists on the table', () => {
  const db = freshDb();
  const cols = new Set(db.prepare('PRAGMA table_info(objects)').all().map((r) => r.name));
  const missing = OBJECT_COLUMNS.filter((c) => !cols.has(c));
  assert.deepEqual(missing, []);
});

/* ── Events ─────────────────────────────────────────────────────────────── */

console.log('\n-- events --');

test('re-running an ingest cannot duplicate a feed entry', () => {
  const db = freshDb();
  const sql = `INSERT OR IGNORE INTO events (ts, kind, NORAD_CAT_ID, title, detail)
               VALUES (?, ?, ?, ?, ?)`;
  for (let i = 0; i < 3; i++) db.prepare(sql).run(NOW, 'new_object', 25544, 'ISS', '{}');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 1);
});

test('the same object can have events of different kinds at the same instant', () => {
  const db = freshDb();
  const sql = `INSERT OR IGNORE INTO events (ts, kind, NORAD_CAT_ID, title, detail)
               VALUES (?, ?, ?, ?, ?)`;
  db.prepare(sql).run(NOW, 'reentry_predicted', 25544, 'a', '{}');
  db.prepare(sql).run(NOW, 'decay', 25544, 'b', '{}');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 2);
});

/* ── api_calls ──────────────────────────────────────────────────────────── */

console.log('\n-- the budget log --');

test('the rolling-hour count the guard runs is a real indexed query', () => {
  const db = freshDb();
  const ins = db.prepare('INSERT INTO api_calls (ts, class, url) VALUES (?, ?, ?)');
  const now = Date.now();
  for (let i = 0; i < 5; i++) ins.run(now - i * 1000, 'gp', 'u');
  for (let i = 0; i < 30; i++) ins.run(now - 2 * 3600_000, 'gp', 'u');   // outside the window
  const n = db.prepare('SELECT COUNT(*) AS n FROM api_calls WHERE ts > ?').get(now - 3600_000).n;
  assert.equal(n, 5);
});


/* ── events(kind, ts) ─────────────────────────────────────────────────────
 * Written before the fix and watched go red on the real bug (repo rule).
 *
 * Measured 2026-08-26 from d1QueriesAdaptiveGroups: buildBrief()'s two
 * events-to-objects joins read 315,916 rows to return 24 (ratio 13,163).
 *
 * The cause is that `WHERE kind = ? AND ts >= ?` has TWO single-column
 * indexes available — idx_events_kind and idx_events_ts — and SQLite can only
 * use one per table. It picks idx_events_ts, so it walks every event in the
 * window and tests `kind` row by row. The brief's window is 7 days of ALL
 * events, of which the decay rows are a small minority, so almost everything
 * visited is discarded.
 *
 * A composite (kind, ts DESC) turns that into a single seek: kind selects the
 * partition, ts ranges within it, and the DESC matches the ORDER BY so no
 * temp b-tree is needed either. Measured with a counting UDF on a seeded
 * 20k-event table: 289 rows visited -> 6. This is the ONE case in this schema
 * where a composite helps; the (OBJECT_TYPE, NORAD_CAT_ID) one proposed for
 * `objects` was correctly rejected, because there NORAD_CAT_ID is the rowid
 * and every index already carries it.
 */
function eventsDb() {
  const db = freshDb();
  const ins = db.prepare("INSERT INTO events (ts, kind, NORAD_CAT_ID, title, detail) VALUES (?, ?, ?, ?, ?)");
  // Decays are ~2% of events, which is what makes the kind filter worth an
  // index — a table that were mostly decays would not show this.
  for (let i = 0; i < 4000; i++) {
    ins.run(`2026-0${1 + (i % 9)}-01T00:00:00Z`, i % 50 === 0 ? 'decay' : 'new_object',
            900000 + i, 't' + i, '{}');
  }
  db.exec('ANALYZE');
  return db;
}

const BRIEF_DECAY_SQL = `
  SELECT e.NORAD_CAT_ID AS norad, e.title AS title, o.OBJECT_NAME AS name,
         o.COUNTRY_CODE AS country
  FROM events e LEFT JOIN objects o ON o.NORAD_CAT_ID = e.NORAD_CAT_ID
  WHERE e.kind = 'decay' AND e.ts >= ?
  ORDER BY e.ts DESC LIMIT 6`;

test('the brief decay join seeks on (kind, ts), it does not walk every event', () => {
  const db = eventsDb();
  const plan = db.prepare('EXPLAIN QUERY PLAN ' + BRIEF_DECAY_SQL).all('2026-01-01T00:00:00Z');
  const detail = plan.map((r) => String(r.detail)).join(' | ');
  assert.ok(/SEARCH e USING INDEX idx_events_kind_ts \(kind=\? AND ts>\?\)/.test(detail),
    'expected a (kind, ts) seek, got: ' + detail);
  // The DESC on the index must also satisfy ORDER BY e.ts DESC, or SQLite
  // sorts the partition and the saving is partly given back.
  assert.ok(!/TEMP B-TREE/.test(detail), 'ORDER BY must be served by the index: ' + detail);
});

test('the (kind, ts) index cuts rows visited by the brief decay join', () => {
  // Rows the engine actually VISITS, counted with a UDF ANDed onto the
  // predicate — D1 bills these, and a plan shape alone would not prove it.
  const count = (db) => {
    let n = 0;
    db.function('cnt', () => { n++; return 1; });
    db.prepare(`
      SELECT e.NORAD_CAT_ID AS norad, e.title AS title, o.OBJECT_NAME AS name,
             o.COUNTRY_CODE AS country
      FROM events e LEFT JOIN objects o ON o.NORAD_CAT_ID = e.NORAD_CAT_ID
      WHERE e.kind = 'decay' AND e.ts >= ? AND cnt()
      ORDER BY e.ts DESC LIMIT 6`).all('2026-01-01T00:00:00Z');
    return n;
  };
  const withIdx = count(eventsDb());

  const without = eventsDb();
  without.exec('DROP INDEX idx_events_kind_ts');
  without.exec('ANALYZE');
  const bare = count(without);

  assert.ok(withIdx * 4 < bare,
    `the composite must cut visits several-fold: ${bare} without vs ${withIdx} with`);
  assert.ok(withIdx <= 12, `expected a seek to the 6 rows wanted, visited ${withIdx}`);
});

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
