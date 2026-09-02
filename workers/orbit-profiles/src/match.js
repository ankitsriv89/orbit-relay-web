/**
 * COSPAR matching — the catalogue↔source join.
 *
 * Match on the COSPAR designator (OBJECT_ID), NEVER on name. Audit finding M-19
 * (functions/api/object/[norad].js:11-13): names change and a substring test
 * over-matches — "ISS (NAUKA)" and "ISS DEB" both contain "ISS". A wrong match
 * here is not an error, it is a debris fragment carrying the ISS mission
 * description in a database whose entire value is that its facts are sourced.
 * Silent wrong attribution is the worst failure mode this system has.
 *
 * Pure functions over rows the caller supplies. No I/O.
 */

/**
 * Pivot for two-digit years. The catalogue starts at Sputnik (1957-001A), so a
 * two-digit year >= 57 is 19xx and < 57 is 20xx. `56` will not be seen in
 * practice for decades; the split is placed where the real data is.
 */
const YEAR_PIVOT = 57;

const COMPACT = /^(\d{2})(\d{3})([A-Z]{1,3})$/;      // 98067A
const CANONICAL = /^(\d{4})-?(\d{3})\s*([A-Z]{1,3})$/; // 1998-067A, 1998067A, 1998-067  A

/**
 * Canonical COSPAR form: `1998-067A`. Accepts `1998-067A`, `98067A`,
 * `1998-067  A`, any case, surrounding whitespace.
 * @returns {string|null} null when the input is not a COSPAR designator —
 *   distinct from `''`, so a caller can tell "absent" from "malformed".
 */
export function normalizeCospar(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toUpperCase().replace(/\s+/g, ' ');
  if (!s) return null;

  let m = CANONICAL.exec(s.replace(/(\d{3}) ([A-Z])/, '$1$2'));
  if (m) return `${m[1]}-${m[2]}${m[3]}`;

  m = COMPACT.exec(s);
  if (m) {
    const yy = Number(m[1]);
    const century = yy >= YEAR_PIVOT ? 1900 : 2000;
    return `${century + yy}-${m[2]}${m[3]}`;
  }

  return null;
}

/**
 * @param {Array<{NORAD_CAT_ID: number, OBJECT_ID: string}>} catalogRows
 * @param {Array<{cospar: string, [k: string]: any}>} sourceRows
 * @returns {{matched: Map<number, object>, unmatchedNorad: number[], unmatchedSource: object[]}}
 *
 * One index build over the sources, then a single pass over the catalogue —
 * this runs over ~28k catalogue rows × 2 sources, so an inner scan would be a
 * real cost. First source row wins a designator; a later duplicate (e.g. the
 * same object spelled compactly) is dropped from `unmatchedSource` silently
 * rather than counted as an orphan.
 */
export function matchByCospar(catalogRows, sourceRows) {
  const byCospar = new Map();
  for (const row of sourceRows || []) {
    const key = normalizeCospar(row.cospar);
    if (key && !byCospar.has(key)) byCospar.set(key, row);
  }

  const matched = new Map();
  const unmatchedNorad = [];
  const consumed = new Set();

  for (const row of catalogRows || []) {
    const norad = Number(row.NORAD_CAT_ID);
    const key = normalizeCospar(row.OBJECT_ID);
    const source = key ? byCospar.get(key) : undefined;
    if (source) {
      matched.set(norad, source);
      consumed.add(key);
    } else {
      unmatchedNorad.push(norad);
    }
  }

  const unmatchedSource = [];
  for (const [key, row] of byCospar) {
    if (!consumed.has(key)) unmatchedSource.push(row);
  }

  return { matched, unmatchedNorad, unmatchedSource };
}
