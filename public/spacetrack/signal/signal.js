import { EARTH_R_KM, orbVel } from '../../orbit-engine/astro.js';
import { initGlobe, initTimeWarpButtons } from '../shared/globe.js';
import { State } from '../shared/state.js';
import { $, setText, fmtLat, fmtLon } from '../shared/utils.js';
import { wireHudToggle, initHamburgerMenu, wireTabs, expandHud } from '/shared/hud.js';

const { viewer, engine } = initGlobe();
const clock = viewer.clock;

/* ── HUD toggles ───────────────────────────────────────────────────────────── */
wireHudToggle('catalog-hud', 'catalog-hud-toggle', 'catalog-hud-body');
wireHudToggle('analysis-hud', 'analysis-hud-toggle', 'analysis-hud-body');
wireTabs(document.getElementById('analysis-hud-body'));
initHamburgerMenu();

/* ── Time-warp ────────────────────────────────────────────────────────────── */
initTimeWarpButtons($('time-warp'));

/* ── Selected object from state ──────────────────────────────────────────── */
let selectedObject = null;
let selectedSatrec = null;
let selectedMeta = null;
let dossierVisuals = null;
let dossierTimer = null;

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
}

function loadSelectedObject() {
    const obj = State.get('selectedObject');
    if (!obj) return;

    selectedObject = obj;

    setText('sig-obj-name', obj.name || '—');
    setText('sig-obj-norad', obj.norad || '—');
    setText('sig-obj-type', obj.type || '—');
    setText('sig-obj-regime', obj.regime || '—');

    if (obj.l1 && obj.l2) {
        try {
            const satrec = satellite.twoline2satrec(obj.l1, obj.l2);
            selectedSatrec = satrec;
            selectedMeta = { satrec, l1: obj.l1, l2: obj.l2, name: obj.name, norad: obj.norad };
            engine.removeEntities(dossierVisuals);
            dossierVisuals = engine.addInspectVisuals(selectedMeta, '#00d2ff');
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

/* ── Ground stations ────────────────────────────────────────────────────── */
const GROUND_STATIONS = [
    { name: 'Cape Canaveral, FL, USA', lat: 28.39, lon: -80.60 },
    { name: 'Vandenberg SFB, CA, USA', lat: 34.74, lon: -120.57 },
    { name: 'Kourou, French Guiana', lat: 5.16, lon: -52.65 },
    { name: 'Baikonur, Kazakhstan', lat: 45.96, lon: 63.30 },
    { name: 'Plesetsk, Russia', lat: 62.92, lon: 40.68 },
    { name: 'McMurdo, Antarctica', lat: -77.85, lon: 166.67 },
    { name: 'Svalbard, Norway', lat: 78.23, lon: 15.39 },
    { name: 'Kiruna, Sweden', lat: 67.86, lon: 20.96 },
    { name: 'Madrid, Spain', lat: 40.43, lon: -4.25 },
    { name: 'Goldstone, CA, USA', lat: 35.43, lon: -116.89 },
    { name: 'Canberra, Australia', lat: -35.40, lon: 148.98 },
    { name: 'Hartebeesthoek, S. Africa', lat: -25.89, lon: 27.69 },
    { name: 'Dongara, Australia', lat: -29.25, lon: 114.93 },
    { name: 'Santa Maria, Azores', lat: 36.98, lon: -25.11 },
    { name: 'Brasília, Brazil', lat: -15.79, lon: -47.88 },
    { name: 'Singapore', lat: 1.35, lon: 103.82 },
    { name: 'Hawaii, USA', lat: 21.30, lon: -157.86 },
    { name: 'Guam, USA', lat: 13.44, lon: 144.78 },
    { name: 'Ascension Island', lat: -7.95, lon: -14.37 },
    { name: 'Troll, Antarctica', lat: -72.01, lon: 2.53 },
];

const stationSelect = $('gs-station');
if (stationSelect) {
    for (const s of GROUND_STATIONS) {
        const opt = document.createElement('option');
        opt.value = `${s.lat},${s.lon}`;
        opt.textContent = s.name;
        stationSelect.appendChild(opt);
    }
}

$('gs-elev').addEventListener('input', () => {
    setText('gs-elev-val', `${$('gs-elev').value}°`);
});

$('cov-elev').addEventListener('input', () => {
    setText('cov-elev-val', `${$('cov-elev').value}°`);
});

/* ── Elevation / visibility helpers ───────────────────────────────────────── */
function degToRad(d) { return d * Math.PI / 180; }

function eciToEcf(pos, gmst) {
    const x = pos.x * Math.cos(gmst) + pos.y * Math.sin(gmst);
    const y = -pos.x * Math.sin(gmst) + pos.y * Math.cos(gmst);
    return { x, y, z: pos.z };
}

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
$('gs-compute').addEventListener('click', async () => {
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

    const [sLat, sLon] = stationVal.split(',').map(Number);
    const elevMask = Number($('gs-elev').value);
    const windowSec = Number($('gs-window').value);
    const stepSec = 30;

    if (hint) hint.textContent = 'computing visibility windows…';
    list.textContent = '';

    const t0 = Date.now();
    const steps = Math.ceil(windowSec / stepSec);
    const windows = [];
    let inWindow = false;
    let windowStart = null;

    for (let i = 0; i <= steps; i++) {
        const date = new Date(t0 + i * stepSec * 1000);
        const elev = computeElevation(selectedSatrec, date, sLat, sLon, 0);
        if (elev == null) continue;

        const above = elev >= elevMask;
        if (above && !inWindow) {
            inWindow = true;
            windowStart = date;
        } else if (!above && inWindow) {
            inWindow = false;
            windows.push({ start: windowStart, end: date, maxElev: 0 });
        }
        if (above && inWindow && elev > (windows.length ? windows[windows.length - 1].maxElev : 0)) {
            if (windows.length) windows[windows.length - 1].maxElev = elev;
        }
    }
    if (inWindow) {
        windows.push({ start: windowStart, end: new Date(t0 + steps * stepSec * 1000), maxElev: 0 });
    }

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

$('cov-compute').addEventListener('click', () => {
    const hint = $('cov-hint');
    if (!selectedSatrec) {
        if (hint) hint.textContent = 'no satellite selected';
        return;
    }

    const gridDeg = Number($('cov-grid').value);
    const minElev = Number($('cov-elev').value);

    engine.removeEntities(coverageEntities);
    coverageEntities = [];

    if (hint) hint.textContent = 'generating coverage map…';

    const now = new Date();
    const p = engine.geo(selectedSatrec);
    if (!p) {
        if (hint) hint.textContent = 'cannot compute satellite position';
        return;
    }

    const altKm = p.alt;
    const coverageRadiusRad = Math.acos(EARTH_R_KM / (EARTH_R_KM + altKm) * Math.cos(degToRad(minElev))) - degToRad(minElev);
    const coverageRadiusDeg = coverageRadiusRad * 180 / Math.PI;

    const satLat = degToRad(p.lat);
    const satLon = degToRad(p.lon);

    const points = [];
    const segments = 64;
    for (let i = 0; i <= segments; i++) {
        const bearing = (i / segments) * 2 * Math.PI;
        const lat = Math.asin(Math.sin(satLat) * Math.cos(coverageRadiusRad) +
                              Math.cos(satLat) * Math.sin(coverageRadiusRad) * Math.cos(bearing));
        const lon = satLon + Math.atan2(Math.sin(bearing) * Math.sin(coverageRadiusRad) * Math.cos(satLat),
                                        Math.cos(coverageRadiusRad) - Math.sin(satLat) * Math.sin(lat));
        points.push(Cesium.Cartesian3.fromRadians(lon, lat, 0));
    }

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
        position: Cesium.Cartesian3.fromRadians(satLon, satLat, 0),
        point: { pixelSize: 6, color: Cesium.Color.CYAN, outlineColor: Cesium.Color.WHITE, outlineWidth: 1 },
    });
    coverageEntities.push(centerPoint);

    if (hint) hint.textContent = `coverage: ${coverageRadiusDeg.toFixed(1)}° radius at ${minElev}° mask`;
});

/* ── Pass predictions tab ─────────────────────────────────────────────────── */
$('pass-compute').addEventListener('click', async () => {
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
    const [tLat, tLon] = parts;
    const daysAhead = Math.max(1, Math.min(30, Number($('pass-days').value) || 7));
    const minDurSec = Number($('pass-min-dur').value) || 60;
    const elevMask = 10;
    const stepSec = 30;

    if (hint) hint.textContent = 'computing passes…';
    list.textContent = '';

    const t0 = Date.now();
    const totalMs = daysAhead * 86400000;
    const steps = Math.ceil(totalMs / (stepSec * 1000));
    const passes = [];
    let inPass = false;
    let passStart = null;
    let passMaxElev = 0;

    for (let i = 0; i <= steps; i++) {
        const date = new Date(t0 + i * stepSec * 1000);
        const elev = computeElevation(selectedSatrec, date, tLat, tLon, 0);
        if (elev == null) continue;

        if (elev >= elevMask && !inPass) {
            inPass = true;
            passStart = date;
            passMaxElev = elev;
        } else if (elev < elevMask && inPass) {
            inPass = false;
            const durSec = (date - passStart) / 1000;
            if (durSec >= minDurSec) {
                passes.push({ start: passStart, end: date, durSec, maxElev: passMaxElev });
            }
        }
        if (inPass && elev > passMaxElev) passMaxElev = elev;
    }

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
});

/* ── RF / Link budget tab ──────────────────────────────────────────────────── */
$('rf-compute').addEventListener('click', () => {
    const freqMHz = Number($('rf-freq').value) || 2200;
    const txPowerW = Number($('rf-tx').value) || 10;
    const txGainDbi = Number($('rf-tx-gain').value) || 10;
    const rxGainDbi = Number($('rf-rx-gain').value) || 40;
    const dataRateKbps = Number($('rf-rate').value) || 1000;

    const eirpDbm = 10 * Math.log10(txPowerW * 1000) + txGainDbi;
    setText('rf-eirp', `${eirpDbm.toFixed(1)} dBm`);

    let pathLossDb = '—';
    let snrDb = '—';
    let marginDb = '—';
    let gtDb = '—';

    if (selectedSatrec) {
        const p = engine.geo(selectedSatrec);
        if (p) {
            const rangeKm = p.alt;
            const freqHz = freqMHz * 1e6;
            pathLossDb = 20 * Math.log10(rangeKm * 1000) + 20 * Math.log10(freqHz) + 20 * Math.log10(4 * Math.PI / 299792458);
            pathLossDb = -pathLossDb;
            setText('rf-pl', `${pathLossDb.toFixed(1)} dB`);

            const rcvPowerDbm = eirpDbm + pathLossDb + rxGainDbi;
            const noiseDbm = -174 + 10 * Math.log10(dataRateKbps * 1000);
            snrDb = rcvPowerDbm - noiseDbm;
            setText('rf-snr', `${snrDb.toFixed(1)} dB`);

            gtDb = rxGainDbi - 10 * Math.log10(290);
            setText('rf-gt', `${gtDb.toFixed(1)} dB/K`);

            const requiredSnr = 10;
            marginDb = snrDb - requiredSnr;
            setText('rf-margin', `${marginDb.toFixed(1)} dB`);
        }
    } else {
        setText('rf-pl', 'no satellite');
        setText('rf-gt', `${rxGainDbi.toFixed(1)} dB/K (no slant range)`);
        setText('rf-snr', '—');
        setText('rf-margin', '—');
    }
});

/* ── Debug handle ──────────────────────────────────────────────────────────── */
window.__spacetrack = {
    viewer, engine,
    get booted() { return !!engine; },
    get selected() { return selectedObject; },
};
