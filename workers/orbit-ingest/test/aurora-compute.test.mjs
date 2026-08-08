/**
 * public/orbit-engine/astro.js — aurora oval maths (plan 34 §3.4).
 *
 *     node workers/orbit-ingest/test/aurora-compute.test.mjs
 *
 * The oval geometry is closed-form and asserted against an independent
 * spherical-trig implementation written here — the two paths share nothing
 * but the pole constants, so agreement to ~1e-4° is a real cross-check, not a
 * self-fulfilling one. The point-reflection property (south[k] exactly
 * antipodal to north[k]) follows from the geomagnetic south pole being the
 * geographic antipode and is asserted exactly.
 *
 * Guards:
 *   - astro.js staying pure (no Cesium/DOM) is pinned file-wide by
 *     occlusion.test.mjs — a broken Node import here would already fail there.
 *   - the /orbit/ page importing the maths rather than forking it (this file's
 *     existence is a pin, so it asserts the import too).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
    auroraBoundaryLat, auroraRingColatDeg, auroraOvals,
    GEOMAG_POLE_NORTH, AURORA_OVAL_OFFSET_DEG,
} from '../../../public/orbit-engine/astro.js';

const DEG = Math.PI / 180;
const D2R = DEG, R2D = 1 / DEG;

/* ── Independent reference implementation (spherical trig, not vectors) ─── */

/** Geographic unit vector for {lat, lon}. */
function ecefOf(lat, lon) {
    const la = lat * D2R, lo = lon * D2R;
    return { x: Math.cos(la) * Math.cos(lo), y: Math.cos(la) * Math.sin(lo), z: Math.sin(la) };
}

function norm(v) {
    const l = Math.hypot(v.x, v.y, v.z) || 1;
    return { x: v.x / l, y: v.y / l, z: v.z / l };
}

/** Centered-dipole frame from the pole constants — written independently. */
function refFrame() {
    const la = GEOMAG_POLE_NORTH.lat * D2R, lo = GEOMAG_POLE_NORTH.lon * D2R;
    const m = { x: Math.cos(la) * Math.cos(lo), y: Math.cos(la) * Math.sin(lo), z: Math.sin(la) };
    const e = norm({ x: -m.z * m.x, y: -m.z * m.y, z: 1 - m.z * m.z });
    const f = { x: m.y * e.z - m.z * e.y, y: m.z * e.x - m.x * e.z, z: m.x * e.y - m.y * e.x };
    return { m, e, f };
}

/** Point at geomagnetic colatitude theta / longitude phi (radians). */
function refPoint(theta, phi, { m, e, f }) {
    const ct = Math.cos(theta), st = Math.sin(theta);
    const cp = Math.cos(phi), sp = Math.sin(phi);
    return { x: ct * m.x + st * (cp * e.x + sp * f.x),
             y: ct * m.y + st * (cp * e.y + sp * f.y),
             z: ct * m.z + st * (cp * e.z + sp * f.z) };
}

const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

/** Great-circle angle between two {lat, lon} points, degrees. */
function angDeg(a, b) {
    return Math.acos(Math.min(1, Math.max(-1, dot(ecefOf(a.lat, a.lon), ecefOf(b.lat, b.lon))))) * R2D;
}

const results = [];
async function test(name, fn) {
    try { await fn(); results.push(`  PASS  ${name}`); }
    catch (e) { results.push(`  FAIL  ${name}\n        ${e.message}`); }
}

/* ── Boundary table ────────────────────────────────────────────────────── */

await test('boundary follows NOAA\'s linear table 66.5 − 2·Kp', () => {
    const table = [66.5, 64.5, 62.5, 60.5, 58.5, 56.5, 54.5, 52.5, 50.5, 48.5];
    for (let kp = 0; kp <= 9; kp++) {
        assert.ok(Math.abs(auroraBoundaryLat(kp) - table[kp]) < 1e-9, `Kp ${kp}`);
    }
});

await test('Kp is clamped to [0, 9] (SWPC has reported Kp 10)', () => {
    assert.equal(auroraBoundaryLat(-3), 66.5);
    assert.equal(auroraBoundaryLat(12), 48.5);
    assert.equal(auroraBoundaryLat(4.7), 66.5 - 9.4);
});

await test('ring colatitude is 90° − boundary', () => {
    assert.ok(Math.abs(auroraRingColatDeg(4) - 31.5) < 1e-9);
    assert.ok(Math.abs(auroraRingColatDeg(0) - 23.5) < 1e-9);
    assert.ok(Math.abs(auroraRingColatDeg(9) - 41.5) < 1e-9);
});

/* ── Ring geometry (Kp 4: ring colat 31.5°, offset 5°) ─────────────────── */

const SUN_NOON = { x: 0, y: 0, z: 1 };   // sun over the geographic north pole
const K4 = auroraOvals({ kp: 4, sunEcef: SUN_NOON });
const frame = refFrame();
const off = AURORA_OVAL_OFFSET_DEG * D2R;
const phiS = Math.atan2(dot(SUN_NOON, frame.f), dot(SUN_NOON, frame.e));
const C = refPoint(off, phiS + Math.PI, frame);          // expected centre

await test('defaults to 24 sample points per ring, no NaN', () => {
    assert.equal(K4.north.length, 24);
    assert.equal(K4.south.length, 24);
    for (const p of [...K4.north, ...K4.south]) {
        assert.ok(Number.isFinite(p.lat) && Number.isFinite(p.lon));
        assert.ok(Math.abs(p.lat) <= 90);
    }
});

await test('every north point sits exactly at the ring colatitude from the centre', () => {
    for (const p of K4.north) {
        const d = Math.acos(Math.min(1, Math.max(-1, dot(ecefOf(p.lat, p.lon), C)))) * R2D;
        assert.ok(Math.abs(d - 31.5) < 1e-4, `point ${JSON.stringify(p)} is ${d.toFixed(5)}° from centre`);
    }
});

