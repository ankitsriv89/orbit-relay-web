/**
 * Derivation layer — everything we compute *from* the catalog rather than ask
 * Space-Track for.
 *
 * The plan's central economy: **partitioning costs zero extra API calls.** We
 * mirror the catalog once and slice it in SQL, so every view below — orbit
 * regime, launch era, debris family, operator, and all 20 legacy group files —
 * is a query over rows we already hold. That is why the budget stays at ~8
 * upstream calls/day no matter how many partitions the UI grows.
 *
 * Contains:
 *   - row derivation (regime / launch year / debris family / operator)
 *   - the objects upsert
 *   - group definitions → the R2 `.txt` bundles the globe actually reads
 *   - the summary and feed artifacts
 */

import { operatorFor, OPERATOR_LABELS } from './operators.js';

/**
 * The citation is a **condition of the redistribution approval**, not a
 * courtesy — USSPACECOM's blanket approval for basic SSA data is granted
 * "conditioned on appropriate citation". It ships in every artifact and every
 * API response. `functions/api/_orbit.js` carries a copy for the read side;
 * test/derive.test.mjs asserts the two strings are identical, because a silent
 * divergence there is a licence problem rather than a cosmetic one.
 */
export const CITATION =
  'Data source: Space-Track.org (USSPACECOM / 18th Space Defense Squadron). ' +
  'Redistributed under USSPACECOM express blanket approval for basic SSA data.';

/**
 * The SWPC attribution (plan 34 §3.4) — the second citation this project
 * carries. NOAA SWPC data is public domain, so this is courtesy rather than
 * licence-conditioned like CITATION, but the duplication discipline is the
 * same: this file and `functions/api/_orbit.js` are separate bundles, and
 * derive.test.mjs asserts the two copies are byte-identical.
 */
export const SWPC_CITATION =
  'Space weather data: NOAA Space Weather Prediction Center ' +
  '(services.swpc.noaa.gov). U.S. government work - public domain.';

/* ── Row derivation ─────────────────────────────────────────────────────── */

/**
 * Orbit regime. Thresholds are **Space-Track's own**, taken from the sample
 * queries in `Space-Track.org.pdf` p.11 rather than invented here:
 *
 *   LEO — `class/satcat/PERIOD/<128/DECAY/null-val` ("LEO = <2000KM altitude")
 *   GEO — `class/satcat/PERIOD/1430--1450` (their Geosynchronous Report), and
 *         `class/gp/MEAN_MOTION/0.99--1.01/ECCENTRICITY/<0.01` for the elset form
 *
 * HEO and MEO are the remainder split on eccentricity, as the plan specifies.
 * The eccentricity test runs first: a Molniya (period ~717 min, e≈0.74) and a
 * GTO (period ~630 min, e≈0.73) are both structurally HEO, and calling them MEO
 * on the strength of their period alone would be visibly wrong on a globe.
 */
export function regimeOf({ PERIOD, ECCENTRICITY }) {
  const p = Number(PERIOD);
  const e = Number(ECCENTRICITY);
  if (!Number.isFinite(p) || p <= 0) return null;
  if (Number.isFinite(e) && e >= 0.25) return 'HEO';
  if (p < 128) return 'LEO';
  if (p >= 1430 && p <= 1450) return 'GEO';
  return 'MEO';
}

/** '1958-03-17' → 1958. Tolerates nulls and the odd malformed date. */
export function launchYearOf(launchDate) {
  const m = /^(\d{4})/.exec(String(launchDate || ''));
  return m ? Number(m[1]) : null;
}

/**
 * Debris family from the international designator: every fragment of a breakup
 * inherits its parent's launch designator, so `1999-025` isolates all ~3,500
 * pieces of Fengyun-1C. This is more robust than a hand-maintained ID list —
 * it needs no upkeep as fragments are catalogued years after the event.
 *
 * '1999-025DKV' → '1999-025'
 */
export function debrisFamilyOf(objectId) {
  const m = /^(\d{4}-\d{3})/.exec(String(objectId || ''));
  return m ? m[1] : null;
}

/**
 * Column order for the objects table. Declared once and used by both the INSERT
 * and the value builder so the two cannot drift — a silent column/value
 * misalignment would write RCS_SIZE into SITE and nothing would throw.
 */
export const OBJECT_COLUMNS = [
  'NORAD_CAT_ID', 'OBJECT_NAME', 'OBJECT_ID', 'OBJECT_TYPE', 'COUNTRY_CODE',
  'RCS_SIZE', 'SITE', 'LAUNCH_DATE', 'DECAY_DATE',
  'EPOCH', 'CREATION_DATE', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION',
  'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'BSTAR',
  'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT', 'SEMIMAJOR_AXIS', 'PERIOD',
  'APOAPSIS', 'PERIAPSIS',
  'EPHEMERIS_TYPE', 'CLASSIFICATION_TYPE', 'ELEMENT_SET_NO', 'REV_AT_EPOCH',
  'GP_ID', 'FILE',
  'TLE_LINE0', 'TLE_LINE1', 'TLE_LINE2',
  'regime', 'launch_year', 'debris_family', 'operator',
  'first_seen', 'updated_at',
];

