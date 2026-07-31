/**
 * public/orbit-engine/conjunction.js — the derived close-approach screen.
 *
 *     node workers/orbit-ingest/test/conjunction.test.mjs
 *
 * Frontend code in the ingest package's suite, deliberately, for the same reason
 * pages-api.test.mjs is here: one `npm test` entry point is worth more than
 * package tidiness, and derive.test.mjs already reaches into `public/` to assert
 * the citation. `conjunction.js` takes its propagator by injection precisely so
 * this file can exist — no browser, no satellite.js, no Cesium.
 *
 * The propagator below is analytic two-body circular motion, which is what makes
 * these assertions worth anything: for the geometries constructed here the true
 * closest approach and the true time of closest approach are known in CLOSED
 * FORM, so the test checks the screen against the answer rather than against
 * itself. Two orbits of radii r1, r2 in the same plane running in opposite
 * directions cross at a known instant with separation exactly |r1 − r2|.
 *
 * What that catches:
 *
 *   - a coarse march that steps over a fast conjunction (the completeness bound
 *     is the whole design; a step/gate pair that violates it fails silently and
 *     looks like "there were no conjunctions");
 *   - a linear-TCA solve that reports the separation at the SAMPLE rather than
 *     at the minimum — at 15 km/s those differ by ~100 km;
 *   - a shell sieve that excludes a pair it should keep (silent misses again),
 *     or keeps LEO×GEO pairs it should drop (a real cost — it is per step);
 *   - one physical pair reported once per coarse step instead of once.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EARTH_R_KM, MAX_REL_SPEED_KMS, gateKm, maxStepSec, orbitShell, shellValid,
  shellsOverlap, buildPairs, linearTca, separationKm, createScreen,
} from '../../../public/orbit-engine/conjunction.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS  ' + name); }
  catch (e) { results.push(false); console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); }
}

/* ── An analytic propagator with known answers ──────────────────────────── */

const MU = 398600.4418;   // km^3/s^2

/**
 * A circular orbit, rotated out of the equatorial plane by a fixed arbitrary
 * rotation applied to EVERY object.
 *
 * The rotation does not change any separation — it is a rigid transform — so
 * the closed-form answers still hold, but it means no state vector in these
 * tests is axis-aligned. An indexing slip in `linearTca` that happens to work
 * when y and z are zero does not survive it.
 */
const ALPHA = 0.7, BETA = 0.4;
function rotate(x, y, z, out, off) {
  // Rx(BETA) then Rz(ALPHA).
  const y1 = y * Math.cos(BETA) - z * Math.sin(BETA);
  const z1 = y * Math.sin(BETA) + z * Math.cos(BETA);
  out[off]     = x * Math.cos(ALPHA) - y1 * Math.sin(ALPHA);
  out[off + 1] = x * Math.sin(ALPHA) + y1 * Math.cos(ALPHA);
  out[off + 2] = z1;
}

/**
 * @param {number} rKm orbit radius
 * @param {number} phase0 angle at t = 0
 * @param {number} dir +1 prograde, -1 retrograde
 */
function circular(rKm, phase0, dir = 1) {
  const n = dir * Math.sqrt(MU / (rKm * rKm * rKm));   // rad/s
  return {
    n,
    rKm,
    shell: { rpKm: rKm, raKm: rKm },
    at(tSec, out, off) {
      const th = phase0 + n * tSec;
      rotate(rKm * Math.cos(th), rKm * Math.sin(th), 0, out, off);
      rotate(-rKm * n * Math.sin(th), rKm * n * Math.cos(th), 0, out, off + 3);
      return true;
    },
  };
}

const T0 = Date.UTC(2026, 6, 28, 0, 0, 0);

/** Wires a set of analytic orbits up as a `sample`, counting the calls. */
function propagatorFor(orbits) {
  const calls = { n: 0 };
  const sample = (i, tMs, out, off) => {
    calls.n++;
    const o = orbits[i];
    if (!o) return false;
    return o.at((tMs - T0) / 1000, out, off);
  };
  return { sample, calls };
}

