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
 * orgs.tsv → Map<code, {name, ename, shortEName, stateCode}>.
 *
 * GCAT's `Name` for a country is the transliterated NATIVE form ("Zhonghua
 * Renmin Gongheguo"); `ShortEName` is the usable English label ("China"). For
 * an organisation `Name` is already Latin-script but often terse/native
 * ("Roskosmos"); `EName` is the fuller English form ("Russian Federal Space
 * Agency") and is `-` for many entries. Callers pick the column that fits the
 * field — see resolveOrg / resolveCountry in buildGcatIndex.
 * @returns {Map<string, {name:string, ename:string|null, shortEName:string|null, stateCode:string|null}>}
 */
export function parseOrgs(text) {
  const { rows } = parseTsv(text);
  const map = new Map();
  for (const r of rows) {
    const code = clean(r.Code);
    if (!code) continue;
    map.set(code, {
      name: clean(r.Name) || code,
      ename: clean(r.EName),
      shortEName: clean(r.ShortEName),
      stateCode: clean(r.StateCode),
    });
  }
  return map;
}

/**
 * GCAT Status code → an honest facet label, or null for an unmapped code.
 *
 * GCAT's `O` means "in free flight" — *in orbit*, NOT operational; GCAT carries
 * no does-it-still-work fact. "Attached" states (docked, grappled, berthed —
 * `DK`/`GRP`/`AO`/`ATT`) collapse into "in orbit": a berthed module is on orbit
 * as far as a catalogue browser is concerned, and the free-flew-or-not
 * distinction is not what the `status` facet is for. Reentry codes (natural
 * `R`, active `D`, suborbital `S`, attached `AR`) collapse into "decayed" for
 * the same reason. Codes are matched exactly, not by prefix — `E` (exploded in
 * orbit) must not match as `EO` (escape).
 */
const STATUS = {
  O: 'in orbit', OX: 'in orbit', N: 'in orbit', OI: 'in orbit', OE: 'in orbit',
  UDK: 'in orbit', REL: 'in orbit', DEP: 'in orbit', TO: 'in orbit',
  AO: 'in orbit', 'AO IN': 'in orbit', DK: 'in orbit', GRP: 'in orbit',
  ATT: 'in orbit', TFR: 'in orbit', TOA: 'in orbit',
  D: 'decayed', R: 'decayed', S: 'decayed', AR: 'decayed', 'AR IN': 'decayed', AS: 'decayed',
  L: 'landed', LF: 'landed', AL: 'landed', 'AL IN': 'landed',
  DSO: 'deep space', DSA: 'deep space', 'DSA IN': 'deep space', EO: 'deep space', EN: 'deep space',
};

/** @returns {string|null} */
export function mapStatusCode(raw) {
  const s = clean(raw);
  return s && Object.hasOwn(STATUS, s) ? STATUS[s] : null;
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
  // An organisation (operator / manufacturer): the fuller English name where
  // GCAT has one, else its Latin-script Name.
  const resolveOrg = (code) => {
    const o = code && orgs.get(code);
    return o ? (o.ename || o.name) : null;
  };
  // A country (the `State` column): the short English label ("China"), never
  // the transliterated native Name ("Zhonghua Renmin Gongheguo").
  const resolveCountry = (code) => {
    const o = code && orgs.get(code);
    return o ? (o.shortEName || o.ename || o.name) : null;
  };
  const { rows } = parseTsv(satcatText);
  const index = new Map();

  for (const row of rows) {
    const cospar = normalizeCospar(row.Piece);
    if (!cospar || index.has(cospar)) continue;   // first spelling of a designator wins

    const spine = {
      cospar,
      official_name: clean(row.Name) || clean(row.PLName),
      mission_summary: null,
      operator_name: resolveOrg(clean(row.Owner)),
      owner_country: resolveCountry(clean(row.State)),
      bus: clean(row.Bus),
      manufacturer: resolveOrg(clean(row.Manufacturer)),
      launch_mass_kg: numeric(row.Mass),
      power_w: null,
      design_life_years: null,
      mission_type: null,
      status: mapStatusCode(row.Status),
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
