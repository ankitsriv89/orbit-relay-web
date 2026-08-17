import { orbVel } from '../../orbit-engine/astro.js';
import { degToRad, eciToEcf, coverageRadiusDeg, coverageCircleDeg, visibilityWindows, predictPasses, eirpDbm, linkBudget, stationEcfMetres, slantRangeKm } from './compute.js';
import { initGlobe, initTimeWarpButtons } from '../shared/globe.js';
import { State } from '../shared/state.js';
import { $, on, setText, fmtLat, fmtLon } from '../shared/utils.js';
import { exposeDebug } from '../shared/debug.js';
import { requestPermission, scheduleNotifications, clearNotifications } from './notifications.js';
import {
    wireHudToggle, initHamburgerMenu, wireTabs, expandHud,
    wireRevsButton, syncRevsButtons, currentRevs, REVS_STATE_PATH,
} from '/shared/hud.js';

const { viewer, engine } = initGlobe();
const clock = viewer.clock;

/* ── HUD toggles ───────────────────────────────────────────────────────────── */
wireHudToggle('catalog-hud', 'catalog-hud-toggle', 'catalog-hud-body');
wireHudToggle('analysis-hud', 'analysis-hud-toggle', 'analysis-hud-body');
wireTabs(document.getElementById('analysis-hud-body'));
initHamburgerMenu();

/* ── Time-warp ────────────────────────────────────────────────────────────── */
initTimeWarpButtons($('time-warp'));

/* ── Orbit revolution count (plan 35 §3, S6) ──────────────────────────────── */
const timeWarpEl = $('time-warp');
let revsToggle = null;
if (timeWarpEl) {
    revsToggle = document.createElement('button');
    revsToggle.type = 'button';
    revsToggle.id = 'revs-toggle';
    revsToggle.className = 'tw-btn';
    revsToggle.dataset.revsLabel = '';
    revsToggle.setAttribute('aria-label', 'Cycle orbit revolution count');
    timeWarpEl.appendChild(revsToggle);
    syncRevsButtons(currentRevs());
    wireRevsButton(revsToggle);
}

/* ── Selected object from state ──────────────────────────────────────────── */
let selectedObject = null;
let selectedSatrec = null;
let selectedMeta = null;
let dossierVisuals = null;
let dossierTimer = null;

State.subscribe(REVS_STATE_PATH, () => {
    if (!selectedMeta) return;
    engine.removeEntities(dossierVisuals);
    dossierVisuals = engine.addInspectVisuals(selectedMeta, '#00d2ff', { revs: currentRevs() });
});

function refreshSelectedLive() {
    if (!selectedSatrec) return;
    const p = engine.geo(selectedSatrec);
    if (!p) {
        setText('sig-obj-lat', 'no solution');
        return;
    }
    setText('sig-obj-lat', fmtLat(p.lat));
    setText('sig-obj-lon', fmtLon(p.lon));
    setText('sig-obj-alt', `${Math.round(p.alt)} km`);
    setText('sig-obj-vel', `${orbVel(p.alt).toFixed(2)} km/s`);
    refreshLink();
}

function loadSelectedObject() {
    const obj = State.get('selectedObject');
    if (!obj) return;

    selectedObject = obj;

    setText('sig-obj-name', obj.name || '—');
    setText('sig-obj-norad', obj.norad || '—');
    setText('sig-obj-type', obj.type || '—');
    setText('sig-obj-regime', obj.regime || '—');

    // Clear any pending pass notifications when object changes
    clearNotifications();

    if (obj.l1 && obj.l2) {
        try {
            const satrec = satellite.twoline2satrec(obj.l1, obj.l2);
            selectedSatrec = satrec;
            selectedMeta = { satrec, l1: obj.l1, l2: obj.l2, name: obj.name, norad: obj.norad };
            engine.removeEntities(dossierVisuals);
            dossierVisuals = engine.addInspectVisuals(selectedMeta, '#00d2ff', { revs: currentRevs() });
            refreshSelectedLive();
            if (dossierTimer) clearInterval(dossierTimer);
            dossierTimer = engine.own(setInterval(refreshSelectedLive, 1000));
        } catch (_) { }
    }

    expandHud('catalog-hud');
}

loadSelectedObject();

State.subscribe('selectedObject', (obj) => {
    if (obj && obj.norad !== (selectedObject || {}).norad) loadSelectedObject();
});

