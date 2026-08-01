/**
 * ORBITAL RELAY — the cinematic Celestrak view.
 *
 * CesiumJS 3D globe with real satellite orbits + live tracking, driven by
 * Celestrak group files (STATIONS + constellation groups). Starlink has its
 * own dedicated page at /starlink/.
 *
 * The rendering and propagation engine lives in `/orbit-engine/` and is shared
 * with `/spacetrack/` (plan 33 wave 3) — points in one PointPrimitiveCollection,
 * a throttled tick in a Web Worker, transferable position buffers. What is left
 * here is this page: its HUDs, its 16 group checkboxes, the inspector card and
 * the fly-to cinematics.
 *
 * Features: time-warp, click-to-inspect, ground tracks, coverage footprints,
 * animated orbit trails, constellation pulse FX.
 */

import { SatEngine, SatPoint, tuneViewerForDevice, mountCameraAltitudeHud } from '../orbit-engine/sat-engine.js';
import { parseTLE, parseTLEChunked, fetchTLE } from '../orbit-engine/tle.js';
import {
    orbitalPeriodMin, orbitRegime, orbVel, fmtLat, fmtLon,
} from '../orbit-engine/astro.js';
import { wireHudToggle, initMobileListener, initHamburgerMenu } from '/shared/hud.js';

/* ── Token + constants ─────────────────────────────────────────────────── */
// The previous orbit-page token was rejected by api.cesium.com with a 403,
// and the globe silently rendered with NO imagery — a black ball that read
// as "globe not rendering". This is the same token /spacetrack/ and /starlink/
// use, which api.cesium.com accepts.
Cesium.Ion.defaultAccessToken =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
    'eyJqdGkiOiI2MjFjZDg5My0zMTRiLTQ3ZjMtOTNlNi1iM2E3ZGNjYWE5ZTQiLCJpZCI6MzkzOTM1LCJpYXQiOjE3NzE5Nzk4NTd9.' +
    'eAH51ApKzzuBIkgwf-rqo4G2U6cSBOQMTPFAALBb2Hg';

// Ion-first base layer with a tokenless fallback. The 403 above was silent —
// no exception, just an imagery layer that never became ready — so a second
// failure of the token (expiry, quota, revocation) must not be able to kill
// the globe again. If the world-imagery promise rejects, swap in ArcGIS
// World Imagery, which needs no token.
const baseLayer = Cesium.ImageryLayer.fromProviderAsync(
    Cesium.createWorldImageryAsync().catch(() =>
        Cesium.ArcGisMapServerImageryProvider.fromUrl(
            'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer'
        )
    )
);

/** This page is Celestrak. Space-Track has its own page now — see the SOURCE
 *  row, where the button is a link rather than an in-place switch. */
const SOURCE = 'celestrak';

const tle = (group, live) => fetchTLE(group, { source: SOURCE, live });

/* ── Viewport ──────────────────────────────────────────────────────────────
 * `isMobile`/`wireHudToggle`/`initMobileListener` come from the shared HUD
 * module (see /shared/hud.js) — the mobile MediaQueryList lives there so
 * rotating the phone re-applies the single-panel rule and re-tunes render
 * resolution via the `initMobileListener` callback below, rather than only
 * sampling the viewport at the next tap.
 */

wireHudToggle('iss-hud',      'iss-hud-toggle',      'iss-hud-body');
wireHudToggle('layers-hud',   'layers-hud-toggle',   'layers-hud-body');

initHamburgerMenu();

