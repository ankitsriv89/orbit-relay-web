/**
 * public/spacetrack/signal/compute.js — signal-analysis maths, extracted from
 * the DOM handlers in plan 34 wave 2.2.
 *
 *     node workers/orbit-ingest/test/signal-compute.test.mjs
 *
 * Same arrangement as conjunction.test.mjs: frontend code, tested in the ingest
 * package's suite because the pure module takes its propagator by injection and
 * therefore needs no browser, no satellite.js and no Cesium. The coverage and
 * link-budget assertions are against closed-form geometry and the textbook
 * FSPL/radar equations; the state machines are driven with synthetic elevation
 * samplers whose windows are known exactly.
 *
 * What this catches:
 *
 *   - the visibility state machine shipping `maxElev: 0` on every window (the
 *     bug fixed during extraction — the running peak lived on a closed window);
 *   - a window/pass that opens and closes a sample early or late (a step-index
 *     slip in the `i <= steps` bound);
 *   - coverage-circle points that are not actually `radiusDeg` from the
 *     sub-satellite point, or a ring that is not closed;
 *   - a link-budget regression in EIRP, path loss, G/T or the SNR margin;
 *   - compute.js drifting back to referencing satellite.js/Cesium/DOM, which
 *     would silently break the very Node import this file exists for.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

import {
  degToRad, eciToEcf, coverageRadiusDeg, coverageCircleDeg,
  visibilityWindows, predictPasses, eirpDbm, freeSpaceLossDb,
  receivedPowerDbm, thermalNoiseDbm, snrDb, systemGtoTDb, linkMarginDb,
  linkBudget, stationEcfMetres, slantRangeKm, WGS84_A_KM, WGS84_B_KM,
} from '../../../public/spacetrack/signal/compute.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS  ' + name); }
  catch (e) { results.push(false); console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); }
}

const approx = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (±${tol})`);

/* ── eciToEcf ───────────────────────────────────────────────────────────── */

console.log('\n-- ECI/ECF frame conversion --');

await test('eciToEcf is a rotation by gmst about z, preserving altitude', () => {
  const gmst = degToRad(42);
  const p = eciToEcf({ x: 1, y: 0, z: 3 }, gmst);
  approx(p.x, Math.cos(gmst), 1e-12);
  approx(p.y, -Math.sin(gmst), 1e-12);   // ECF is the frame EAST of the node
  approx(p.z, 3, 1e-12);
});

await test('eciToEcf at gmst = 0 is the identity on the equatorial plane', () => {
  const p = eciToEcf({ x: 2, y: -1, z: 0 }, 0);
  approx(p.x, 2);
  approx(p.y, -1);
  approx(p.z, 0);
});

/* ── Coverage geometry ──────────────────────────────────────────────────── */

console.log('\n-- coverage circle --');

await test('at zero mask the coverage radius is the geometric horizon', () => {
  // Central angle of the visible horizon: acos(R/(R+h)). Closed form.
  const R = 6371;
  const h = 550;
  approx(coverageRadiusDeg(h, 0), (180 / Math.PI) * Math.acos(R / (R + h)), 1e-9);
});

await test('a higher elevation mask shrinks the footprint', () => {
  const r0 = coverageRadiusDeg(550, 0);
  const r10 = coverageRadiusDeg(550, 10);
  assert.ok(r10 > 0, 'a valid mask still yields a footprint');
  assert.ok(r10 < r0, `mask 10° gives ${r10}°, mask 0° gives ${r0}°`);
});

await test('a higher altitude yields a wider footprint', () => {
  assert.ok(coverageRadiusDeg(20000, 5) > coverageRadiusDeg(550, 5));
});

await test('every ring point is exactly radiusDeg from the sub-satellite point', () => {
  const ring = coverageCircleDeg(34.7, -119.7, 22.5, 64);
  assert.equal(ring.length, 65, 'segments + 1, so the ring is closed');
  // First and last bearings differ by 2π — the ring must come back to (≈) itself.
  approx(ring[0].lat, ring[64].lat, 1e-9);
  approx(ring[0].lon, ring[64].lon, 1e-9);
  // Great-circle distance from the sub-satellite point, in degrees (1° = π/180).
  for (const pt of ring) {
    const gc = Math.acos(
      Math.sin(degToRad(34.7)) * Math.sin(degToRad(pt.lat)) +
      Math.cos(degToRad(34.7)) * Math.cos(degToRad(pt.lat)) * Math.cos(degToRad(pt.lon + 119.7)),
    ) * 180 / Math.PI;
    approx(gc, 22.5, 1e-6);
  }
});

