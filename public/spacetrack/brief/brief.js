import { $, setText, num, relTime } from '../shared/utils.js';
import { exposeDebug } from '../shared/debug.js';
import { API } from '../shared/api.js';
import { initHamburgerMenu } from '/shared/hud.js';
import { colorForBoxCode } from '/theme/palette.js';
import { boxSegments, svgLine } from '/shared/charts.js';

initHamburgerMenu();

/* ── Brief ────────────────────────────────────────────────────────────────────
 * A once-a-day artifact, read flat. Nothing here calls a model — the card was
 * written during the ingest, checked there, and is served as a file.
 *
 * The facts render whether or not a narrative came with them. That ordering is
 * the feature: with generation switched off the panel is a digest of numbers
 * that are all still true.
 *
 * The page also carries an 90-day archive (plan 38 task 5/6): a sparkline +
 * day selector drives which card is on screen, defaulting to today. Selecting
 * an older day re-fetches that day's card via `?date=` — the same flat R2
 * read `/api/brief` already serves for `latest.json`, there is no separate
 * "archive" endpoint or synthesis on read (CLAUDE.md: brief.js has no D1
 * fallback, deliberately, and that invariant extends to any archived day).
 */

let selectedDate = null; // null = today / latest.json

function renderBrief(card, dateLabel) {
    const section = $('brief-card');
    if (!section) return;

    setText('brief-date', dateLabel ? `— ${dateLabel}` : '');

    if (!card || card.available === false || !card.facts) {
        setText('brief-hint', (card && card.note) ? card.note : 'no brief available');
        setText('brief-new', '—');
        setText('brief-decayed', '—');
        setText('brief-reentry', '—');
        setText('brief-tracked', '—');
        setText('brief-payloads', '—');
        setText('brief-debris', '—');
        const el = $('brief-narrative');
        if (el) el.hidden = true;
        const badge = $('brief-badge');
        if (badge) badge.hidden = true;
        const divider = $('brief-narrative-divider');
        if (divider) divider.hidden = true;
        const list = $('brief-highlights');
        if (list) list.textContent = '';
        return;
    }

    const f = card.facts;
    setText('brief-new', num(f.new_objects));
    setText('brief-decayed', num(f.decays));
    setText('brief-reentry', num((f.reentry_watch || []).length));
    setText('brief-tracked', num(f.tracked_on_orbit));
    setText('brief-payloads', num(f.payloads));
    setText('brief-debris', num(f.debris));

    const narrative = typeof card.narrative === 'string' ? card.narrative.trim() : '';
    const el = $('brief-narrative');
    const divider = $('brief-narrative-divider');
    if (el) { el.textContent = narrative; el.hidden = !narrative; }
    renderBadge(card, narrative);
    if (divider) divider.hidden = !narrative;

    const list = $('brief-highlights');
    if (list) {
        list.textContent = '';
        for (const w of (f.reentry_watch || []).slice(0, 3)) {
            const li = document.createElement('li');
            li.className = 'st-feed__item';
            const title = document.createElement('span');
            title.className = 'st-feed__title';
            title.textContent = w.name;
            const meta = document.createElement('span');
            meta.className = 'st-feed__meta st-feed__meta--soon';
            meta.textContent = `reentry ~${w.days_until}d · ${w.country || '—'}`;
            li.append(title, meta);
            list.appendChild(li);
        }
    }

    setText('brief-hint', briefHint(card));
}

/* The `.st-machine` badge asserts fact-checked AI provenance — a manual edit
 * (plan 38 task 8's `/api/admin/brief`) must never pass under that claim, so
 * `narrative_source: 'manual'` swaps both the label and the box's styling
 * rather than reusing the AI copy with different words. */
function renderBadge(card, narrative) {
    const badge = $('brief-badge');
    if (!badge) return;
    badge.hidden = !narrative;
    if (!narrative) return;

    const label = $('brief-badge-label');
    const text = $('brief-badge-text');
    if (card.narrative_source === 'manual') {
        badge.classList.add('st-machine--manual');
        if (label) label.textContent = '✎ EDITED';
        if (text) text.textContent = 'written by a human editor, not generated from the figures above';
    } else {
        badge.classList.remove('st-machine--manual');
        if (label) label.textContent = '✦ AI NARRATIVE';
        if (text) text.textContent = 'generated from computed facts — reviewed by fact-check';
    }
}

function briefHint(card) {
    const when = card.generated_at ? relTime(card.generated_at) : 'unknown';
    const status = card.narrative_status || '';
    if (card.narrative) return `built ${when}`;
    if (status.startsWith('rejected')) return `built ${when} · narrative withheld — failed its fact-check`;
    if (status.startsWith('error')) return `built ${when} · narrative unavailable`;
    if (status.startsWith('skipped')) return `built ${when} · a quiet day`;
    return `built ${when}`;
}

async function loadBrief(date) {
    try {
        const card = await API.brief(date);
        renderBrief(card, date);
    } catch (err) {
        console.warn('[brief] failed:', err);
        setText('brief-hint', 'brief unavailable');
    }
}

