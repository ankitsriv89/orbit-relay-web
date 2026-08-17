/**
 * Constellation layer registry for /orbit/ (plan 34 3.1 S11).
 *
 * Before this, the 15 group checkboxes + ISS row were hand-authored twice —
 * once in the desktop `#layer-list`, once in the mobile `#layer-list-drawer`
 * — and every layer change meant editing both in lockstep (see S6's revs
 * button, which still has to do exactly that until this registry existed).
 * `LAYERS` is now the single source of truth; `renderLayerList()` builds both
 * copies from it, and `wireLayerMirror()` replaces the old
 * `querySelectorAll('.layer-cb')` index-pairing in orbital-relay.js.
 *
 * Markup shape is unchanged on purpose: `.layer-cb[data-group]` +
 * `data-color`/`data-cap`/`data-builtin`, `#layer-status-{group}` (desktop)
 * and `#layer-status-{group}-drawer` (mobile) — `orbital-relay.js`'s
 * `toggleLayer`/`reloadAllLayers` and tests/e2e/test_orbit.py's `set_layer()`
 * key on those directly and must keep working unmodified.
 */

/** @typedef {{group: string, name: string, flag: string, color?: string, cap?: number, builtin?: boolean, on?: boolean}} LayerDef */
/** @typedef {{section: string, layers: LayerDef[]}} LayerSection */

/** ISS is always-on furniture, not a toggle — kept separate from LAYERS. */
export const ISS_LAYER = { name: 'ISS', flag: '🛸', color: '#f5a623' };

/**
 * The original 15 groups are grouped exactly as before (USA / RUSSIA /
 * EU-ESA / CHINA / INDIA / INTERNATIONAL). `active` and `military` (plan 34
 * 3.1 S12) land here in the same commit as their `ALLOWED_GROUPS` +
 * baseline-file counterpart — adding a group here without backend/baseline
 * support behind it fails test_orbit.py's "every non-builtin layer ships a
 * baseline snapshot" check. Celestrak has no plain "rocket bodies" GP group
 * (verified against the live API — GROUP=rocket-bodies and GROUP=rb both
 * 400), so that spec filter stays out of scope for this registry; it would
 * need OBJECT_TYPE classification, which is a Space-Track/spacetrack.js
 * concept, not a Celestrak group fetch.
 */
export const LAYERS = [
    {
        section: '🇺🇸 USA',
        layers: [
            { group: 'gps-ops', name: 'GPS', flag: '🇺🇸', color: '#f5f500', cap: 35, on: true },
            { group: 'iridium-NEXT', name: 'IRIDIUM', flag: '🇺🇸', color: '#cc88ff', cap: 66, on: true },
        ],
    },
    {
        section: '🇷🇺 RUSSIA',
        layers: [
            { group: 'glo-ops', name: 'GLONASS', flag: '🇷🇺', color: '#ff4444', cap: 30 },
        ],
    },
    {
        section: '🇪🇺 EU / ESA',
        layers: [
            { group: 'galileo', name: 'GALILEO', flag: '🇪🇺', color: '#4488ff', cap: 30 },
            { group: 'oneweb', name: 'ONEWEB', flag: '🇪🇺', color: '#66ddff', cap: 150 },
        ],
    },
    {
        section: '🇨🇳 CHINA',
        layers: [
            { group: 'beidou', name: 'BEIDOU', flag: '🇨🇳', color: '#ff6600', cap: 50 },
            { group: 'qianfan', name: 'QIANFAN', flag: '🇨🇳', color: '#ffaa44', cap: 150 },
            { group: 'hulianwang', name: 'GUOWANG', flag: '🇨🇳', color: '#ffcc66', cap: 150 },
        ],
    },
    {
        section: '🇮🇳 INDIA',
        layers: [
            { group: 'irnss', name: 'NAVIC', flag: '🇮🇳', color: '#ff9933', cap: 15 },
        ],
    },
    {
        section: '🌍 INTERNATIONAL',
        layers: [
            { group: 'stations-other', name: 'STATIONS', flag: '🛰', color: '#ff8c69', builtin: true, on: true },
            { group: 'aurora', name: 'AURORA', flag: '🌌', color: '#42f587', builtin: true },
            { group: 'weather', name: 'WEATHER', flag: '🌍', color: '#88ffcc', cap: 100 },
            { group: 'geo', name: 'GEO BELT', flag: '🌍', color: '#ffe066', cap: 150 },
            { group: 'resource', name: 'EARTH-OBS', flag: '🌍', color: '#66ff99', cap: 150 },
            { group: 'last-30-days', name: 'NEWEST', flag: '🚀', color: '#ff66cc', cap: 150 },
            { group: 'cosmos-2251-debris', name: 'DEBRIS', flag: '💥', color: '#ff5555', cap: 150 },
        ],
    },
    {
        section: '🎖 OTHER',
        layers: [
            // "active" is Celestrak's entire active-payload catalog (~9-10k
            // objects) — same order of magnitude as the full Starlink group,
            // which is why the baseline snapshot trims it the same way
            // starlink.txt is trimmed (see scripts/snapshot_tle.sh) and the
            // render cap here matches the other high-volume groups.
            { group: 'active', name: 'ACTIVE', flag: '🛰', color: '#00ffaa', cap: 150 },
            { group: 'military', name: 'MILITARY', flag: '🎖', color: '#aaaaaa', cap: 150 },
        ],
    },
];

