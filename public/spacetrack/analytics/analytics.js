import { $, setText, num } from '../shared/utils.js';
import { exposeDebug } from '../shared/debug.js';
import { API } from '../shared/api.js';
import { initMobileListener } from '/shared/hud.js';

initMobileListener();

/* ── Analytics ────────────────────────────────────────────────────────────────
 * Launch-history dashboard: launches by decade, top launch sites, debris
 * families and a country-by-decade matrix. Rendered with CSS bars and a
 * heatmap table — no charting library.
 */

/* SITE is a raw GP field (AFETR); the artifact carries no name because none is
 * stored anywhere (AGENTS.md; satcat.LAUNCH could seed a map at ingest, but
 * that is a backend change, not this page's). Ship only the handful of pads
 * whose English names are the standard one; an unmapped code stays bare rather
 * than guessing, because a wrong name is worse than a code. */
const SITE_NAMES = {
    'AFETR': 'Cape Canaveral',
    'AFWTR': 'Vandenberg',
    'KSCAJ': 'Cape Kennedy',
    'TTMTR': 'Baikonur',
    'PKMTR': 'Plesetsk',
};

/* A site code that maps gets its name shown first so the rank reads as places
 * rather than noise; the code stays as the authority on hover. */
function siteLabel(code) {
    const name = SITE_NAMES[(code || '').toUpperCase()];
    return name ? `${name} [${code}]` : String(code);
}

async function loadAnalytics() {
    try {
        renderAnalytics(await API.analytics());
    } catch (err) {
        console.warn('[analytics] failed:', err);
        setText('an-decade-hint', 'analytics unavailable');
    }
}

/* A fallback-shaped artifact (artifactOrDb returning stub arrays with
 * `stale: true`) must say so instead of scanning as part of the data. */
function staleNote(data) {
    const el = $('an-stale-note');
    if (!el) return;
    if (data && data.stale) {
        el.hidden = false;
        setText('an-stale-note', data.note || 'artifact not built — partial counts');
    } else {
        el.hidden = true;
    }
}

function renderAnalytics(data) {
    if (!data) return;

    staleNote(data);

    renderBars('an-decade-bars', 'an-decade-hint',
        data.launches_by_decade, (r) => String(r.decade) + 's', (r) => r.n);
    renderBars('an-site-bars', 'an-site-hint',
        data.top_launch_sites, (r) => siteLabel(r.site), (r) => r.n);
    renderBars('an-family-bars', 'an-family-hint',
        data.debris_families, (r) => r.family, (r) => r.n);

    const matrix = data.country_by_decade;
    const wrap = $('an-country-matrix');
    const hint = $('an-country-hint');
    if (!wrap) return;
    if (!matrix || !matrix.decades || !matrix.decades.length ||
        !matrix.countries || !matrix.countries.length) {
        wrap.textContent = '';
        if (hint) hint.textContent = 'no data';
        return;
    }
    if (hint) hint.textContent = '';

    renderMatrix(wrap, matrix);
}

/* Country × decade as a heatmap: each cell's background opacity is scaled to
 * how much that country's strongest decade diverges from the global max, so a
 * glance finds the era that dominates a state. A `0` stays legible as a bare
 * dash — dark ink would read as a small number. */
function renderMatrix(wrap, matrix) {
    wrap.textContent = '';
    const max = Math.max(1, ...matrix.countries.flatMap((c) => c.by_decade || []));

    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    const empty = document.createElement('th');
    empty.textContent = 'STATE \\ ERA';
    headRow.appendChild(empty);
    for (const d of matrix.decades) {
        const th = document.createElement('th');
        th.textContent = String(d).slice(2);
        headRow.appendChild(th);
    }
    const headTot = document.createElement('th');
    headTot.textContent = 'TOT';
    headTot.className = 'st-matrix__total';
    headRow.appendChild(headTot);
    thead.appendChild(headRow);

    const tbody = document.createElement('tbody');
    const totals = new Array(matrix.decades.length).fill(0);
    for (const c of matrix.countries) {
        const tr = document.createElement('tr');
        const tdLabel = document.createElement('td');
        tdLabel.className = 'st-matrix__country';
        tdLabel.textContent = c.country;
        tr.appendChild(tdLabel);
        let rowTotal = 0;
        c.by_decade.forEach((n, i) => {
            const v = n || 0;
            totals[i] += v;
            rowTotal += v;
            const td = document.createElement('td');
            td.textContent = v > 0 ? num(v) : '—';
            if (v > 0) {
                const heat = (v / max).toFixed(3);
                td.className = 'st-matrix__cell';
                td.style.setProperty('--heat', heat);
                td.title = `${matrix.decades[i]} · ${c.country}: ${num(v)} launches`;
            } else {
                td.className = 'st-matrix__zero';
            }
            tr.appendChild(td);
        });
        const tdRow = document.createElement('td');
        tdRow.className = 'st-matrix__total';
        tdRow.textContent = num(rowTotal);
        tr.appendChild(tdRow);
        tbody.appendChild(tr);
    }

    const tfoot = document.createElement('tfoot');
    const footRow = document.createElement('tr');
    const footLabel = document.createElement('td');
    footLabel.textContent = 'ALL';
    footRow.appendChild(footLabel);
    let grand = 0;
    for (const t of totals) {
        grand += t;
        const td = document.createElement('td');
        td.className = 'st-matrix__total';
        td.textContent = num(t);
        footRow.appendChild(td);
    }
    const footGrand = document.createElement('td');
    footGrand.className = 'st-matrix__total st-matrix__grand';
    footGrand.textContent = num(grand);
    footRow.appendChild(footGrand);
    tfoot.appendChild(footRow);

    table.appendChild(thead);
    table.appendChild(tbody);
    table.appendChild(tfoot);
    wrap.appendChild(table);
}

function renderBars(containerId, hintId, items, labelFn, valueFn) {
    const wrap = $(containerId);
    const hint = $(hintId);
    if (!wrap) return;
    wrap.textContent = '';

    if (!items || !items.length) {
        if (hint) hint.textContent = 'no data';
        return;
    }
    if (hint) hint.textContent = '';

    const max = Math.max(...items.map(valueFn));
    if (!max) { if (hint) hint.textContent = 'no data'; return; }

    for (const item of items) {
        const v = valueFn(item);
        const pct = (v / max) * 100;

        const bar = document.createElement('div');
        bar.className = 'st-bar';

        const label = document.createElement('span');
        label.className = 'st-bar__label';
        label.textContent = labelFn(item);
        label.title = labelFn(item);

        const track = document.createElement('div');
        track.className = 'st-bar__track';
        const fill = document.createElement('div');
        fill.className = 'st-bar__fill';
        fill.style.width = `${pct}%`;
        fill.title = `${num(v)}`;
        track.appendChild(fill);

        const val = document.createElement('span');
        val.className = 'st-bar__value';
        val.textContent = num(v);

        bar.append(label, track, val);
        wrap.appendChild(bar);
    }
}

loadAnalytics();

/* Refetch every 30 min to catch the daily ingest */
setInterval(loadAnalytics, 30 * 60 * 1000);

/* ── Debug handle ──────────────────────────────────────────────────────────── */
exposeDebug('analytics', {
    loadAnalytics,
    renderAnalytics,
    renderMatrix,
});