/**
 * Two coplanar counter-rotating circular orbits that pass each other at exactly
 * `tcaSec`, with a closest approach of exactly `missKm`.
 *
 * Angles coincide when n1·t = φ − n2·t, so φ = tcaSec·(n1 + n2) puts the crossing
 * where we want it. At that instant both are at the same angle and different
 * radii, so the separation is |r1 − r2| and it is the global minimum: angular
 * separation grows linearly away from it at (n1 + n2), i.e. ~15 km/s of closing
 * speed — the sharp geometry the refinement has to handle.
 */
function crossingPair(rKm, missKm, tcaSec) {
  const a  = circular(rKm, 0, +1);
  const n2 = Math.sqrt(MU / Math.pow(rKm + missKm, 3));
  const b  = circular(rKm + missKm, tcaSec * (Math.abs(a.n) + n2), -1);
  return [a, b];
}

function runToCompletion(screen) {
  let guard = 0;
  while (!screen.advance(16)) {
    if (++guard > 100000) throw new Error('screen never terminated');
  }
  return screen.results();
}

/* ── Constants and the completeness bound ───────────────────────────────── */

console.log('\n-- gate, step and the completeness bound --');

await test('the gate is derived from the step, not tuned', () => {
  // Nothing else in the file may hardcode a capture radius: the guarantee is
  // gate = threshold + v_max·step/2, so a step change must move the gate.
  assert.equal(gateKm(10, 15), 10 + (MAX_REL_SPEED_KMS * 15) / 2);
  assert.ok(gateKm(10, 30) > gateKm(10, 15), 'a longer step needs a wider gate');
  assert.ok(gateKm(25, 15) > gateKm(10, 15), 'a wider threshold needs a wider gate');
});

await test('maxStepSec inverts gateKm', () => {
  for (const [d, s] of [[1, 15], [10, 15], [25, 30], [5, 60]]) {
    assert.ok(Math.abs(maxStepSec(d, gateKm(d, s)) - s) < 1e-9, `${d}km / ${s}s`);
  }
});

await test('the max relative speed covers anything still in Earth orbit', () => {
  // Twice the surface escape speed. Two objects that could exceed this are not
  // bound to Earth and so are not in the catalog — that is what makes the
  // coarse pass complete rather than merely likely.
  const escape = Math.sqrt((2 * MU) / EARTH_R_KM);
  assert.ok(MAX_REL_SPEED_KMS >= 2 * escape,
            `${MAX_REL_SPEED_KMS} must cover ${(2 * escape).toFixed(2)} km/s`);
});

/* ── The shell sieve ────────────────────────────────────────────────────── */

console.log('\n-- the perigee/apogee shell sieve --');

await test('shells come out as RADII, not the altitudes the catalog stores', () => {
  // GP's APOAPSIS/PERIAPSIS and SATCAT's APOGEE/PERIGEE are altitudes above the
  // surface; mixing the two conventions is a 6378 km error and has already cost
  // this project a debugging round. Deriving from the satrec avoids the field
  // entirely — assert the units so nobody "fixes" it back.
  const s = orbitShell(1.0, 0);
  assert.ok(Math.abs(s.rpKm - EARTH_R_KM) < 1e-6, 'a = 1 Earth radius is r = R, not 0');
  assert.equal(s.rpKm, s.raKm, 'a circular orbit has one radius');
});

await test('eccentricity opens the shell symmetrically', () => {
  const s = orbitShell(2, 0.25);
  assert.ok(Math.abs(s.rpKm - 2 * EARTH_R_KM * 0.75) < 1e-9);
  assert.ok(Math.abs(s.raKm - 2 * EARTH_R_KM * 1.25) < 1e-9);
});

