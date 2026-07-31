/**
 * SpaceTrack Catalog Page — Main entry point for satellite discovery and visualization.
 * 3D Cesium Globe + Filters + Results + Object Dossier
 */

import { orbVel, fmtLat, fmtLon } from '/orbit-engine/astro.js';
import { initGlobe, initTimeWarpButtons } from './shared/globe.js';
import { State } from './shared/state.js';
import { API, getApiBase } from './shared/api.js';
import { wireHudToggle, initHamburgerMenu, initFilterDrawer, closeAllHuds } from './shared/hud.js';
import {
    TYPE_COLORS, COUNTRY_COLORS, colorForRow, regimeSize, colorForCountry,
} from './shared/utils.js';

const RENDER_CAP = 500;

const $ = (id) => document.getElementById(id);

/* ── Viewer / Globe ───────────────────────────────────────────────────────── */
const { viewer, engine } = initGlobe();
const clock = viewer.clock;

/* ── Clock readout ────────────────────────────────────────────────────────── */
function updateClock() {
    const now = engine.now();
    const pad = n => String(n).padStart(2, '0');
    const d = $('hud-date');
    const t = $('hud-time');
    if (d) d.textContent = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
    if (t) t.textContent = `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())} UTC`;
}
engine.own(setInterval(updateClock, 250));
updateClock();

/* ── HUD toggles ───────────────────────────────────────────────────────────── */
wireHudToggle('catalog-hud', 'catalog-hud-toggle', 'catalog-hud-body');
wireHudToggle('filters-hud', 'filters-hud-toggle', 'filters-hud-body');
wireHudToggle('activity-hud', 'activity-hud-toggle', 'activity-hud-body');
wireHudToggle('results-hud', 'results-hud-toggle', 'results-hud-body');
wireHudToggle('boxscore-hud', 'boxscore-hud-toggle', 'boxscore-hud-body');
initHamburgerMenu();
initFilterDrawer();

/* ── Color mode (type vs country) ─────────────────────────────────────────── */
let colorMode = State.get('preferences.colorMode') || 'type';

/* ── Colorblind-safe palette ─────────────────────────────────────────────── */
const CB_TYPE_COLORS = {
    'PAYLOAD':     '#56B4E9',  // sky blue
    'ROCKET BODY': '#E69F00',  // orange
    'DEBRIS':      '#CC79A7',  // reddish purple
    'UNKNOWN':     '#999999',  // grey
};
const CB_COUNTRY_COLORS = {
    'US': '#56B4E9',   // sky blue
    'RU': '#D55E00',   // vermillion
    'CN': '#E69F00',   // orange
    'GB': '#0072B2',   // blue
    'FR': '#009E73',   // bluish green
    'JP': '#CC79A7',   // reddish purple
    'IN': '#F0E442',   // yellow
    'KR': '#56B4E9',   // sky blue
    'DE': '#999999',   // grey
    'IT': '#009E73',   // bluish green
    'CA': '#D55E00',   // vermillion
    'AU': '#E69F00',   // orange
    'BR': '#009E73',   // bluish green
    'ESA': '#0072B2',  // blue
    'ISRAEL': '#0072B2',
    'UAE': '#56B4E9',
    'TS': '#CC79A7',
    'OR': '#CC79A7',
};

function effectiveTypeColors() { return colorMode === 'cb' ? CB_TYPE_COLORS : TYPE_COLORS; }
function effectiveCountryColors() { return colorMode === 'cb' ? CB_COUNTRY_COLORS : COUNTRY_COLORS; }

/* ── Filter chips state ──────────────────────────────────────────────────── */
const activeChips = new Set(); // e.g. 'US', 'PAYLOAD', etc.

function applyColorModeUI() {
    document.querySelectorAll('.st-color-toggle__option').forEach(el => {
        el.classList.toggle('st-color-toggle__option--active', el.dataset.mode === colorMode);
    });
    activeChips.clear();
    renderLegend();
}

function renderLegend() {
    const el = $('color-legend');
    if (!el) return;
    el.textContent = '';
    el.classList.toggle('st-color-legend--filtered', activeChips.size > 0);

    const colors = colorMode === 'country' || colorMode === 'cb'
        ? effectiveCountryColors()
        : effectiveTypeColors();

    for (const [key, hex] of Object.entries(colors)) {
        const item = document.createElement('span');
        item.className = 'st-color-legend__item';
        if (activeChips.size > 0 && !activeChips.has(key)) {
            item.classList.add('st-color-legend__item--ghosted');
        } else if (activeChips.has(key)) {
            item.classList.add('st-color-legend__item--active');
        }
        item.dataset.chip = key;
        const swatch = document.createElement('span');
        swatch.className = 'st-color-legend__swatch';
        swatch.style.background = hex;
        const label = document.createTextNode(key);
        item.append(swatch, label);
        item.addEventListener('click', () => toggleChip(key));
        el.appendChild(item);
    }

    const clearBtn = document.createElement('span');
    clearBtn.className = 'st-color-legend__clear';
    clearBtn.textContent = '✕ CLEAR';
    clearBtn.addEventListener('click', clearChips);
    el.appendChild(clearBtn);
}

function toggleChip(key) {
    if (activeChips.has(key)) {
        activeChips.delete(key);
    } else {
        activeChips.add(key);
    }
    renderLegend();
    applyChipFilter();
}

function clearChips() {
    activeChips.clear();
    renderLegend();
    applyChipFilter();
}

function applyChipFilter() {
    if (activeChips.size === 0) {
        for (const sat of rendered) {
            sat.primitive.alpha = 1;
            sat.primitive.show = true;
        }
    } else {
        for (const sat of rendered) {
            const row = sat.meta.row;
            if (!row) continue;
            const match = colorMode === 'country' || colorMode === 'cb'
                ? activeChips.has(row.COUNTRY_CODE)
                : activeChips.has((row.OBJECT_TYPE || '').toUpperCase());
            sat.primitive.alpha = match ? 1 : 0.08;
        }
    }
    engine.requestRender();
}

const colorModeBtn = $('color-mode-btn');
if (colorModeBtn) {
    colorModeBtn.addEventListener('click', () => {
        const modes = ['type', 'country', 'cb'];
        const idx = modes.indexOf(colorMode);
        colorMode = modes[(idx + 1) % modes.length];
        const labels = { type: 'TYPE', country: 'COUNTRY', cb: 'COLORBLIND' };
        colorModeBtn.querySelectorAll('.st-color-toggle__option').forEach(opt => {
            opt.classList.toggle('st-color-toggle__option--active', opt.dataset.mode === colorMode);
        });
        State.set('preferences.colorMode', colorMode);
        activeChips.clear();
        renderLegend();
        if (rendered.length) recolorRendered();
    });
}
applyColorModeUI();

/** Recolor all currently rendered points without re-fetching. */
function recolorRendered() {
    for (const sat of rendered) {
        const row = sat.meta.row;
        if (!row) continue;
        sat.primitive.color = Cesium.Color.fromCssColorString(
            colorForRow(row, colorMode, CB_TYPE_COLORS, CB_COUNTRY_COLORS));
        sat.primitive.pixelSize = regimeSize(row.apogee_km ?? row.perigee_km ?? 400);
        sat.baseSize = sat.primitive.pixelSize;
    }
    applyChipFilter();
    engine.requestRender();
}

/* ── Tier 1.2: Constellation / cluster hover label ─────────────────────── */
const constLabel = $('constellation-label');
let hoverActive = false;

