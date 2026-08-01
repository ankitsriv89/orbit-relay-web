/**
 * Schema conformance — d1/orbit.sql vs Space-Track's own modeldef.
 *
 *     node workers/orbit-ingest/test/schema.test.mjs
 *
 * This is the test I wish had existed before I wrote the schema by hand. The
 * first draft invented three SATCAT columns that do not exist (OPS_STATUS_CODE,
 * ORBIT_CENTER, ORBIT_TYPE) and named GP's apsis fields APOGEE/PERIGEE when GP
 * actually calls them APOAPSIS/PERIAPSIS — SATCAT uses the other pair. None of
 * that would have surfaced until the first live ingest silently wrote NULLs.
 *
 * Ground truth is fixtures/modeldef_*.json, captured from
 * `basicspacedata/modeldef/class/<class>`. Refresh those and this test tells
 * you exactly what upstream changed.
 *
 * Fixtures are also the reason no test here needs the network.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');

const sql = fs.readFileSync(path.join(ROOT, 'd1/orbit.sql'), 'utf8');

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(HERE, '../fixtures', name), 'utf8'));
}

/** Field names Space-Track says a class has. */
function upstreamFields(modeldefFile) {
  return new Set(fixture(modeldefFile).data.map(f => f.Field));
}

/** Column names our CREATE TABLE declares, minus our own derived ones. */
function tableColumns(table) {
  const m = sql.match(new RegExp(
    `CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`, 'i'));
  assert.ok(m, `no CREATE TABLE for ${table}`);
  return m[1]
    .split('\n')
    .map(l => l.replace(/--.*$/, '').trim())
    .filter(l => l && !/^(PRIMARY KEY|UNIQUE|FOREIGN KEY)/i.test(l))
    // Some tables pack several columns on one line (plan 36 admin tables),
    // so split on commas before taking the first token of each.
    .flatMap(l => l.split(',').map(s => s.trim()))
    .map(l => l.split(/\s+/)[0].replace(/,$/, ''))
    .filter(Boolean);
}

// Columns we add ourselves. Everything else must exist upstream.
const OURS = new Set([
  'regime', 'launch_year', 'debris_family', 'operator',
  'first_seen', 'updated_at', 'id', 'ts', 'kind', 'title', 'detail',
  'class', 'url', 'status', 'rows', 'ms',
]);

const results = [];
function test(name, fn) {
  try { fn(); results.push(true); console.log('  PASS  ' + name); }
  catch (e) { results.push(false); console.log('  FAIL  ' + name + '\n        ' + e.message); }
}

const CLASSES = [
  ['objects', 'modeldef_gp.json',       'gp'],
  ['satcat',  'modeldef_satcat.json',   'satcat'],
  ['decay',   'modeldef_decay.json',    'decay'],
  ['boxscore','modeldef_boxscore.json', 'boxscore'],
];

console.log('\n-- every column we declare exists upstream --');

for (const [table, file, cls] of CLASSES) {
  test(`${table} declares no column absent from class/${cls}`, () => {
    const up = upstreamFields(file);
    const invented = tableColumns(table).filter(c => !OURS.has(c) && !up.has(c));
    assert.deepEqual(invented, [],
      `not in modeldef/class/${cls}: ${invented.join(', ')}`);
  });
}

console.log('\n-- the fields the product depends on are all captured --');

// Losing any of these silently breaks a named feature, so name the feature.
const REQUIRED = {
  objects: {
    'NORAD_CAT_ID': 'join key + ISS identity (25544)',
    'TLE_LINE1': 'propagation', 'TLE_LINE2': 'propagation',
    'OBJECT_TYPE': 'payload vs debris filter', 'COUNTRY_CODE': 'country view',
    'RCS_SIZE': 'point sizing', 'LAUNCH_DATE': 'launch-era view',
    'DECAY_DATE': 'on-orbit filter', 'PERIOD': 'orbit regime',
    'ECCENTRICITY': 'orbit regime', 'CREATION_DATE': 'the delta window',
    'APOAPSIS': 'dossier', 'PERIAPSIS': 'dossier', 'SITE': 'dossier',
  },
  decay:    { 'DECAY_EPOCH': 'reentry watch countdown', 'SOURCE': '60-day feed split' },
  boxscore: { 'COUNTRY': 'per-country stats', 'COUNTRY_TOTAL': 'per-country stats' },
};

for (const [table, need] of Object.entries(REQUIRED)) {
  test(`${table} keeps every field a feature depends on`, () => {
    const have = new Set(tableColumns(table));
    const missing = Object.entries(need).filter(([c]) => !have.has(c));
    assert.deepEqual(missing.map(([c, why]) => `${c} (${why})`), []);
  });
}

console.log('\n-- sample rows actually populate the schema --');

