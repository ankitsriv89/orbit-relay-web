// Cloudflare Pages Function — catalog search and faceting for /spacetrack/.
//
//   GET /api/search?q=vanguard
//   GET /api/search?type=DEBRIS&country=CIS&regime=LEO&era=1957-1969&limit=200
//   GET /api/search?facets=1                 (counts only, no rows)
//
// Filters are the plan's Tier A/B/C dimensions: object type · country · orbit
// regime · launch era · operator. Every one of them is a column on `objects`
// with an index behind it, so this is a handful of indexed scans rather than a
// catalog walk.
//
// `operator` is a derived column — our inference from OBJECT_NAME, not a
// Space-Track field — and responses say so, because a filter that looks
// authoritative and is not is worse than one that is absent.

import { json, preflight, requireDb, withCitation, clamp, cached } from './_catalog.js';

const MAX_LIMIT     = 500;
const DEFAULT_LIMIT = 100;

// Launch eras, as buckets rather than free-form years: the point is browsing a
// catalog spanning 1957 to now, and "Space Race" is a more useful handle than
// a year spinner. Explicit year_from / year_to still work for anything else.
const ERAS = {
  '1957-1969': [1957, 1969],   // Space Race
  '1970-1989': [1970, 1989],   // Cold War operations
  '1990-2009': [1990, 2009],   // commercial era
  '2010-2019': [2010, 2019],   // smallsat era
  '2020-':     [2020, 9999],   // megaconstellations
};

const COLUMNS = `NORAD_CAT_ID, OBJECT_NAME, OBJECT_ID, OBJECT_TYPE, COUNTRY_CODE,
         RCS_SIZE, LAUNCH_DATE, DECAY_DATE, PERIOD, INCLINATION,
         APOAPSIS, PERIAPSIS, regime, launch_year, operator, debris_family`;

export async function onRequest(context) {
  const { request } = context;
  if (request.method === 'OPTIONS') return preflight();
  return cached(context, () => handle(context));
}

