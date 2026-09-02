/**
 * Tier 3 prose — constrained rewriting behind the numeral validator.
 *
 *     node --no-warnings workers/orbit-profiles/test/prose-tier3.test.mjs
 *
 * The model is given verified Tier 1 facts and asked to phrase them. It never
 * sources a number. Every string tier3Prose() returns has passed validateProse;
 * on rejection it returns the Tier 2 fallback with tier: 2 and the offending
 * sentences — it never publishes unvalidated prose and never retries to make it
 * pass. It never throws: a 429, a timeout, a malformed response and a null
 * client all resolve to the fallback.
 */
import assert from 'node:assert/strict';
import { tier3Prose } from '../src/prose-tier3.js';
import { fakeAI } from './fakes.mjs';

const results = [];
function test(name, fn) {
  Promise.resolve().then(fn)
    .then(() => { results.push(true); console.log('  PASS  ' + name); })
    .catch((e) => { results.push(false); console.log('  FAIL  ' + name + '\n        ' + e.message); });
}

const FACTS = {
  official_name: 'Envisat',
  operator_name: 'European Space Agency',
  launch_mass_kg: 8211,
  launch_year: 2002,
  mission_type: 'Earth observation',
  status: 'retired',
};
const FALLBACK = 'Envisat is a catalogued spacecraft from the 2002-009 launch, in a 98.5° orbit at 765 × 767 km.';
const MODEL = 'openai/gpt-oss-20b';

console.log('\n-- a fabricated numeral downgrades to Tier 2 --');

test('a response with an invented mass returns tier 2, the fallback verbatim, and the offending sentence', async () => {
  const ai = fakeAI(() => 'Envisat, operated by the European Space Agency, had a launch mass of 9000 kg.');
  const r = await tier3Prose(ai, MODEL, FACTS, FALLBACK);
  assert.equal(r.tier, 2);
  assert.equal(r.prose, FALLBACK);
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0], /9000 kg/);
});

console.log('\n-- a clean response is published as Tier 3 --');

test('a response using only supported numerals returns tier 3', async () => {
  const ai = fakeAI(() => 'Launched in 2002, the 8,211 kg Envisat was an ESA Earth-observation satellite, now retired.');
  const r = await tier3Prose(ai, MODEL, FACTS, FALLBACK);
  assert.equal(r.tier, 3);
  assert.match(r.prose, /Envisat/);
  assert.deepEqual(r.rejected, []);
});

test('a purely qualitative response returns tier 3', async () => {
  const ai = fakeAI(() => 'Envisat was a large European Earth-observation satellite, now retired from service.');
  const r = await tier3Prose(ai, MODEL, FACTS, FALLBACK);
  assert.equal(r.tier, 3);
});

console.log('\n-- never throws --');

test('a client that throws a 429 returns the fallback and does not throw', async () => {
  const ai = fakeAI(() => { const e = new Error('Groq 429: rate limited'); throw e; });
  const r = await tier3Prose(ai, MODEL, FACTS, FALLBACK);
  assert.equal(r.tier, 2);
  assert.equal(r.prose, FALLBACK);
});

test('a null client returns the fallback', async () => {
  const r = await tier3Prose(null, MODEL, FACTS, FALLBACK);
  assert.equal(r.tier, 2);
  assert.equal(r.prose, FALLBACK);
});

test('a malformed (empty) response returns the fallback', async () => {
  const ai = fakeAI(() => '');
  const r = await tier3Prose(ai, MODEL, FACTS, FALLBACK);
  assert.equal(r.tier, 2);
});

test('a response that is only whitespace/markdown noise returns the fallback', async () => {
  const ai = fakeAI(() => '```\n\n```');
  const r = await tier3Prose(ai, MODEL, FACTS, FALLBACK);
  assert.equal(r.tier, 2);
});

console.log('\n-- the prompt asks only for phrasing of the given facts --');

test('the prompt contains the facts and does not request anything absent from them', async () => {
  const ai = fakeAI(() => 'Envisat was a European Earth-observation satellite.');
  await tier3Prose(ai, MODEL, FACTS, FALLBACK);
  const sent = JSON.stringify(ai.calls[0].input).toLowerCase();
  assert.ok(sent.includes('envisat'));
  assert.ok(sent.includes('8211') || sent.includes('8,211'));
  assert.ok(sent.includes('earth observation') || sent.includes('earth-observation'));
  // It must instruct the model not to introduce numbers.
  assert.ok(/only the (numbers|facts|figures)|never (compute|invent|estimate)/.test(sent));
});

test('the model it is told to use is the one passed, not a hardcoded name', async () => {
  const ai = fakeAI(() => 'Envisat was an ESA satellite.');
  await tier3Prose(ai, 'some/other-model', FACTS, FALLBACK);
  assert.equal(ai.calls[0].model, 'some/other-model');
});

process.on('exit', () => {
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  if (passed !== results.length) process.exitCode = 1;
});