await test('bearing 0 lands due north and bearing 90° lands east on the equator', () => {
  const ring = coverageCircleDeg(0, 0, 10, 64);
  approx(ring[0].lat, 10);        // north
  approx(ring[0].lon, 0);
  approx(ring[16].lat, 0, 1e-9);  // 16/64 = bearing 90°
  approx(ring[16].lon, 10, 1e-9);
});

/* ── Visibility-window state machine ────────────────────────────────────── */

console.log('\n-- visibility windows --');

const T0 = Date.UTC(2026, 6, 28, 0, 0, 0);
const SEC = 1000;
const STEP = 30;

/** Sampler that is `elev` at the given integer steps and `below` otherwise. */
function stepElev(openSteps, elev, below = 5) {
  return (date) => {
    const i = Math.round((date.getTime() - T0) / (STEP * SEC));
    return openSteps.has(i) ? elev : below;
  };
}

await test('one contiguous above-mask run is one window, with the true peak', () => {
  const ws = visibilityWindows({
    t0Ms: T0, windowSec: 3600, stepSec: STEP, elevMask: 10,
    stationLat: 40, stationLon: -75,
    elevationAt: stepElev(new Set([10, 11, 12, 13, 14]), 45, 5),
  });
  assert.equal(ws.length, 1, JSON.stringify(ws));
  assert.equal(ws[0].start.getTime(), T0 + 10 * STEP * SEC);
  assert.equal(ws[0].end.getTime(), T0 + 15 * STEP * SEC, 'closes on the first sub-mask sample');
  assert.equal(ws[0].maxElev, 45, 'the peak is reported, not 0');
});

await test('the peak is the true maximum, not the opening or closing sample', () => {
  // Ascend 10°→28° then descend back below the mask. Peak = 28 at the apex.
  const elevAt = (date) => {
    const i = Math.round((date.getTime() - T0) / (STEP * SEC));
    if (i < 10 || i > 22) return 5;
    return 10 + (i <= 16 ? 2 * (i - 10) : 2 * (22 - i));
  };
  const ws = visibilityWindows({
    t0Ms: T0, windowSec: 1200, stepSec: STEP, elevMask: 10,
    stationLat: 40, stationLon: -75, elevationAt: elevAt,
  });
  assert.equal(ws.length, 1);
  assert.equal(ws[0].maxElev, 22, 'elevation peaks at 22°, not at the window edges');
});

await test('two separated runs are two windows', () => {
  const ws = visibilityWindows({
    t0Ms: T0, windowSec: 3600, stepSec: STEP, elevMask: 10,
    stationLat: 40, stationLon: -75,
    elevationAt: stepElev(new Set([5, 6, 7, 40, 41, 42]), 30, 5),
  });
  assert.equal(ws.length, 2);
  assert.equal(ws[0].start.getTime(), T0 + 5 * STEP * SEC);
  assert.equal(ws[0].end.getTime(), T0 + 8 * STEP * SEC);
  assert.equal(ws[1].start.getTime(), T0 + 40 * STEP * SEC);
  assert.equal(ws[1].end.getTime(), T0 + 43 * STEP * SEC);
});

await test('a run that is still open at the end of the window is reported', () => {
  const ws = visibilityWindows({
    t0Ms: T0, windowSec: 1200, stepSec: STEP, elevMask: 10,
    stationLat: 40, stationLon: -75,
    elevationAt: stepElev(new Set([35, 36, 37, 38, 39, 40]), 50, 5),
  });
  assert.equal(ws.length, 1, 'trailing run must not be dropped');
  assert.equal(ws[0].end.getTime(), T0 + 1200 * SEC, 'closed at the end of the span');
});

