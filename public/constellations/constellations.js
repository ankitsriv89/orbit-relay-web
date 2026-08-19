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
 * Data: Celestrak group TLEs via /api/tle (the same path /orbit/ uses),
 * parsed client-side. The full bundle is fetched at boot for every
 * constellation — the density slider's max needs the total from the start,
 * so there is deliberately NO fetch-all button.
 *
 * Rings are Earth-fixed schematics of the inertial orbital plane, exactly
 * like the GEO belt and the regime shells — see compute.js's frame notes.
 */

import { SatEngine, tuneViewerForDevice, tuneBaseImagery, mountCameraAltitudeHud, flyHome } from '/orbit-engine/sat-engine.js';
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
import { shapeForShell } from '/orbit-engine/markers.js';

/* ── Constants ──────────────────────────────────────────────────────────── */
// Dot-tracking view, not a photorealistic map — the CesiumJS-bundled offline
// NaturalEarthII tileset + a plain ellipsoid need no Cesium ion account/token.
const baseLayer = Cesium.ImageryLayer.fromProviderAsync(
    Cesium.TileMapServiceImageryProvider.fromUrl(
        Cesium.buildModuleUrl('Assets/Textures/NaturalEarthII')
    )
);

/* Density slider defaults. DENSITY_MIN is the *desired* floor, not a hard
   one: GPS (32) and Galileo (~30) have fewer objects than 40, so the real
   min is `min(DENSITY_MIN, total)` per constellation. Clamping up to a
   fixed 40 walked renderOrder past its end and threw, which loadConstellation's
   catch swallowed into a silent empty globe. */
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

/* `label` is the HUD/bottom-bar token (all caps, reads as "TRACKING n STARLINK
   SATELLITES"); `title` is the prose form used in <title> and the nav link, so
   the tab and the address bar name the constellation currently on screen. */
const CONSTELLATIONS = {
    starlink: { label: 'STARLINK', title: 'Starlink',  group: 'starlink' },
    oneweb:   { label: 'ONEWEB',   title: 'OneWeb',    group: 'oneweb' },
    gps:      { label: 'GPS',      title: 'GPS',       group: 'gps-ops' },
    galileo:  { label: 'GALILEO',  title: 'Galileo',   group: 'galileo' },
    iridium:  { label: 'IRIDIUM',  title: 'Iridium',   group: 'iridium-NEXT' },
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
let ringsVisible = true;

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
    terrainProvider:       new Cesium.EllipsoidTerrainProvider(),
});

window.viewer = viewer;
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
// See tuneBaseImagery: the additive atmosphere rim over the bright offline
// imagery left a blown-out cyan halo at the old -0.1.
viewer.scene.skyAtmosphere.brightnessShift = -0.45;

// Tone the bright NaturalEarthII base texture down under the deliberately
// unlit globe above — imagery-layer dials, not lighting. See sat-engine.js.
tuneBaseImagery(viewer);

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
            show: ringsVisible,
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
            show: ringsVisible,
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

