/**
 * public/orbit-engine/astro.js — far-side occlusion maths.
 *
 *     node workers/orbit-ingest/test/occlusion.test.mjs
 *
 * Satellite points are drawn with `disableDepthTestDistance: Infinity` so they
 * never z-fight the globe or vanish into terrain up close. The cost is total:
 * a satellite on the FAR side of the Earth draws straight through the planet,
 * over whatever continent faces the camera. Rotating the globe then looks like
 * the dots stayed put while the map slid beneath them — the positions are
 * right, but with no depth cue the eye puts a far-side satellite on near-side
 * ground. `farSideFade()` restores the cue by fading points by how deeply they
 * sit behind the horizon.
 *
 * Same arrangement as catalog-compute.test.mjs: frontend maths, tested in the
 * ingest suite because the module is pure — no Cesium, no DOM, no satellite.js
 * on this path — so every assertion here is closed-form geometry at pinned
 * positions.
 *
 * What this catches:
 *
 *   - the horizon plane placed at the sphere's centre (`p·c < 0`) instead of at
 *     `R²`, which leaves a whole visor of genuinely-hidden satellites at full
 *     brightness — the exact bug this file was written to prove;
 *   - a fade that snaps between two values instead of grading with depth, which
 *     makes a ring of dots pop at the limb during a drag;
 *   - near-side points picking up any fade at all;
 *   - the fade leaving the [minAlpha, 1] range, which would either blank a
 *     near-side sat or push colour components out of range;
 *   - astro.js drifting back to importing Cesium/DOM, which would break the
 *     Node import this file depends on.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isBehindEarth, farSideFade, EARTH_R_KM } from '../../../public/orbit-engine/astro.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS  ' + name); }
  catch (e) { results.push(false); console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); }
}

const R = EARTH_R_KM * 1000;          // mean Earth radius, metres
const v = (x, y, z) => ({ x, y, z });

// Camera parked over the +X equator at ~50,000 km — the altitude in the frames
// that opened this bug (the /spacetrack/ HUD read 50,583 KM).
const CAM = v(R + 50e6, 0, 0);

/* ── isBehindEarth: the horizon plane ───────────────────────────────────── */

console.log('\n-- isBehindEarth --');

await test('a point between camera and Earth is visible', () => {
  assert.equal(isBehindEarth(v(R + 500e3, 0, 0), CAM), false);
});

await test('the antipode is hidden', () => {
  assert.equal(isBehindEarth(v(-(R + 500e3), 0, 0), CAM), true);
});

await test('a point on the far side but off-axis is still hidden', () => {
  // 400 km up, 30° past the anti-camera point.
  const r = R + 400e3, a = Math.PI - Math.PI / 6;
  assert.equal(isBehindEarth(v(r * Math.cos(a), r * Math.sin(a), 0), CAM), true);
});

await test('the horizon plane sits at R², not at the centre', () => {
  // THE REGRESSION GUARD. A point at 88° from the camera axis is past the
  // horizon for this camera but still in the near HEMISPHERE (p·c > 0), so the
  // naive `p·c < 0` half-space test calls it visible when it is not.
  const r = R + 400e3, a = (88 * Math.PI) / 180;
  const p = v(r * Math.cos(a), r * Math.sin(a), 0);
  assert.ok(p.x * CAM.x + p.y * CAM.y + p.z * CAM.z > 0,
            'fixture must sit in the near hemisphere for this test to bite');
  assert.equal(isBehindEarth(p, CAM), true,
               'a near-hemisphere point past the horizon must read as hidden');
});

await test('a point exactly on the horizon plane is not hidden', () => {
  // p·c == R² exactly: grazing, and the test is strict `<`.
  const p = v((R * R) / CAM.x, 0, 0);
  assert.equal(isBehindEarth(p, CAM), false);
});