await test('null elevations (a diverged propagator) are skipped, not fatal', () => {
  const elevAt = (date) => {
    const i = Math.round((date.getTime() - T0) / (STEP * SEC));
    if (i >= 10 && i <= 12) return null;      // propagator gives no solution
    return (i >= 13 && i <= 15) ? 40 : 5;
  };
  const ws = visibilityWindows({
    t0Ms: T0, windowSec: 1200, stepSec: STEP, elevMask: 10,
    stationLat: 40, stationLon: -75, elevationAt: elevAt,
  });
  assert.equal(ws.length, 1);
  assert.equal(ws[0].start.getTime(), T0 + 13 * STEP * SEC);
});

await test('no run at all returns an empty list', () => {
  const ws = visibilityWindows({
    t0Ms: T0, windowSec: 3600, stepSec: STEP, elevMask: 10,
    stationLat: 40, stationLon: -75, elevationAt: () => 5,
  });
  assert.deepEqual(ws, []);
});

/* ── Pass predictions ───────────────────────────────────────────────────── */

console.log('\n-- pass predictions --');

await test('a pass shorter than the minimum duration is dropped', () => {
  const run = (minDurSec) => predictPasses({
    t0Ms: T0, daysAhead: 1, stepSec: STEP, elevMask: 10, minDurSec,
    targetLat: 40, targetLon: -75,
    elevationAt: stepElev(new Set([10, 11, 12, 13]), 40, 5),   // 4 steps = 120 s
  });
  assert.equal(run(60).length, 1);
  assert.equal(run(121).length, 0, 'a 120 s pass must not survive a 121 s minimum');
  const p = run(60)[0];
  assert.equal(p.durSec, 120);
  assert.equal(p.maxElev, 40);
});

await test('daysAhead spans the horizon, and passes carry start/end/maxElev', () => {
  // Above mask for one window at steps 10..13 and a second at steps 70..73.
  const passes = predictPasses({
    t0Ms: T0, daysAhead: 1, stepSec: STEP, elevMask: 10, minDurSec: 60,
    targetLat: 40, targetLon: -75,
    elevationAt: stepElev(new Set([10, 11, 12, 13, 70, 71, 72, 73]), 35, 5),
  });
  assert.equal(passes.length, 2);
  assert.equal(passes[0].durSec, 120);
  assert.equal(passes[0].maxElev, 35);
  assert.equal(passes[1].start.getTime(), T0 + 70 * STEP * SEC);
  assert.equal(passes[1].end.getTime(), T0 + 74 * STEP * SEC);
});

/* ── RF / link budget ───────────────────────────────────────────────────── */

console.log('\n-- RF / link budget --');

await test('EIRP is 10·log10(mW) + gain — closed form', () => {
  assert.equal(eirpDbm(10, 10), 50);                    // 10 W = 40 dBm, +10 dBi
  assert.equal(eirpDbm(1, 0), 30);                      // 1 W = 30 dBm, +0 dBi
  assert.equal(eirpDbm(100, 20), 70);                   // 100 W = 50 dBm, +20 dBi
});

await test('free-space path loss matches the textbook constant 32.44', () => {
  // FSPL(dB) = 20·log10(d[km]) + 20·log10(f[MHz]) + 32.45, where the constant is
  // exactly 20·log10(4π·10⁹/c) — the implementation uses the exact value, so
  // the test's constant must too, not the rounded "32.44" often quoted.
  const k = 20 * Math.log10((4 * Math.PI * 1e9) / 299792458);
  const expected = -(20 * Math.log10(6371) + 20 * Math.log10(2200) + k);
  approx(freeSpaceLossDb(6371, 2200), expected, 1e-9);
});

await test('path loss grows with range and frequency', () => {
  assert.ok(freeSpaceLossDb(12742, 2200) < freeSpaceLossDb(6371, 2200));
  assert.ok(freeSpaceLossDb(6371, 4400) < freeSpaceLossDb(6371, 2200));
});

await test('thermal noise is kTB at 290 K — −174 dBm/Hz plus 10·log10(B)', () => {
  assert.equal(thermalNoiseDbm(1000), -114);            // 1 MHz bandwidth
  assert.equal(thermalNoiseDbm(1), -144);               // 1 kHz bandwidth
});