function onPointerMove(movement) {
    if (!rendered.length || !constLabel) return;
    const pos = movement.endPosition;
    // Sample points within a 40px radius of cursor
    const RADIUS = 40;
    const hits = [];
    for (const sat of rendered) {
        if (!sat.primitive.show || !sat.primitive.position) continue;
        const c2s = Cesium.SceneTransforms.wgs84ToWindowCoordinates(
            viewer.scene, sat.primitive.position);
        if (!c2s) continue;
        const dx = c2s.x - pos.x;
        const dy = c2s.y - pos.y;
        if (dx * dx + dy * dy < RADIUS * RADIUS) hits.push(sat);
    }
    if (hits.length < 3) {
        constLabel.classList.remove('st-constellation-label--visible');
        return;
    }
    // Group by OBJECT_TYPE or by name prefix (constellation)
    const groups = {};
    for (const sat of hits) {
        const row = sat.meta.row;
        const key = row ? (row.OBJECT_TYPE || 'UNKNOWN') : (sat.meta.group || 'UNKNOWN');
        groups[key] = (groups[key] || 0) + 1;
    }
    const parts = Object.entries(groups)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k, v]) => `${k}: ${v}`);
    constLabel.textContent = parts.join(' · ');
    constLabel.style.left = `${pos.x + 16}px`;
    constLabel.style.top = `${pos.y - 8}px`;
    constLabel.classList.add('st-constellation-label--visible');
}

const hoverHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
hoverHandler.setInputAction(onPointerMove, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
hoverHandler.setInputAction(() => {
    if (constLabel) constLabel.classList.remove('st-constellation-label--visible');
}, Cesium.ScreenSpaceEventType.MOUSE_OUT);

/* ── Tier 1.3: Density heatmap overlay ─────────────────────────────────── */
const heatmapCanvas = $('density-heatmap');
const heatCtx = heatmapCanvas?.getContext('2d');
let heatmapVisible = false;
const HEAT_BIN = 6; // pixel bin size for density counting

function resizeHeatmap() {
    if (!heatmapCanvas) return;
    heatmapCanvas.width = window.innerWidth;
    heatmapCanvas.height = window.innerHeight;
}

function renderHeatmap() {
    if (!heatCtx || !heatmapVisible || !rendered.length) return;
    const w = heatmapCanvas.width;
    const h = heatmapCanvas.height;
    heatCtx.clearRect(0, 0, w, h);

    // Bin points into screen-space cells
    const bins = new Map();
    for (const sat of rendered) {
        if (!sat.primitive.show || !sat.primitive.position) continue;
        const c2s = Cesium.SceneTransforms.wgs84ToWindowCoordinates(
            viewer.scene, sat.primitive.position);
        if (!c2s) continue;
        const bx = Math.floor(c2s.x / HEAT_BIN);
        const by = Math.floor(c2s.y / HEAT_BIN);
        const key = `${bx},${by}`;
        bins.set(key, (bins.get(key) || 0) + 1);
    }
    if (!bins.size) return;

    // Find max for normalisation
    let maxVal = 0;
    for (const v of bins.values()) if (v > maxVal) maxVal = v;
    if (maxVal < 2) return;

    // Draw semi-transparent circles per bin
    for (const [key, count] of bins) {
        const [bx, by] = key.split(',').map(Number);
        const intensity = Math.min(count / maxVal, 1);
        const radius = HEAT_BIN * (1 + intensity * 3);
        const alpha = 0.05 + intensity * 0.35;
        // Cyan for low, yellow for mid, red for high
        const r = Math.round(intensity < 0.5 ? intensity * 2 * 255 : 255);
        const g = Math.round(intensity < 0.5 ? 200 + intensity * 110 : 255 * (1 - intensity));
        const b = Math.round(intensity < 0.5 ? 255 : 255 * (1 - intensity));
        heatCtx.beginPath();
        heatCtx.arc(
            bx * HEAT_BIN + HEAT_BIN / 2,
            by * HEAT_BIN + HEAT_BIN / 2,
            radius, 0, Math.PI * 2);
        heatCtx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
        heatCtx.fill();
    }
}

resizeHeatmap();
window.addEventListener('resize', resizeHeatmap);

const heatmapToggle = $('heatmap-toggle');
if (heatmapToggle) {
    heatmapToggle.addEventListener('click', () => {
        heatmapVisible = !heatmapVisible;
        heatmapToggle.textContent = heatmapVisible ? 'ON' : 'OFF';
        heatmapToggle.classList.toggle('st-toggle-btn--on', heatmapVisible);
        if (heatmapCanvas) heatmapCanvas.classList.toggle('is-visible', heatmapVisible);
        if (heatmapVisible) renderHeatmap();
        else if (heatCtx) heatCtx.clearRect(0, 0, heatmapCanvas.width, heatmapCanvas.height);
    });
}
// Re-render heatmap on camera move
viewer.camera.changed.addEventListener(() => { if (heatmapVisible) renderHeatmap(); });
viewer.camera.moveEnd.addEventListener(() => { if (heatmapVisible) renderHeatmap(); });

/* ── Filter drawer sync ────────────────────────────────────────────────────
 * On mobile, the filter drawer duplicates the filter form. We sync values
 * between the two sets of inputs so either surface controls the same state. */
const FILTER_FIELDS = ['f-q', 'f-type', 'f-country', 'f-regime', 'f-era', 'f-operator'];
const DRAWER_FIELDS = ['fd-q', 'fd-type', 'fd-country', 'fd-regime', 'fd-era', 'fd-operator'];

function syncDrawerFromForm() {
    FILTER_FIELDS.forEach((srcId, i) => {
        const src = $(srcId);
        const dst = $(DRAWER_FIELDS[i]);
        if (src && dst) dst.value = src.value;
    });
}

function syncFormFromDrawer() {
    DRAWER_FIELDS.forEach((srcId, i) => {
        const src = $(srcId);
        const dst = $(FILTER_FIELDS[i]);
        if (src && dst) dst.value = src.value;
    });
}

function populateDrawerSelects() {
    DRAWER_FIELDS.forEach((dstId, i) => {
        const src = $(FILTER_FIELDS[i]);
        const dst = $(dstId);
        if (!src || !dst) return;
        dst.innerHTML = src.innerHTML;
    });
}

/* Drawer apply: copy values to main form and render */
const fdApply = $('fd-apply');
if (fdApply) {
    fdApply.addEventListener('click', () => {
        syncFormFromDrawer();
        render();
        const overlay = $('filter-drawer-overlay');
        if (overlay) overlay.removeAttribute('open');
        document.body.classList.remove('filter-drawer-open');
    });
}

/* Drawer reset: clear both forms */
const fdReset = $('fd-reset');
if (fdReset) {
    fdReset.addEventListener('click', () => {
        DRAWER_FIELDS.forEach(id => { const el = $(id); if (el) el.value = ''; });
        FILTER_FIELDS.forEach(id => { const el = $(id); if (el) el.value = ''; });
        clearRendered();
        renderList([]);
        setText('results-count', '');
        status('ready');
        document.querySelectorAll('.st-preset-btn').forEach(b => b.classList.remove('st-preset-btn--active'));
    });
}

/* Sync drawer when it opens (via the overlay click handler in hud.js) */
const fdOverlay = $('filter-drawer-overlay');
if (fdOverlay) {
    const observer = new MutationObserver(() => {
        if (fdOverlay.hasAttribute('open')) syncDrawerFromForm();
    });
    observer.observe(fdOverlay, { attributes: true, attributeFilter: ['open'] });
}

/* ── Summary / Catalog Stats ──────────────────────────────────────────────── */
const num = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));

