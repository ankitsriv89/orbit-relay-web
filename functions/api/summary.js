// Cloudflare Pages Function — the catalog summary the /spacetrack/ HUD opens with.
//
//   GET /api/summary
//
// This is a flat R2 read of `catalog/summary.json`, which the daily ingest
// regenerates: totals by type, regime, country and operator, plus the group
// counts and which of those groups are approximations. Serving it from the
// artifact rather than from D1 keeps six GROUP BY scans off the page-load path,
// and the numbers only change once a day anyway.
//
// It falls back to counting in D1 when the artifact is missing — which is the
// state between applying the schema and the first daily run.

import { preflight, withCitation, artifactOrDb } from './_catalog.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return preflight();

  return artifactOrDb(env, 'catalog/summary.json', 900, async () => {
    const [total, byType, byRegime] = await Promise.all([
      env.ORBIT_DB.prepare('SELECT COUNT(*) AS n FROM objects WHERE DECAY_DATE IS NULL').first(),
      tally(env, 'OBJECT_TYPE'),
      tally(env, 'regime'),
    ]);

    return withCitation({
      generated_at: new Date().toISOString(),
      tracked: total ? total.n : 0,
      by_type: byType,
      by_regime: byRegime,
      // The artifact carries more than this — group counts, country and operator
      // breakdowns. Say plainly that this is the reduced form rather than letting
      // the page render a partial summary as if it were complete.
      stale: true,
      note: 'Summary artifact not built yet — counted live from D1.',
    });
  });
}

async function tally(env, column) {
  const { results } = await env.ORBIT_DB.prepare(
    `SELECT ${column} AS k, COUNT(*) AS n FROM objects
     WHERE DECAY_DATE IS NULL GROUP BY k ORDER BY n DESC`).all();
  return Object.fromEntries((results || []).map((r) => [r.k || 'UNKNOWN', r.n]));
}
