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

const bundleSql = (where) =>
  `SELECT NORAD_CAT_ID FROM objects
   WHERE DECAY_DATE IS NULL AND TLE_LINE1 IS NOT NULL AND (${where})
   ORDER BY NORAD_CAT_ID`;

test('every group predicate compiles', () => {
  const db = freshDb();
  for (const [slug, g] of Object.entries(GROUPS)) {
    try { db.prepare(bundleSql(g.where)); }
    catch (e) { throw new Error(`${slug}: ${e.message}`); }
  }
});

test('every group matches its specimen — no predicate is silently empty', () => {
  const missing = [];
  for (const [slug, g] of Object.entries(GROUPS)) {
    const ids = specimenDb.prepare(bundleSql(g.where)).all().map((r) => r.NORAD_CAT_ID);
    if (!ids.includes(SPECIMENS[slug].NORAD_CAT_ID)) missing.push(slug);
  }
  assert.deepEqual(missing, []);
});

test('a decayed object drops out of every bundle', () => {
  // The whole point of writing DECAY_DATE back from SATCAT and the decay feed.
  const db = freshDb();
  seed(db, [{ ...SPECIMENS.starlink, TLE_LINE1: '1 x', TLE_LINE2: '2 x' }], NOW);
  db.prepare('UPDATE objects SET DECAY_DATE = ? WHERE NORAD_CAT_ID = ?')
    .run('2026-07-20', SPECIMENS.starlink.NORAD_CAT_ID);
  assert.equal(db.prepare(bundleSql(GROUPS.starlink.where)).all().length, 0);
});

test('Iridium NEXT excludes the original 1997 block', () => {
  const db = freshDb();
  seed(db, [
    { NORAD_CAT_ID: 24793, OBJECT_NAME: 'IRIDIUM 8', OBJECT_TYPE: 'PAYLOAD',
      LAUNCH_DATE: '1997-05-05', TLE_LINE1: '1 a', TLE_LINE2: '2 a' },
    { NORAD_CAT_ID: 41917, OBJECT_NAME: 'IRIDIUM 106', OBJECT_TYPE: 'PAYLOAD',
      LAUNCH_DATE: '2017-01-14', TLE_LINE1: '1 b', TLE_LINE2: '2 b' },
  ], NOW);
  const ids = db.prepare(bundleSql(GROUPS['iridium-next'].where)).all().map((r) => r.NORAD_CAT_ID);
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
  const ids = db.prepare(bundleSql(GROUPS['fengyun-1c-debris'].where)).all().map((r) => r.NORAD_CAT_ID);
  assert.deepEqual(ids, [30000]);
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

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
