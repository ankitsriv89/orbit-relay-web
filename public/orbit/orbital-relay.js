/**
 * ORBITAL RELAY — the cinematic Celestrak view.
 *
 * CesiumJS 3D globe with real satellite orbits + live tracking, driven by
 * Celestrak group files (STATIONS + constellation groups). Starlink has its
 * own tab on /constellations/ (?c=starlink).
 *
 * The rendering and propagation engine lives in `/orbit-engine/` and is shared
 * with `/spacetrack/` (plan 33 wave 3) — points in one PointPrimitiveCollection,
 * a throttled tick in a Web Worker, transferable position buffers. What is left
 * here is this page: its HUDs, its constellation layer registry (./layers.js),
 * the inspector card and
 * the fly-to cinematics.
 *
 * Features: time-warp, click-to-inspect, ground tracks, coverage footprints,
 * animated orbit trails, constellation pulse FX.
 */

import { SatEngine, tuneViewerForDevice, mountCameraAltitudeHud, flyHome } from '../orbit-engine/sat-engine.js';
import { parseTLE, parseTLEChunked, fetchTLE } from '../orbit-engine/tle.js';
import {
    orbitalPeriodMin, orbitRegime, orbVel, fmtLat, fmtLon,
    auroraOvals, sunDirectionEcef,
} from '../orbit-engine/astro.js';
import {
    wireHudToggle, initMobileListener, initHamburgerMenu,
    wireRevsButton, syncRevsButtons, currentRevs, REVS_STATE_PATH,
    isMobile,
} from '/shared/hud.js';
import { syncCheckboxes } from '/shared/sync-checkbox.js';
import { State } from '/spacetrack/shared/state.js';
import { renderLayerList } from './layers.js';

/* ── Token + constants ─────────────────────────────────────────────────── */
// The previous orbit-page token was rejected by api.cesium.com with a 403,
// and the globe silently rendered with NO imagery — a black ball that read
// as "globe not rendering". This is the same token /spacetrack/ and /constellations/
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

/* ── Layer list (plan 34 3.1 S11) ─────────────────────────────────────────
 * Both the desktop panel and mobile drawer are built from the same LAYERS
 * registry in ./layers.js, before anything below queries `.layer-cb` —
 * the drawer mirror wiring, the layer-cb change handler, and reloadAllLayers
 * all assume the checkboxes already exist in the DOM. */
renderLayerList('layer-list');
renderLayerList('layer-list-drawer', '-drawer');

/* ── SPACE WEATHER (plan 34 §3.4 — NOAA SWPC) ──────────────────────────────
 * A builtin AURORA layer (registry entry in layers.js) that draws the
 * auroral ovals for the current Kp index, plus a compact data row in both
 * layers HUDs. All data comes from /api/space-weather (SWPC → D1 → artifact,
 * cited NOAA). Silent degrade on purpose: a fetch failure blanks the row to
 * '—' and the toggle does nothing — this is a satellite tracker, not a
 * weather service, and a dead SWPC must not take the page down with it.
 */
const SW_COLOR = '#42f587';
let auroraState = { data: null, entities: [], loaded: false, fetching: false };

function swStatusEls() {
    return [
        document.getElementById('layer-status-aurora'),
        document.getElementById('layer-status-aurora-drawer'),
    ];
}

function setSwStatus(text) {
    swStatusEls().forEach(el => { if (el) el.textContent = text; });
}

function setSwRow(text) {
    document.querySelectorAll('.space-weather-row .hud-val').forEach(el => {
        el.textContent = text;
    });
}

function swRowText(data) {
    const kp   = data?.current?.kp;
    const f107 = data?.current?.f107;
    const mean = data?.current?.f107_90day;
    const parts = [];
    if (kp != null) parts.push(`KP ${Number(kp).toFixed(1)}`);
    if (f107 != null) parts.push(`F10.7 ${Math.round(f107)}`);
    if (mean != null) parts.push(`90D ${Math.round(mean)}`);
    return parts.join(' · ') || '—';
}