/** Columns we compute; everything else in OBJECT_COLUMNS comes from upstream. */
export const DERIVED_COLUMNS = new Set([
  'regime', 'launch_year', 'debris_family', 'operator', 'first_seen', 'updated_at',
]);

/**
 * The `predicates/` projection for GP queries — exactly the upstream fields we
 * store, so Space-Track stops sending the seven constant OMM envelope fields
 * (CCSDS_OMM_VERS, COMMENT, ORIGINATOR, CENTER_NAME, REF_FRAME, TIME_SYSTEM,
 * MEAN_ELEMENT_THEORY) on all ~28k rows. Smaller payload, less to stream, and
 * the request states plainly what we take.
 *
 * Derived from OBJECT_COLUMNS rather than typed out: a predicate name that does
 * not exist upstream is a hard 400, so the list must not be able to drift from
 * the schema it fills.
 */
export const GP_PREDICATES = OBJECT_COLUMNS.filter((c) => !DERIVED_COLUMNS.has(c));

// Space-Track returns every scalar as a JSON *string* ("PERIOD": "132.594").
// Coercing at ingest means D1 stores REAL/INTEGER as the schema declares, so
// `WHERE PERIOD BETWEEN 1430 AND 1450` compares numbers rather than text —
// which would otherwise sort '9' after '1430' and quietly return nonsense.
const NUMERIC = new Set([
  'NORAD_CAT_ID', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE',
  'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'BSTAR', 'MEAN_MOTION_DOT',
  'MEAN_MOTION_DDOT', 'SEMIMAJOR_AXIS', 'PERIOD', 'APOAPSIS', 'PERIAPSIS',
  'EPHEMERIS_TYPE', 'ELEMENT_SET_NO', 'REV_AT_EPOCH', 'GP_ID', 'FILE',
  'launch_year',
]);

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * One GP (OMM) row → the value array for OBJECT_UPSERT_SQL.
 * @param {object} gp   a row as Space-Track returns it
 * @param {string} now  ISO timestamp for this ingest run — the same value for
 *                      every row, which is what makes "new this run" a single
 *                      indexed equality query instead of a range scan.
 */
export function deriveObjectRow(gp, now) {
  const derived = {
    ...gp,
    regime: regimeOf(gp),
    launch_year: launchYearOf(gp.LAUNCH_DATE),
    debris_family: debrisFamilyOf(gp.OBJECT_ID),
    operator: operatorFor(gp.OBJECT_NAME),
    first_seen: now,
    updated_at: now,
  };
  return OBJECT_COLUMNS.map((c) => {
    const v = derived[c];
    if (v === undefined) return null;
    return NUMERIC.has(c) ? num(v) : (v === '' ? null : v);
  });
}

/**
 * Upsert keyed on NORAD_CAT_ID. `first_seen` is deliberately absent from the
 * DO UPDATE SET list: an omitted column keeps its stored value, so the column
 * records when *we* first saw an object and never gets overwritten by a later
 * re-ingest. The signal feed's "new object" detection is built on exactly that.
 */
export const OBJECT_UPSERT_SQL = (() => {
  const cols = OBJECT_COLUMNS.join(', ');
  const holes = OBJECT_COLUMNS.map(() => '?').join(', ');
  const sets = OBJECT_COLUMNS
    .filter((c) => c !== 'NORAD_CAT_ID' && c !== 'first_seen')
    .map((c) => `${c} = excluded.${c}`)
    .join(', ');
  return `INSERT INTO objects (${cols}) VALUES (${holes})
          ON CONFLICT(NORAD_CAT_ID) DO UPDATE SET ${sets}`;
})();

/**
 * D1 caps a single query at 100 bound parameters, so multi-row VALUES tuples
 * are out at 39 columns — one statement per row, submitted in batches.
 * 40 statements/batch keeps each round trip small enough to stay well inside
 * the subrequest and payload limits while still amortising the latency.
 */
export const BATCH_SIZE = 40;

export async function upsertObjects(db, valueRows) {
  let written = 0;
  for (let i = 0; i < valueRows.length; i += BATCH_SIZE) {
    const slice = valueRows.slice(i, i + BATCH_SIZE);
    await db.batch(slice.map((v) => db.prepare(OBJECT_UPSERT_SQL).bind(...v)));
    written += slice.length;
  }
  return written;
}

