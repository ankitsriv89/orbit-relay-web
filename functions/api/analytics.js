// Cloudflare Pages Function — the launch-history dashboard for /spacetrack/.
//
//   GET /api/analytics
//
// This is a flat R2 read of `catalog/analytics.json`, which the daily ingest
// regenerates (plan 33 wave 7): launches by decade, top launch sites, debris
// family sizes and a country-by-decade matrix for the top 8 registering
// states. Same discipline as summary.js — the aggregates run over the whole
// catalog (decayed included), because "how many things launched in the
// 1980s" is a historical count, not an on-orbit-now one, so a decade total
// should not shrink every time something from it reenters.
//
// Falls back to counting in D1 when the artifact is missing — the state
// between applying the schema and the first daily run.

import { preflight, withCitation, artifactOrDb } from './_catalog.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return preflight();

  return artifactOrDb(env, 'catalog/analytics.json', 3600, async () => {
    const { results: byDecade } = await env.ORBIT_DB.prepare(`
      SELECT (launch_year / 10) * 10 AS k, COUNT(*) AS n
      FROM objects WHERE launch_year IS NOT NULL
      GROUP BY k ORDER BY k ASC`).all();

    return withCitation({
      generated_at: new Date().toISOString(),
      launches_by_decade: (byDecade || []).map((r) => ({ decade: r.k, n: r.n })),
      // The artifact carries more than this — launch sites, debris families and
      // the country matrix. Say plainly that this is the reduced form rather
      // than letting the page render a partial dashboard as if it were complete.
      top_launch_sites: [],
      debris_families: [],
      country_by_decade: { decades: [], countries: [] },
      stale: true,
      note: 'Analytics artifact not built yet — partial counts from D1.',
    });
  });
}
