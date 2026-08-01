import { adminJson } from '../_admin.js';

const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|replace|truncate|attach|detach|pragma|vacuum|reindex|analyze|begin|commit|rollback|savepoint|release|grant|revoke|load_extension|writable_schema)\b/i;
const ROW_CAP = 500;

function stripNoise(sql) {
  return sql
    .replace(/--[^\n]*/g, ' ?? ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ?? ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "' ?? '")
    .replace(/"(?:[^"\\]|\\.)*"/g, '" ?? "');
}

export function guardSelect(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'empty query' };
  if (raw.length > 4000) return { ok: false, reason: 'query too long (4000 char cap)' };
  const bare = stripNoise(raw).trim().replace(/;\s*$/, '');
  if (bare.includes(';')) return { ok: false, reason: 'multiple statements are not allowed' };
  if (!/^\s*(select|with)\b/i.test(bare)) return { ok: false, reason: 'only SELECT (or WITH…SELECT)' };
  const m = FORBIDDEN.exec(bare);
  if (m) return { ok: false, reason: `forbidden keyword: ${m[1].toUpperCase()}` };
  return { ok: true, sql: bare };
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const db = env.ORBIT_DB;
  if (!db) return adminJson({ error: 'D1 not bound' }, 503);

  let body;
  try { body = await request.json(); } catch (_) {
    return adminJson({ error: 'invalid JSON body' }, 400);
  }

  const check = guardSelect(body?.sql);
  if (!check.ok) return adminJson({ error: check.reason }, 400);

  const wrapped = `SELECT * FROM (${check.sql}) LIMIT ${ROW_CAP + 1}`;
  const start = Date.now();
  try {
    const { results } = await db.prepare(wrapped).all();
    const elapsed = Date.now() - start;
    const truncated = results.length > ROW_CAP;
    return adminJson({
      rows: truncated ? results.slice(0, ROW_CAP) : results,
      truncated,
      rowCount: Math.min(results.length, ROW_CAP),
      ms: elapsed,
    });
  } catch (err) {
    return adminJson({ error: `Query failed: ${err.message}` }, 400);
  }
}
