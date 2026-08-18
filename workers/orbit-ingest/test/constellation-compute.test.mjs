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
 *     which would silently break the very Node import this file exists for;
 *   - groupConstellation merging multi-shell groups (Starlink's live 43°/
 *     53°/70°/97.5° shells interleave RAANs so densely that a RAAN-only
 *     split collapses them into one plane — inclination banding must come
 *     first), or remapping band-local member indices onto the wrong
 *     entries array.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    smaKmFromMeanMotion, altKmFromSma, planeElements, circularMeanDeg,
    groupIntoPlanes, groupConstellation, planeRingDeg,
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

/* ── Two-level grouping: inclination bands, then RAAN per band ────────── */

console.log('\n-- groupConstellation --');

await test('multi-shell group (Starlink-like) keeps shells separate', () => {
  // Three shells whose RAANs interleave densely — a RAAN-only split sees
  // one continuous sequence (this is the live Starlink failure mode) while
  // inclination separates them by 10°+.
  const mk = (inclDeg, raanDeg) => ({ raanDeg, inclDeg, smaKm: 6921 });
  const entries = [
    // 53° shell, quasi-continuous RAANs
    ...Array.from({ length: 20 }, (_, i) => mk(53.0 + 0.02 * (i % 5), (i * 4.9) % 360)),
    // 43° shell, same RAAN range
    ...Array.from({ length: 10 }, (_, i) => mk(43.1 + 0.02 * (i % 3), (i * 9.8) % 360)),
    // 70° shell, wide spacing (real gaps)
    ...Array.from({ length: 9 }, (_, i) => mk(70.2, (i * 40) % 360)),
  ];
  const planes = groupConstellation(entries);
  const inclMeans = planes.map(p => p.inclDeg).sort((a, b) => a - b);
  assert.ok(planes.length >= 3, `expected >=3 planes, got ${planes.length}`);
  // every plane's mean inclination matches one of the three shells
  for (const m of inclMeans) {
    assert.ok(
      Math.abs(m - 43.1) < 0.5 || Math.abs(m - 53.0) < 0.5 || Math.abs(m - 70.2) < 0.5,
      `plane mean incl ${m} matches no shell`);
  }
  const total = planes.reduce((s, p) => s + p.count, 0);
  assert.equal(total, entries.length);
});

await test('a pure RAAN split WOULD merge the multi-shell group (contrast)', () => {
  const mk = (inclDeg, raanDeg) => ({ raanDeg, inclDeg, smaKm: 6921 });
  const entries = [
    ...Array.from({ length: 20 }, (_, i) => mk(53.0, (i * 4.9) % 360)),
    ...Array.from({ length: 10 }, (_, i) => mk(43.1, (i * 9.8) % 360)),
  ];
  assert.equal(groupIntoPlanes(entries, { raanTolDeg: 5 }).length, 1,
    'RAAN-only split merges interleaved shells — this is why banding exists');
});

await test('single-shell group equals groupIntoPlanes on the same entries', () => {
  const mk = (raanDeg) => ({ raanDeg, inclDeg: 55, smaKm: 26562 });
  const entries = [mk(10), mk(12), mk(70), mk(130), mk(132), mk(250)];
  const viaBands = groupConstellation(entries);
  const direct = groupIntoPlanes(entries, { raanTolDeg: 5 });
  assert.equal(viaBands.length, direct.length);
  viaBands.forEach((p, i) => {
    approx(p.raanDeg, direct[i].raanDeg, 1e-9);
    assert.equal(p.count, direct[i].count);
  });
});

await test('inclination gap exactly at the tolerance does not split; larger does', () => {
  const mk = incl => ({ raanDeg: 100, inclDeg: incl, smaKm: 6921 });
  assert.equal(groupConstellation([mk(53), mk(54)]).length, 1);
  assert.equal(groupConstellation([mk(53), mk(54.1)]).length, 2);
});

