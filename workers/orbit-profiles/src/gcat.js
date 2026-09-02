/**
 * GCAT bulk-source parsing — Jonathan McDowell's satcat.tsv + orgs.tsv into the
 * COSPAR → {byField, spine} index runFacts() consumes.
 *
 * GCAT is CC-BY (attribution discharged by the `<a>` tag SOURCES already holds).
 * satcat.tsv is one row per catalogued object; orgs.tsv is the code table its
 * Owner / State / Manufacturer columns point into — those columns are GCAT
 * *codes* ("SU", "KHRUN"), never display names, so resolution through orgs.tsv
 * is not optional.
 *
 * Only fields satcat.tsv can honestly supply are emitted: name, operator,
 * owner country, bus, manufacturer, launch mass, status. mission_summary,
 * mission_type, power and design life are NSSDCA's to fill — GCAT satcat has a
 * coarse object Type (P/R/D), not a mission purpose, and quoting that as
 * mission_type would misrepresent a debris fragment as having a mission.
 *
 * Pure functions over the file text the caller fetched — no I/O, so the parse
 * is provable against a fixture. index.js's loadSourceIndex() is the fetch shim.
 */
import { normalizeCospar } from './match.js';

/** GCAT's "no value" tokens: "-" (not applicable), "?" (unknown), and empty. */
function clean(cell) {
  const s = (cell ?? '').trim();
  return s === '' || s === '-' || s === '?' ? null : s;
}

/**
 * A GCAT TSV: one "#"-prefixed header line, then tab-separated rows. GCAT also
 * emits a `# Updated <date>` comment line right below the header — every
 * "#"-prefixed line past the first is skipped, not parsed as data. A short row
 * (fewer cells than the header) is kept; trailing columns read as absent. Cells
 * are trimmed — GCAT space-pads its fixed-width columns.
 * @returns {{header: string[], rows: Array<Record<string, string>>}}
 */
export function parseTsv(text) {
  const lines = String(text ?? '').split(/\r?\n/).filter((l) => l.length > 0);
  if (!lines.length) return { header: [], rows: [] };
  const header = lines[0].replace(/^#/, '').split('\t').map((h) => h.trim());
  const rows = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith('#')) continue;
    const cells = line.split('\t');
    const row = {};
    header.forEach((h, i) => { row[h] = (cells[i] ?? '').trim(); });
    rows.push(row);
  }
  return { header, rows };
}

/**
 * orgs.tsv → Map<code, {name, stateCode}>. `Name` is the long display form;
 * `StateCode` is the country/state code the org rolls up to (itself a key in
 * this same map for a country row).
 * @returns {Map<string, {name: string, stateCode: string|null}>}
 */
export function parseOrgs(text) {
  const { rows } = parseTsv(text);
  const map = new Map();
  for (const r of rows) {
    const code = clean(r.Code);
    if (!code) continue;
    map.set(code, { name: clean(r.Name) || code, stateCode: clean(r.StateCode) });
  }
  return map;
}

/**
 * GCAT Status → an honest facet label. GCAT's `O` is "separated from parent,
 * still in free flight" — it means *in orbit*, NOT operational; GCAT carries no
 * "does it still work" fact. Natural (`R`) and active (`D`) reentry are a real
 * sourced distinction but collapse here so the `status` facet stays a short
 * list. Unmapped codes stay null rather than guessing.
 */
function mapStatus(raw) {
  const s = clean(raw);
  if (!s) return null;
  if (/^AO/.test(s)) return 'attached';        // AO, AO IN — never separately orbited
  if (/^O/.test(s)) return 'in orbit';         // O, OX
  if (/^A?[RD]/.test(s)) return 'decayed';      // R, D, AR — reentered
  if (/^A?L/.test(s)) return 'landed';          // L, AL — landed / splashed down
  if (/^(DSO|EO|EL)/.test(s)) return 'deep space';
  return null;
}

const GCAT_URL = 'https://planet4589.org/space/gcat/data/cat/satcat.html';

/**
 * @param {string} satcatText  contents of satcat.tsv
 * @param {string} orgsText    contents of orgs.tsv
 * @returns {Map<string, {byField: Record<string, Array<object>>, spine: object}>}
 *   keyed by canonical COSPAR. `spine` carries every `profiles` column (value or
 *   null); `byField` carries a single gcat-sourced Fact for each populated one —
 *   the shape resolveConflicts() + writeFacts() take directly.
 */
export function buildGcatIndex(satcatText, orgsText) {
  const orgs = parseOrgs(orgsText);
  const orgName = (code) => (code && orgs.get(code) ? orgs.get(code).name : null);
  const { rows } = parseTsv(satcatText);
  const index = new Map();

  for (const row of rows) {
    const cospar = normalizeCospar(row.Piece);
    if (!cospar || index.has(cospar)) continue;   // first spelling of a designator wins

    const spine = {
      cospar,
      official_name: clean(row.Name) || clean(row.PLName),
      mission_summary: null,
      operator_name: orgName(clean(row.Owner)),
      owner_country: orgName(clean(row.State)),
      bus: clean(row.Bus),
      manufacturer: orgName(clean(row.Manufacturer)),
      launch_mass_kg: numeric(row.Mass),
      power_w: null,
      design_life_years: null,
      mission_type: null,
      status: mapStatus(row.Status),
    };

    const byField = {};
    for (const [field, value] of Object.entries(spine)) {
      if (field === 'cospar' || value == null) continue;
      byField[field] = [{ value, source_id: 'gcat', source_url: GCAT_URL, confidence: 1 }];
    }

    index.set(cospar, { byField, spine });
  }

  return index;
}

/** A GCAT numeric cell → Number, or null when absent / non-numeric. */
function numeric(cell) {
  const s = clean(cell);
  if (s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
