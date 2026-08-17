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
    geoAt, orbitalPeriodMin, footprintRadiusM, farSideFade, eclipseShadowFactor,
    sunDirectionEcef,
} from './astro.js';
import { buildSkyFaceSources } from './starfield.js';
import { renderCommLinks } from './comm-links.js';

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
 *
 * On DESKTOP that same pinning is what made the globe look soft on every
 * high-DPI monitor. `useBrowserRecommendedResolution = true` means "draw at CSS
 * pixels", so a 1.5-2x display renders the globe at 1x and lets the compositor
 * upscale it — Ion imagery arrives sharp and is then thrown away. The phone
 * argument above does not transfer: a desktop GPU has the fill rate, and the
 * blur is very visible on a large screen. Desktop therefore draws at the
 * device ratio, capped at DESKTOP_DPR_CAP so a 4K/5K panel does not pay a 9x
 * fragment bill for detail past the point of visible return.
 */
const DESKTOP_DPR_CAP = 2;

export function tuneViewerForDevice(viewer, { mobileMaxWidth = 600 } = {}) {
    const scene = viewer.scene;

    scene.requestRenderMode         = true;
    scene.maximumRenderTimeChange   = 30;    // seconds of simulation time

    const isSmall = window.matchMedia(`(max-width: ${mobileMaxWidth}px)`).matches;

    if (isSmall) {
        // Unchanged mobile path — see the note above.
        viewer.useBrowserRecommendedResolution = true;
        viewer.resolutionScale = 0.85;
    } else {
        viewer.useBrowserRecommendedResolution = false;
        const dpr = Number(window.devicePixelRatio) || 1;
        viewer.resolutionScale = Math.min(Math.max(dpr, 1), DESKTOP_DPR_CAP);
    }

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

    guardCameraAgainstNaN(viewer);
}

/**
 * Recover the camera if CesiumJS drives it to NaN.
 *
 * CesiumJS 1.113 has a reachable bug in zoom-toward-cursor: after a
 * *drag-rotate*, the next wheel tick whose pick ray hits the globe surface can
 * leave `camera.position` — and with it direction/up/right and
 * `positionCartographic.height` — entirely NaN. The globe disappears and no
 * error is thrown; the page just goes black and stops responding to input.
 *
 * Verified against production, on /orbit/, /starlink/ and /constellations/
 * (every page that calls this), and reproducible in four steps: load, drag to
 * rotate, put the cursor over the globe, scroll. It is specific to that path —
 * wheel WITHOUT a preceding drag is fine, wheel over empty space is fine, and
 * `camera.zoomIn()` is fine. None of the controller knobs avoid it
 * (`enableCollisionDetection`, `depthTestAgainstTerrain`, the zoom-distance
 * clamps above), so this cannot be configured away, and pinning a patched
 * Cesium is out of scope for a no-build-step frontend.
 *
 * `preUpdate` runs before the controller consumes the next input, so restoring
 * the last good camera there means the corruption never reaches a rendered
 * frame. We snapshot only known-finite states, so the fallback can never be a
 * NaN we saved earlier.
 *
 * Recovery RE-APPLIES the zoom the user asked for rather than only restoring
 * the old camera. Restoring alone is correct but feels broken: the gesture
 * that triggers the bug is an ordinary "rotate, then scroll to zoom", so a
 * bare restore reads as a globe that refuses to zoom. Instead we return to the
 * last good position and move along the view direction toward the globe centre
 * — which also re-centres the view, since the corrupting path is precisely the
 * off-centre zoom-toward-cursor one.
 */
const CAMERA_RECOVER_ZOOM = 0.25;   // fraction of altitude per recovered tick

