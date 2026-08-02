import { $, setText, num, relTime } from '../shared/utils.js';
import { exposeDebug } from '../shared/debug.js';
import { API } from '../shared/api.js';
import { initHamburgerMenu } from '/shared/hud.js';
import { colorForCountry } from '/theme/palette.js';

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
        setText('brief-hint', 'no brief available');
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
        console.warn('[brief] decay-watch failed:', err);
        if (hint) hint.textContent = 'decay watch unavailable';
    }
}

/* ── Boxscore: country breakdown ──────────────────────────────────────────── */
async function loadBoxscore() {
    const bars = $('boxscore-bars');
    const hint = $('boxscore-hint');
    try {
        const b = await API.boxscore();
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
