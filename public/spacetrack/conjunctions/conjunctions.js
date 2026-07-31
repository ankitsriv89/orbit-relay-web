import { orbVel, fmtLat, fmtLon } from '../../orbit-engine/astro.js';
import {
    ConjunctionScreener, SCREEN_WINDOWS, SCREEN_THRESHOLDS_KM,
} from '../../orbit-engine/screen-client.js';
import { initGlobe, initTimeWarpButtons } from '../shared/globe.js';
import { State } from '../shared/state.js';
import { $, setText, num, relTime, fmtMiss, fmtWhen, fmtRelSpeed, fmtElsetAge, TYPE_COLORS, colorFor } from '../shared/utils.js';
import { getApiBase } from '../shared/api.js';
import { wireHudToggle, initHamburgerMenu, wireTabs } from '/shared/hud.js';

const RENDER_CAP = 500;

const { viewer, engine } = initGlobe();
const clock = viewer.clock;

/* ── HUD toggles ───────────────────────────────────────────────────────────── */
wireHudToggle('catalog-hud', 'catalog-hud-toggle', 'catalog-hud-body');
wireHudToggle('screening-hud', 'screening-hud-toggle', 'screening-hud-body');
wireTabs(document.getElementById('screening-hud-body'));
initHamburgerMenu();

/* ── Time-warp ────────────────────────────────────────────────────────────── */
initTimeWarpButtons($('time-warp'));

/* ── Render objects ────────────────────────────────────────────────────────── */
let rendered = [];
let lastQuery = '';

function clearRendered() {
    rendered.forEach(s => engine.removeSat(s));
    rendered = [];
    screener.cancel();
    const list = $('c-list');
    if (list) list.textContent = '';
    conjStatus('screens the objects currently rendered');
    renderObjectsList([]);
}

function status(msg) {
    const el = $('f-status');
    if (el) el.textContent = msg;
}

function currentQuery() {
    const params = new URLSearchParams();
    const selObj = State.get('selectedObject');
    if (selObj && selObj.norad) {
        params.set('q', String(selObj.norad));
    }
    params.set('tle', '1');
    params.set('limit', String(RENDER_CAP));
    return params;
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
        console.warn('[conjunctions] search failed:', err);
        status('query failed');
        return;
    }

    clearRendered();
    const noElset = addObjects(data.results);
    renderObjectsList(data.results);
    engine.flyToSats(rendered);

    const shown = rendered.length;
    const total = data.total || 0;
    let msg = `${num(shown)} rendered`;
    if (total > shown) msg += ` of ${num(total)} matched`;
    if (noElset) msg += ` · ${noElset} without an elset`;
    status(msg);
}

function addObjects(rows) {
    let noElset = 0;
    for (const row of rows) {
        if (!row.TLE_LINE1 || !row.TLE_LINE2) { noElset++; continue; }
        let satrec;
        try { satrec = satellite.twoline2satrec(row.TLE_LINE1, row.TLE_LINE2); }
        catch (_) { noElset++; continue; }

        rendered.push(engine.addSatellite(satrec, colorFor(row.OBJECT_TYPE), 4, false, {
            satrec, l1: row.TLE_LINE1, l2: row.TLE_LINE2,
            name: row.OBJECT_NAME || String(row.NORAD_CAT_ID),
            group: row.OBJECT_TYPE || 'UNKNOWN',
            norad: row.NORAD_CAT_ID,
            row,
        }));
    }
    return noElset;
}

function renderObjectsList(rows) {
    const list = $('c-objects-list');
    const hint = $('c-objects-hint');
    if (!list) return;
    list.textContent = '';
    if (!rows.length) {
        if (hint) hint.textContent = 'no objects rendered';
        return;
    }
    if (hint) hint.textContent = '';

    for (const row of rows.slice(0, 100)) {
        const li = document.createElement('li');
        li.className = 'st-result';
        const swatch = document.createElement('span');
        swatch.className = 'st-result__swatch';
        swatch.style.background = colorFor(row.OBJECT_TYPE);
        const name = document.createElement('span');
        name.className = 'st-result__name';
        name.textContent = row.OBJECT_NAME || `NORAD ${row.NORAD_CAT_ID}`;
        const meta = document.createElement('span');
        meta.className = 'st-result__meta';
        meta.textContent = [row.regime, row.COUNTRY_CODE].filter(Boolean).join(' · ');
        li.append(swatch, name, meta);
        list.appendChild(li);
    }
}

