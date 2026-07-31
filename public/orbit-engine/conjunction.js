/**
 * Derived close-approach screening — the maths, with no propagator in it.
 *
 * Plan 33 wave 5. Space-Track publishes CDMs, but `cdm_public` is deliberately
 * absent from USSPACECOM's enumerated basic-SSA set, so it is the one class we
 * do not redistribute (see the plan's *Legal basis*). We derive our own
 * screening instead, and badge it `UNOFFICIAL — NOT FOR COLLISION AVOIDANCE`
 * because that is exactly what it is: SGP4 over public TLEs, which Space-Track
 * itself says "should not be used for conjunction assessment prediction".
 *
 * Nothing here touches satellite.js, Cesium or the DOM. The caller injects a
 * `sample(i, tMs, out, offset)` propagator, so the whole algorithm can be driven
 * in Node against an analytic two-body orbit whose true closest approach is
 * known in closed form — which is what `test/conjunction.test.mjs` does. The
 * browser's propagator lives in `screen.worker.js`.
 *
 * ── Why this is complete rather than best-effort ───────────────────────────
 *
 * The screen marches a coarse step Δt and refines anything inside a gate G.
 * A pair whose true closest approach is d_min is at most Δt/2 away from a
 * coarse sample, so at the nearest sample its separation is at most
 * `d_min + v_rel·Δt/2`. Choose
 *
 *     G = D + MAX_REL_SPEED · Δt / 2
 *
 * and every approach closer than the threshold D is guaranteed to land inside
 * the gate at some coarse sample. `MAX_REL_SPEED_KMS` is twice the surface
 * escape speed, which no two Earth-bound objects can exceed, so the bound holds
 * for the whole catalog rather than for LEO only. That is why `gateKm()` is
 * derived from the step rather than being a tuned constant: change the step and
 * the gate has to move with it or the screen silently starts missing pairs.
 *
 * ── Why there is no spatial broadphase ─────────────────────────────────────
 *
 * The rendered slice is capped at 500 objects, so the worst case is ~125k pairs
 * per step against ~500 SGP4 propagations per step. A grid would optimise the
 * cheap term: the squared-distance test is a handful of flops, an SGP4 call is
 * hundreds. The static shell sieve below removes pairs *once*, before the time
 * loop, which is the part actually worth doing.
 */

/**
 * SGP4's Earth radius (WGS-72), NOT WGS84's 6378.137. `satrec.a` is expressed
 * in these units, so this is the constant that converts it to km. The
 * geodetic→ECEF conversion in propagate.worker.js correctly uses WGS84; the two
 * are different numbers for different jobs and 2 m apart.
 */
export const EARTH_R_KM = 6378.135;

/**
 * The fastest two Earth-bound objects can ever close on each other: twice the
 * surface escape speed (11.18 km/s), the head-on case. Anything above this is
 * on a hyperbolic trajectory and is not in this catalog.
 */
export const MAX_REL_SPEED_KMS = 22.4;

/**
 * Coarse-pass capture radius for a screening threshold and step. See the
 * completeness argument in the file header — this is not a tuning knob.
 */
export function gateKm(thresholdKm, stepSec) {
    return thresholdKm + (MAX_REL_SPEED_KMS * stepSec) / 2;
}

/**
 * The inverse: the largest coarse step a given gate can support without the
 * screen starting to miss approaches. Exists so the relationship is asserted in
 * both directions by the tests rather than living only in a comment.
 */
export function maxStepSec(thresholdKm, gate) {
    return (2 * (gate - thresholdKm)) / MAX_REL_SPEED_KMS;
}

/**
 * Perigee/apogee **radii** in km from a satrec's semi-major axis and
 * eccentricity.
 *
 * Radii, not altitudes. The catalog's `APOGEE`/`PERIGEE` (SATCAT) and
 * `APOAPSIS`/`PERIAPSIS` (GP) are altitudes above the surface — a trap that has
 * already cost this project a debugging round. Deriving the shell from the
 * satrec sidesteps the question entirely and also means screening works for an
 * object with no catalog row at all.
 *
 * @param {number} aEarthRadii `satrec.a`
 * @param {number} ecco `satrec.ecco`
 */