/* ── Archive: sparkline + day selector ────────────────────────────────────── */

let archiveIndex = null;

async function loadArchive() {
    const hint = $('archive-hint');
    try {
        const idx = await API.briefIndex();
        archiveIndex = idx;
        const days = (idx.days || []).slice().reverse(); // oldest → newest for the chart
        if (!days.length) {
            if (hint) hint.textContent = idx.note || 'no archive yet';
            const spark = $('archive-sparkline');
            if (spark) spark.textContent = '';
            renderSelector([]);
            return;
        }
        if (hint) hint.textContent = `${idx.total} day${idx.total === 1 ? '' : 's'} on file`;

        const spark = $('archive-sparkline');
        if (spark) {
            svgLine(spark, [
                { label: 'new catalog entries', color: 'rgba(0, 210, 255, 0.85)',
                  points: days.map((d, i) => ({ x: i, y: d.new_objects || 0 })) },
                { label: 'decays', color: 'rgba(255, 120, 120, 0.85)',
                  points: days.map((d, i) => ({ x: i, y: d.decays || 0 })) },
            ], { xLabel: 'day (oldest → newest)', yLabel: 'events' });
        }

        renderSelector(days);
    } catch (err) {
        console.warn('[brief] archive failed:', err);
        if (hint) hint.textContent = 'archive unavailable';
    }
}

function renderSelector(days) {
    const wrap = $('archive-selector');
    if (!wrap) return;
    wrap.textContent = '';

    // Newest first for the button row — the sparkline reads oldest→newest as
    // a timeline, but a picker is scanned top-down from "most recent".
    for (const d of days.slice().reverse()) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'st-archive__day';
        if (d.date === selectedDate) btn.classList.add('st-archive__day--active');
        if (!selectedDate && d.date === days[days.length - 1]?.date) btn.classList.add('st-archive__day--active');
        btn.setAttribute('role', 'option');
        btn.setAttribute('aria-selected', String(d.date === selectedDate));

        const dateEl = document.createElement('span');
        dateEl.textContent = d.date.slice(5); // MM-DD, year is implied by context
        const countEl = document.createElement('span');
        countEl.className = 'st-archive__day-count';
        countEl.textContent = `+${num(d.new_objects || 0)}`;

        btn.append(dateEl, countEl);
        btn.title = d.headline || `${d.date}: +${d.new_objects || 0} new, ${d.decays || 0} decayed`;
        btn.addEventListener('click', () => selectDay(d.date));
        wrap.appendChild(btn);
    }
}

function selectDay(date) {
    selectedDate = date;
    loadBrief(date);
    if (archiveIndex) renderSelector(archiveIndex.days.slice().reverse());
}

/* ── Activity: signal feed / reentry watch ───────────────────────────────────
 * Moved here from the Catalog globe page — this is read-only informational
 * data with no interaction with the 3D view, so it belongs on the
 * informational pages (Brief/Analytics), not floating over the globe.
 */
// Space-Track has no "what changed" feed; every kind below was derived by the
// ingest diffing a run against the previous one. Render the raw key with a
// human word and a semantic class so a scan picks up the shape of the day.
const EVENT_KIND = {
    new_object:       { label: 'NEW CATALOG ENTRY', c: 'kind-new' },
    decay:            { label: 'DECAYED', c: 'kind-decay' },
    reentry_predicted: { label: 'REENTRY PREDICTED', c: 'kind-predicted' },
    satcat_change:    { label: 'CATALOG CHANGE', c: 'kind-change' },
};
const kindOf = (kind) => EVENT_KIND[kind] || { label: kind.toUpperCase(), c: 'kind-other' };

async function loadFeed() {
    const list = $('feed-list');
    const hint = $('feed-hint');
    try {
        const f = await API.feed(30);
        const events = f.events || [];
        renderNews(events);
        if (!list) return;
        list.textContent = '';
        if (!events.length) {
            if (hint) hint.textContent = 'no events yet';
            return;
        }
        if (hint) hint.textContent = '';
        for (const e of events) {
            const li = document.createElement('li');
            const { label, c } = kindOf(e.kind);
            li.className = `st-feed__item ${c}`;
            const tag = document.createElement('span');
            tag.className = 'st-feed__tag';
            tag.textContent = label;
            const title = document.createElement('span');
            title.className = 'st-feed__title';
            title.textContent = e.title || `${e.kind}`;
            const meta = document.createElement('span');
            meta.className = 'st-feed__meta';
            meta.textContent = relTime(e.ts);
            li.append(tag, title, meta);
            list.appendChild(li);
        }
    } catch (err) {
        console.warn('[brief] feed failed:', err);
        if (hint) hint.textContent = 'feed unavailable';
        const newsHint = $('news-hint');
        if (newsHint) newsHint.textContent = 'unavailable';
    }
}

