/**
 * The satellite rendering + propagation engine.
 *
 * Extracted from orbital-relay.js in plan 33 wave 3 so `/orbit/` (the cinematic
 * Celestrak view) and `/spacetrack/` (the catalog) run the same code. This is
 * the part that has already been fixed twice in two copies — the
 * marsapiens/standalone divergence that opened plan 33 — and a fork inside one
 * repo would be that mistake at closer range.
 *
 * Two things define it:
 *
 * **Points, not Entities.** Every tracked satellite is a PointPrimitive inside
 * ONE shared PointPrimitiveCollection. Entities carry a heavy property-bag and
 * change-event wrapper each; at 600+ sats that structural overhead is the bulk
 * of the page's retained memory (the 1.2 GB blowup fixed as marsapiens #71).
 * A PointPrimitiveCollection stores points in packed typed arrays.
 *
 * **A throttled tick, in a worker.** Positions are NOT per-frame
 * CallbackProperties, which would re-run SGP4 for every sat every frame —
 * ~36k propagations/sec at 600 sats × 60fps. A tick a few times a second
 * re-propagates the *visible* set off the Cesium clock and writes each point's
 * position in place; a sat moves metres in that time, so it is visually
 * identical. That tick runs in propagate.worker.js and comes back as one
 * transferable Float32Array which is handed straight back for reuse, so a
 * steady tick allocates nothing on either side.
 *
 * The worker is an optimisation, never a dependency: if it fails to construct
 * or errors at runtime it is dropped and every path falls back to the
 * synchronous implementation. The E2E suite kills it deliberately.
 */

import {
    geoAt, orbitalPeriodMin, footprintRadiusM,
} from './astro.js';

const SAT_TICK_MS   = 280;   // position refresh (a sat moves ~metres in this time)
// The pulse rides the position cadence on purpose. At 90 ms it forced a full
// render ~11×/s forever while any pulsing layer was visible — a standing GPU
// bill that quietly defeated requestRenderMode. The sine's period is seconds,
// so at 280 ms the wobble still reads smooth and each step is a real change.
const PULSE_TICK_MS = SAT_TICK_MS;

/**
 * Put the Cesium viewer on a mobile power budget. Call once, right after
 * constructing the Viewer and before creating a SatEngine.
 *
 * ── Rendering on demand ────────────────────────────────────────────────────
 *
 * By default Cesium re-renders every animation frame whether or not anything
 * changed — 60 fps of full-globe drawing to show a scene that only moves when a
 * satellite tick lands or the camera does. `requestRenderMode` flips that
 * around: nothing is drawn until something asks. Cesium itself asks on camera
 * motion, tile loads and input; SatEngine asks whenever it writes new positions.
 * The tick is 280 ms, so a still camera renders ~4 fps instead of 60.
 *
 * This is only safe because every path that changes the scene requests a frame.
 * If you add one that does not, the globe will look frozen — call
 * `engine.requestRender()` from it.
 *
 * `maximumRenderTimeChange` is the backstop: it forces a frame when the
 * simulation clock has moved that far regardless of who asked, so the day/night
 * terminator and the sun position keep up even on a page with no satellites.
 *
 * ── Resolution ─────────────────────────────────────────────────────────────
 *
 * `useBrowserRecommendedResolution` is pinned rather than left to the default.
 * Measured at devicePixelRatio 3, Cesium already draws a 375×812 CSS canvas at
 * 375×812 device pixels — the ratio is 1.0, not 3.0, so there is no 9× pixel
 * bill to fix here. Pinning it is a guard, not a fix: flipping it to false (or a
 * future default change) would silently triple the fragment cost on every phone.
 *
 * The real saving available is drawing *below* CSS resolution on small screens,
 * which is what `resolutionScale` does. 0.85 is a deliberate compromise: on a
 * ~5" screen the softening is not perceptible at arm's length, and it removes
 * ~28% of the fragment work on the device least able to afford it.
 */
export function tuneViewerForDevice(viewer, { mobileMaxWidth = 600 } = {}) {
    const scene = viewer.scene;

    scene.requestRenderMode         = true;
    scene.maximumRenderTimeChange   = 30;    // seconds of simulation time
    viewer.useBrowserRecommendedResolution = true;

    const isSmall = window.matchMedia(`(max-width: ${mobileMaxWidth}px)`).matches;
    viewer.resolutionScale = isSmall ? 0.85 : 1.0;

    tuneCameraLimits(viewer);

    return viewer;
}