async function loadSummary() {
    try {
        const s = await API.summary();
        if (!s) return;
        const type = s.by_type || {};
        const regime = s.by_regime || {};
        const pick = (o, ...keys) => keys.reduce((n, k) => n ?? o[k], undefined);

        setText('cat-tracked', num(s.tracked));
        setText('cat-payload', num(pick(type, 'PAYLOAD', 'Payload')));
        setText('cat-rocket', num(pick(type, 'ROCKET BODY', 'Rocket Body')));
        setText('cat-debris', num(pick(type, 'DEBRIS', 'Debris')));
        setText('cat-leo', num(regime.LEO));
        setText('cat-meo', num(regime.MEO));
        setText('cat-geo', num(regime.GEO));
        setText('cat-heo', num(regime.HEO));
        setText('cat-updated', relTime(s.last_elset_ingest || s.generated_at));

        if (s.stale) status('catalog summary is being counted live — no artifact yet');
    } catch (err) {
        console.warn('[catalog] summary failed:', err);
        setText('cat-tracked', 'offline');
    }
}

/* ── Facets → filter options ──────────────────────────────────────────────── */
async function loadFacets() {
    try {
        const f = await API.facets();
        fillSelect('f-type', f.facets?.type);
        fillSelect('f-country', f.facets?.country);
        fillSelect('f-regime', f.facets?.regime);
        fillSelect('f-operator', f.facets?.operator);
    } catch (err) {
        console.warn('[catalog] facets failed:', err);
    }
}

function fillSelect(id, entries) {
    const el = $(id);
    if (!el || !entries) return;
    while (el.options.length > 1) el.remove(1);
    for (const e of entries) {
        if (e.key == null || e.key === '') continue;
        const opt = document.createElement('option');
        opt.value = e.key;
        opt.textContent = `${e.key} (${num(e.n)})`;
        el.appendChild(opt);
    }
}

/* ── Feed / Decay Watch / Boxscore (wave 4) ────────────────────────────────── */

async function loadFeed() {
    const list = $('feed-list');
    const hint = $('feed-hint');
    try {
        const r = await fetch(`${getApiBase()}/feed?limit=30`);
        if (!r.ok) throw new Error(`feed ${r.status}`);
        const f = await r.json();
        const events = f.events || [];
        if (!list) return;
        list.textContent = '';
        if (!events.length) {
            if (hint) hint.textContent = 'no events yet';
            return;
        }
        if (hint) hint.textContent = '';
        for (const e of events) {
            const li = document.createElement('li');
            li.className = 'st-feed__item';
            const title = document.createElement('span');
            title.className = 'st-feed__title';
            title.textContent = e.title || e.kind;
            const meta = document.createElement('span');
            meta.className = 'st-feed__meta';
            meta.textContent = `${relTime(e.ts)} · ${e.kind}`;
            li.append(title, meta);
            list.appendChild(li);
        }
    } catch (err) {
        console.warn('[catalog] feed failed:', err);
        if (hint) hint.textContent = 'feed unavailable';
    }
}

async function loadDecayWatch() {
    const list = $('decay-list');
    const hint = $('decay-hint');
    try {
        const r = await fetch(`${getApiBase()}/decay-watch?limit=20`);
        if (!r.ok) throw new Error(`decay-watch ${r.status}`);
        const d = await r.json();
        const watch = d.watch || [];
        if (!list) return;
        list.textContent = '';
        if (!watch.length) {
            if (hint) hint.textContent = 'no predicted reentries on file';
            return;
        }
        if (hint) hint.textContent = '';
        for (const w of watch) {
            const li = document.createElement('li');
            li.className = 'st-feed__item';
            const title = document.createElement('span');
            title.className = 'st-feed__title';
            title.textContent = w.name;
            const meta = document.createElement('span');
            const soon = w.days_until != null && w.days_until <= 7;
            meta.className = 'st-feed__meta' + (soon ? ' st-feed__meta--soon' : '');
            meta.textContent = w.days_until != null
                ? `~${w.days_until}d · ${w.country || '—'} · ${w.source || 'prediction'}`
                : `${w.decay_epoch || 'date unknown'} · ${w.country || '—'}`;
            li.append(title, meta);
            list.appendChild(li);
        }
    } catch (err) {
        console.warn('[catalog] decay-watch failed:', err);
        if (hint) hint.textContent = 'decay watch unavailable';
    }
}

async function loadBoxscore() {
    const bars = $('boxscore-bars');
    const hint = $('boxscore-hint');
    try {
        const r = await fetch(`${getApiBase()}/boxscore`);
        if (!r.ok) throw new Error(`boxscore ${r.status}`);
        const b = await r.json();
        const countries = (b.countries || []).slice(0, 10);
        if (!bars) return;
        bars.textContent = '';
        if (!countries.length) {
            if (hint) hint.textContent = 'no boxscore yet';
            return;
        }
        if (hint) hint.textContent = '';
        const maxTotal = countries[0]?.COUNTRY_TOTAL || 1;
        for (const c of countries) {
            const row = document.createElement('div');
            row.className = 'st-boxscore__row';
            const label = document.createElement('span');
            label.className = 'st-boxscore__country';
            label.textContent = c.COUNTRY;
            label.title = c.COUNTRY;
            const track = document.createElement('div');
            track.className = 'st-boxscore__track';
            const fill = document.createElement('div');
            fill.className = 'st-boxscore__fill';
            const pct = (c.COUNTRY_TOTAL / maxTotal) * 100;
            fill.style.width = `${pct}%`;
            fill.style.background = colorForCountry(c.SPADOC_CD || c.COUNTRY);
            track.appendChild(fill);
            const count = document.createElement('span');
            count.className = 'st-boxscore__count';
            count.textContent = num(c.COUNTRY_TOTAL);
            row.append(label, track, count);
            bars.appendChild(row);
        }
    } catch (err) {
        console.warn('[catalog] boxscore failed:', err);
        if (hint) hint.textContent = 'boxscore unavailable';
    }
}

/* ── Time-warp ─────────────────────────────────────────────────────────────── */
initTimeWarpButtons($('time-warp'));

/* ── Render / Query ─────────────────────────────────────────────────────────── */
let rendered = [];
let lastQuery = '';

function clearRendered() {
    rendered.forEach(s => engine.removeSat(s));
    rendered = [];
    if (debrisCloudVisible) { removeDebrisCloud(); debrisCloudVisible = false; }
    if (launchSitesVisible) { removeLaunchSites(); launchSitesVisible = false; }
    if (debrisCloudToggle) {
        debrisCloudToggle.textContent = 'OFF';
        debrisCloudToggle.classList.remove('st-toggle-btn--on');
        debrisCloudToggle.disabled = true;
    }
    if (launchSitesToggle) {
        launchSitesToggle.textContent = 'OFF';
        launchSitesToggle.classList.remove('st-toggle-btn--on');
    }
    if (ageColorMode) {
        ageColorMode = false;
        if (ageColorToggle) {
            ageColorToggle.textContent = 'OFF';
            ageColorToggle.classList.remove('st-toggle-btn--on');
        }
        if (ageLegend) ageLegend.hidden = true;
    }
}