await test('a diverged satrec yields an unusable shell rather than a wrong one', () => {
  assert.equal(shellValid(orbitShell(NaN, 0)), false);
  assert.equal(shellValid(orbitShell(-1, 0)), false);
  assert.equal(shellValid(null), false);
  assert.equal(shellValid(orbitShell(1.05, 0.001)), true);
});

await test('non-overlapping shells are excluded, overlapping ones kept', () => {
  const leo = { rpKm: 6700, raKm: 6900 };
  const geo = { rpKm: 42000, raKm: 42200 };
  const gto = { rpKm: 6600, raKm: 42100 };   // crosses both
  assert.equal(shellsOverlap(leo, geo, 178), false);
  assert.equal(shellsOverlap(leo, gto, 178), true);
  assert.equal(shellsOverlap(gto, geo, 178), true);
  assert.equal(shellsOverlap(leo, leo, 178), true);
});

await test('the sieve is inclusive at exactly one gate of separation', () => {
  const a = { rpKm: 7000, raKm: 7000 };
  const b = { rpKm: 7178, raKm: 7178 };      // 178 km above — exactly the gate
  assert.equal(shellsOverlap(a, b, 178), true,  'must not drop a pair at the boundary');
  assert.equal(shellsOverlap(a, { rpKm: 7179, raKm: 7179 }, 178), false);
});

await test('buildPairs emits each pair once, in flat index order', () => {
  const shells = [{ rpKm: 7000, raKm: 7000 }, { rpKm: 7010, raKm: 7010 },
                  { rpKm: 42000, raKm: 42000 }];
  const pairs = buildPairs(shells, 178);
  assert.equal(pairs.length, 2, 'only the two LEO objects pair');
  assert.deepEqual([...pairs], [0, 1]);
});

/* ── The TCA solve ──────────────────────────────────────────────────────── */

console.log('\n-- linear TCA --');

await test('a head-on pair solves to the exact crossing', () => {
  // A at -100 km closing at +5 km/s, B at +100 km closing at -5 km/s: they meet
  // at the origin in 20 s with a miss of zero.
  const st = Float64Array.from([-100, 0, 0, 5, 0, 0,
                                  100, 0, 0, -5, 0, 0]);
  const out = linearTca(st, 0, 6, {});
  assert.ok(Math.abs(out.tauSec - 20) < 1e-9, `tau ${out.tauSec}`);
  assert.ok(out.missKm < 1e-9, `miss ${out.missKm}`);
  assert.ok(Math.abs(out.relSpeedKms - 10) < 1e-9);
});

await test('an offset pass reports the perpendicular offset, not the range', () => {
  // Same closing geometry, offset 3 km in z: the miss is 3, not the 100 km the
  // sample sees. Reporting the sample separation is the failure this catches.
  const st = Float64Array.from([-100, 0, 3, 5, 0, 0,
                                  100, 0, 0, -5, 0, 0]);
  const out = linearTca(st, 0, 6, {});
  assert.ok(Math.abs(out.missKm - 3) < 1e-9, `miss ${out.missKm}`);
  assert.ok(separationKm(st, 0, 6) > 100, 'the instantaneous range is much larger');
});

await test('co-moving objects give tau = 0 rather than a division by zero', () => {
  const st = Float64Array.from([0, 0, 0, 7, 0, 0,
                                4, 0, 0, 7, 0, 0]);
  const out = linearTca(st, 0, 6, {});
  assert.equal(out.tauSec, 0);
  assert.ok(Math.abs(out.missKm - 4) < 1e-12);
  assert.equal(out.relSpeedKms, 0);
});

/* ── The screen, against closed-form geometry ───────────────────────────── */

console.log('\n-- the screen against orbits whose answer is known --');

