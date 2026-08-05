/**
 * public/orbit-engine/astro.js — eclipse/umbra shadow maths (plan 34 §3.3,
 * spec #20 "eclipse shadows").
 *
 *     node workers/orbit-ingest/test/eclipse-compute.test.mjs
 *
 * Satellites are PointPrimitives in one collection; Cesium's globe lighting
 * shades the surface but nothing shades the points, so a satellite crossing
 * Earth's shadow reads at full brightness against the dark night side.
 * `eclipseShadowFactor()` closes that gap with the shadow-cylinder model:
 * lit on the day side, fully eclipsed inside the umbra, graded across the
 * penumbra (whose width grows with the distance behind the terminator plane,
 * from the sun's finite angular radius).
 *
 * Same arrangement as occlusion.test.mjs: frontend maths, tested in the
 * ingest suite because the module is pure — no Cesium, no DOM, no satellite.js
 * on this path — so every assertion here is closed-form geometry at pinned
 * positions.
 *
 * What this catches:
 *
 *   - a day-side satellite picking up any darkening (the `p·ŝ ≥ 0` plane
 *     placed wrong, e.g. strictly `>` so the terminator pops);
 *   - the shadow cylinder centred on the Earth instead of on the sun axis
 *     (`perp` measured against the wrong line), which darkens a band of
 *     near-side satellites that are fully sunlit;
 *   - a binary umbra with no penumbra, which pops every satellite crossing
 *     the shadow edge — the exact distraction `farSideFade`'s grading exists
 *     to avoid;
 *   - the penumbra band at a fixed width instead of growing with depth, or
 *     with the umbra radius on the wrong side of `earthR` (so the cylinder
 *     shrinks to nothing, or the "umbra" is *wider* than the Earth);
 *   - NaN from the degenerate cases (sun at the origin, satellite at the
 *     origin) taking down the per-frame occlusion pass;
 *   - a unit-system mismatch silently changing the answer (metres vs km);
 *   - astro.js drifting back to importing Cesium/DOM, which would break the
 *     Node import this file depends on.
 */
import assert from 'node:assert/strict';

import { eclipseShadowFactor, sunDirectionEcef, SUN_ANGULAR_RADIUS_RAD, EARTH_R_KM } from '../../../public/orbit-engine/astro.js';

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS  ' + name); }
  catch (e) { results.push(false); console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); }
}