/* ── Ground stations ──────────────────────────────────────────────────────
 * The real list lives in /data/ground-stations.json (~50 sites, plan 34 §3.4).
 * FALLBACK_STATIONS below is the offline subset that populates the select
 * before (and instead of) the fetch — it is a strict subset of the file,
 * asserted by signal-compute.test.mjs, so a dead static file degrades to the
 * pre-3.4 behaviour rather than a broken page.
 */
const FALLBACK_STATIONS = [
    { name: 'Cape Canaveral, FL, USA', lat: 28.39, lon: -80.60, alt: 0 },
    { name: 'Vandenberg SFB, CA, USA', lat: 34.74, lon: -120.57, alt: 0 },
    { name: 'Kourou, French Guiana', lat: 5.16, lon: -52.65, alt: 0 },
    { name: 'Baikonur, Kazakhstan', lat: 45.96, lon: 63.30, alt: 0 },
    { name: 'Plesetsk, Russia', lat: 62.92, lon: 40.68, alt: 0 },
    { name: 'McMurdo, Antarctica', lat: -77.85, lon: 166.67, alt: 0 },
    { name: 'Svalbard, Norway', lat: 78.23, lon: 15.39, alt: 0 },
    { name: 'Kiruna, Sweden', lat: 67.86, lon: 20.96, alt: 0 },
    { name: 'Madrid, Spain', lat: 40.43, lon: -4.25, alt: 0 },
    { name: 'Goldstone, CA, USA', lat: 35.43, lon: -116.89, alt: 0 },
    { name: 'Canberra, Australia', lat: -35.40, lon: 148.98, alt: 0 },
    { name: 'Hartebeesthoek, S. Africa', lat: -25.89, lon: 27.69, alt: 0 },
    { name: 'Dongara, Australia', lat: -29.25, lon: 114.93, alt: 0 },
    { name: 'Santa Maria, Azores', lat: 36.98, lon: -25.11, alt: 0 },
    { name: 'Brasília, Brazil', lat: -15.79, lon: -47.88, alt: 0 },
    { name: 'Singapore', lat: 1.35, lon: 103.82, alt: 0 },
    { name: 'Hawaii, USA', lat: 21.30, lon: -157.86, alt: 0 },
    { name: 'Guam, USA', lat: 13.44, lon: 144.78, alt: 0 },
    { name: 'Ascension Island', lat: -7.95, lon: -14.37, alt: 0 },
    { name: 'Troll, Antarctica', lat: -72.01, lon: 2.53, alt: 0 },
];

let groundStations = FALLBACK_STATIONS;
let stationMarkers = [];
let stationMarkersOn = false;
let linkLine = null;

const stationSelect = $('gs-station');

/** The station the select currently names, or null. */
function selectedStation() {
    if (!stationSelect || !stationSelect.value) return null;
    const [lat, lon, alt = 0] = stationSelect.value.split(',').map(Number);
    if (isNaN(lat) || isNaN(lon)) return null;
    return { lat, lon, alt };
}

function populateStationSelect() {
    if (!stationSelect) return;
    const prev = stationSelect.value;
    stationSelect.textContent = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'select station';
    stationSelect.appendChild(placeholder);
    for (const s of groundStations) {
        const opt = document.createElement('option');
        opt.value = `${s.lat},${s.lon},${s.alt ?? 0}`;
        opt.textContent = s.name;
        stationSelect.appendChild(opt);
    }
    if ([...stationSelect.options].some(o => o.value === prev)) stationSelect.value = prev;
}

populateStationSelect();

fetch('/data/ground-stations.json')
    .then(res => {
        if (!res.ok) throw new Error(`ground-stations ${res.status}`);
        return res.json();
    })
    .then(data => {
        if (!Array.isArray(data) || data.length === 0) throw new Error('empty station list');
        groundStations = data;
        populateStationSelect();
    })
    .catch(err => console.warn('[signal] ground-stations fetch failed, using built-in 20:', err));

/* ── Station markers + live sat↔ground link (plan 34 §3.4) ─────────────────
 * The stations were only ever <select> options — never rendered on the globe,
 * even though the link-budget maths that characterises a station↔sat link was
 * already in compute.js. Markers are managed entities (launch-sites.js is the
 * pattern); the link is a live straight polyline from the station to the
 * satellite, rebuilt on the 1 s dossier tick, with the true WGS-84 slant
 * range shown in the visibility tab and fed to the RF tab. Both degrade
 * silently: no station selected → no line, and the RF tab falls back to the
 * near-zenith altitude bound it used before.
 */
