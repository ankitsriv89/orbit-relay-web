/**
 * public/orbit-engine/ — worker path messages must never crash the render loop.
 *
 *     node workers/orbit-ingest/test/path-unpack.test.mjs
 *
 * `unpackPositions(xyz, count)` turns the propagation worker's packed buffer
 * into Cartesian3s for an orbit ring / ground track. It runs inside the
 * worker's `onmessage`, which Cesium services from its render loop — so an
 * uncaught throw there does not degrade one polyline, it makes Cesium STOP
 * RENDERING and paint
 *
 *     "An error occurred while rendering. Rendering has stopped.
 *      RangeError: Failed to set the 'length' property on 'Array':
 *      Invalid array length"
 *
 * over the globe. That dialog was live on /orbit/, /starlink/ and
 * /constellations/ in production.
 *
 * `new Array(n)` throws RangeError for NaN, negative, fractional and
 * out-of-range n — and `count` arrives straight off a postMessage. Two ways it
 * goes bad:
 *
 *   1. propagate.worker.js's `path()` gave up on an unparseable TLE with
 *      `postMessage({ type:'path', job, count: 0 })` — no `xyz` at all.
 *   2. `period = periodMin || (2π)/rec.no` is Infinity when a malformed or
 *      decayed element set leaves `rec.no` at 0, which makes every sample date
 *      an Invalid Date and walks NaN into the vertex count.
 *
 * The function is a module-private in sat-engine.js (which imports Cesium and
 * cannot be imported in Node), so it is extracted from source and evaluated
 * against a Cartesian3 stub — the assertions still run the REAL code, and the
 * extraction itself is asserted so a rename cannot silently skip this file.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS  ' + name); }
  catch (e) { results.push(false); console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); }
}

/* ── Extract unpackPositions from sat-engine.js ─────────────────────────── */

const ENGINE_SRC = read('public/orbit-engine/sat-engine.js');

function loadUnpackPositions() {
  const m = ENGINE_SRC.match(/function unpackPositions\s*\([\s\S]*?\n\}/);
  assert.ok(m, 'unpackPositions must exist in sat-engine.js (renamed? update this test)');
  const Cesium = { Cartesian3: function (x, y, z) { this.x = x; this.y = y; this.z = z; } };
  // eslint-disable-next-line no-new-func
  return new Function('Cesium', `${m[0]}; return unpackPositions;`)(Cesium);
}

const unpackPositions = loadUnpackPositions();

/* ── The crash inputs ───────────────────────────────────────────────────── */

console.log('\n-- unpackPositions never throws on a malformed message --');

const XYZ = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);

// Each of these makes a bare `new Array(count)` throw RangeError.
const BAD_COUNTS = [
  ['undefined (message shipped no count)', undefined],
  ['NaN (Infinity period → Invalid Date)', NaN],
  ['negative', -1],
  ['fractional', 2.5],
  ['larger than 2^32', 1e30],
  ['Infinity', Infinity],
  ['null', null],
  ['a string', 'three'],
];

for (const [label, count] of BAD_COUNTS) {
  await test(`count = ${label} returns [] instead of throwing`, () => {
    let out;
    assert.doesNotThrow(() => { out = unpackPositions(XYZ, count); },
      `unpackPositions must not throw for count=${String(count)} — it runs in ` +
      `Cesium's render loop, where a throw stops rendering entirely`);
    assert.ok(Array.isArray(out), 'must still return an array');
  });
}

await test('a missing xyz buffer returns [] instead of throwing', () => {
  let out;
  assert.doesNotThrow(() => { out = unpackPositions(undefined, 4); });
  assert.deepEqual(out, [], 'no buffer means no positions');
});

await test('count is clamped to what the buffer can actually supply', () => {
  // 9 floats = 3 points. A count of 100 must not read past the end and
  // produce 97 Cartesian3s full of undefined.
  const out = unpackPositions(XYZ, 100);
  assert.equal(out.length, 3, `expected 3 points from a 9-float buffer, got ${out.length}`);
  for (const p of out) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z),
      'every unpacked point must be finite');
  }
});

/* ── The good path still works ──────────────────────────────────────────── */

console.log('\n-- the valid path is unchanged --');

await test('a well-formed buffer unpacks in order', () => {
  const out = unpackPositions(XYZ, 3);
  assert.equal(out.length, 3);
  assert.deepEqual([out[0].x, out[0].y, out[0].z], [1, 2, 3]);
  assert.deepEqual([out[2].x, out[2].y, out[2].z], [7, 8, 9]);
});

await test('count = 0 is a legitimate empty path, not an error', () => {
  assert.deepEqual(unpackPositions(XYZ, 0), []);
});

/* ── The worker side of the same contract ───────────────────────────────── */

console.log('\n-- propagate.worker.js path() ---');

const WORKER_SRC = read('public/orbit-engine/propagate.worker.js');

await test('every path postMessage ships an xyz alongside count', () => {
  // The give-up branch used to post {type:'path', job, count:0} with no xyz.
  const posts = [...WORKER_SRC.matchAll(/postMessage\(\{\s*type:\s*'path'[^}]*\}/g)]
    .map(m => m[0]);
  assert.ok(posts.length > 0, 'expected path postMessage calls in the worker');
  for (const p of posts) {
    assert.ok(/xyz/.test(p),
      `a 'path' message without xyz unpacks as undefined on the main thread: ${p}`);
  }
});

await test('the orbital period is guarded against a zero/NaN mean motion', () => {
  // `(2*Math.PI)/rec.no` is Infinity when rec.no is 0, which walks NaN into
  // the vertex count and reaches new Array(NaN).
  const m = WORKER_SRC.match(/period\s*=\s*periodMin\s*\|\|[\s\S]{0,400}/);
  assert.ok(m, 'path() must still derive a period from periodMin/rec.no');
  assert.ok(/Number\.isFinite\(period\)|isFinite\(period\)/.test(m[0]),
    'period must be checked for finiteness before it scales the sample dates');
});

/* ── flyToSats must not fly the camera to NaN ───────────────────────────── */

console.log('\n-- flyToSats guards against non-finite positions --');

await test('flyToSats filters non-finite sat positions before building a sphere', () => {
  // A sat whose first propagation has not landed yet still carries a
  // Cartesian3 of NaN. One of those poisons BoundingSphere.fromPoints, and
  // flying to a NaN sphere parks the camera at a NaN height — the globe
  // disappears and every later zoom reports `nan m`, silently.
  const m = ENGINE_SRC.match(/flyToSats\s*\([\s\S]*?\n {4}\}/);
  assert.ok(m, 'flyToSats must exist in sat-engine.js');
  const body = m[0];
  assert.ok(/Number\.isFinite\([^)]*\.x\)/.test(body) && /Number\.isFinite\([^)]*\.y\)/.test(body),
    'flyToSats must reject positions with non-finite components');
  assert.ok(/Number\.isFinite\(\s*sphere\.radius\s*\)/.test(body),
    'flyToSats must reject a sphere whose radius is not finite');
});

/* ── Summary ────────────────────────────────────────────────────────────── */

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
