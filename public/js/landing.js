// Landing page: hero 3D backdrop + live catalog stat strip + ticker.

import { initHeroScene } from './hero-scene.js';

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ── Hero 2D starfield (fallback for reduced-motion-off but WebGL2-less browsers) ── */
function initStarfield() {
    const canvas = document.getElementById('hero-canvas');
    if (!canvas || reduceMotion) return;

    const ctx = canvas.getContext('2d');
    let width, height, dpr;
    let stars = [];

    function resize() {
        dpr = Math.min(window.devicePixelRatio || 1, 2);
        width = canvas.parentElement.offsetWidth;
        height = canvas.parentElement.offsetHeight;
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        canvas.style.width = width + 'px';
        canvas.style.height = height + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const count = Math.round((width * height) / 9000);
        stars = Array.from({ length: count }, () => ({
            x: Math.random() * width,
            y: Math.random() * height,
            r: Math.random() * 1.3 + 0.3,
            a: Math.random() * 0.6 + 0.2,
            tw: Math.random() * 0.015 + 0.003,
        }));
    }

    const arcs = [
        { cx: 0.15, cy: 1.1, r: 0.55 },
        { cx: 0.9, cy: -0.15, r: 0.42 },
    ];

    function draw() {
        ctx.clearRect(0, 0, width, height);

        ctx.strokeStyle = 'rgba(0, 210, 255, 0.12)';
        ctx.lineWidth = 1;
        for (const arc of arcs) {
            ctx.beginPath();
            ctx.arc(width * arc.cx, height * arc.cy, Math.max(width, height) * arc.r, 0, Math.PI * 2);
            ctx.stroke();
        }

        for (const s of stars) {
            s.a += s.tw;
            const flicker = 0.5 + 0.5 * Math.sin(s.a);
            ctx.beginPath();
            ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(232, 244, 250, ${0.15 + flicker * 0.5})`;
            ctx.fill();
        }

        requestAnimationFrame(draw);
    }

    resize();
    window.addEventListener('resize', resize, { passive: true });
    requestAnimationFrame(draw);
}

/* ── Live stat strip ───────────────────────────────────────────────────── */
function fmtCount(n) {
    if (typeof n !== 'number') return '—';
    return n.toLocaleString('en-US');
}

function fmtAge(iso) {
    if (!iso) return '—';
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const hrs = ms / 3_600_000;
    if (hrs < 1) return `${Math.round(ms / 60_000)}m ago`;
    if (hrs < 48) return `${Math.round(hrs)}h ago`;
    return `${Math.round(hrs / 24)}d ago`;
}

const STATIC_FALLBACK = {
    tracked: '28,000+',
    payloads: '11,000+',
    debris: '15,000+',
    updated: 'daily',
};

async function loadStats() {
    const noteEl = document.getElementById('stat-strip-note');
    let showNote = false;
    try {
        const res = await fetch('/api/summary');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!data.tracked) throw new Error('summary artifact not built yet (tracked=0)');

        const tracked = data.tracked;
        const payloads = data.by_type && data.by_type.PAYLOAD;
        const debris = data.by_type && data.by_type.DEBRIS;
        const updatedAt = data.last_elset_ingest || data.generated_at;

        document.getElementById('stat-tracked').textContent = fmtCount(tracked) !== '—' ? fmtCount(tracked) : STATIC_FALLBACK.tracked;
        document.getElementById('stat-payloads').textContent = fmtCount(payloads) !== '—' ? fmtCount(payloads) : STATIC_FALLBACK.payloads;
        document.getElementById('stat-debris').textContent = fmtCount(debris) !== '—' ? fmtCount(debris) : STATIC_FALLBACK.debris;
        document.getElementById('stat-updated').textContent = fmtAge(updatedAt) !== '—' ? fmtAge(updatedAt) : STATIC_FALLBACK.updated;

        showNote = Boolean(data.stale) || !payloads || !debris || !updatedAt;
    } catch (err) {
        console.warn('[landing] /api/summary unavailable, showing static copy:', err);
        document.getElementById('stat-tracked').textContent = STATIC_FALLBACK.tracked;
        document.getElementById('stat-payloads').textContent = STATIC_FALLBACK.payloads;
        document.getElementById('stat-debris').textContent = STATIC_FALLBACK.debris;
        document.getElementById('stat-updated').textContent = STATIC_FALLBACK.updated;
        showNote = true;
    }
    if (noteEl) noteEl.hidden = !showNote;
}

/* ── Live ticker ───────────────────────────────────────────────────────── */
// Each item is [prefix, strongText, suffix] — all rendered via textContent,
// never innerHTML, since strongText/prefix/suffix can carry API-derived
// strings (satellite names, brief narrative) that must not be parsed as markup.
function makeTickerItem(parts) {
    const item = document.createElement('span');
    item.className = 'ticker__item';
    for (const part of parts) {
        if (part.strong) {
            const strong = document.createElement('strong');
            strong.textContent = part.strong;
            item.appendChild(strong);
        } else {
            item.appendChild(document.createTextNode(part.text));
        }
    }
    const dot = document.createElement('span');
    dot.className = 'ticker__dot';
    dot.textContent = '◆';

    const frag = document.createDocumentFragment();
    frag.appendChild(item);
    frag.appendChild(dot);
    return frag;
}

const FEED_KIND_LABEL = {
    new_object: 'New catalog entry',
    reentry_predicted: 'Reentry predicted',
    satcat_change: 'Catalog update',
    decay: 'Decayed',
};

async function buildTickerItems() {
    const items = [];

    try {
        const res = await fetch('/api/summary');
        if (res.ok) {
            const data = await res.json();
            if (data.tracked) {
                items.push([{ strong: fmtCount(data.tracked) }, { text: ' objects tracked' }]);
            }
            const debris = data.by_type && data.by_type.DEBRIS;
            if (debris) items.push([{ strong: fmtCount(debris) }, { text: ' tracked debris' }]);
        }
    } catch (_) { /* ticker degrades silently — the stat strip already surfaces the failure */ }

    try {
        const res = await fetch('/api/decay-watch?limit=1');
        if (res.ok) {
            const data = await res.json();
            const next = data.watch && data.watch[0];
            if (next && next.days_until != null) {
                const when = next.days_until <= 0 ? 'imminent' : `in ~${next.days_until}d`;
                items.push([
                    { text: 'Next predicted reentry: ' },
                    { strong: next.name },
                    { text: ` ${when}` },
                ]);
            }
        }
    } catch (_) { /* optional ticker content */ }

    try {
        const res = await fetch('/api/brief');
        if (res.ok) {
            const data = await res.json();
            if (data.available && data.narrative) {
                items.push([{ text: 'Daily brief: ' }, { text: data.narrative }]);
            }
        }
    } catch (_) { /* optional ticker content */ }

    try {
        const res = await fetch('/api/feed?limit=6');
        if (res.ok) {
            const data = await res.json();
            for (const ev of (data.events || []).slice(0, 3)) {
                const label = FEED_KIND_LABEL[ev.kind];
                if (!label || !ev.title) continue;
                items.push([{ text: `${label}: ` }, { strong: ev.title }]);
            }
        }
    } catch (_) { /* optional ticker content */ }

    if (items.length === 0) {
        items.push([{ text: 'Live satellite catalog intelligence — Space-Track.org & CelesTrak' }]);
    }

    return items;
}

async function initTicker() {
    const ticker = document.getElementById('ticker');
    const track = document.getElementById('ticker-track');
    if (!ticker || !track) return;

    const items = await buildTickerItems();
    // Duplicate the sequence so the CSS scroll (translateX -50%) loops seamlessly.
    track.textContent = '';
    for (const parts of [...items, ...items]) {
        track.appendChild(makeTickerItem(parts));
    }
    ticker.hidden = false;
}

// Ticker and header both use `position: sticky` and stack (header at top:0,
// ticker at top: header height) — set the real measured header height so
// the ticker sits flush under it at any viewport/font-size instead of a
// hardcoded guess.
function syncHeaderHeight() {
    const header = document.querySelector('.site-header');
    if (!header) return;
    document.documentElement.style.setProperty('--header-h', `${header.offsetHeight}px`);
}

function initHero() {
    if (reduceMotion) return;
    const canvas = document.getElementById('hero-canvas');
    if (!canvas) return;
    let scene = null;
    try {
        scene = initHeroScene(canvas);
    } catch (err) {
        console.warn('[landing] hero WebGL scene failed, falling back to 2D starfield:', err);
    }
    if (!scene) initStarfield();
}

document.addEventListener('DOMContentLoaded', () => {
    initHero();
    loadStats();
    initTicker();
    syncHeaderHeight();
    window.addEventListener('resize', syncHeaderHeight, { passive: true });
});
