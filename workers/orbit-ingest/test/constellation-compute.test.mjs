/**
 * public/constellations/compute.js — constellation plane arithmetic from
 * plan 34 §3.2 (spec #7), extracted from the page layer in the same
 * discipline as signal-compute.test.mjs: pure module, unit-tested in Node
 * against synthetic constellations with exactly-known answers.
 *
 *     node workers/orbit-ingest/test/constellation-compute.test.mjs
 *
 * What this catches:
 *
 *   - a Kepler slip in smaKmFromMeanMotion (mean motion rad/min vs rad/s);
 *   - a plane split at the wrong gap, or a plane whose members straddle
 *     0°/360° being torn in two by the wrap boundary;
 *   - the circular mean returning ~180° for angles clustered around 0°;
 *   - a ring whose points are not on the orbital plane (bad rotation
 *     matrix), not at the requested radius, or not closed;
 *   - compute.js drifting back to referencing satellite.js/Cesium/DOM,
 *     which would silently break the very Node import this file exists for.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    smaKmFromMeanMotion, altKmFromSma, planeElements, circularMeanDeg,
    groupIntoPlanes, planeRingDeg,
} from '../../../public/constellations/compute.js';
import { EARTH_R_KM, GM_EARTH, orbitRegime } from '../../../public/orbit-engine/astro.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS  ' + name); }
  catch (e) { results.push(false); console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); }
}

const approx = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (±${tol})`);

/* circular distance between two angles in degrees, 0..180 */
const circDist = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

/* ── Semi-major axis from mean motion ─────────────────────────────────── */

console.log('\n-- smaKmFromMeanMotion --');

await test('Starlink-like 96.3 min period gives ~6920 km SMA (~549 km altitude)', () => {
  const periodMin = 96.3;
  const no = 2 * Math.PI / periodMin;
  const a = smaKmFromMeanMotion(no);
  // Independent closed form: a = (GM (T/2π)²)^(1/3) with T in seconds.
  const T = periodMin * 60;
  const expect = Math.cbrt(GM_EARTH * T * T / (4 * Math.PI * Math.PI));
  approx(a, expect, 1e-9);
  approx(altKmFromSma(a), a - EARTH_R_KM, 1e-9);
  assert.ok(a > EARTH_R_KM + 300 && a < EARTH_R_KM + 800, `altitude ${a - EARTH_R_KM} km`);
});

await test('GPS-like 718 min period gives ~26562 km SMA (~20191 km altitude)', () => {
  const periodMin = 718;
  const no = 2 * Math.PI / periodMin;
  const a = smaKmFromMeanMotion(no);
  const T = periodMin * 60;
  approx(a, Math.cbrt(GM_EARTH * T * T / (4 * Math.PI * Math.PI)), 1e-9);
  approx(altKmFromSma(a), 20191, 2);
  assert.equal(orbitRegime(altKmFromSma(a)), 'MEO');
});

/* ── Plane elements ───────────────────────────────────────────────────── */

console.log('\n-- planeElements --');

await test('maps TLE elements (radians) to degrees + SMA + shell', () => {
  const no = 2 * Math.PI / 96.3;
  const el = planeElements({ raanRad: Math.PI, inclRad: Math.PI / 2, noRadPerMin: no });
  approx(el.raanDeg, 180, 1e-12);
  approx(el.inclDeg, 90, 1e-12);
  approx(el.smaKm, smaKmFromMeanMotion(no), 1e-12);
  assert.equal(el.shell, 'LEO');
});

/* ── Circular mean ────────────────────────────────────────────────────── */

console.log('\n-- circularMeanDeg --');

await test('angles straddling 0° mean to ~0°, not ~180°', () => {
  approx(circularMeanDeg([358, 2]), 0, 1e-9);
  approx(circularMeanDeg([350, 355, 5, 10]), 0, 1e-9);
});

await test('angles around 180° mean to 180°', () => {
  approx(circularMeanDeg([175, 185]), 180, 1e-9);
});

/* ── Plane grouping ───────────────────────────────────────────────────── */

console.log('\n-- groupIntoPlanes --');

await test('three planes at RAAN 0/120/240 with jitter group exactly', () => {
  const entries = [];
  for (const raan of [0, 120, 240]) {
    for (let k = 0; k < 10; k++) {
      entries.push({
        raanDeg: raan + (Math.random() - 0.5) * 0.8,
        inclDeg: 53 + (Math.random() - 0.5) * 0.4,
        smaKm: 6921 + (Math.random() - 0.5) * 6,
      });
    }
  }
  const planes = groupIntoPlanes(entries, { raanTolDeg: 5 });
  assert.equal(planes.length, 3);
  // Match planes by circular distance, not array index: a plane whose mean
  // lands slightly *negative* is correctly represented as ~359.9° and sorts
  // last. Both are the same angle — compare them as angles.
  const expect = [0, 120, 240];
  for (const p of planes) {
    const idx = expect.findIndex(e => circDist(p.raanDeg, e) <= 1.5);
    assert.ok(idx >= 0, `plane RAAN ${p.raanDeg} matches no expected plane`);
    expect.splice(idx, 1);
    assert.equal(p.count, 10);
    approx(p.inclDeg, 53, 0.5);
    approx(p.smaKm, 6921, 5);
    assert.equal(p.shell, 'LEO');
    assert.equal(p.members.length, 10);
  }
  // members are indices into entries, and cover every entry exactly once
  const seen = new Set();
  for (const p of planes) for (const m of p.members) { assert.ok(!seen.has(m)); seen.add(m); }
  assert.equal(seen.size, entries.length);
});