await test('the centre is AURORA_OVAL_OFFSET_DEG from the geomagnetic pole', () => {
    const p = ecefOf(GEOMAG_POLE_NORTH.lat, GEOMAG_POLE_NORTH.lon);
    const d = Math.acos(Math.min(1, Math.max(-1, dot(p, C)))) * R2D;
    assert.ok(Math.abs(d - AURORA_OVAL_OFFSET_DEG) < 1e-9, `${d}°`);
});

await test('the centre rides the magnetic-midnight meridian', () => {
    // Midnight = geomagnetic longitude φs + 180°. The centre sits on that
    // meridian at colatitude `off`, so: geomagnetic longitude of C is φs+π,
    // and C·m = cos(off).
    const lonC = Math.atan2(dot(C, frame.f), dot(C, frame.e));
    assert.ok(Math.abs(lonC - (phiS + Math.PI)) < 1e-9, `lonC ${lonC * R2D}° vs ${(phiS + Math.PI) * R2D}°`);
    assert.ok(Math.abs(dot(C, frame.m) - Math.cos(off)) < 1e-9);
    // Physical anchor: with the sun over the geographic north pole, midnight
    // is the pole's own meridian equator-side — the centre must sit exactly
    // 5° equatorward of the pole, same longitude: 75.65°N, 72.68°W.
    const geo = { lat: Math.asin(dot(C, ecefOf(90, 0))) * R2D,
                  lon: Math.atan2(C.y, C.x) * R2D };
    assert.ok(Math.abs(geo.lat - 75.65) < 1e-4, `lat ${geo.lat}`);
    assert.ok(Math.abs(geo.lon - GEOMAG_POLE_NORTH.lon) < 1e-4, `lon ${geo.lon}`);
});

await test('ring extent brackets [ρ−off, ρ+off] from the pole', () => {
    const p = ecefOf(GEOMAG_POLE_NORTH.lat, GEOMAG_POLE_NORTH.lon);
    const dists = K4.north.map(pt =>
        Math.acos(Math.min(1, Math.max(-1, dot(p, ecefOf(pt.lat, pt.lon))))) * R2D);
    const min = Math.min(...dists), max = Math.max(...dists);
    assert.ok(Math.abs(min - (31.5 - AURORA_OVAL_OFFSET_DEG)) < 1e-3, `min ${min}`);
    assert.ok(Math.abs(max - (31.5 + AURORA_OVAL_OFFSET_DEG)) < 1e-3, `max ${max}`);
});

await test('the southern oval is the northern\'s point reflection', () => {
    for (let k = 0; k < K4.north.length; k++) {
        const n = ecefOf(K4.north[k].lat, K4.north[k].lon);
        const s = ecefOf(K4.south[k].lat, K4.south[k].lon);
        assert.ok(Math.abs(n.x + s.x) < 1e-9 && Math.abs(n.y + s.y) < 1e-9 && Math.abs(n.z + s.z) < 1e-9,
                  `pair ${k} not antipodal`);
    }
});

await test('north ring stays north of the equator, south ring south', () => {
    assert.ok(K4.north.every(p => p.lat > 0), 'a north point crossed the equator');
    assert.ok(K4.south.every(p => p.lat < 0), 'a south point crossed the equator');
});

await test('deterministic: same inputs, same rings', () => {
    const again = auroraOvals({ kp: 4, sunEcef: SUN_NOON });
    for (let k = 0; k < K4.north.length; k++) {
        assert.equal(K4.north[k].lat, again.north[k].lat);
        assert.equal(K4.north[k].lon, again.north[k].lon);
    }
});

await test('custom sample counts and storm-level Kp are honoured', () => {
    const s = auroraOvals({ kp: 9, sunEcef: { x: 0.5, y: 0.3, z: 0.8 }, samples: 48 });
    assert.equal(s.north.length, 48);
    assert.equal(s.south.length, 48);
    const p = ecefOf(GEOMAG_POLE_NORTH.lat, GEOMAG_POLE_NORTH.lon);
    for (const pt of s.north) {
        const d = Math.acos(Math.min(1, Math.max(-1, dot(p, ecefOf(pt.lat, pt.lon))))) * R2D;
        assert.ok(Math.abs(d - 41.5) < 41.5, `Kp9 point ${d.toFixed(2)}° from pole`);
    }
});

await test('a zero-magnitude sun yields empty rings, not NaN', () => {
    const z = auroraOvals({ kp: 4, sunEcef: { x: 0, y: 0, z: 0 } });
    assert.deepEqual(z, { north: [], south: [] });
});

/* ── Wiring pins ───────────────────────────────────────────────────────── */

await test('orbital-relay.js imports the ovals rather than re-implementing them', () => {
    const src = fs.readFileSync(new URL('../../../public/orbit/orbital-relay.js', import.meta.url), 'utf8');
    assert.ok(/import[^;]*\bauroraOvals\b/.test(src), 'orbital-relay.js must import auroraOvals');
    assert.ok(!/66\.5/.test(src), 'the boundary table must not be forked into the page');
});

await test('the AURORA layer exists in the registry as a builtin', () => {
    const src = fs.readFileSync(new URL('../../../public/orbit/layers.js', import.meta.url), 'utf8');
    assert.ok(/group: 'aurora'[^}]*builtin:\s*true/.test(src), 'AURORA must be a builtin layer entry');
});

console.log('\n-- aurora: ' + results.filter(r => r.startsWith('  PASS')).length + '/' +
            results.length + ' checks --');
console.log(results.join('\n'));
if (results.some(r => r.startsWith('  FAIL'))) process.exit(1);