function currentQuery() {
    const params = new URLSearchParams();
    const add = (key, id, transform) => {
        const el = $(id);
        if (!el) return;
        let v = (el.value || '').trim();
        if (!v) return;
        if (transform) v = transform(v);
        params.set(key, v);
    };
    add('q', 'f-q');
    add('type', 'f-type');
    add('country', 'f-country');
    add('regime', 'f-regime');
    add('era', 'f-era');
    add('operator', 'f-operator');
    params.set('tle', '1');
    params.set('limit', String(RENDER_CAP));
    return params;
}

function status(msg) {
    const el = $('f-status');
    if (el) el.textContent = msg;
}

async function render() {
    const params = currentQuery();
    lastQuery = params.toString();
    status('querying…');

    let data;
    try {
        const r = await fetch(`${getApiBase()}/search?${lastQuery}`);
        if (!r.ok) throw new Error(`search ${r.status}`);
        data = await r.json();
    } catch (err) {
        console.warn('[catalog] search failed:', err);
        status('query failed');
        return;
    }

    clearRendered();
    if (debrisCloudVisible) removeDebrisCloud();
    if (launchSitesVisible) removeLaunchSites();
    const noElset = addObjects(data.results);
    renderList(data.results);
    engine.flyToSats(rendered);

    const hasDebris = rendered.some(s => (s.meta?.row?.OBJECT_TYPE || '').toUpperCase() === 'DEBRIS');
    if (debrisCloudToggle) debrisCloudToggle.disabled = !hasDebris;
    if (!hasDebris && debrisCloudVisible) {
        debrisCloudVisible = false;
        if (debrisCloudToggle) {
            debrisCloudToggle.textContent = 'OFF';
            debrisCloudToggle.classList.remove('st-toggle-btn--on');
        }
    }
    if (launchSitesVisible) buildLaunchSites();

    const shown = rendered.length;
    const total = data.total || 0;
    let msg = `${num(shown)} rendered`;
    if (total > shown) msg += ` of ${num(total)} matched — refine to see the rest`;
    if (noElset) msg += ` · ${noElset} without an elset`;
    status(msg);
    setText('results-count', shown ? `(${num(shown)})` : '');
}

function addObjects(rows) {
    let noElset = 0;
    for (const row of rows) {
        if (!row.TLE_LINE1 || !row.TLE_LINE2) { noElset++; continue; }
        let satrec;
        try { satrec = satellite.twoline2satrec(row.TLE_LINE1, row.TLE_LINE2); }
        catch (_) { noElset++; continue; }

        const sz = regimeSize(row.apogee_km ?? row.perigee_km ?? 400);
        const isPayload = (row.OBJECT_TYPE || '').toUpperCase() === 'PAYLOAD';

        rendered.push(engine.addSatellite(satrec,
            Cesium.Color.fromCssColorString(colorForRow(row, colorMode, CB_TYPE_COLORS, CB_COUNTRY_COLORS)), sz, false, {
            satrec, l1: row.TLE_LINE1, l2: row.TLE_LINE2,
            name: row.OBJECT_NAME || String(row.NORAD_CAT_ID),
            group: row.OBJECT_TYPE || 'UNKNOWN',
            norad: row.NORAD_CAT_ID,
            pulse: isPayload,
            row,
        }));
    }
    return noElset;
}

function renderList(rows) {
    const list = $('results-list');
    const hint = $('results-hint');
    if (!list) return;
    list.textContent = '';
    if (!rows.length) {
        if (hint) hint.textContent = 'nothing matched those filters';
        return;
    }
    if (hint) hint.textContent = 'click a row to open its dossier';

    for (const row of rows.slice(0, 200)) {
        const li = document.createElement('li');
        li.className = 'st-result';
        li.dataset.norad = row.NORAD_CAT_ID;

        const swatch = document.createElement('span');
        swatch.className = 'st-result__swatch';
        swatch.style.background = colorForRow(row, colorMode, CB_TYPE_COLORS, CB_COUNTRY_COLORS);

        const name = document.createElement('span');
        name.className = 'st-result__name';
        name.textContent = row.OBJECT_NAME || `NORAD ${row.NORAD_CAT_ID}`;

        const meta = document.createElement('span');
        meta.className = 'st-result__meta';
        meta.textContent = [row.regime, row.COUNTRY_CODE, row.launch_year].filter(Boolean).join(' · ');

        li.append(swatch, name, meta);
        li.addEventListener('click', () => {
            openDossier(row.NORAD_CAT_ID);
            const sat = rendered.find(s => s.meta.norad === row.NORAD_CAT_ID);
            if (sat) engine.flyToSats([sat], { zoom: 8, duration: 1.2 });
        });
        list.appendChild(li);
    }
}

function setText(id, v) { const el = $(id); if (el) el.textContent = v; }

$('f-apply').addEventListener('click', render);
$('f-reset').addEventListener('click', () => {
    ['f-q', 'f-type', 'f-country', 'f-regime', 'f-era', 'f-operator'].forEach(id => { $(id).value = ''; });
    clearRendered();
    renderList([]);
    setText('results-count', '');
    status('ready');
    document.querySelectorAll('.st-preset-btn').forEach(b => b.classList.remove('st-preset-btn--active'));
});
$('f-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') render(); });

/* ── Dossier ──────────────────────────────────────────────────────────────── */
const dossier = $('dossier');
const dossierClose = $('dossier-close');
let dossierVisuals = null;
let dossierTimer = null;
let dossierSatrec = null;

/* ── Tier 1.4: Orbit trail ───────────────────────────────────────────────── */
const TRAIL_MAX = 60;            // max positions in the trail
const TRAIL_STEP_MS = 2000;      // ms between trail samples
let trailPositions = [];
let trailEntity = null;
let trailTimer = null;

function updateTrail() {
    if (!dossierSatrec) return;
    const p = engine.geo(dossierSatrec);
    if (!p) return;
    trailPositions.push(Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.alt * 1000));
    if (trailPositions.length > TRAIL_MAX) trailPositions.shift();
    if (trailPositions.length < 2) return;

    if (trailEntity) viewer.entities.remove(trailEntity);
    // Build a polyline with decreasing alpha for older points
    const alphas = trailPositions.map((_, i) => 0.05 + 0.55 * (i / trailPositions.length));
    // Draw as a single polyline with a gradient material (Cesium doesn't support per-vertex alpha on polylines,
    // so we draw a single solid trail with a low alpha for simplicity)
    trailEntity = viewer.entities.add({
        polyline: {
            positions: trailPositions,
            width: 1.5,
            material: new Cesium.PolylineGlowMaterialProperty({
                glowPower: 0.2,
                color: Cesium.Color.CYAN.withAlpha(0.35),
            }),
            arcType: Cesium.ArcType.NONE,
        },
    });
    engine.requestRender();
}

function startTrail() {
    trailPositions = [];
    if (trailTimer) clearInterval(trailTimer);
    trailTimer = engine.own(setInterval(updateTrail, TRAIL_STEP_MS));
    updateTrail();
}

function stopTrail() {
    if (trailTimer) { clearInterval(trailTimer); trailTimer = null; }
    if (trailEntity) { viewer.entities.remove(trailEntity); trailEntity = null; }
    trailPositions = [];
}