/* ── Groups ─────────────────────────────────────────────────────────────────
 *
 * Back-compat: the globe's 16 checkboxes fetch `?source=<src>&group=<slug>`,
 * and the Celestrak path serves curated group files. To make SPACE-TRACK a
 * drop-in source we reproduce the same slugs as SQL predicates over our own
 * mirror — so switching source changes where the TLEs come from and nothing
 * else in the UI.
 *
 * Two of these are *better* than the Celestrak equivalents rather than merely
 * equal, and it is worth being explicit about which:
 *
 *   - the four debris groups are `OBJECT_ID` prefix matches, so a fragment
 *     catalogued next year joins its family automatically;
 *   - `last-30-days` is a live date predicate rather than a snapshot.
 *
 * And two are weaker, and are labelled as approximations in the UI:
 *
 *   - `glo-ops`, because GLONASS payloads are named COSMOS nnnn and cannot be
 *     told from unrelated Russian objects by name — see the note below;
 *   - `sbas`, which is a small hand-listed set of augmentation payloads.
 *
 * NOTE ON CASE: Space-Track returns OBJECT_TYPE and RCS_SIZE upper-cased
 * ('PAYLOAD', 'ROCKET BODY', 'DEBRIS', 'MEDIUM'), which is what these
 * predicates match. The schema comments spell them in title case; the data does
 * not.
 */
export const GROUPS = {
  stations: {
    label: 'Space stations',
    where: `(NORAD_CAT_ID IN (25544, 48274, 54216, 55402)
             OR OBJECT_NAME LIKE 'ISS (%'
             OR OBJECT_NAME LIKE 'CSS (%'
             OR OBJECT_NAME LIKE 'TIANHE%'
             OR OBJECT_NAME LIKE 'PROGRESS-MS%'
             OR OBJECT_NAME LIKE 'SOYUZ-MS%'
             OR OBJECT_NAME LIKE 'TIANZHOU%'
             OR OBJECT_NAME LIKE 'SHENZHOU%'
             OR OBJECT_NAME LIKE 'CREW DRAGON%'
             OR OBJECT_NAME LIKE 'DRAGON CRS%'
             OR OBJECT_NAME LIKE 'CYGNUS%')`,
  },
  starlink:  { label: 'Starlink',  where: `OBJECT_NAME LIKE 'STARLINK%'` },
  oneweb:    { label: 'OneWeb',    where: `OBJECT_NAME LIKE 'ONEWEB%'` },
  qianfan:   { label: 'Qianfan',   where: `(OBJECT_NAME LIKE 'QIANFAN%' OR OBJECT_NAME LIKE 'CHUTIAN%')` },
  hulianwang:{ label: 'Guowang',   where: `(OBJECT_NAME LIKE 'GUOWANG%' OR OBJECT_NAME LIKE 'SATNET%' OR OBJECT_NAME LIKE 'HULIANWANG%')` },

  'gps-ops': { label: 'GPS',       where: `OBJECT_NAME LIKE 'NAVSTAR%' AND OBJECT_TYPE = 'PAYLOAD'` },
  // GLONASS payloads are catalogued as COSMOS nnnn — indistinguishable by name
  // from hundreds of unrelated Russian objects. They are identified instead by
  // their orbit signature, which nothing else occupies: a 675.7-minute period
  // at 64.8° inclination. Approximate by construction; labelled as such.
  'glo-ops': {
    label: 'GLONASS (derived)',
    approximate: true,
    where: `OBJECT_TYPE = 'PAYLOAD' AND COUNTRY_CODE = 'CIS'
            AND PERIOD BETWEEN 670 AND 682 AND INCLINATION BETWEEN 63 AND 66`,
  },
  galileo:   { label: 'Galileo',   where: `OBJECT_NAME LIKE 'GSAT0%'` },
  beidou:    { label: 'BeiDou',    where: `OBJECT_NAME LIKE 'BEIDOU%'` },
  irnss:     { label: 'NavIC',     where: `(OBJECT_NAME LIKE 'IRNSS%' OR OBJECT_NAME LIKE 'NVS-%')` },
  sbas: {
    label: 'SBAS (approx.)',
    approximate: true,
    where: `(OBJECT_NAME LIKE 'QZS-%' OR OBJECT_NAME LIKE 'GAGAN%'
             OR OBJECT_NAME LIKE 'MSAS%' OR OBJECT_NAME LIKE 'INMARSAT 3-F%'
             OR OBJECT_NAME LIKE 'INMARSAT 4-F%' OR OBJECT_NAME LIKE 'SES-15%'
             OR OBJECT_NAME LIKE 'GALAXY 30%' OR OBJECT_NAME LIKE 'EUTELSAT 5%'
             OR OBJECT_NAME LIKE 'ASTRA 5B%')`,
  },

  // The NEXT constellation only — the launch-date floor excludes the original
  // 1997-2002 block, which shares the IRIDIUM name prefix.
  'iridium-next': {
    label: 'Iridium NEXT',
    where: `OBJECT_NAME LIKE 'IRIDIUM%' AND OBJECT_TYPE = 'PAYLOAD'
            AND LAUNCH_DATE >= '2017-01-01'`,
  },

  weather: {
    label: 'Weather',
    where: `OBJECT_TYPE = 'PAYLOAD' AND (
              OBJECT_NAME LIKE 'NOAA%' OR OBJECT_NAME LIKE 'METOP%'
              OR OBJECT_NAME LIKE 'FENGYUN%' OR OBJECT_NAME LIKE 'METEOR%'
              OR OBJECT_NAME LIKE 'DMSP%' OR OBJECT_NAME LIKE 'SUOMI%'
              OR OBJECT_NAME LIKE 'METEOSAT%' OR OBJECT_NAME LIKE 'GOES%')`,
  },
  resource: {
    label: 'Earth resources',
    where: `OBJECT_TYPE = 'PAYLOAD' AND (
              OBJECT_NAME LIKE 'LANDSAT%' OR OBJECT_NAME LIKE 'SENTINEL%'
              OR OBJECT_NAME LIKE 'TERRA%' OR OBJECT_NAME LIKE 'AQUA%'
              OR OBJECT_NAME LIKE 'SPOT %' OR OBJECT_NAME LIKE 'RESOURCESAT%'
              OR OBJECT_NAME LIKE 'CBERS%' OR OBJECT_NAME LIKE 'KANOPUS%'
              OR OBJECT_NAME LIKE 'RADARSAT%' OR OBJECT_NAME LIKE 'PLEIADES%'
              OR OBJECT_NAME LIKE 'WORLDVIEW%' OR OBJECT_NAME LIKE 'GEOEYE%'
              OR OBJECT_NAME LIKE 'ICEYE%' OR OBJECT_NAME LIKE 'CAPELLA%')`,
  },
  // Space-Track's own Geosynchronous Report definition.
  geo: {
    label: 'Geosynchronous',
    where: `OBJECT_TYPE = 'PAYLOAD' AND PERIOD BETWEEN 1430 AND 1450`,
  },
  'last-30-days': {
    label: 'Launched in the last 30 days',
    where: `LAUNCH_DATE >= date('now', '-30 day')`,
  },

  // Debris families by international designator — see debrisFamilyOf().
  'cosmos-2251-debris': { label: 'Cosmos 2251 debris', where: `OBJECT_TYPE = 'DEBRIS' AND OBJECT_ID LIKE '1993-036%'` },
  'cosmos-1408-debris': { label: 'Cosmos 1408 debris', where: `OBJECT_TYPE = 'DEBRIS' AND OBJECT_ID LIKE '1982-092%'` },
  'fengyun-1c-debris':  { label: 'Fengyun-1C debris',  where: `OBJECT_TYPE = 'DEBRIS' AND OBJECT_ID LIKE '1999-025%'` },
  'iridium-33-debris':  { label: 'Iridium 33 debris',  where: `OBJECT_TYPE = 'DEBRIS' AND OBJECT_ID LIKE '1997-051%'` },

  // plan 34 3.1 S12 — every currently-operating payload. The wrapper query in
  // buildGroupArtifacts() already ANDs in `DECAY_DATE IS NULL`, which is
  // Space-Track's own definition of "active", so no extra predicate narrows
  // this further — it is Celestrak's `active` group, just derived rather than
  // curated.
  active: { label: 'Active payloads', where: `OBJECT_TYPE = 'PAYLOAD'` },
  // Celestrak's `military` group is a small hand-curated list of named
  // programs (SDA/SSC "PRAETORIAN", SAR-Lupe, Sapphire, etc.) with no shared
  // orbit signature or name prefix, so it cannot be derived the way
  // `starlink`/`stations`/etc. are — approximate by construction, same as
  // `sbas`. List taken from a live Celestrak GROUP=military fetch
  // (2026-08-02); re-fetch and update if Celestrak's curated set changes.
  military: {
    label: 'Military (approx.)',
    approximate: true,
    where: `OBJECT_NAME IN (
              'SAR-LUPE 2', 'SAPPHIRE', 'VICTUS HAZE PUMA',
              'PRAETORIAN SDA_601', 'PRAETORIAN SDA_602', 'PRAETORIAN SDA_603',
              'PRAETORIAN SDA_604', 'PRAETORIAN SDA_605', 'PRAETORIAN SDA_606',
              'PRAETORIAN SDA_607', 'PRAETORIAN SDA_608', 'PRAETORIAN SDA_609',
              'PRAETORIAN SDA_610', 'PRAETORIAN SDA_611', 'PRAETORIAN SDA_612',
              'PRAETORIAN SDA_613', 'PRAETORIAN SDA_614', 'PRAETORIAN SDA_615',
              'PRAETORIAN SDA_616', 'PRAETORIAN SDA_617', 'PRAETORIAN SDA_618',
              'PRAETORIAN SDA_619', 'PRAETORIAN SDA_620', 'PRAETORIAN SDA_621'
            )`,
  },
};