/** One SPACE WX row built once, cloned into both layers HUDs (desktop + drawer). */
function mountSpaceWeatherRows() {
    document.querySelectorAll(
        '#layers-hud-body .hud-controls-hint, #layers-drawer-overlay .hud-controls-hint'
    ).forEach(hint => {
        const row = document.createElement('div');
        row.className = 'hud-row space-weather-row';
        const label = document.createElement('span');
        label.className = 'hud-label';
        label.textContent = 'SPACE WX';
        const val = document.createElement('span');
        val.className = 'hud-val';
        val.textContent = '—';
        row.appendChild(label);
        row.appendChild(val);
        hint.parentNode.insertBefore(row, hint);
    });
}

async function fetchSpaceWeather() {
    const res = await fetch('/api/space-weather');
    if (!res.ok) throw new Error(`space-weather ${res.status}`);
    return res.json();
}

async function toggleAurora(checked) {
    if (!checked) {
        auroraState.entities.forEach(e => { e.show = false; });
        setSwStatus('');
        return;
    }
    if (auroraState.loaded) {
        auroraState.entities.forEach(e => { e.show = true; });
        setSwStatus(`KP ${Number(auroraState.data.current.kp).toFixed(1)}`);
        return;
    }
    if (auroraState.fetching) return;
    auroraState.fetching = true;
    setSwStatus('…');
    try {
        const data = await fetchSpaceWeather();
        auroraState.data = data;
        setSwRow(swRowText(data));
        const kp = data?.current?.kp;
        if (kp == null) throw new Error('no current Kp in /api/space-weather');
        // The ovals are fixed at build time: magnetic midnight rotates with the
        // sun and Kp re-ingests daily, but rebuilding per tick costs ~50 trig
        // calls a frame for a layer that moves at half a pixel a minute.
        const sun = sunDirectionEcef(engine.now());
        const { north, south } = auroraOvals({ kp, sunEcef: sun });
        auroraState.entities = [north, south].map(ring => {
            const coords = [];
            for (const p of ring) coords.push(p.lon, p.lat);
            coords.push(ring[0].lon, ring[0].lat);   // close the ring
            return engine.addManagedEntity(viewer.entities.add({
                polyline: {
                    positions: Cesium.Cartesian3.fromDegreesArray(coords),
                    width: 2,
                    arcType: Cesium.ArcType.GEODESIC,
                    material: Cesium.Color.fromCssColorString(SW_COLOR).withAlpha(0.6),
                },
            }));
        });
        auroraState.loaded = true;
        auroraState.fetching = false;
        setSwStatus(`KP ${Number(kp).toFixed(1)}`);
    } catch (err) {
        console.warn('[orbital-relay] aurora layer failed:', err);
        auroraState.loaded = false;
        auroraState.fetching = false;
        setSwStatus('ERR');
    }
}

mountSpaceWeatherRows();

/* ── Orbit revolution count (plan 35 §3, S6) — authored twice: desktop panel
 * + mobile drawer, mirroring every other layers-hud control until the S11
 * registry lands. Must NOT carry class `layer-cb` (reloadAllLayers() would
 * treat it as a Celestrak layer). syncRevsButtons() queries [data-revs-label]
 * globally, so both buttons stay in sync without a checkbox-style mirror. */