function closeDossier() {
    engine.removeEntities(dossierVisuals);
    dossierVisuals = null;
    dossierSatrec = null;
    stopTrail();
    if (dossierTimer) { clearInterval(dossierTimer); dossierTimer = null; }
    if (dossier) dossier.hidden = true;
}
dossierClose?.addEventListener('click', closeDossier);

async function openDossier(norad, meta) {
    if (!dossier || norad == null) return;
    dossier.hidden = false;
    setText('dossier-status', 'loading…');

    if (meta?.satrec) {
        State.set('selectedObject', {
            norad: meta.norad,
            name: meta.name,
            type: meta.group,
            regime: meta.row?.regime || '',
            l1: meta.l1,
            l2: meta.l2,
        });
        dossierSatrec = meta.satrec;
        engine.removeEntities(dossierVisuals);
        dossierVisuals = engine.addInspectVisuals(meta, '#ffffff');
        setText('dossier-name', `// ${meta.name}`);
        refreshLive();
        if (dossierTimer) clearInterval(dossierTimer);
        dossierTimer = engine.own(setInterval(refreshLive, 1000));
        startTrail();
    }

    let data;
    try {
        const r = await fetch(`${getApiBase()}/object/${encodeURIComponent(norad)}`);
        if (!r.ok) throw new Error(String(r.status));
        data = await r.json();
    } catch (err) {
        setText('dossier-status', `catalog record unavailable (${err.message})`);
        return;
    }

    const o = data.object;
    setText('dossier-name', `// ${o.OBJECT_NAME || 'UNNAMED'}`);
    setText('dossier-designator', o.OBJECT_ID || '—');
    setText('d-norad', o.NORAD_CAT_ID);
    setText('d-type', o.OBJECT_TYPE || '—');
    setText('d-country', o.COUNTRY_CODE || '—');
    setText('d-launch', o.LAUNCH_DATE || '—');
    setText('d-site', o.SITE || o.satcat_site || '—');
    setText('d-rcs', o.RCS_SIZE ? `${o.RCS_SIZE}${o.satcat_rcs_m2 ? ` · ${o.satcat_rcs_m2} m²` : ''}` : '—');
    setText('d-regime', o.regime || '—');
    setText('d-period', o.PERIOD != null ? `${Number(o.PERIOD).toFixed(1)} min` : '—');
    setText('d-apogee', o.apogee_km != null ? `${Math.round(o.apogee_km)} km` : '—');
    setText('d-perigee', o.perigee_km != null ? `${Math.round(o.perigee_km)} km` : '—');
    setText('d-incl', o.INCLINATION != null ? `${Number(o.INCLINATION).toFixed(2)}°` : '—');
    setText('d-epoch', relTime(o.EPOCH));

    if (!dossierSatrec && o.TLE_LINE1 && o.TLE_LINE2) {
        try {
            const satrec = satellite.twoline2satrec(o.TLE_LINE1, o.TLE_LINE2);
            dossierSatrec = satrec;
            dossierVisuals = engine.addInspectVisuals({ satrec, l1: o.TLE_LINE1, l2: o.TLE_LINE2 }, '#ffffff');
            refreshLive();
            if (dossierTimer) clearInterval(dossierTimer);
            dossierTimer = engine.own(setInterval(refreshLive, 1000));
            startTrail();
        } catch (_) { }
    }

    State.set('selectedObject', {
        norad: o.NORAD_CAT_ID,
        name: o.OBJECT_NAME,
        type: o.OBJECT_TYPE,
        regime: o.regime || '',
        l1: o.TLE_LINE1,
        l2: o.TLE_LINE2,
    });

    const decayEl = $('dossier-decay');
    if (decayEl) {
        const next = (data.decay || [])[0];
        decayEl.hidden = !next && !o.DECAY_DATE;
        if (o.DECAY_DATE) {
            decayEl.textContent = `DECAYED ${o.DECAY_DATE}`;
            decayEl.className = 'st-dossier__decay st-dossier__decay--done';
        } else if (next) {
            decayEl.textContent = `REENTRY PREDICTED ${next.DECAY_EPOCH} (${next.SOURCE || 'TIP'})`;
            decayEl.className = 'st-dossier__decay';
        }
    }

    setText('dossier-status', o.operator_derived
        ? `operator: ${o.operator} — inferred from the name, not a Space-Track field`
        : '');
}

function refreshLive() {
    if (!dossierSatrec) return;
    const p = engine.geo(dossierSatrec);
    if (!p) { setText('d-lat', 'no solution'); return; }
    setText('d-lat', fmtLat(p.lat));
    setText('d-lon', fmtLon(p.lon));
    setText('d-alt', `${Math.round(p.alt)} km`);
    setText('d-vel', `${orbVel(p.alt).toFixed(2)} km/s`);
}

