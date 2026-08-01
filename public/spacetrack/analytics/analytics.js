import { $, setText, num } from '../shared/utils.js';
import { exposeDebug } from '../shared/debug.js';
import { API } from '../shared/api.js';
import { wireHudToggle, initMobileListener } from '/shared/hud.js';

/* ── HUD toggle ──────────────────────────────────────────────────────────── */
wireHudToggle('catalog-hud', 'catalog-hud-toggle', 'catalog-hud-body');

initMobileListener();

/* ── Analytics ────────────────────────────────────────────────────────────────
 * Launch-history dashboard: launches by decade, top launch sites, debris
 * families and a country-by-decade matrix. Rendered with CSS bars and a simple
 * table — no charting library.
 */

async function loadAnalytics() {
    try {
        renderAnalytics(await API.analytics());
    } catch (err) {
        console.warn('[analytics] failed:', err);
        setText('an-decade-hint', 'analytics unavailable');
    }
}

function renderAnalytics(data) {
    if (!data) return;

    renderBars('an-decade-bars', 'an-decade-hint',
        data.launches_by_decade, (r) => r.decade, (r) => r.n);
    renderBars('an-site-bars', 'an-site-hint',
        data.top_launch_sites, (r) => r.site, (r) => r.n);
    renderBars('an-family-bars', 'an-family-hint',
        data.debris_families, (r) => r.family, (r) => r.n);

    const matrix = data.country_by_decade;
    const wrap = $('an-country-matrix');
    const hint = $('an-country-hint');
    if (!wrap || !matrix || !matrix.decades || !matrix.countries) {
        if (hint) hint.textContent = !matrix ? 'no data' : '';
        return;
    }
    if (hint) hint.textContent = '';

    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    const empty = document.createElement('th');
    headRow.appendChild(empty);
    for (const d of matrix.decades) {
        const th = document.createElement('th');
        th.textContent = String(d).slice(2);
        headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const c of matrix.countries) {
        const tr = document.createElement('tr');
        const tdLabel = document.createElement('td');
        tdLabel.textContent = c.country;
        tr.appendChild(tdLabel);
        for (const n of c.by_decade) {
            const td = document.createElement('td');
            td.textContent = n || '—';
            tr.appendChild(td);
        }
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.textContent = '';
    wrap.appendChild(table);

    expandPanel();
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

        const track = document.createElement('div');
        track.className = 'st-bar__track';
        const fill = document.createElement('div');
        fill.className = 'st-bar__fill';
        fill.style.width = `${pct}%`;
        track.appendChild(fill);

        const val = document.createElement('span');
        val.className = 'st-bar__value';
        val.textContent = num(v);

        bar.append(label, track, val);
        wrap.appendChild(bar);
    }
}

function expandPanel() {
    const hud = $('catalog-hud');
    const body = $('catalog-hud-body');
    const toggle = $('catalog-hud-toggle');
    if (!hud || !body) return;
    hud.classList.remove('key-hud--collapsed');
    body.hidden = false;
    if (toggle) toggle.setAttribute('aria-expanded', 'true');
}

loadAnalytics();

/* Refetch every 30 min to catch the daily ingest */
setInterval(loadAnalytics, 30 * 60 * 1000);

/* ── Debug handle ──────────────────────────────────────────────────────────── */
exposeDebug('analytics', {
    loadAnalytics,
    renderAnalytics,
});