/**
 * Clamp how far the camera can pull out.
 *
 * Cesium's default `maximumZoomDistance` is unbounded, so a fast trackpad/
 * scroll-wheel flick (or a pinch on mobile) can push the globe past the far
 * clipping plane or shrink it to a few pixels off-center — it reads as "the
 * globe fell out of the screen." GEO altitude is ~35,786 km; 110,000 km is
 * >3x that, so geostationary shells (and everything below) stay comfortably
 * in frame at every viewport size while still capping the runaway zoom-out.
 * `minimumZoomDistance` stops the inverse case — zooming inside the globe
 * and clipping through the surface.
 */
function tuneCameraLimits(viewer) {
    const controller = viewer.scene.screenSpaceCameraController;
    controller.minimumZoomDistance = 500;
    controller.maximumZoomDistance = 1.1e8;
    controller.enableInputs = true;
}

/** The same top-down framing every page boots into — see the `setView` calls
 *  in orbital-relay.js / globe.js / starlink.js. Kept here too so `flyHome`
 *  has a default that matches "home" without a caller having to repeat it. */
const HOME_DESTINATION = Cesium.Cartesian3.fromDegrees(20, 25, 40000000);

/**
 * Recenter the globe: fly back to a fixed top-down destination with a level
 * heading/pitch/roll, undoing whatever rotate/tilt/zoom drag left the camera
 * at. This is the "recenter" button's handler, not a drag gesture — dragging
 * a 3D perspective camera to *translate* it has no built-in Cesium support
 * (`translateEventTypes` only applies in 2D/Columbus view), and hand-rolling
 * one would fight the default rotate-drag every page already relies on to
 * look at other longitudes.
 */
export function flyHome(viewer, { destination = HOME_DESTINATION, duration = 1.2 } = {}) {
    viewer.camera.flyTo({
        destination,
        orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
        duration,
    });
}

/**
 * Mounts a live "camera altitude above the surface, in km" readout into
 * `el` and keeps it in sync with `viewer.camera.changed`. Altitude (not
 * range-to-target) is what the zoom clamp above is expressed in, so this
 * is the number that tells a user how close they are to the 110,000 km
 * ceiling — not a range-from-globe-center figure that would read differently.
 */
export function mountCameraAltitudeHud(viewer, el) {
    if (!el) return;
    el.classList.add('cam-alt');

    function render() {
        const carto = viewer.camera.positionCartographic;
        if (!carto) return;
        const km = carto.height / 1000;
        el.textContent = km >= 1000
            ? Math.round(km).toLocaleString() + ' KM'
            : km.toFixed(1) + ' KM';
    }

    render();
    viewer.camera.changed.addEventListener(render);
    viewer.camera.percentageChanged = 0.005; // fire `changed` on small zoom deltas too
    return () => viewer.camera.changed.removeEventListener(render);
}

/**
 * Wraps a PointPrimitive so callers can keep the Entity-era `.show` idiom.
 * Carries the satrec and metadata for the tick and for click-to-inspect.
 */
export class SatPoint {
    constructor(engine, primitive, satrec, meta, baseSize, pulse) {
        this._engine   = engine;
        this.primitive = primitive;
        this.satrec    = satrec;
        this.meta      = meta;
        this.baseSize  = baseSize;
        this.pulse     = pulse;
        this.id        = 0;      // worker registration id (0 = not registered)
        this.ring      = null;   // orbit ring entity, built lazily by ensureRing()
        this._ringStyle = null;  // the orbitStyle arg passed to addSatellite
        this._ringColor = null;
    }
    get show()  { return this.primitive.show; }
    set show(v) {
        // The worker only propagates the visible set, so any show change means
        // that set has to be re-posted.
        if (this.primitive.show !== v) this._engine.visDirty = true;
        this.primitive.show = v;
    }
}