function guardCameraAgainstNaN(viewer) {
    const camera = viewer.camera;
    const finite = (c) => c && Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.z);
    const healthy = () => finite(camera.position) && finite(camera.direction) && finite(camera.up);

    let last = null;

    viewer.scene.preUpdate.addEventListener(() => {
        if (healthy()) {
            // Snapshot the good state. Clone: these are live Cartesian3s that
            // Cesium mutates in place, so a reference would go NaN with them.
            last = last || {
                position: new Cesium.Cartesian3(),
                direction: new Cesium.Cartesian3(),
                up: new Cesium.Cartesian3(),
            };
            Cesium.Cartesian3.clone(camera.position, last.position);
            Cesium.Cartesian3.clone(camera.direction, last.direction);
            Cesium.Cartesian3.clone(camera.up, last.up);
            return;
        }

        if (!last) {
            // Corrupted before we ever saw a good frame — fall back to the
            // same top-down framing every page boots into.
            camera.setView({
                destination: HOME_DESTINATION,
                orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
            });
            return;
        }

        camera.setView({
            destination: last.position,
            orientation: { direction: last.direction, up: last.up },
        });

        /* Re-centre on the globe and complete the zoom, so the recovery reads
         * as "it zoomed" rather than "it stuck". Looking at the centre is what
         * pulls the view back to middle after the failed off-centre zoom. */
        const carto = camera.positionCartographic;
        if (!carto || !Number.isFinite(carto.height)) return;
        const target = Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, 0);
        const range = Math.max(
            viewer.scene.screenSpaceCameraController.minimumZoomDistance,
            carto.height * (1 - CAMERA_RECOVER_ZOOM));
        camera.lookAt(target, new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-90), range));
        // lookAt leaves a reference frame behind; without this every later
        // rotate/zoom happens in that frame instead of world space.
        camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    });
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
        /** Immutable snapshot of the colour this sat is drawn at when nothing
         *  occludes it — {r,g,b,a} floats, deliberately NOT a Cesium.Color.
         *
         *  The far-side pass rebuilds from this rather than reading hue back off
         *  the live primitive, for two reasons. It cannot compound its own
         *  output; and pages are free to pass ONE shared Cesium.Color for a
         *  whole layer (starlink.js does — every sat gets the same instance),
         *  where reading `primitive.color` can hand back a reference into the
         *  collection and writing through it would smear one point's fade
         *  across every other point sharing that colour. */
        this.baseColor = { r: 1, g: 1, b: 1, a: 1 };
        /** Set by the engine's per-frame occlusion pass: true when the Earth is
         *  between the camera and this sat. Click handlers read it — a faded
         *  point is still pickable, and picking one behind the globe selects a
         *  satellite over India from a click on Kansas. */
        this.farSide   = false;
        this._appliedFade = 1;   // last fade written, so the pass can skip no-ops
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
        /** Comm-links renderer (ground-to-satellite RF links) */
        this._commLinks = null;
        /** Cinematic quality (plan 34 §3.3): 'high' shades satellites inside
         *  Earth's umbra via eclipseShadowFactor (the eclipse pass below),
         *  enables the bloom post-process stage (C3) AND replaces the scene
         *  skyBox with the procedural starfield (C4); 'low' keeps only the
         *  camera-based far-side fade, bloom off and the skyBox hidden.
         *  /orbit/ owns the persisted toggle; pages without one keep the
         *  engine default. */
        this.cinematics = 'high';
        /** The procedural star skyBox (C4), built lazily on the first
         *  _applyCinematics call — see _buildSkyBox(). Recreated never. */
        this._skyBox = null;

        try {
            this.worker = new Worker(workerUrl);
        } catch (err) {
            console.warn('[sat-engine] propagation worker unavailable — SGP4 stays on the main thread:', err);
        }
        if (this.worker) this._wireWorker();

        this._intervals.push(setInterval(() => this.propagate(),  SAT_TICK_MS));
        this._intervals.push(setInterval(() => this._pulse(),     PULSE_TICK_MS));

        // Far-side occlusion, refreshed per DRAWN FRAME rather than on the
        // propagation tick. Occlusion is a function of the camera as much as of
        // position, and the camera moves continuously during a drag while
        // propagate() only lands every 280 ms — computing the fade there would
        // leave ~56 of every 60 dragged frames carrying a camera up to a quarter
        // second stale, so the dots would visibly pop behind the hand. preRender
        // fires exactly when Cesium draws, whoever asked for the frame, and adds
        // nothing on frames that were not going to be drawn — under
        // requestRenderMode an idle camera renders ~4 fps, so this is a
        // passenger, never a driver.
        this._occludeFrame = () => this._refreshOcclusion();
        viewer.scene.preRender.addEventListener(this._occludeFrame);

        // Bloom matches the initial cinematics level. This runs at construction
        // (not only on a setCinematics flip) so pages that never call
        // setCinematics — /starlink/, /constellations/ — still inherit the
        // engine default 'high' exactly like the eclipse pass does.
        this._applyCinematics();
    }

    /** Register a comm-links renderer. The page calls this once with the ground-station
     *  list and a tick function that returns the current satellite ECF position.
     *  The engine will call .update() on the renderer every propagation tick. */
    setCommLinks(renderer) {
        this._commLinks = renderer;
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
    requestPath(l1, l2, kind, steps, periodMin, done, fallback, spanFrom = 0, spanTo = 1) {
        if (!this.worker) { done(fallback()); return; }
        const job = this._nextPathJob++;
        this._pathJobs.set(job, { done, fallback });
        this.worker.postMessage({
            type: 'path', job, l1, l2, kind, steps,
            t0: this.now().getTime(), periodMin, spanFrom, spanTo,
        });
    }

    /**
     * A CallbackProperty source that never blocks: returns the last computed
     * array immediately and refreshes it in the worker every `ms`. Without this
     * a ground-track callback re-runs 120 propagations on the main thread every
     * refresh — audit finding M-18.
     */
    workerPath(rec, kind, steps, ms, spanFrom = 0, spanTo = 1) {
        let cache = [], last = -Infinity, pending = false;
        const sync = () => (kind === 'track'
            ? this.computeGroundTrack(rec.satrec, steps, spanFrom, spanTo)
            : this.computeOrbitPath(rec.satrec, steps, spanFrom, spanTo));
        return () => {
            const now = performance.now();
            if (!pending && now - last > ms) {
                last = now;
                if (this.worker && rec.l1) {
                    pending = true;
                    this.requestPath(rec.l1, rec.l2, kind, steps, orbitalPeriodMin(rec.satrec),
                                     (pts) => { cache = pts; pending = false; },
                                     () => { pending = false; return sync(); },
                                     spanFrom, spanTo);
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

    _samplePath(satrec, steps, heightOf, spanFrom = 0, spanTo = 1) {
        const period = orbitalPeriodMin(satrec);
        const t0 = this.now().getTime();
        // Same signed-span walk as the worker's path() — the two must land on
        // the same instants. Vertex count scales with the span so resolution
        // is constant per revolution (the default 0..1 span is unchanged).
        const span = spanTo - spanFrom;
        const n    = Math.min(Math.max(2, Math.round(Math.abs(span) * steps)), 480);
        const pts = [];
        for (let i = 0; i <= n; i++) {
            const rev = spanFrom + (i / n) * span;
            const t  = new Date(t0 + rev * period * 60000);
            const g  = geoAt(satrec, t);
            if (!g) continue;
            pts.push(Cesium.Cartesian3.fromDegrees(g.lon, g.lat, heightOf(g)));
        }
        return pts;
    }

    computeOrbitPath(satrec, steps = 90, spanFrom = 0, spanTo = 1) {
        return this._samplePath(satrec, steps, (g) => g.alt * 1000, spanFrom, spanTo);
    }

    /** Sub-satellite path clamped to the surface, one full period. */
    computeGroundTrack(satrec, steps = 120, spanFrom = 0, spanTo = 1) {
        return this._samplePath(satrec, steps, () => 0, spanFrom, spanTo);
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
            scaleByDistance:          new Cesium.NearFarScalar(1e6, 1.2, 2e7, 0.85),
            show:                     true,
        });

        const sat = new SatPoint(this, primitive, satrec, safeMeta, pointSize,
                                 !!(meta && meta.pulse));
        // Snapshot the unoccluded colour by VALUE. Layers pass pre-faded colours
        // (the dimmed non-matching set on /spacetrack/) and may reuse one Color
        // instance for a whole layer, so copying the components here is what
        // keeps the far-side pass from smearing across a shared instance.
        sat.baseColor = { r: color.red, g: color.green, b: color.blue, a: color.alpha };
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
        // Update comm-links after positions are propagated
        this._commLinks?.update();
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

    /**
     * Fade satellites the Earth is in front of, once per drawn frame.
     *
     * Why this exists: sat points are drawn with `disableDepthTestDistance:
     * Infinity` (so they never z-fight the globe or sink into terrain up close),
     * which means a far-side satellite draws straight *through* the planet, over
     * whatever continent faces the camera. Without a depth cue, rotating the
     * globe reads as "the dots stayed put while the map moved" — the positions
     * are correct, but the eye maps a satellite over India onto Kansas.
     *
     * Three things keep this affordable at /spacetrack/ scale (~28k objects):
     *
     *   - the test is one dot product and a compare, no allocation, no sqrt on
     *     the visible path;
     *   - hidden points are skipped outright;
     *   - `primitive.color` is only WRITTEN when the fade actually moves. Every
     *     write dirties the collection's packed buffer and forces a re-upload,
     *     so a parked camera must settle to zero writes — same no-op-skip
     *     discipline as _pulse(). The 0.01 threshold is below one 8-bit alpha
     *     step, so nothing visible is dropped.
     *
     * Deliberately does NOT call requestRender(): it runs *inside* a frame that
     * is already being drawn, and asking for another from here would loop.
     */
    _refreshOcclusion() {
        const cam = this.viewer.camera.positionWC;
        if (!cam) return;
        // Eclipse shading (plan 34 §3.3, quality gate): the sun direction is a
        // function of the clock, not of the camera, so it is computed ONCE per
        // drawn frame and shared by every sat. sunDirectionEcef returns a unit
        // ECEF vector — the same metres-frame as prim.position — and is pure
        // math from astro.js (satellite.js has no sun module and Cesium 1.113
        // dropped SunPosition; see its doc comment). One call per frame is the
        // whole budget of the pass, matching the "deliberately does NOT call
        // requestRender()" discipline above.
        const sun = this.cinematics === 'high'
            ? sunDirectionEcef(this.now())
            : null;
        for (let i = 0; i < this.allSats.length; i++) {
            const s = this.allSats[i];
            const prim = s.primitive;
            if (!prim.show) continue;
            const fade = farSideFade(prim.position, cam);
            // The two occluders multiply: the camera fades far-side dots, the
            // sun dims dots inside the shadow cylinder. eclipseShadowFactor is
            // 1 for every day-side sat, so 'low' (sun = null) is exactly the
            // old behaviour and the sunlit majority of 'high' costs one extra
            // multiply plus a dot product per sat.
            const alpha = sun ? fade * eclipseShadowFactor(prim.position, sun) : fade;
            s.farSide = fade < 1;
            if (Math.abs(alpha - s._appliedFade) < 0.01) continue;
            s._appliedFade = alpha;
            // Rebuild from the base snapshot, never from prim.color: the getter
            // can return a reference the page shares across a whole layer.
            // Assigning a fresh Color is also what marks the buffer dirty.
            const b = s.baseColor;
            prim.color = new Cesium.Color(b.r, b.g, b.b, b.a * alpha);
        }
    }

    /**
     * Recolour a satellite — the only supported way to change a point's colour.
     *
     * Writing `sat.primitive.color` directly is not enough once far-side fading
     * is on: the per-frame pass rebuilds every faded point from `baseColor`, so
     * a direct write to a currently-faded point is reverted on the next drawn
     * frame. This updates the snapshot the pass reads from, then applies the
     * live fade so the new colour appears immediately at the right opacity.
     *
     * @param {SatPoint} sat
     * @param {Cesium.Color} color the unoccluded colour
     */
    setSatColor(sat, color) {
        if (!sat || !color) return;
        sat.baseColor = { r: color.red, g: color.green, b: color.blue, a: color.alpha };
        const fade = sat._appliedFade;
        sat.primitive.color = fade < 1
            ? new Cesium.Color(color.red, color.green, color.blue, color.alpha * fade)
            : color;
    }

    /**
     * Apply the scene-level half of the cinematic quality (plan 34 §3.3 C3+C4).
     *
     * 'high' enables `scene.postProcessStages.bloom`, the built-in bloom
     * stage, and shows the procedural star skyBox (built once, then cached —
     * see _buildSkyBox). 'low' disables bloom and hides the skyBox, leaving a
     * plain black background behind the atmosphere.
     *
     * The bloom uniforms are left at Cesium's defaults — the canvas renders
     * black in the dev sandbox (Cesium Ion 403), so visual tuning (glowOnly /
     * contrast / sigma) is deliberately deferred until a real renderer can be
     * eyeballed, same discipline as C2's sun constants being pinned by tests
     * before they were trusted.
     *
     * The skyBox is assigned in BOTH levels, not just 'high'. Cesium 1.113's
     * Scene lazily constructs its default Tycho-2 skyBox on the first render
     * when `scene.skyBox` is undefined — six JPEG fetches from the Cesium CDN
     * per page. This constructor-time call runs before the first frame, so
     * assigning ours (even hidden) preempts the default entirely and every
     * page ships the procedural sky or a plain black one, never a CDN asset.
     *
     * Post-processing is guarded at every level: it needs a WebGL2 context,
     * and even where the collection exists the bloom stage is a lazy getter
     * that some restricted renderers may not provide. A page that boots
     * without it must keep working, exactly like the propagation worker's
     * synchronous fallback.
     */
    _applyCinematics() {
        const scene = this.viewer.scene;
        if (!this._skyBox) this._skyBox = this._buildSkyBox();
        if (scene.skyBox !== this._skyBox) scene.skyBox = this._skyBox;
        this._skyBox.show = this.cinematics === 'high';

        if (!scene.postProcessStages || !scene.postProcessStages.bloom) return;
        scene.postProcessStages.bloom.enabled = this.cinematics === 'high';
    }

    /** The procedural star skyBox (C4): six canvas faces of a deterministic
     *  3D star field, encoded as PNG data URLs — a few KB of generated image
     *  strings, no external assets (the plan §1.3 lesson). See
     *  starfield.js for the pure math. */
    _buildSkyBox() {
        return new Cesium.SkyBox({ sources: buildSkyFaceSources(), show: true });
    }

    /**
     * Set the cinematic quality (plan 34 §3.3 — the eclipse shading + bloom
     * passes + star skyBox).
     *
     * 'high' shades satellites inside Earth's umbra via eclipseShadowFactor,
     * enables the bloom post-process stage and shows the procedural star
     * skyBox; 'low' disables all three and leaves the far-side fade alone.
     * The first frame after a change rewrites every
     * visible point — the pass compares against the last applied multiplier,
     * which the flip invalidates — so requestRender() makes the change visible
     * immediately rather than waiting for the next propagation tick.
     *
     * @param {'high'|'low'} level
     */
    setCinematics(level) {
        if (level !== 'high' && level !== 'low') return;
        if (this.cinematics === level) return;
        this.cinematics = level;
        this._applyCinematics();
        this.requestRender();
    }

    /**
     * The SatPoint under a `scene.pick()` result, or null.
     *
     * Filters out satellites behind the Earth. `scene.pick()` ignores alpha, so
     * without this a faded far-side dot still wins the click over the globe in
     * front of it — you click Kansas and select a satellite over India, which is
     * the same confusion the fade removes visually, arriving through a different
     * channel. All three globe pages pick the same way; this is the one place
     * that knows the rule.
     */
    pickSat(picked) {
        if (!picked || !(picked.id instanceof SatPoint)) return null;
        return picked.id.farSide ? null : picked.id;
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
     * Orbit + ground track + footprint for one inspected object, plus a dashed
     * past-orbit arc. `revs` (default 1) extends the glowing future orbit that
     * many periods; the past arc is fixed at half a revolution, and the ground
     * track stays at one period (three near-identical sinusoids offset by
     * nodal regression would be noisier, not more informative).
     *
     * A revs change on a live selection must tear down and rebuild via
     * removeEntities() + addInspectVisuals() — both call requestRender(), and
     * under requestRenderMode mutating the existing polyline in place skips
     * that frame and the globe freezes into a still image.
     *
     * Entity visuals are added outside the tick, and on a page with NOTHING
     * rendered the tick asks for no frames at all — /spacetrack/ boots that way,
     * and a dossier opened from a result row whose object had no elset would add
     * its rings into a scene that never redraws.
     */
    addInspectVisuals(meta, cssColor = '#ffffff', { revs = 1 } = {}) {
        this.requestRender();
        const accent = Cesium.Color.fromCssColorString(cssColor);
        return {
            past: this.viewer.entities.add({
                polyline: {
                    positions: new Cesium.CallbackProperty(
                        this.workerPath(meta, 'orbit', 60, 2000, -0.5, 0), false),
                    width: 1.2,
                    material: new Cesium.PolylineDashMaterialProperty({
                        color: accent.withAlpha(0.25), dashLength: 10,
                    }),
                    arcType: Cesium.ArcType.NONE,
                },
            }),
            orbit: this.viewer.entities.add({
                polyline: {
                    positions: new Cesium.CallbackProperty(
                        this.workerPath(meta, 'orbit', 120, 2000, 0, revs), false),
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
     *  BoundingSphere from their positions and fly to that.
     *
     *  Only FINITE positions are considered. A sat whose first propagation has
     *  not landed yet (or whose TLE produced no position) still carries a
     *  Cartesian3 full of NaN; one of those poisons
     *  `BoundingSphere.fromPoints`, and flying to a NaN sphere leaves the
     *  camera at a NaN height — the globe vanishes and every later zoom reads
     *  `nan m`, with no error thrown to say why. */
    flyToSats(sats, { duration = 1.8, pitch = -55, zoom = 3.0 } = {}) {
        const positions = [];
        for (let i = 0; i < sats.length; i++) {
            const s = sats[i];
            if (s.show === false) continue;
            const p = s.primitive && s.primitive.position;
            if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
                positions.push(p);
            }
        }
        if (!positions.length) return;
        const sphere = Cesium.BoundingSphere.fromPoints(positions);
        // fromPoints on near-coincident points can still yield a zero/NaN
        // radius; `radius * zoom` would then be the camera's range.
        if (!sphere || !Number.isFinite(sphere.radius) || sphere.radius <= 0) return;
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
        if (this._occludeFrame) {
            this.viewer.scene.preRender.removeEventListener(this._occludeFrame);
            this._occludeFrame = null;
        }
        if (this.worker) { this.worker.terminate(); this.worker = null; }
    }

    /* ── Introspection (console + tests/e2e/test_orbit.py) ──────────────── */

    get satPointCount() { return this.satCollection.length; }
    get registered()    { return this._satById.size; }
}

/**
 * Turn the worker's packed [x,y,z,…] buffer into Cartesian3s.
 *
 * `count` is sanitised rather than trusted. `new Array(n)` throws
 * `RangeError: Invalid array length` for NaN, negative, fractional and
 * out-of-range n — and every caller reaches here from a worker `message`
 * handler that Cesium runs inside its render loop, where an uncaught throw
 * makes Cesium stop rendering and paint its error dialog across the globe.
 * A path that cannot be unpacked must degrade to "no ring drawn", never to
 * "the scene is dead". Observed in production as a RangeError dialog on
 * /orbit/, /starlink/ and /constellations/.
 */
function unpackPositions(xyz, count) {
    const n = Number(count);
    if (!Number.isFinite(n) || n <= 0 || !xyz) return [];
    const usable = Math.min(Math.floor(n), Math.floor(xyz.length / 3));
    if (usable <= 0) return [];
    const pts = new Array(usable);
    for (let i = 0; i < usable; i++) {
        pts[i] = new Cesium.Cartesian3(xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2]);
    }
    return pts;
}