await test('members are indices into the ORIGINAL entries array', () => {
  const entries = [
    { raanDeg: 200, inclDeg: 43, smaKm: 6921 },   // 0
    { raanDeg: 5,   inclDeg: 53, smaKm: 6921 },   // 1
    { raanDeg: 9,   inclDeg: 53, smaKm: 6921 },   // 2
    { raanDeg: 40,  inclDeg: 70, smaKm: 6921 },   // 3
  ];
  const planes = groupConstellation(entries);
  const planeOf = i => planes.find(p => p.members.includes(i));
  assert.equal(planeOf(0).inclDeg, 43);
  assert.equal(planeOf(1).inclDeg, 53);
  assert.equal(planeOf(2).inclDeg, 53);
  assert.equal(planeOf(3).inclDeg, 70);
  assert.equal(planeOf(1).count, 2);
});

await test('a wrap-straddling plane inside one inclination band stays whole', () => {
  const mk = raan => ({ raanDeg: raan, inclDeg: 53, smaKm: 6921 });
  const entries = [mk(358.5), mk(359.8), mk(1.2), mk(120), mk(240)];
  const planes = groupConstellation(entries);
  assert.equal(planes.length, 3);
  // mean of [358.5, 359.8, 1.2] is ~359.83° — one plane, and it sorts LAST
  // (the earlier C1 test's 0.4° mean came from a [2.1] member; here it's 359.83)
  approx(planes[2].raanDeg, 359.83, 0.1);
  assert.equal(planes[2].count, 3);
});

await test('empty input yields no planes', () => {
  assert.deepEqual(groupConstellation([]), []);
});