/* ── Filter drawer (mobile layers) ─────────────────────────────────────── */
function initFilterDrawer() {
    const overlay = document.getElementById('layers-drawer-overlay');
    const closeBtn = document.getElementById('layers-drawer-close');
    const openBtn = document.getElementById('layers-drawer-btn');

    function openDrawer() {
        if (!overlay) return;
        overlay.setAttribute('open', '');
        document.body.classList.add('layers-drawer-open');
    }

    function closeDrawer() {
        if (!overlay) return;
        overlay.removeAttribute('open');
        document.body.classList.remove('layers-drawer-open');
    }

    if (openBtn) {
        openBtn.addEventListener('click', openDrawer);
    }

    if (closeBtn) {
        closeBtn.addEventListener('click', closeDrawer);
    }

    if (overlay) {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeDrawer();
        });
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && overlay && overlay.hasAttribute('open')) {
            closeDrawer();
        }
    });

    /* Sync drawer checkboxes with main layer checkboxes */
    const mainCheckboxes = document.querySelectorAll('#layers-hud .layer-cb');
    const drawerCheckboxes = document.querySelectorAll('#layer-list-drawer .layer-cb');

    mainCheckboxes.forEach((mainCb, i) => {
        const drawerCb = drawerCheckboxes[i];
        if (!drawerCb) return;
        mainCb.addEventListener('change', () => {
            drawerCb.checked = mainCb.checked;
            drawerCb.dispatchEvent(new Event('change', { bubbles: true }));
        });
        drawerCb.addEventListener('change', () => {
            mainCb.checked = drawerCb.checked;
            mainCb.dispatchEvent(new Event('change', { bubbles: true }));
        });
    });
}

initFilterDrawer();

/* ── HUD update ────────────────────────────────────────────────────────── */
const elLat   = document.getElementById('hud-iss-lat');
const elLon   = document.getElementById('hud-iss-lon');
const elAlt   = document.getElementById('hud-iss-alt');
const elVel   = document.getElementById('hud-iss-vel');
const elCount = document.getElementById('hud-sat-count');
const elDate  = document.getElementById('hud-date');
const elTime  = document.getElementById('hud-time');

let issRec = null;

// Start the STATIONS TLE fetch BEFORE the synchronous Cesium Viewer boot: the
// request overlaps the ~hundreds of ms of viewer construction + shader compile,
// so the parse (and first sat dots) land sooner. Everything loadSatellites does
// after its first await runs post-boot, when `viewer`/`engine` exist.
loadSatellites();

/* ── Cesium Viewer ─────────────────────────────────────────────────────── */
const viewer = new Cesium.Viewer('cesium-container', {
    animation:             false,
    baseLayer:             baseLayer,
    baseLayerPicker:       false,
    fullscreenButton:      false,
    geocoder:              false,
    homeButton:            false,
    infoBox:               false,
    sceneModePicker:       false,
    selectionIndicator:    false,
    timeline:              false,
    navigationHelpButton:  false,
    shouldAnimate:         true,
});

// Expose the viewer for console debugging / inspection.
window.viewer = viewer;

// Render on demand and cap resolution on small screens. Must run before the
// SatEngine exists, because the engine's tick is what asks for frames.
tuneViewerForDevice(viewer);
mountCameraAltitudeHud(viewer, document.getElementById('cam-alt'));

// Space atmosphere + day/night terminator (dynamic lighting follows the sun)
viewer.scene.globe.enableLighting          = true;
viewer.scene.globe.dynamicAtmosphereLighting = true;
viewer.scene.globe.dynamicAtmosphereLightingFromSun = true;
viewer.scene.skyAtmosphere.show            = true;
viewer.scene.skyAtmosphere.hueShift        = 0.0;
viewer.scene.skyAtmosphere.saturationShift = -0.1;
viewer.scene.skyAtmosphere.brightnessShift = -0.1;
// Slight night-side dimming so the terminator reads clearly
viewer.scene.globe.nightFadeOutDistance = 1.0e7;
viewer.scene.globe.nightFadeInDistance  = 5.0e7;

viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(
    Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK
);

// Initial camera (a cinematic fly-in animates from here on boot)
viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(20, 25, 40000000),
});

const clock = viewer.clock;
clock.shouldAnimate = true;
clock.multiplier    = 1;

/* ── Engine ────────────────────────────────────────────────────────────── */
const engine = new SatEngine({ viewer });

/**
 * React to crossing the mobile breakpoint (a rotation, usually) rather than
 * waiting for the next tap.
 *
 * Leaving it until the next toggle can strand the page: rotate to landscape
 * while a panel is open and `body.hud-panel-open` stays set on a wide layout,
 * where the rule does not apply — and that class HIDES the other collapsed
 * chips, so their toggles are gone with nothing left to bring them back.
 * The single-panel re-collapse itself lives in initMobileListener; only the
 * render re-tune (width-dependent) is specific to this page.
 */
