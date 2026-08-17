// Cloudflare Pages Function — the launch-history dashboard for /spacetrack.
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
//
// The `launches` section of the response is served from `catalog/launches.json`,
// a separate artifact built daily by the ingest worker. It contains a reverse-
// chronological list of launches (by YYYY-NNN prefix), each with site name,
// object count, and type breakdown.
//
import { preflight, withCitation, artifactOrDb, json } from './_catalog.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return preflight();

  const analyticsP = artifactOrDb(env, 'catalog/analytics.json', 3600, async () => {
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

  const launchesP = artifactOrDb(env, 'catalog/launches.json', 86400, async () => {
    // launches.json is built daily by the ingest worker. When it is missing we
    // still read D1 so the table renders (stale: true, top 20 only) rather than
    // silently showing nothing — same reduced-form discipline as the analytics
    // fallback above.
    const { results } = await env.ORBIT_DB.prepare(`
      SELECT OBJECT_ID, LAUNCH_DATE, SITE, OBJECT_TYPE
      FROM objects
      WHERE OBJECT_ID IS NOT NULL AND LAUNCH_DATE IS NOT NULL AND SITE IS NOT NULL
      ORDER BY LAUNCH_DATE DESC`).all();

    const byLaunch = new Map();
    for (const r of (results || [])) {
      const prefix = String(r.OBJECT_ID).slice(0, 8); // YYYY-NNN
      if (!byLaunch.has(prefix)) {
        byLaunch.set(prefix, {
          launch_date: r.LAUNCH_DATE, site: r.SITE, n: 0,
          typeBreakdown: { PAYLOAD: 0, 'ROCKET BODY': 0, DEBRIS: 0 },
        });
      }
      const g = byLaunch.get(prefix);
      g.n++;
      const t = r.OBJECT_TYPE || '';
      if (g.typeBreakdown[t] !== undefined) g.typeBreakdown[t]++;
    }

    const nameOf = new Map();
    try {
      const { results: siteNames } = await env.ORBIT_DB.prepare('SELECT SITE_CODE, LAUNCH_SITE FROM launch_sites').all();
      for (const r of (siteNames || [])) nameOf.set(r.SITE_CODE, r.LAUNCH_SITE);
    } catch (_) {}

    // ISO date strings compare chronologically as strings (D1 stores
    // LAUNCH_DATE as TEXT); a numeric comparator would no-op on them and the
    // slice below would take whatever order the scan happened to produce.
    const launches = [...byLaunch.entries()]
      .map(([, g]) => ({
        launch_date: g.launch_date,
        site: nameOf.get(g.site) || g.site || '',
        n: g.n,
        typeBreakdown: g.typeBreakdown,
      }))
      .sort((a, b) => String(b.launch_date || '').localeCompare(String(a.launch_date || '')))
      .slice(0, 20);

    return {
      generated_at: new Date().toISOString(),
      launches,
      stale: true,
      note: 'Launch artifact not built yet — top 20 launches read from D1.',
    };
  });

  // artifactOrDb returns Responses; both sections are merged into ONE response
  // body here, so the citation header and the analytics cache age apply to the
  // whole payload rather than the page making two round-trips.
  const [analyticsRes, launchesRes] = await Promise.all([analyticsP, launchesP]);
  const [analyticsBody, launchesBody] = await Promise.all([analyticsRes.json(), launchesRes.json()]);
  return json({
    ...analyticsBody,
    launches: (launchesBody && launchesBody.launches) || [],
  }, { maxAge: 3600 });
}