export function orbitShell(aEarthRadii, ecco) {
    const a = aEarthRadii * EARTH_R_KM;
    const e = Math.min(Math.max(ecco, 0), 0.999);
    return { rpKm: a * (1 - e), raKm: a * (1 + e) };
}

/** A shell is usable if SGP4 produced a real orbit rather than a diverged one. */
export function shellValid(shell) {
    return !!shell && Number.isFinite(shell.rpKm) && Number.isFinite(shell.raKm) &&
           shell.rpKm > 0 && shell.raKm >= shell.rpKm;
}

/**
 * Can these two orbits ever come within `gate` of each other?
 *
 * Exact and free: if one object's perigee is more than `gate` above the other's
 * apogee, the radial bands never overlap, so no phasing of the two orbits can
 * bring them close. This removes the overwhelming majority of pairs in a mixed
 * slice (LEO debris against GEO payloads, say) before a single propagation.
 *
 * It is a necessary condition, not a sufficient one — two orbits can share a
 * radial band and never be near each other in space. That is what the coarse
 * march is for.
 */
export function shellsOverlap(a, b, gate) {
    return !(a.rpKm - b.raKm > gate || b.rpKm - a.raKm > gate);
}

/**
 * Every pair worth marching, as a flat [i0, j0, i1, j1, …] Int32Array.
 *
 * Flat and typed because this is read once per coarse step — at 1440 steps a
 * per-pair object would be the allocation that matters.
 */
export function buildPairs(shells, gate) {
    const n = shells.length;
    const out = [];
    for (let i = 0; i < n; i++) {
        const a = shells[i];
        if (!shellValid(a)) continue;
        for (let j = i + 1; j < n; j++) {
            const b = shells[j];
            if (!shellValid(b)) continue;
            if (shellsOverlap(a, b, gate)) out.push(i, j);
        }
    }
    return Int32Array.from(out);
}

/**
 * Time of closest approach from two state vectors, treating the relative motion
 * as straight-line over the seconds involved.
 *
 * With relative position Δr and relative velocity Δv, |Δr + Δv·t|² is a parabola
 * in t, minimised at t = −(Δr·Δv)/|Δv|². Relative acceleration in LEO is of
 * order 1e-5 km/s², so over the ±15 s bracket this is used across, the linear
 * assumption costs well under a metre — far inside the kilometres of error the
 * TLEs themselves carry. Two iterations of this (see `refine` in `createScreen`)
 * converge to the true minimum of the *propagated* separation.
 *
 * Reads both states out of one Float64Array — [x, y, z, vx, vy, vz] at each
 * offset — so a candidate refinement allocates nothing.
 *
 * @param {Float64Array} st
 * @param {number} oa offset of object A's state
 * @param {number} ob offset of object B's state
 * @param {{tauSec:number, missKm:number, relSpeedKms:number}} out scratch, reused
 */
export function linearTca(st, oa, ob, out) {
    const dx = st[oa]     - st[ob];
    const dy = st[oa + 1] - st[ob + 1];
    const dz = st[oa + 2] - st[ob + 2];
    const dvx = st[oa + 3] - st[ob + 3];
    const dvy = st[oa + 4] - st[ob + 4];
    const dvz = st[oa + 5] - st[ob + 5];

    const dv2 = dvx * dvx + dvy * dvy + dvz * dvz;
    // Co-moving to numerical precision (an object screened against itself, or a
    // duplicate elset): the separation is already stationary, so t = 0.
    const tau = dv2 > 0 ? -(dx * dvx + dy * dvy + dz * dvz) / dv2 : 0;

    const mx = dx + dvx * tau;
    const my = dy + dvy * tau;
    const mz = dz + dvz * tau;

    out.tauSec      = tau;
    out.missKm      = Math.sqrt(mx * mx + my * my + mz * mz);
    out.relSpeedKms = Math.sqrt(dv2);
    return out;
}

