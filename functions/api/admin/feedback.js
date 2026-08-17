import { adminJson } from '../_admin.js';

export async function onRequestGet(context) {
  const { env } = context;
  const db = env.ORBIT_DB;
  if (!db) return adminJson({ error: 'Database not bound — ORBIT_DB binding is missing on this deployment.' }, 503);

  try {
    const { results } = await db
      .prepare('SELECT id, ts, kind, message, email, path, ua_class, reviewed FROM feedback ORDER BY ts DESC LIMIT 200')
      .all();
    const unreviewed = results.filter(r => !r.reviewed).length;
    return adminJson({ items: results, unreviewed });
  } catch (err) {
    return adminJson({ error: `Failed to fetch feedback: ${err.message}` }, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const db = env.ORBIT_DB;
  if (!db) return adminJson({ error: 'Database not bound — ORBIT_DB binding is missing on this deployment.' }, 503);

  let body;
  try { body = await request.json(); } catch (_) {
    return adminJson({ error: 'Request body must be valid JSON.' }, 400);
  }

  const id = Number(body?.id);
  if (!Number.isInteger(id) || id <= 0) return adminJson({ error: 'id must be a positive integer' }, 400);
  const reviewed = body?.reviewed ? 1 : 0;

  try {
    await db.prepare('UPDATE feedback SET reviewed = ? WHERE id = ?').bind(reviewed, id).run();
    return adminJson({ ok: true });
  } catch (err) {
    return adminJson({ error: `Failed to update feedback: ${err.message}` }, 500);
  }
}
