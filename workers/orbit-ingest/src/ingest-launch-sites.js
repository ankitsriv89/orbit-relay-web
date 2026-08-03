/**
 * launch_site ingest — the weekly job, full pull.
 *
 * Space-Track's `launch_site` class is a small, static SITE_CODE -> LAUNCH_SITE
 * name map (~60 rows, per the Space-Track glossary). Unlike SATCAT there is no
 * FILE cursor on this class and none is needed: the whole table fits in one
 * response and the data barely ever changes, so a plain upsert of everything
 * returned is simpler than maintaining a delta that would save almost nothing
 * (plan 38 task 2).
 *
 * Runs from `runWeekly`, not `runDaily` — the daily job is already the long
 * one, and this data does not need daily freshness.
 */

import { Q, query } from './spacetrack.js';

const UPSERT_SQL = `
  INSERT INTO launch_sites (SITE_CODE, LAUNCH_SITE, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(SITE_CODE) DO UPDATE SET
    LAUNCH_SITE = excluded.LAUNCH_SITE,
    updated_at = excluded.updated_at
`;

export async function ingestLaunchSites(env) {
  const now = new Date().toISOString();
  const rows = await query(env, 'launch_site', Q.launchSites());

  const statements = [];
  for (const r of rows) {
    const code = r && (r.SITE_CODE ?? r.SITE);
    if (code == null || code === '') continue;
    const name = r.LAUNCH_SITE ?? null;
    statements.push(env.ORBIT_DB.prepare(UPSERT_SQL).bind(String(code), name, now));
  }

  if (statements.length) await env.ORBIT_DB.batch(statements);

  return { rows: statements.length };
}