const STATION_LINK_COLOR = '#42f587';

function renderStationMarkers() {
    if (stationMarkersOn || !viewer) return;
    stationMarkersOn = true;
    for (const s of groundStations) {
        stationMarkers.push(engine.addManagedEntity(viewer.entities.add({
            position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, 0),
            point: {
                pixelSize: 5,
                color: Cesium.Color.fromCssColorString(STATION_LINK_COLOR).withAlpha(0.75),
                outlineColor: Cesium.Color.WHITE.withAlpha(0.5),
                outlineWidth: 1,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            },
            label: {
                text: s.name,
                font: '10px monospace',
                fillColor: Cesium.Color.fromCssColorString(STATION_LINK_COLOR).withAlpha(0.85),
                outlineColor: Cesium.Color.BLACK,
                outlineWidth: 2,
                style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                pixelOffset: new Cesium.Cartesian2(0, -8),
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
                showBackground: true,
                backgroundColor: Cesium.Color.fromCssColorString('#000810').withAlpha(0.8),
                backgroundPadding: new Cesium.Cartesian2(4, 2),
                scaleByDistance: new Cesium.NearFarScalar(1e5, 1.2, 1e7, 0.4),
            },
        })));
    }
    engine.requestRender();
}

function removeStationMarkers() {
    for (const e of stationMarkers) engine.removeManagedEntity(e);
    stationMarkers = [];
    stationMarkersOn = false;
}

const stationsToggle = $('stations-toggle');
if (stationsToggle) {
    stationsToggle.addEventListener('click', () => {
        if (stationMarkersOn) removeStationMarkers();
        else renderStationMarkers();
        stationsToggle.textContent = stationMarkersOn ? 'ON' : 'OFF';
        stationsToggle.classList.toggle('st-toggle-btn--on', stationMarkersOn);
    });

    // Notifications toggle
    const notifToggle = $('notifications-toggle');
    if (notifToggle) {
        notifToggle.addEventListener('change', () => {
            if (notifToggle.checked) {
                requestPermission().then(perm => {
                    if (perm !== 'granted') {
                        // Permission denied — uncheck toggle so UI clearly reads as off
                        notifToggle.checked = false;
                    }
                });
            } else {
                clearNotifications();
            }
        });
    }
}

/** Rebuild the station↔sat link line + its slant-range readout. */
function refreshLink() {
    const st = selectedStation();
    const p = selectedSatrec ? engine.geo(selectedSatrec) : null;
    if (!st || !p) {
        if (linkLine) linkLine.show = false;
        setText('gs-link', '—');
        return;
    }
    const stEcf = stationEcfMetres({ latDeg: st.lat, lonDeg: st.lon, altKm: st.alt });
    const satEcf = stationEcfMetres({ latDeg: p.lat, lonDeg: p.lon, altKm: p.alt });
    if (!linkLine) {
        linkLine = engine.addManagedEntity(viewer.entities.add({
            polyline: {
                positions: [],
                width: 1.5,
                material: Cesium.Color.fromCssColorString(STATION_LINK_COLOR).withAlpha(0.8),
                arcType: Cesium.ArcType.NONE,   // a sight line through space, not a surface arc
            },
        }));
    }
    linkLine.show = true;
    linkLine.polyline.positions = [
        new Cesium.Cartesian3(stEcf.x, stEcf.y, stEcf.z),
        new Cesium.Cartesian3(satEcf.x, satEcf.y, satEcf.z),
    ];
    setText('gs-link', `${slantRangeKm(stEcf, satEcf).toFixed(0)} km`);
}

if (stationSelect) {
    on('gs-station', 'change', refreshLink);
}

on('gs-elev', 'input', () => {
    setText('gs-elev-val', `${$('gs-elev').value}°`);
});

on('cov-elev', 'input', () => {
    setText('cov-elev-val', `${$('cov-elev').value}°`);
});

/* ── Elevation / visibility helpers ───────────────────────────────────────── */
function computeElevation(satrec, date, stationLat, stationLon, stationAltKm) {
    const pv = satellite.propagate(satrec, date);
    if (!pv || !pv.position) return null;

    const gmst = satellite.gstime(date);
    const satEcf = eciToEcf(pv.position, gmst);

    const obsGeo = {
        latitude: degToRad(stationLat),
        longitude: degToRad(stationLon),
        height: stationAltKm,
    };

    const look = satellite.ecfToLookAngles(obsGeo, satEcf);
    if (!look) return null;
    return satellite.degreesLat(look.elevation);
}

