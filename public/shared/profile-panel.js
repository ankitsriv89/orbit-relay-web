/**
 * The inline profile panel for /spacetrack/ — the object encyclopedia entry,
 * condensed, mounted alongside the dossier.
 *
 * ONE database, one API, two presentations. This reads /api/profile/<norad> —
 * the same shape Task 9's detail page renders — and shows the profile MINUS its
 * long-form sections. It is not a second data path: if you find yourself adding
 * a panel-specific endpoint or query shape, that is the thing this design
 * forbids.
 *
 * Failure is the common case. Most objects have no profile, so the panel must be
 * ABSENT, not empty, and never an error: profile:null, a 404 and a fetch failure
 * all hide it, and the dossier keeps working exactly as it does today. The panel
 * never blocks the dossier's own render — the caller fires show() without
 * awaiting it.
 *
 * No insertAdjacentHTML with API-derived content: nodes are built and
 * textContent is set, matching dossier.js's setText pattern.
 */

const KEY_FACTS = [
  ['operator_name', 'OPERATOR', { derived: true }],
  ['owner_country', 'COUNTRY'],
  ['manufacturer', 'MAKER'],
  ['bus', 'BUS'],
  ['launch_mass_kg', 'MASS', { unit: 'kg' }],
  ['power_w', 'POWER', { unit: 'W' }],
  ['design_life_years', 'DESIGN LIFE', { unit: 'yr' }],
  ['mission_type', 'MISSION'],
  ['status', 'STATUS'],
];

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

/**
 * @param {{mount: HTMLElement, getApiBase: () => string}} opts
 * @returns {{show: (norad: number) => Promise<void>, hide: () => void}}
 */
export function createProfilePanel({ mount, getApiBase }) {
  let token = 0;

  function hide() {
    token++;                 // cancel any in-flight show()
    mount.hidden = true;
    mount.textContent = '';
  }

  async function show(norad) {
    const mine = ++token;
    if (norad == null) return hide();

    let data;
    try {
      const r = await fetch(`${getApiBase()}/profile/${encodeURIComponent(norad)}`,
        { headers: { Accept: 'application/json' } });
      if (r.status === 404) return hide();
      if (!r.ok) throw new Error(String(r.status));
      data = await r.json();
    } catch (_err) {
      return hide();          // absent, not an error surface
    }

    if (mine !== token) return;      // a newer selection won
    if (!data || !data.profile) return hide();

    render(data);
  }

  function render(data) {
    const p = data.profile;
    mount.textContent = '';

    const primary = (data.images || []).find((im) => im.is_primary) || (data.images || [])[0];
    mount.appendChild(figure(primary, p.mission_type, getApiBase));

    if (p.official_name) mount.appendChild(el('div', 'st-profile__name', p.official_name));
    if (p.prose) mount.appendChild(el('p', 'st-profile__prose', p.prose));

    const byField = Object.fromEntries((data.fields || []).map((f) => [f.field, f]));
    const rows = el('dl', 'st-profile__facts');
    for (const [key, label, meta] of KEY_FACTS) {
      const value = formatValue(p[key], meta);
      if (value == null) continue;
      rows.appendChild(el('dt', null, label));
      const dd = el('dd', null, value);
      if (meta && meta.derived) dd.appendChild(el('span', 'st-profile__derived', ' ·derived'));
      const src = byField[key];
      if (src) {
        const cite = el('a', 'st-profile__src', src.source_id);
        if (src.source_url) { cite.href = src.source_url; cite.target = '_blank'; cite.rel = 'noopener'; }
        dd.appendChild(document.createTextNode(' '));
        dd.appendChild(cite);
      }
      rows.appendChild(dd);
    }
    if (rows.childElementCount) mount.appendChild(rows);

    const link = el('a', 'st-profile__more', 'Full encyclopedia entry →');
    link.href = `/objects/${encodeURIComponent(p.norad)}/`;
    mount.appendChild(link);

    mount.hidden = false;
  }

  return { show, hide };
}

function formatValue(raw, meta) {
  if (raw == null || raw === '') return null;
  if (meta && meta.unit) {
    const n = Number(raw);
    return Number.isFinite(n) ? `${n} ${meta.unit}` : null;
  }
  return String(raw);
}

const PLACEHOLDER_GLYPH = '\u{1F6F0}';   // 🛰

/** The thumbnail, or a placeholder on a miss — never a broken <img>. */
function figure(image, _missionType, getApiBase) {
  const fig = el('figure', 'st-profile__figure');
  const showPlaceholder = () => {
    fig.textContent = '';
    fig.classList.add('st-profile__figure--placeholder');
    fig.appendChild(el('span', null, PLACEHOLDER_GLYPH));
  };
  if (image && image.thumb_key) {
    const img = document.createElement('img');
    img.src = `${getApiBase()}/img/${image.thumb_key.replace(/^profiles\//, '')}`;
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', showPlaceholder);
    fig.appendChild(img);
    if (image.credit) fig.appendChild(el('figcaption', null, image.credit));
  } else {
    showPlaceholder();
  }
  return fig;
}
