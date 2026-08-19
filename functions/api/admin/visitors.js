import { adminJson } from '../_admin.js';

export async function onRequest(context) {
  const { env } = context;
  const db = env.ORBIT_DB;
  if (!db) return adminJson({ error: 'Database not bound — ORBIT_DB binding is missing on this deployment.' }, 503);

  const now = Date.now();
  const dayMs = 86400000;
  const todayStart = now - (now % dayMs);
  const weekStart = todayStart - 6 * dayMs;

  const result = { today: 0, thisWeek: 0, uniqueToday: 0, topPages: [], byCountry: [], byCity: [] };

  try {
    const r = await db.prepare('SELECT COUNT(*) AS n FROM page_views WHERE ts >= ?').bind(todayStart).first();
    result.today = r?.n ?? 0;
  } catch (_) {}

  try {
    const r = await db.prepare('SELECT COUNT(*) AS n FROM page_views WHERE ts >= ?').bind(weekStart).first();
    result.thisWeek = r?.n ?? 0;
  } catch (_) {}

  try {
    const r = await db.prepare('SELECT COUNT(DISTINCT ip_hash) AS n FROM page_views WHERE ts >= ?').bind(todayStart).first();
    result.uniqueToday = r?.n ?? 0;
  } catch (_) {}

  try {
    const { results } = await db
      .prepare('SELECT path, COUNT(*) AS views FROM page_views WHERE ts >= ? GROUP BY path ORDER BY views DESC LIMIT 10')
      .bind(weekStart)
      .all();
    result.topPages = results;
  } catch (_) {}

  try {
    const { results } = await db
      .prepare(
        "SELECT country, COUNT(*) AS views FROM page_views WHERE ts >= ? AND country != '' GROUP BY country ORDER BY views DESC LIMIT 20",
      )
      .bind(weekStart)
      .all();
    result.byCountry = results;
  } catch (_) {}

  try {
    const { results } = await db
      .prepare(
        `SELECT city, country, lat, lon, COUNT(*) AS views
         FROM page_views
         WHERE ts >= ? AND city != '' AND lat IS NOT NULL AND lon IS NOT NULL
         GROUP BY city, country, lat, lon
         ORDER BY views DESC
         LIMIT 200`,
      )
      .bind(weekStart)
      .all();
    result.byCity = results;
  } catch (_) {}

  return adminJson(result);
}