await test('G/T is receiver gain minus the 290 K noise floor', () => {
  approx(systemGtoTDb(40), 40 - 10 * Math.log10(290), 1e-12);
});

await test('received power and SNR follow the cascade', () => {
  const rcv = receivedPowerDbm(50, -175, 40);
  assert.equal(rcv, -85);
  assert.equal(snrDb(rcv, -114), 29);
  assert.equal(linkMarginDb(29, 10), 19);
});

await test('linkBudget aggregates the whole chain end to end', () => {
  const b = linkBudget({
    freqMHz: 2200, txPowerW: 10, txGainDbi: 10, rxGainDbi: 40,
    dataRateKbps: 1000, rangeKm: 6371,
  });
  assert.equal(b.eirp, 50);
  assert.equal(b.receivedPower, b.eirp + b.pathLoss + 40);
  assert.equal(b.snr, b.receivedPower - b.noise);
  assert.equal(b.margin, b.snr - 10);
  assert.equal(b.gToT, systemGtoTDb(40));
});

/* ── Geodetic → ECF and slant range (plan 34 §3.4) ─────────────────────── */

console.log('\n-- WGS-84 geodetic → ECF and slant range --');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

await test('the geodetic→ECF transform hits the closed-form anchors exactly', () => {
  // Equator, lon 0, sea level → (a, 0, 0); lon 90 → (0, a, 0); north pole → (0, 0, b).
  const eq = stationEcfMetres({ latDeg: 0, lonDeg: 0, altKm: 0 });
  approx(eq.x, WGS84_A_KM * 1000, 1e-6);
  approx(eq.y, 0, 1e-9);
  approx(eq.z, 0, 1e-9);
  const eq90 = stationEcfMetres({ latDeg: 0, lonDeg: 90, altKm: 0 });
  approx(eq90.y, WGS84_A_KM * 1000, 1e-6);
  approx(eq90.x, 0, 1e-9);
  const pole = stationEcfMetres({ latDeg: 90, lonDeg: 0, altKm: 0 });
  approx(pole.z, WGS84_B_KM * 1000, 1e-6);
  approx(pole.x, 0, 1e-6);
  approx(pole.y, 0, 1e-6);
});

await test('altitude rides straight up the ellipsoid normal at the equator', () => {
  const p = stationEcfMetres({ latDeg: 0, lonDeg: 0, altKm: 1 });
  approx(p.x, (WGS84_A_KM + 1) * 1000, 1e-6);   // at lat 0 the prime vertical is a
  const pz = stationEcfMetres({ latDeg: 90, lonDeg: 0, altKm: 0.4 });
  approx(pz.z, (WGS84_B_KM + 0.4) * 1000, 1e-6);
});

await test('slant range is the straight-line ECF distance in km', () => {
  const st = stationEcfMetres({ latDeg: 0, lonDeg: 0, altKm: 0 });
  const overhead = { x: st.x, y: st.y, z: st.z + 400 * 1000 };
  approx(slantRangeKm(st, overhead), 400, 1e-9);           // exactly overhead
  const antipode = { x: -st.x, y: -st.y, z: -st.z };
  approx(slantRangeKm(st, antipode), 2 * WGS84_A_KM, 1e-9); // through the centre
});

