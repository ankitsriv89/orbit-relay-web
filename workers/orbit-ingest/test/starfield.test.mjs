/**
 * public/orbit-engine/starfield.js — procedural star skyBox maths (plan 34
 * §3.3 C4, spec #20 "HDR stars").
 *
 *     node workers/orbit-ingest/test/starfield.test.mjs
 *
 * The plan asks for a star skyBox "behind the toggle" with no external
 * assets (the §1.3 lesson). Cesium 1.113's Scene would otherwise lazily
 * fetch six Tycho-2 starfield JPEGs from the Cesium CDN on every page's
 * first render; this module generates a deterministic 3D star field on the
 * unit sphere and projects it onto six cube faces, which the engine hands
 * to `Cesium.SkyBox` as PNG data URLs.
 *
 * Same arrangement as eclipse-compute.test.mjs: frontend maths, tested in
 * the ingest suite because the module is pure — no Cesium, no DOM, no
 * satellite.js on this path — so every assertion here is closed-form
 * geometry with known answers.
 *
 * What this catches:
 *
 *   - the PRNG losing determinism (same seed must give the same sky on
 *     every load — a randomly re-rolled sky is untestable and unverifiable
 *     in a sandbox whose canvas renders black);
 *   - a star outside [0.15, 1] brightness (fully invisible stars are wasted
 *     pixels) or a NaN anywhere in the field;
 *   - a face frame that is not right-handed (t1 × t2 ≠ n), which mirrors
 *     stars between faces and breaks cube-corner consistency;
 *   - `faceForDir` picking the wrong face or ties resolving inconsistently,
 *     which double-draws a star on two faces (a false duplicate in the sky);
 *   - a projection escaping the face square (|u|,|v| > 1 on the owning
 *     face), which would clip or tile stars;
 *   - the projection dividing by a zero normal dot (the plane at 90° to the
 *     star) producing NaN;
 *   - starfield.js drifting back to importing Cesium or touching the DOM at
 *     module scope, which would break the Node import this file depends on.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    mulberry32, generateStars, FACE_FRAMES, FACE_KEYS,
    faceForDir, projectToFace, drawSkyFace,
} from '../../../public/orbit-engine/starfield.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS  ' + name); }
  catch (e) { results.push(false); console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); }
}

const approx = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (±${tol})`);

/* ── PRNG determinism ───────────────────────────────────────────────────── */

console.log('\n-- mulberry32 --');

await test('same seed → identical sequence', () => {
  const a = mulberry32(42), b = mulberry32(42);
  for (let i = 0; i < 100; i++) assert.equal(a(), b());
});

await test('different seeds → different sequence', () => {
  const a = mulberry32(1), b = mulberry32(2);
  let differ = 0;
  for (let i = 0; i < 100; i++) if (a() !== b()) differ++;
  assert.ok(differ > 50, `expected largely divergent sequences, ${differ} draws differed`);
});

await test('outputs stay in [0, 1)', () => {
  const rng = mulberry32(7);
  for (let i = 0; i < 1000; i++) {
    const x = rng();
    assert.ok(x >= 0 && x < 1, `draw ${i} = ${x}`);
  }
});

/* ── Star field ─────────────────────────────────────────────────────────── */

console.log('\n-- generateStars --');

await test('same seed → identical sky', () => {
  const a = generateStars(99), b = generateStars(99);
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i].x, b[i].x);
    assert.equal(a[i].y, b[i].y);
    assert.equal(a[i].z, b[i].z);
    assert.equal(a[i].b, b[i].b);
  }
});

await test('directions are unit vectors', () => {
  for (const s of generateStars(5)) {
    const n = Math.hypot(s.x, s.y, s.z);
    approx(n, 1, 1e-12);
  }
});

await test('no NaN in the field', () => {
  for (const s of generateStars(5)) {
    for (const k of ['x', 'y', 'z', 'b']) {
      assert.ok(Number.isFinite(s[k]), `${k} not finite: ${s[k]}`);
    }
  }
});

await test('brightness stays in [0.15, 1]', () => {
  for (const s of generateStars(5)) {
    assert.ok(s.b >= 0.15 && s.b <= 1, `b = ${s.b}`);
  }
});

await test('tints are near-white', () => {
  for (const s of generateStars(5)) {
    const { r, g, b } = s.tint;
    assert.ok(r >= 0.7 && g >= 0.7 && b >= 0.7, `tint ${r},${g},${b}`);
  }
});

