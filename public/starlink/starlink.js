/**
 * STARLINK CONSTELLATION — dedicated Starlink satellite tracker.
 *
 * CesiumJS 3D globe with the full Starlink constellation rendered from
 * Celestrak group TLE data. Reuses the shared orbit-engine for propagation
 * and rendering.
 */

import { SatEngine, SatPoint, tuneViewerForDevice, mountCameraAltitudeHud } from '/orbit-engine/sat-engine.js';
import { parseTLE, fetchTLE }  from '/orbit-engine/tle.js';
import {
    orbitalPeriodMin, orbitRegime, orbVel, fmtLat, fmtLon,
} from '/orbit-engine/astro.js';
import { wireHudToggle, initMobileListener } from '/shared/hud.js';

/* ── Token + constants ─────────────────────────────────────────────────── */
Cesium.Ion.defaultAccessToken =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
    'eyJqdGkiOiI2MjFjZDg5My0zMTRiLTQ3ZjMtOTNlNi1iM2E3ZGNjYWE5ZTQiLCJpZCI6MzkzOTM1LCJpYXQiOjE3NzE5Nzk4NTd9.' +
    'eAH51ApKzzuBIkgwf-rqo4G2U6cSBOQMTPFAALBb2Hg';

const SAT_CAP_DEFAULT = 40;
const SAT_CAP_MAX     = 600;
const SAT_CAP_FULL    = 8000;

const slAllRecords  = [];
const slEntities    = [];
let   slActiveCount = SAT_CAP_DEFAULT;
let   slFullLoaded  = false;

const SOURCE = 'celestrak';
const tle = (group, live) => fetchTLE(group, { source: SOURCE, live });

/* ── HUD toggle ──────────────────────────────────────────────────────── */
wireHudToggle('stats-hud',   'stats-hud-toggle',   'stats-hud-body');
wireHudToggle('density-hud', 'density-hud-toggle',  'density-hud-body');

/* ── Cesium Viewer ─────────────────────────────────────────────────── */
const viewer = new Cesium.Viewer('cesium-container', {
    animation:             false,
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

window.viewer = viewer;
tuneViewerForDevice(viewer);
mountCameraAltitudeHud(viewer, document.getElementById('cam-alt'));

viewer.scene.globe.enableLighting          = true;
viewer.scene.globe.dynamicAtmosphereLighting = true;
viewer.scene.globe.dynamicAtmosphereLightingFromSun = true;
viewer.scene.skyAtmosphere.show            = true;
viewer.scene.skyAtmosphere.hueShift        = 0.0;
viewer.scene.skyAtmosphere.saturationShift = -0.1;
viewer.scene.skyAtmosphere.brightnessShift = -0.1;
viewer.scene.globe.nightFadeOutDistance = 1.0e7;
viewer.scene.globe.nightFadeInDistance  = 5.0e7;

viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(
    Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK
);

viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(20, 25, 40000000),
});

const clock = viewer.clock;
clock.shouldAnimate = true;
clock.multiplier    = 1;

/* ── Engine ────────────────────────────────────────────────────────── */
const engine = new SatEngine({ viewer });

initMobileListener(() => {
    tuneViewerForDevice(viewer);
    engine.requestRender();
});

/* ── HUD elements ──────────────────────────────────────────────────── */
const elCount    = document.getElementById('hud-sat-count');
const elLoaded   = document.getElementById('sl-loaded');
const elRendered = document.getElementById('sl-rendered');
const elAvgAlt   = document.getElementById('sl-avg-alt');
const elAvgPeriod = document.getElementById('sl-avg-period');
const elAvgVel   = document.getElementById('sl-avg-vel');

/* ── Stats ─────────────────────────────────────────────────────────── */
function updateStats() {
    if (elLoaded) elLoaded.textContent = slAllRecords.length;
    if (elRendered) elRendered.textContent = slActiveCount;
    if (elCount) elCount.textContent = slActiveCount;

    if (slAllRecords.length === 0) return;

    let totalAlt = 0, totalPeriod = 0, totalVel = 0;
    let count = 0;
    for (let i = 0; i < Math.min(slActiveCount, slAllRecords.length); i++) {
        const rec = slAllRecords[i];
        const p = engine.geo(rec.satrec);
        if (p) {
            totalAlt += p.alt;
            totalPeriod += orbitalPeriodMin(rec.satrec);
            totalVel += orbVel(p.alt);
            count++;
        }
    }
    if (count > 0) {
        if (elAvgAlt) elAvgAlt.textContent = `${Math.round(totalAlt / count)} km`;
        if (elAvgPeriod) elAvgPeriod.textContent = `${(totalPeriod / count).toFixed(1)} min`;
        if (elAvgVel) elAvgVel.textContent = `${(totalVel / count).toFixed(2)} km/s`;
    }
}
engine.own(setInterval(updateStats, 2000));

window.addEventListener('beforeunload', () => engine.destroy());

