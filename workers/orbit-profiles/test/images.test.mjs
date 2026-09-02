/**
 * Image ingest — public-domain imagery to R2 with provenance.
 *
 *     node --no-warnings workers/orbit-profiles/test/images.test.mjs
 *
 * Imagery is NASA / USGS / NOAA only (public domain, 17 U.S.C. §105). The
 * allowlist entry is `nasa-imagery`, not "NASA", because the NASA logo/insignia
 * are protected separately. Commercial press-kit images are editorial-use
 * licensed and this database is not editorial use — excluded, same hard line as
 * Task 2. assertAllowed() runs BEFORE any fetch.
 *
 * Failure is a normal outcome: most of the catalogue has no image. Every
 * failure path returns null and writes nothing — a missing image must not fail
 * the run for the other 27,999 objects.
 *
 * Offline: a fake fetch and fakeR2, no network.
 */
import assert from 'node:assert/strict';
import { ingestImage } from '../src/images.js';
import { fakeR2 } from './fakes.mjs';

const results = [];
function test(name, fn) {
  Promise.resolve().then(fn)
    .then(() => { results.push(true); console.log('  PASS  ' + name); })
    .catch((e) => { results.push(false); console.log('  FAIL  ' + name + '\n        ' + e.message); });
}

// A 1×1 WebP (VP8L), enough bytes for a real decode of the dimensions.
const WEBP_1x1 = Buffer.from(
  'UklGRhIAAABXRUJQVlA4TAYAAAAvAAAAAAfQ//73v/+BiOh/AAA=', 'base64');
// A minimal PNG (used for the "thumb from a different rendition" case).
const PNG_2x3 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAADElEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64');

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const r = routes[url];
    if (!r) return { ok: false, status: 404, headers: new Map(), async arrayBuffer() { return new ArrayBuffer(0); } };
    if (r.throw) throw new Error('socket hang up');
    return {
      ok: r.status ? r.status < 400 : true,
      status: r.status || 200,
      headers: { get: (k) => (r.headers || {})[k.toLowerCase()] },
      async arrayBuffer() { return r.body.buffer.slice(r.body.byteOffset, r.body.byteOffset + r.body.byteLength); },
    };
  };
  fn.calls = calls;
  return fn;
}

const NASA = {
  url: 'https://images-assets.nasa.gov/image/iss/iss~medium.webp',
  credit: 'NASA/Roscosmos',
  license: 'public-domain',
  source_id: 'nasa-imagery',
};

console.log('\n-- a disallowed source is rejected BEFORE any fetch --');

test('a commercial source returns null and performs no fetch at all', async () => {
  const r2 = fakeR2();
  const fetch = fakeFetch({});
  const out = await ingestImage({ ORBIT_R2: r2, fetch }, 25544, {
    url: 'https://maxar.example/iss.jpg', credit: 'Maxar', license: 'editorial',
    source_id: 'maxar',
  });
  assert.equal(out, null);
  assert.equal(fetch.calls.length, 0, 'assertAllowed must run before the fetch');
  assert.equal(r2.puts.size, 0);
});

console.log('\n-- a successful ingest --');

test('writes two R2 objects at the fixed key shape and returns keys + real dimensions', async () => {
  const r2 = fakeR2();
  const fetch = fakeFetch({
    [NASA.url]: { body: WEBP_1x1, headers: { 'content-type': 'image/webp' } },
  });
  const out = await ingestImage({ ORBIT_R2: r2, fetch }, 25544, NASA);
  assert.ok(out, 'expected a result');
  assert.match(out.r2_key, /^profiles\/25544\/primary\./);
  assert.match(out.thumb_key, /^profiles\/25544\/thumb\./);
  assert.ok(r2.puts.has(out.r2_key));
  assert.ok(r2.puts.has(out.thumb_key));
  assert.equal(out.width, 1);
  assert.equal(out.height, 1);
});

test('a separate thumbnail URL is fetched and stored as the thumb', async () => {
  const r2 = fakeR2();
  const thumbUrl = 'https://images-assets.nasa.gov/image/iss/iss~thumb.png';
  const fetch = fakeFetch({
    [NASA.url]: { body: WEBP_1x1, headers: { 'content-type': 'image/webp' } },
    [thumbUrl]: { body: PNG_2x3, headers: { 'content-type': 'image/png' } },
  });
  const out = await ingestImage({ ORBIT_R2: r2, fetch }, 25544, { ...NASA, thumbUrl });
  assert.ok(fetch.calls.includes(thumbUrl));
  assert.ok(r2.puts.has(out.thumb_key));
});

console.log('\n-- every failure path returns null and writes nothing --');

for (const [label, route] of [
  ['a 404', { [NASA.url]: undefined }],
  ['a non-image content type', { [NASA.url]: { body: WEBP_1x1, headers: { 'content-type': 'text/html' } } }],
  ['a fetch that throws', { [NASA.url]: { throw: true } }],
  ['an undecodable body', { [NASA.url]: { body: Buffer.from('not an image'), headers: { 'content-type': 'image/webp' } } }],
]) {
  test(`${label} returns null and writes nothing to R2`, async () => {
    const r2 = fakeR2();
    const fetch = fakeFetch(route);
    const out = await ingestImage({ ORBIT_R2: r2, fetch }, 25544, NASA);
    assert.equal(out, null);
    assert.equal(r2.puts.size, 0);
  });
}

console.log('\n-- provenance on the images row --');

test('credit and license are returned for the images row', async () => {
  const r2 = fakeR2();
  const fetch = fakeFetch({ [NASA.url]: { body: WEBP_1x1, headers: { 'content-type': 'image/webp' } } });
  const out = await ingestImage({ ORBIT_R2: r2, fetch }, 25544, NASA);
  assert.equal(out.credit, 'NASA/Roscosmos');
  assert.equal(out.license, 'public-domain');
  assert.equal(out.source_url, NASA.url);
});

test('an image with no credit is refused — cannot legally be displayed', async () => {
  const r2 = fakeR2();
  const fetch = fakeFetch({ [NASA.url]: { body: WEBP_1x1, headers: { 'content-type': 'image/webp' } } });
  const out = await ingestImage({ ORBIT_R2: r2, fetch }, 25544, { ...NASA, credit: '' });
  assert.equal(out, null);
  assert.equal(r2.puts.size, 0);
});

process.on('exit', () => {
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  if (passed !== results.length) process.exitCode = 1;
});