test('every key in a real GP row maps to a column or a documented omission', () => {
  // OMM envelope metadata, constant on every row — deliberately not stored.
  const ENVELOPE = new Set(['CCSDS_OMM_VERS', 'COMMENT', 'ORIGINATOR',
                            'CENTER_NAME', 'REF_FRAME', 'TIME_SYSTEM',
                            'MEAN_ELEMENT_THEORY']);
  const cols = new Set(tableColumns('objects'));
  const rows = fixture('sample_gp.json');
  assert.ok(rows.length > 0, 'empty GP fixture');
  const unmapped = Object.keys(rows[0]).filter(k => !cols.has(k) && !ENVELOPE.has(k));
  assert.deepEqual(unmapped, []);
});

test('GP apsides are ALTITUDES above the surface, not radii', () => {
  // If these were measured from Earth's centre, the ingest would report the
  // ISS at ~6800 km and every regime classification would be wrong.
  const R = 6378.137;
  for (const r of fixture('sample_gp.json').slice(0, 10)) {
    const mean = (Number(r.APOAPSIS) + Number(r.PERIAPSIS)) / 2;
    assert.ok(Math.abs((Number(r.SEMIMAJOR_AXIS) - R) - mean) < 1.0,
      `${r.OBJECT_NAME}: a-R=${(Number(r.SEMIMAJOR_AXIS) - R).toFixed(1)} vs ` +
      `mean apsis=${mean.toFixed(1)}`);
  }
});

test('GP and SATCAT agree on apogee for the same object', () => {
  const gp = new Map(fixture('sample_gp.json').map(r => [Number(r.NORAD_CAT_ID), r]));
  const sc = new Map(fixture('sample_satcat.json').map(r => [Number(r.NORAD_CAT_ID), r]));
  let compared = 0;
  for (const [id, g] of gp) {
    const s = sc.get(id);
    if (!s || s.APOGEE == null) continue;
    assert.ok(Math.abs(Number(g.APOAPSIS) - Number(s.APOGEE)) < 2.0,
      `NORAD ${id}: GP ${g.APOAPSIS} vs SATCAT ${s.APOGEE}`);
    compared++;
  }
  assert.ok(compared >= 5, `only ${compared} objects overlapped`);
});

test('NORAD_CAT_ID survives as an integer (Alpha-5 would corrupt it)', () => {
  for (const r of fixture('sample_gp.json')) {
    const n = Number(r.NORAD_CAT_ID);
    assert.ok(Number.isInteger(n) && n > 0, `bad id: ${r.NORAD_CAT_ID}`);
  }
});

test('boxscore fixture is the full table, not a truncated sample', () => {
  assert.ok(fixture('sample_boxscore.json').length > 100);
});

console.log('\n-- admin tables (plan 36) --');

// page_views and ingest_runs are ours end to end — no upstream modeldef to
// check against — so the test asserts the columns the admin endpoints read.
const ADMIN_TABLES = {
  page_views: ['id', 'ts', 'path', 'referrer', 'country', 'ip_hash', 'ua_class'],
  ingest_runs: ['id', 'ts', 'job', 'ok', 'total_ms', 'd1_requests', 'r2_puts', 'source', 'steps'],
};

for (const [table, need] of Object.entries(ADMIN_TABLES)) {
  test(`${table} declares every column the admin endpoints read`, () => {
    const have = new Set(tableColumns(table));
    const missing = need.filter(c => !have.has(c));
    assert.deepEqual(missing, []);
  });
}

test('the admin queries the endpoints run are answerable by the schema', () => {
  // visitors.js runs these against page_views; runs.js and health.js read
  // ingest_runs. None of them may reference a column that does not exist.
  const pv = new Set(tableColumns('page_views'));
  assert.ok(pv.has('ts'), 'page_views.ts needed for ts >= ? windowing');
  assert.ok(pv.has('ip_hash'), 'page_views.ip_hash needed for COUNT(DISTINCT)');
  assert.ok(pv.has('path'), 'page_views.path needed for top-pages GROUP BY');
  const ir = new Set(tableColumns('ingest_runs'));
  for (const c of ['ts', 'job', 'ok', 'total_ms', 'd1_requests', 'r2_puts', 'source', 'steps']) {
    assert.ok(ir.has(c), `ingest_runs.${c} needed by recordRun / runs.js`);
  }
});

test('indexes for the admin read patterns exist', () => {
  const idxs = [...sql.matchAll(/CREATE INDEX IF NOT EXISTS (\S+)\s+ON\s+(\S+?)\s*\(/g)]
    .map(m => `${m[2]}.${m[1]}`);
  for (const idx of ['page_views.idx_page_views_ts', 'page_views.idx_page_views_path',
                     'ingest_runs.idx_ingest_runs_ts']) {
    assert.ok(idxs.includes(idx), `missing ${idx}`);
  }
});

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
