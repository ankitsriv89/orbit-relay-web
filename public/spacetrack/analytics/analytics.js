import { $, setText, num } from '../shared/utils.js';
import { exposeDebug } from '../shared/debug.js';
import { API, showFooterFreshness } from '../shared/api.js';
import { initMobileListener, initHamburgerMenu } from '/shared/hud.js';
import { bars, stackedBars, svgLine, svgHistogram, cumulative } from '/shared/charts.js';

initMobileListener();
/* This page ships the same #hamburger-btn + .mobile-menu markup as its four
   siblings but was the only one that never wired it — harmless while the CSS
   hid the button, a dead control once the dropdown became the home for
   cross-app links. */
initHamburgerMenu();
showFooterFreshness();

/* ── Analytics ────────────────────────────────────────────────────────────────
 * Catalog dashboard: KPI strip, growth, cohort survival, orbit distributions,
 * type/RCS, launches by decade/site/family, and the country-by-decade matrix.
 * Rendered with public/shared/charts.js's SVG/CSS primitives — no charting
 * library (repo rule).
 *
 * Historical vs on-orbit-now (plan 38's easiest way to say something false):
 * the launch/site/family/country sections count everything ever catalogued,
 * decayed included — "how many launched in the 1980s" doesn't shrink when one
 * of them reenters. The KPI strip, cohort survival, type/RCS and the orbit
 * distributions are on-orbit-now questions and the artifact already filters
 * them server-side (buildAnalytics, plan 38 task 3). This page never draws a
 * historical on-orbit curve — growth's two series are labelled "cumulative
 * catalog entries" and "still on orbit today", never merged into one line.
 */

/* A site code that maps gets its name shown first so the rank reads as places
 * rather than noise; the code stays as the authority on hover. The artifact
 * now carries the name directly (plan 38 task 2's launch_sites join) — an
 * unmapped code stays bare rather than guessing, because a wrong name is
 * worse than a code (same rule the old hardcoded SITE_NAMES map followed). */