/* ── Face frames ────────────────────────────────────────────────────────── */

console.log('\n-- face frames --');

await test('every frame is right-handed (t1 × t2 === n)', () => {
  for (const key of FACE_KEYS) {
    const { n, t1, t2 } = FACE_FRAMES[key];
    const cross = [
      t1[1] * t2[2] - t1[2] * t2[1],
      t1[2] * t2[0] - t1[0] * t2[2],
      t1[0] * t2[1] - t1[1] * t2[0],
    ];
    for (let i = 0; i < 3; i++) approx(cross[i], n[i], 1e-15);
  }
});

await test('frames are orthonormal', () => {
  for (const key of FACE_KEYS) {
    const { n, t1, t2 } = FACE_FRAMES[key];
    for (const a of [n, t1, t2]) {
      approx(Math.hypot(a[0], a[1], a[2]), 1, 1e-15);
    }
    for (const [a, b] of [[n, t1], [n, t2], [t1, t2]]) {
      approx(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], 0, 1e-15);
    }
  }
});

/* ── Projection ─────────────────────────────────────────────────────────── */

console.log('\n-- projection --');

const v = (x, y, z) => ({ x, y, z });

await test('cube corners land on the same (u,v) corner on every face that sees them', () => {
  // The corner (1,1,1)/√3 is owned by +X but is exactly on the +Y and +Z
  // face planes too — a right-handed frame set must hand back (1,1) there.
  const corner = { x: 1, y: 1, z: 1 };
  for (const key of FACE_KEYS) {
    const f = FACE_FRAMES[key];
    const d = f.n[0] * corner.x + f.n[1] * corner.y + f.n[2] * corner.z;
    if (d <= 0) continue;
    const uv = projectToFace(corner, key);
    approx(uv.u, 1, 1e-12);
    approx(uv.v, 1, 1e-12);
  }
});

await test('every star is inside its owning face square', () => {
  for (const s of generateStars(1)) {
    const key = faceForDir(s);
    const uv = projectToFace(s, key);
    assert.ok(uv, 'owning face must see the star (positive normal dot)');
    assert.ok(Math.abs(uv.u) <= 1 + 1e-12 && Math.abs(uv.v) <= 1 + 1e-12,
              `${key}: u=${uv.u} v=${uv.v} for ${s.x},${s.y},${s.z}`);
  }
});

await test('interior stars are owned by exactly one face', () => {
  // The dominant |dot| is strictly largest for interior stars, so the other
  // five faces must reject them — |u| or |v| > 1 (never a double-draw).
  let checked = 0;
  for (const s of generateStars(1)) {
    if (faceForDir(s) !== 'positiveX') continue;   // any face is the same test
    const maxD = Math.max(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z));
    if (maxD === Math.abs(s.x) && (Math.abs(s.y) === maxD || Math.abs(s.z) === maxD)) continue;
    for (const key of FACE_KEYS) {
      if (key === 'positiveX') continue;
      const uv = projectToFace(s, key);
      if (!uv) continue;
      assert.ok(Math.abs(uv.u) > 1 || Math.abs(uv.v) > 1,
                `${key}: off-face star read on-face (u=${uv.u}, v=${uv.v})`);
    }
    checked++;
  }
  assert.ok(checked > 50, 'fixture must exercise a decent share of the field');
});

await test('boundary directions read the same edge coordinate on both neighbours', () => {
  // A direction on the +X/+Y edge (x = y > 0) projects to u=1 on +X and
  // v=1 on +Y — the two faces agree on where the star sits, in
  // direction space, so the seam has no gap or overlap in the star field.
  const edge = { x: 1, y: 1, z: 0.25 };
  const ux = projectToFace(edge, 'positiveX');
  const vy = projectToFace(edge, 'positiveY');
  approx(ux.u, 1, 1e-12);
  approx(vy.v, 1, 1e-12);
  approx(ux.v, vy.u, 1e-12);   // z/x on +X equals z/y on +Y at x = y
});

await test('the back half of the cube projects to null', () => {
  assert.equal(projectToFace(v(0, 0, 1), 'negativeZ'), null);
  assert.equal(projectToFace(v(1, 0, 0), 'negativeX'), null);
});

await test('a direction perpendicular to the face normal never divides by zero', () => {
  // dot(n, d) == 0 exactly: the projection must reject, not divide by zero.
  assert.equal(projectToFace(v(0, 1, 0), 'positiveX'), null);
});