syncRevsButtons(currentRevs());
wireRevsButton(document.getElementById('revs-toggle'));
wireRevsButton(document.getElementById('revs-toggle-drawer'));

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

    /* Sync drawer checkboxes with main layer checkboxes.
     * The mirroring needs an equality guard or the two handlers re-dispatch
     * at each other forever — see /shared/sync-checkbox.js. */
    const mainCheckboxes = document.querySelectorAll('#layers-hud .layer-cb');
    const drawerCheckboxes = document.querySelectorAll('#layer-list-drawer .layer-cb');

    mainCheckboxes.forEach((mainCb, i) => {
        syncCheckboxes(mainCb, drawerCheckboxes[i]);
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

// Flat, fully-lit globe — object tracking, not a day/night render. Sun-driven
// terrain lighting hid every satellite on the night hemisphere behind an
// unlit, near-black Earth; the terminator is not a tracking cue, so the globe
// is lit uniformly and the atmosphere is left static rather than sun-driven.
// See also SatEngine's eclipse pass, removed for the same reason.
viewer.scene.globe.enableLighting          = false;
viewer.scene.globe.dynamicAtmosphereLighting = false;
viewer.scene.globe.dynamicAtmosphereLightingFromSun = false;
viewer.scene.skyAtmosphere.show            = true;
viewer.scene.skyAtmosphere.hueShift        = 0.0;
viewer.scene.skyAtmosphere.saturationShift = -0.1;
viewer.scene.skyAtmosphere.brightnessShift = -0.1;

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

/* ── Cinematic quality (plan 34 §3.3, C2) ─────────────────────────────────
 * Eclipse/umbra shading lives in the SHARED engine, gated by
 * quality.cinematics in the persisted State. This page owns the toggle —
 * authored twice like revs-toggle (desktop panel + mobile drawer), kept in
 * sync by the [data-cinematics-label] global query below. First boot picks a
 * device-appropriate level and persists it: the plan warns bloom (C3, same
 * toggle) is expensive on mobile, so a phone that never opens the toggle
 * must not inherit the desktop default. */
const CINEMATICS_STATE_PATH = 'quality.cinematics';

function cinematicsLabel(level) {
    return `CINE ${level === 'high' ? 'HIGH' : 'LOW'}`;
}

function syncCinematicsButtons(level, root = document) {
    const active = level === 'high';
    root.querySelectorAll('[data-cinematics]').forEach(btn => {
        btn.classList.toggle('st-toggle-btn--on', active);
        btn.setAttribute('aria-pressed', String(active));
    });
    root.querySelectorAll('[data-cinematics-label]').forEach(el => { el.textContent = cinematicsLabel(level); });
    return level;
}

function cycleCinematics() {
    State.set(CINEMATICS_STATE_PATH,
        State.get(CINEMATICS_STATE_PATH) === 'high' ? 'low' : 'high');
}

function wireCinematicsButton(button) {
    if (!button) return;
    button.addEventListener('click', cycleCinematics);
}

/* First boot (no saved key — the default in state.js is a placeholder, not a
 * user decision): 'low' on phones, 'high' on desktop, persisted so it sticks. */
function resolveCinematics() {
    let saved = null;
    try {
        const stored = JSON.parse(localStorage.getItem(State.STORAGE_KEY) || 'null');
        const v = stored && stored.quality && stored.quality.cinematics;
        if (v === 'high' || v === 'low') saved = v;
    } catch { /* corrupt storage → device default below */ }
    if (saved) return saved;
    const level = isMobile() ? 'low' : 'high';
    State.set(CINEMATICS_STATE_PATH, level);
    return level;
}

const cinematics = resolveCinematics();
engine.setCinematics(cinematics);
syncCinematicsButtons(cinematics);
wireCinematicsButton(document.getElementById('cinematics-toggle'));
wireCinematicsButton(document.getElementById('cinematics-toggle-drawer'));
State.subscribe(CINEMATICS_STATE_PATH, (level) => {
    engine.setCinematics(level);
    syncCinematicsButtons(level);
});

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

    // After STATIONS is parsed, so the `stations-other` builtin has entities to
    // reveal; the constellation fetches inside run concurrently with the fly-in.
    bootDefaultLayers();

    updateSatBar();
    introFlyIn();
}

/* ── Click-to-inspect ──────────────────────────────────────────────────── */
const detailCard   = document.getElementById('sat-detail');
const dName        = document.getElementById('sat-detail-name');
const dNorad       = document.getElementById('sat-detail-norad');
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
let inspectedMeta      = null;

function closeInspector() {
    engine.removeEntities(inspectVisuals);
    inspectVisuals = null;
    inspectedMeta = null;
    if (inspectUpdateTimer) { clearInterval(inspectUpdateTimer); inspectUpdateTimer = null; }
    if (detailCard) detailCard.hidden = true;
}

function inspectSatellite(meta) {
    if (!meta || !meta.satrec) return;
    inspectedMeta = meta;
    engine.removeEntities(inspectVisuals);
    inspectVisuals = engine.addInspectVisuals(meta, '#ffffff', { revs: currentRevs() });

    // Populate + live-update the card
    if (dName)  dName.textContent  = `// ${meta.name}`;
    // satrec.satnum is the NORAD catalog id, parsed straight out of TLE line 1 —
    // no /spacetrack/object/{norad} fetch here (see the markup comment above:
    // Celestrak-sourced sats aren't guaranteed to resolve against that catalog).
    if (dNorad) dNorad.textContent = meta.satrec.satnum != null ? `NORAD ${meta.satrec.satnum}` : '—';
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

State.subscribe(REVS_STATE_PATH, () => {
    if (!inspectedMeta) return;
    engine.removeEntities(inspectVisuals);
    inspectVisuals = engine.addInspectVisuals(inspectedMeta, '#ffffff', { revs: currentRevs() });
});

// Pick handler — click a satellite dot to inspect it. Sat points are
// PointPrimitives whose `.id` is the SatPoint wrapper (carries `.meta`).
const clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
clickHandler.setInputAction((movement) => {
    const sat = engine.pickSat(viewer.scene.pick(movement.position));
    if (sat) inspectSatellite(sat.meta);
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

/* ── Time-warp controls ────────────────────────────────────────────────── */
document.querySelectorAll('.tw-btn[data-rate]').forEach(btn => {
    btn.addEventListener('click', () => {
        const rate = parseInt(btn.dataset.rate, 10);
        if (rate === 0) {
            clock.shouldAnimate = false;
        } else {
            clock.shouldAnimate = true;
            clock.multiplier    = rate;
        }
        document.querySelectorAll('.tw-btn[data-rate]').forEach(b =>
            b.classList.toggle('tw-btn--active', b === btn));
    });
});

/* ── Recenter ───────────────────────────────────────────────────────────── */
document.getElementById('recenter-btn')?.addEventListener('click', () => flyHome(viewer));

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

async function toggleLayer(group, color, cap, checked, live, { fly = true } = {}) {
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
        if (fly) engine.flyToSats(state.entities);
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
        if (fly) engine.flyToSats(entities);
    } catch (err) {
        console.warn(`[orbital-relay] Layer "${group}" fetch failed:`, err);
        layerState[group] = { entities: [], loaded: false, fetching: false };
        if (statusEl) statusEl.textContent = 'ERR';
    }
}

/**
 * Load the layers `layers.js` flags `on`, honouring the checked state the
 * registry already rendered.
 *
 * Checking a box in markup fires no `change` event, so without this the page
 * booted with boxes ticked and nothing behind them. `fly: false` matters as
 * much as the fetch: `toggleLayer` normally flies the camera to the layer it
 * just loaded, which is right for a user click and wrong at boot — three
 * layers resolving out of order would fight introFlyIn() and each other for
 * the camera. The fly-in owns the camera at startup; these just populate.
 */
function bootDefaultLayers() {
    document.querySelectorAll('#layer-list .layer-cb').forEach(cb => {
        if (!cb.checked) return;
        const group = cb.dataset.group;

        if (cb.dataset.builtin === 'true') {
            // Builtins have no fetch of their own — STATIONS is already loaded
            // by loadSatellites(), so this only reveals what is there.
            if (group === 'stations-other') {
                stationEntities.forEach(e => {
                    e.show = true;
                    engine.ensureRing(e);
                });
                if (stStatusEl) stStatusEl.textContent = stationEntities.length;
                updateSatBar();
            } else if (group === 'aurora') {
                toggleAurora(true);
            }
            return;
        }

        toggleLayer(group, cb.dataset.color, parseInt(cb.dataset.cap, 10),
                    true, undefined, { fly: false });
    });
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
            } else if (group === 'aurora') {
                toggleAurora(cb.checked);
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
    state: State,
    satCollection: engine.satCollection,
    allSats: engine.allSats,
    layerState,
    stationEntities,
    auroraState,
    get satPointCount() { return engine.satPointCount; },
    get entityCount()   { return viewer.entities.values.length; },
    get booted()        { return engine.allSats.length > 0; },
    get worker()        { return engine.worker; },
    get workerReady()   { return engine.workerReady; },
    get registered()    { return engine.registered; },
    get tickCount()     { return engine.tickCount; },
    get source()        { return SOURCE; },
    get cinematics()    { return engine.cinematics; },
    disableWorker:      (why) => engine.disableWorker(why),
    propagateAllSats:     () => engine.propagate(),
    propagateAllSatsSync: () => engine.propagateSync(),
    inspectSatellite,
    toggleLayer,
    toggleAurora,
    fetchTLE: (group, live) => fetchTLE(group, { source: SOURCE, live }),
    parseTLE,
};

/* ── Boot ────────────────────────────────────────────────────────────────
 * loadSatellites() is kicked off at the top of the module (see there) so the
 * STATIONS fetch overlaps the Cesium Viewer construction below.
 */