async function handle(context) {
  const { request, env } = context;

  const unbound = requireDb(env);
  if (unbound) return unbound;

  const url = new URL(request.url);
  const p = (k) => (url.searchParams.get(k) || '').trim();

  // Built as {param: [clause, ...args]} rather than flat arrays so facet mode
  // can drop one dimension's own condition when computing that dimension's
  // counts — see the `facet()` helper below. Everything that isn't tied to a
  // single filter param (search text, decayed, era/year) lives under 'base'
  // and always applies.
  const whereByParam = { base: [] };
  const pushWhere = (param, clause, ...vals) => {
    (whereByParam[param] || (whereByParam[param] = [])).push([clause, vals]);
  };

  // Decayed objects are excluded unless asked for. They are most of the
  // difference between "what is up there" and "what has ever been catalogued",
  // and defaulting to the former is what every count on the page means.
  if (p('include_decayed') !== '1') pushWhere('base', 'DECAY_DATE IS NULL');

  const q = p('q');
  if (q) {
    if (/^\d+$/.test(q)) {
      // A bare number is a catalog number. Also matched against the name, so
      // searching "1408" still finds "COSMOS 1408".
      pushWhere('base', '(NORAD_CAT_ID = ? OR OBJECT_NAME LIKE ?)', Number.parseInt(q, 10), `%${q}%`);
    } else {
      // A contains-match on the name cannot use idx_objects_name — a leading
      // wildcard never can. That is accepted: the alternative is a prefix-only
      // search, and "starlink" would then miss "STARLINK-1234 DEB". The scan is
      // over ~28k rows of one indexed column, bounded by LIMIT.
      pushWhere('base', '(OBJECT_NAME LIKE ? OR OBJECT_ID LIKE ?)', `%${q}%`, `${q}%`);
    }
  }

  for (const [param, column] of [
    ['type', 'OBJECT_TYPE'], ['country', 'COUNTRY_CODE'], ['regime', 'regime'],
    ['operator', 'operator'], ['rcs', 'RCS_SIZE'], ['family', 'debris_family'],
  ]) {
    const v = p(param);
    if (v) pushWhere(param, `${column} = ?`, v);
  }

  const era = p('era');
  if (era) {
    const range = ERAS[era];
    if (!range) {
      return json({ error: `Unknown era. Use one of: ${Object.keys(ERAS).join(', ')}` },
                  { status: 400 });
    }
    pushWhere('era', 'launch_year BETWEEN ? AND ?', range[0], range[1]);
  }
  const from = Number.parseInt(p('year_from'), 10);
  const to   = Number.parseInt(p('year_to'), 10);
  if (Number.isInteger(from)) pushWhere('era', 'launch_year >= ?', from);
  if (Number.isInteger(to))   pushWhere('era', 'launch_year <= ?', to);

  // Builds a WHERE clause + bound args from every param's conditions except
  // `excludeParam` — used so a dimension's own facet counts (e.g. every
  // country, with its catalog-wide total) aren't collapsed by the country
  // filter the user picked, while still narrowing by every *other* active
  // filter (type, regime, operator, era, search). That's what makes the
  // filter panel cascade instead of each select only ever showing whatever
  // was already chosen.
  function buildClause(excludeParam) {
    const clauses = [];
    const boundArgs = [];
    for (const [param, entries] of Object.entries(whereByParam)) {
      if (param === excludeParam) continue;
      for (const [clause, vals] of entries) {
        clauses.push(clause);
        boundArgs.push(...vals);
      }
    }
    return { clause: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', args: boundArgs };
  }

  const { clause, args } = buildClause(null);

  // Sort keys are whitelisted, never interpolated from the query string — this
  // is the one place in the statement where a bound parameter cannot be used.
  const SORTS = {
    norad:   'NORAD_CAT_ID ASC',
    name:    'OBJECT_NAME COLLATE NOCASE ASC',
    launch:  'LAUNCH_DATE DESC',
    period:  'PERIOD ASC',
    apogee:  'APOAPSIS DESC',
  };
  const order = SORTS[p('sort')] || SORTS.norad;

  // An UNFILTERED facets request is answerable from the daily artifact, and
  // that is worth a special case because it was the most expensive call in the
  // product: five whole-catalog queries (the COUNT below plus four GROUP BYs),
  // each examining 27,381 of 31,944 rows because `DECAY_DATE IS NULL` selects
  // 86% of the table. It is also the most cacheable thing here — identical for
  // every caller, changing once a day — so it should not touch D1 at all.
  //
  // Only the unfiltered form: the artifact holds whole-catalog totals, so a
  // request carrying filters still has to ask D1, and falls through below.
  // include_decayed=1 counts as a filter too — it asks a different question
  // than the artifact (which is built from DECAY_DATE IS NULL) answers, even
  // though it doesn't add a 'base' condition of its own.
  const isUnfiltered = p('include_decayed') !== '1'
    && Object.keys(whereByParam).every((param) => param === 'base');
  if (p('facets') === '1' && isUnfiltered) {
    const artifact = await readSummary(env);
    if (artifact) {
      return json(withCitation({
        total: artifact.tracked || 0,
        facets: {
          type:     tallyToRows(artifact.by_type),
          country:  tallyToRows(artifact.by_country),
          regime:   tallyToRows(artifact.by_regime),
          operator: tallyToRows(artifact.by_operator).filter((r) => r.key !== null),
        },
        operator_derived: true,
        eras: Object.keys(ERAS),
      }), { maxAge: 300 });
    }
  }

  const total = await env.ORBIT_DB
    .prepare(`SELECT COUNT(*) AS n FROM objects${clause}`).bind(...args).first();

  // Facet mode returns the breakdown without the rows — what the filter chips
  // need to show their counts, at a fraction of the payload. Each dimension
  // excludes its own filter param (see buildClause) so picking a country
  // narrows the type/regime/operator lists without collapsing the country
  // list down to the one already chosen — that's the cascade.
  if (p('facets') === '1') {
    const facet = (col, excludeParam) => {
      const scoped = buildClause(excludeParam);
      return env.ORBIT_DB.prepare(
        `SELECT ${col} AS k, COUNT(*) AS n FROM objects${scoped.clause} GROUP BY k ORDER BY n DESC LIMIT 40`
      ).bind(...scoped.args).all();
    };

    const [type, country, regime, operator] = await Promise.all([
      facet('OBJECT_TYPE', 'type'), facet('COUNTRY_CODE', 'country'),
      facet('regime', 'regime'), facet('operator', 'operator'),
    ]);
    return json(withCitation({
      total: total ? total.n : 0,
      facets: {
        type:     rows(type),
        country:  rows(country),
        regime:   rows(regime),
        operator: rows(operator).filter((r) => r.key !== null),
      },
      operator_derived: true,
      eras: Object.keys(ERAS),
    }), { maxAge: 300 });
  }

  const limit  = clamp(Number.parseInt(p('limit'), 10) || DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = Math.max(0, Number.parseInt(p('offset'), 10) || 0);

  // `tle=1` adds the two element-set lines so the caller can propagate the
  // result set directly. That is the whole point of the filters on /spacetrack/
  // — an arbitrary slice of the catalog rendered on the globe — and it is opt-in
  // because it roughly triples the row size and a list view has no use for it.
  // Decayed objects and objects awaiting a first elset have no lines; the
  // frontend skips those rather than the query hiding them.
  const columns = p('tle') === '1' ? `${COLUMNS}, TLE_LINE1, TLE_LINE2` : COLUMNS;

  const { results } = await env.ORBIT_DB
    .prepare(`SELECT ${columns} FROM objects${clause} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`)
    .bind(...args)
    .all();

  return json(withCitation({
    total: total ? total.n : 0,
    limit,
    offset,
    operator_derived: true,
    results: results || [],
  }), { maxAge: 60 });
}

const rows = (r) => (r.results || []).map((x) => ({ key: x.k, n: x.n }));

/**
 * `catalog/summary.json`, or null if it is missing/corrupt/unbound.
 *
 * Same read-through discipline as artifactOrDb(): a corrupt artifact must not
 * take the endpoint down, it just means the D1 path answers instead.
 */
async function readSummary(env) {
  if (!env || !env.ORBIT_R2) return null;
  try {
    const object = await env.ORBIT_R2.get('catalog/summary.json');
    if (!object) return null;
    const parsed = JSON.parse(await object.text());
    // Guard the shape: a partial artifact (the D1-fallback form summary.js
    // writes when it has not been built yet, which carries `stale: true` and
    // empty breakdowns) must not be served as a complete facet set. Also
    // reject a pre-fix artifact still sitting in R2 from before by_country/
    // by_operator were normalized to flat {key: n} objects — an old one has
    // by_country as an array of {code, n}, which tallyToRows() misreads as
    // NaN counts. Falling through to D1 here is what makes the shape fix take
    // effect on deploy, without waiting for the next daily ingest run to
    // overwrite the artifact.
    if (!parsed || parsed.stale || !parsed.by_type || !parsed.by_country
        || Array.isArray(parsed.by_country) || Array.isArray(parsed.by_operator)) {
      return null;
    }
    return parsed;
  } catch (_) {
    return null;
  }
}

/**
 * `{PAYLOAD: 18393, …}` → `[{key: 'PAYLOAD', n: 18393}, …]`, descending.
 *
 * The artifact stores each breakdown as an object keyed by value; the facets
 * response has always been an array of `{key, n}` sorted by count, and the
 * filter chips depend on both the shape and the order. LIMIT 40 matches the
 * D1 path below so the two forms cannot disagree on length.
 */
function tallyToRows(tally) {
  if (!tally) return [];
  return Object.entries(tally)
    .map(([key, n]) => ({ key: key === 'UNKNOWN' ? null : key, n }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 40);
}
