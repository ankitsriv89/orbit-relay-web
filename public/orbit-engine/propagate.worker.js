/**
 * ORBITAL RELAY — SGP4 propagation worker.
 *
 * Plan 33 wave 1. Everything SGP4 runs here so the main thread only ever does
 * "copy numbers into PointPrimitives". Two jobs:
 *
 *   1. TICK — re-propagate the visible set and post back ONE transferable
 *      Float32Array of ECEF metres. Buffers ping-pong (the main thread returns
 *      them via `recycle`), so a steady-state tick allocates nothing on either
 *      side. This is what makes ~28k objects viable.
 *
 *   2. PATH — orbit rings and ground tracks. Each is 90–120 propagations and
 *      the page used to do them synchronously at load and again every 2s per
 *      CallbackProperty (audit finding M-18: ~54,000 blocking propagations at
 *      load). Now they are async jobs and the main thread never blocks on one.
 *
 * Coordinates: satellite.js gives geodetic radians + km, and this converts to
 * WGS84 ECEF metres with the same formula Cesium's Cartographic→Cartesian uses,
 * so points land exactly where the old `Cartesian3.fromDegrees` path put them.
 * Float32 quantises to ~0.5 m at Earth's radius — far below a pixel from orbit.
 */

/* eslint-env worker */
// Absolute: this worker is constructed from pages at different depths
// (/orbit/ and /spacetrack/), and importScripts resolves against the worker's
// own URL, so keeping it absolute removes the question entirely.
importScripts('/orbit-engine/vendor/satellite.min.js');

/* ── WGS84 geodetic → ECEF ──────────────────────────────────────────────────
 * Mirrors Ellipsoid.WGS84.cartographicToCartesian: with
 * gamma = sqrt(a²cos²φ + b²sin²φ), the surface point is (a²cosφcosλ,
 * a²cosφsinλ, b²sinφ)/gamma and height adds along the unit normal.
 */
const WGS84_A2 = 6378137.0 * 6378137.0;
const WGS84_B2 = 6356752.314245179 * 6356752.314245179;

function geodeticToEcef(latRad, lonRad, heightM, out, o) {
    const cosLat = Math.cos(latRad);
    const sinLat = Math.sin(latRad);
    const nx = cosLat * Math.cos(lonRad);
    const ny = cosLat * Math.sin(lonRad);
    const nz = sinLat;

    const kx = WGS84_A2 * nx;
    const ky = WGS84_A2 * ny;
    const kz = WGS84_B2 * nz;
    const gamma = Math.sqrt(nx * kx + ny * ky + nz * kz);

    out[o]     = kx / gamma + nx * heightM;
    out[o + 1] = ky / gamma + ny * heightM;
    out[o + 2] = kz / gamma + nz * heightM;
}

/* ── Registries ────────────────────────────────────────────────────────────
 * `satrecs` is the tick set, indexed by the id the main thread assigned.
 * `pathRecs` is an LRU cache of satrecs for one-off path jobs, keyed by TLE
 * lines — inspector paths re-request the same object every couple of seconds.
 */
const satrecs  = new Map();   // id → satrec
const PATH_CACHE_MAX = 64;
const pathRecs = new Map();   // "l1\nl2" → satrec (insertion-order LRU)

function pathRecGet(key) {
    const rec = pathRecs.get(key);
    if (rec !== undefined) {
        // Move to end (most-recently used) by re-inserting.
        pathRecs.delete(key);
        pathRecs.set(key, rec);
    }
    return rec;
}

function pathRecSet(key, rec) {
    if (pathRecs.has(key)) pathRecs.delete(key);
    while (pathRecs.size >= PATH_CACHE_MAX) {
        // Evict the oldest (first) entry.
        const oldest = pathRecs.keys().next().value;
        pathRecs.delete(oldest);
    }
    pathRecs.set(key, rec);
}

let visible = new Uint32Array(0);   // ids the main thread currently shows

// Pooled tick buffers. Two of each so a tick can go out while the previous
// pair is still in flight back from the main thread.
const xyzPool = [];
const idPool  = [];

function takeBuffers(n) {
    let xyz = xyzPool.pop();
    let ids = idPool.pop();
    if (!xyz || xyz.length < n * 3) xyz = new Float32Array(Math.max(n * 3, 3072));
    if (!ids || ids.length < n)     ids = new Uint32Array(Math.max(n, 1024));
    return { xyz, ids };
}

function makeSatrec(l1, l2) {
    try {
        const rec = satellite.twoline2satrec(l1, l2);
        return (rec && !rec.error) ? rec : null;
    } catch (_) {
        return null;
    }
}