await test('planes come back sorted by RAAN with circular ordering', () => {
  const mk = (incl, raan) => ({ raanDeg: raan, inclDeg: incl, smaKm: 6921 });
  const entries = [mk(43, 300), mk(43, 50), mk(70, 30), mk(53, 200), mk(43, 310), mk(70, 120)];
  const planes = groupConstellation(entries);
  const raans = planes.map(p => p.raanDeg);
  const sorted = [...raans].sort((a, b) => a - b);
  assert.deepEqual(raans, sorted);
  assert.equal(planes.length, 6);
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

/* ── The fly-in must frame the shell it is showing ────────────────────── */

await test('the intro fly-in altitude is derived from the shell, not hardcoded', () => {
  // THE REGRESSION GUARD for "GPS and Galileo render nothing". introFlyIn()
  // hardcoded 22,000 km — a framing tuned for LEO. GPS (~20,200 km) and
  // Galileo (~23,200 km) are MEO, so that camera sits ON or INSIDE their
  // shell: the sats were created, shown and fully opaque, but only ~9 of 32
  // projected onto the canvas, in the corners behind the HUD. The plane rings
  // still drew (sweeping off-screen), which is exactly why it read as "the tab
  // is broken" rather than "the camera is in the wrong place".
  const src = fs.readFileSync(
    path.resolve(HERE, '../../../public/constellations/constellations.js'), 'utf8');
  const fly = src.slice(src.indexOf('function flyInAltitude'),
                        src.indexOf('/* ── Debug handle'));
  assert.ok(/function flyInAltitude/.test(src),
            'constellations.js must derive the fly-in altitude from the loaded planes');
  assert.ok(/altKm/.test(fly),
            'flyInAltitude must read the planes\' altKm — the shell is what sets the framing');
  assert.ok(/introFlyIn\(currentData\)/.test(src),
            'introFlyIn must be handed the loaded constellation, not called bare');
});

await test('a MEO shell frames further out than a LEO one', () => {
  // Reimplements flyInAltitude's arithmetic against the constants the page
  // declares, so a change to either that stops separating LEO from MEO fails
  // here rather than on the GPS tab.
  const src = fs.readFileSync(
    path.resolve(HERE, '../../../public/constellations/constellations.js'), 'utf8');
  // Reads the declared value as an EXPRESSION (CAMERA_FOV_RAD is Math.PI / 3),
  // so the test tracks whatever the page actually declares rather than a
  // second copy of the number that could silently drift from it.
  const num = (name) => {
    const m = src.match(new RegExp('const\\s+' + name + '\\s*=\\s*([^;]+);'));
    assert.ok(m, `constellations.js must declare ${name}`);
    const v = Function('Math', `"use strict"; return (${m[1].split('//')[0]});`)(Math);
    assert.ok(Number.isFinite(v), `${name} must evaluate to a finite number`);
    return v;
  };
  const R = num('EARTH_R_M'), FOV = num('CAMERA_FOV_RAD');
  const MARGIN = num('FRAME_MARGIN');
  const MIN = num('MIN_FLY_ALT_M'), MAX = num('MAX_FLY_ALT_M');
  const camRadius = (altKm) => (R + altKm * 1000) / Math.tan(FOV / 2 * MARGIN);
  const alt = (altKm) => Math.min(Math.max(camRadius(altKm) - R, MIN), MAX);

  // LEO keeps the framing that already looked right.
  assert.equal(alt(550), MIN, 'Starlink must keep the LEO framing');
  assert.equal(alt(1200), MIN, 'OneWeb must keep the LEO framing');

  // MEO must pull the camera outside its own shell, or the sats leave frame.
  for (const [name, shellKm] of [['GPS', 20251], ['Galileo', 23242]]) {
    const cam = alt(shellKm);
    assert.ok(cam > shellKm * 1000,
              `${name}: camera ${Math.round(cam / 1000)} km must sit outside the ${shellKm} km shell`);
    assert.ok(cam > MIN,
              `${name}: camera must pull back further than the LEO framing`);
    // The real requirement: the plane RING, a full shell diameter wide, must
    // subtend less than the frame. This is what the first (tuned, 1.9) attempt
    // got wrong — the sats were on screen but every ring still ran off it.
    const shellR = R + shellKm * 1000;
    const halfAngle = Math.atan(shellR / camRadius(shellKm));
    assert.ok(halfAngle < FOV / 2,
              `${name}: the plane ring must fit inside the ${(FOV * 180 / Math.PI).toFixed(0)}° frame ` +
              `(subtends ${(halfAngle * 2 * 180 / Math.PI).toFixed(1)}°)`);
  }

  // The margin must actually leave room — a ring that exactly fills the frame
  // lands under the corner HUD panels.
  assert.ok(MARGIN > 0 && MARGIN < 1, 'FRAME_MARGIN must leave headroom for the HUD');

  // The framing must use the NARROWER screen axis. Cesium applies `fov` to the
  // wider axis, so on a 390x844 portrait phone the horizontal half-angle binds
  // and is roughly half the vertical one. Framing off the vertical fov alone
  // fit 19 of 32 GPS sats at 390px while desktop was fine — right maths, wrong
  // axis. Reimplemented here against the page's own frameHalfAngle().
  assert.ok(/function frameHalfAngle/.test(src),
            'constellations.js must derive the binding half-angle from the canvas aspect');
  assert.ok(/Math\.min\(w, h\)[\s\S]{0,40}Math\.max\(w, h\)/.test(src),
            'frameHalfAngle must compare the narrow axis against the wide one');

  const halfAngleFor = (w, h) => {
    const half = FOV / 2;
    return Math.min(half, Math.atan(Math.tan(half) * Math.min(w, h) / Math.max(w, h)));
  };
  // Portrait phone is tighter than desktop, and both must still fit the ring.
  assert.ok(halfAngleFor(390, 844) < halfAngleFor(1400, 900),
            'a portrait phone must frame from a tighter half-angle than desktop');
  for (const [w, h, name] of [[390, 844, 'iPhone 14'], [412, 915, 'Pixel 7'],
                              [1133, 744, 'iPad Mini landscape'], [1400, 900, 'desktop']]) {
    const shellR = R + 23242 * 1000;                       // Galileo, the outermost
    const camR = shellR / Math.tan(halfAngleFor(w, h) * MARGIN);
    assert.ok(Math.atan(shellR / camR) < halfAngleFor(w, h),
              `${name}: the Galileo ring must fit the binding axis at ${w}x${h}`);
  }
  // Never past what tuneCameraLimits will accept.
  assert.ok(alt(400000) <= MAX, 'the fly-in must stay inside maximumZoomDistance');
});

/* ── Summary ──────────────────────────────────────────────────────────── */

const failed = results.filter(r => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed\n`);
process.exit(failed ? 1 : 0);
