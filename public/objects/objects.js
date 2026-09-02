/**
 * The object encyclopedia index — /objects/.
 *
 * A filter table over ~28k profile rows, served by /api/objects (the same
 * envelope /api/search returns, so this mirrors /spacetrack/'s patterns). The
 * facet cascade is server-side (buildClause(excludeParam) in objects.js): each
 * filter change re-fetches ?facets=1 to repopulate the other selects without
 * collapsing the one just chosen.
 *
 * Root-absolute for anything shared; this file is depth 1 under public/.
 * No insertAdjacentHTML with API-derived content — rows are built with
 * createElement / textContent.
 */
const API = '/api';
const PAGE = 60;

// When the page itself was loaded with a ?cb= cache-buster (the e2e suite does
// this), carry it onto the API calls too — otherwise a warm edge cache serves a
// stale count after the test reseeds its local D1. A no-op in normal use.
const CB = new URLSearchParams(location.search).get('cb');
const bust = (url) => (CB ? `${url}${url.includes('?') ? '&' : '?'}cb=${CB}` : url);

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};
const form = $('filters');
const rowsEl = $('rows');
const countEl = $('count');
const moreBtn = $('more');

const state = { offset: 0, total: 0, loading: false };

/** Current filter values as a URLSearchParams, empties dropped. */
function params(extra = {}) {
  const p = new URLSearchParams();
  for (const el of form.elements) {
    if (el.name && el.value) p.set(el.name, el.value);
  }
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p;
}

async function getJSON(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

function fillSelect(sel, options, keep) {
  const chosen = keep ?? sel.value;
  sel.textContent = '';
  const any = document.createElement('option');
  any.value = '';
  any.textContent = 'Any';
  sel.appendChild(any);
  for (const { key } of options) {
    if (key == null || key === '') continue;
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = key;
    sel.appendChild(opt);
  }
  sel.value = chosen;
  if (sel.value !== chosen) sel.value = ''; // chosen value no longer offered
}

async function refreshFacets() {
  try {
    const data = await getJSON(bust(`${API}/objects?${params({ facets: '1' })}`));
    fillSelect($('f-country'), data.facets.country);
    fillSelect($('f-type'), data.facets.type);
    fillSelect($('f-operator'), data.facets.operator);
    fillSelect($('f-status'), data.facets.status);
  } catch (err) {
    console.warn('[objects] facet refresh failed:', err);
  }
}

function objectCell(row) {
  const td = document.createElement('td');
  const a = document.createElement('a');
  a.className = 'obj-name';
  a.href = `/objects/${encodeURIComponent(row.norad)}/`;
  a.textContent = row.official_name || `NORAD ${row.norad}`;
  td.appendChild(a);
  const sub = document.createElement('span');
  sub.className = 'obj-sub';
  sub.textContent = `#${row.norad}`;
  td.appendChild(sub);
  return td;
}

function textCell(value, className) {
  const td = document.createElement('td');
  if (className) td.className = className;
  td.textContent = value == null || value === '' ? '—' : value;
  return td;
}

/** Operator cell — a small "derived" tag only when there is a real value. */
function operatorCell(value) {
  const td = document.createElement('td');
  td.className = 'obj-derived';
  if (value == null || value === '') {
    td.textContent = '—';
    return td;
  }
  td.appendChild(document.createTextNode(value));
  td.appendChild(el('span', 'obj-derived__tag', '·derived'));
  return td;
}

function renderRows(results, append) {
  if (!append) rowsEl.textContent = '';
  for (const row of results) {
    const tr = document.createElement('tr');
    tr.appendChild(objectCell(row));
    tr.appendChild(textCell(row.cospar, 'obj-mono'));
    tr.appendChild(operatorCell(row.operator_name));
    tr.appendChild(textCell(row.owner_country));
    tr.appendChild(textCell(row.mission_type));
    tr.appendChild(textCell(row.status, 'obj-status'));
    rowsEl.appendChild(tr);
  }
}

async function load(append = false) {
  if (state.loading) return;
  state.loading = true;
  if (!append) state.offset = 0;
  countEl.textContent = append ? countEl.textContent : 'Loading…';
  try {
    const data = await getJSON(bust(`${API}/objects?${params({ limit: PAGE, offset: state.offset })}`));
    state.total = data.total;
    renderRows(data.results, append);
    state.offset += data.results.length;
    countEl.textContent = state.total === 1
      ? '1 object'
      : `${state.total.toLocaleString()} objects`;
    moreBtn.hidden = state.offset >= state.total;
  } catch (err) {
    console.error('[objects] load failed:', err);
    countEl.textContent = 'Could not load the encyclopedia. Try again shortly.';
  } finally {
    state.loading = false;
  }
}

let debounce;
function onFilterChange() {
  clearTimeout(debounce);
  debounce = setTimeout(async () => {
    await Promise.all([refreshFacets(), load(false)]);
  }, 180);
}

form.addEventListener('input', onFilterChange);
form.addEventListener('change', onFilterChange);
$('f-reset').addEventListener('click', () => {
  form.reset();
  onFilterChange();
});
moreBtn.addEventListener('click', () => load(true));

refreshFacets();
load(false);
