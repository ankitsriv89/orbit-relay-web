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

export const TYPE_COLORS = {
    'PAYLOAD': '#00ccff',
    'ROCKET BODY': '#f5a623',
    'DEBRIS': '#ff5f6d',
    'UNKNOWN': '#9aa7b2',
};

export const COUNTRY_COLORS = {
    'US': '#00ccff',   // cyan — United States
    'RU': '#ff5f6d',   // red — Russia
    'CN': '#ff9933',   // orange — China
    'GB': '#4488ff',   // blue — United Kingdom
    'FR': '#6666ff',   // indigo — France
    'JP': '#ff66cc',   // pink — Japan
    'IN': '#ffcc33',   // saffron — India
    'KR': '#66ddff',   // light cyan — South Korea
    'DE': '#cccccc',   // silver — Germany
    'IT': '#44cc88',   // green — Italy
    'CA': '#ff4444',   // red — Canada
    'AU': '#ffaa44',   // gold — Australia
    'BR': '#44cc44',   // green — Brazil
    'ESA': '#8888ff',  // blue-purple — European Space Agency
    'ISRAEL': '#4488ff',
    'UAE': '#00cc88',
    'TS': '#cc88ff',   // turquoise — Multinational/Commercial
    'OR': '#cc88ff',   // ORGANIZATION
};
const COUNTRY_DEFAULT = '#9aa7b2';

export function colorFor(type) {
    return TYPE_COLORS[(type || '').toUpperCase()] || TYPE_COLORS.UNKNOWN;
}

export function colorForCountry(country) {
    const key = (country || '').toUpperCase().trim();
    return COUNTRY_COLORS[key] || COUNTRY_DEFAULT;
}

/**
 * Derive a display color for a satellite row based on the current color mode.
 * @param {object} row  A catalog search result row
 * @param {'type'|'country'|'cb'} mode
 * @param {object} [cbTypeColors]  Colorblind type palette (when mode=cb)
 * @param {object} [cbCountryColors]  Colorblind country palette (when mode=cb)
 */
export function colorForRow(row, mode = 'type', cbTypeColors, cbCountryColors) {
    if (mode === 'cb') {
        const t = (row.OBJECT_TYPE || '').toUpperCase();
        const c = (row.COUNTRY_CODE || '').toUpperCase().trim();
        // Prefer country if available in CB palette, else type
        if (cbCountryColors && cbCountryColors[c]) return cbCountryColors[c];
        if (cbTypeColors && cbTypeColors[t]) return cbTypeColors[t];
        return cbTypeColors?.UNKNOWN || COUNTRY_DEFAULT;
    }
    if (mode === 'country') return colorForCountry(row.COUNTRY_CODE);
    return colorFor(row.OBJECT_TYPE);
}

/**
 * Orbit-regime-based point size.
 * LEO is dense and close → small dots; GEO is sparse and far → larger dots.
 * Returns a pixel size suitable for a PointPrimitive.
 */
export function regimeSize(altKm) {
    if (altKm == null) return 4;
    if (altKm < 600)   return 3;    // LEO
    if (altKm < 2000)  return 4;    // LEO upper
    if (altKm < 10000) return 5;    // MEO
    if (altKm < 36000) return 6;    // MEO upper / HEO
    return 7;                        // GEO / beyond
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

export const $ = (id) => document.getElementById(id);