function swatchStyle(color) {
    return `background:${color};box-shadow:0 0 5px ${color}aa;`;
}

/** Builds one `<li class="layer-item">` — a checkbox row or the static ISS row. */
function buildLayerItem(def, idSuffix) {
    const li = document.createElement('li');
    li.className = 'layer-item';

    const isIss = def === ISS_LAYER;
    const label = document.createElement(isIss ? 'span' : 'label');
    if (isIss) {
        label.className = 'layer-label layer-label--static';
    } else {
        label.className = 'layer-label';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'layer-cb';
        cb.dataset.group = def.group;
        /* `on` layers boot checked. Without this every box rendered unchecked
         * and /orbit/ — the *cinematic* route — opened on a bare globe with
         * the ISS alone, reporting "TRACKING 1 ACTIVE SATELLITES". The count
         * was arithmetically right (1 ISS + 0 visible stations + 0 layers) and
         * still read as broken, because an empty sky is not what this page is
         * for. See bootDefaultLayers() in orbital-relay.js, which fetches the
         * ones flagged here. */
        if (def.on) cb.checked = true;
        if (def.builtin) {
            cb.dataset.builtin = 'true';
        } else {
            cb.dataset.color = def.color;
            cb.dataset.cap = String(def.cap);
        }
        label.appendChild(cb);
    }

    const swatch = document.createElement('span');
    swatch.className = 'layer-swatch';
    swatch.style.cssText = swatchStyle(def.color) + (isIss ? 'opacity:1;' : '');
    label.appendChild(swatch);

    const name = document.createElement('span');
    name.className = 'layer-name';
    name.textContent = def.name;
    label.appendChild(name);

    const flag = document.createElement('span');
    flag.className = 'layer-flag';
    flag.textContent = def.flag;
    label.appendChild(flag);

    li.appendChild(label);

    const status = document.createElement('span');
    status.className = 'layer-status';
    const group = isIss ? 'iss' : def.group;
    status.id = `layer-status-${group}${idSuffix}`;
    if (isIss) status.textContent = '1';
    li.appendChild(status);

    return li;
}

function buildSectionHeader(label) {
    const li = document.createElement('li');
    li.className = 'layer-item layer-item--section';
    const span = document.createElement('span');
    span.className = 'layer-section-label';
    span.textContent = label;
    li.appendChild(span);
    return li;
}

/**
 * Renders the ISS row + every LAYERS group into the `<ul>` at `mountId`,
 * replacing any existing children. `idSuffix` distinguishes the drawer copy's
 * `layer-status-*-drawer` ids from the desktop panel's.
 *
 * @param {string} mountId
 * @param {string} [idSuffix='']
 */
export function renderLayerList(mountId, idSuffix = '') {
    const ul = document.getElementById(mountId);
    if (!ul) return;
    ul.textContent = '';

    ul.appendChild(buildLayerItem(ISS_LAYER, idSuffix));

    for (const { section, layers } of LAYERS) {
        ul.appendChild(buildSectionHeader(section));
        for (const def of layers) {
            ul.appendChild(buildLayerItem(def, idSuffix));
        }
    }
}