/* ── Visibility tab ───────────────────────────────────────────────────────── */
on('gs-compute', 'click', () => {
    const list = $('gs-windows');
    const hint = $('gs-hint');
    if (!list) return;

    if (!selectedSatrec) {
        if (hint) hint.textContent = 'no satellite selected — choose one on the Catalog page first';
        return;
    }

    const stationVal = stationSelect.value;
    if (!stationVal) {
        if (hint) hint.textContent = 'select a ground station';
        return;
    }

    const [stationLat, stationLon, stationAlt = 0] = stationVal.split(',').map(Number);
    const elevMask = Number($('gs-elev').value);
    const windowSec = Number($('gs-window').value);
    const stepSec = 30;

    if (hint) hint.textContent = 'computing visibility windows…';
    list.textContent = '';

    const windows = visibilityWindows({
        t0Ms: Date.now(), windowSec, stepSec, elevMask, stationLat, stationLon,
        elevationAt: (date, lat, lon) => computeElevation(selectedSatrec, date, lat, lon, stationAlt),
    });

    if (!windows.length) {
        if (hint) hint.textContent = `no passes above ${elevMask}° in the selected window`;
        return;
    }

    if (hint) hint.textContent = '';
    const fmt = (d) => d.toUTCString().slice(17, 25);
    for (const w of windows) {
        const li = document.createElement('li');
        li.className = 'st-feed__item';
        const title = document.createElement('span');
        title.className = 'st-feed__title';
        const dur = Math.round((w.end - w.start) / 60000);
        title.textContent = `${fmt(w.start)} – ${fmt(w.end)} (${dur} min)`;
        const meta = document.createElement('span');
        meta.className = 'st-feed__meta';
        meta.textContent = `max elev: ${w.maxElev.toFixed(1)}°`;
        li.append(title, meta);
        list.appendChild(li);
    }
});

/* ── Coverage tab ──────────────────────────────────────────────────────────── */
let coverageEntities = [];

on('cov-compute', 'click', () => {
    const hint = $('cov-hint');
    if (!selectedSatrec) {
        if (hint) hint.textContent = 'no satellite selected';
        return;
    }

    const minElev = Number($('cov-elev').value);

    engine.removeEntities(coverageEntities);
    coverageEntities = [];

    if (hint) hint.textContent = 'generating coverage map…';

    const p = engine.geo(selectedSatrec);
    if (!p) {
        if (hint) hint.textContent = 'cannot compute satellite position';
        return;
    }

    const radiusDeg = coverageRadiusDeg(p.alt, minElev);
    const points = coverageCircleDeg(p.lat, p.lon, radiusDeg).map(pt => Cesium.Cartesian3.fromDegrees(pt.lon, pt.lat, 0));

    const polygon = viewer.entities.add({
        polygon: {
            hierarchy: new Cesium.PolygonHierarchy(points),
            material: new Cesium.Color(0, 210 / 255, 255 / 255, 0.12),
            outline: true,
            outlineColor: new Cesium.Color(0, 210 / 255, 255 / 255, 0.6),
            outlineWidth: 1,
        },
    });
    coverageEntities.push(polygon);

    const centerPoint = viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 0),
        point: { pixelSize: 6, color: Cesium.Color.CYAN, outlineColor: Cesium.Color.WHITE, outlineWidth: 1 },
    });
    coverageEntities.push(centerPoint);

    if (hint) hint.textContent = `coverage: ${radiusDeg.toFixed(1)}° radius at ${minElev}° mask`;
});

