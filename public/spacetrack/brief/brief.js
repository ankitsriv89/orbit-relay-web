import { $, setText, num, relTime } from '../shared/utils.js';
import { exposeDebug } from '../shared/debug.js';
import { API } from '../shared/api.js';
import { initHamburgerMenu } from '/shared/hud.js';
import { colorForBoxCode } from '/theme/palette.js';
import { boxSegments } from '/shared/charts.js';

initHamburgerMenu();

/* ── Brief ────────────────────────────────────────────────────────────────────
 * A once-a-day artifact, read flat. Nothing here calls a model — the card was
 * written during the ingest, checked there, and is served as a file.
 *
 * The facts render whether or not a narrative came with them. That ordering is
 * the feature: with generation switched off the panel is a digest of numbers
 * that are all still true.
 */

function renderBrief(card) {
    const section = $('brief-card');
    if (!section) return;

    if (!card || card.available === false || !card.facts) {
        setText('brief-hint', (card && card.note) ? card.note : 'no brief available');
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
    const badge = $('brief-badge');
    const divider = $('brief-narrative-divider');
    if (el) { el.textContent = narrative; el.hidden = !narrative; }
    if (badge) badge.hidden = !narrative;
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

function briefHint(card) {
    const when = card.generated_at ? relTime(card.generated_at) : 'unknown';
    const status = card.narrative_status || '';
    if (card.narrative) return `built ${when}`;
    if (status.startsWith('rejected')) return `built ${when} · narrative withheld — failed its fact-check`;
    if (status.startsWith('error')) return `built ${when} · narrative unavailable`;
    if (status.startsWith('skipped')) return `built ${when} · a quiet day`;
    return `built ${when}`;
}

async function loadBrief() {
    try {
        renderBrief(await API.brief());
    } catch (err) {
        console.warn('[brief] failed:', err);
        setText('brief-hint', 'brief unavailable');
    }
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
loadFeed();
loadDecayWatch();
loadBoxscore();

/* Refetch every 30 min to catch the daily ingest */
setInterval(loadBrief, 30 * 60 * 1000);
setInterval(loadFeed, 5 * 60 * 1000);
setInterval(loadDecayWatch, 5 * 60 * 1000);
setInterval(loadBoxscore, 10 * 60 * 1000);

/* ── Debug handle ──────────────────────────────────────────────────────────── */
exposeDebug('brief', {
    loadBrief,
    renderBrief,
    loadFeed,
    loadDecayWatch,
    loadBoxscore,
});
