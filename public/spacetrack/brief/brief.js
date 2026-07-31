import { $, setText, num, relTime } from '../shared/utils.js';
import { getApiBase } from '../shared/api.js';
import { wireHudToggle, initHamburgerMenu } from '../shared/hud.js';

/* ── HUD toggle ──────────────────────────────────────────────────────────── */
wireHudToggle('catalog-hud', 'catalog-hud-toggle', 'catalog-hud-body');
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
    const section = $('catalog-hud');
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
    expandPanel();
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

function expandPanel() {
    const hud = $('catalog-hud');
    const body = $('catalog-hud-body');
    const toggle = $('catalog-hud-toggle');
    if (!hud || !body) return;
    hud.classList.remove('key-hud--collapsed');
    body.hidden = false;
    if (toggle) toggle.setAttribute('aria-expanded', 'true');
}

async function loadBrief() {
    try {
        const r = await fetch(`${getApiBase()}/brief`);
        if (!r.ok) throw new Error(`brief ${r.status}`);
        renderBrief(await r.json());
    } catch (err) {
        console.warn('[brief] failed:', err);
        setText('brief-hint', 'brief unavailable');
    }
}

loadBrief();

/* Refetch every 30 min to catch the daily ingest */
setInterval(loadBrief, 30 * 60 * 1000);

/* ── Debug handle ──────────────────────────────────────────────────────────── */
window.__spacetrack = {
    loadBrief,
    renderBrief,
    get source() { return 'brief'; },
};