/** R2 key for a group's 3LE bundle. */
export const groupKey = (slug) => `tle/spacetrack/${slug}.txt`;

/* ── D1 paging ──────────────────────────────────────────────────────────────
 * Every catalog-wide read is paged. Starlink alone is ~8,000 rows and D1 caps
 * the size of a single result set, so an unpaged SELECT would work in
 * development and truncate in production — the worst failure mode available.
 */
const PAGE = 1000;

async function* pagedRows(db, sql, params = []) {
  for (let offset = 0; ; offset += PAGE) {
    const stmt = db.prepare(`${sql} LIMIT ${PAGE} OFFSET ${offset}`);
    const { results } = await (params.length ? stmt.bind(...params) : stmt).all();
    if (!results || results.length === 0) return;
    for (const r of results) yield r;
    if (results.length < PAGE) return;
  }
}

/**
 * Render rows as a 3LE bundle in Celestrak's exact layout: bare name line, then
 * lines 1 and 2.
 *
 * **Not** TLE_LINE0 verbatim. Space-Track's line 0 carries the 3LE '0 ' prefix
 * ("0 VANGUARD 1"); the frontend's parseTLE takes lines in threes and uses the
 * first as the display name, so shipping the prefix would label every object
 * "0 SOMETHING" on the globe. OBJECT_NAME is already the clean form.
 */
