/**
 * Schema conformance — d1/profiles.sql vs the contract every later task writes to.
 *
 *     node workers/orbit-profiles/test/schema.test.mjs
 *
 * There is no upstream modeldef to check this schema against — unlike
 * orbit-catalog, these tables are ours end to end. So the ground truth here is
 * the plan's Interface Summary: the column names facts.js, checkpoint.js,
 * images.js and the three endpoints were specified against. A column silently
 * renamed here would not fail until a live write returned "no such column".
 *
 * Parses the SQL as text. No database, no network.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');

// Normalise CRLF so the per-line `/--.*$/` comment strip below works on a
// core.autocrlf checkout (`.` and `$` both stop at the `\r` otherwise).
const sql = fs.readFileSync(path.join(ROOT, 'd1/profiles.sql'), 'utf8').replace(/\r\n/g, '\n');

/** Column names a CREATE TABLE declares, minus table-level constraints. */
function tableColumns(table) {
  const m = sql.match(new RegExp(
    `CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`, 'i'));
  assert.ok(m, `no CREATE TABLE for ${table}`);
  return m[1]
    .split('\n')
    .map(l => l.replace(/--.*$/, '').trim())
    .filter(l => l && !/^(PRIMARY KEY|UNIQUE|FOREIGN KEY)/i.test(l))
    .flatMap(l => l.split(',').map(s => s.trim()))
    .map(l => l.split(/\s+/)[0].replace(/,$/, ''))
    .filter(Boolean);
}

/** The body of a CREATE TABLE, comments stripped — for constraint assertions. */
function tableBody(table) {
  const m = sql.match(new RegExp(
    `CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`, 'i'));
  assert.ok(m, `no CREATE TABLE for ${table}`);
  return m[1].replace(/--.*$/gm, '');
}

const results = [];
function test(name, fn) {
  try { fn(); results.push(true); console.log('  PASS  ' + name); }
  catch (e) { results.push(false); console.log('  FAIL  ' + name + '\n        ' + e.message); }
}

console.log('\n-- the file re-runs as a migration --');

const TABLES = ['sources', 'profiles', 'profile_fields', 'images', 'ingest_checkpoints'];

test('all five tables are declared', () => {
  const declared = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map(m => m[1]);
  assert.deepEqual([...declared].sort(), [...TABLES].sort());
});

test('every CREATE TABLE is IF NOT EXISTS', () => {
  const bare = [...sql.matchAll(/CREATE TABLE (?!IF NOT EXISTS)(\S+)/g)].map(m => m[1]);
  assert.deepEqual(bare, []);
});

test('every CREATE INDEX is IF NOT EXISTS', () => {
  const bare = [...sql.matchAll(/CREATE INDEX (?!IF NOT EXISTS)(\S+)/g)].map(m => m[1]);
  assert.deepEqual(bare, []);
});

console.log('\n-- the columns the Interface Summary names --');

// Losing any of these breaks a named consumer, so name the consumer.
const REQUIRED = {
  sources: {
    id: 'assertAllowed() / the allowlist key',
    name: 'attribution UI', url: 'attribution UI',
    license: 'licence review', attribution_text: 'CC-BY discharge',
    priority: 'resolveConflicts() ordering',
  },
  profiles: {
    norad: 'the join key to orbit-catalog', cospar: 'matchByCospar()',
    official_name: 'the spine', mission_summary: 'the spine',
    operator_name: 'the spine', owner_country: 'the spine',
    bus: 'the spine', manufacturer: 'the spine',
    launch_mass_kg: 'the spine', power_w: 'the spine',
    design_life_years: 'the spine', mission_type: 'the spine',
    status: 'the spine',
    prose: 'tier2Prose / tier3Prose output', prose_tier: 'tier 2 vs 3 badge',
    updated_at: 'freshness',
  },
  profile_fields: {
    norad: 'the sidecar join', field: 'which spine column',
    source_id: 'provenance + the allowlist check',
    source_url: 'the citation link', confidence: 'match quality',
  },
  images: {
    norad: 'the join', r2_key: 'primary WebP', thumb_key: 'thumbnail',
    width: 'layout', height: 'layout', credit: 'required credit line',
    license: 'licence audit', source_url: 'provenance', is_primary: 'which image to show',
  },
  ingest_checkpoints: {
    stage: 'match | facts | prose | images', last_norad: 'readCheckpoint / writeCheckpoint',
  },
};

for (const [table, need] of Object.entries(REQUIRED)) {
  test(`${table} declares every column its consumers read`, () => {
    const have = new Set(tableColumns(table));
    const missing = Object.entries(need).filter(([c]) => !have.has(c));
    assert.deepEqual(missing.map(([c, why]) => `${c} (${why})`), []);
  });
}

console.log('\n-- the shapes that are load-bearing --');

test('profiles.norad is INTEGER PRIMARY KEY', () => {
  // Not TEXT: it joins to objects.NORAD_CAT_ID, which is a true integer
  // precisely so Alpha-5 ids above 100,000 cannot corrupt it.
  assert.match(tableBody('profiles'), /norad\s+INTEGER PRIMARY KEY/);
});

test('profile_fields carries the composite PRIMARY KEY (norad, field)', () => {
  // Without it a re-run appends a second provenance row per field instead of
  // replacing the first, and the UI cannot tell which citation is current.
  assert.match(tableBody('profile_fields'), /PRIMARY KEY\s*\(\s*norad\s*,\s*field\s*\)/i);
});

test('sources.priority is NOT NULL — conflict resolution orders by it', () => {
  assert.match(tableBody('sources'), /priority\s+INTEGER\s+NOT NULL/i);
});

test('ingest_checkpoints is keyed by stage', () => {
  assert.match(tableBody('ingest_checkpoints'), /stage\s+TEXT PRIMARY KEY/i);
});

console.log('\n-- indexes for the read patterns --');

test('the five encyclopedia dimensions and both sidecars are indexed', () => {
  const idxs = [...sql.matchAll(/CREATE INDEX IF NOT EXISTS (\S+)\s+ON\s+(\S+?)\s*\(/g)]
    .map(m => `${m[2]}.${m[1]}`);
  for (const idx of ['profiles.idx_profiles_country', 'profiles.idx_profiles_type',
                     'profiles.idx_profiles_operator', 'profiles.idx_profiles_status',
                     'profiles.idx_profiles_cospar',
                     'profile_fields.idx_profile_fields_norad',
                     'images.idx_images_norad']) {
    assert.ok(idxs.includes(idx), `missing ${idx}`);
  }
});

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
