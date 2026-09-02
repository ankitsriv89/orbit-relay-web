// Cloudflare Pages Function — the object-profile encyclopedia index.
//
//   GET /api/objects?q=envisat
//   GET /api/objects?country=United States&type=Communications&limit=50
//   GET /api/objects?facets=1                 (counts only, no rows)
//   GET /api/objects?facets=1&country=China   (cascading facet counts)
//
// The read side of the `orbit-profiles` D1. Same envelope and the same
// buildClause(excludeParam) facet cascade as functions/api/search.js — so the
// /objects/ frontend (Task 9) reuses /spacetrack/'s patterns directly. The five
// dimensions each have an index on `profiles` (d1/profiles.sql).
//
// `operator_name` here is a SOURCED fact, but the endpoint still returns
// operator_derived: true because the object's *catalog* operator (objects.js in
// the other database) is our inference — the two must not be conflated in a UI.

import { json, preflight, clamp, cached } from './_catalog.js';
import { requireProfileDb } from './_profiles.js';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 60;

// The one place a bound parameter cannot be used, so it is a fixed whitelist and
// never interpolated from the query string.
const SORTS = {
  name: 'official_name COLLATE NOCASE ASC',
  norad: 'norad ASC',
  country: 'owner_country COLLATE NOCASE ASC, official_name COLLATE NOCASE ASC',
  type: 'mission_type COLLATE NOCASE ASC, official_name COLLATE NOCASE ASC',
};

const FILTERS = [
  ['country', 'owner_country'],
  ['type', 'mission_type'],
  ['operator', 'operator_name'],
  ['status', 'status'],
];

const COLUMNS = `norad, cospar, official_name, operator_name, owner_country,
  mission_type, status, prose_tier`;

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return preflight();
  return cached(context, () => handle(context));
}

async function handle(context) {
  const { request, env } = context;

  const unbound = requireProfileDb(env);
  if (unbound) return unbound;

  const url = new URL(request.url);
  const p = (k) => (url.searchParams.get(k) || '').trim();

  const whereByParam = { base: [] };
  const push = (param, clause, ...vals) => {
    (whereByParam[param] || (whereByParam[param] = [])).push([clause, vals]);
  };

  const q = p('q');
  if (q) push('base', '(official_name LIKE ? OR cospar LIKE ? OR operator_name LIKE ?)',
    `%${q}%`, `${q}%`, `%${q}%`);
  for (const [param, column] of FILTERS) {
    const v = p(param);
    if (v) push(param, `${column} = ?`, v);
  }

  const buildClause = (excludeParam) => {
    const clauses = [];
    const args = [];
    for (const [param, entries] of Object.entries(whereByParam)) {
      if (param === excludeParam) continue;
      for (const [clause, vals] of entries) { clauses.push(clause); args.push(...vals); }
    }
    return { clause: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', args };
  };

  const sortParam = p('sort');
  if (sortParam && !SORTS[sortParam]) {
    return json({ error: `Unknown sort. Use one of: ${Object.keys(SORTS).join(', ')}` },
                { status: 400 });
  }
  const order = SORTS[sortParam] || SORTS.name;

  const { clause, args } = buildClause(null);
  const total = await env.PROFILE_DB
    .prepare(`SELECT COUNT(*) AS n FROM profiles${clause}`).bind(...args).first();

  if (p('facets') === '1') {
    const [country, type, operator, status] = await Promise.all([
      facetCount(env, buildClause('country'), 'owner_country'),
      facetCount(env, buildClause('type'), 'mission_type'),
      facetCount(env, buildClause('operator'), 'operator_name'),
      facetCount(env, buildClause('status'), 'status'),
    ]);
    return json({
      total: total ? total.n : 0,
      facets: { country: rows(country), type: rows(type), operator: rows(operator), status: rows(status) },
      operator_derived: true,
    }, { maxAge: 3600 });
  }

  const limit = clamp(Number.parseInt(p('limit'), 10) || DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = Math.max(0, Number.parseInt(p('offset'), 10) || 0);

  const { results } = await env.PROFILE_DB
    .prepare(`SELECT ${COLUMNS} FROM profiles${clause} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`)
    .bind(...args)
    .all();

  return json({
    total: total ? total.n : 0,
    limit,
    offset,
    operator_derived: true,
    results: results || [],
  }, { maxAge: 600 });
}

const rows = (r) => (r.results || []).map((x) => ({ key: x.k, n: x.n }));

/**
 * One dimension's counts. `scoped` already excludes this dimension's own filter
 * (buildClause), so picking a country still lists every country while narrowing
 * type/operator/status by that country.
 */
function facetCount(env, scoped, col) {
  const where = scoped.clause
    ? `${scoped.clause} AND ${col} IS NOT NULL`
    : ` WHERE ${col} IS NOT NULL`;
  return env.PROFILE_DB
    .prepare(`SELECT ${col} AS k, COUNT(*) AS n FROM profiles${where} GROUP BY k ORDER BY n DESC LIMIT 60`)
    .bind(...scoped.args)
    .all();
}
