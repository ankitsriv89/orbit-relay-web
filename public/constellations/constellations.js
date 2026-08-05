/**
 * CONSTELLATION VIEW — orbital-plane view of the five major constellations.
 *
 * Plan 34 §3.2 (spec #7). The view groups a constellation's satellites into
 * orbital planes (compute.js's `groupConstellation`: inclination shells
 * first, then RAAN gaps per shell), draws each plane as a two-ring glow
 * great-circle ring at the shell altitude the plane occupies, and renders
 * the satellites on top. A density slider caps how many of the full set are
 * drawn (progressive fill across planes, plane-major), a plane-list HUD
 * flies the camera to any plane's ring, and the selector bar switches
 * constellation — Starlink / OneWeb / GPS / Galileo / Iridium.
 *
 * Data: Celestrak group TLEs via /api/tle (the same path /starlink/ uses),
 * parsed client-side. The full bundle is fetched at boot for every
 * constellation — the density slider's max needs the total from the start,
 * so there is deliberately NO fetch-all button (unlike /starlink/'s).
 *
 * Rings are Earth-fixed schematics of the inertial orbital plane, exactly
 * like the GEO belt and the regime shells — see compute.js's frame notes.
 */

import { SatEngine, tuneViewerForDevice, mountCameraAltitudeHud, flyHome } from '/orbit-engine/sat-engine.js';
import { parseTLE, parseTLEChunked, fetchTLE } from '/orbit-engine/tle.js';
import {
    orbitalPeriodMin, orbitRegime, orbVel, fmtLat, fmtLon,
} from '/orbit-engine/astro.js';
import {
    wireHudToggle, initMobileListener, initHamburgerMenu,
    wireRevsButton, syncRevsButtons, currentRevs, REVS_STATE_PATH,
} from '/shared/hud.js';
import { State } from '/spacetrack/shared/state.js';
import { planeElements, groupConstellation, planeRingDeg } from './compute.js';

/* ── Token + constants ─────────────────────────────────────────────────── */
Cesium.Ion.defaultAccessToken =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
    'eyJqdGkiOiI2MjFjZDg5My0zMTRiLTQ3ZjMtOTNlNi1iM2E3ZGNjYWE5ZTQiLCJpZCI6MzkzOTM1LCJpYXQiOjE3NzE5Nzk4NTd9.' +
    'eAH51ApKzzuBIkgwf-rqo4G2U6cSBOQMTPFAALBb2Hg';

const DENSITY_MIN  = 40;
const DENSITY_STEP = 10;

/* Re-declared here (not exported from regime-shells.js): the shell palette
   the product already uses for its regime rings, so the plane rings and the
   satellite dots line up with every other shell drawing in the product. */
const SHELL_COLORS = {
    LEO: '#4ee2ff',
    MEO: '#8effa0',
    GEO: '#ffe066',
    HEO: '#ff6ec7',
};

const CONSTELLATIONS = {
    starlink: { label: 'STARLINK', group: 'starlink' },
    oneweb:   { label: 'ONEWEB',   group: 'oneweb' },
    gps:      { label: 'GPS',      group: 'gps-ops' },
    galileo:  { label: 'GALILEO',  group: 'galileo' },
    iridium:  { label: 'IRIDIUM',  group: 'iridium-NEXT' },
};

const SOURCE = 'celestrak';

/* Per-constellation parsed bundles — kept across switches so toggling back
   and forth never refetches. Each entry: { records, entries, planes,
   renderOrder, planeOf }. */
const cache = {};

let currentKey  = null;
let currentData = null;
let satEntities = [];
let ringEntities = [];
let activeCount = 0;

/* ── HUD toggles + mobile nav ──────────────────────────────────────────── */
wireHudToggle('stats-hud',  'stats-hud-toggle',  'stats-hud-body');
wireHudToggle('planes-hud', 'planes-hud-toggle', 'planes-hud-body');
wireHudToggle('density-hud', 'density-hud-toggle', 'density-hud-body');
initHamburgerMenu();