export function toThreeLine(rows) {
  const out = [];
  for (const r of rows) {
    if (!r.TLE_LINE1 || !r.TLE_LINE2) continue;
    out.push(r.OBJECT_NAME || String(r.NORAD_CAT_ID), r.TLE_LINE1, r.TLE_LINE2);
  }
  return out.length ? out.join('\n') + '\n' : '';
}

/**
 * Regenerate the R2 group bundles. This is the artifact the globe actually
 * reads — a flat object GET, never a database query on the hot path.
 *
 * @returns {Promise<Record<string, number>>} slug → object count
 */
export async function buildGroupArtifacts(env, { slugs = Object.keys(GROUPS) } = {}) {
  const counts = {};
  for (const slug of slugs) {
    const g = GROUPS[slug];
    if (!g) continue;
    const sql = `SELECT NORAD_CAT_ID, OBJECT_NAME, TLE_LINE1, TLE_LINE2
                 FROM objects
                 WHERE DECAY_DATE IS NULL AND TLE_LINE1 IS NOT NULL AND (${g.where})
                 ORDER BY NORAD_CAT_ID`;
    const rows = [];
    for await (const r of pagedRows(env.ORBIT_DB, sql)) rows.push(r);

    const body = toThreeLine(rows);
    counts[slug] = rows.length;

    // An empty bundle is never written. If a predicate breaks — a rename
    // upstream, a bad migration — the previous good file must stay in place so
    // the globe degrades to stale data rather than to a blank sky.
    if (!body) continue;

    await env.ORBIT_R2.put(groupKey(slug), body, {
      httpMetadata: { contentType: 'text/plain; charset=utf-8' },
      customMetadata: { citation: CITATION, generated: new Date().toISOString() },
    });
  }
  return counts;
}

/** The whole on-orbit catalog as one bundle. Daily only — it is ~5 MB. */
export async function buildFullCatalog(env) {
  const sql = `SELECT NORAD_CAT_ID, OBJECT_NAME, TLE_LINE1, TLE_LINE2
               FROM objects
               WHERE DECAY_DATE IS NULL AND TLE_LINE1 IS NOT NULL
               ORDER BY NORAD_CAT_ID`;
  const parts = [];
  let n = 0;
  for await (const r of pagedRows(env.ORBIT_DB, sql)) { parts.push(r); n++; }
  const body = toThreeLine(parts);
  if (body) {
    await env.ORBIT_R2.put('tle/spacetrack/all.txt', body, {
      httpMetadata: { contentType: 'text/plain; charset=utf-8' },
      customMetadata: { citation: CITATION, generated: new Date().toISOString() },
    });
  }
  return n;
}

/* ── Summary + feed artifacts ───────────────────────────────────────────── */

async function tally(db, sql) {
  const { results } = await db.prepare(sql).all();
  return results || [];
}

/**
 * `catalog/summary.json` — the counts the HUD shows without touching D1.
 * Aggregates run in SQLite over indexed columns, so this is a handful of
 * grouped scans rather than a catalog download.
 */
export async function buildSummary(env, { groups = null } = {}) {
  const live = 'WHERE DECAY_DATE IS NULL';
  const [total, byType, byRegime, byCountry, byOperator, lastIngest] = await Promise.all([
    env.ORBIT_DB.prepare(`SELECT COUNT(*) AS n FROM objects ${live}`).first(),
    tally(env.ORBIT_DB, `SELECT OBJECT_TYPE AS k, COUNT(*) AS n FROM objects ${live} GROUP BY k ORDER BY n DESC`),
    tally(env.ORBIT_DB, `SELECT regime AS k, COUNT(*) AS n FROM objects ${live} GROUP BY k ORDER BY n DESC`),
    tally(env.ORBIT_DB, `SELECT COUNTRY_CODE AS k, COUNT(*) AS n FROM objects ${live} GROUP BY k ORDER BY n DESC LIMIT 25`),
    tally(env.ORBIT_DB, `SELECT operator AS k, COUNT(*) AS n FROM objects ${live} AND operator IS NOT NULL GROUP BY k ORDER BY n DESC`),
    env.ORBIT_DB.prepare(`SELECT MAX(updated_at) AS t FROM objects`).first(),
  ]);

  const summary = {
    generated_at: new Date().toISOString(),
    citation: CITATION,
    tracked: total ? total.n : 0,
    last_elset_ingest: lastIngest ? lastIngest.t : null,
    by_type: Object.fromEntries(byType.map((r) => [r.k || 'UNKNOWN', r.n])),
    by_regime: Object.fromEntries(byRegime.map((r) => [r.k || 'UNKNOWN', r.n])),
    by_country: byCountry.map((r) => ({ code: r.k, n: r.n })),
    by_operator: byOperator.map((r) => ({
      id: r.k, label: OPERATOR_LABELS[r.k] || r.k, n: r.n,
      derived: true,   // operator is OUR inference — see operators.js
    })),
    groups: groups || undefined,
    group_labels: Object.fromEntries(
      Object.entries(GROUPS).map(([k, g]) => [k, g.label])),
    approximate_groups: Object.entries(GROUPS)
      .filter(([, g]) => g.approximate).map(([k]) => k),
  };

  await env.ORBIT_R2.put('catalog/summary.json', JSON.stringify(summary), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });
  return summary;
}