await test('raising the camera enlarges the visible cap', () => {
  // A point 80° off-axis at 400 km: hidden from low orbit, visible from far
  // away, because the horizon circle opens toward a great circle as c → ∞.
  const r = R + 400e3, a = (80 * Math.PI) / 180;
  const p = v(r * Math.cos(a), r * Math.sin(a), 0);
  assert.equal(isBehindEarth(p, v(R + 400e3, 0, 0)), true,  'hidden from a close camera');
  assert.equal(isBehindEarth(p, v(R + 5000e6, 0, 0)), false, 'visible from very far away');
});

await test('geostationary belt: the hidden arc matches the closed-form limb', () => {
  // At GEO the ring radius (42,164 km) is comparable to the camera distance,
  // so the horizon sits at acos(R²/(geo·|c|)) ≈ 89.02° and the hidden arc is
  // ~182° — a shade MORE than half the belt. (The near arc is only the larger
  // one for satellites hugging the surface; do not assume it in general.)
  const geo = R + 35786e3;
  const limb = Math.acos(Math.max(-1, Math.min(1, (R * R) / (geo * CAM.x))));
  let hidden = 0, shown = 0;
  for (let deg = 0; deg < 360; deg += 5) {
    const a = (deg * Math.PI) / 180;
    const beyond = Math.abs(((deg + 180) % 360) - 180) * (Math.PI / 180) > limb;
    const got = isBehindEarth(v(geo * Math.cos(a), geo * Math.sin(a), 0), CAM);
    assert.equal(got, beyond, `deg=${deg}: limb=${(limb * 180 / Math.PI).toFixed(2)}°`);
    got ? hidden++ : shown++;
  }
  assert.equal(hidden + shown, 72);
  assert.ok(hidden > shown, 'from just outside GEO a little over half the belt is occluded');
});

/* ── farSideFade: graded, not binary ────────────────────────────────────── */

console.log('\n-- farSideFade --');

await test('near-side points are fully opaque', () => {
  assert.equal(farSideFade(v(R + 500e3, 0, 0), CAM), 1);
});

await test('a hidden point is faded', () => {
  assert.ok(farSideFade(v(-(R + 500e3), 0, 0), CAM) < 1);
});

await test('the fade never leaves [minAlpha, 1]', () => {
  const minAlpha = 0.18;
  for (let deg = 0; deg < 360; deg += 3) {
    const a = (deg * Math.PI) / 180, r = R + 800e3;
    const f = farSideFade(v(r * Math.cos(a), r * Math.sin(a), 0), CAM, { minAlpha });
    assert.ok(f >= minAlpha && f <= 1, `deg=${deg} fade=${f}`);
  }
});

await test('the fade grades with depth behind the limb, it does not snap', () => {
  // THE REGRESSION GUARD for a two-state fade. Walking from the limb to the
  // antipode must produce strictly decreasing alpha, not one step.
  const r = R + 400e3;
  const samples = [];
  for (let deg = 95; deg <= 180; deg += 5) {
    const a = (deg * Math.PI) / 180;
    samples.push(farSideFade(v(r * Math.cos(a), r * Math.sin(a), 0), CAM));
  }
  const distinct = new Set(samples.map((s) => s.toFixed(4)));
  assert.ok(distinct.size > 4,
            `expected a graded ramp, got ${distinct.size} distinct value(s): ${[...distinct].join(',')}`);
  for (let i = 1; i < samples.length; i++) {
    assert.ok(samples[i] <= samples[i - 1] + 1e-9,
              `alpha must not rise with depth: ${samples[i - 1]} -> ${samples[i]} at step ${i}`);
  }
});

await test('the deepest point is at or near the floor', () => {
  const minAlpha = 0.18;
  const f = farSideFade(v(-(R + 400e3), 0, 0), CAM, { minAlpha });
  assert.ok(f < minAlpha + 0.12, `antipode should be near the floor, got ${f}`);
});

await test('the fade is continuous across the limb', () => {
  // No visible pop: alpha just inside and just outside the horizon must be close.
  const r = R + 400e3;
  const limb = Math.acos(Math.min(1, (R * R) / (r * CAM.x)));   // p·c = R² angle
  const eps = 1e-4;
  const at = (a) => farSideFade(v(r * Math.cos(a), r * Math.sin(a), 0), CAM);
  assert.ok(Math.abs(at(limb - eps) - at(limb + eps)) < 0.02,
            'alpha must not jump at the horizon boundary');
});