/* ── Orbit revolution count (plan 35 §3, S6) ──────────────────────────────── */
syncRevsButtons(currentRevs());
wireRevsButton(document.getElementById('revs-toggle'));

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

/* One shared Cesium.Color per shell — the engine snapshots the components,
   so a shared instance is safe (starlink.js passes one instance for the
   whole layer the same way). */
const colorCache = {};
function shellColor(shell) {
    return colorCache[shell] || (colorCache[shell] =
        Cesium.Color.fromCssColorString(SHELL_COLORS[shell] || SHELL_COLORS.LEO));
}

/* ── HUD elements ──────────────────────────────────────────────────── */
const elCount      = document.getElementById('hud-sat-count');
const elLabel      = document.getElementById('hud-sat-label');
const elLoaded     = document.getElementById('ct-loaded');
const elRendered   = document.getElementById('ct-rendered');
const elPlanes     = document.getElementById('ct-planes');
const elAvgAlt     = document.getElementById('ct-avg-alt');
const elAvgPeriod  = document.getElementById('ct-avg-period');
const planesList   = document.getElementById('planes-list');

/* ── Stats ─────────────────────────────────────────────────────────── */
function updateStats() {
    if (elLoaded) elLoaded.textContent = currentData ? currentData.records.length : '—';
    if (elRendered) elRendered.textContent = activeCount;
    if (elPlanes) elPlanes.textContent = currentData ? currentData.planes.length : '—';
    if (elCount) elCount.textContent = activeCount;

    if (!currentData || currentData.records.length === 0) return;

    let totalAlt = 0, totalPeriod = 0;
    let count = 0;
    for (let i = 0; i < activeCount && i < satEntities.length; i++) {
        const sat = satEntities[i];
        const p = engine.geo(sat.satrec);
        if (p) {
            totalAlt += p.alt;
            totalPeriod += orbitalPeriodMin(sat.satrec);
            count++;
        }
    }
    if (count > 0) {
        if (elAvgAlt) elAvgAlt.textContent = `${Math.round(totalAlt / count)} km`;
        if (elAvgPeriod) elAvgPeriod.textContent = `${(totalPeriod / count).toFixed(1)} min`;
    }
}
engine.own(setInterval(updateStats, 2000));

window.addEventListener('beforeunload', () => engine.destroy());

/* ── Data load + grouping ───────────────────────────────────────────── */

async function fetchAndGroup(def) {
    const text = await fetchTLE(def.group, { source: SOURCE, live: true });
    if (!text) throw new Error(`no TLE data for ${def.group}`);
    // ~8000 Starlink TLEs chunk through idle frames; the other four bundles
    // are a few hundred lines and parse synchronously.
    const records = def.group === 'starlink' ? await parseTLEChunked(text) : parseTLE(text);

    const entries = records.map(r => ({
        ...planeElements({
            raanRad: r.satrec.nodeo,
            inclRad: r.satrec.inclo,
            noRadPerMin: r.satrec.no,
        }),
        rec: r,
    }));

    const planes = groupConstellation(entries);
    planes.forEach((p, i) => {
        p.index = i;
        p.label = `P${String(i + 1).padStart(2, '0')}`;
    });

    // Progressive-fill order: planes sorted by RAAN (groupConstellation's
    // return order), then their members — so any density cap spreads across
    // every plane instead of draining one plane's full shell first.
    const renderOrder = [];
    const planeOf = new Map();
    for (const p of planes) {
        for (const m of p.members) {
            renderOrder.push(m);
            planeOf.set(m, p);
        }
    }

    return { records, entries, planes, renderOrder, planeOf };
}

/* ── Rings ──────────────────────────────────────────────────────────── */

