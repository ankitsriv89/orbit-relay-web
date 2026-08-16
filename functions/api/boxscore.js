// Cloudflare Pages Function — per-country boxscore stats (plan 33 wave 4).
//
//   GET /api/boxscore
//
// A flat read of the `boxscore` table, refreshed daily by ingestBoxscore(),
// which replaces the whole table each run (122 rows, no delta cursor — a
// country dropping out of the report should drop out of ours). Small enough
// that this reads D1 directly rather than needing an R2 artifact.

import { json, preflight, requireDb, withCitation, cached } from './_catalog.js';

const SQL = `
  SELECT COUNTRY, SPADOC_CD, ORBITAL_PAYLOAD_COUNT, ORBITAL_ROCKET_BODY_COUNT,
         ORBITAL_DEBRIS_COUNT, ORBITAL_TOTAL_COUNT, DECAYED_TOTAL_COUNT,
         COUNTRY_TOTAL, updated_at
  FROM boxscore
  ORDER BY COUNTRY_TOTAL DESC`;

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return preflight();
  return cached(context, () => handle(context));
}

async function handle(context) {
  const { env } = context;

  const unbound = requireDb(env);
  if (unbound) return unbound;

  const { results } = await env.ORBIT_DB.prepare(SQL).all();
  const countries = results || [];

  return json(withCitation({
    generated_at: countries[0] ? countries[0].updated_at : null,
    countries,
  }), { maxAge: 900 });
}