const R = EARTH_R_KM * 1000;          // mean Earth radius, metres
const v = (x, y, z) => ({ x, y, z });
const approx = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (±${tol})`);

// Sun parked one AU along +X (one direction is as good as any; the model is
// scale- and rotation-invariant, tested below).
const SUN = v(1.496e11, 0, 0);
// Penumbra half-width at L km behind the terminator plane, in metres —
// re-derived here from the exported constant so the tests never recompute
// the implementation's own formula verbatim.
const bandAt = (Lkm) => Lkm * 1000 * Math.tan(SUN_ANGULAR_RADIUS_RAD);

/* ── eclipseShadowFactor: the cylinder ─────────────────────────────────── */

console.log('\n-- eclipseShadowFactor --');

await test('a day-side satellite is always fully lit', () => {
  assert.equal(eclipseShadowFactor(v(3000e3, 5000e3, 0), SUN), 1);
});

await test('the terminator plane counts as lit (no pop at p·ŝ = 0)', () => {
  assert.equal(eclipseShadowFactor(v(0, 7000e3, 0), SUN), 1);
});

await test('a satellite directly behind the Earth is fully eclipsed', () => {
  assert.equal(eclipseShadowFactor(v(-1000e3, 0, 0), SUN), 0);
});

await test('a night-side satellite outside the shadow cylinder stays lit', () => {
  // 9,000 km off the axis: beyond the cylinder wall no matter the penumbra.
  assert.equal(eclipseShadowFactor(v(-1000e3, 9000e3, 0), SUN), 1);
});

await test('the cylinder uses the Earth radius, not the centre line', () => {
  // 3,000 km off the axis on the night side: well inside the cylinder, and the
  // naive "any night-side point is dark" model would also flag the 9,000 km
  // case above — the pair pins the radius where the boundary actually sits.
  assert.equal(eclipseShadowFactor(v(-1000e3, 3000e3, 0), SUN), 0);
});

/* ── penumbra: graded, and it widens with depth ─────────────────────────── */

await test('a point at exactly one Earth radius off the axis sits mid-penumbra', () => {
  // band at L = 1,000 km ≈ 4.64 km; perp = R is exactly halfway across it, and
  // smoothstep(0.5) = 0.5 by construction — a closed form, not a pin.
  const f = eclipseShadowFactor(v(-1000e3, R, 0), SUN);
  approx(f, 0.5, 1e-6);
});

await test('the umbra and penumbra boundaries are exact', () => {
  const band = bandAt(1000);
  approx(eclipseShadowFactor(v(-1000e3, R - band, 0), SUN), 0, 1e-12);
  approx(eclipseShadowFactor(v(-1000e3, R + band, 0), SUN), 1, 1e-12);
});

await test('the penumbra widens with distance behind the terminator plane', () => {
  // At GEO depth the band is ~195 km: a point 100 km off the cylinder wall is
  // in the penumbra there (graded) but deep inside the umbra at 1,000 km depth
  // (band ~4.6 km) — the same perpendicular offset, two answers.
  const fGeo = eclipseShadowFactor(v(-42000e3, R - 100e3, 0), SUN);
  const fLeo = eclipseShadowFactor(v(-1000e3,  R - 100e3, 0), SUN);
  assert.ok(fGeo > 0 && fGeo < 1, `GEO-depth penumbra should be graded, got ${fGeo}`);
  assert.equal(fLeo, 0, 'shallow-depth point 100 km inside the wall is in full umbra');
  // And the GEO-depth band itself is the closed form L·tan(θ_sun) ≈ 195 km.
  approx(bandAt(42000), 195e3, 2e3);
});

await test('a GEO satellite in the anti-sun direction is fully eclipsed', () => {
  // The real equinox-eclipse geometry: a GEO sat directly behind the Earth.
  assert.equal(eclipseShadowFactor(v(-42000e3, 0, 0), SUN), 0);
});

await test('grading across the penumbra is monotone and continuous', () => {
  const band = bandAt(1000);
  const lo = R - band, hi = R + band;
  let prev = eclipseShadowFactor(v(-1000e3, lo, 0), SUN);
  const samples = [prev];
  for (let i = 1; i <= 20; i++) {
    const perp = lo + (hi - lo) * (i / 20);
    const f = eclipseShadowFactor(v(-1000e3, perp, 0), SUN);
    assert.ok(f >= prev - 1e-9, `illumination must not fall as perp grows: ${prev} -> ${f}`);
    samples.push(f);
    prev = f;
  }
  assert.ok(new Set(samples.map((s) => s.toFixed(4))).size > 10,
            'the ramp must actually grade, not snap between two values');
});

/* ── frame-rotation invariance, degenerates, units ──────────────────────── */

await test('an off-axis sun direction gives the same geometry', () => {
  // Rotate everything: sun at 45° in the XY plane, satellite built in that
  // frame — the answers must be exactly the +X-sun ones above.
  const s = 1 / Math.sqrt(2);
  const sun = v(1.496e11 * s, 1.496e11 * s, 0);
  const toward = (km, offKm) => {
    const along = -km * 1000 * s, off = offKm * 1000;
    return v(along, along, off);   // -L·ŝ + off·ẑ
  };
  assert.equal(eclipseShadowFactor(toward(1000, 2000), sun), 0);   // umbra
  assert.equal(eclipseShadowFactor(toward(1000, 9000), sun), 1);   // outside
  assert.equal(eclipseShadowFactor(toward(-5000, 0), sun), 1);     // day side
  approx(eclipseShadowFactor(toward(1000, EARTH_R_KM), sun), 0.5, 1e-6); // mid-penumbra
});

await test('degenerate inputs are treated as lit, never NaN', () => {
  assert.equal(eclipseShadowFactor(v(-1000e3, 0, 0), v(0, 0, 0)), 1, 'no sun');
  assert.equal(eclipseShadowFactor(v(0, 0, 0), SUN), 1, 'satellite at the origin');
  assert.ok(Number.isFinite(eclipseShadowFactor(v(-1, 0, 0), SUN)), 'tiny night-side point');
});

await test('the model is scale-invariant (metres vs km agree)', () => {
  const m = eclipseShadowFactor(v(-1000e3, R, 0), SUN);
  const km = eclipseShadowFactor(
    { x: -1000, y: EARTH_R_KM, z: 0 },
    { x: 1.496e8, y: 0, z: 0 },
    { earthR: EARTH_R_KM }
  );
  approx(km, m, 1e-9);
});

await test('the umbra stays open across every orbit this repo renders', () => {
  // The cylinder model's domain: the umbra radius R − band must stay positive,
  // i.e. L < R / tan(θ_sun) ≈ 1.37e6 km. The camera zoom itself is capped at
  // 110,000 km (tuneCameraLimits), so every satellite these pages can ever
  // hold is inside the domain — pin the whole range rather than one spot.
  for (const Lkm of [100, 1000, 42000, 1.1e5]) {
    assert.ok(bandAt(Lkm) < R, `L=${Lkm} km: band ${bandAt(Lkm)} m must stay under ${R} m`);
  }
});

/* ── sunDirectionEcef: the shadow axis, in the Earth-fixed frame ──────────
 * C2 wiring: the engine computes one sun direction per drawn frame from the
 * clock. satellite.js (vendored v5.0.0) has no sun module and Cesium 1.113
 * dropped SunPosition, so the direction is computed in astro.js. Declination
 * anchors are genuinely closed-form astronomy (solstices ±23.44°, equinoxes
 * 0°), tolerant to ±0.5° for the low-precision algorithm and the few-hours
 * uncertainty in the published 2026 event instants. The ECEF longitude (GMST
 * rotation) has no independent closed form at this precision — its
 * correctness is proven end-to-end by the C2 headless probe's in-umbra
 * geometry check, which parks a sat at the antipode of this direction. */

const DEC = (s) => Math.asin(Math.max(-1, Math.min(1, s.z))) / Math.PI * 180;

await test('sunDirectionEcef returns a unit vector in 2026', () => {
  for (const [y, m, d, h] of [[2026, 3, 20, 12], [2026, 6, 21, 12], [2026, 12, 21, 12]]) {
    const s = sunDirectionEcef(new Date(Date.UTC(y, m, d, h)));
    approx(Math.hypot(s.x, s.y, s.z), 1, 1e-12);
  }
});

await test('June solstice 2026 declination ≈ +23.44°', () => {
  const s = sunDirectionEcef(new Date(Date.UTC(2026, 5, 21, 8, 24)));
  approx(DEC(s), 23.44, 0.5);
});

await test('December solstice 2026 declination ≈ −23.44°', () => {
  const s = sunDirectionEcef(new Date(Date.UTC(2026, 11, 21, 20, 50)));
  approx(DEC(s), -23.44, 0.5);
});

await test('equinoxes 2026 cross the equator (|decl| < 0.5°)', () => {
  const mar = sunDirectionEcef(new Date(Date.UTC(2026, 2, 20, 14, 46)));
  const sep = sunDirectionEcef(new Date(Date.UTC(2026, 8, 23, 0, 5)));
  assert.ok(Math.abs(DEC(mar)) < 0.5, `March decl ${DEC(mar).toFixed(3)}°`);
  assert.ok(Math.abs(DEC(sep)) < 0.5, `September decl ${DEC(sep).toFixed(3)}°`);
});

await test('seasonality: northern summer sun is over the north pole half', () => {
  const jun = sunDirectionEcef(new Date(Date.UTC(2026, 5, 21, 12)));
  const dec = sunDirectionEcef(new Date(Date.UTC(2026, 11, 21, 12)));
  assert.ok(jun.z > 0.35, `June z ${jun.z.toFixed(4)}`);
  assert.ok(dec.z < -0.35, `December z ${dec.z.toFixed(4)}`);
});

await test('the real sun axis eclipses its own antipode and lights its sub-solar point', () => {
  // Integration: feed sunDirectionEcef into eclipseShadowFactor at real
  // times — a GEO sat parked exactly opposite the sun is in full umbra, a
  // sat at the sub-solar point is fully lit. This is what the engine does
  // per frame; a sign error anywhere in the axis would flip both.
  for (const t of [new Date(Date.UTC(2026, 2, 20, 12)), new Date(Date.UTC(2026, 5, 21, 12))]) {
    const sun = sunDirectionEcef(t);
    const geo = 42164e3;
    assert.equal(eclipseShadowFactor(v(-sun.x * geo, -sun.y * geo, -sun.z * geo), sun), 0);
    assert.equal(eclipseShadowFactor(v(sun.x * geo, sun.y * geo, sun.z * geo), sun), 1);
  }
});