/** `feed/latest.json` — the signal feed wave 4 renders; written from wave 2 on. */
export async function buildFeed(env, { limit = 200 } = {}) {
  const { results } = await env.ORBIT_DB
    .prepare(`SELECT ts, kind, NORAD_CAT_ID, title, detail
              FROM events ORDER BY ts DESC, id DESC LIMIT ?`)
    .bind(limit)
    .all();

  const feed = {
    generated_at: new Date().toISOString(),
    citation: CITATION,
    events: (results || []).map((r) => ({
      ts: r.ts,
      kind: r.kind,
      norad: r.NORAD_CAT_ID,
      title: r.title,
      detail: r.detail ? safeParse(r.detail) : null,
    })),
  };

  await env.ORBIT_R2.put('feed/latest.json', JSON.stringify(feed), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });
  return feed;
}

function safeParse(s) {
  try { return JSON.parse(s); } catch (_) { return s; }
}

/**
 * `catalog/analytics.json` (plan 33 wave 7) — the launch-history breakdowns for
 * the ANALYTICS panel: decade, launch site and debris family are all free —
 * `launch_year` and `debris_family` are already derived columns on `objects`,
 * and `SITE` is a native GP field, so every query below is one indexed GROUP BY
 * over the mirror we already hold, same as `buildSummary`.
 *
 * Unlike `by_type`/`by_regime` in the summary, these run over the WHOLE
 * catalog (decayed included) rather than DECAY_DATE IS NULL: "how many things
 * launched in the 1980s" is a historical count, and excluding everything that
 * has since deorbited would undercount every decade before the 2010s by most
 * of its total — the opposite of what "on orbit right now" means in the
 * summary panel.
 */
/**
 * Fixed-width SQL bucket count over an expression already indexed or cheap to
 * scan. Mirrors `public/shared/charts.js`'s `bin()` edge rule so the two stay
 * consistent even though they run in different places (SQL here, over rows
 * already in memory there): a value exactly on `max` lands in the LAST
 * bucket via `MIN(..., count-1)`, not an overflow bucket one past the end.
 */
async function binQuery(db, { expr, where, min, max, width }) {
  const count = Math.max(1, Math.ceil((max - min) / width));
  const { results } = await db.prepare(`
    SELECT MIN(${count - 1}, CAST((${expr} - ?) / ? AS INTEGER)) AS bucket, COUNT(*) AS n
    FROM objects
    WHERE ${where} AND ${expr} IS NOT NULL AND ${expr} >= ? AND ${expr} <= ?
    GROUP BY bucket ORDER BY bucket ASC
  `).bind(min, width, min, max).all();
  const byBucket = new Map((results || []).map((r) => [r.bucket, r.n]));
  const bins = [];
  for (let i = 0; i < count; i++) {
    bins.push({ min: min + i * width, max: Math.min(max, min + (i + 1) * width), n: byBucket.get(i) || 0 });
  }
  return bins;
}

/**
 * `catalog/analytics.json` (plan 33 wave 7, extended plan 38 A1) — the launch-
 * history AND on-orbit-distribution breakdowns for the ANALYTICS panel.
 *
 * **Historical vs on-orbit-now — the split this artifact must keep straight:**
 * `launches_by_decade`/`launches_by_year`/`regime_by_year`/`operator_by_year`/
 * `cohort_on_orbit`/`decays_by_month`/`top_launch_sites`/`debris_families`/
 * `country_by_decade` all run over the WHOLE catalog (decayed included) —
 * "how many things launched in the 1980s" is a historical count, and
 * excluding everything that has since deorbited would undercount every decade
 * before the 2010s by most of its total. `by_type`/`by_regime`/`rcs_sizes`/
 * `altitude_bins`/`inclination_bins` are the opposite: they filter
 * `DECAY_DATE IS NULL` because "what's up there now" is an on-orbit-now
 * question, same discipline as `buildSummary`. Mixing these two up is the
 * easiest way for this artifact to become quietly wrong — see the plan's
 * Risks table.
 */
