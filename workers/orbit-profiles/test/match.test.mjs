/**
 * COSPAR matching — the catalogue↔source join, keyed on designator, never name.
 *
 *     node --no-warnings workers/orbit-profiles/test/match.test.mjs
 *
 * Audit finding M-19 (functions/api/object/[norad].js:11-13): names change and a
 * substring test over-matches — "ISS (NAUKA)" and "ISS DEB" both contain "ISS".
 * Getting this wrong is not an error, it is a debris fragment silently carrying
 * the ISS mission description in a database whose whole value is sourced facts.
 *
 * Offline: fixtures only.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeCospar, matchByCospar } from '../src/match.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (n) => fs.readFileSync(path.join(HERE, '../fixtures', n), 'utf8');
const nssdca = JSON.parse(fixture('sample_nssdca.json'));

/** Minimal GCAT TSV reader — header row starts with '#', tab-separated. */
function readGcat(tsv) {
  const lines = tsv.split(/\r?\n/).filter(Boolean);
  const header = lines[0].replace(/^#/, '').split('\t');
  return lines.slice(1).map((l) => {
    const cells = l.split('\t');
    return Object.fromEntries(header.map((h, i) => [h.trim(), cells[i]]));
  });
}
const gcat = readGcat(fixture('sample_gcat.tsv'));

const results = [];
function test(name, fn) {
  try { fn(); results.push(true); console.log('  PASS  ' + name); }
  catch (e) { results.push(false); console.log('  FAIL  ' + name + '\n        ' + e.message); }
}

console.log('\n-- normalizeCospar --');

test('round-trips the canonical, compact and spaced spellings to 1998-067A', () => {
  assert.equal(normalizeCospar('1998-067A'), '1998-067A');
  assert.equal(normalizeCospar('98067A'), '1998-067A');
  assert.equal(normalizeCospar('1998-067  A'), '1998-067A');
  assert.equal(normalizeCospar('  1998-067a '), '1998-067A');
});

test('returns null — not "" — for a name string, so callers tell absent from malformed', () => {
  assert.equal(normalizeCospar('ISS (NAUKA)'), null);
  assert.equal(normalizeCospar('ZARYA'), null);
  assert.equal(normalizeCospar(''), null);
  assert.equal(normalizeCospar(null), null);
  assert.equal(normalizeCospar(undefined), null);
});

test('the two-digit-year pivot: 57 is 1957 (Sputnik), 56 is 2056', () => {
  assert.equal(normalizeCospar('57001A'), '1957-001A');
  assert.equal(normalizeCospar('56001A'), '2056-001A');
  assert.equal(normalizeCospar('99025A'), '1999-025A');
  assert.equal(normalizeCospar('00001A'), '2000-001A');
});

test('multi-letter piece suffixes survive (…067AB)', () => {
  assert.equal(normalizeCospar('1998-067AB'), '1998-067AB');
  assert.equal(normalizeCospar('98067ab'), '1998-067AB');
});

console.log('\n-- matchByCospar: the M-19 trap --');

// Catalogue rows supplied by the caller. Both an ISS module and an 1998-067
// FAMILY debris object are present; the NSSDCA/GCAT row is for 1998-067A only.
// The profile must attach to 25544 ALONE — the debris NORAD must come back
// unmatched. This is the finding M-19 defence.
const catalog = [
  { NORAD_CAT_ID: 25544, OBJECT_ID: '1998-067A' },   // ISS (Zarya)
  { NORAD_CAT_ID: 40258, OBJECT_ID: '1998-067PB' },  // ISS-family debris — must NOT inherit Zarya
  { NORAD_CAT_ID: 47853, OBJECT_ID: '' },            // no designator at all — must not match anything
  { NORAD_CAT_ID: 25730, OBJECT_ID: '99025A' },      // Fengyun 1C, compact spelling in the catalogue
  { NORAD_CAT_ID: 99999, OBJECT_ID: '2020-500Z' },   // catalogue object with no source row
];

test('the ISS profile attaches to 25544 only; 1998-067 debris stays unmatched (M-19)', () => {
  const { matched, unmatchedNorad } = matchByCospar(catalog, nssdca.map((r) => ({
    cospar: r.nssdc_id, ...r,
  })));
  assert.ok(matched.has(25544), 'ISS Zarya should have matched');
  assert.equal(matched.get(25544).spacecraft, 'ISS (Zarya)');
  assert.ok(unmatchedNorad.includes(40258), '1998-067PB debris must NOT inherit Zarya');
  assert.ok(!matched.has(40258));
});

test('matched is keyed by NORAD integer', () => {
  const { matched } = matchByCospar(catalog, nssdca.map((r) => ({ cospar: r.nssdc_id, ...r })));
  assert.ok([...matched.keys()].every((k) => Number.isInteger(k)));
});

test('the compact-form catalogue designator still joins (99025A ↔ 1999-025A)', () => {
  const { matched } = matchByCospar(catalog, nssdca.map((r) => ({ cospar: r.nssdc_id, ...r })));
  assert.ok(matched.has(25730));
  assert.equal(matched.get(25730).spacecraft, 'Fengyun 1C');
});

console.log('\n-- both unmatched directions are return values, not errors --');

test('a source row matching no catalogue object comes back in unmatchedSource', () => {
  const { unmatchedSource } = matchByCospar(catalog, nssdca.map((r) => ({ cospar: r.nssdc_id, ...r })));
  assert.ok(unmatchedSource.some((s) => s.cospar === '1974-089A'));
});

test('a catalogue object matching no source row comes back in unmatchedNorad', () => {
  const { unmatchedNorad } = matchByCospar(catalog, nssdca.map((r) => ({ cospar: r.nssdc_id, ...r })));
  assert.ok(unmatchedNorad.includes(99999));
});

test('the GCAT fixture joins through the same normalisation (compact S27424 row)', () => {
  const rows = gcat.map((r) => ({ cospar: r.Piece, ...r }));
  const { matched } = matchByCospar(
    [{ NORAD_CAT_ID: 25544, OBJECT_ID: '1998-067A' }],
    rows,
  );
  // Both the canonical S26758 and the compact-spelled S27424 GCAT rows are for
  // 1998-067A — the join must not throw and must produce a match for 25544.
  assert.ok(matched.has(25544));
});

process.on('exit', () => {
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  if (passed !== results.length) process.exitCode = 1;
});
