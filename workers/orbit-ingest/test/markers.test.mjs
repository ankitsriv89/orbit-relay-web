/**
 * public/orbit-engine/markers.js — per-type marker shapes, and the star/sat
 * contrast rules that motivated them.
 *
 *     node workers/orbit-ingest/test/markers.test.mjs
 *
 * The bug this guards: at the shipped sizes a satellite dot and a background
 * star core were both small round bright marks (~3 screen px vs ~1.5), and
 * users could not tell them apart. Three things fix it — dimmer stars, bigger
 * dots, and an outline on every dot — plus shape encoding OBJECT_TYPE.
 *
 * Same arrangement as starfield.test.mjs: the shape table and type mapping are
 * pure, so they are tested directly; the canvas-drawing half is asserted by
 * source inspection because there is no DOM here.
 *
 * What this catches:
 *
 *   - a star core growing back into satellite-dot territory (the original
 *     confusion), asserted as a RATIO against the smallest dot the product
 *     ships, not as a magic number;
 *   - the small-dot outline regressing to `pointSize > 7 ? 1.5 : 0`, which is
 *     what left 3-4px dots looking like light sources;
 *   - an OBJECT_TYPE silently falling through to a shape that claims a
 *     meaning it does not have;
 *   - the marker texture cache keying wrongly, which would generate a texture
 *     per object and destroy the batching that makes billboards affordable;
 *   - a billboard's base colour not being white, which would square the tint
 *     through the far-side fade and render markers near-black.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SHAPES, TYPE_SHAPE, shapeForType, SHELL_SHAPE, shapeForShell,
} from '../../../public/orbit-engine/markers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS  ' + name); }
  catch (e) { results.push(false); console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); }
}

/* ── OBJECT_TYPE -> shape ───────────────────────────────────────────────── */

console.log('\n-- type to shape mapping --');

await test('the three real Space-Track OBJECT_TYPEs each get a distinct shape', () => {
  const got = ['PAYLOAD', 'ROCKET BODY', 'DEBRIS'].map(shapeForType);
  assert.deepEqual(got, ['square', 'triangle', 'diamond']);
  assert.equal(new Set(got).size, 3, 'the three types must not share a shape');
});

await test('OBJECT_TYPE matching is case-insensitive', () => {
  // Space-Track stores uppercase, but rows reach here from several paths.
  assert.equal(shapeForType('payload'), 'square');
  assert.equal(shapeForType('Rocket Body'), 'triangle');
});

await test('unknown and missing types stay round rather than claiming a meaning', () => {
  for (const v of [null, undefined, '', 'UNKNOWN', 'TBA', 'something new']) {
    assert.equal(shapeForType(v), 'circle', JSON.stringify(v) + ' must be circle');
  }
});

await test('every mapped shape is a real shape markerCanvas can draw', () => {
  for (const [type, shape] of Object.entries(TYPE_SHAPE)) {
    assert.ok(SHAPES.includes(shape), type + ' -> ' + shape + ' is not in SHAPES');
  }
});

/* ── Orbit shell -> shape (/constellations/) ────────────────────────────── */

console.log('\n-- shell to shape mapping --');

await test('the four orbit regimes each get a distinct, non-round shape', () => {
  const got = ['LEO', 'MEO', 'GEO', 'HEO'].map(shapeForShell);
  assert.equal(new Set(got).size, 4, 'the four shells must not share a shape');
  assert.ok(!got.includes('circle'),
            'no shell may be round — round is what stars look like, which is the bug');
});

await test('shell matching is case-insensitive and unknown stays round', () => {
  assert.equal(shapeForShell('leo'), 'square');
  for (const v of [null, undefined, '', 'XYZ']) assert.equal(shapeForShell(v), 'circle');
});

await test('every shell shape is one markerCanvas can draw', () => {
  for (const [shell, shape] of Object.entries(SHELL_SHAPE)) {
    assert.ok(SHAPES.includes(shape), shell + ' -> ' + shape + ' is not in SHAPES');
  }
});

await test('the shells astro.js can return are exactly the shells we map', () => {
  // A regime with no shape entry silently falls back to circle — the bug.
  const astro = read('public/orbit-engine/astro.js');
  const returned = new Set(
    [...astro.matchAll(/return '(LEO|MEO|GEO|HEO)'/g)].map(m => m[1]));
  assert.ok(returned.size >= 4, 'expected all four regimes in astro.js');
  for (const r of returned) {
    assert.ok(SHELL_SHAPE[r], 'astro.js can return ' + r + ' but SHELL_SHAPE has no entry');
  }
});

await test('/constellations/ actually passes a shape to addSatellite', () => {
  const src = read('public/constellations/constellations.js');
  assert.ok(/shape:\s*shapeForShell\(plane\.shell\)/.test(src),
            'constellations must shape its dots — round dots were the reported confusion');
});

/* ── The contrast rules ─────────────────────────────────────────────────── */

console.log('\n-- star vs satellite contrast --');

/* Reproduces starfield.js's core-radius maths and the texture->screen
 * magnification, so a change to either constant is caught here rather than by
 * eye on a globe page. */
