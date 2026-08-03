/**
 * Object-type and country color palette, plus the colorblind-safe alternate.
 *
 * Extracted from shared/utils.js (TYPE_COLORS/COUNTRY_COLORS) and catalog.js
 * (CB_TYPE_COLORS/CB_COUNTRY_COLORS) — two halves of the same color-mode
 * toggle that lived in two different files.
 */

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

/** Colorblind-safe (Okabe-Ito) alternate palette, selected via the type/country/cb toggle. */
export const CB_TYPE_COLORS = {
    'PAYLOAD':     '#56B4E9',  // sky blue
    'ROCKET BODY': '#E69F00',  // orange
    'DEBRIS':      '#CC79A7',  // reddish purple
    'UNKNOWN':     '#999999',  // grey
};

export const CB_COUNTRY_COLORS = {
    'US': '#56B4E9',   // sky blue
    'RU': '#D55E00',   // vermillion
    'CN': '#E69F00',   // orange
    'GB': '#0072B2',   // blue
    'FR': '#009E73',   // bluish green
    'JP': '#CC79A7',   // reddish purple
    'IN': '#F0E442',   // yellow
    'KR': '#56B4E9',   // sky blue
    'DE': '#999999',   // grey
    'IT': '#009E73',   // bluish green
    'CA': '#D55E00',   // vermillion
    'AU': '#E69F00',   // orange
    'BR': '#009E73',   // bluish green
    'ESA': '#0072B2',  // blue
    'ISRAEL': '#0072B2',
    'UAE': '#56B4E9',
    'TS': '#CC79A7',
    'OR': '#CC79A7',
};

export function colorFor(type) {
    return TYPE_COLORS[(type || '').toUpperCase()] || TYPE_COLORS.UNKNOWN;
}

export function colorForCountry(country) {
    const key = (country || '').toUpperCase().trim();
    return COUNTRY_COLORS[key] || COUNTRY_DEFAULT;
}

/**
 * Map a boxscore SPADOC_CD (e.g. `CIS`, `PRC`, `UK`) onto the country palette,
 * whose keys are the two-letter codes used by GP's COUNTRY_CODE. The raw box
 * table ships its own code set, so a direct lookup turns everything that is not
 * `US`/`FR`/`IT`/`CA` into default grey. Aliasing keeps one color source.
 */
const BOX_CD = {
    'US': 'US', 'USA': 'US', 'CIS': 'RU', 'RUS': 'RU', 'PRC': 'CN', 'CHN': 'CN',
    'GB': 'GB', 'UK': 'GB', 'GBR': 'GB', 'JPN': 'JP', 'IND': 'IN', 'GER': 'DE',
    'FR': 'FR', 'FRA': 'FR', 'IT': 'IT', 'ITA': 'IT', 'SKOR': 'KR', 'KOR': 'KR',
    'AUS': 'AU', 'BRAZ': 'BR', 'ISRA': 'IL', 'UAE': 'AE', 'CA': 'CA',
    'TBD': null, 'ALL': null, 'ORB': null,
};

export function colorForBoxCode(code) {
    const key = (code || '').toUpperCase().trim();
    const alias = BOX_CD[key] ?? key;
    return alias ? colorForCountry(alias) : COUNTRY_DEFAULT;
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