function setRingsVisible(visible) {
    ringsVisible = visible;
    for (const e of ringEntities) e.show = visible;
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
    /* Clamp DOWN to what exists first. renderOrder has exactly records.length
       entries, so any count above it indexes undefined and throws. */
    const total = data.records.length;
    const count = Math.min(Math.max(1, Math.trunc(n) || 1), total);

    for (let i = satEntities.length; i < count; i++) {
        const recIdx = data.renderOrder[i];
        const rec = data.records[recIdx];
        const plane = data.planeOf.get(recIdx);
        /* 5, not 3: at 3 these dots were ~3 screen px against ~1.5px star
           cores, close enough that the two read as the same mark. /orbit/
           already used 5 for its sats.

           `shape` is what actually separates them: a star is always round, so
           an angular marker cannot be mistaken for one however small it gets.
           Shaped by orbit shell, the same axis the colour already encodes —
           see SHELL_SHAPE in markers.js. */
        satEntities.push(engine.addSatellite(rec.satrec, shellColor(plane.shell), 5, false, {
            shape: shapeForShell(plane.shell),
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
const elLabelMin = document.getElementById('ct-label-min');

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

/* Keep ?c= and the document title in step with the active tab, so the address
   bar is always a shareable deep link to what is actually on screen and Back
   walks the tabs. replaceState on the initial load (the URL already says what
   we are showing); pushState only on a real user switch. */
function syncLocation(key, def, { push }) {
    document.title = `${def.title} — Orbital Plane View`;
    const url = `${location.pathname}?c=${encodeURIComponent(key)}${location.hash}`;
    if (push) history.pushState({ c: key }, '', url);
    else history.replaceState({ c: key }, '', url);
}

async function loadConstellation(key, { push = true } = {}) {
    const def = CONSTELLATIONS[key];
    if (!def) return;
    document.querySelectorAll('.constellation-selector__btn').forEach(b => {
        const on = b.dataset.constellation === key;
        b.classList.toggle('constellation-selector__btn--active', on);
        b.setAttribute('aria-pressed', String(on));
    });
    syncLocation(key, def, { push: push && currentKey !== null && currentKey !== key });
    if (currentKey === key && currentData) return;

    currentKey = key;
    currentData = null;
    clearScene();
    if (elCount) elCount.textContent = 'INITIALIZING…';
    if (elLabel) elLabel.textContent = def.label;

    try {
        const data = cache[key] || (cache[key] = await fetchAndGroup(def));
        currentData = data;

        /* Per-constellation range: a constellation smaller than DENSITY_MIN
           (GPS 32, Galileo ~30) gets min === max === total, so the slider is
           a no-op rather than a request for satellites that do not exist. */
        const total = data.records.length;
        const min   = Math.min(DENSITY_MIN, total);
        if (elSlider) {
            elSlider.min  = min;
            elSlider.max  = total;
            elSlider.step = Math.max(1, Math.min(DENSITY_STEP, total - min));
            const prev = parseInt(elSlider.value, 10);
            elSlider.value = Math.min(Math.max(Number.isFinite(prev) ? prev : min, min), total);
        }
        if (elLabelMin) elLabelMin.textContent = min;
        if (elLabelMax) elLabelMax.textContent = total;
        if (elTotalDisplay) elTotalDisplay.textContent = total;
        if (elCountDisplay) elCountDisplay.textContent = elSlider ? elSlider.value : min;

        buildRings(data.planes);
        renderPlanesList(data.planes);
        renderSats(data, elSlider ? parseInt(elSlider.value, 10) : min);
    } catch (err) {
        console.warn(`[constellations] ${def.group} load failed:`, err);
        /* Surface it. This catch previously left the bar on INITIALIZING…
           forever, which is how a hard TypeError in renderSats read as
           "there is nothing to show" instead of "this broke". */
        if (elCount) elCount.textContent = 'LOAD FAILED';
    }

    /* currentData, not the local `data`: on the failure path there is none, and
       flyInAltitude falls back to the LEO framing rather than throwing. */
    introFlyIn(currentData);
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

const ringsToggle = document.getElementById('rings-toggle');
if (ringsToggle) {
    ringsToggle.addEventListener('click', () => {
        setRingsVisible(!ringsVisible);
        ringsToggle.textContent = ringsVisible ? 'ON' : 'OFF';
        ringsToggle.classList.toggle('st-toggle-btn--on', ringsVisible);
        ringsToggle.setAttribute('aria-pressed', String(ringsVisible));
    });
}

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
/* `exclusive: 'never'` — the time bar is a persistent control, not one of the
   mutually-exclusive corner panels, so opening it must not close stats/planes
   (same call /spacetrack/'s shared/globe.js makes). */
wireHudToggle('time-warp', 'time-warp-toggle', 'time-warp-body', { exclusive: 'never' });

/* The collapsed toggle still has to say what rate is running, or pausing then
   collapsing leaves no indication the clock is stopped. */
const elCurrentRate = document.getElementById('tw-current-rate');
function syncCurrentRateChip(rate) {
    if (elCurrentRate) elCurrentRate.textContent = rate === 0 ? '❚❚' : `${rate}×`;
}

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
        syncCurrentRateChip(rate);
    });
});

/* ── Recenter ──────────────────────────────────────────────────────── */
document.getElementById('recenter-btn')?.addEventListener('click', () => flyHome(viewer));

/* ── Fly-to cinematics ─────────────────────────────────────────────── */

/* The fly-in altitude is DERIVED from the constellation being shown, never
   fixed. It used to be a hardcoded 22,000 km, which frames LEO — Starlink
   (~550 km) and OneWeb (~1,200 km) fill the screen at it. GPS (~20,200 km)
   and Galileo (~23,200 km) are MEO: their shells sit at or beyond that camera,
   so the sats flew off the edges and only ~9 of 32 landed on the canvas, in
   the corners behind the HUD panels. The plane rings still drew, sweeping off
   screen, which is what made it read as "the tab renders nothing" rather than
   "the camera is inside the shell."

   The framing ratio is GEOMETRY, not a tuned constant. What has to fit is the
   plane RING, whose great circle extends a full shell radius r in every
   direction from Earth's centre — so the camera distance d from centre must
   satisfy r/d <= tan(halfFov), i.e. d = r / tan(halfFov). A tuned multiplier
   is what produced the first attempt at this fix (1.9), and it under-framed:
   the rings still ran off every edge, because a ratio picked against the
   sats' scatter ignores that the ring is a full diameter wide.

   FRAME_MARGIN shrinks the half-angle rather than padding the distance, which
   is the same correction the HUD needs anyway — the stats/planes/density
   panels overlay the corners, so a ring that mathematically just fits still
   lands underneath them. 0.75 leaves the ring inside the panel gutters.

   The LEO floor keeps the small-shell case at the framing that already looked
   right rather than diving to a few hundred km, and the cap is
   tuneCameraLimits' maximumZoomDistance so the fly-to can never request a
   camera the controller will refuse. */
const EARTH_R_M      = 6371e3;
const CAMERA_FOV_RAD = Math.PI / 3;  // Cesium's default vertical fov (60°)
const FRAME_MARGIN   = 0.75;         // fraction of the half-angle the ring may fill
const MIN_FLY_ALT_M  = 22000000;     // the old LEO framing, now a floor
const MAX_FLY_ALT_M  = 1.35e8;       // tuneCameraLimits' maximumZoomDistance

/* The half-angle actually available, which on a portrait phone is NOT the
   vertical fov. Cesium's PerspectiveFrustum applies `fov` to the WIDER screen
   axis and derives the narrower one from the aspect ratio, so on a 390x844
   phone the *horizontal* half-angle is the binding constraint — roughly half
   the vertical one. Framing off the vertical fov alone is why the first
   geometric pass still fit only 19 of 32 GPS sats at 390px while desktop was
   fine: the maths was right for the axis it measured and blind to the one that
   clipped. Taking the min of the two axes frames the ring on whichever is
   tighter, which is the whole point of a "fit" calculation. */
function frameHalfAngle() {
    const half = CAMERA_FOV_RAD / 2;
    const canvas = viewer.scene.canvas;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return half;
    // Cesium puts `fov` on the wider axis; the narrower follows from aspect.
    const narrow = Math.atan(Math.tan(half) * Math.min(w, h) / Math.max(w, h));
    return Math.min(half, narrow);
}

function flyInAltitude(data) {
    const planes = data && data.planes;
    if (!planes || !planes.length) return MIN_FLY_ALT_M;
    let maxAltKm = 0;
    for (const p of planes) {
        if (Number.isFinite(p.altKm) && p.altKm > maxAltKm) maxAltKm = p.altKm;
    }
    if (!maxAltKm) return MIN_FLY_ALT_M;
    const shellRadiusM = EARTH_R_M + maxAltKm * 1000;
    const camRadiusM = shellRadiusM / Math.tan(frameHalfAngle() * FRAME_MARGIN);
    return Math.min(Math.max(camRadiusM - EARTH_R_M, MIN_FLY_ALT_M), MAX_FLY_ALT_M);
}

function introFlyIn(data) {
    viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(20, 25, flyInAltitude(data)),
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
loadConstellation(CONSTELLATIONS[preset] ? preset : 'starlink', { push: false });

/* Back/forward walks the tabs. `push: false` — the entry already exists in the
   history stack; pushing again would make Back a no-op that never unwinds. */
window.addEventListener('popstate', (e) => {
    const key = (e.state && e.state.c)
        || new URLSearchParams(location.search).get('c')
        || 'starlink';
    if (CONSTELLATIONS[key]) loadConstellation(key, { push: false });
});