/* "Recent launches" proxy — `new_object` events whose OBJECT_TYPE is the
 * uppercase Space-Track literal `PAYLOAD` (the title-case version of this
 * check already bit the admin health panel once; see admin.test.mjs).
 * Labelled "catalog entries", never "launches" — a catalog entry can lag its
 * actual launch by days and this repo is not a launch-authoritative source. */
function renderNews(events) {
    const list = $('news-list');
    const hint = $('news-hint');
    if (!list) return;
    list.textContent = '';

    const entries = (events || []).filter(
        (e) => e.kind === 'new_object' && e.detail && e.detail.type === 'PAYLOAD');

    if (!entries.length) {
        if (hint) hint.textContent = 'no new catalog entries in the recent feed';
        return;
    }
    if (hint) hint.textContent = '';

    for (const e of entries) {
        const li = document.createElement('li');
        li.className = 'st-feed__item kind-new';
        const title = document.createElement('span');
        title.className = 'st-feed__title';
        title.textContent = e.title || 'Unnamed object entered the catalog';
        const meta = document.createElement('span');
        meta.className = 'st-feed__meta';
        const country = e.detail.country ? ` · ${e.detail.country}` : '';
        meta.textContent = `${relTime(e.ts)}${country}`;
        li.append(title, meta);
        list.appendChild(li);
    }
}

async function loadDecayWatch() {
    const list = $('decay-list');
    const hint = $('decay-hint');
    try {
        const d = await API.decayWatch(20);
        const watch = d.watch || [];
        if (!list) return;
        list.textContent = '';
        if (!watch.length) {
            if (hint) hint.textContent = 'no predicted reentries on file';
            return;
        }
        if (hint) hint.textContent = d.generated_at ? `built ${relTime(d.generated_at)}` : '';
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
        console.warn('[brief] decay-watch failed:', err);
        if (hint) hint.textContent = 'decay watch unavailable';
    }
}

/* ── Boxscore: country breakdown ──────────────────────────────────────────── */
// The boxscore table aggregates pseudo-countries too (`ALL` total line, `TBD`
// unknown). Neither is a country, and `ALL` would sit atop the ranking and make
// every real row's bar look small by comparison, so both are dropped.
const boxscoreRows = (countries) => (countries || []).filter(
    (c) => !['ALL', 'TBD'].includes((c.SPADOC_CD || '').toUpperCase()));

async function loadBoxscore() {
    const bars = $('boxscore-bars');
    const hint = $('boxscore-hint');
    try {
        const b = await API.boxscore();
        const countries = boxscoreRows(b?.countries).slice(0, 10);
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
            const { bar, orbitalPct, decayedPct } = boxSegments(c, maxTotal);
            track.style.width = `${bar}%`;
            if (orbitalPct < 100) {
                const orbital = document.createElement('div');
                orbital.className = 'st-boxscore__fill';
                orbital.style.width = `${orbitalPct}%`;
                orbital.style.background = colorForBoxCode(c.SPADOC_CD);
                orbital.title = `orbital ${num(c.ORBITAL_TOTAL_COUNT)}`;
                const decayed = document.createElement('div');
                decayed.className = 'st-boxscore__fill st-boxscore__fill--decayed';
                decayed.style.flex = '1 1 auto';
                decayed.title = `decayed ${num(c.DECAYED_TOTAL_COUNT)}`;
                track.append(orbital, decayed);
            } else {
                const fill = document.createElement('div');
                fill.className = 'st-boxscore__fill';
                fill.style.width = '100%';
                fill.style.background = colorForBoxCode(c.SPADOC_CD);
                track.appendChild(fill);
            }
            const count = document.createElement('span');
            count.className = 'st-boxscore__count';
            count.textContent = num(c.COUNTRY_TOTAL);
            count.title = `orbital ${num(c.ORBITAL_TOTAL_COUNT)} · decayed ${num(c.DECAYED_TOTAL_COUNT)}`;
            row.append(label, track, count);
            bars.appendChild(row);
        }
    } catch (err) {
        console.warn('[brief] boxscore failed:', err);
        if (hint) hint.textContent = 'boxscore unavailable';
    }
}

loadBrief();
loadArchive();
loadFeed();
loadDecayWatch();
loadBoxscore();

/* Refetch every 30 min to catch the daily ingest. Only re-polls `latest.json`
 * while today's card is showing — a visitor reading an archived day should
 * not have it swapped out from under them by a background timer. */
setInterval(() => { if (!selectedDate) loadBrief(); }, 30 * 60 * 1000);
setInterval(loadFeed, 5 * 60 * 1000);
setInterval(loadDecayWatch, 5 * 60 * 1000);
setInterval(loadBoxscore, 10 * 60 * 1000);

/* ── Debug handle ──────────────────────────────────────────────────────────── */
exposeDebug('brief', {
    loadBrief,
    renderBrief,
    loadArchive,
    loadFeed,
    loadDecayWatch,
    loadBoxscore,
    renderNews,
    selectDay,
});