await test('the transform agrees with the vendored satellite.js to 1e-6 km', () => {
  // The page's other sight-line maths use satellite.js's geodeticToEcf /
  // ecfToLookAngles (km). compute.js must not import it, so this loads the
  // vendored file into a bare vm context and cross-checks both functions.
  const src = read('public/orbit-engine/vendor/satellite.min.js');
  const { runInContext, createContext } = require('node:vm');
  // The UMD wrapper binds its API to `globalThis.satellite` of the vm context —
  // runInContext returns the script's completion value, so read it off the
  // context object.
  const ctx = createContext({});
  runInContext(src, ctx);
  const satjs = ctx.satellite;
  assert.ok(satjs && typeof satjs.geodeticToEcf === 'function', 'vendored satellite.js loads');

  const g = { latitude: degToRad(45.2), longitude: degToRad(-118.7), height: 0.62 };
  const mine = stationEcfMetres({ latDeg: 45.2, lonDeg: -118.7, altKm: 0.62 });
  const theirs = satjs.geodeticToEcf(g);
  approx(mine.x / 1000, theirs.x, 1e-6);
  approx(mine.y / 1000, theirs.y, 1e-6);
  approx(mine.z / 1000, theirs.z, 1e-6);

  const st = stationEcfMetres({ latDeg: -33.9, lonDeg: 151.2, altKm: 0.05 });
  const sat = { x: 2000e3 + 3e6, y: 4000e3, z: 5000e3 };
  const look = satjs.ecfToLookAngles(
    { latitude: degToRad(-33.9), longitude: degToRad(151.2), height: 0.05 },
    { x: sat.x / 1000, y: sat.y / 1000, z: sat.z / 1000 }
  );
  assert.ok(look && typeof look.rangeSat === 'number', 'ecfToLookAngles returns rangeSat');
  approx(slantRangeKm(st, sat), look.rangeSat, 1e-6);
});

await test('the station data file ships 50 real stations, fallback included', () => {
  const data = JSON.parse(read('public/data/ground-stations.json'));
  assert.equal(data.length, 50);
  const seen = new Set();
  for (const s of data) {
    assert.ok(typeof s.name === 'string' && s.name.length > 0, 'name');
    assert.ok(Number.isFinite(s.lat) && Math.abs(s.lat) <= 90, s.name + ' lat');
    assert.ok(Number.isFinite(s.lon) && Math.abs(s.lon) <= 180, s.name + ' lon');
    assert.ok(Number.isFinite(s.alt) && s.alt >= 0, s.name + ' alt');
    assert.ok(!seen.has(s.name), 'duplicate name ' + s.name);
    seen.add(s.name);
  }
  const fallback = /FALLBACK_STATIONS\s*=\s*\[([\s\S]*?)\n\];/.exec(read('public/spacetrack/signal/signal.js'));
  assert.ok(fallback, 'FALLBACK_STATIONS block found in signal.js');
  const fallbackRows = [...fallback[1].matchAll(/\{ name: '([^']+)', lat: ([\d.+-]+), lon: ([\d.+-]+)[^}]*\}/g)]
    .map(m => ({ name: m[1], lat: Number(m[2]), lon: Number(m[3]) }));
  assert.ok(fallbackRows.length >= 20, `fallback has ${fallbackRows.length} stations`);
  for (const f of fallbackRows) {
    const match = data.find(s => s.name === f.name);
    assert.ok(match, `fallback station "${f.name}" missing from the data file`);
    approx(match.lat, f.lat, 1e-9);
    approx(match.lon, f.lon, 1e-9);
  }
});

await test('compute.js stays importable in Node: no browser globals', () => {
  // The invariant is about CODE, not prose — the file header legitimately names
  // satellite.js and Cesium while explaining why they must not be called. Strip
  // both comment styles first so the header does not trip the check.
  const src = read('public/spacetrack/signal/compute.js')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  assert.ok(!/\bsatellite\s*\./.test(src), 'no satellite.js calls');
  assert.ok(!/\bCesium\s*\./.test(src), 'no Cesium calls');
  assert.ok(!/\bdocument\s*\./.test(src), 'no DOM access');
  assert.ok(!/\bwindow\s*\./.test(src), 'no window access');
});

await test('signal.js imports the maths instead of re-implementing it', () => {
  const src = read('public/spacetrack/signal/signal.js');
  for (const fn of ['visibilityWindows', 'predictPasses', 'coverageRadiusDeg',
                    'coverageCircleDeg', 'linkBudget', 'stationEcfMetres',
                    'slantRangeKm']) {
    assert.ok(new RegExp(`import[\\s\\S]*\\b${fn}\\b`).test(src),
              `signal.js must import ${fn}`);
  }
  assert.ok(!/Math\.acos\(EARTH_R_KM/.test(src),
            'the coverage-radius math must not be re-implemented inline');
  assert.ok(!/let inWindow|let inPass/.test(src),
            'the window/pass state machines must not be re-implemented inline');
});

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