await test('a 15 km/s crossing is found, with the right miss and the right time', () => {
  const TCA_SEC = 907.5;      // deliberately BETWEEN coarse samples (see below)
  const MISS_KM = 2;
  const orbits = crossingPair(6800, MISS_KM, TCA_SEC);
  const { sample } = propagatorFor(orbits);

  const screen = createScreen({
    shells: orbits.map(o => o.shell),
    thresholdKm: 10, stepSec: 15, windowSec: 1800, t0Ms: T0, sample,
  });
  const rows = runToCompletion(screen);

  // Tolerances are a millimetre and a millisecond because that is what the two
  // refinement passes actually deliver here. A single pass reports the geometry
  // at the coarse SAMPLE instead, which is ~115 km out — loose tolerances would
  // let that regression through, so they are set just above the real error.
  assert.equal(rows.length, 1, `expected one conjunction, got ${rows.length}`);
  assert.ok(Math.abs(rows[0].missKm - MISS_KM) < 1e-6,
            `miss ${rows[0].missKm} km, expected ${MISS_KM}`);
  assert.ok(Math.abs(rows[0].tcaMs - (T0 + TCA_SEC * 1000)) < 1,
            `tca off by ${rows[0].tcaMs - (T0 + TCA_SEC * 1000)} ms`);
  assert.ok(rows[0].relSpeedKms > 14, `closing at ${rows[0].relSpeedKms} km/s`);
});

await test('the coarse march cannot step over one — TCA exactly mid-step', () => {
  // The adversarial case for a sampled search: the true minimum sits as far from
  // every coarse sample as it can, so the screen only ever SEES the pair ~115 km
  // apart. If the gate were tuned rather than derived, this is what would be
  // missed, and it would look like an empty result rather than a bug.
  const step = 15;
  for (const offset of [0, step / 2, step / 4]) {
    const tca = 600 + offset;
    const orbits = crossingPair(6800, 1.5, tca);
    const { sample } = propagatorFor(orbits);
    const rows = runToCompletion(createScreen({
      shells: orbits.map(o => o.shell),
      thresholdKm: 10, stepSec: step, windowSec: 1200, t0Ms: T0, sample,
    }));
    assert.equal(rows.length, 1, `offset ${offset}s: missed the conjunction`);
    assert.ok(Math.abs(rows[0].missKm - 1.5) < 1e-6,
              `offset ${offset}s: miss ${rows[0].missKm}`);
  }
});

await test('the threshold decides what is reported, and the gate is not it', () => {
  // A 12 km miss is inside the ~178 km gate at every nearby sample, so it is
  // refined either way — but it must only be REPORTED at the wider threshold.
  const orbits = crossingPair(6800, 12, 900);
  for (const [thresholdKm, expected] of [[10, 0], [25, 1]]) {
    const { sample } = propagatorFor(orbits);
    const rows = runToCompletion(createScreen({
      shells: orbits.map(o => o.shell),
      thresholdKm, stepSec: 15, windowSec: 1800, t0Ms: T0, sample,
    }));
    assert.equal(rows.length, expected, `threshold ${thresholdKm} km`);
  }
});

await test('a co-orbiting pair is one row at its constant separation', () => {
  // Same orbit, 0.02 rad apart: the separation is 2r·sin(Δθ/2) and never
  // changes, so the pair trips the gate at all 121 coarse samples. One row.
  const dTheta = 0.02;
  const orbits = [circular(6800, 0, +1), circular(6800, dTheta, +1)];
  const { sample } = propagatorFor(orbits);
  const rows = runToCompletion(createScreen({
    shells: orbits.map(o => o.shell),
    thresholdKm: 200, stepSec: 15, windowSec: 1800, t0Ms: T0, sample,
  }));
  const expected = 2 * 6800 * Math.sin(dTheta / 2);
  assert.equal(rows.length, 1, `${rows.length} rows for one physical pair`);
  assert.ok(Math.abs(rows[0].missKm - expected) < 1e-6,
            `miss ${rows[0].missKm}, expected ${expected}`);
});