/* ── Coverage ───────────────────────────────────────────────────────────── */

await test('600 stars cover all six faces', () => {
  const seen = new Set();
  for (const s of generateStars(1, 600)) seen.add(faceForDir(s));
  assert.deepEqual([...seen].sort(), [...FACE_KEYS].sort());
});

/* ── Drawing ────────────────────────────────────────────────────────────── */

console.log('\n-- drawSkyFace --');

/** A stub 2D context so the draw path can be exercised in Node — the DOM
 *  canvas is a thin wrapper around exactly these calls, so a pure crash
 *  (like passing a face frame where a face KEY belongs) is caught here
 *  instead of at page boot. */
function stubCtx() {
    const calls = [];
    return {
        calls,
        clearRect: (...a) => calls.push(['clear', ...a]),
        createRadialGradient: () => ({ addColorStop: () => {} }),
        fillRect: (...a) => calls.push(['rect', ...a]),
        beginPath: () => calls.push(['begin']),
        arc: (...a) => calls.push(['arc', ...a]),
        fill: () => calls.push(['fill']),
        fillStyle: null,
    };
}

await test('drawSkyFace renders all six faces without throwing, against a stub context', () => {
  const stars = generateStars(1, 120);
  for (const key of FACE_KEYS) {
    const ctx = stubCtx();
    drawSkyFace(ctx, 64, stars, key);
    const kinds = ctx.calls.map(c => c[0]);
    assert.ok(kinds.includes('clear'), `${key}: must clear the face first`);
    assert.ok(kinds.includes('arc'), `${key}: must draw star cores`);
    assert.ok(kinds.every(k => ['clear', 'rect', 'begin', 'arc', 'fill'].includes(k)),
              `${key}: unexpected ctx call ${kinds}`);
  }
});

await test('drawSkyFace on the negative faces draws too (not just +X)', () => {
  const stars = generateStars(1, 300);
  const counts = {};
  for (const key of FACE_KEYS) {
    const ctx = stubCtx();
    drawSkyFace(ctx, 64, stars, key);
    counts[key] = ctx.calls.filter(c => c[0] === 'arc').length;
  }
  for (const key of FACE_KEYS) {
    assert.ok(counts[key] > 0, `${key}: no star cores drawn (${counts[key]})`);
  }
});

/* ── Apparent star size (resolution independence) ───────────────────────── */

/* A skyBox face spans a 90° FOV, so it is magnified onto the screen by
 * roughly `screenHeight / (faceSize * tan(fov/2) / tan(45°))`. At the old
 * fixed 512px face that is ~3.0x at 900p and ~4.9x at 1440p, which turned a
 * 2.7px star core into an 8-13px blob and the 22x22 glow rect into a visible
 * 67-107px SQUARE — the "stars look big / background looks different on this
 * machine" report. Two invariants keep that from coming back:
 *
 *   1. Radii are expressed in *face* pixels but must scale WITH faceSize, so
 *      a bigger texture means sharper stars, not bigger ones.
 *   2. The default face is large enough that magnification at 1440p is ~1x.
 */

console.log('\n-- apparent star size --');

/** Largest `arc` radius drawn, in units of face-width (resolution-independent). */
function maxCoreFraction(size) {
    const stars = generateStars(20260806, 600);
    let max = 0;
    for (const key of FACE_KEYS) {
        const ctx = stubCtx();
        drawSkyFace(ctx, size, stars, key);
        for (const c of ctx.calls) {
            if (c[0] === 'arc') max = Math.max(max, c[3]);
        }
    }
    return max / size;
}

await test('star core size scales with face size (resolution-independent)', () => {
  // The same star must occupy the same FRACTION of the face at any texture
  // size. If radii are hardcoded in pixels, doubling size halves the fraction
  // and the star renders at a different apparent size per machine.
  const at512 = maxCoreFraction(512);
  const at2048 = maxCoreFraction(2048);
  assert.ok(Math.abs(at512 - at2048) / at512 < 0.02,
    `core radius must be a fixed fraction of the face, got ${at512.toFixed(6)} at 512 ` +
    `vs ${at2048.toFixed(6)} at 2048 (${(at2048 / at512).toFixed(3)}x) — radii are ` +
    `hardcoded in face pixels, so apparent star size depends on texture size`);
});