/* ── Tick ───────────────────────────────────────────────────────────────── */
function tick(tMs) {
    const date = new Date(tMs);
    const gmst = satellite.gstime(date);      // one gmst for the whole set
    const n    = visible.length;
    const { xyz, ids } = takeBuffers(n);

    let count = 0;
    for (let i = 0; i < n; i++) {
        const id  = visible[i];
        const rec = satrecs.get(id);
        if (!rec) continue;
        const pv = satellite.propagate(rec, date);
        if (!pv || !pv.position) continue;
        const geo = satellite.eciToGeodetic(pv.position, gmst);
        geodeticToEcef(geo.latitude, geo.longitude, geo.height * 1000, xyz, count * 3);
        ids[count] = id;
        count++;
    }

    postMessage({ type: 'positions', t: tMs, count, xyz, ids },
                [xyz.buffer, ids.buffer]);
}

/* ── Paths (orbit ring · ground track) ──────────────────────────────────── */
function path(job, l1, l2, kind, steps, t0Ms, periodMin, spanFrom = 0, spanTo = 1) {
    const key = l1 + '\n' + l2;
    let rec = pathRecGet(key);
    if (!rec) {
        rec = makeSatrec(l1, l2);
        // Always ship an `xyz` alongside `count`, even on the give-up path:
        // the main thread does `new Array(m.count)`, and a message missing
        // either field lands there as `undefined`/NaN, which throws
        // `RangeError: Invalid array length` INSIDE Cesium's render loop —
        // and Cesium responds to a render-loop throw by stopping rendering
        // and showing its error dialog over the globe.
        if (!rec) {
            postMessage({ type: 'path', job, count: 0, xyz: new Float32Array(0) });
            return;
        }
        pathRecSet(key, rec);
    }

    // `rec.no` is radians/minute from the TLE mean motion. A malformed or
    // decayed element set can leave it 0/NaN, and `(2π)/0` is Infinity — which
    // turns every `new Date(t0 + rev*period*60000)` below into an Invalid Date,
    // propagates NaN into the vertex count, and reaches `new Array(NaN)`.
    // Falling back to a ~90 min LEO period keeps the ring wrong-but-finite
    // rather than taking the whole scene down.
    let period = periodMin || (2 * Math.PI) / rec.no;
    if (!Number.isFinite(period) || period <= 0) period = 90;
    // Signed span, in revolutions: negative revs propagate before `now`, and
    // SGP4 is symmetric about the epoch so no guard is needed. The vertex
    // count scales with the span so resolution stays constant per revolution.
    const span = spanTo - spanFrom;
    const n    = Math.min(Math.max(2, Math.round(Math.abs(span) * steps)), 480);
    const xyz  = new Float32Array((n + 1) * 3);
    let count = 0;
    for (let i = 0; i <= n; i++) {
        const rev  = spanFrom + (i / n) * span;
        const date = new Date(t0Ms + rev * period * 60000);
        const pv   = satellite.propagate(rec, date);
        if (!pv || !pv.position) continue;
        const geo = satellite.eciToGeodetic(pv.position, satellite.gstime(date));
        // Ground tracks clamp to the surface; orbit rings keep their altitude.
        geodeticToEcef(geo.latitude, geo.longitude,
                       kind === 'track' ? 0 : geo.height * 1000, xyz, count * 3);
        count++;
    }
    postMessage({ type: 'path', job, count, xyz }, [xyz.buffer]);
}

/* ── Dispatch ───────────────────────────────────────────────────────────── */
onmessage = (e) => {
    const m = e.data;
    switch (m.type) {
        case 'register': {
            // ids[i] pairs with tles[2i], tles[2i+1].
            for (let i = 0; i < m.ids.length; i++) {
                const rec = makeSatrec(m.tles[i * 2], m.tles[i * 2 + 1]);
                if (rec) satrecs.set(m.ids[i], rec);
            }
            postMessage({ type: 'registered', count: satrecs.size });
            break;
        }
        case 'unregister':
            for (let i = 0; i < m.ids.length; i++) satrecs.delete(m.ids[i]);
            break;
        case 'visible':
            visible = m.ids;
            break;
        case 'tick':
            tick(m.t);
            break;
        case 'recycle':
            // Buffers came back from the main thread — reuse instead of realloc.
            if (m.xyz && xyzPool.length < 2) xyzPool.push(new Float32Array(m.xyz));
            if (m.ids && idPool.length  < 2) idPool.push(new Uint32Array(m.ids));
            break;
        case 'path':
            path(m.job, m.l1, m.l2, m.kind, m.steps, m.t0, m.periodMin,
                 m.spanFrom, m.spanTo);
            break;
        default:
            break;
    }
};

postMessage({ type: 'ready' });