/* ── Conjunction screening ─────────────────────────────────────────────────── */
const screener = new ConjunctionScreener();
let lastScreen = null;

function fillPresets() {
    const w = $('c-window');
    const t = $('c-threshold');
    if (w) {
        SCREEN_WINDOWS.forEach((opt, i) => {
            const o = document.createElement('option');
            o.value = String(opt.sec);
            o.textContent = `next ${opt.label}`;
            if (i === 1) o.selected = true;
            w.appendChild(o);
        });
    }
    if (t) {
        SCREEN_THRESHOLDS_KM.forEach(km => {
            const o = document.createElement('option');
            o.value = String(km);
            o.textContent = `${km} km`;
            if (km === 10) o.selected = true;
            t.appendChild(o);
        });
    }
}
fillPresets();

const conjStatus = (msg) => setText('c-status', msg);

function setScreenProgress(step, total) {
    const wrap = $('c-progress');
    const bar = $('c-progress-bar');
    if (wrap) wrap.hidden = false;
    if (bar) bar.style.width = `${Math.round((step / Math.max(total, 1)) * 100)}%`;
}

function endScreenProgress() {
    const wrap = $('c-progress');
    if (wrap) wrap.hidden = true;
    const bar = $('c-progress-bar');
    if (bar) bar.style.width = '0%';
    const run = $('c-run');
    const cancel = $('c-cancel');
    if (run) run.disabled = false;
    if (cancel) cancel.disabled = true;
}

async function runScreen() {
    const list = $('c-list');
    if (list) list.textContent = '';
    lastScreen = null;

    if (!rendered.length) {
        conjStatus('nothing rendered — load objects from the Catalog first');
        return;
    }

    const thresholdKm = Number($('c-threshold').value) || 10;
    const windowSec = Number($('c-window').value) || 7200;
    const t0Ms = engine.now().getTime();

    const objects = rendered.map(s => ({
        norad: s.meta.norad,
        name: s.meta.name,
        type: s.meta.group,
        l1: s.meta.l1,
        l2: s.meta.l2,
    }));

    $('c-run').disabled = true;
    $('c-cancel').disabled = false;
    conjStatus(`screening ${num(objects.length)} objects…`);
    setScreenProgress(0, 1);

    let out;
    try {
        out = await screener.run(objects, { thresholdKm, windowSec, t0Ms },
                                 (step, total) => setScreenProgress(step, total));
    } catch (err) {
        if (err.message === 'superseded') return;
        endScreenProgress();
        conjStatus(err.message === 'cancelled' ? 'screen cancelled' : `screening unavailable: ${err.message}`);
        if (!screener.available && $('c-run')) $('c-run').disabled = true;
        return;
    }

    endScreenProgress();
    lastScreen = out;
    renderConjunctions(out.rows, out.stats);
}

