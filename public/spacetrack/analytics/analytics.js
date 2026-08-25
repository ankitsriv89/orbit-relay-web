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
 * type/RCS, and launch history. Rendered with public/shared/charts.js's
 * SVG/CSS primitives — no charting library (repo rule).
 *
 * The launches-by-decade / top-sites / debris-family bar cards and the
 * country-by-decade matrix were removed 2026-08-26: static historical
 * reference facts, freely available elsewhere, crowding out the live data.
 * `/api/analytics` still carries those fields.
 *
 * Historical vs on-orbit-now (plan 38's easiest way to say something false):
 * growth's "cumulative catalog entries" series counts everything ever
 * catalogued, decayed included — a 1980s total doesn't shrink when one of
 * them reenters. The KPI strip, cohort survival, type/RCS and the orbit
 * distributions are on-orbit-now questions and the artifact already filters
 * them server-side (buildAnalytics, plan 38 task 3). This page never draws a
 * historical on-orbit curve — growth's two series are labelled "cumulative
 * catalog entries" and "still on orbit today", never merged into one line.
 */

async function loadAnalytics() {
    try {
        renderAnalytics(await API.analytics());
    } catch (err) {
        console.warn('[analytics] failed:', err);
        // Was 'an-decade-hint' — a hint that belonged to a card removed on
        // 2026-08-26, so a failed load wrote to nothing and the page sat on
        // "loading…" forever. The KPI strip is the first card and is never
        // removed, so its hint is where a total failure has to surface.
        setText('an-kpi-hint', 'analytics unavailable');
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

    // The decade / launch-site / debris-family bar cards and the country x
    // decade matrix were removed 2026-08-26 (see index.html). The payload
    // still carries those fields; this page just no longer renders them.
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
    // `h` sets the viewBox, not the rendered height — the SVG is scaled by
    // CSS to its container's width, so the viewBox only fixes the ASPECT
    // RATIO and the units the axis text is drawn in. Two consequences, both
    // learned by measuring rather than guessing:
    //
    //  - The card is full-width, so at the 480x220 default the chart rendered
    //    ~490px tall on desktop and towered over its neighbours. The rendered
    //    height is now capped by `.st-chart--line` in spacetrack.css.
    //  - Widening the viewBox to 960 to suit the wide card then made the
    //    labels illegible: the same 10px type scaled down by a 960->1330
    //    box squeezed into 220px of height. Font size is in viewBox units, so
    //    a wider box means smaller text for a fixed rendered height.
    //
    // 1200x240 (5:1) is chosen to MATCH the card rather than fight it: the
    // card is ~1330px wide on a 1400px desktop and `.st-chart--line` caps the
    // height at 240px, so a 5:1 box meet-fits almost exactly and leaves
    // negligible letterboxing. Keeping the viewBox large also keeps the type
    // proportionate — font sizes are in viewBox units, so a small box scaled
    // up to a wide card is what made the labels look oversized, and an
    // over-wide one shrank them to illegibility.
    ], { xLabel: 'year', yLabel: 'objects', w: 1200, h: 240 });
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

/* ── Launch history ──────────────────────────────────────────────────────────── */
function renderLaunches(launches) {
    const container = $('launches-card');
    const hint = $('an-launches-hint');
    const tableBody = $('an-launches-table-body');
    if (!container) return;

    if (!launches || !launches.length) {
        if (hint) hint.textContent = 'no launches in artifact yet';
        if (tableBody) tableBody.replaceChildren();
        return;
    }
    if (hint) hint.textContent = '';

    if (!tableBody) return;

    tableBody.replaceChildren();
    for (const launch of launches) {
        const row = document.createElement('tr');
        const dateTd = document.createElement('td');
        dateTd.textContent = launch.launch_date ? String(launch.launch_date).slice(0, 10) : '—';
        const siteTd = document.createElement('td');
        siteTd.textContent = launch.site || '—';
        const nTd = document.createElement('td');
        nTd.textContent = num(launch.n || 0);
        row.append(dateTd, siteTd, nTd, breakdownCell(launch));
        tableBody.appendChild(row);
    }
}

/* The TYPE BREAKDOWN cell.
 *
 * derive.js writes `typeBreakdown` — an OBJECT of per-type counts, e.g.
 * { PAYLOAD: 1, 'ROCKET BODY': 0, DEBRIS: 0 }. This used to read
 * `launch.type`, a scalar that has never existed on that shape, so every row
 * rendered an em-dash while the API returned perfectly good data.
 *
 * The counts do NOT necessarily sum to `n`: computeLaunchEntry only tallies
 * the three known OBJECT_TYPE values, and Space-Track also carries UNKNOWN
 * and (for very recent launches) rows not yet typed at all. A launch of 7
 * objects can therefore legitimately show 0/0/0. Rather than print a
 * breakdown that silently contradicts the OBJECTS column, the remainder is
 * shown explicitly as "untyped" — the honest reading of a fresh catalog
 * entry, and the same discipline the rest of the page follows about not
 * letting a partial count scan as a complete one. */
function breakdownCell(launch) {
    const td = document.createElement('td');
    const b = launch.typeBreakdown || {};
    const parts = [];
    for (const [key, label] of [['PAYLOAD', 'payload'], ['ROCKET BODY', 'rocket body'], ['DEBRIS', 'debris']]) {
        const v = Number(b[key]) || 0;
        if (v > 0) parts.push(`${num(v)} ${label}`);
    }
    const typed = Object.keys(b).reduce((sum, k) => sum + (Number(b[k]) || 0), 0);
    const untyped = Math.max(0, (Number(launch.n) || 0) - typed);
    if (untyped > 0) parts.push(`${num(untyped)} untyped`);

    td.textContent = parts.length ? parts.join(' · ') : '—';
    return td;
}

loadAnalytics();

/* Refetch every 30 min to catch the daily ingest. This covers the launch
 * table too — it rides the same payload.
 *
 * There was a second 24h interval here that called
 * `renderLaunches(data?.launches)`, where `data` is not defined in this
 * scope. It threw a ReferenceError on every fire into an empty `catch (_)`,
 * so it never rendered anything and never reported that it hadn't. Removed
 * rather than repaired: the 30-minute refetch above already re-renders the
 * table from fresh data, so a 24-hour re-render of a stale closure was
 * redundant even in the version where it worked. */
setInterval(loadAnalytics, 30 * 60 * 1000);

/* ── Debug handle ──────────────────────────────────────────────────────────── */
exposeDebug('analytics', {
    loadAnalytics,
    renderAnalytics,
    renderLaunches,
});
