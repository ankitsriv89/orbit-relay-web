/**
 * Shared utility functions for SpaceTrack pages.
 */

export const num = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));

export function relTime(ts) {
    if (!ts) return '—';
    const diff = (Date.now() - new Date(ts).getTime()) / 1000;
    if (diff < 60) return `${Math.round(diff)}s ago`;
    if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
    return `${Math.round(diff / 86400)}d ago`;
}

export function fmtLat(lat) {
    return lat == null ? '—' : `${lat >= 0 ? 'N' : 'S'} ${Math.abs(lat).toFixed(4)}°`;
}

export function fmtLon(lon) {
    return lon == null ? '—' : `${lon >= 0 ? 'E' : 'W'} ${Math.abs(lon).toFixed(4)}°`;
}

export function fmtMiss(km) {
    return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(2)} km`;
}

export function fmtRelSpeed(kms) {
    return kms < 1 ? `${Math.round(kms * 1000)} m/s` : `${kms.toFixed(1)} km/s`;
}

export function fmtElsetAge(r) {
    const ages = [r.a?.epochAgeDays, r.b?.epochAgeDays].filter(a => a != null);
    if (!ages.length) return 'elset age unknown';
    const oldest = Math.max(...ages);
    return oldest < 1 ? 'elsets <1 d old' : `elsets ${oldest.toFixed(1)} d old`;
}

export function fmtWhen(r) {
    const CO_ORBITING_KMS = 0.1;
    return r.relSpeedKms < CO_ORBITING_KMS ? 'co-orbiting' : inTime(r.tcaMs);
}

function inTime(ms) {
    if (ms == null) return '—';
    const diff = ms - Date.now();
    if (diff <= 0) return 'now';
    const m = Math.round(diff / 60000);
    const h = Math.round(diff / 3600000);
    return m < 60 ? `${m}m` : `${h}h`;
}

/**
 * Orbit-regime-based point size.
 * LEO is dense and close → small dots; GEO is sparse and far → larger dots.
 * Returns a pixel size suitable for a PointPrimitive.
 */
export function regimeSize(altKm) {
    if (altKm == null) return 6;
    if (altKm < 600)   return 5;    // LEO
    if (altKm < 2000)  return 6;    // LEO upper
    if (altKm < 10000) return 7;    // MEO
    if (altKm < 36000) return 8;    // MEO upper / HEO
    return 10;                       // GEO / beyond
}

export function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

export function fillSelect(id, entries) {
    const el = document.getElementById(id);
    if (!el || !entries) return;
    while (el.options.length > 1) el.remove(1);
    for (const e of entries) {
        if (e.key == null || e.key === '') continue;
        const opt = document.createElement('option');
        opt.value = e.key;
        opt.textContent = `${e.key} (${num(e.n)})`;
        el.appendChild(opt);
    }
}

export function status(elOrId, msg) {
    const el = typeof elOrId === 'string' ? document.getElementById(elOrId) : elOrId;
    if (el) el.textContent = msg;
}

/**
 * Turn a failed API call into a status line that says *why*.
 *
 * The filter form used to report every failure as the bare string "query
 * failed", so a rejected filter value, an offline box, and a 500 were
 * indistinguishable — the reason existed only in the console. `fetchJSON`
 * attaches the API's own `{"error": …}` message as `err.detail`; prefer it,
 * fall back to the shape of the failure.
 */
export function queryFailure(err) {
    if (err && err.detail) return err.detail;
    if (err && err.status) {
        if (err.status === 400) return 'query rejected — check the filter values';
        if (err.status === 404) return 'query failed — endpoint not found';
        if (err.status >= 500) return `query failed — server error (${err.status})`;
        return `query failed — HTTP ${err.status}`;
    }
    /* No status: fetch itself rejected (offline, DNS, CORS) or the URL was
       malformed before the request was ever made. */
    if (err instanceof TypeError) return 'query failed — could not reach the API';
    return 'query failed';
}

export const $ = (id) => document.getElementById(id);

/**
 * Bind a listener by element id, no-oping when the node is missing.
 *
 * A bare `$('id').addEventListener(...)` throws at module import if the id is
 * absent, which silently unregisters every later handler in that module (an
 * ES module fails wholesale). This keeps the guard in one place — same spirit
 * as `setText` above.
 */
export function on(id, ev, fn) {
    const el = document.getElementById(id);
    if (el) el.addEventListener(ev, fn);
    return el;
}