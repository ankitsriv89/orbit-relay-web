/**
 * SpaceTrack Catalog Page — Main entry point for satellite discovery and visualization.
 * 3D Cesium Globe + Filters + Results + Object Dossier
 */

import { createDossier } from '/shared/dossier.js';
import { initGlobe, initTimeWarpButtons } from './shared/globe.js';
import { State } from './shared/state.js';
import { API } from './shared/api.js';
import {
    wireHudToggle, initHamburgerMenu, initFilterDrawer, closeAllHuds,
    wireRevsButton, syncRevsButtons, currentRevs,
} from '/shared/hud.js';
import { regimeSize, on } from './shared/utils.js';
import { exposeDebug } from './shared/debug.js';
import { createHeatmap } from './overlays/heatmap.js';
import { createDebris } from './overlays/debris.js';
import { createLaunchSites } from './overlays/launch-sites.js';
import { createAge } from './overlays/age.js';
import { createLOD } from './overlays/lod.js';
import { createRegimeShells } from './overlays/regime-shells.js';
import {
    TYPE_COLORS, COUNTRY_COLORS, CB_TYPE_COLORS, CB_COUNTRY_COLORS,
    colorForRow,
} from '/theme/palette.js';

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
wireHudToggle('results-hud', 'results-hud-toggle', 'results-hud-body');
initHamburgerMenu();
initFilterDrawer();

/* ── Color mode (type vs country) ─────────────────────────────────────────── */
let colorMode = State.get('preferences.colorMode') || 'type';

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

/* ── Time-warp ─────────────────────────────────────────────────────────────── */
initTimeWarpButtons($('time-warp'));

/* ── Orbit revolution count (plan 35 §3, S6) ──────────────────────────────── */
syncRevsButtons(currentRevs());
wireRevsButton($('revs-toggle'));

/* ── Render / Query ─────────────────────────────────────────────────────────── */
let rendered = [];
let lastQuery = '';

createHeatmap({ viewer, getRendered: () => rendered });
const debris = createDebris({ viewer, engine, getRendered: () => rendered });
const launchSites = createLaunchSites({ viewer, engine, getRendered: () => rendered });
const age = createAge({ engine, getRendered: () => rendered, recolorRendered });
createLOD({ viewer, engine, getRendered: () => rendered });
createRegimeShells({ viewer, engine });

function clearRendered() {
    rendered.forEach(s => engine.removeSat(s));
    rendered = [];
    debris.reset();
    launchSites.reset();
    age.reset();
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
        data = await API.search(Object.fromEntries(params));
    } catch (err) {
        console.warn('[catalog] search failed:', err);
        status('query failed');
        return;
    }

    clearRendered();
    const noElset = addObjects(data.results);
    renderList(data.results);
    engine.flyToSats(rendered);

    const hasDebris = rendered.some(s => (s.meta?.row?.OBJECT_TYPE || '').toUpperCase() === 'DEBRIS');
    debris.setEnabled(hasDebris);

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

on('f-apply', 'click', render);
on('f-reset', 'click', () => {
    ['f-q', 'f-type', 'f-country', 'f-regime', 'f-era', 'f-operator'].forEach(id => { $(id).value = ''; });
    clearRendered();
    renderList([]);
    setText('results-count', '');
    status('ready');
    document.querySelectorAll('.st-preset-btn').forEach(b => b.classList.remove('st-preset-btn--active'));
});
on('f-q', 'keydown', (e) => { if (e.key === 'Enter') render(); });

/* ── Dossier ──────────────────────────────────────────────────────────────── */
const { open: openDossier, close: closeDossier } =
    createDossier({ viewer, engine, State, trail: true });

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
                data = await API.search(Object.fromEntries(params));
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
    API.search(Object.fromEntries(params))
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
    status('loading catalog…');
    let data;
    try {
        data = await API.search({ type: 'PAYLOAD', limit: '200', tle: '1' });
    } catch (err) {
        console.warn('[catalog] default load failed:', err);
        status('catalog offline');
        return;
    }
    const noElset = addObjects(data.results);
    renderList(data.results);
    engine.flyToSats(rendered);

    const hasDebris = rendered.some(s => (s.meta?.row?.OBJECT_TYPE || '').toUpperCase() === 'DEBRIS');
    debris.setEnabled(hasDebris);

    const shown = rendered.length;
    const total = data.total || 0;
    let msg = `${num(shown)} rendered`;
    if (total > shown) msg += ` of ${num(total)} payloads`;
    if (noElset) msg += ` · ${noElset} without an elset`;
    status(msg);
    setText('results-count', shown ? `(${num(shown)})` : '');
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
exposeDebug('catalog', {
    viewer, engine,
    get satPointCount() { return engine.satPointCount; },
    get rendered() { return rendered.length; },
    get booted() { return !!engine; },
    get worker() { return engine.worker; },
    get workerReady() { return engine.workerReady; },
    get tickCount() { return engine.tickCount; },
    get lastQuery() { return lastQuery; },
    get colorMode() { return colorMode; },
    get ageColorMode() { return age.visible; },
    get debrisCloudVisible() { return debris.visible; },
    get launchSitesVisible() { return launchSites.visible; },
    render, openDossier, closeDossier, clearRendered,
    loadSummary, loadFacets,
    buildDebrisCloud: () => debris.build(),
    removeDebrisCloud: () => debris.remove(),
    buildLaunchSites: () => launchSites.build(),
    removeLaunchSites: () => launchSites.remove(),
    recolorByAge: () => age.recolor(),
});
