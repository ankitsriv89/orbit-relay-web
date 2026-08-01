import { adminJson } from '../_admin.js';

export async function onRequest(context) {
  const { env } = context;
  const db = env.ORBIT_DB;
  if (!db) return adminJson({ error: 'D1 not bound' }, 503);

  try {
    const { results } = await db
      .prepare('SELECT id, ts, job, ok, total_ms, d1_requests, r2_puts, source, steps FROM ingest_runs ORDER BY ts DESC LIMIT 50')
      .all();
    return adminJson({ runs: results });
  } catch (err) {
    return adminJson({ error: `Failed to fetch runs: ${err.message}` }, 500);
  }
}