/* Click a point → its dossier */
const clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
clickHandler.setInputAction((movement) => {
    const picked = viewer.scene.pick(movement.position);
    if (picked && picked.id && picked.id.meta) {
        const meta = picked.id.meta;
        openDossier(meta.norad, meta);
    }
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

/* ── Boot ────────────────────────────────────────────────────────────────── */
loadSummary();
loadFacets().then(() => populateDrawerSelects());
loadFeed();
loadDecayWatch();
loadBoxscore();

engine.own(setInterval(loadFeed, 5 * 60 * 1000));
engine.own(setInterval(loadDecayWatch, 5 * 60 * 1000));
engine.own(setInterval(loadBoxscore, 10 * 60 * 1000));

/* ══════════════════════════════════════════════════════════════════════════════
   TIER 2.2 — DEBRIS FIELD VISUALIZATION
   ══════════════════════════════════════════════════════════════════════════════ */
let debrisCloudEntities = [];
let debrisCloudVisible = false;

function buildDebrisCloud() {
    removeDebrisCloud();
    const debrisObjs = rendered.filter(s => {
        const t = (s.meta?.row?.OBJECT_TYPE || '').toUpperCase();
        return t === 'DEBRIS';
    });
    if (!debrisObjs.length) return;

    const BAND_WIDTH = 200;
    const MIN_ALT = 200;
    const MAX_ALT = 2200;
    const bands = new Map();

    for (const sat of debrisObjs) {
        const alt = sat.meta?.row?.apogee_km ?? sat.meta?.row?.perigee_km ?? 400;
        const band = Math.floor(alt / BAND_WIDTH) * BAND_WIDTH;
        if (band < MIN_ALT || band >= MAX_ALT) continue;
        bands.set(band, (bands.get(band) || 0) + 1);
    }

    if (!bands.size) return;

    let maxCount = 0;
    for (const v of bands.values()) if (v > maxCount) maxCount = v;

    const SEGMENTS = 180;
    for (const [alt, count] of bands) {
        const intensity = Math.min(count / Math.max(maxCount, 1), 1);
        const alpha = 0.06 + intensity * 0.25;
        const width = 0.8 + intensity * 2.5;
        const positions = [];
        for (let i = 0; i <= SEGMENTS; i++) {
            const lon = (i / SEGMENTS) * 360 - 180;
            positions.push(Cesium.Cartesian3.fromDegrees(lon, 0, (alt + BAND_WIDTH / 2) * 1000));
        }
        const entity = viewer.entities.add({
            polyline: {
                positions,
                width,
                material: new Cesium.PolylineGlowMaterialProperty({
                    glowPower: 0.12,
                    color: Cesium.Color.fromCssColorString('#ff5f6d').withAlpha(alpha),
                }),
                arcType: Cesium.ArcType.NONE,
            },
        });
        debrisCloudEntities.push(entity);
    }
    engine.requestRender();
}

function removeDebrisCloud() {
    for (const e of debrisCloudEntities) viewer.entities.remove(e);
    debrisCloudEntities = [];
}

const debrisCloudToggle = $('debris-cloud-toggle');
if (debrisCloudToggle) {
    debrisCloudToggle.addEventListener('click', () => {
        debrisCloudVisible = !debrisCloudVisible;
        debrisCloudToggle.textContent = debrisCloudVisible ? 'ON' : 'OFF';
        debrisCloudToggle.classList.toggle('st-toggle-btn--on', debrisCloudVisible);
        if (debrisCloudVisible) buildDebrisCloud();
        else removeDebrisCloud();
    });
}

/* ══════════════════════════════════════════════════════════════════════════════
   TIER 2.3 — LAUNCH SITE MARKERS
   ══════════════════════════════════════════════════════════════════════════════ */
const LAUNCH_SITES = {
    'CCAFS LC-13':      { lat: 28.488, lon: -80.577 },
    'CCAFS LC-14':      { lat: 28.491, lon: -80.578 },
    'CCAFS LC-17A':     { lat: 28.439, lon: -80.569 },
    'CCAFS LC-17B':     { lat: 28.438, lon: -80.568 },
    'CCAFS LC-20':      { lat: 28.462, lon: -80.567 },
    'CCAFS LC-26A':     { lat: 28.442, lon: -80.569 },
    'CCAFS LC-31':      { lat: 28.493, lon: -80.580 },
    'CCAFS LC-32':      { lat: 28.493, lon: -80.581 },
    'CCAFS LC-34':      { lat: 28.496, lon: -80.582 },
    'CCAFS LC-36':      { lat: 28.487, lon: -80.582 },
    'CCAFS LC-40':      { lat: 28.562, lon: -80.577 },
    'CCAFS LC-41':      { lat: 28.583, lon: -80.583 },
    'CCAFS SLC-40':     { lat: 28.562, lon: -80.577 },
    'CCAFS SLC-41':     { lat: 28.583, lon: -80.583 },
    'VAFB SLC-2E':      { lat: 34.742, lon: -120.572 },
    'VAFB SLC-2W':      { lat: 34.742, lon: -120.574 },
    'VAFB SLC-3E':      { lat: 34.757, lon: -120.601 },
    'VAFB SLC-4E':      { lat: 34.723, lon: -120.572 },
    'VAFB SLC-4W':      { lat: 34.723, lon: -120.574 },
    'VAFB SLC-6':       { lat: 34.740, lon: -120.585 },
    'WFF LC-0A':        { lat: 37.830, lon: -75.488 },
    'WFF LC-15.64E':    { lat: 37.830, lon: -75.488 },
    'WFF LC-15.64W':    { lat: 37.830, lon: -75.488 },
    'KSC LC-39A':       { lat: 28.608, lon: -80.604 },
    'KSC LC-39B':       { lat: 28.624, lon: -80.606 },
    'KSC LC-39C':       { lat: 28.619, lon: -80.605 },
    'KSC SPACEX LC-39A': { lat: 28.608, lon: -80.604 },
    'KSC UPFF':         { lat: 28.608, lon: -80.604 },
    'MLS':              { lat: 28.410, lon: -80.620 },
    'KODAK':            { lat: 28.410, lon: -80.620 },
    'ELA-1':            { lat: 5.232, lon: -52.767 },
    'ELA-2':            { lat: 5.234, lon: -52.768 },
    'ELA-3':            { lat: 5.236, lon: -52.769 },
    'ELA-4':            { lat: 5.238, lon: -52.770 },
    'SLC-4':            { lat: 5.233, lon: -52.768 },
    'BAIKONUR LC-1':    { lat: 45.965, lon: 63.305 },
    'BAIKONUR LC-31':   { lat: 45.996, lon: 63.282 },
    'BAIKONUR LC-45':   { lat: 46.030, lon: 62.950 },
    'BAIKONUR LC-81/23': { lat: 46.034, lon: 62.937 },
    'BAIKONUR LC-81/24': { lat: 46.034, lon: 62.938 },
    'BAIKONUR LC-90':   { lat: 46.030, lon: 62.950 },
    'PLESETSK LC-41':   { lat: 62.927, lon: 40.682 },
    'PLESETSK LC-43':   { lat: 62.880, lon: 40.741 },
    'PLESETSK LC-133':  { lat: 62.920, lon: 40.575 },
    'PLESETSK LC-158':  { lat: 62.860, lon: 40.820 },
    'TANEGASHIMA LA':   { lat: 30.401, lon: 131.019 },
    'TANEGASHIMA LB':   { lat: 30.397, lon: 130.974 },
    'UCHINOURA':        { lat: 31.252, lon: 131.076 },
    'KAGOSHIMA LP-1':   { lat: 31.783, lon: 130.736 },
    'KAGOSHIMA LP-2':   { lat: 31.774, lon: 130.735 },
    'KAGOSHIMA LC-1':   { lat: 31.774, lon: 130.735 },
    'SEMHAE':           { lat: 39.660, lon: 124.705 },
    'SOHAE':            { lat: 39.660, lon: 124.705 },
    'TONGHAE':          { lat: 39.660, lon: 124.705 },
    'JQU':              { lat: -1.483, lon: 110.453 },
    'XICHANG':          { lat: 28.246, lon: 102.027 },
    'JIUQUAN LC-1':     { lat: 40.959, lon: 100.291 },
    'JIUQUAN LC-2':     { lat: 40.959, lon: 100.292 },
    'TAIYUAN LC-1':     { lat: 38.850, lon: 111.600 },
    'TANDEM':           { lat: -31.615, lon: 115.953 },
    'WOOMERA':          { lat: -31.100, lon: 136.830 },
    'KAPUSTIN YAR LC-3': { lat: 48.567, lon: 45.750 },
    'KAPUSTIN YAR LC-5': { lat: 48.567, lon: 45.750 },
    'KAPUSTIN YAR LC-107': { lat: 48.567, lon: 45.750 },
    'PLESETSK LC-16':   { lat: 62.910, lon: 40.620 },
    'YASNY':            { lat: 51.093, lon: 59.858 },
    'SRIHARIKOTA FLP':  { lat: 13.720, lon: 80.230 },
    'SRIHARIKOTA SLP':  { lat: 13.720, lon: 80.230 },
    'SAC':              { lat: -15.600, lon: -73.980 },
    'SEALY':            { lat: 47.590, lon: -122.610 },
    'MAURITIUS':        { lat: -20.410, lon: 57.680 },
    'SAO TOME':         { lat: 0.330, lon: 6.620 },
    'KOUROU ELD':       { lat: 5.150, lon: -52.650 },
    'KOUROU ELP':       { lat: 5.150, lon: -52.650 },
    'WALLOPS':          { lat: 37.850, lon: -75.488 },
    'MARS':             { lat: 39.733, lon: -77.008 },
    'MARS FLP':         { lat: 39.733, lon: -77.008 },
    'HAMPTON':          { lat: 37.020, lon: -76.340 },
    'MURMANSK':         { lat: 68.950, lon: 33.090 },
    'ASCALON':          { lat: 48.567, lon: 45.750 },
    'CHINHAE':          { lat: 36.400, lon: 127.100 },
    'SWAN':             { lat: -32.000, lon: 115.000 },
    'ALCANTARA':        { lat: -2.300, lon: -44.400 },
    'THUMBA':           { lat: 8.547, lon: 76.874 },
    'HAINAN':           { lat: 19.614, lon: 110.951 },
    'HWANGJU':          { lat: 36.400, lon: 127.100 },
    'YAVNE':            { lat: 31.830, lon: 34.730 },
    'PAMELA':           { lat: 32.000, lon: 34.730 },
    'SVOBODNY':         { lat: 52.040, lon: 128.300 },
    'SVOBODNY-18':      { lat: 52.040, lon: 128.300 },
    'DOMBAROVSKY':      { lat: 51.093, lon: 59.858 },
    'KAPUSTIN YAR':     { lat: 48.567, lon: 45.750 },
    'NENOKSA':          { lat: 64.420, lon: 39.600 },
    'KAP YAR':          { lat: 48.567, lon: 45.750 },
};

let launchSiteEntities = [];
let launchSitesVisible = false;

function resolveSiteCoords(siteName) {
    if (!siteName) return null;
    const normalized = siteName.trim().toUpperCase();
    if (LAUNCH_SITES[normalized]) return LAUNCH_SITES[normalized];
    for (const [key, coords] of Object.entries(LAUNCH_SITES)) {
        if (normalized.includes(key) || key.includes(normalized)) return coords;
    }
    return null;
}

function buildLaunchSites() {
    removeLaunchSites();
    const siteNames = new Map();
    for (const sat of rendered) {
        const site = sat.meta?.row?.SITE || sat.meta?.row?.satcat_site;
        if (!site) continue;
        siteNames.set(site, (siteNames.get(site) || 0) + 1);
    }
    for (const [siteName, count] of siteNames) {
        const coords = resolveSiteCoords(siteName);
        if (!coords) continue;
        const entity = viewer.entities.add({
            position: Cesium.Cartesian3.fromDegrees(coords.lon, coords.lat, 0),
            point: {
                pixelSize: 5,
                color: Cesium.Color.fromCssColorString('#00d2ff').withAlpha(0.7),
                outlineColor: Cesium.Color.WHITE.withAlpha(0.5),
                outlineWidth: 1,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            },
            label: {
                text: siteName,
                font: '10px monospace',
                fillColor: Cesium.Color.fromCssColorString('#00d2ff').withAlpha(0.8),
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
            _siteData: { name: siteName, count },
        });
        launchSiteEntities.push(entity);
    }
    engine.requestRender();
}

function removeLaunchSites() {
    for (const e of launchSiteEntities) viewer.entities.remove(e);
    launchSiteEntities = [];
}

const launchSitesToggle = $('launch-sites-toggle');
if (launchSitesToggle) {
    launchSitesToggle.addEventListener('click', () => {
        launchSitesVisible = !launchSitesVisible;
        launchSitesToggle.textContent = launchSitesVisible ? 'ON' : 'OFF';
        launchSitesToggle.classList.toggle('st-toggle-btn--on', launchSitesVisible);
        if (launchSitesVisible) buildLaunchSites();
        else removeLaunchSites();
    });
}

/* ══════════════════════════════════════════════════════════════════════════════
   TIER 2.4 — OBJECT AGE COLORING
   ══════════════════════════════════════════════════════════════════════════════ */
let ageColorMode = false;

function ageColor(row) {
    const dateStr = row.EPOCH || row.LAUNCH_DATE;
    if (!dateStr) return null;
    const ageDays = (Date.now() - Date.parse(dateStr)) / 86400000;
    const maxAge = 365 * 3;
    const t = Math.min(ageDays / maxAge, 1);
    const r = Math.round(0 + t * 0);
    const g = Math.round(210 * (1 - t * 0.85));
    const b = Math.round(255 * (1 - t * 0.7));
    const a = 0.95 - t * 0.5;
    return `rgba(${r},${g},${b},${a})`;
}

function recolorByAge() {
    for (const sat of rendered) {
        const row = sat.meta?.row;
        if (!row) continue;
        const c = ageColor(row);
        if (c) sat.primitive.color = Cesium.Color.fromCssColorString(c);
    }
    engine.requestRender();
}

const ageColorToggle = $('age-color-toggle');
const ageLegend = $('age-legend');
if (ageColorToggle) {
    ageColorToggle.addEventListener('click', () => {
        ageColorMode = !ageColorMode;
        ageColorToggle.textContent = ageColorMode ? 'ON' : 'OFF';
        ageColorToggle.classList.toggle('st-toggle-btn--on', ageColorMode);
        if (ageLegend) ageLegend.hidden = !ageColorMode;
        if (ageColorMode) recolorByAge();
        else recolorRendered();
    });
}

/* ══════════════════════════════════════════════════════════════════════════════
   TIER 3.1 — LOD SYSTEM
   ══════════════════════════════════════════════════════════════════════════════ */
const LOD_CLOSE_THRESHOLD = 500000;
const LOD FAR_THRESHOLD = 5000000;
const LOD_CLOSE_CAP = 400;

function updateLOD() {
    const height = viewer.camera.positionCartographic.height;
    if (height > LOD_FAR_THRESHOLD) {
        for (const sat of rendered) sat.primitive.show = true;
    } else if (height < LOD_CLOSE_THRESHOLD) {
        const camPos = viewer.camera.position;
        const sorted = rendered.map(sat => {
            const pos = sat.primitive.position;
            if (!pos) return { sat, dist: Infinity };
            const dx = pos.x - camPos.x;
            const dy = pos.y - camPos.y;
            const dz = pos.z - camPos.z;
            return { sat, dist: dx * dx + dy * dy + dz * dz };
        }).sort((a, b) => a.dist - b.dist);
        for (let i = 0; i < sorted.length; i++) {
            sorted[i].sat.primitive.show = i < LOD_CLOSE_CAP;
        }
    } else {
        for (const sat of rendered) sat.primitive.show = true;
    }
    engine.requestRender();
}

viewer.camera.moveEnd.addEventListener(updateLOD);

/* ══════════════════════════════════════════════════════════════════════════════
   TIER 3.2 — TIME-BASED FILTER PRESETS
   ══════════════════════════════════════════════════════════════════════════════ */
function wirePresetBtns(precentId, decayId) {
    const recentBtn = $(precentId);
    const decayBtn = $(decayId);
    if (recentBtn) {
        recentBtn.addEventListener('click', () => {
            const now = new Date();
            const d = new Date(now - 30 * 86400000);
            const yr = d.getUTCFullYear();
            ['f-q', 'f-type', 'f-country', 'f-regime', 'f-era', 'f-operator'].forEach(id => { const el = $(id); if (el) el.value = ''; });
            const typeEl = $('f-type');
            if (typeEl) typeEl.value = 'PAYLOAD';
            const statusEl = $('f-status');
            if (statusEl) statusEl.textContent = `launches since ${yr}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
            renderWithEra(yr);
        });
    }
    if (decayBtn) {
        decayBtn.addEventListener('click', async () => {
            status('querying decaying objects…');
            const params = new URLSearchParams({ tle: '1', limit: String(RENDER_CAP), include_decayed: '0' });
            const now = new Date();
            const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
            const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
            const yearFrom = monthStart.getUTCFullYear();
            params.set('year_from', String(yearFrom));
            let data;
            try {
                const r = await fetch(`${getApiBase()}/search?${params}`);
                if (!r.ok) throw new Error(`search ${r.status}`);
                data = await r.json();
            } catch (err) {
                status('query failed');
                return;
            }
            const filtered = (data.results || []).filter(row => {
                if (!row.DECAY_DATE) return false;
                const d = Date.parse(row.DECAY_DATE);
                return d >= monthStart.getTime() && d <= monthEnd.getTime();
            });
            clearRendered();
            addObjects(filtered);
            renderList(filtered);
            engine.flyToSats(rendered);
            status(`${rendered.length} objects predicted to decay this month`);
            setText('results-count', rendered.length ? `(${num(rendered.length)})` : '');
        });
    }
}

function renderWithEra(yearFrom) {
    const params = currentQuery();
    params.delete('era');
    params.set('year_from', String(yearFrom));
    params.set('tle', '1');
    params.set('limit', String(RENDER_CAP));
    lastQuery = params.toString();
    status('querying…');
    fetch(`${getApiBase()}/search?${lastQuery}`)
        .then(r => { if (!r.ok) throw new Error(`search ${r.status}`); return r.json(); })
        .then(data => {
            clearRendered();
            addObjects(data.results);
            renderList(data.results);
            engine.flyToSats(rendered);
            const shown = rendered.length;
            const total = data.total || 0;
            let msg = `${num(shown)} rendered`;
            if (total > shown) msg += ` of ${num(total)} matched`;
            status(msg);
            setText('results-count', shown ? `(${num(shown)})` : '');
        })
        .catch(err => { console.warn('[catalog] search failed:', err); status('query failed'); });
}

wirePresetBtns('f-preset-recent', 'f-preset-decay');
wirePresetBtns('fd-preset-recent', 'fd-preset-decay');

/* ══════════════════════════════════════════════════════════════════════════════
   TIER 3.3 — CROSS-PAGE STATE SYNC (colorMode)
   ══════════════════════════════════════════════════════════════════════════════ */
State.subscribe('preferences.colorMode', (newMode) => {
    if (newMode && newMode !== colorMode) {
        colorMode = newMode;
        applyColorModeUI();
        if (rendered.length) recolorRendered();
    }
});

/* ══════════════════════════════════════════════════════════════════════════════
   TIER 3.4 — SCREENSHOT / SNAPSHOT BUTTON
   ══════════════════════════════════════════════════════════════════════════════ */
const screenshotBtn = $('screenshot-btn');
if (screenshotBtn) {
    screenshotBtn.addEventListener('click', async (e) => {
        const canvas = viewer.scene.canvas;
        let blob;
        try {
            blob = await new Promise((resolve, reject) => {
                canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/png');
            });
        } catch (err) {
            console.warn('[catalog] screenshot failed:', err);
            return;
        }
        if (e.shiftKey) {
            try {
                await navigator.clipboard.write([
                    new ClipboardItem({ 'image/png': blob }),
                ]);
                screenshotBtn.classList.add('st-screenshot-btn--copied');
                screenshotBtn.textContent = '✓';
                setTimeout(() => {
                    screenshotBtn.classList.remove('st-screenshot-btn--copied');
                    screenshotBtn.textContent = '\u{1F4F7}';
                }, 1500);
            } catch (err) {
                console.warn('[catalog] clipboard write failed:', err);
                const url = URL.createObjectURL(blob);
                window.open(url, '_blank');
            }
        } else {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            a.download = `spacetrack-${ts}.png`;
            a.click();
            URL.revokeObjectURL(url);
        }
    });
}

/* ── Default data: auto-render recent payloads on first load ────────────── */
(async function loadDefault() {
    const params = new URLSearchParams({ type: 'PAYLOAD', limit: '200', tle: '1' });
    status('loading catalog…');
    let data;
    try {
        const r = await fetch(`${getApiBase()}/search?${params}`);
        if (!r.ok) throw new Error(`search ${r.status}`);
        data = await r.json();
    } catch (err) {
        console.warn('[catalog] default load failed:', err);
        status('catalog offline');
        return;
    }
    const noElset = addObjects(data.results);
    renderList(data.results);
    engine.flyToSats(rendered);

    const hasDebris = rendered.some(s => (s.meta?.row?.OBJECT_TYPE || '').toUpperCase() === 'DEBRIS');
    if (debrisCloudToggle) debrisCloudToggle.disabled = !hasDebris;

    const shown = rendered.length;
    const total = data.total || 0;
    let msg = `${num(shown)} rendered`;
    if (total > shown) msg += ` of ${num(total)} payloads`;
    if (noElset) msg += ` · ${noElset} without an elset`;
    status(msg);
    setText('results-count', shown ? `(${num(shown)})` : '');
})();

/* ── GEO belt glow ring ─────────────────────────────────────────────────── */
(function addGeoBelt() {
    const GEO_ALT_KM = 35786;
    const SEGMENTS = 180;
    const positions = [];
    for (let i = 0; i <= SEGMENTS; i++) {
        const lon = (i / SEGMENTS) * 360 - 180;
        positions.push(Cesium.Cartesian3.fromDegrees(lon, 0, GEO_ALT_KM * 1000));
    }
    viewer.entities.add({
        polyline: {
            positions,
            width: 1.2,
            material: new Cesium.PolylineGlowMaterialProperty({
                glowPower: 0.15,
                color: Cesium.Color.fromCssColorString('#ffe066').withAlpha(0.25),
            }),
            arcType: Cesium.ArcType.NONE,
        },
    });
    // Second ring slightly offset for depth
    const positions2 = [];
    for (let i = 0; i <= SEGMENTS; i++) {
        const lon = (i / SEGMENTS) * 360 - 180;
        positions2.push(Cesium.Cartesian3.fromDegrees(lon, 0, (GEO_ALT_KM + 200) * 1000));
    }
    viewer.entities.add({
        polyline: {
            positions: positions2,
            width: 0.6,
            material: new Cesium.PolylineGlowMaterialProperty({
                glowPower: 0.08,
                color: Cesium.Color.fromCssColorString('#ffe066').withAlpha(0.12),
            }),
            arcType: Cesium.ArcType.NONE,
        },
    });
})();

viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(20, 25, 24000000),
    duration: 2.4,
    easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
});

/* ── Helpers ──────────────────────────────────────────────────────────────── */
function relTime(iso) {
    if (!iso) return '—';
    const then = Date.parse(iso);
    if (Number.isNaN(then)) return '—';
    const mins = Math.round((Date.now() - then) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 48) return `${hours} h ago`;
    return `${Math.round(hours / 24)} d ago`;
}

/* Debug handle */
window.__spacetrack = {
    viewer, engine,
    get satPointCount() { return engine.satPointCount; },
    get rendered() { return rendered.length; },
    get booted() { return !!engine; },
    get worker() { return engine.worker; },
    get workerReady() { return engine.workerReady; },
    get tickCount() { return engine.tickCount; },
    get lastQuery() { return lastQuery; },
    get source() { return 'spacetrack'; },
    get colorMode() { return colorMode; },
    get ageColorMode() { return ageColorMode; },
    get debrisCloudVisible() { return debrisCloudVisible; },
    get launchSitesVisible() { return launchSitesVisible; },
    render, openDossier, closeDossier, clearRendered,
    loadSummary, loadFacets, loadFeed, loadDecayWatch, loadBoxscore,
    buildDebrisCloud, removeDebrisCloud,
    buildLaunchSites, removeLaunchSites,
    recolorByAge,
};
