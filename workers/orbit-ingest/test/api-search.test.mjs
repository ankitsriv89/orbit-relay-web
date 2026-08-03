/**
 * public/spacetrack/shared/api.js — API.search() URL construction.
 *
 *     node workers/orbit-ingest/test/api-search.test.mjs
 *
 * Regression guard for "TypeError: Failed to construct 'URL': Invalid URL",
 * which broke both loadDefault() and the render() button on /spacetrack/.
 *
 * search() used to be the only method here that built a `new URL(path, base)`.
 * On a file:// page `window.location.origin` is the *string* "null", and
 * `new URL('/api/search', 'null')` throws — so the whole catalog page failed to
 * load its objects while the other nine methods, which hand relative paths
 * straight to fetch(), kept working. The fix is for search() to do the same and
 * build its query with URLSearchParams.
 *
 * api.js reads localStorage/location at import time, so the browser globals are
 * stubbed before the dynamic import below.
 */
import assert from 'node:assert/strict';

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS  ' + name); }
  catch (e) { results.push(false); console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); }
}

/* ── Browser stubs ──────────────────────────────────────────────────────── */

/* The failing case: a file:// document. origin is "null", search is "". */
globalThis.window = { location: { origin: 'null', search: '' } };
globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
};

let lastUrl = null;
globalThis.fetch = async (url) => {
  lastUrl = String(url);
  return { ok: true, status: 200, json: async () => ({ objects: [] }) };
};

const { API } = await import('../../../public/spacetrack/shared/api.js');

/* ── Tests ──────────────────────────────────────────────────────────────── */

console.log('\n-- API.search() on a file:// origin --');

await test('does not throw when location.origin is "null"', async () => {
  await API.search({ type: 'PAYLOAD' });
});

await test('sends a relative /api path fetch() can resolve', async () => {
  await API.search({ type: 'PAYLOAD' });
  assert.equal(lastUrl, '/api/search?type=PAYLOAD');
});

console.log('\n-- query construction --');

await test('no params yields a bare path with no trailing "?"', async () => {
  await API.search({});
  assert.equal(lastUrl, '/api/search');
});

await test('empty and null values are omitted', async () => {
  await API.search({ q: '', type: null, country: 'US' });
  assert.equal(lastUrl, '/api/search?country=US');
});

await test('multiple params are joined with &', async () => {
  await API.search({ type: 'PAYLOAD', limit: 50 });
  assert.equal(lastUrl, '/api/search?type=PAYLOAD&limit=50');
});

await test('values are percent-encoded', async () => {
  await API.search({ q: 'ISS ZARYA&x=1' });
  assert.equal(lastUrl, '/api/search?q=ISS+ZARYA%26x%3D1');
});

await test('0 and false are kept, not dropped as falsy', async () => {
  await API.search({ page: 0, active: false });
  assert.equal(lastUrl, '/api/search?page=0&active=false');
});

/* ── Summary ────────────────────────────────────────────────────────────── */

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
if (passed !== results.length) process.exit(1);
