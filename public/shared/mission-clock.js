/**
 * Mission year — a 2026 → 2061 horizon (35 years) driven by real elapsed
 * time since the anchor date, not a session animation. Every visitor at the
 * same moment sees the same year; no server state, no drift to reconcile.
 */
const ANCHOR_DATE = Date.UTC(2026, 7, 1);   // 2026-08-01, year 2026.00
const START_YEAR  = 2026;
const END_YEAR    = 2061;
const HORIZON_MS  = (END_YEAR - START_YEAR) * 365.25 * 86400 * 1000;

export function missionYear(now = Date.now()) {
    const elapsed = Math.max(0, now - ANCHOR_DATE);
    const frac = Math.min(1, elapsed / HORIZON_MS);
    return START_YEAR + frac * (END_YEAR - START_YEAR);
}

export function missionYearLabel(now = Date.now()) {
    return String(Math.floor(missionYear(now)));
}

export function missionYearFraction(now = Date.now()) {
    return (missionYear(now) - START_YEAR) / (END_YEAR - START_YEAR);
}

/**
 * Mounts a compact "YEAR 2026 / 2061" readout into `el` and keeps it fresh.
 * Cheap enough (one DOM write) to poll on an interval rather than rAF — this
 * is a date readout, not an animation.
 */
export function mountMissionClock(el) {
    if (!el) return;
    el.classList.add('mission-clock');
    el.innerHTML =
        '<span class="mission-clock__year"></span>' +
        '<span class="mission-clock__sep">/</span>' +
        '<span class="mission-clock__end">' + END_YEAR + '</span>' +
        '<span class="mission-clock__bar"><span class="mission-clock__fill"></span></span>';

    const yearEl = el.querySelector('.mission-clock__year');
    const fillEl = el.querySelector('.mission-clock__fill');

    function render() {
        yearEl.textContent = missionYearLabel();
        fillEl.style.width = (missionYearFraction() * 100).toFixed(3) + '%';
    }

    render();
    const id = setInterval(render, 60 * 60 * 1000); // hourly is plenty for a year readout
    return () => clearInterval(id);
}
