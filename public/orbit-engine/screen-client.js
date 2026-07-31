/**
 * Main-thread half of the derived close-approach screen (plan 33 wave 5).
 *
 * Owns `screen.worker.js`: constructs it lazily on the first run so a visitor
 * who never opens the panel never pays for it, keeps one run in flight, and
 * turns the worker's message protocol into a promise plus a progress callback.
 *
 * Lives in `/orbit-engine/` rather than `/spacetrack/` for the reason the whole
 * directory exists: `/orbit/` should be able to adopt this without a second
 * copy appearing. Nothing in here knows about Cesium or the catalog schema —
 * the caller hands over `{norad, name, type, l1, l2}` and gets rows back.
 *
 * **There is no synchronous fallback, unlike the propagation worker.** That one
 * falls back because a tick is a few hundred propagations and a slow globe still
 * works. A screen is hundreds of thousands, so a main-thread fallback would lock
 * the page for ten seconds with no way to interrupt it. Declining and saying so
 * is the honest failure; `available` reports which case the caller is in.
 */

/** Screening presets. Grouped here because window and step are not independent —
 *  see the completeness argument in conjunction.js. */
export const SCREEN_WINDOWS = [
    { label: '30 min', sec:  30 * 60 },
    { label: '2 h',    sec: 120 * 60 },
    { label: '6 h',    sec: 360 * 60 },
];

export const SCREEN_THRESHOLDS_KM = [1, 5, 10, 25];

/**
 * Coarse step, seconds.
 *
 * Fixed at 15 s so the gate stays around 200 km even at the widest threshold —
 * `gateKm(25, 15)` is 193 km. Raising it would grow the gate linearly and the
 * candidate count with it; lowering it buys nothing, because completeness is
 * already guaranteed rather than approximate.
 */
export const SCREEN_STEP_SEC = 15;

export class ConjunctionScreener {
    /**
     * @param {string} [workerUrl] absolute for the same reason the propagation
     *        worker's is: a relative worker URL resolves against the *page*, and
     *        this engine is loaded from pages at two different depths.
     */
    constructor(workerUrl = '/orbit-engine/screen.worker.js') {
        this.workerUrl = workerUrl;
        this.worker    = null;
        this.available = true;    // until a construction attempt says otherwise
        this._job      = 0;
        this._pending  = null;    // {job, resolve, reject, onProgress}
    }

    /** @returns {boolean} false when this browser gave us no worker. */
    _ensureWorker() {
        if (this.worker) return true;
        if (!this.available) return false;
        try {
            this.worker = new Worker(this.workerUrl, { type: 'module' });
        } catch (err) {
            console.warn('[screen] conjunction worker unavailable — screening disabled:', err);
            this.available = false;
            return false;
        }
        this.worker.onerror = (e) => {
            // A module worker that fails to parse or import reports here and
            // never delivers `ready`, so this is the only signal we get.
            console.warn('[screen] conjunction worker errored — screening disabled:', e.message || e);
            this._settle(new Error('screening worker failed'));
            this.available = false;
            try { this.worker.terminate(); } catch (_) { /* already gone */ }
            this.worker = null;
        };
        this.worker.onmessage = (e) => this._onMessage(e.data);
        return true;
    }

    _settle(err, value) {
        const p = this._pending;
        if (!p) return;
        this._pending = null;
        if (err) p.reject(err); else p.resolve(value);
    }

    _onMessage(m) {
        if (m.type === 'ready') return;
        // Late messages from a superseded run must not resolve the current one.
        if (!this._pending || m.job !== this._pending.job) return;

        if (m.type === 'screen-progress') {
            if (this._pending.onProgress) this._pending.onProgress(m.step, m.totalSteps);
            return;
        }
        if (m.type === 'screen-done')      this._settle(null, { rows: m.rows, stats: m.stats });
        if (m.type === 'screen-cancelled') this._settle(new Error('cancelled'));
    }

    /**
     * Screen a set of objects for close approaches.
     *
     * Objects without both TLE lines are dropped here rather than in the worker,
     * so the count the caller reports is the count actually screened. That is a
     * real state — SATCAT can list an object before a public elset exists.
     *
     * @param {Array<{norad:number, name:string, type:string, l1:string, l2:string}>} objects
     * @param {{thresholdKm:number, windowSec:number, t0Ms:number, stepSec?:number}} opts
     * @param {(step:number, total:number) => void} [onProgress]
     * @returns {Promise<{rows:Array, stats:object}>}
     */
    run(objects, opts, onProgress) {
        if (!this._ensureWorker()) {
            return Promise.reject(new Error('screening needs a Web Worker'));
        }
        // A second run supersedes the first: the worker drops the old one, and
        // the job check in _onMessage means its trailing messages are ignored.
        this._settle(new Error('superseded'));

        const usable = objects.filter(o => o && o.l1 && o.l2);
        const job = ++this._job;
        const promise = new Promise((resolve, reject) => {
            this._pending = { job, resolve, reject, onProgress };
        });

        this.worker.postMessage({
            type: 'screen',
            job,
            objects: usable.map(o => ({
                norad: o.norad, name: o.name, type: o.type, l1: o.l1, l2: o.l2,
            })),
            opts: {
                thresholdKm: opts.thresholdKm,
                windowSec:   opts.windowSec,
                t0Ms:        opts.t0Ms,
                stepSec:     opts.stepSec || SCREEN_STEP_SEC,
            },
        });
        return promise;
    }

    /** No-op when nothing is running. */
    cancel() {
        if (!this.worker || !this._pending) return;
        this.worker.postMessage({ type: 'screen-cancel', job: this._pending.job });
    }

    get running() { return !!this._pending; }

    destroy() {
        this._settle(new Error('destroyed'));
        if (this.worker) { this.worker.terminate(); this.worker = null; }
    }
}