/* ── Starlink panel: slider + fetch-all ────────────────────────────── */
const slSlider       = document.getElementById('sl-slider');
const slCountDisplay = document.getElementById('sl-count-display');
const slTotalDisplay = document.getElementById('sl-total-display');
const slLabelMax     = document.getElementById('sl-label-max');
const slFetchAllBtn  = document.getElementById('sl-fetch-all');
const slFetchHint    = document.getElementById('sl-fetch-hint');

const slColor = Cesium.Color.fromCssColorString('#00ccff');

function spawnStarlink(i) {
    const rec = slAllRecords[i];
    return engine.addSatellite(rec.satrec, slColor, 4, false,
        { satrec: rec.satrec, l1: rec.l1, l2: rec.l2,
          name: rec.name, group: 'STARLINK', pulse: false });
}

function updateStarlinkCount(n) {
    slActiveCount = Math.max(SAT_CAP_DEFAULT, Math.min(n, slAllRecords.length));

    for (let i = slEntities.length; i < slActiveCount; i++) {
        slEntities.push(spawnStarlink(i));
    }
    for (let i = 0; i < slEntities.length; i++) {
        slEntities[i].show = i < slActiveCount;
    }

    if (slCountDisplay) slCountDisplay.textContent = slActiveCount;
    updateStats();
}

if (slSlider) {
    slSlider.addEventListener('input', () => {
        updateStarlinkCount(parseInt(slSlider.value, 10));
    });
}

if (slFetchAllBtn) {
    slFetchAllBtn.addEventListener('click', async () => {
        if (slFullLoaded || slFetchAllBtn.disabled) return;
        slFetchAllBtn.disabled = true;
        slFetchAllBtn.textContent = '… FETCHING LIVE …';
        try {
            const text   = await tle('STARLINK', true);
            const parsed = parseTLE(text).slice(0, SAT_CAP_FULL);
            if (parsed.length > slAllRecords.length) {
                for (let i = slAllRecords.length; i < parsed.length; i++) {
                    slAllRecords.push(parsed[i]);
                }
            }
            slFullLoaded = true;
            if (slSlider)       slSlider.max = slAllRecords.length;
            if (slLabelMax)     slLabelMax.textContent = slAllRecords.length;
            if (slTotalDisplay) slTotalDisplay.textContent = slAllRecords.length;
            slFetchAllBtn.textContent = `✓ ${slAllRecords.length} LOADED`;
            slFetchAllBtn.classList.add('is-loaded');
            if (slFetchHint) slFetchHint.textContent = 'slide right to render more';
        } catch (err) {
            console.warn('[starlink] fetch-all failed:', err);
            slFetchAllBtn.disabled = false;
            slFetchAllBtn.textContent = '⬇ RETRY FETCH';
            if (slFetchHint) slFetchHint.textContent = 'fetch failed — try again';
        }
    });
}

/* ── Load TLE data ─────────────────────────────────────────────────── */
async function loadSatellites() {
    if (elCount) elCount.textContent = 'INITIALIZING…';

    try {
        const text = await tle('STARLINK');
        const parsed = parseTLE(text).slice(0, SAT_CAP_MAX);
        slAllRecords.push(...parsed);
        if (slSlider)       slSlider.max = slAllRecords.length;
        if (slLabelMax)     slLabelMax.textContent = slAllRecords.length;
        if (slTotalDisplay) slTotalDisplay.textContent = slAllRecords.length;
        for (let i = 0; i < SAT_CAP_DEFAULT && i < slAllRecords.length; i++) {
            slEntities.push(spawnStarlink(i));
        }
        slActiveCount = SAT_CAP_DEFAULT;
    } catch (err) {
        console.warn('[starlink] STARLINK fetch failed:', err);
    }

    updateStats();
    introFlyIn();
}

/* ── Click-to-inspect ──────────────────────────────────────────────── */
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

const clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
clickHandler.setInputAction((movement) => {
    const picked = viewer.scene.pick(movement.position);
    if (picked && picked.id instanceof SatPoint) {
        inspectSatellite(picked.id.meta);
    }
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

/* ── Time-warp controls ────────────────────────────────────────────── */
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

/* ── Fly-to cinematics ─────────────────────────────────────────────── */
function introFlyIn() {
    viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(20, 25, 22000000),
        duration: 2.6,
        easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
    });
}

/* ── Debug handle ──────────────────────────────────────────────────── */
window.__starlink = {
    viewer,
    engine,
    satCollection: engine.satCollection,
    allSats: engine.allSats,
    slEntities,
    get satPointCount() { return engine.satPointCount; },
    get entityCount()   { return viewer.entities.values.length; },
    get booted()        { return engine.allSats.length > 0; },
    get worker()        { return engine.worker; },
    get workerReady()   { return engine.workerReady; },
    get registered()    { return engine.registered; },
    get tickCount()     { return engine.tickCount; },
    get source()        { return SOURCE; },
    inspectSatellite,
    fetchTLE: (group, live) => fetchTLE(group, { source: SOURCE, live }),
    parseTLE,
};

/* ── Boot ──────────────────────────────────────────────────────────── */
loadSatellites();