initMobileListener(() => {
    tuneViewerForDevice(viewer);
    engine.requestRender();
});

/* ── HUD update ────────────────────────────────────────────────────────── */
function updateISSHud() {
    if (!issRec) return;
    const p = engine.geo(issRec);
    if (!p) return;
    if (elLat) elLat.textContent = fmtLat(p.lat);
    if (elLon) elLon.textContent = fmtLon(p.lon);
    if (elAlt) elAlt.textContent = `${Math.round(p.alt)} km`;
    if (elVel) elVel.textContent = `${orbVel(p.alt).toFixed(2)} km/s`;
}
engine.own(setInterval(updateISSHud, 1000));

/* ── UTC clock (shows the simulated time so time-warp is legible) ──────── */
function updateClock() {
    const now = engine.now();
    const pad = n => String(n).padStart(2, '0');
    const d = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
    const t = `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`;
    if (elDate) elDate.textContent = d;
    if (elTime) elTime.textContent = t + ' UTC';
}
engine.own(setInterval(updateClock, 250));

window.addEventListener('beforeunload', () => engine.destroy());

/* ── Loading state ─────────────────────────────────────────────────────── */
function setLoadingState(active) {
    if (elCount && active) elCount.textContent = 'INITIALIZING RELAY…';
}

/* ── Layer registries + sat count bar ──────────────────────────────────── */
const stationEntities = [];
let layerCount = 0;

function updateSatBar() {
    const stVis = stationEntities.reduce((n, e) => n + (e.show ? 1 : 0), 0);
    if (elCount) elCount.textContent = 1 + stVis + layerCount;
}

const stStatusEl = document.getElementById('layer-status-stations-other');

/* ── Load TLE data ─────────────────────────────────────────────────────── */
async function loadSatellites() {
    setLoadingState(true);

    const [stResult] = await Promise.allSettled([
        tle('STATIONS'),
    ]);

    if (stResult.status === 'fulfilled') {
        // Chunked so a cold phone never eats the whole bundle's twoline2satrec
        // work in one blocking burst — it spreads across idle frames instead.
        const stations = await parseTLEChunked(stResult.value);
        const issEntry = stations.find(s =>
            s.name.toUpperCase().includes('ISS') || s.name.toUpperCase().includes('ZARYA')
        );
        if (issEntry) {
            issRec = issEntry.satrec;
            const issMeta = { satrec: issRec, l1: issEntry.l1, l2: issEntry.l2,
                              name: issEntry.name, group: 'ISS', pulse: true };
            const issSat = engine.addSatellite(issRec, Cesium.Color.fromCssColorString('#f5a623'), 11, 'bright',
                issMeta);
            // ISS is always on, so its ring is built at boot — the one ring
            // that is never deferred to a layer toggle.
            engine.ensureRing(issSat);
            // ISS gets a persistent ground track + coverage footprint
            engine.addGroundTrack(issMeta, '#f5a623');
            engine.addFootprint(issRec, '#f5a623');
        }
        stations
            .filter(s => s !== issEntry)
            .forEach(s => {
                const e = engine.addSatellite(s.satrec, Cesium.Color.fromCssColorString('#ff8c69'), 7, true,
                    { satrec: s.satrec, l1: s.l1, l2: s.l2, name: s.name, group: 'STATIONS' });
                e.show = false;
                stationEntities.push(e);
            });
        if (stStatusEl) stStatusEl.textContent = '';
    } else {
        console.warn('[orbital-relay] STATIONS fetch failed:', stResult.reason);
    }

    updateSatBar();
    introFlyIn();
}