await test('glow rect scales with face size too', () => {
  const stars = generateStars(20260806, 600);
  const maxRect = (size) => {
    let max = 0;
    for (const key of FACE_KEYS) {
      const ctx = stubCtx();
      drawSkyFace(ctx, size, stars, key);
      for (const c of ctx.calls) if (c[0] === 'rect') max = Math.max(max, c[3]);
    }
    return max / size;
  };
  const a = maxRect(512), b = maxRect(2048);
  assert.ok(a > 0 && Math.abs(a - b) / a < 0.02,
    `glow rect must be a fixed fraction of the face, got ${a.toFixed(6)} vs ${b.toFixed(6)}`);
});

await test('a star renders as a point, not a disc, at 900p and 1440p', () => {
  // The actual complaint: stars looked like big blurry blobs. Consistency
  // across texture sizes (above) is necessary but not sufficient — the sizes
  // also have to be SMALL. Convert the largest drawn core into screen pixels
  // through the real magnification and hold it to roughly a point source.
  const src = read('public/orbit-engine/starfield.js');
  const size = Number((src.match(/size\s*=\s*(\d+)/) || [])[1]);
  assert.ok(size, 'expected a default face size');
  const faceFrac = maxCoreFraction(size);          // radius / face width
  for (const screenH of [900, 1440]) {
    // Face spans 90°, Cesium's default vertical FOV is 60°.
    const facePxAcrossFov = size * (Math.tan(Math.PI / 6) / Math.tan(Math.PI / 4));
    const screenPx = faceFrac * size * (screenH / facePxAcrossFov);
    assert.ok(screenPx <= 2.5,
      `brightest star core renders ~${screenPx.toFixed(2)}px at ${screenH}p — ` +
      `a star is a point source; anything past ~2.5px reads as a blurry disc`);
    assert.ok(screenPx > 0.2,
      `brightest star core renders ~${screenPx.toFixed(2)}px at ${screenH}p — ` +
      `too small to be visible at all`);
  }
});

await test('the glow rect fully covers the glow gradient (no clipped square)', () => {
  // The visible square edges came from a fillRect narrower than the radial
  // gradient it was meant to contain.
  const src = read('public/orbit-engine/starfield.js');
  const base = Number((src.match(/GLOW_BASE\s*=\s*([\d.]+)/) || [])[1]);
  const gain = Number((src.match(/GLOW_GAIN\s*=\s*([\d.]+)/) || [])[1]);
  const half = Number((src.match(/GLOW_HALF\s*=\s*([\d.]+)/) || [])[1]);
  assert.ok(Number.isFinite(base) && Number.isFinite(gain) && Number.isFinite(half),
    'glow constants must stay declared as named values');
  assert.ok(half >= base + gain,
    `glow half-width ${half} must cover the max glow radius ${base + gain}, ` +
    `or the gradient is cut off and the star shows square edges`);
});

await test('default face size keeps 1440p magnification near 1x', () => {
  const src = read('public/orbit-engine/starfield.js');
  const m = src.match(/size\s*=\s*(\d+)/);
  assert.ok(m, 'buildSkyFaceSources must declare a default face size');
  const size = Number(m[1]);
  // Face spans 90deg; Cesium's default vertical FOV is 60deg.
  const facePxAcrossFov = size * (Math.tan(Math.PI / 6) / Math.tan(Math.PI / 4));
  const magnification = 1440 / facePxAcrossFov;
  assert.ok(magnification <= 1.35,
    `face size ${size} gives ${magnification.toFixed(2)}x magnification at 1440p — ` +
    `stars will render as blurry blobs on a high-resolution display`);
});

/* ── Purity ─────────────────────────────────────────────────────────────── */

console.log('\n-- purity --');

await test('starfield.js stays free of Cesium and DOM outside the canvas sink', () => {
  const src = read('public/orbit-engine/starfield.js');
  assert.ok(!/\bCesium\./.test(src), 'starfield.js must not reference Cesium');
  // All DOM work happens in exactly one function (buildSkyFaceSources); the
  // rest of the module — everything the Node tests import — must be pure.
  const sink = src.indexOf('export function buildSkyFaceSources');
  assert.ok(sink > 0, 'buildSkyFaceSources must exist');
  const head = src.slice(0, sink);
  assert.ok(!/\bdocument\.|\bwindow\./.test(head),
            'no DOM reference may appear outside buildSkyFaceSources');
});

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