function buildRings(planes) {
    for (const p of planes) {
        const positions = planeRingDeg({ raanDeg: p.raanDeg, inclDeg: p.inclDeg, radiusKm: p.smaKm }, 180)
            .map(pt => Cesium.Cartesian3.fromDegrees(pt.lon, pt.lat, p.smaKm * 1000));
        p.ringPositions = positions;
        const color = shellColor(p.shell);
        ringEntities.push(engine.addManagedEntity(viewer.entities.add({
            polyline: {
                positions,
                width: 1.2,
                material: new Cesium.PolylineGlowMaterialProperty({
                    glowPower: 0.15,
                    color: color.withAlpha(0.25),
                }),
                arcType: Cesium.ArcType.NONE,
            },
        })));
        ringEntities.push(engine.addManagedEntity(viewer.entities.add({
            polyline: {
                positions,
                width: 0.6,
                material: new Cesium.PolylineGlowMaterialProperty({
                    glowPower: 0.08,
                    color: color.withAlpha(0.12),
                }),
                arcType: Cesium.ArcType.NONE,
            },
        })));
    }
    engine.requestRender();
}

/* ── Planes list HUD ────────────────────────────────────────────────── */

function renderPlanesList(planes) {
    if (!planesList) return;
    planesList.textContent = '';
    for (const p of planes) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'plane-row';
        row.setAttribute('role', 'option');
        row.setAttribute('aria-label', `Plane ${p.label}, RAAN ${Math.round(p.raanDeg)} degrees, ${p.count} satellites, ${p.shell}`);
        const id = document.createElement('span');
        id.className = 'plane-row__id';
        id.textContent = p.label;
        const raan = document.createElement('span');
        raan.className = 'plane-row__raan';
        raan.textContent = ` · RAAN ${Math.round(p.raanDeg)}°`;
        const meta = document.createElement('span');
        meta.className = 'plane-row__meta';
        meta.textContent = ` · ${p.count} · ${p.shell}`;
        row.append(id, raan, meta);
        row.addEventListener('click', () => flyToPlane(p));
        planesList.appendChild(row);
    }
}

/* ── Satellite rendering (density cap) ──────────────────────────────── */

function renderSats(data, n) {
    if (!data) return;
    const count = Math.max(DENSITY_MIN, Math.min(n, data.records.length));

    for (let i = satEntities.length; i < count; i++) {
        const recIdx = data.renderOrder[i];
        const rec = data.records[recIdx];
        const plane = data.planeOf.get(recIdx);
        satEntities.push(engine.addSatellite(rec.satrec, shellColor(plane.shell), 3, false, {
            satrec: rec.satrec,
            l1: rec.l1,
            l2: rec.l2,
            name: rec.name,
            group: CONSTELLATIONS[currentKey].label,
            plane,
            norad: rec.satrec.satnum,
            pulse: false,
        }));
    }
    for (let i = 0; i < satEntities.length; i++) {
        satEntities[i].show = i < count;
    }

    activeCount = count;
    if (elCount) elCount.textContent = activeCount;
    updateStats();
}

/* ── Fly-to-plane ───────────────────────────────────────────────────── */

function flyToPlane(plane) {
    if (!plane || !plane.ringPositions || !plane.ringPositions.length) return;
    const sphere = Cesium.BoundingSphere.fromPoints(plane.ringPositions);
    viewer.camera.flyToBoundingSphere(sphere, {
        duration: 1.8,
        offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-55),
                                             sphere.radius * 3.0),
    });
}

/* ── Constellation switching ────────────────────────────────────────── */

const elSlider = document.getElementById('ct-slider');
const elCountDisplay = document.getElementById('ct-count-display');
const elTotalDisplay = document.getElementById('ct-total-display');
const elLabelMax = document.getElementById('ct-label-max');

function clearScene() {
    closeInspector();
    for (const e of ringEntities) engine.removeManagedEntity(e);
    ringEntities = [];
    for (const s of satEntities) engine.removeSat(s);
    satEntities = [];
    activeCount = 0;
    if (planesList) planesList.textContent = '';
    engine.requestRender();
}

