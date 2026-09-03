/**
 * GCAT bulk-source parsing — satcat.tsv + orgs.tsv into the {byField, spine}
 * shape runFacts() consumes.
 *
 *     node --no-warnings workers/orbit-profiles/test/gcat.test.mjs
 *
 * The risk this test exists for: satcat.tsv carries org/country/manufacturer as
 * GCAT *codes* ("SU", "KHRUN"), not display names. buildGcatIndex must resolve
 * them through orgs.tsv, and must key the result on the canonical COSPAR so the
 * catalogue join in runFacts works — the compact-spelled debris row exercises
 * both. GCAT's absent-value tokens ("-", "?", empty) must produce no fact, not a
 * fact whose value is a dash.
 *
 * Offline: fixtures only, no network.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTsv, parseOrgs, buildGcatIndex, mapStatusCode } from '../src/gcat.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (n) => fs.readFileSync(path.join(HERE, '../fixtures', n), 'utf8');
const satcat = fixture('sample_satcat.tsv');
const orgs = fixture('sample_orgs.tsv');

const results = [];
function test(name, fn) {
  Promise.resolve().then(fn)
    .then(() => { results.push(true); console.log('  PASS  ' + name); })
    .catch((e) => { results.push(false); console.log('  FAIL  ' + name + '\n        ' + e.message); });
}

console.log('\n-- parseTsv: the GCAT TSV shape --');

test('the "#"-prefixed header names the columns; rows are objects keyed by them', () => {
  const { header, rows } = parseTsv(satcat);
  assert.equal(header[0], 'JCAT');
  assert.ok(header.includes('Piece') && header.includes('Owner') && header.includes('State'));
  assert.equal(rows[0].Piece, '1998-067A');
  assert.equal(rows[0].Name, 'Zarya');
  assert.equal(rows[0].Owner, 'RSA');
});

test('a row with fewer cells than the header still parses; missing cells are absent', () => {
  const { rows } = parseTsv('#A\tB\tC\nx\ty\n');
  assert.equal(rows[0].A, 'x');
  assert.equal(rows[0].B, 'y');
  assert.equal(rows[0].C ?? '', '');
});

test('a "# Updated ..." comment line after the header is not parsed as a data row', () => {
  // GCAT files carry a `# Updated <date>` line immediately below the header.
  const { rows } = parseTsv('#A\tB\n# Updated 2026 Aug 30\nx\ty\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].A, 'x');
});

test('padded numeric and code cells are trimmed', () => {
  const { rows } = parseTsv('#Mass\tOwner\n    7790 \tOKB1   \n');
  assert.equal(rows[0].Mass.trim(), '7790');
  assert.equal(rows[0].Owner.trim(), 'OKB1');
});

console.log('\n-- parseOrgs: code -> {name, ename, shortEName, stateCode} --');

test('captures Name, the English EName/ShortEName, and the owning state code', () => {
  const map = parseOrgs(orgs);
  assert.equal(map.get('KHRUN').name, 'NPO Mashinostroeniya (Khrunichev)');
  assert.equal(map.get('KHRUN').ename, 'Khrunichev');        // EName: the clean English form
  assert.equal(map.get('KHRUN').stateCode, 'SU');
  // GCAT's country Name is the transliterated native form; ShortEName is the
  // usable label ("China", not "Zhonghua Renmin Gongheguo").
  assert.equal(map.get('CN').name, 'Zhonghua Renmin Gongheguo');
  assert.equal(map.get('CN').shortEName, 'China');
  assert.equal(map.get('SU').shortEName, 'USSR');
});

console.log('\n-- buildGcatIndex: keyed by canonical COSPAR --');

const index = buildGcatIndex(satcat, orgs);

test('the index is keyed by the canonical COSPAR form (1998-067A, not S26758)', () => {
  assert.ok(index.has('1998-067A'));
  assert.ok(!index.has('S26758'));
});

test('a compact-spelled Piece (98067F) is normalised to the canonical key', () => {
  assert.ok(index.has('1998-067F'));
});

console.log('\n-- the spine: profiles columns, GCAT value or null --');

test('the Zarya spine carries the profiles column set with GCAT-sourced values', () => {
  const { spine } = index.get('1998-067A');
  assert.equal(spine.cospar, '1998-067A');
  assert.equal(spine.official_name, 'Zarya');
  assert.equal(spine.bus, 'FGB');
  assert.equal(spine.launch_mass_kg, 19323);
  assert.equal(spine.status, 'in orbit');   // GCAT 'GRP' (grappled to the ISS) — on orbit
});

test('org codes resolve to the English name; country codes to the short English name', () => {
  const { spine } = index.get('1998-067A');
  assert.equal(spine.manufacturer, 'Khrunichev');                    // KHRUN EName
  assert.equal(spine.operator_name, 'Russian Federal Space Agency'); // RSA EName
  assert.equal(spine.owner_country, 'USSR');                         // State SU ShortEName
});

test('an org with no English name at all falls back to Name (NOAA, CMA)', () => {
  const { spine } = index.get('2020-500Z');   // Orphan Sat: Owner NOAA, State US
  assert.equal(spine.operator_name, 'National Oceanic and Atmospheric Administration');
  assert.equal(spine.owner_country, 'USA');    // US has a ShortEName
});

test('the spine has every profiles column present as a key (null where GCAT is silent)', () => {
  const { spine } = index.get('1998-067A');
  for (const col of ['cospar', 'official_name', 'mission_summary', 'operator_name',
    'owner_country', 'bus', 'manufacturer', 'launch_mass_kg', 'power_w',
    'design_life_years', 'mission_type', 'status']) {
    assert.ok(col in spine, `spine missing column ${col}`);
  }
  assert.equal(spine.power_w, null);            // satcat.tsv has no power
  assert.equal(spine.mission_summary, null);    // GCAT does not describe missions
});

console.log('\n-- Status maps to an honest facet vocabulary --');

test('the on-orbit codes (O, GRP, DK, AO, N, DEP…) all map to "in orbit"', () => {
  assert.equal(index.get('1998-067A').spine.status, 'in orbit');   // GRP — grappled to the ISS
  for (const c of ['O', 'OX', 'GRP', 'DK', 'AO', 'AO IN', 'ATT', 'N', 'DEP', 'REL', 'UDK'])
    assert.equal(mapStatusCode(c), 'in orbit', `${c} should be "in orbit"`);
});

test('the reentry codes (R, D, S, AR…) map to "decayed"', () => {
  assert.equal(index.get('1999-025A').spine.status, 'decayed');   // R
  assert.equal(index.get('1957-001B').spine.status, 'decayed');   // R (Sputnik)
  for (const c of ['R', 'D', 'S', 'AR', 'AR IN', 'AS'])
    assert.equal(mapStatusCode(c), 'decayed', `${c} should be "decayed"`);
});

test('landed and deep-space codes get their own labels; unknown codes stay null', () => {
  for (const c of ['L', 'LF', 'AL', 'AL IN']) assert.equal(mapStatusCode(c), 'landed');
  for (const c of ['DSO', 'DSA', 'EO', 'EN']) assert.equal(mapStatusCode(c), 'deep space');
  for (const c of ['E', 'REFLT', 'ERR', 'ZZ', '']) assert.equal(mapStatusCode(c), null);
});

console.log('\n-- absent-value tokens produce no fact --');

test('"-", "?" and empty cells become null in the spine and absent from byField', () => {
  const { spine, byField } = index.get('1998-067F');   // the ISS DEB row: owner/state/mfr all "?"
  assert.equal(spine.operator_name, null);
  assert.equal(spine.owner_country, null);
  assert.equal(spine.manufacturer, null);
  assert.equal(spine.launch_mass_kg, null);            // Mass was "-"
  assert.ok(!('operator_name' in byField), 'unknown owner must not be a provenance fact');
  assert.ok(!('launch_mass_kg' in byField));
});

console.log('\n-- byField: one gcat-sourced candidate per populated field --');

test('every byField entry is a single-element array of a gcat Fact with a source_url', () => {
  const { byField } = index.get('1998-067A');
  for (const [field, cands] of Object.entries(byField)) {
    assert.ok(Array.isArray(cands) && cands.length === 1, `${field} is not a 1-element array`);
    assert.equal(cands[0].source_id, 'gcat');
    assert.ok(cands[0].source_url && cands[0].source_url.includes('planet4589'),
      `${field} fact has no GCAT source_url`);
    assert.equal(cands[0].value, index.get('1998-067A').spine[field]);
  }
});

test('byField covers exactly the populated spine fields, minus cospar (the key, not a fact)', () => {
  const { spine, byField } = index.get('1998-067A');
  const populated = Object.keys(spine)
    .filter((k) => k !== 'cospar' && spine[k] != null).sort();
  assert.deepEqual(Object.keys(byField).sort(), populated);
});

test('resolveConflicts + writeFacts accept a buildGcatIndex candidate unchanged', async () => {
  // The shape contract with runFacts: sources.get(cospar) -> {byField, spine},
  // then resolveConflicts(byField) and writeFacts(db, norad, resolved, spine).
  const { resolveConflicts, writeFacts } = await import('../src/facts.js');
  const { fakeDB, matching } = await import('./fakes.mjs');
  const cand = index.get('1998-067A');
  const resolved = resolveConflicts(cand.byField);
  const db = fakeDB();
  const n = await writeFacts(db, 25544, resolved, cand.spine);
  assert.equal(n.profiles, 1);
  assert.ok(n.fields > 0);
  assert.equal(matching(db, /INTO profiles/i).length, 1);
  for (const w of matching(db, /INTO profile_fields/i)) assert.equal(w.args[1] in cand.spine, true);
});

process.on('exit', () => {
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  if (passed !== results.length) process.exitCode = 1;
});