await test('a plane straddling 0°/360° stays one plane', () => {
  const entries = [
    { raanDeg: 358.5, inclDeg: 53, smaKm: 6921 },
    { raanDeg: 359.8, inclDeg: 53, smaKm: 6921 },
    { raanDeg: 1.2,   inclDeg: 53, smaKm: 6921 },
    { raanDeg: 2.1,   inclDeg: 53, smaKm: 6921 },
    { raanDeg: 120.3, inclDeg: 53, smaKm: 6921 },
    { raanDeg: 240.7, inclDeg: 53, smaKm: 6921 },
  ];
  const planes = groupIntoPlanes(entries, { raanTolDeg: 5 });
  assert.equal(planes.length, 3);
  approx(planes[0].raanDeg, 0.4, 0.5);
  assert.equal(planes[0].count, 4);
  approx(planes[1].raanDeg, 120.3, 0.1);
  approx(planes[2].raanDeg, 240.7, 0.1);
});

await test('singletons are their own planes', () => {
  const entries = [
    { raanDeg: 5,   inclDeg: 53, smaKm: 6921 },
    { raanDeg: 100, inclDeg: 53, smaKm: 6921 },
    { raanDeg: 200, inclDeg: 53, smaKm: 6921 },
  ];
  const planes = groupIntoPlanes(entries, { raanTolDeg: 5 });
  assert.equal(planes.length, 3);
  planes.forEach(p => assert.equal(p.count, 1));
});

await test('everything within tolerance collapses to one plane', () => {
  const entries = [
    { raanDeg: 10, inclDeg: 53, smaKm: 6921 },
    { raanDeg: 12, inclDeg: 53, smaKm: 6921 },
    { raanDeg: 14, inclDeg: 53, smaKm: 6921 },
  ];
  const planes = groupIntoPlanes(entries, { raanTolDeg: 5 });
  assert.equal(planes.length, 1);
  assert.equal(planes[0].count, 3);
  approx(planes[0].raanDeg, 12, 1e-9);
});

await test('gap exactly at the tolerance does not split; larger does', () => {
  const mk = raan => ({ raanDeg: raan, inclDeg: 53, smaKm: 6921 });
  assert.equal(groupIntoPlanes([mk(0), mk(5)], { raanTolDeg: 5 }).length, 1);
  assert.equal(groupIntoPlanes([mk(0), mk(5.1)], { raanTolDeg: 5 }).length, 2);
});

await test('empty input yields no planes', () => {
  assert.deepEqual(groupIntoPlanes([]), []);
});

/* ── Ring geometry ────────────────────────────────────────────────────── */
/* planeRingDeg returns {lat, lon} *directions* — the ring's radius is a
 * caller-side altitude. All radius assertions below therefore check the
 * direction vector instead, plus that it tracks the expected rotation. */

const RAD = Math.PI / 180;
function ringDir(p) {
  const la = p.lat * RAD, lo = p.lon * RAD;
  return {
    x: Math.cos(la) * Math.cos(lo),
    y: Math.cos(la) * Math.sin(lo),
    z: Math.sin(la),
  };
}
function ringRadiusKm(p) {
  const v = ringDir(p);
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

console.log('\n-- planeRingDeg --');

await test('equatorial plane is latitude 0 with longitude following RAAN + argument of latitude', () => {
  const raanDeg = 45, seg = 64;
  const pts = planeRingDeg({ raanDeg, inclDeg: 0, radiusKm: 6921 }, seg);
  for (let i = 0; i <= seg; i++) {
    const p = pts[i];
    approx(p.lat, 0, 1e-9);
    const u = (i / seg) * 360;
    const expectLon = (raanDeg + u) % 360;
    assert.ok(circDist(p.lon, expectLon) <= 1e-9, `lon ${p.lon} vs ${expectLon}`);
  }
});

await test('polar plane (RAAN 0) is the meridian ring through both poles', () => {
  const pts = planeRingDeg({ raanDeg: 0, inclDeg: 90, radiusKm: 6921 }, 64);
  for (const p of pts) {
    const d = ringDir(p);
    approx(d.y, 0, 1e-9);                       // the x-z meridian plane
    approx(ringRadiusKm(p), 1, 1e-12);          // unit direction
  }
  const maxLat = Math.max(...pts.map(p => p.lat));
  approx(maxLat, 90, 1e-9);
  const minLat = Math.min(...pts.map(p => p.lat));
  approx(minLat, -90, 1e-9);
});

await test('every point lies in the orbital plane (dot with normal ≈ 0)', () => {
  const raanDeg = 30, inclDeg = 40;
  const pts = planeRingDeg({ raanDeg, inclDeg, radiusKm: 26562 }, 90);
  // Plane normal n = Rz(Ω)·Rx(i)·(0,0,1).
  const raan = raanDeg * Math.PI / 180, incl = inclDeg * Math.PI / 180;
  const n = {
    x: Math.sin(incl) * Math.sin(raan),
    y: -Math.sin(incl) * Math.cos(raan),
    z: Math.cos(incl),
  };
  for (const p of pts) {
    const v = ringDir(p);
    const dot = v.x * n.x + v.y * n.y + v.z * n.z;
    approx(dot, 0, 1e-9);
  }
  approx(Math.acos(n.z) * 180 / Math.PI, inclDeg, 1e-9);   // normal tilts from z by the inclination
});

await test('ring is closed (last point equals first)', () => {
  const pts = planeRingDeg({ raanDeg: 123, inclDeg: 71, radiusKm: 8000 }, 180);
  approx(pts[pts.length - 1].lat, pts[0].lat, 1e-12);
  approx(pts[pts.length - 1].lon, pts[0].lon, 1e-12);
});

/* ── Summary ──────────────────────────────────────────────────────────── */

const failed = results.filter(r => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed\n`);
process.exit(failed ? 1 : 0);