async function loadConstellation(key) {
    const def = CONSTELLATIONS[key];
    if (!def) return;
    document.querySelectorAll('.constellation-selector__btn').forEach(b => {
        const on = b.dataset.constellation === key;
        b.classList.toggle('constellation-selector__btn--active', on);
        b.setAttribute('aria-pressed', String(on));
    });
    if (currentKey === key && currentData) return;

    currentKey = key;
    currentData = null;
    clearScene();
    if (elCount) elCount.textContent = 'INITIALIZING…';
    if (elLabel) elLabel.textContent = def.label;

    try {
        const data = cache[key] || (cache[key] = await fetchAndGroup(def));
        currentData = data;

        if (elSlider) {
            elSlider.max = data.records.length;
            elSlider.value = Math.max(DENSITY_MIN, Math.min(parseInt(elSlider.value, 10) || DENSITY_MIN, data.records.length));
        }
        if (elLabelMax) elLabelMax.textContent = data.records.length;
        if (elTotalDisplay) elTotalDisplay.textContent = data.records.length;
        if (elCountDisplay) elCountDisplay.textContent = elSlider ? elSlider.value : DENSITY_MIN;

        buildRings(data.planes);
        renderPlanesList(data.planes);
        renderSats(data, elSlider ? parseInt(elSlider.value, 10) : DENSITY_MIN);
    } catch (err) {
        console.warn(`[constellations] ${def.group} load failed:`, err);
    }

    introFlyIn();
}

if (elSlider) {
    elSlider.addEventListener('input', () => {
        const n = parseInt(elSlider.value, 10);
        if (elCountDisplay) elCountDisplay.textContent = n;
        renderSats(currentData, n);
    });
}

document.querySelectorAll('.constellation-selector__btn').forEach(btn => {
    btn.addEventListener('click', () => loadConstellation(btn.dataset.constellation));
});

/* ── Click-to-inspect ──────────────────────────────────────────────── */
const detailCard   = document.getElementById('sat-detail');
const dName        = document.getElementById('sat-detail-name');
const dGroup       = document.getElementById('sat-detail-group');
const dPlane       = document.getElementById('sat-detail-plane');
const dNorad       = document.getElementById('sat-detail-norad');
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

    if (dName)  dName.textContent  = `// ${meta.name}`;
    if (dGroup) dGroup.textContent = meta.group || '—';
    if (dPlane && meta.plane) {
        dPlane.textContent = `${meta.plane.label} · RAAN ${Math.round(meta.plane.raanDeg)}° · ${meta.plane.count} · ${meta.plane.shell}`;
    }
    if (dNorad) dNorad.textContent = `NORAD ${meta.satrec.satnum}`;
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

const clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
clickHandler.setInputAction((movement) => {
    const sat = engine.pickSat(viewer.scene.pick(movement.position));
    if (sat) inspectSatellite(sat.meta);
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

/* ── Time-warp controls ────────────────────────────────────────────── */
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

/* ── Recenter ──────────────────────────────────────────────────────── */
document.getElementById('recenter-btn')?.addEventListener('click', () => flyHome(viewer));

/* ── Fly-to cinematics ─────────────────────────────────────────────── */
function introFlyIn() {
    viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(20, 25, 22000000),
        duration: 2.6,
        easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
    });
}

/* ── Debug handle ──────────────────────────────────────────────────── */
window.__constellations = {
    viewer,
    engine,
    satCollection: engine.satCollection,
    allSats: engine.allSats,
    get satEntities() { return satEntities; },
    get ringEntities() { return ringEntities; },
    get records() { return currentData ? currentData.records : []; },
    get entries() { return currentData ? currentData.entries : []; },
    get planes() { return currentData ? currentData.planes : []; },
    get activeCount() { return activeCount; },
    get currentKey() { return currentKey; },
    get satPointCount() { return engine.satPointCount; },
    get entityCount() { return viewer.entities.values.length; },
    get booted() { return engine.allSats.length > 0; },
    get worker() { return engine.worker; },
    get workerReady() { return engine.workerReady; },
    get registered() { return engine.registered; },
    get tickCount() { return engine.tickCount; },
    get source() { return SOURCE; },
    inspectSatellite,
    flyToPlane,
    loadConstellation,
    groupConstellation,
    fetchTLE: (group, live) => fetchTLE(group, { source: SOURCE, live }),
    parseTLE,
};

/* ── Boot ──────────────────────────────────────────────────────────── */
const preset = new URLSearchParams(location.search).get('c');
loadConstellation(CONSTELLATIONS[preset] ? preset : 'starlink');