export class SatEngine {
    /**
     * @param {object} o
     * @param {Cesium.Viewer} o.viewer
     * @param {string} [o.workerUrl] absolute, because the two pages that use
     *        this engine sit at different depths — a relative worker URL
     *        resolves against the *page*, so /spacetrack/ would look for
     *        /spacetrack/propagate.worker.js and silently fall back to the
     *        synchronous path.
     */
    constructor({ viewer, workerUrl = '/orbit-engine/propagate.worker.js' }) {
        this.viewer = viewer;
        this.clock  = viewer.clock;
        this.satCollection = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());

        /** @type {SatPoint[]} every sat, for the shared tick + pulse loops */
        this.allSats = [];
        /** @type {SatPoint[]} subset that pulse — avoids scanning allSats at 11fps */
        this.pulseSats = [];

        this.worker      = null;
        this.workerReady = false;
        this.visDirty    = true;      // visible set changed since last posted
        this.tickInFlight = false;
        this.tickCount   = 0;         // completed ticks — lets tests sync on the worker

        this._nextSatId  = 1;
        this._satById    = new Map();
        this._regIds     = [];        // registrations batched until the next tick
        this._regTles    = [];
        this._pathJobs   = new Map();
        this._nextPathJob = 1;
        this._intervals  = [];
        /** Entities the page added via addManagedEntity — removed on destroy() */
        this._managedEntities = [];
        this._posScratch = new Cesium.Cartesian3();
        this._geoScratch = { lat: 0, lon: 0, alt: 0 };

        try {
            this.worker = new Worker(workerUrl);
        } catch (err) {
            console.warn('[sat-engine] propagation worker unavailable — SGP4 stays on the main thread:', err);
        }
        if (this.worker) this._wireWorker();

