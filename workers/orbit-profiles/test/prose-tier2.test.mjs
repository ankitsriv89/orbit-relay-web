/**
 * Tier 2 prose — deterministic templated description, no model call.
 *
 *     node --no-warnings workers/orbit-profiles/test/prose-tier2.test.mjs
 *
 * ~25k of ~28k catalogued objects are debris and rocket bodies. They have no
 * mission and MUST NEVER be described as having one. Tier 2 covers them from
 * SATCAT fields already held: zero hallucination surface, zero cost, and
 * reproducible byte-for-byte so 25k rows stay diffable.
 */
import assert from 'node:assert/strict';
import { tier2Prose } from '../src/prose-tier2.js';
import { validateProse } from '../src/validate.js';

const results = [];
function test(name, fn) {
  try { fn(); results.push(true); console.log('  PASS  ' + name); }
  catch (e) { results.push(false); console.log('  FAIL  ' + name + '\n        ' + e.message); }
}

const MISSION_WORDS = /\b(mission|purpose|operat(?:es|or|ed)|payload carr|designed to|tasked with|provides|observ|communicat|navigat|reconnaissance|surveill)/i;

const iss = {
  OBJECT_NAME: 'ISS (ZARYA)', OBJECT_TYPE: 'PAYLOAD', OBJECT_ID: '1998-067A',
  LAUNCH_DATE: '1998-11-20', INCLINATION: 51.64, APOAPSIS: 421, PERIAPSIS: 413,
  COUNTRY_CODE: 'ISS', regime: 'LEO',
};
const debris = {
  OBJECT_NAME: 'FENGYUN 1C DEB', OBJECT_TYPE: 'DEBRIS', OBJECT_ID: '1999-025DTG',
  LAUNCH_DATE: '1999-05-10', INCLINATION: 98.6, APOAPSIS: 851, PERIAPSIS: null,
  COUNTRY_CODE: 'PRC', regime: 'LEO',
};
const rb = {
  OBJECT_NAME: 'SL-4 R/B', OBJECT_TYPE: 'ROCKET BODY', OBJECT_ID: '2019-047B',
  LAUNCH_DATE: '2019-07-20', INCLINATION: 71.0, APOAPSIS: 355, PERIAPSIS: 340,
  COUNTRY_CODE: 'CIS', regime: 'LEO',
};

console.log('\n-- determinism --');

test('two calls on the same row are byte-identical', () => {
  assert.equal(tier2Prose(rb), tier2Prose(rb));
  assert.equal(tier2Prose(iss), tier2Prose(iss));
  assert.equal(tier2Prose(debris), tier2Prose(debris));
});

test('no clock / timestamp leaks in — output does not change between runs', () => {
  const a = tier2Prose(rb);
  const b = JSON.parse(JSON.stringify({ p: tier2Prose(rb) })).p;
  assert.equal(a, b);
});

console.log('\n-- debris and rocket bodies claim no mission --');

test('a DEBRIS row produces no mission or purpose language', () => {
  const p = tier2Prose(debris);
  assert.doesNotMatch(p, MISSION_WORDS, `debris prose leaked mission language: ${p}`);
  assert.match(p, /debris/i);
});

test('a ROCKET BODY row produces no mission or purpose language', () => {
  const p = tier2Prose(rb);
  assert.doesNotMatch(p, MISSION_WORDS, `rocket-body prose leaked mission language: ${p}`);
  assert.match(p, /rocket body|stage/i);
});

console.log('\n-- degrades on missing fields --');

test('a row missing perigee still yields a sentence, no undefined / NaN / dangling unit', () => {
  const p = tier2Prose(debris);
  assert.ok(p.length > 0);
  assert.doesNotMatch(p, /undefined|NaN|null/);
  assert.doesNotMatch(p, /×\s*(km)?\s*$/); // no dangling "× " or "× km"
  assert.doesNotMatch(p, /\bx\s*km\b/i);
});

test('a row missing both apsides and inclination still yields a sentence', () => {
  const bare = { OBJECT_NAME: 'SL-4 R/B', OBJECT_TYPE: 'ROCKET BODY', OBJECT_ID: '2019-047B',
    LAUNCH_DATE: '2019-07-20' };
  const p = tier2Prose(bare);
  assert.ok(p.length > 0);
  assert.doesNotMatch(p, /undefined|NaN/);
});

test('a row with essentially nothing still yields a non-empty string', () => {
  const p = tier2Prose({ OBJECT_TYPE: 'UNKNOWN' });
  assert.equal(typeof p, 'string');
  assert.ok(p.length > 0);
});

console.log('\n-- Tier 2 passes Task 3’s validator --');

// Every numeral tier2Prose emits comes from the row, so Tier 2 must pass its own
// validator. Wiring this here proves the two modules agree before Task 6 leans
// on validateProse to gate Tier 3.
for (const [label, row] of [['ISS', iss], ['debris', debris], ['rocket body', rb]]) {
  test(`${label}: every numeral in the output is present in the row (validateProse ok)`, () => {
    const p = tier2Prose(row);
    const facts = { ...row };
    const r = validateProse(p, facts);
    assert.equal(r.ok, true, `validator rejected Tier 2 ${label} prose: ${r.reason}\n  ${p}`);
  });
}

console.log('\n-- register matches the spec example --');

test('the rocket-body sentence reads like the spec target', () => {
  // spec: "SL-4 rocket body from the 2019-047 launch, in a 71.0° orbit at 340 × 355 km."
  // Inclination is emitted at the row's precision (71 here), not forced to 71.0 —
  // see orbitClause: a forced decimal is a numeral the validator has no fact for.
  const p = tier2Prose(rb);
  assert.match(p, /\bSL-4 rocket body\b/);
  assert.match(p, /from the 2019-047 launch/);
  assert.match(p, /71°/);
  assert.match(p, /340\s*×\s*355\s*km/);
});

process.on('exit', () => {
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  if (passed !== results.length) process.exitCode = 1;
});
