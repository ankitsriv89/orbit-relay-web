/**
 * Derived close-approach screening — the worker.
 *
 * Plan 33 wave 5. Separate from propagate.worker.js on purpose. That worker is
 * on the render critical path: a tick every 280 ms is what keeps the globe
 * moving, and a screening run is seconds of solid SGP4. Sharing one worker
 * would have meant either stalling the globe or chunking the screen finely
 * enough to interleave with ticks — a second thread costs one extra
 * `twoline2satrec` per object (microseconds) and removes the question.
 *
 * This is a **module** worker, unlike propagate.worker.js. It needs
 * `conjunction.js`, which is an ES module because the pure maths in it is unit
 * tested in Node against an analytic orbit. `importScripts` cannot load an ES
 * module, and duplicating the maths into a classic script so the worker could
 * have its own copy is precisely the forking mistake plan 33 exists to stop.
 *
 * Note the difference from the `new Worker()` trap recorded for wave 3: a
 * relative *worker URL* resolves against the page, but a relative *import
 * specifier* resolves against the importing module. `./conjunction.js` below is
 * therefore always `/orbit-engine/conjunction.js`, whichever page constructed
 * this worker.
 *
 * satellite.min.js is UMD: with no `module` and no `define` it assigns to
 * `globalThis.satellite`, which works the same inside a module worker as it does
 * from a `<script>` tag.
 */

import './vendor/satellite.min.js';
import { createScreen, orbitShell } from './conjunction.js';

/**
 * Coarse steps per macrotask. Small enough that a CANCEL message is acted on
 * within a few tens of milliseconds, large enough that the setTimeout overhead
 * is noise against the ~500 propagations each step costs.
 */
const CHUNK_STEPS = 8;

/** Rows returned to the page. The rest of the run is summarised in `stats`. */
const MAX_RESULTS = 60;

/** Julian date of the Unix epoch — for turning `satrec.jdsatepoch` into an age. */
const JD_UNIX_EPOCH = 2440587.5;

let current = null;   // the one in-flight run; a new screen supersedes it

function buildSatrec(l1, l2) {
    try {
        const rec = satellite.twoline2satrec(l1, l2);
        return (rec && !rec.error) ? rec : null;
    } catch (_) {
        return null;
    }
}

/**
 * Age of an elset at `tMs`, in days.
 *
 * Surfaced per result rather than kept internal: SGP4 on a public TLE drifts by
 * kilometres within days, so a 2 km miss between two week-old elsets is not a
 * meaningfully different number from a 6 km one. Showing the age is what makes
 * the UNOFFICIAL badge a statement the visitor can actually check rather than
 * boilerplate.
 */
function epochAgeDays(satrec, tMs) {
    const jdNow = tMs / 86400000 + JD_UNIX_EPOCH;
    return jdNow - (satrec.jdsatepoch + (satrec.jdsatepochF || 0));
}

function runScreen(job, objects, opts) {
    // If the UMD import did not land on globalThis, every buildSatrec() below
    // would be caught, every shell would be invalid, the sieve would produce no
    // pairs, and the panel would report "no approaches" — a silent zero that
    // looks exactly like a clean result. Fail loudly instead. (This is real:
    // the same file loaded in Node takes the CommonJS branch and never touches
    // globalThis, so the two environments genuinely differ.)
    if (typeof satellite === 'undefined' || !satellite.twoline2satrec) {
        throw new Error('satellite.js did not load in the screening worker');
    }

    const satrecs = objects.map(o => buildSatrec(o.l1, o.l2));
    const shells  = satrecs.map(rec => (rec ? orbitShell(rec.a, rec.ecco) : null));

    // A scratch Date per sample would allocate once per object per step — 720k
    // of them on a six-hour window.
    const when = new Date(0);

    const sample = (i, tMs, out, offset) => {
        const rec = satrecs[i];
        if (!rec) return false;
        when.setTime(tMs);
        let pv;
        try { pv = satellite.propagate(rec, when); } catch (_) { return false; }
        if (!pv || !pv.position || !pv.velocity) return false;
        // TEME km / km·s⁻¹ straight out of SGP4. Screening happens in this
        // inertial frame deliberately: the ECEF the render tick uses would give
        // the same separations (a rotation preserves distance) but the wrong
        // relative VELOCITY, which is what the TCA solve turns on.
        const p = pv.position, v = pv.velocity;
        if (!Number.isFinite(p.x) || !Number.isFinite(v.x)) return false;
        out[offset]     = p.x;  out[offset + 1] = p.y;  out[offset + 2] = p.z;
        out[offset + 3] = v.x;  out[offset + 4] = v.y;  out[offset + 5] = v.z;
        return true;
    };

    const screen = createScreen({
        shells:      shells.map(s => s || { rpKm: NaN, raKm: NaN }),
        thresholdKm: opts.thresholdKm,
        stepSec:     opts.stepSec,
        windowSec:   opts.windowSec,
        t0Ms:        opts.t0Ms,
        sample,
    });

    const startedAt = Date.now();
    current = { job, cancelled: false };

    const pump = () => {
        if (!current || current.job !== job || current.cancelled) return;
        const done = screen.advance(CHUNK_STEPS);
        if (!done) {
            postMessage({ type: 'screen-progress', job,
                          step: screen.step, totalSteps: screen.totalSteps });
            setTimeout(pump, 0);
            return;
        }

        const found = screen.results();
        const rows = found.slice(0, MAX_RESULTS).map(r => {
            const A = objects[r.a], B = objects[r.b];
            return {
                a: { norad: A.norad, name: A.name, type: A.type,
                     epochAgeDays: satrecs[r.a] ? epochAgeDays(satrecs[r.a], r.tcaMs) : null },
                b: { norad: B.norad, name: B.name, type: B.type,
                     epochAgeDays: satrecs[r.b] ? epochAgeDays(satrecs[r.b], r.tcaMs) : null },
                missKm:      r.missKm,
                tcaMs:       r.tcaMs,
                relSpeedKms: r.relSpeedKms,
            };
        });

        const stats = screen.stats();
        stats.elapsedMs = Date.now() - startedAt;
        stats.found     = found.length;
        stats.shown     = rows.length;
        stats.noElset   = satrecs.filter(r => !r).length;
        current = null;
        postMessage({ type: 'screen-done', job, rows, stats });
    };

    // First chunk goes through setTimeout too, so a screen posted immediately
    // before a cancel is still cancellable.
    setTimeout(pump, 0);
}

onmessage = (e) => {
    const m = e.data;
    if (m.type === 'screen') {
        if (current) current.cancelled = true;   // a new run supersedes the old
        runScreen(m.job, m.objects, m.opts);
        return;
    }
    if (m.type === 'screen-cancel') {
        if (current && (m.job == null || current.job === m.job)) {
            current.cancelled = true;
            postMessage({ type: 'screen-cancelled', job: current.job });
            current = null;
        }
    }
};

postMessage({ type: 'ready' });