await test('the closest approach wins, not the first one found', () => {
  // Two crossings in one window: the screen must report the tighter one.
  const orbits = crossingPair(6800, 3, 300);
  const { sample } = propagatorFor(orbits);
  // A counter-rotating pair re-crosses every half synodic period, so a long
  // window contains many crossings — all at the same 3 km by construction.
  const rows = runToCompletion(createScreen({
    shells: orbits.map(o => o.shell),
    thresholdKm: 10, stepSec: 15, windowSec: 7200, t0Ms: T0, sample,
  }));
  assert.equal(rows.length, 1, 'still one pair, however many crossings');
  assert.ok(Math.abs(rows[0].missKm - 3) < 1e-6, `miss ${rows[0].missKm}`);
});

await test('every reported miss is backed by propagation, not extrapolation', () => {
  // The guard on the linear model. τ = −(Δr·Δv)/|Δv|² blows up as |Δv| → 0, and
  // a near-co-orbiting pair (one constellation plane, one launch's debris) has
  // exactly that geometry: two objects at slightly different radii drifting past
  // each other. Here the unconstrained solution sits ~800 s away — far outside
  // the bracket where straight-line relative motion holds, and potentially
  // outside the screening window altogether.
  //
  // So the assertion is not on a magic number: it is that for EVERY row, the
  // reported miss equals the separation an independent propagation finds at the
  // reported TCA. That is what "backed by propagation" means, and an unclamped
  // τ cannot satisfy it.
  const a = circular(6800, 0, +1);
  const b = circular(6802, 0.01, +1);
  const orbits = [a, b];
  const { sample } = propagatorFor(orbits);
  const screen = createScreen({
    shells: orbits.map(o => o.shell),
    thresholdKm: 100, stepSec: 15, windowSec: 3600, t0Ms: T0, sample,
  });
  const rows = runToCompletion(screen);
  assert.ok(rows.length > 0, 'the drifting pair should be reported at all');

  const st = new Float64Array(12);
  for (const r of rows) {
    assert.ok(r.tcaMs >= T0 - 15000 && r.tcaMs <= T0 + 3600000 + 15000,
              `TCA ${(r.tcaMs - T0) / 1000}s escaped the window`);
    sample(r.a, r.tcaMs, st, 0);
    sample(r.b, r.tcaMs, st, 6);
    const actual = separationKm(st, 0, 6);
    assert.ok(Math.abs(actual - r.missKm) < 1e-6,
              `reported ${r.missKm} km but propagation says ${actual} km`);
  }
});

await test('sieved-out objects are never propagated at all', () => {
  // The sieve exists to remove work, so assert the work is actually removed:
  // a LEO/GEO pair must cost zero sample() calls, not merely zero results.
  const orbits = [circular(6800, 0, +1), circular(42164, 1, +1)];
  const { sample, calls } = propagatorFor(orbits);
  const screen = createScreen({
    shells: orbits.map(o => o.shell),
    thresholdKm: 10, stepSec: 15, windowSec: 3600, t0Ms: T0, sample,
  });
  const rows = runToCompletion(screen);
  assert.equal(rows.length, 0);
  assert.equal(calls.n, 0, `${calls.n} propagations for a pair that cannot meet`);
  assert.equal(screen.stats().objectsScreened, 0);
  assert.equal(screen.stats().pairsScreened, 0);
});

await test('a propagator with no solution is skipped, not thrown on', () => {
  // Decayed objects do this: SGP4 returns no position and that is a real state.
  const orbits = crossingPair(6800, 2, 900);
  const screen = createScreen({
    shells: orbits.map(o => o.shell),
    thresholdKm: 10, stepSec: 15, windowSec: 1800, t0Ms: T0,
    sample: (i, tMs, out, off) => (i === 1 ? false : orbits[i].at((tMs - T0) / 1000, out, off)),
  });
  assert.deepEqual(runToCompletion(screen), []);
});