/* ── Click-to-inspect ──────────────────────────────────────────────────── */
const detailCard   = document.getElementById('sat-detail');
const dName        = document.getElementById('sat-detail-name');
const dGroup       = document.getElementById('sat-detail-group');
const dLat         = document.getElementById('sat-detail-lat');
const dLon         = document.getElementById('sat-detail-lon');
const dAlt         = document.getElementById('sat-detail-alt');
const dVel         = document.getElementById('sat-detail-vel');
const dPeriod      = document.getElementById('sat-detail-period');
const dRegime      = document.getElementById('sat-detail-regime');
const detailClose  = document.getElementById('sat-detail-close');

let inspectVisuals     = null;
let inspectUpdateTimer = null;

function closeInspector() {
    engine.removeEntities(inspectVisuals);
    inspectVisuals = null;
    if (inspectUpdateTimer) { clearInterval(inspectUpdateTimer); inspectUpdateTimer = null; }
    if (detailCard) detailCard.hidden = true;
}

function inspectSatellite(meta) {
    if (!meta || !meta.satrec) return;
    engine.removeEntities(inspectVisuals);
    inspectVisuals = engine.addInspectVisuals(meta, '#ffffff');

    // Populate + live-update the card
    if (dName)  dName.textContent  = `// ${meta.name}`;
    if (dGroup) dGroup.textContent = meta.group || '—';
    function refresh() {
        const p = engine.geo(meta.satrec);
        if (!p) return;
        if (dLat)    dLat.textContent    = fmtLat(p.lat);
        if (dLon)    dLon.textContent    = fmtLon(p.lon);
        if (dAlt)    dAlt.textContent    = `${Math.round(p.alt)} km`;
        if (dVel)    dVel.textContent    = `${orbVel(p.alt).toFixed(2)} km/s`;
        if (dPeriod) dPeriod.textContent = `${orbitalPeriodMin(meta.satrec).toFixed(1)} min`;
        if (dRegime) dRegime.textContent = orbitRegime(p.alt);
    }
    refresh();
    if (inspectUpdateTimer) clearInterval(inspectUpdateTimer);
    inspectUpdateTimer = engine.own(setInterval(refresh, 1000));
    if (detailCard) detailCard.hidden = false;
}

if (detailClose) detailClose.addEventListener('click', closeInspector);

// Pick handler — click a satellite dot to inspect it. Sat points are
// PointPrimitives whose `.id` is the SatPoint wrapper (carries `.meta`).
const clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
clickHandler.setInputAction((movement) => {
    const picked = viewer.scene.pick(movement.position);
    if (picked && picked.id instanceof SatPoint) {
        inspectSatellite(picked.id.meta);
    }
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

/* ── Time-warp controls ────────────────────────────────────────────────── */
document.querySelectorAll('.tw-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const rate = parseInt(btn.dataset.rate, 10);
        if (rate === 0) {
            clock.shouldAnimate = false;
        } else {
            clock.shouldAnimate = true;
            clock.multiplier    = rate;
        }
        document.querySelectorAll('.tw-btn').forEach(b =>
            b.classList.toggle('tw-btn--active', b === btn));
    });
});

/* ── Fly-to cinematics ─────────────────────────────────────────────────── */
function introFlyIn() {
    // Smooth descent from the wide boot view to the working altitude.
    viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(20, 25, 22000000),
        duration: 2.6,
        easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
    });
}

/* ── Constellation Layers ──────────────────────────────────────────────── */
const layerState = {};

function recalcLayerCount() {
    layerCount = Object.values(layerState)
        .reduce((sum, s) => sum + s.entities.reduce((n, e) => n + (e.show ? 1 : 0), 0), 0);
}