export async function buildAnalytics(env) {
  const live = 'WHERE DECAY_DATE IS NULL';
  const [
    total, byDecade, byYear, bySite, byFamily, byCountryDecade,
    byType, byRegime, regimeByYear, rcsSizes, decaysByMonth,
    cohortLaunched, cohortAlive, operatorByYear,
  ] = await Promise.all([
    env.ORBIT_DB.prepare(`SELECT COUNT(*) AS n FROM objects ${live}`).first(),
    tally(env.ORBIT_DB, `
      SELECT (launch_year / 10) * 10 AS k, COUNT(*) AS n
      FROM objects WHERE launch_year IS NOT NULL
      GROUP BY k ORDER BY k ASC`),
    tally(env.ORBIT_DB, `
      SELECT launch_year AS k, COUNT(*) AS n
      FROM objects WHERE launch_year IS NOT NULL
      GROUP BY k ORDER BY k ASC`),
    tally(env.ORBIT_DB, `
      SELECT SITE AS k, COUNT(*) AS n FROM objects
      WHERE SITE IS NOT NULL AND SITE != ''
      GROUP BY k ORDER BY n DESC LIMIT 15`),
    tally(env.ORBIT_DB, `
      SELECT debris_family AS k, COUNT(*) AS n FROM objects
      WHERE debris_family IS NOT NULL
      GROUP BY k ORDER BY n DESC LIMIT 15`),
    tally(env.ORBIT_DB, `
      SELECT COUNTRY_CODE AS country, (launch_year / 10) * 10 AS decade, COUNT(*) AS n
      FROM objects WHERE launch_year IS NOT NULL AND COUNTRY_CODE IS NOT NULL
      GROUP BY country, decade`),
    tally(env.ORBIT_DB, `SELECT OBJECT_TYPE AS k, COUNT(*) AS n FROM objects ${live} GROUP BY k ORDER BY n DESC`),
    tally(env.ORBIT_DB, `SELECT regime AS k, COUNT(*) AS n FROM objects ${live} GROUP BY k ORDER BY n DESC`),
    tally(env.ORBIT_DB, `
      SELECT launch_year AS year, regime AS k, COUNT(*) AS n FROM objects
      ${live} AND launch_year IS NOT NULL AND regime IS NOT NULL
      GROUP BY year, k`),
    tally(env.ORBIT_DB, `SELECT RCS_SIZE AS k, COUNT(*) AS n FROM objects ${live} GROUP BY k ORDER BY n DESC`),
    tally(env.ORBIT_DB, `
      SELECT substr(DECAY_DATE, 1, 7) AS k, COUNT(*) AS n FROM objects
      WHERE DECAY_DATE IS NOT NULL GROUP BY k ORDER BY k ASC`),
    tally(env.ORBIT_DB, `
      SELECT (launch_year / 10) * 10 AS decade, COUNT(*) AS n
      FROM objects WHERE launch_year IS NOT NULL GROUP BY decade`),
    tally(env.ORBIT_DB, `
      SELECT (launch_year / 10) * 10 AS decade, COUNT(*) AS n
      FROM objects WHERE launch_year IS NOT NULL AND DECAY_DATE IS NULL GROUP BY decade`),
    tally(env.ORBIT_DB, `
      SELECT launch_year AS year, operator AS k, COUNT(*) AS n FROM objects
      WHERE launch_year IS NOT NULL AND operator IS NOT NULL
      GROUP BY year, k`),
  ]);

  const [altitudeBins, inclinationBins] = await Promise.all([
    binQuery(env.ORBIT_DB, {
      expr: '(APOAPSIS + PERIAPSIS) / 2', where: live.replace(/^WHERE /, ''),
      min: 0, max: 40000, width: 1000,
    }),
    binQuery(env.ORBIT_DB, {
      expr: 'INCLINATION', where: live.replace(/^WHERE /, ''),
      min: 0, max: 180, width: 10,
    }),
  ]);

  // Site names come from launch_sites (plan 38 task 2) — a LEFT JOIN would
  // need a second round-trip either way, and the table is ~60 rows, so one
  // extra SELECT + an in-memory join is simpler than rewriting bySite's query.
  const { results: siteNames } = await env.ORBIT_DB
    .prepare('SELECT SITE_CODE, LAUNCH_SITE FROM launch_sites').all();
  const nameOf = new Map((siteNames || []).map((r) => [r.SITE_CODE, r.LAUNCH_SITE]));

  // Top 8 countries by all-time total drive which rows the by-decade matrix
  // carries — a full COUNTRY_CODE x decade grid is mostly zeroes and the panel
  // has room for a handful of series, not the ~70 registering states on file.
  const totals = new Map();
  for (const r of byCountryDecade) totals.set(r.country, (totals.get(r.country) || 0) + r.n);
  const topCountries = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c]) => c);
  const decades = [...new Set(byDecade.map((r) => r.k))].sort((a, b) => a - b);
  const byCountryMap = new Map();
  for (const r of byCountryDecade) {
    if (!topCountries.includes(r.country)) continue;
    if (!byCountryMap.has(r.country)) byCountryMap.set(r.country, {});
    byCountryMap.get(r.country)[r.decade] = r.n;
  }

  // regime_by_year: one row per year, one column per regime, zero-filled —
  // same "no missing decade" discipline as country_by_decade below.
  const years = [...new Set(byYear.map((r) => r.k))].sort((a, b) => a - b);
  const regimeByYearMap = new Map();
  for (const r of regimeByYear) {
    if (!regimeByYearMap.has(r.year)) regimeByYearMap.set(r.year, {});
    regimeByYearMap.get(r.year)[r.k] = r.n;
  }

  // operator_by_year: top operators overall (by all-time launch count) get
  // their own year-by-year series; everything else collapses into `other` so
  // the chart has a handful of labelled series instead of the long tail of
  // every operator that ever launched one satellite. `operator` is OUR
  // inference (operators.js), never authoritative — badge it wherever shown.
  const operatorTotals = new Map();
  for (const r of operatorByYear) operatorTotals.set(r.k, (operatorTotals.get(r.k) || 0) + r.n);
  const topOperators = [...operatorTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([o]) => o);
  const operatorByYearMap = new Map();
  for (const r of operatorByYear) {
    if (!operatorByYearMap.has(r.year)) operatorByYearMap.set(r.year, { top: {}, other: 0 });
    const bucket = operatorByYearMap.get(r.year);
    if (topOperators.includes(r.k)) bucket.top[r.k] = r.n;
    else bucket.other += r.n;
  }

  // cohort_on_orbit: of everything launched in decade D, how many are still up
  // — a survival stat, not a timeline. Both queries share the same decade
  // buckets so a decade with launches but zero survivors still emits a 0 row
  // rather than disappearing (which would read as "no launches").
  const launchedByDecade = new Map(cohortLaunched.map((r) => [r.decade, r.n]));
  const aliveByDecade = new Map(cohortAlive.map((r) => [r.decade, r.n]));
  const cohortDecades = [...new Set([...launchedByDecade.keys(), ...aliveByDecade.keys()])].sort((a, b) => a - b);

  const analytics = {
    generated_at: new Date().toISOString(),
    citation: CITATION,
    tracked: total ? total.n : 0,
    by_type: Object.fromEntries(byType.map((r) => [r.k || 'UNKNOWN', r.n])),
    by_regime: Object.fromEntries(byRegime.map((r) => [r.k || 'UNKNOWN', r.n])),
    launches_by_decade: byDecade.map((r) => ({ decade: r.k, n: r.n })),
    launches_by_year: byYear.map((r) => ({ year: r.k, n: r.n })),
    operator_by_year: [...operatorByYearMap.entries()].sort((a, b) => a[0] - b[0])
      .map(([year, { top, other }]) => ({ year, top, other, derived: true })),
    regime_by_year: years.map((year) => ({
      year,
      leo: regimeByYearMap.get(year)?.LEO || 0,
      meo: regimeByYearMap.get(year)?.MEO || 0,
      geo: regimeByYearMap.get(year)?.GEO || 0,
      heo: regimeByYearMap.get(year)?.HEO || 0,
    })),
    cohort_on_orbit: cohortDecades.map((decade) => ({
      decade,
      launched: launchedByDecade.get(decade) || 0,
      still_on_orbit: aliveByDecade.get(decade) || 0,
    })),
    top_launch_sites: bySite.map((r) => ({ site: r.k, name: nameOf.get(r.k) || null, n: r.n })),
    debris_families: byFamily.map((r) => ({ family: r.k, n: r.n })),
    country_by_decade: {
      decades,
      countries: topCountries.map((c) => ({
        country: c,
        by_decade: decades.map((d) => byCountryMap.get(c)?.[d] || 0),
      })),
    },
    rcs_sizes: Object.fromEntries(rcsSizes.map((r) => [r.k || 'UNKNOWN', r.n])),
    altitude_bins: altitudeBins,
    inclination_bins: inclinationBins,
    // events has no history before the ingest started running; DECAY_DATE on
    // objects does, so decays_by_month sources from there, not from events.
    decays_by_month: decaysByMonth.map((r) => ({ month: r.k, n: r.n })),
  };

  await env.ORBIT_R2.put('catalog/analytics.json', JSON.stringify(analytics), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });
  return analytics;
}

/* ── Events ─────────────────────────────────────────────────────────────── */

/**
 * Space-Track has no "what changed" endpoint, so every event is derived by
 * diffing an ingest against what we already held. The UNIQUE(kind, NORAD, ts)
 * constraint makes re-running an ingest idempotent — INSERT OR IGNORE turns a
 * replay into a no-op rather than a duplicated feed.
 */
export async function recordEvents(db, events) {
  if (!events.length) return 0;
  const sql = `INSERT OR IGNORE INTO events (ts, kind, NORAD_CAT_ID, title, detail)
               VALUES (?, ?, ?, ?, ?)`;
  for (let i = 0; i < events.length; i += BATCH_SIZE) {
    const slice = events.slice(i, i + BATCH_SIZE);
    await db.batch(slice.map((e) => db.prepare(sql).bind(
      e.ts, e.kind, e.norad ?? null, e.title ?? null,
      e.detail == null ? null : JSON.stringify(e.detail))));
  }
  return events.length;
}
