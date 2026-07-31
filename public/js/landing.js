// Landing page: hero starfield + live catalog stat strip.

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ── Hero starfield ────────────────────────────────────────────────────── */
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

async function loadStats() {
    const noteEl = document.getElementById('stat-strip-note');
    try {
        const res = await fetch('/api/summary');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!data.tracked) throw new Error('summary artifact not built yet (tracked=0)');

        const tracked = data.tracked;
        const payloads = data.by_type && data.by_type.PAYLOAD;
        const debris = data.by_type && data.by_type.DEBRIS;
        const updatedAt = data.last_elset_ingest || data.generated_at;

        document.getElementById('stat-tracked').textContent = fmtCount(tracked);
        document.getElementById('stat-payloads').textContent = fmtCount(payloads);
        document.getElementById('stat-debris').textContent = fmtCount(debris);
        document.getElementById('stat-updated').textContent = fmtAge(updatedAt);

        if (data.stale && noteEl) {
            noteEl.hidden = false;
        }
    } catch (err) {
        console.warn('[landing] /api/summary unavailable, showing static copy:', err);
        document.getElementById('stat-tracked').textContent = '28,000+';
        document.getElementById('stat-payloads').textContent = '11,000+';
        document.getElementById('stat-debris').textContent = '15,000+';
        document.getElementById('stat-updated').textContent = 'daily';
        if (noteEl) noteEl.hidden = false;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    initStarfield();
    loadStats();
});