await test('advance() is resumable in chunks and reports its own progress', () => {
  // The worker drives this in chunks so CANCEL stays responsive; a driver that
  // restarts or double-counts across chunk boundaries would show up here.
  const orbits = crossingPair(6800, 2, 900);
  const { sample } = propagatorFor(orbits);
  const screen = createScreen({
    shells: orbits.map(o => o.shell),
    thresholdKm: 10, stepSec: 15, windowSec: 1800, t0Ms: T0, sample,
  });
  assert.equal(screen.step, 0);
  assert.equal(screen.advance(1), false);
  assert.equal(screen.step, 1);
  let guard = 0;
  while (!screen.advance(7)) { if (++guard > 1000) throw new Error('no termination'); }
  assert.equal(screen.step, screen.totalSteps);
  assert.equal(screen.advance(10), true, 'advancing a finished screen stays finished');
  assert.equal(screen.step, screen.totalSteps, 'and does not march past the window');
  assert.equal(screen.results().length, 1);
  assert.equal(screen.stats().stepsRun, screen.totalSteps);
});

/* ── Cross-file invariants ──────────────────────────────────────────────── */

console.log('\n-- the worker and the page agree with the module --');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

await test('the screening worker imports the shared maths rather than forking it', () => {
  const src = read('public/orbit-engine/screen.worker.js');
  assert.ok(/from ['"]\.\/conjunction\.js['"]/.test(src),
            'screen.worker.js must import ./conjunction.js');
  assert.ok(!/function\s+linearTca/.test(src), 'the TCA solve must not be re-implemented');
});

await test('the worker fails loudly if satellite.js did not reach globalThis', () => {
  // Without the guard this is a SILENT ZERO: every satrec build is caught, every
  // shell is invalid, the sieve yields no pairs, and the panel reports "no
  // approaches" — indistinguishable from a clean screen. Not hypothetical: the
  // same UMD file loaded in Node takes the CommonJS branch and never assigns to
  // globalThis, so the two environments really do differ.
  const src = read('public/orbit-engine/screen.worker.js');
  assert.ok(/typeof satellite === ['"]undefined['"]/.test(src),
            'screen.worker.js must check the global before screening');
  assert.ok(/throw new Error/.test(src), 'and throw rather than screen nothing');
});

await test('the screening worker is constructed as a module worker', () => {
  // It imports an ES module. A classic Worker would fail to construct and the
  // panel would silently report "screening unavailable" forever.
  const src = read('public/orbit-engine/screen-client.js');
  assert.ok(/new Worker\([^)]*type:\s*['"]module['"]/s.test(src),
            "screen-client.js must pass { type: 'module' }");
  assert.ok(/['"]\/orbit-engine\/screen\.worker\.js['"]/.test(src),
            'the worker URL must be absolute — a relative one resolves against the page');
});

await test('the UNOFFICIAL badge is in the markup, not only in the JS', () => {
  // Space-Track's own position is that public TLEs "should not be used for
  // conjunction assessment prediction", and cdm_public is the one class outside
  // USSPACECOM's blanket redistribution approval. The disclaimer is the reason
  // deriving our own screening is acceptable at all, so it ships in the HTML
  // where it cannot be lost to a failed fetch.
  //
  // The multi-page split moved the screener off the catalog page, so the badge
  // lives with the feature it disclaims rather than on /spacetrack/.
  const html = read('public/spacetrack/conjunctions/index.html');
  assert.ok(/UNOFFICIAL/.test(html), 'the badge text must be in the markup');
  // Match on meaning, not on the exact casing/wording of the sentence — the
  // rendered copy is "Do not use for collision avoidance", and an assertion
  // pinned to a verbatim uppercase string fails on a page that is in fact
  // correctly labelled.
  assert.ok(/collision avoidance/i.test(html), 'the full warning must be present');
});

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