async function toggleLayer(group, color, cap, checked, live) {
    const statusEl = document.getElementById(`layer-status-${group}`);

    if (!checked) {
        const state = layerState[group];
        if (state) {
            state.entities.forEach(e => { e.show = false; });
            recalcLayerCount();
            updateSatBar();
        }
        if (statusEl) statusEl.textContent = '';
        return;
    }

    const state = layerState[group];
    if (state && state.loaded) {
        state.entities.forEach(e => { e.show = true; });
        recalcLayerCount();
        updateSatBar();
        if (statusEl) statusEl.textContent = `${state.entities.length}`;
        engine.flyToSats(state.entities);
        return;
    }
    if (state && state.fetching) return;

    layerState[group] = { entities: [], loaded: false, fetching: true };
    if (statusEl) statusEl.textContent = '…';

    try {
        const text     = await tle(group, live);
        const records  = (await parseTLEChunked(text)).slice(0, cap);
        const cesColor = Cesium.Color.fromCssColorString(color);
        const entities = records.map(r =>
            engine.addSatellite(r.satrec, cesColor, 5, false,
                { satrec: r.satrec, l1: r.l1, l2: r.l2,
                  name: r.name, group: group.toUpperCase(), pulse: true })
        );
        layerState[group] = { entities, loaded: true, fetching: false };
        recalcLayerCount();
        updateSatBar();
        if (statusEl) statusEl.textContent = `${entities.length}`;
        engine.flyToSats(entities);
    } catch (err) {
        console.warn(`[orbital-relay] Layer "${group}" fetch failed:`, err);
        layerState[group] = { entities: [], loaded: false, fetching: false };
        if (statusEl) statusEl.textContent = 'ERR';
    }
}

document.querySelectorAll('.layer-cb').forEach(cb => {
    cb.addEventListener('change', () => {
        const group   = cb.dataset.group;
        const builtin = cb.dataset.builtin === 'true';

        if (builtin) {
            if (group === 'stations-other') {
                stationEntities.forEach(e => {
                    e.show = cb.checked;
                    // Rings are deferred (see ensureRing) — the layer's 150
                    // rings must not exist, let alone draw, until it is on.
                    if (cb.checked) engine.ensureRing(e);
                    else if (e.ring) e.ring.show = false;
                });
                if (stStatusEl) stStatusEl.textContent = cb.checked ? stationEntities.length : '';
                updateSatBar();
            }
        } else {
            const color = cb.dataset.color;
            const cap   = parseInt(cb.dataset.cap, 10);
            toggleLayer(group, color, cap, cb.checked);
        }
    });
});

/* ── Refresh ───────────────────────────────────────────────────────────── */
function reloadAllLayers(live) {
    document.querySelectorAll('.layer-cb').forEach(cb => {
        if (cb.dataset.builtin === 'true') return;
        const group = cb.dataset.group;
        const state = layerState[group];
        if (state) {
            state.entities.forEach(s => engine.removeSat(s));
            delete layerState[group];
        }
        if (cb.checked) {
            toggleLayer(group, cb.dataset.color, parseInt(cb.dataset.cap, 10), true, live);
        }
    });
}

const refreshBtn = document.getElementById('refresh-data');
if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
        refreshBtn.classList.add('is-spinning');
        reloadAllLayers(true);
        setTimeout(() => refreshBtn.classList.remove('is-spinning'), 1200);
    });
}

/* ── Debug handle ──────────────────────────────────────────────────────────
 * Console inspection + the E2E suite (tests/e2e/test_orbit.py). Mirrors the
 * `__mc` convention in mars-colony: everything the tests need to assert on,
 * nothing they should mutate.
 */
window.__orbit = {
    viewer,
    engine,
    satCollection: engine.satCollection,
    allSats: engine.allSats,
    layerState,
    stationEntities,
    get satPointCount() { return engine.satPointCount; },
    get entityCount()   { return viewer.entities.values.length; },
    get booted()        { return engine.allSats.length > 0; },
    get worker()        { return engine.worker; },
    get workerReady()   { return engine.workerReady; },
    get registered()    { return engine.registered; },
    get tickCount()     { return engine.tickCount; },
    get source()        { return SOURCE; },
    disableWorker:      (why) => engine.disableWorker(why),
    propagateAllSats:     () => engine.propagate(),
    propagateAllSatsSync: () => engine.propagateSync(),
    inspectSatellite,
    toggleLayer,
    fetchTLE: (group, live) => fetchTLE(group, { source: SOURCE, live }),
    parseTLE,
};

/* ── Boot ────────────────────────────────────────────────────────────────
 * loadSatellites() is kicked off at the top of the module (see there) so the
 * STATIONS fetch overlaps the Cesium Viewer construction below.
 */