function brightestStarScreenPx(src, screenH = 900) {
  const num = (re) => Number((src.match(re) || [])[1]);
  const CORE_BASE = num(/CORE_BASE\s*=\s*([\d.]+)/);
  const CORE_GAIN = num(/CORE_GAIN\s*=\s*([\d.]+)/);
  assert.ok(Number.isFinite(CORE_BASE) && Number.isFinite(CORE_GAIN),
            'CORE_BASE/CORE_GAIN must be readable from starfield.js');
  const r = Math.max(0.35, CORE_BASE + 1 * 1 * CORE_GAIN);   // b = 1, k = 1 at size 2048
  const mag = screenH / (2048 * Math.tan(Math.PI / 6) / Math.tan(Math.PI / 4));
  return 2 * r * mag;
}

await test('the brightest star stays under 1 screen px', () => {
  const px = brightestStarScreenPx(read('public/orbit-engine/starfield.js'));
  assert.ok(px < 1.0, 'brightest star core is ' + px.toFixed(2) + 'px, must be < 1.0');
});

await test('the smallest satellite dot is at least 3x the brightest star', () => {
  const star = brightestStarScreenPx(read('public/orbit-engine/starfield.js'));
  // The smallest pointSize the product ships, at its most-shrunk distance.
  const src = read('public/constellations/constellations.js');
  const size = Number((src.match(/shellColor\(plane\.shell\),\s*(\d+)/) || [])[1]);
  assert.ok(Number.isFinite(size), 'constellations dot size must be readable');
  const dot = size * 0.85;                     // scaleByDistance far end
  assert.ok(dot / star >= 3, 'dot ' + dot + 'px vs star ' + star.toFixed(2) + 'px = '
            + (dot / star).toFixed(1) + 'x, must be >= 3x');
});

await test('small dots are outlined — the rule is not "> 7 ? 1.5 : 0"', () => {
  const src = read('public/orbit-engine/sat-engine.js');
  assert.ok(!/outlineWidth:\s*pointSize > 7 \? 1\.5 : 0\b/.test(src),
            'small dots must not have zero outline width');
  assert.ok(/outlineWidth:\s*pointSize > 7 \? 1\.5 : 1\b/.test(src),
            'every point needs a non-zero outline');
});

/* ── Billboard integration invariants ───────────────────────────────────── */

console.log('\n-- billboard wiring --');

await test('a billboard base colour is white so the fade cannot square the tint', () => {
  const src = read('public/orbit-engine/sat-engine.js');
  assert.ok(/_isBillboard[\s\S]{0,200}\{ r: 1, g: 1, b: 1, a: color\.alpha \}/.test(src),
            'billboard baseColor must be white-with-alpha');
});

await test('removeSat returns a marker to the collection it came from', () => {
  const src = read('public/orbit-engine/sat-engine.js');
  assert.ok(/_isBillboard\)\s*this\.markerCollection\.remove/.test(src),
            'billboards must be removed from markerCollection, not satCollection');
});

await test('destroy() tears down the marker collection too', () => {
  const src = read('public/orbit-engine/sat-engine.js');
  const d = src.slice(src.indexOf('    destroy() {'));
  assert.ok(/markerCollection[\s\S]{0,160}primitives\.remove/.test(d),
            'destroy() must remove the billboard collection (it escapes cleanup otherwise)');
});

await test('the pulse loop does not write pixelSize to a billboard', () => {
  const src = read('public/orbit-engine/sat-engine.js');
  assert.ok(/_isBillboard\)\s*\{[\s\S]{0,240}\.width\s*=/.test(src),
            'billboards must be pulsed via width/height, not pixelSize');
});

await test('satPointCount counts both collections', () => {
  const src = read('public/orbit-engine/sat-engine.js');
  const g = src.slice(src.indexOf('get satPointCount'));
  assert.ok(/markerCollection/.test(g.slice(0, 200)),
            'satPointCount must include shaped markers or the count under-reports');
});

/* ── Texture batching ───────────────────────────────────────────────────── */

console.log('\n-- texture cache --');

await test('the cache key covers shape, colour AND size', () => {
  const src = read('public/orbit-engine/markers.js');
  assert.ok(/const key = `\$\{shape\}\|\$\{css\}\|\$\{size\}`/.test(src),
            'a key missing any of the three would return a wrong-looking marker');
});

await test('markers.js stays free of Cesium, and DOM-free above the draw sink', () => {
  const src = read('public/orbit-engine/markers.js');
  assert.ok(!/\bCesium\./.test(src), 'markers.js must not reference Cesium');
  const sink = src.indexOf('export function markerCanvas');
  assert.ok(sink > 0, 'markerCanvas must exist');
  assert.ok(!/\bdocument\.|\bwindow\./.test(src.slice(0, sink)),
            'no DOM reference above markerCanvas — Node imports this module');
});

const passed = results.filter(Boolean).length;
console.log('\n' + passed + '/' + results.length + ' passed');
process.exit(passed === results.length ? 0 : 1);
