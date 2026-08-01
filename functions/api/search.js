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

import { json, preflight, requireDb, withCitation, clamp } from './_catalog.js';

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
  const { request, env } = context;
  if (request.method === 'OPTIONS') return preflight();

  const unbound = requireDb(env);
  if (unbound) return unbound;

  const url = new URL(request.url);
  const p = (k) => (url.searchParams.get(k) || '').trim();

  const where = [];
  const args  = [];

  // Decayed objects are excluded unless asked for. They are most of the
  // difference between "what is up there" and "what has ever been catalogued",
  // and defaulting to the former is what every count on the page means.
  if (p('include_decayed') !== '1') where.push('DECAY_DATE IS NULL');

  const q = p('q');
  if (q) {
    if (/^\d+$/.test(q)) {
      // A bare number is a catalog number. Also matched against the name, so
      // searching "1408" still finds "COSMOS 1408".
      where.push('(NORAD_CAT_ID = ? OR OBJECT_NAME LIKE ?)');
      args.push(Number.parseInt(q, 10), `%${q}%`);
    } else {
      // A contains-match on the name cannot use idx_objects_name — a leading
      // wildcard never can. That is accepted: the alternative is a prefix-only
      // search, and "starlink" would then miss "STARLINK-1234 DEB". The scan is
      // over ~28k rows of one indexed column, bounded by LIMIT.
      where.push('(OBJECT_NAME LIKE ? OR OBJECT_ID LIKE ?)');
      args.push(`%${q}%`, `${q}%`);
    }
  }

  for (const [param, column] of [
    ['type', 'OBJECT_TYPE'], ['country', 'COUNTRY_CODE'], ['regime', 'regime'],
    ['operator', 'operator'], ['rcs', 'RCS_SIZE'], ['family', 'debris_family'],
  ]) {
    const v = p(param);
    if (v) { where.push(`${column} = ?`); args.push(v); }
  }

  const era = p('era');
  if (era) {
    const range = ERAS[era];
    if (!range) {
      return json({ error: `Unknown era. Use one of: ${Object.keys(ERAS).join(', ')}` },
                  { status: 400 });
    }
    where.push('launch_year BETWEEN ? AND ?');
    args.push(range[0], range[1]);
  }
  const from = Number.parseInt(p('year_from'), 10);
  const to   = Number.parseInt(p('year_to'), 10);
  if (Number.isInteger(from)) { where.push('launch_year >= ?'); args.push(from); }
  if (Number.isInteger(to))   { where.push('launch_year <= ?'); args.push(to); }

  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';

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

  const total = await env.ORBIT_DB
    .prepare(`SELECT COUNT(*) AS n FROM objects${clause}`).bind(...args).first();

  // Facet mode returns the breakdown without the rows — what the filter chips
  // need to show their counts, at a fraction of the payload.
  if (p('facets') === '1') {
    const facet = (col) => env.ORBIT_DB.prepare(
      `SELECT ${col} AS k, COUNT(*) AS n FROM objects${clause} GROUP BY k ORDER BY n DESC LIMIT 40`
    ).bind(...args).all();

    const [type, country, regime, operator] = await Promise.all([
      facet('OBJECT_TYPE'), facet('COUNTRY_CODE'), facet('regime'), facet('operator'),
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