await test('a custom minAlpha is honoured', () => {
  const p = v(-(R + 400e3), 0, 0);
  assert.ok(farSideFade(p, CAM, { minAlpha: 0.05 }) < farSideFade(p, CAM, { minAlpha: 0.5 }));
});

/* ── Purity ─────────────────────────────────────────────────────────────── */

console.log('\n-- purity --');

await test('astro.js stays free of Cesium and the DOM', () => {
  const src = read('public/orbit-engine/astro.js');
  assert.ok(!/\bCesium\./.test(src), 'astro.js must not reference Cesium');
  assert.ok(!/\bdocument\.|\bwindow\./.test(src), 'astro.js must not touch the DOM');
});

await test('the fade rebuilds from a base snapshot, never from the live primitive', () => {
  // THE REGRESSION GUARD for the /starlink/ bug. starlink.js passes ONE shared
  // Cesium.Color instance for all 40 sats; reading hue back off `prim.color`
  // can hand out a reference into the collection, so writing through it smears
  // one point's fade across every point sharing that instance — on /starlink/
  // that meant no dot faded at all.
  const src = read('public/orbit-engine/sat-engine.js');
  const pass = src.slice(src.indexOf('_refreshOcclusion()'), src.indexOf('setSatColor('));
  assert.ok(/baseColor/.test(pass), '_refreshOcclusion must rebuild from baseColor');
  assert.ok(!/=\s*prim\.color\b/.test(pass),
            '_refreshOcclusion must not read hue back off the live primitive');
  assert.ok(/setSatColor/.test(src),
            'the engine must expose setSatColor so recolours keep the snapshot in sync');
});

await test('pages recolour through setSatColor, not the primitive', () => {
  // A direct `primitive.color =` write to a faded point is reverted on the next
  // drawn frame, because the pass rebuilds it from the stale snapshot.
  for (const f of ['public/spacetrack/catalog.js', 'public/spacetrack/overlays/age.js']) {
    assert.ok(!/\.primitive\.color\s*=/.test(read(f)),
              `${f}: recolour via engine.setSatColor(), not primitive.color =`);
  }
});

await test('the engine drives occlusion from the frame, not the propagation tick', () => {
  // Occlusion depends on the CAMERA, which moves continuously during a drag,
  // while propagate() runs on a 280 ms interval. Computing the fade in the tick
  // leaves ~56 of every 60 dragged frames carrying a stale camera, so the dots
  // pop a quarter-second behind the hand. preRender fires per drawn frame.
  const src = read('public/orbit-engine/sat-engine.js');
  assert.ok(/preRender/.test(src),
            'sat-engine.js must hook scene.preRender to refresh occlusion per frame');
  const tick = src.slice(src.indexOf('propagate('), src.indexOf('_pulse('));
  assert.ok(!/farSideFade/.test(tick),
            'the fade must not be computed inside the propagation tick');
});

await test('bloom never sets glowOnly, which would discard the whole scene', () => {
  // Cesium's bloom `glowOnly` uniform is a BOOLEAN: any truthy value makes the
  // stage output the glow alone and throw the rendered scene away. Plan 39 set
  // it to 0.8 (truthy) as a guessed "tuning" value and every globe page —
  // /orbit/, /spacetrack/, /starlink/, /constellations/ — went blank white with
  // no console error, because the globe still renders and is then discarded.
  // A numeric assignment here is always the bug, never a tuning knob.
  const src = read('public/orbit-engine/sat-engine.js');
  const m = src.match(/glowOnly\s*=\s*([^;\n]+)/);
  assert.ok(!m || /^(false|0)\s*$/.test(m[1]),
            `glowOnly must stay falsy (found "${m && m[1].trim()}") — a truthy value blanks every globe page`);
});

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
