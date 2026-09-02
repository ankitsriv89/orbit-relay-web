/**
 * The numeral validator — written before any Tier 3 generator exists.
 *
 *     node --no-warnings workers/orbit-profiles/test/validate.test.mjs
 *
 * The rule (from the spec, and the same discipline as checkNarrative() in
 * workers/orbit-ingest/src/brief.js): reject any sentence containing a numeral
 * absent from the input facts — INCLUDING a correct one the model derived. From
 * the output alone a correct derivation is indistinguishable from an invention,
 * and a 20B model drifts numbers readily enough that this is load-bearing, not
 * defensive.
 *
 * Pure module — two plain arguments, no I/O.
 */
import assert from 'node:assert/strict';
import { validateProse, extractNumerals, factNumerals } from '../src/validate.js';

const results = [];
function test(name, fn) {
  try { fn(); results.push(true); console.log('  PASS  ' + name); }
  catch (e) { results.push(false); console.log('  FAIL  ' + name + '\n        ' + e.message); }
}

console.log('\n-- the headline case: a fabricated mass --');

test('rejects prose claiming a launch mass the facts do not give', () => {
  const facts = { launch_mass_kg: 6161, official_name: 'Envisat' };
  const r = validateProse('Envisat had a launch mass of 6,500 kg.', facts);
  assert.equal(r.ok, false);
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0], /6,500 kg/);
  assert.match(r.reason, /6500/);
});

console.log('\n-- the uncomfortable case: a CORRECT derived number --');

// This is the test that documents the rule's whole point. `16` is arithmetically
// correct from a 92.68-minute period (1440 / 92.68 = 15.5...). It must STILL be
// rejected: at scale we cannot tell this apart from "carries 6 instruments"
// invented from facts that list none.
test('rejects a derived orbit count even though the arithmetic checks out', () => {
  const facts = { period_min: 92.68 };
  const r = validateProse('It orbits Earth about 16 times a day.', facts);
  assert.equal(r.ok, false);
  assert.equal(r.rejected.length, 1);
  assert.match(r.reason, /16/);
});

console.log('\n-- the pass case --');

test('accepts prose using only numerals present in the facts', () => {
  const facts = { launch_mass_kg: 6161, period_min: 92.68, launch_year: 2002 };
  const r = validateProse(
    'Launched in 2002, the 6,161 kg spacecraft completes an orbit every 92.68 minutes.',
    facts,
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.rejected, []);
  assert.equal(r.reason, null);
});

test('a thousands separator in prose matches a bare number in the facts', () => {
  const r = validateProse('It masses 6,161 kg.', { launch_mass_kg: 6161 });
  assert.equal(r.ok, true);
});

test('trailing zeros do not matter: 92.680 in prose matches 92.68 in facts', () => {
  const r = validateProse('Its period is 92.680 minutes.', { period_min: 92.68 });
  assert.equal(r.ok, true);
});

console.log('\n-- mixed: one clean sentence, one not --');

test('rejects exactly the offending sentence in a two-sentence input', () => {
  const facts = { launch_mass_kg: 6161, launch_year: 2002 };
  const r = validateProse(
    'It was launched in 2002. It carries 6 scientific instruments.',
    facts,
  );
  assert.equal(r.ok, false);
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0], /6 scientific instruments/);
  assert.doesNotMatch(r.rejected[0], /launched in 2002/);
});

console.log('\n-- no numerals at all --');

test('purely qualitative prose passes', () => {
  const r = validateProse(
    'It is an Earth-observation satellite operated by a European agency, now retired.',
    { mission_type: 'Earth observation', status: 'retired' },
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.rejected, []);
});

console.log('\n-- years and COSPAR designators --');

test('a year stated in prose passes when that year is in the facts (via the COSPAR id)', () => {
  const r = validateProse('The 1998 launch placed it in low Earth orbit.',
    { cospar: '1998-067A' });
  assert.equal(r.ok, true);
});

test('the digits of a COSPAR designator in prose are not treated as a claim', () => {
  // "1998-067A" appears verbatim in both facts and prose — the hyphen/letter
  // form must be recognised, not split into an unsupported "067".
  const r = validateProse('Module 1998-067A is part of the ISS.', { cospar: '1998-067A' });
  assert.equal(r.ok, true);
});

test('a COSPAR in the facts does not open a hole for an invented four-figure mass', () => {
  // 1998-067A contributes 1998 and 67 — not 5000.
  const r = validateProse('It has a dry mass of 5000 kg.', { cospar: '1998-067A' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /5000/);
});

console.log('\n-- the helpers directly --');

test('extractNumerals normalises commas and trailing zeros', () => {
  assert.deepEqual(extractNumerals('6,161 kg over 92.680 min, 0 losses'),
    ['6161', '92.68', '0']);
});

test('factNumerals walks nested values and strings, returning a Set', () => {
  const s = factNumerals({ mass: 6161, tags: ['launched 2002'], nested: { power_w: 1900 } });
  assert.ok(s instanceof Set);
  assert.ok(s.has('6161'));
  assert.ok(s.has('2002'));
  assert.ok(s.has('1900'));
});

process.on('exit', () => {
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  if (passed !== results.length) process.exitCode = 1;
});