function renderConjunctions(rows, stats) {
    const list = $('c-list');
    const windowLabel = (SCREEN_WINDOWS.find(w => w.sec === stats.windowSec) || {}).label
                        || `${Math.round(stats.windowSec / 60)} min`;
    const plural = (n, word) => `${num(n)} ${word}${n === 1 ? '' : 's'}`;
    const screened = `${plural(stats.objectsScreened, 'object')} · ` +
                     `${plural(stats.pairsScreened, 'pair')} · ` +
                     `${(stats.elapsedMs / 1000).toFixed(1)}s`;

    if (!rows.length) {
        conjStatus(`no approaches under ${stats.thresholdKm} km in the next ${windowLabel} — ${screened}`);
        return;
    }
    const capped = stats.found > stats.shown ? ` (closest ${num(stats.shown)} listed)` : '';
    conjStatus(`${num(stats.found)} under ${stats.thresholdKm} km in the next ${windowLabel}${capped} — ${screened}`);

    if (!list) return;
    for (const r of rows) {
        const li = document.createElement('li');
        li.className = 'st-feed__item st-result';

        const pair = document.createElement('span');
        pair.className = 'st-conj__pair';
        pair.textContent = `${r.a.name} ✕ ${r.b.name}`;

        const meta = document.createElement('span');
        meta.className = 'st-feed__meta';

        const miss = document.createElement('span');
        miss.className = 'st-conj__miss' + (r.missKm < 1 ? ' st-conj__miss--tight' : '');
        miss.textContent = fmtMiss(r.missKm);

        const rest = document.createElement('span');
        rest.textContent = ` · ${fmtWhen(r)} · ${fmtRelSpeed(r.relSpeedKms)} · `;

        const age = document.createElement('span');
        age.className = 'st-conj__age';
        age.textContent = fmtElsetAge(r);

        meta.append(miss, rest, age);
        li.append(pair, meta);

        li.addEventListener('click', () => {
            const sats = [r.a.norad, r.b.norad]
                .map(n => rendered.find(s => s.meta.norad === n))
                .filter(Boolean);
            if (sats.length) engine.flyToSats(sats, { zoom: 6, duration: 1.2 });
            openDossier(r.a.norad, sats[0] ? sats[0].meta : undefined);
        });
        list.appendChild(li);
    }
}

$('c-run').addEventListener('click', runScreen);
$('c-cancel').addEventListener('click', () => {
    screener.cancel();
    conjStatus('cancelling…');
});

/* ── Dossier ────────────────────────────────────────────────────────────────── */
const dossier = $('dossier');
const dossierClose = $('dossier-close');
let dossierVisuals = null;
let dossierTimer = null;
let dossierSatrec = null;

function closeDossier() {
    engine.removeEntities(dossierVisuals);
    dossierVisuals = null;
    dossierSatrec = null;
    if (dossierTimer) { clearInterval(dossierTimer); dossierTimer = null; }
    if (dossier) dossier.hidden = true;
}
dossierClose?.addEventListener('click', closeDossier);

async function openDossier(norad, meta) {
    if (!dossier || norad == null) return;
    dossier.hidden = false;
    setText('dossier-status', 'loading…');

    if (meta?.satrec) {
        dossierSatrec = meta.satrec;
        engine.removeEntities(dossierVisuals);
        dossierVisuals = engine.addInspectVisuals(meta, '#ffffff');
        setText('dossier-name', `// ${meta.name}`);
        refreshLive();
        if (dossierTimer) clearInterval(dossierTimer);
        dossierTimer = engine.own(setInterval(refreshLive, 1000));
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
        } catch (_) { }
    }

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

const clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
clickHandler.setInputAction((movement) => {
    const picked = viewer.scene.pick(movement.position);
    if (picked && picked.id && picked.id.meta) {
        const meta = picked.id.meta;
        openDossier(meta.norad, meta);
    }
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

/* ── Boot ──────────────────────────────────────────────────────────────────── */
const selObj = State.get('selectedObject');
if (selObj && selObj.norad) {
    render();
} else {
    conjStatus('select an object on the Catalog page first, or the screen panel will be empty');
}

/* ── Debug handle ──────────────────────────────────────────────────────────── */
window.__spacetrack = {
    viewer, engine,
    get satPointCount() { return engine.satPointCount; },
    get rendered() { return rendered.length; },
    get booted() { return !!engine; },
    get worker() { return engine.worker; },
    get workerReady() { return engine.workerReady; },
    get tickCount() { return engine.tickCount; },
    get lastQuery() { return lastQuery; },
    get source() { return 'conjunctions'; },
    render, openDossier, closeDossier, clearRendered,
    screener, runScreen, addObjects,
    get lastScreen() { return lastScreen; },
};