        this._intervals.push(setInterval(() => this.propagate(),  SAT_TICK_MS));
        this._intervals.push(setInterval(() => this._pulse(),     PULSE_TICK_MS));
    }

    /* ── Time ───────────────────────────────────────────────────────────── */

    /**
     * Ask for a frame.
     *
     * A no-op unless `tuneViewerForDevice` turned on requestRenderMode, so it is
     * safe to call unconditionally — which matters, because the rule is that
     * EVERY path that changes what the scene looks like calls this. Miss one and
     * the globe appears frozen rather than merely slow.
     */
    requestRender() {
        this.viewer.scene.requestRender();
    }

    /** The single time source for every satellite — so one clock multiplier
     *  drives time-warp with no per-satellite timers. */
    now() {
        return Cesium.JulianDate.toDate(this.clock.currentTime);
    }

    /** Sub-satellite point at the current clock time. Uses a shared scratch
     *  object unless `out` is given — copy values out before the next call. */
    geo(satrec, out) {
        return geoAt(satrec, this.now(), out || this._geoScratch);
    }

    /* ── Worker bridge ──────────────────────────────────────────────────── */

    _wireWorker() {
        this.worker.onerror = (e) => this.disableWorker(e.message || e);
        this.worker.onmessage = (e) => {
            const m = e.data;
            if (m.type === 'ready') { this.workerReady = true; return; }

            if (m.type === 'positions') {
                const { xyz, ids, count } = m;
                for (let i = 0; i < count; i++) {
                    const sat = this._satById.get(ids[i]);
                    if (!sat) continue;
                    sat.primitive.position = Cesium.Cartesian3.fromElements(
                        xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2], this._posScratch);
                }
                this.tickInFlight = false;
                this.tickCount++;
                if (count) this.requestRender();
                // Hand both buffers back so the next tick reuses them.
                this.worker.postMessage({ type: 'recycle', xyz: xyz.buffer, ids: ids.buffer },
                                        [xyz.buffer, ids.buffer]);
                return;
            }

            if (m.type === 'path') {
                const job = this._pathJobs.get(m.job);
                if (!job) return;
                this._pathJobs.delete(m.job);
                job.done(unpackPositions(m.xyz, m.count));
            }
        };
    }

    /**
     * Drop the worker and settle every in-flight path job from its synchronous
     * fallback, so no polyline is left permanently empty.
     */
    disableWorker(why) {
        if (!this.worker) return;
        console.warn('[sat-engine] propagation worker disabled — falling back:', why);
        this.worker.terminate();
        this.worker      = null;
        this.workerReady = false;
        this._pathJobs.forEach(job => job.done(job.fallback()));
        this._pathJobs.clear();
    }

    /**
     * Ask the worker for an orbit ring or ground track. Messages posted before
     * the worker script finishes loading are queued by the browser, so there is
     * no need to wait on `workerReady`.
     */
    requestPath(l1, l2, kind, steps, periodMin, done, fallback) {
        if (!this.worker) { done(fallback()); return; }
        const job = this._nextPathJob++;
        this._pathJobs.set(job, { done, fallback });
        this.worker.postMessage({
            type: 'path', job, l1, l2, kind, steps,
            t0: this.now().getTime(), periodMin,
        });
    }

    /**
     * A CallbackProperty source that never blocks: returns the last computed
     * array immediately and refreshes it in the worker every `ms`. Without this
     * a ground-track callback re-runs 120 propagations on the main thread every
     * refresh — audit finding M-18.
     */
    workerPath(rec, kind, steps, ms) {
        let cache = [], last = -Infinity, pending = false;
        const sync = () => (kind === 'track'
            ? this.computeGroundTrack(rec.satrec, steps)
            : this.computeOrbitPath(rec.satrec, steps));
        return () => {
            const now = performance.now();
            if (!pending && now - last > ms) {
                last = now;
                if (this.worker && rec.l1) {
                    pending = true;
                    this.requestPath(rec.l1, rec.l2, kind, steps, orbitalPeriodMin(rec.satrec),
                                     (pts) => { cache = pts; pending = false; },
                                     () => { pending = false; return sync(); });
                } else {
                    cache = sync();
                }
            }
            // A polyline with <2 points has no geometry; undefined reads as
            // "no value yet" and Cesium simply doesn't draw it.
            return cache.length > 1 ? cache : undefined;
        };
    }

    /* ── Synchronous path fallbacks ─────────────────────────────────────── */

    _samplePath(satrec, steps, heightOf) {
        const period = orbitalPeriodMin(satrec);
        const t0 = this.now().getTime();
        const pts = [];
        for (let i = 0; i <= steps; i++) {
            const t  = new Date(t0 + (i / steps) * period * 60000);
            const g  = geoAt(satrec, t);
            if (!g) continue;
            pts.push(Cesium.Cartesian3.fromDegrees(g.lon, g.lat, heightOf(g)));
        }
        return pts;
    }

    computeOrbitPath(satrec, steps = 90) {
        return this._samplePath(satrec, steps, (g) => g.alt * 1000);
    }

    /** Sub-satellite path clamped to the surface, one full period. */
    computeGroundTrack(satrec, steps = 120) {
        return this._samplePath(satrec, steps, () => 0);
    }

    /* ── Satellites ─────────────────────────────────────────────────────── */

    /**
     * @param {object} satrec
     * @param {Cesium.Color} color
     * @param {number} pointSize
     * @param {false|'bright'|true} orbitStyle draw a static orbit ring
     * @param {object} [meta] {satrec, l1, l2, name, group, pulse}
     * @returns {SatPoint}
     */
    addSatellite(satrec, color, pointSize, orbitStyle, meta) {
        const safeMeta = meta || { satrec, name: 'SAT', group: '' };
        const geo = this.geo(satrec);
        const pos = geo
            ? Cesium.Cartesian3.fromDegrees(geo.lon, geo.lat, geo.alt * 1000)
            : Cesium.Cartesian3.ZERO.clone();

        const primitive = this.satCollection.add({
            position:                 pos,
            pixelSize:                pointSize,
            color:                    color,
            outlineColor:             Cesium.Color.BLACK.withAlpha(0.4),
            outlineWidth:             pointSize > 7 ? 1.5 : 0,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            scaleByDistance:          new Cesium.NearFarScalar(1e6, 1.2, 2e7, 0.6),
            show:                     true,
        });

        const sat = new SatPoint(this, primitive, satrec, safeMeta, pointSize,
                                 !!(meta && meta.pulse));
        primitive.id = sat;          // scene.pick() returns this → click-to-inspect
        this.allSats.push(sat);
        if (sat.pulse) this.pulseSats.push(sat);

        // Orbit rings are deferred, not built here: STATIONS adds ~150 of them
        // for dots that boot hidden, and a hidden ring's per-frame draw cost
        // has no reason to exist until the layer is turned on. Call
        // ensureRing() when the sat becomes visible — see addOrbitRing.
        if (orbitStyle) { sat._ringStyle = orbitStyle; sat._ringColor = color; }

        // Hand the raw TLE lines to the worker; it builds its own satrec.
        // Batched and flushed on the next tick so a 600-sat layer toggle is one
        // message rather than 600.
        if (this.worker && safeMeta.l1) {
            sat.id = this._nextSatId++;
            this._satById.set(sat.id, sat);
            this._regIds.push(sat.id);
            this._regTles.push(safeMeta.l1, safeMeta.l2);
        }
        this.visDirty = true;
        this.requestRender();
        return sat;
    }

    /**
     * Drop a SatPoint's primitive AND its entry in allSats, so the tick stops
     * touching it and it can be collected.
     */
    removeSat(sat) {
        if (!sat) return;
        if (sat.primitive) this.satCollection.remove(sat.primitive);
        if (sat.ring) { this.viewer.entities.remove(sat.ring); sat.ring = null; }
        const i = this.allSats.indexOf(sat);
        if (i !== -1) this.allSats.splice(i, 1);
        if (sat.pulse) {
            const pi = this.pulseSats.indexOf(sat);
            if (pi !== -1) this.pulseSats.splice(pi, 1);
        }
        if (sat.id) {
            this._satById.delete(sat.id);
            if (this.worker) this.worker.postMessage({ type: 'unregister', ids: [sat.id] });
            sat.id = 0;
        }
        this.visDirty = true;
        this.requestRender();
    }

    /* ── The tick ───────────────────────────────────────────────────────── */

    propagate() {
        if (!this.worker) { this.propagateSync(); return; }
        this._flushRegistrations();
        if (this.visDirty) { this._postVisibleSet(); this.visDirty = false; }
        // Skip if the previous tick hasn't come back — under load the worker
        // sets the real cadence and queueing ticks would only build a backlog.
        if (this.tickInFlight) return;
        this.tickInFlight = true;
        this.worker.postMessage({ type: 'tick', t: this.now().getTime() });
    }

    /** The pre-worker synchronous loop. Used when there is no worker, and by
     *  the E2E suite to check the two paths agree. */
    propagateSync() {
        const date = this.now();
        let moved = 0;
        for (let i = 0; i < this.allSats.length; i++) {
            const s = this.allSats[i];
            if (!s.primitive.show) continue;      // skip hidden — the big saving
            const geo = geoAt(s.satrec, date, this._geoScratch);
            if (!geo) continue;
            s.primitive.position = Cesium.Cartesian3.fromDegrees(
                geo.lon, geo.lat, geo.alt * 1000, undefined, this._posScratch);
            moved++;
        }
        if (moved) { this.tickCount++; this.requestRender(); }
    }

    _flushRegistrations() {
        if (!this._regIds.length) return;
        this.worker.postMessage({
            type: 'register', ids: this._regIds.slice(), tles: this._regTles.slice(),
        });
        this._regIds.length  = 0;
        this._regTles.length = 0;
    }

    _postVisibleSet() {
        const n = this.allSats.length;
        const ids = new Uint32Array(n);
        let k = 0;
        for (let i = 0; i < n; i++) {
            const s = this.allSats[i];
            if (s.id && s.primitive.show) ids[k++] = s.id;
        }
        // Only transfer the filled portion — worker uses ids.length as the count.
        const out = k === n ? ids : ids.slice(0, k);
        this.worker.postMessage({ type: 'visible', ids: out }, [out.buffer]);
    }

    _pulse() {
        // rAF is already throttled in background tabs; the gate just stops the
        // interval from forcing renders no one can see.
        if (document.hidden) return;
        const t = Date.now() / 1000;
        let changed = false;
        for (let i = 0; i < this.pulseSats.length; i++) {
            const s = this.pulseSats[i];
            if (!s.primitive.show) continue;
            const next = s.baseSize + Math.sin(t * 2 + i) * (s.baseSize * 0.35);
            // Skip no-op writes (near the sine's extrema) so the render request
            // below is only ever for pixels that actually moved.
            if (Math.abs(next - s.primitive.pixelSize) < 0.02) continue;
            s.primitive.pixelSize = next;
            changed = true;
        }
        if (changed) this.requestRender();
    }

    /* ── Shared visuals ─────────────────────────────────────────────────── */

    /**
     * Build (once) the deferred orbit ring for a SatPoint and return it.
     * Rings are created empty and filled by a worker path job, so calling this
     * never blocks the main thread — see addOrbitRing.
     */
    ensureRing(sat) {
        if (!sat) return null;
        if (sat.ring) {
            // Re-showing after a layer toggle-off: addOrbitRing/place() never
            // touch .show, only .polyline.positions, so a hidden ring stays
            // hidden forever unless this setter restores it.
            sat.ring.show = true;
            return sat.ring;
        }
        if (!sat._ringStyle) return null;
        sat.ring = this.addOrbitRing(sat.satrec, sat.meta, sat._ringColor, sat._ringStyle);
        return sat.ring;
    }

    /**
     * Static orbit ring. The entity is created synchronously with EMPTY
     * positions — a polyline with fewer than 2 points draws nothing — and its
     * points arrive from the worker path job afterwards, so the caller gets a
     * handle whose `.show` works immediately and a load-time batch never
     * blocks the main thread.
     *
     * Glow is reserved for 'bright' rings (the ISS): it is a two-pass,
     * unbatchable material. Dim rings use the plain, batched color material —
     * STATIONS used to ship 150 glow rings always in the scene.
     */
    addOrbitRing(satrec, meta, color, orbitStyle) {
        const bright = orbitStyle === 'bright';
        const entity = this.viewer.entities.add({
            polyline: {
                positions: [],
                width:     bright ? 1.4 : 0.7,
                material:  bright
                    ? new Cesium.PolylineGlowMaterialProperty({
                        glowPower: 0.35, color: color.withAlpha(0.6),
                    })
                    : new Cesium.ColorMaterialProperty(color.withAlpha(0.2)),
                arcType: Cesium.ArcType.NONE,
            },
        });
        const place = (pts) => {
            if (!pts || pts.length < 2) {
                this.viewer.entities.remove(entity);
                return;
            }
            entity.polyline.positions = pts;
            // Path jobs come back asynchronously, so this is not inside a tick.
            this.requestRender();
        };
        if (meta && meta.l1) {
            this.requestPath(meta.l1, meta.l2, 'orbit', 90, orbitalPeriodMin(satrec),
                             place, () => this.computeOrbitPath(satrec));
        } else {
            place(this.computeOrbitPath(satrec));
        }
        return entity;
    }

    addGroundTrack(rec, cssColor, { width = 1.6, alpha = 0.55 } = {}) {
        this.requestRender();
        const color = Cesium.Color.fromCssColorString(cssColor);
        return this.viewer.entities.add({
            polyline: {
                positions: new Cesium.CallbackProperty(
                    this.workerPath(rec, 'track', 120, 2000), false),
                width,
                material: new Cesium.PolylineDashMaterialProperty({
                    color: color.withAlpha(alpha), dashLength: 12,
                }),
                clampToGround: true,
            },
        });
    }

    addFootprint(satrec, cssColor, { fill = 0.07, outline = 0.45, width = 1.2 } = {}) {
        this.requestRender();
        const color = Cesium.Color.fromCssColorString(cssColor);
        // Single geo() per frame shared across position + both radii.
        // Cesium evaluates CallbackProperties in arbitrary order, so the first
        // one to fire each frame runs geo(); the rest read the cached result.
        let frameGeo = null;
        let frameId  = -1;
        const cacheGeo = () => {
            const frame = this.tickCount;   // increments each worker tick
            if (frame !== frameId) {
                frameId = frame;
                frameGeo = this.geo(satrec);
            }
            return frameGeo;
        };
        return this.viewer.entities.add({
            position: new Cesium.CallbackProperty(() => {
                const p = cacheGeo();
                return p ? Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 0) : undefined;
            }, false),
            ellipse: {
                semiMajorAxis: new Cesium.CallbackProperty(() => {
                    const p = cacheGeo();
                    return p ? footprintRadiusM(p.alt) : 0;
                }, false),
                semiMinorAxis: new Cesium.CallbackProperty(() => {
                    const p = cacheGeo();
                    return p ? footprintRadiusM(p.alt) : 0;
                }, false),
                material:      color.withAlpha(fill),
                outline:       true,
                outlineColor:  color.withAlpha(outline),
                outlineWidth:  width,
                height:        0,
            },
        });
    }

    /**
     * Orbit + ground track + footprint for one inspected object.
     *
     * Entity visuals are added outside the tick, and on a page with NOTHING
     * rendered the tick asks for no frames at all — /spacetrack/ boots that way,
     * and a dossier opened from a result row whose object had no elset would add
     * its rings into a scene that never redraws.
     */
    addInspectVisuals(meta, cssColor = '#ffffff') {
        this.requestRender();
        const accent = Cesium.Color.fromCssColorString(cssColor);
        return {
            orbit: this.viewer.entities.add({
                polyline: {
                    positions: new Cesium.CallbackProperty(
                        this.workerPath(meta, 'orbit', 120, 2000), false),
                    width: 1.6,
                    material: new Cesium.PolylineGlowMaterialProperty({
                        glowPower: 0.25, color: accent.withAlpha(0.55),
                    }),
                    arcType: Cesium.ArcType.NONE,
                },
            }),
            track: this.addGroundTrack(meta, cssColor, { width: 1.4, alpha: 0.4 }),
            foot:  this.addFootprint(meta.satrec, cssColor,
                                     { fill: 0.06, outline: 0.4, width: 1 }),
        };
    }

    removeEntities(entities) {
        Object.values(entities || {}).forEach(e => { if (e) this.viewer.entities.remove(e); });
        this.requestRender();
    }

    /**
     * Track an entity the page added directly so destroy() removes it too.
     *
     * Satellites are PointPrimitives in one collection and are not Entities, so
     * nothing here tracks them. But overlays (debris bands, launch sites, the
     * GEO belt) are plain `viewer.entities.add(...)` calls; routing them through
     * here is what keeps them from leaking past engine.destroy(). Returns the
     * entity so the page can keep its own toggle bookkeeping if it wants.
     */
    addManagedEntity(entity) {
        this._managedEntities.push(entity);
        this.requestRender();
        return entity;
    }

    /** The inverse: stop tracking and remove a managed entity from the scene. */
    removeManagedEntity(entity) {
        const i = this._managedEntities.indexOf(entity);
        if (i >= 0) this._managedEntities.splice(i, 1);
        this.viewer.entities.remove(entity);
        this.requestRender();
    }

    /* ── Camera ─────────────────────────────────────────────────────────── */

    /** Frame a set of sat points. They are not Entities, so build a
     *  BoundingSphere from their positions and fly to that. */
    flyToSats(sats, { duration = 1.8, pitch = -55, zoom = 3.0 } = {}) {
        const positions = [];
        for (let i = 0; i < sats.length; i++) {
            const s = sats[i];
            if (s.show === false) continue;
            if (s.primitive && s.primitive.position) positions.push(s.primitive.position);
        }
        if (!positions.length) return;
        const sphere = Cesium.BoundingSphere.fromPoints(positions);
        this.viewer.camera.flyToBoundingSphere(sphere, {
            duration,
            offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(pitch),
                                                 sphere.radius * zoom),
        });
    }

    /* ── Lifecycle ──────────────────────────────────────────────────────── */

    /** Register an interval the engine should clear on destroy(). */
    own(intervalId) {
        this._intervals.push(intervalId);
        return intervalId;
    }

    destroy() {
        this._intervals.forEach(id => clearInterval(id));
        this._intervals.length = 0;
        this._managedEntities.forEach(e => this.viewer.entities.remove(e));
        this._managedEntities.length = 0;
        if (this.worker) { this.worker.terminate(); this.worker = null; }
    }

    /* ── Introspection (console + tests/e2e/test_orbit.py) ──────────────── */

    get satPointCount() { return this.satCollection.length; }
    get registered()    { return this._satById.size; }
}

function unpackPositions(xyz, count) {
    const pts = new Array(count);
    for (let i = 0; i < count; i++) {
        pts[i] = new Cesium.Cartesian3(xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2]);
    }
    return pts;
}
