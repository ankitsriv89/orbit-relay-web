import { adminJson } from '../_admin.js';

export async function onRequest(context) {
  const { env } = context;
  const db = env.ORBIT_DB;
  if (!db) return adminJson({ error: 'Database not bound — ORBIT_DB binding is missing on this deployment.' }, 503);

  const results = {};

  try {
    const r = await db.prepare('SELECT COUNT(*) AS n FROM objects').first();
    results.objects = r?.n ?? 0;
  } catch (_) { results.objects = null; }

  try {
    const r = await db.prepare("SELECT COUNT(*) AS n FROM objects WHERE OBJECT_TYPE = 'Payload'").first();
    results.payloads = r?.n ?? 0;
  } catch (_) { results.payloads = null; }

  try {
    const r = await db.prepare("SELECT COUNT(*) AS n FROM objects WHERE OBJECT_TYPE = 'Debris'").first();
    results.debris = r?.n ?? 0;
  } catch (_) { results.debris = null; }

  try {
    const cutoff = Date.now() - 3600000;
    const r = await db.prepare('SELECT COUNT(*) AS n FROM api_calls WHERE ts > ?').bind(cutoff).first();
    results.apiCalls1h = r?.n ?? 0;
  } catch (_) { results.apiCalls1h = null; }

  try {
    const r = await db.prepare('SELECT job, ok, ts FROM ingest_runs ORDER BY ts DESC LIMIT 1').first();
    results.latestIngest = r || null;
  } catch (_) { results.latestIngest = null; }

  try {
    const r2 = env.ORBIT_R2;
    if (r2) {
      const obj = await r2.get('catalog/summary.json');
      if (obj) {
        // customMetadata, not metadata: the ingest writes { citation, generated }
        // via customMetadata (derive.js) and .metadata is always undefined.
        const uploaded = obj.customMetadata?.generated;
        if (uploaded) {
          const ageMs = Date.now() - new Date(uploaded).getTime();
          const hours = Math.floor(ageMs / 3600000);
          results.artifactAge = hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
        } else {
          results.artifactAge = 'unknown';
        }
      } else {
        results.artifactAge = 'missing';
      }
    } else {
      results.artifactAge = 'no R2';
    }
  } catch (_) { results.artifactAge = 'error'; }

  return adminJson(results);
}
