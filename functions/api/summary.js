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

import { json, preflight, requireDb, withCitation } from './_catalog.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return preflight();

  if (env && env.ORBIT_R2) {
    const object = await env.ORBIT_R2.get('catalog/summary.json');
    if (object) {
      const body = await object.text();
      try {
        return json({ ...JSON.parse(body), stale: false }, { maxAge: 900 });
      } catch (_) {
        // A corrupt artifact must not take the page down — fall through to D1.
      }
    }
  }

  const unbound = requireDb(env);
  if (unbound) return unbound;

  const [total, byType, byRegime] = await Promise.all([
    env.ORBIT_DB.prepare('SELECT COUNT(*) AS n FROM objects WHERE DECAY_DATE IS NULL').first(),
    tally(env, 'OBJECT_TYPE'),
    tally(env, 'regime'),
  ]);

  return json(withCitation({
    generated_at: new Date().toISOString(),
    tracked: total ? total.n : 0,
    by_type: byType,
    by_regime: byRegime,
    // The artifact carries more than this — group counts, country and operator
    // breakdowns. Say plainly that this is the reduced form rather than letting
    // the page render a partial summary as if it were complete.
    stale: true,
    note: 'Summary artifact not built yet — counted live from D1.',
  }), { maxAge: 60 });
}

async function tally(env, column) {
  const { results } = await env.ORBIT_DB.prepare(
    `SELECT ${column} AS k, COUNT(*) AS n FROM objects
     WHERE DECAY_DATE IS NULL GROUP BY k ORDER BY n DESC`).all();
  return Object.fromEntries((results || []).map((r) => [r.k || 'UNKNOWN', r.n]));
}