function siteLabel(row) {
    return row.name ? `${row.name} [${row.site}]` : String(row.site);
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

/* A section whose artifact key is entirely missing (the reduced-form D1
 * fallback ships empty arrays/objects for sections it doesn't compute) must
 * say so in its own hint rather than rendering an empty chart that reads as
 * "zero of everything" — CLAUDE.md's degraded-mode rule, extended per
 * section rather than only at the page level. */
function sectionMissing(hintId, empty) {
    if (!empty) return false;
    const hint = $(hintId);
    if (hint) hint.textContent = 'not in this artifact yet';
    return true;
}

function renderAnalytics(data) {
    if (!data) return;

    staleNote(data);

    renderKPIs(data);
    renderGrowth(data);
    renderCohort(data);
    renderTypeAndRCS(data);
    renderHistograms(data);

    renderBars('an-decade-bars', 'an-decade-hint',
        data.launches_by_decade, (r) => String(r.decade) + 's', (r) => r.n);
    renderBars('an-site-bars', 'an-site-hint',
        data.top_launch_sites, siteLabel, (r) => r.n);
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

    // New: render launch history table
    renderLaunches(data.launches);
}

/* ── KPI strip ────────────────────────────────────────────────────────────── */

function renderKPIs(data) {
    const strip = $('an-kpi-strip');
    const hint = $('an-kpi-hint');
    if (!strip) return;
    strip.textContent = '';

    if (sectionMissing('an-kpi-hint', data.tracked == null)) return;
    if (hint) hint.textContent = '';

    const byType = data.by_type || {};
    const byRegime = data.by_regime || {};
    const tiles = [
        ['TRACKED', num(data.tracked)],
        ['PAYLOADS', num(byType.PAYLOAD)],
        ['DEBRIS', num(byType.DEBRIS)],
        ['ROCKET BODIES', num(byType['ROCKET BODY'])],
        ['LEO', num(byRegime.LEO)],
        ['MEO', num(byRegime.MEO)],
        ['GEO', num(byRegime.GEO)],
        ['HEO', num(byRegime.HEO)],
    ];
    for (const [label, value] of tiles) {
        const tile = document.createElement('div');
        tile.className = 'st-kpi';
        const v = document.createElement('span');
        v.className = 'st-kpi__value';
        v.textContent = value;
        const l = document.createElement('span');
        l.className = 'st-kpi__label';
        l.textContent = label;
        tile.append(v, l);
        strip.appendChild(tile);
    }
}

/* ── Growth ───────────────────────────────────────────────────────────────── */
/* Two clearly distinct series, never merged: "cumulative catalog entries"
 * (from launches_by_year, whole catalog — a historical count) and "still on
 * orbit today" is approximated from the same cumulative launch series minus
 * a cumulative decay series, since we hold no true historical on-orbit
 * snapshot. Axis labels carry the distinction per the plan's Risks table. */
function renderGrowth(data) {
    const container = $('an-growth-chart');
    const hint = $('an-growth-hint');
    if (!container) return;

    const byYear = data.launches_by_year;
    if (sectionMissing('an-growth-hint', !byYear || !byYear.length)) {
        container.textContent = '';
        return;
    }
    if (hint) hint.textContent = '';

    const launchedCum = cumulative(byYear, 'n');
    const decaysByMonth = data.decays_by_month || [];
    const decaysByYear = new Map();
    for (const d of decaysByMonth) {
        const year = Number(String(d.month).slice(0, 4));
        if (!Number.isFinite(year)) continue;
        decaysByYear.set(year, (decaysByYear.get(year) || 0) + d.n);
    }
    let decayRunning = 0;
    const onOrbitSeries = launchedCum.map((r) => {
        decayRunning += decaysByYear.get(r.year) || 0;
        return { x: r.year, y: Math.max(0, r.cumulative - decayRunning) };
    });

    svgLine(container, [
        { label: 'cumulative catalog entries', color: 'rgba(0, 210, 255, 0.85)',
          points: launchedCum.map((r) => ({ x: r.year, y: r.cumulative })) },
        { label: 'still on orbit today (approx)', color: 'rgba(255, 180, 0, 0.85)',
          points: onOrbitSeries },
    ], { xLabel: 'year', yLabel: 'objects' });
}

/* ── Cohort survival ──────────────────────────────────────────────────────── */

function renderCohort(data) {
    const container = $('an-cohort-bars');
    const hint = $('an-cohort-hint');
    if (!container) return;

    const rows = data.cohort_on_orbit;
    if (sectionMissing('an-cohort-hint', !rows || !rows.length)) {
        container.textContent = '';
        return;
    }
    if (hint) hint.textContent = '';

    stackedBars(container, rows, {
        label: (r) => `${r.decade}s`,
        segments: [
            { value: (r) => r.still_on_orbit, label: 'still on orbit', color: () => 'rgba(0, 210, 255, 0.7)' },
            { value: (r) => Math.max(0, r.launched - r.still_on_orbit), label: 'decayed', color: () => 'rgba(150, 160, 170, 0.5)' },
        ],
    });
}

/* ── Type & RCS ───────────────────────────────────────────────────────────── */

function renderTypeAndRCS(data) {
    const typeContainer = $('an-type-bars');
    const rcsContainer = $('an-rcs-bars');
    const hint = $('an-type-hint');
    if (!typeContainer) return;

    const byType = data.by_type;
    const rcsSizes = data.rcs_sizes;
    if (sectionMissing('an-type-hint', !byType || !Object.keys(byType).length)) {
        typeContainer.textContent = '';
        if (rcsContainer) rcsContainer.textContent = '';
        return;
    }
    if (hint) hint.textContent = '';

    const typeRows = Object.entries(byType).map(([k, n]) => ({ label: k, n }));
    bars(typeContainer, typeRows, { label: (r) => r.label, value: (r) => r.n });

    if (rcsContainer) {
        const rcsRows = Object.entries(rcsSizes || {}).map(([k, n]) => ({ label: k, n }));
        bars(rcsContainer, rcsRows, { label: (r) => r.label, value: (r) => r.n });
    }
}

/* ── Orbit distribution histograms ────────────────────────────────────────── */

function renderHistograms(data) {
    const altContainer = $('an-altitude-chart');
    const altHint = $('an-altitude-hint');
    if (altContainer) {
        const bins = data.altitude_bins;
        if (sectionMissing('an-altitude-hint', !bins || !bins.length)) {
            altContainer.textContent = '';
        } else {
            if (altHint) altHint.textContent = '';
            svgHistogram(altContainer, bins, { unit: ' km' });
        }
    }

    const inclContainer = $('an-inclination-chart');
    const inclHint = $('an-inclination-hint');
    if (inclContainer) {
        const bins = data.inclination_bins;
        if (sectionMissing('an-inclination-hint', !bins || !bins.length)) {
            inclContainer.textContent = '';
        } else {
            if (inclHint) inclHint.textContent = '';
            svgHistogram(inclContainer, bins, { unit: '°' });
        }
    }
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

    if (sectionMissing(hintId, !items || !items.length)) {
        wrap.textContent = '';
        return;
    }
    if (hint) hint.textContent = '';

    bars(wrap, items, { label: labelFn, value: valueFn });
}

/* ── Launch history ──────────────────────────────────────────────────────────── */
function renderLaunches(launches) {
    const container = $('launches-card');
    const hint = $('an-launches-hint');
    const tableBody = $('an-launches-table-body');
    if (!container) return;

    if (!launches || !launches.length) {
        if (hint) hint.textContent = 'no launches in artifact yet';
        if (tableBody) tableBody.innerHTML = '';
        return;
    }
    if (hint) hint.textContent = '';

    if (!tableBody) return;

    tableBody.innerHTML = '';
    for (const launch of launches) {
        const row = document.createElement('tr');
        const dateTd = document.createElement('td');
        dateTd.textContent = launch.launch_date ? String(launch.launch_date).slice(0, 10) : '—';
        const siteTd = document.createElement('td');
        siteTd.textContent = launch.site || '—';
        const nTd = document.createElement('td');
        nTd.textContent = launch.n || '0';
        const typeTd = document.createElement('td');
        // Show primary type
        const typeMap = { PAYLOAD: 'payload', 'ROCKET BODY': 'rocket body', DEBRIS: 'debris' };
        typeTd.textContent = typeMap[launch.type] || (launch.type || '—');
        row.append(dateTd, siteTd, nTd, typeTd);
        tableBody.appendChild(row);
    }
}

loadAnalytics();

/* Refetch every 30 min to catch the daily ingest */
setInterval(loadAnalytics, 30 * 60 * 1000);

/* Refetch launches every 24 hrs to catch the daily build */
setInterval(() => {
    try {
        renderLaunches(data?.launches);
    } catch (_) {}
}, 86400000);

/* ── Debug handle ──────────────────────────────────────────────────────────── */
exposeDebug('analytics', {
    loadAnalytics,
    renderAnalytics,
    renderMatrix,
});