/**
 * Separation the linear model predicts `tauSec` from now: |Δr + Δv·τ|.
 *
 * Separate from `linearTca` because the caller must be able to evaluate the
 * model at a τ it chose rather than at the unconstrained minimum — see the
 * clamp in `createScreen`'s `refine`, which is a correctness guard rather than
 * a tuning detail.
 */
export function missAtTau(st, oa, ob, tauSec) {
    const mx = (st[oa]     - st[ob])     + (st[oa + 3] - st[ob + 3]) * tauSec;
    const my = (st[oa + 1] - st[ob + 1]) + (st[oa + 4] - st[ob + 4]) * tauSec;
    const mz = (st[oa + 2] - st[ob + 2]) + (st[oa + 5] - st[ob + 5]) * tauSec;
    return Math.sqrt(mx * mx + my * my + mz * mz);
}

/** Squared instantaneous separation between two states in the same buffer. */
export function sep2Km(st, oa, ob) {
    const dx = st[oa] - st[ob], dy = st[oa + 1] - st[ob + 1], dz = st[oa + 2] - st[ob + 2];
    return dx * dx + dy * dy + dz * dz;
}

/** Instantaneous separation in km. */
export function separationKm(st, oa, ob) {
    return Math.sqrt(sep2Km(st, oa, ob));
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Build a screening run. Nothing happens until `advance()` is called.
 *
 * Step-wise rather than one blocking call so the worker can yield to its
 * message queue between chunks — that is what makes CANCEL responsive on a run
 * that takes ten seconds. Node tests drive it to completion in a loop, which
 * means the tests exercise the same driver the browser does.
 *
 * @param {object} o
 * @param {Array<{rpKm:number, raKm:number}>} o.shells one per object, index-aligned
 *        with whatever the caller's `sample` understands
 * @param {number} o.thresholdKm report approaches closer than this
 * @param {number} o.stepSec coarse step
 * @param {number} o.windowSec how far ahead of `t0Ms` to screen
 * @param {number} o.t0Ms window start, epoch ms
 * @param {(i:number, tMs:number, out:Float64Array, offset:number) => boolean} o.sample
 *        writes [x, y, z, vx, vy, vz] in km / km·s⁻¹ in a consistent inertial
 *        frame; returns false when the propagator has no solution (decayed
 *        objects do this, and it is a real state rather than an error)
 */
export function createScreen({ shells, thresholdKm, stepSec, windowSec, t0Ms, sample }) {
    const gate  = gateKm(thresholdKm, stepSec);
    const gate2 = gate * gate;
    const pairs = buildPairs(shells, gate);
    const totalSteps = Math.max(1, Math.floor(windowSec / stepSec) + 1);

    // Only objects that survived the sieve in at least one pair are propagated.
    // In a mixed slice this is a large saving; in a single-shell slice (all of
    // one constellation, the interesting case) it is none, which is correct.
    const activeSet = new Set();
    for (let p = 0; p < pairs.length; p++) activeSet.add(pairs[p]);
    const active = Int32Array.from(activeSet).sort();
    // Object index → its row in `states`. A dense array rather than a Map: this
    // is read twice per pair per step, so at the 500-object cap it is a quarter
    // of a million lookups per step and the constant factor is the whole cost.
    const slotOf = new Int32Array(shells.length).fill(-1);
    active.forEach((idx, k) => { slotOf[idx] = k; });

    const states  = new Float64Array(active.length * 6);
    const ok      = new Uint8Array(active.length);
    const scratch = new Float64Array(12);
    const tca     = { tauSec: 0, missKm: 0, relSpeedKms: 0 };

    /** pair key → best (closest) approach seen so far for that pair */
    const best = new Map();

    let step = 0;
    let refinements = 0;

    /**
     * Turn a coarse hit into an actual closest approach.
     *
     * Two passes: the first jumps from the coarse sample to the linear TCA, the
     * second re-propagates there and reads off the minimum.
     *
     * **τ is clamped to one step, and the reported miss is evaluated at the
     * CLAMPED τ — not at the unconstrained minimum.** This is a correctness
     * guard, not a tuning detail. The straight-line model is only trustworthy
     * inside the ±Δt bracket the completeness argument covers, where relative
     * acceleration is negligible. But τ = −(Δr·Δv)/|Δv|² blows up as |Δv| → 0,
     * and a near-co-orbiting pair — two objects in one constellation plane, or
     * one launch's debris — has exactly that geometry: a nearly flat parabola
     * whose unconstrained minimum can sit thousands of seconds away, long after
     * the orbits have curved and |Δr + Δv·t| has stopped meaning anything.
     * Reporting that number would invent close approaches that never happen,
     * with a time that can fall outside the screening window entirely.
     *
     * Clamping costs nothing on a real crossing (τ there is a fraction of a
     * step) and completeness is unaffected: the march visits every step, so a
     * true minimum is still found from whichever sample is nearest to it.
     */
    function refine(i, j, tMs) {
        let t = tMs;
        let result = null;
        for (let pass = 0; pass < 2; pass++) {
            if (!sample(i, t, scratch, 0) || !sample(j, t, scratch, 6)) return null;
            linearTca(scratch, 0, 6, tca);
            const tau = clamp(tca.tauSec, -stepSec, stepSec);
            result = {
                tcaMs:       t + tau * 1000,
                missKm:      missAtTau(scratch, 0, 6, tau),
                relSpeedKms: tca.relSpeedKms,
            };
            t = result.tcaMs;
        }
        const clampedMs = clamp(result.tcaMs, tMs - stepSec * 1000, tMs + stepSec * 1000);
        if (clampedMs !== result.tcaMs) {
            if (!sample(i, clampedMs, scratch, 0) || !sample(j, clampedMs, scratch, 6)) return null;
            result.tcaMs  = clampedMs;
            result.missKm = separationKm(scratch, 0, 6);
        }
        refinements++;
        return result;
    }

    return {
        totalSteps,
        pairCount:   pairs.length / 2,
        objectCount: active.length,
        gateKm:      gate,
        get step() { return step; },

        /** @returns {boolean} true once the whole window has been marched */
        advance(maxSteps = 1) {
            const until = Math.min(step + maxSteps, totalSteps);
            for (; step < until; step++) {
                const t = t0Ms + step * stepSec * 1000;

                for (let k = 0; k < active.length; k++) {
                    ok[k] = sample(active[k], t, states, k * 6) ? 1 : 0;
                }

                for (let p = 0; p < pairs.length; p += 2) {
                    const i = pairs[p], j = pairs[p + 1];
                    const ka = slotOf[i], kb = slotOf[j];
                    if (!ok[ka] || !ok[kb]) continue;
                    // Squared, so the inner loop over ~125k pairs per step never
                    // pays for a sqrt it is going to throw away.
                    if (sep2Km(states, ka * 6, kb * 6) > gate2) continue;

                    const r = refine(i, j, t);
                    if (!r || r.missKm > thresholdKm) continue;

                    // One row per pair: the closest approach in the window, not
                    // the first one found. A pair in a co-planar train trips the
                    // gate at nearly every step.
                    const key  = i * shells.length + j;
                    const prev = best.get(key);
                    if (!prev || r.missKm < prev.missKm) {
                        best.set(key, { a: i, b: j, ...r });
                    }
                }
            }
            return step >= totalSteps;
        },

        /** Closest first. */
        results() {
            return [...best.values()].sort((x, y) => x.missKm - y.missKm);
        },

        stats() {
            return {
                objectsScreened: active.length,
                pairsScreened:   pairs.length / 2,
                stepsRun:        step,
                totalSteps,
                refinements,
                gateKm:          gate,
                thresholdKm,
                stepSec,
                windowSec,
            };
        },
    };
}
