/**
 * The object detail page — hydrates the crawlable shell from
 * functions/objects/[norad]/index.js.
 *
 * The shell already carries the <title>, meta description and JSON-LD (server
 * injected). This fills the visible body from /api/object/<norad>, which now
 * returns a `profile` key alongside its catalog reads.
 *
 * A `profile: null` object still renders a usable page — the encyclopedia
 * covers ~28k objects and most have no Tier 1 facts. An object with no image
 * shows a typed placeholder, never a broken <img>.
 *
 * Root-absolute for shared refs; depth 1 under public/. Values from the API are
 * placed with textContent / createElement — never insertAdjacentHTML.
 */
const API = '/api';

// Carry a page-level ?cb= cache-buster onto the API call (the e2e suite relies
// on this after reseeding a local D1). No-op in normal use.
const CB = new URLSearchParams(location.search).get('cb');
const bust = (url) => (CB ? `${url}${url.includes('?') ? '&' : '?'}cb=${CB}` : url);

const norad = document.body.dataset.norad;
const bodyEl = document.getElementById('obj-body');
const cosparEl = document.getElementById('obj-cospar');

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

function dl(pairs) {
  const list = el('dl', 'obj-dl');
  for (const [term, value] of pairs) {
    if (value == null || value === '') continue;
    list.appendChild(el('dt', null, term));
    list.appendChild(el('dd', null, String(value)));
  }
  return list;
}

/** Typed placeholder — a debris fragment and a payload must not look identical. */
function placeholderFigure(type) {
  const fig = el('figure', 'obj-figure obj-figure--placeholder');
  const glyph = { PAYLOAD: '🛰', 'ROCKET BODY': '🚀', DEBRIS: '✦' }[String(type || '').toUpperCase()] || '•';
  fig.appendChild(el('div', 'obj-figure__glyph', glyph));
  fig.appendChild(el('figcaption', null, `No public-domain image on file for this ${String(type || 'object').toLowerCase()}.`));
  return fig;
}

function imageFigure(image) {
  const fig = el('figure', 'obj-figure');
  const img = document.createElement('img');
  // image.r2_key is `profiles/<norad>/primary.<ext>`; the passthrough route is
  // /api/img/<norad>/primary.<ext>.
  img.src = `${API}/img/${image.r2_key.replace(/^profiles\//, '')}`;
  img.alt = '';
  img.loading = 'lazy';
  img.addEventListener('error', () => fig.replaceWith(placeholderFigure()));
  fig.appendChild(img);
  const cap = el('figcaption');
  cap.append(image.credit || 'NASA', document.createTextNode(' · '), image.license || 'public domain');
  fig.appendChild(cap);
  return fig;
}

function sourceList(fields) {
  if (!fields || !fields.length) return null;
  const wrap = el('div', 'obj-sources');
  wrap.appendChild(el('h2', null, 'Sources'));
  const ul = el('ul');
  for (const f of fields) {
    const li = el('li');
    li.appendChild(el('span', 'obj-sources__field', f.field.replace(/_/g, ' ')));
    const a = el('a', null, f.source_id);
    if (f.source_url) { a.href = f.source_url; a.target = '_blank'; a.rel = 'noopener'; }
    li.appendChild(a);
    ul.appendChild(li);
  }
  wrap.appendChild(ul);
  return wrap;
}

function renderProfile(container, profile) {
  const p = profile.profile;
  if (p.prose) container.appendChild(el('p', 'obj-prose', p.prose));

  const images = profile.images || [];
  const primary = images.find((im) => im.is_primary) || images[0];
  container.appendChild(primary ? imageFigure(primary) : placeholderFigure(p.mission_type));

  container.appendChild(dl([
    ['Official name', p.official_name],
    ['Operator', p.operator_name],
    ['Owner / country', p.owner_country],
    ['Manufacturer', p.manufacturer],
    ['Bus', p.bus],
    ['Launch mass', num(p.launch_mass_kg) != null ? `${num(p.launch_mass_kg)} kg` : null],
    ['Power', num(p.power_w) != null ? `${num(p.power_w)} W` : null],
    ['Design life', num(p.design_life_years) != null ? `${num(p.design_life_years)} years` : null],
    ['Mission type', p.mission_type],
    ['Status', p.status],
  ]));

  const sources = sourceList(profile.fields);
  if (sources) container.appendChild(sources);

  if (p.prose_tier === 2) {
    container.appendChild(el('p', 'obj-tiernote',
      'This description is generated from catalogue fields. A sourced mission summary is added where the facts support one.'));
  }
}

function renderCatalogOnly(container, object) {
  container.appendChild(placeholderFigure(object.OBJECT_TYPE));
  container.appendChild(el('p', 'obj-prose',
    'No descriptive profile is on file for this object yet. The orbital record below is from the catalogue.'));
  container.appendChild(dl([
    ['Object type', object.OBJECT_TYPE],
    ['COSPAR id', object.OBJECT_ID],
    ['Country', object.COUNTRY_CODE],
    ['Launch date', object.LAUNCH_DATE],
    ['Decay date', object.DECAY_DATE],
    ['Inclination', num(object.INCLINATION) != null ? `${num(object.INCLINATION)}°` : null],
    ['Apogee', num(object.apogee_km) != null ? `${Math.round(num(object.apogee_km))} km` : null],
    ['Perigee', num(object.perigee_km) != null ? `${Math.round(num(object.perigee_km))} km` : null],
  ]));
}

async function main() {
  let data;
  try {
    const r = await fetch(bust(`${API}/object/${encodeURIComponent(norad)}`), { headers: { Accept: 'application/json' } });
    if (r.status === 404) {
      bodyEl.textContent = '';
      bodyEl.appendChild(el('p', 'obj-error', `No catalogued object with NORAD ${norad}.`));
      return;
    }
    if (!r.ok) throw new Error(`${r.status}`);
    data = await r.json();
  } catch (err) {
    console.error('[object] load failed:', err);
    bodyEl.textContent = '';
    bodyEl.appendChild(el('p', 'obj-error', 'Could not load this object. Try again shortly.'));
    return;
  }

  const object = data.object || {};
  if (object.OBJECT_ID) cosparEl.textContent = ` · ${object.OBJECT_ID}`;

  bodyEl.textContent = '';
  if (data.profile) renderProfile(bodyEl, data.profile);
  else renderCatalogOnly(bodyEl, object);
}

main();
