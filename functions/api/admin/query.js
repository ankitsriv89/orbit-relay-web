import { adminJson } from '../_admin.js';

// Whitelist of shape, not a blacklist of keywords. Threats the naive checks miss:
// SELECT 1; DROP TABLE objects (multi-statement), /*x*/DELETE …,
// WITH t AS (SELECT 1) DELETE …, PRAGMA writable_schema=ON, ATTACH DATABASE, etc.
const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|replace|truncate|attach|detach|pragma|vacuum|reindex|analyze|begin|commit|rollback|savepoint|release|grant|revoke|load_extension|writable_schema)\b/i;
const ROW_CAP = 500;

/** Strip comments and string literals so keywords cannot hide inside either. */
export function stripNoise(sql) {
  return sql
    .replace(/--[^\n]*/g, ' ?? ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ?? ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "' ?? '")
    .replace(/"(?:[^"\\]|\\.)*"/g, '" ?? "');
}

export function guardSelect(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'empty query' };
  if (raw.length > 4000) return { ok: false, reason: 'query too long (4000 char cap)' };
  const bare = stripNoise(raw).trim().replace(/;\s*$/, '');   // one trailing ; allowed
  if (bare.includes(';')) return { ok: false, reason: 'multiple statements are not allowed' };
  if (!/^\s*(select|with)\b/i.test(bare)) return { ok: false, reason: 'only SELECT (or WITH…SELECT)' };
  const m = FORBIDDEN.exec(bare);
  if (m) return { ok: false, reason: `forbidden keyword: ${m[1].toUpperCase()}` };
  return { ok: true, sql: bare };
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const db = env.ORBIT_DB;
  if (!db) return adminJson({ error: 'Database not bound — ORBIT_DB binding is missing on this deployment.' }, 503);

  let body;
  try { body = await request.json(); } catch (_) {
    return adminJson({ error: 'Request body must be valid JSON.' }, 400);
  }

  const check = guardSelect(body?.sql);
  if (!check.ok) return adminJson({ error: check.reason }, 400);

  // There is no timeout, and the code says so — D1 exposes no per-query timeout
  // and Workers cannot cancel an in-flight D1 call. Mitigation is the row cap +
  // char cap + the fact that this is behind auth.
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