/* ── Pass predictions tab ─────────────────────────────────────────────────── */
on('pass-compute', 'click', () => {
    const list = $('pass-list');
    const hint = $('pass-hint');
    if (!list) return;

    if (!selectedSatrec) {
        if (hint) hint.textContent = 'no satellite selected';
        return;
    }

    const targetStr = $('pass-target').value.trim();
    if (!targetStr) {
        if (hint) hint.textContent = 'enter target lat,lon';
        return;
    }

    const parts = targetStr.split(',').map(s => parseFloat(s.trim()));
    if (parts.length < 2 || isNaN(parts[0]) || isNaN(parts[1])) {
        if (hint) hint.textContent = 'invalid format — use lat,lon (e.g. 37.4,-122.1)';
        return;
    }
    const [targetLat, targetLon] = parts;
    const daysAhead = Math.max(1, Math.min(30, Number($('pass-days').value) || 7));
    const minDurSec = Number($('pass-min-dur').value) || 60;
    const elevMask = 10;
    const stepSec = 30;

    if (hint) hint.textContent = 'computing passes…';
    list.textContent = '';

    const passes = predictPasses({
        t0Ms: Date.now(), daysAhead, stepSec, elevMask, minDurSec, targetLat, targetLon,
        elevationAt: (date, lat, lon) => computeElevation(selectedSatrec, date, lat, lon, 0),
    });

    if (!passes.length) {
        if (hint) hint.textContent = `no passes above ${elevMask}° in ${daysAhead} days`;
        return;
    }

    if (hint) hint.textContent = `${passes.length} pass${passes.length === 1 ? '' : 'es'} found`;
    const fmt = (d) => {
        const s = d.toUTCString();
        return s.slice(5, 7) + '/' + s.slice(8, 10) + ' ' + s.slice(17, 25);
    };
    for (const p of passes) {
        const li = document.createElement('li');
        li.className = 'st-feed__item';
        const title = document.createElement('span');
        title.className = 'st-feed__title';
        title.textContent = fmt(p.start);
        const meta = document.createElement('span');
        meta.className = 'st-feed__meta';
        const durMin = Math.round(p.durSec / 60);
        meta.textContent = `duration: ${durMin} min · max elev: ${p.maxElev.toFixed(1)}°`;
        li.append(title, meta);
        list.appendChild(li);
    }

    // Schedule notifications for upcoming passes if enabled
    const notifToggle = $('notifications-toggle');
    if (notifToggle && notifToggle.checked) {
        requestPermission().then(perm => {
            if (perm === 'granted') {
                scheduleNotifications(passes, selectedObject.name || '—');
            }
        });
    }
});

/* ── RF / Link budget tab ──────────────────────────────────────────────────── */

/* ── RF / Link budget tab ──────────────────────────────────────────────────── */
on('rf-compute', 'click', () => {
    const freqMHz = Number($('rf-freq').value) || 2200;
    const txPowerW = Number($('rf-tx').value) || 10;
    const txGainDbi = Number($('rf-tx-gain').value) || 10;
    const rxGainDbi = Number($('rf-rx-gain').value) || 40;
    const dataRateKbps = Number($('rf-rate').value) || 1000;

    const eirp = eirpDbm(txPowerW, txGainDbi);
    setText('rf-eirp', `${eirp.toFixed(1)} dBm`);

    if (selectedSatrec) {
        const p = engine.geo(selectedSatrec);
        if (p) {
            // Real station↔sat slant range when a station is selected (plan 34
            // §3.4); the near-zenith altitude bound remains the no-station case.
            const st = selectedStation();
            const rangeKm = st
                ? slantRangeKm(
                    stationEcfMetres({ latDeg: st.lat, lonDeg: st.lon, altKm: st.alt }),
                    stationEcfMetres({ latDeg: p.lat, lonDeg: p.lon, altKm: p.alt })
                )
                : p.alt;
            const b = linkBudget({ freqMHz, txPowerW, txGainDbi, rxGainDbi, dataRateKbps, rangeKm });
            setText('rf-pl', `${b.pathLoss.toFixed(1)} dB`);
            setText('rf-snr', `${b.snr.toFixed(1)} dB`);
            setText('rf-gt', `${b.gToT.toFixed(1)} dB/K`);
            setText('rf-margin', `${b.margin.toFixed(1)} dB`);
        }
    } else {
        setText('rf-pl', 'no satellite');
        setText('rf-gt', `${rxGainDbi.toFixed(1)} dB/K (no slant range)`);
        setText('rf-snr', '—');
        setText('rf-margin', '—');
    }
});

/* ── Debug handle ──────────────────────────────────────────────────────────── */
exposeDebug('signal', {
    viewer, engine,
    get booted() { return !!engine; },
    get selected() { return selectedObject; },
    get stationCount() { return groundStations.length; },
    get stationsOnGlobe() { return stationMarkers.length; },
    refreshLink,
});

window.addEventListener('beforeunload', () => {
    clearNotifications();
});
