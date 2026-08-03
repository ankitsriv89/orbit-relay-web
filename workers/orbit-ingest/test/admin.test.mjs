/**
 * Admin auth + SQL guard tests.
 *
 *     node workers/orbit-ingest/test/admin.test.mjs
 *
 * SQL-guard tests are written FIRST and must pass against the naive
 * startsWith('select') implementation — then we improve the guard.
 * Auth round-trip, tampered sig, expired token, wrong secret all tested.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextRun, nextDue, ACTIONS_CRONS } from '../../../public/admin/cron.js';
import { onRequest as hitOnRequest } from '../../../functions/api/hit.js';
import { onRequestPost as briefEditPost } from '../../../functions/api/admin/brief.js';
import { fakeR2 } from './fakes.mjs';

// ── Inline the functions under test (they are pure, no bindings needed) ────

function b64uEncode(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64uDecode(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

async function getKey(secret) {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false,
    ['sign', 'verify'],
  );
}

async function mintToken(secret, claims) {
  const key = await getKey(secret);
  const payload = b64uEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const sig = b64uEncode(await crypto.subtle.sign('HMAC', key, b64uDecode(payload)));
  return `v1.${payload}.${sig}`;
}

async function verifyToken(secret, token) {
  if (typeof token !== 'string') return null;
  const [v, p, s] = token.split('.');
  if (v !== 'v1' || !p || !s) return null;
  let bytes, sig;
  try { bytes = b64uDecode(p); sig = b64uDecode(s); } catch (_) { return null; }
  if (!await crypto.subtle.verify('HMAC', await getKey(secret), sig, bytes)) return null;
  let claims;
  try { claims = JSON.parse(new TextDecoder().decode(bytes)); } catch (_) { return null; }
  if (typeof claims?.exp !== 'number' || claims.exp < Date.now()) return null;
  return claims;
}

// ── adminJson: positional status codes (regression: all 14 call sites pass
//    the status positionally — `adminJson({error}, 401)` — so the helper must
//    honor a bare number, not only an options object. When this broke, every
//    admin error returned HTTP 200 and the login form never appeared.)
//    NOTE: inlined copy mirrors functions/api/_admin.js; keep in sync. ────────

function adminJson(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      ...extraHeaders,
    },
  });
}

// ── SQL guard (copied from the implementation to test against) ─────────────

const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|replace|truncate|attach|detach|pragma|vacuum|reindex|analyze|begin|commit|rollback|savepoint|release|grant|revoke|load_extension|writable_schema)\b/i;

function stripNoise(sql) {
  return sql
    .replace(/--[^\n]*/g, ' ?? ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ?? ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "' ?? '")
    .replace(/"(?:[^"\\]|\\.)*"/g, '" ?? "');
}

function guardSelect(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'empty query' };
  if (raw.length > 4000) return { ok: false, reason: 'query too long (4000 char cap)' };
  const bare = stripNoise(raw).trim().replace(/;\s*$/, '');
  if (bare.includes(';')) return { ok: false, reason: 'multiple statements are not allowed' };
  if (!/^\s*(select|with)\b/i.test(bare)) return { ok: false, reason: 'only SELECT (or WITH…SELECT)' };
  const m = FORBIDDEN.exec(bare);
  if (m) return { ok: false, reason: `forbidden keyword: ${m[1].toUpperCase()}` };
  return { ok: true, sql: bare };
}

// ── Tests ──────────────────────────────────────────────────────────────────

const results = [];
function test(name, fn) {
  try { fn(); results.push(true); console.log('  PASS  ' + name); }
  catch (e) { results.push(false); console.log('  FAIL  ' + name + '\n        ' + e.message); }
}

async function testAsync(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS  ' + name); }
  catch (e) { results.push(false); console.log('  FAIL  ' + name + '\n        ' + e.message); }
}

console.log('\n-- adminJson: status codes --');

test('default status is 200', () => {
  assert.equal(adminJson({ ok: true }).status, 200);
});

test('positional 401 honored (unauthorized / bad password)', () => {
  assert.equal(adminJson({ error: 'unauthorized' }, 401).status, 401);
});

test('positional 400 honored (SQL guard rejections)', () => {
  assert.equal(adminJson({ error: 'multiple statements are not allowed' }, 400).status, 400);
});

test('positional 503 honored (misconfiguration)', () => {
  assert.equal(adminJson({ error: 'Admin is not configured on this deployment.' }, 503).status, 503);
});

console.log('\n-- SQL guard: basic accepts --');

test('simple SELECT passes', () => {
  assert.deepEqual(guardSelect('SELECT * FROM objects'), { ok: true, sql: 'SELECT * FROM objects' });
});

test('lowercase select passes', () => {
  assert.deepEqual(guardSelect('select norad_cat_id from objects'), { ok: true, sql: 'select norad_cat_id from objects' });
});

test('WITH…SELECT passes', () => {
  assert.deepEqual(guardSelect('WITH t AS (SELECT 1) SELECT * FROM t'), { ok: true, sql: 'WITH t AS (SELECT 1) SELECT * FROM t' });
});

test('trailing semicolon stripped', () => {
  assert.deepEqual(guardSelect('SELECT 1;'), { ok: true, sql: 'SELECT 1' });
});

console.log('\n-- SQL guard: rejects --');

test('empty query rejected', () => {
  assert.deepEqual(guardSelect(''), { ok: false, reason: 'empty query' });
});

test('whitespace-only rejected', () => {
  assert.deepEqual(guardSelect('   '), { ok: false, reason: 'empty query' });
});

test('non-string rejected', () => {
  assert.deepEqual(guardSelect(null), { ok: false, reason: 'empty query' });
});

test('too long rejected', () => {
  assert.deepEqual(guardSelect('SELECT ' + 'x'.repeat(4001)), { ok: false, reason: 'query too long (4000 char cap)' });
});

test('multi-statement rejected', () => {
  assert.deepEqual(guardSelect('SELECT 1; DROP TABLE objects'), { ok: false, reason: 'multiple statements are not allowed' });
});

test('INSERT rejected', () => {
  const r = guardSelect('INSERT INTO objects VALUES (1)');
  assert.equal(r.ok, false);
});

test('DELETE rejected', () => {
  const r = guardSelect('DELETE FROM objects');
  assert.equal(r.ok, false);
});

test('DROP rejected', () => {
  const r = guardSelect('DROP TABLE objects');
  assert.equal(r.ok, false);
});

test('UPDATE rejected', () => {
  const r = guardSelect('UPDATE objects SET x=1');
  assert.equal(r.ok, false);
});

test('CREATE rejected', () => {
  const r = guardSelect('CREATE TABLE evil (id INTEGER)');
  assert.equal(r.ok, false);
});

test('ALTER rejected', () => {
  const r = guardSelect('ALTER TABLE objects ADD COLUMN x');
  assert.equal(r.ok, false);
});

test('PRAGMA rejected', () => {
  const r = guardSelect('PRAGMA writable_schema=ON');
  assert.equal(r.ok, false);
});

test('TRUNCATE rejected', () => {
  const r = guardSelect('TRUNCATE TABLE objects');
  assert.equal(r.ok, false);
});

test('ATTACH rejected', () => {
  const r = guardSelect('ATTACH DATABASE "evil.db" AS e');
  assert.equal(r.ok, false);
});

test('VACUUM rejected', () => {
  const r = guardSelect('VACUUM');
  assert.equal(r.ok, false);
});

test('REINDEX rejected', () => {
  const r = guardSelect('REINDEX');
  assert.equal(r.ok, false);
});

test('ANALYZE rejected', () => {
  const r = guardSelect('ANALYZE objects');
  assert.equal(r.ok, false);
});

test('GRANT rejected', () => {
  const r = guardSelect('GRANT ALL ON objects TO public');
  assert.equal(r.ok, false);
});

test('REVOKE rejected', () => {
  const r = guardSelect('REVOKE ALL ON objects FROM public');
  assert.equal(r.ok, false);
});

test('COMMIT rejected', () => {
  const r = guardSelect('COMMIT');
  assert.equal(r.ok, false);
});

test('ROLLBACK rejected', () => {
  const r = guardSelect('ROLLBACK');
  assert.equal(r.ok, false);
});

test('BEGIN rejected', () => {
  const r = guardSelect('BEGIN');
  assert.equal(r.ok, false);
});

console.log('\n-- SQL guard: comment/string bypass attempts --');

test('DELETE hidden behind block comment', () => {
  const r = guardSelect('/* evil */ DELETE FROM objects');
  assert.equal(r.ok, false, `should reject, got: ${JSON.stringify(r)}`);
});

test('DELETE hidden behind line comment', () => {
  const r = guardSelect('-- x\nDELETE FROM objects');
  assert.equal(r.ok, false, `should reject, got: ${JSON.stringify(r)}`);
});

test('DELETE hidden inside string literal', () => {
  const r = guardSelect("SELECT * FROM t WHERE x = 'DELETE'");
  assert.equal(r.ok, true, `should accept DELETE inside string, got: ${JSON.stringify(r)}`);
});

test('DROP hidden behind comment is stripped', () => {
  const stripped = stripNoise('/* DROP */ SELECT 1');
  assert.ok(!/drop/i.test(stripped), 'DROP keyword should be blanked by stripNoise');
});

test('WITH … DELETE caught', () => {
  const r = guardSelect('WITH t AS (SELECT 1) DELETE FROM objects');
  assert.equal(r.ok, false, `should reject, got: ${JSON.stringify(r)}`);
});

test('SELECT with DELETE in string is fine', () => {
  const r = guardSelect("SELECT 'delete' FROM t");
  assert.equal(r.ok, true, `should accept, got: ${JSON.stringify(r)}`);
});

test('INSERT INTO t SELECT ... rejected', () => {
  const r = guardSelect('INSERT INTO t SELECT * FROM objects');
  assert.equal(r.ok, false, `should reject INSERT, got: ${JSON.stringify(r)}`);
});

console.log('\n-- SQL guard: stripNoise --');

test('line comment stripped', () => {
  const s = stripNoise('SELECT 1 -- comment');
  assert.ok(!s.includes('comment'));
});

test('block comment stripped', () => {
  const s = stripNoise('SELECT /* comment */ 1');
  assert.ok(!s.includes('comment'));
});

test('single-quoted string stripped', () => {
  const s = stripNoise("SELECT 'hello' FROM t");
  assert.ok(s.includes("' ?? '"));
  assert.ok(!s.includes('hello'));
});

test('double-quoted string stripped', () => {
  const s = stripNoise('SELECT "hello" FROM t');
  assert.ok(s.includes('" ?? "'));
  assert.ok(!s.includes('hello'));
});

test('nested block comments stripped', () => {
  const s = stripNoise('SELECT /* a /* b */ c */ 1');
  assert.ok(!s.includes('a'));
});

console.log('\n-- Auth: token round-trip --');

await testAsync('mint + verify round-trip', async () => {
  const secret = 'test-secret-123';
  const now = Date.now();
  const claims = { sub: 'admin', iat: now, exp: now + 3600000 };
  const token = await mintToken(secret, claims);
  const result = await verifyToken(secret, token);
  assert.ok(result);
  assert.equal(result.sub, 'admin');
  assert.equal(result.exp, claims.exp);
});

await testAsync('tampered signature fails', async () => {
  const secret = 'test-secret-123';
  const token = await mintToken(secret, { sub: 'admin', iat: Date.now(), exp: Date.now() + 3600000 });
  const parts = token.split('.');
  parts[2] = b64uEncode(new Uint8Array([1, 2, 3]));
  const tampered = parts.join('.');
  const result = await verifyToken(secret, tampered);
  assert.equal(result, null);
});

await testAsync('expired token fails', async () => {
  const secret = 'test-secret-123';
  const token = await mintToken(secret, { sub: 'admin', iat: Date.now() - 7200000, exp: Date.now() - 1000 });
  const result = await verifyToken(secret, token);
  assert.equal(result, null);
});

await testAsync('wrong secret fails', async () => {
  const token = await mintToken('secret-a', { sub: 'admin', iat: Date.now(), exp: Date.now() + 3600000 });
  const result = await verifyToken('secret-b', token);
  assert.equal(result, null);
});

await testAsync('invalid token format fails', async () => {
  assert.equal(await verifyToken('secret', 'not-a-token'), null);
  assert.equal(await verifyToken('secret', 'v1.'), null);
  assert.equal(await verifyToken('secret', ''), null);
});

await testAsync('null/undefined token fails', async () => {
  assert.equal(await verifyToken('secret', null), null);
  assert.equal(await verifyToken('secret', undefined), null);
});

console.log('\n-- Auth: password compare --');

await testAsync('correct password matches', async () => {
  const env = { ADMIN_PASSWORD: 'my-secret-pw', ADMIN_SECRET: 'hmac-key' };
  const enc = new TextEncoder();
  const key = await getKey(env.ADMIN_SECRET);
  const a = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(env.ADMIN_PASSWORD)));
  const b = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode('my-secret-pw')));
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  assert.equal(diff, 0);
});

await testAsync('wrong password fails', async () => {
  const env = { ADMIN_PASSWORD: 'my-secret-pw', ADMIN_SECRET: 'hmac-key' };
  const enc = new TextEncoder();
  const key = await getKey(env.ADMIN_SECRET);
  const a = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(env.ADMIN_PASSWORD)));
  const b = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode('wrong-pw')));
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  assert.notEqual(diff, 0);
});

console.log('\n-- next-due cron (plan 36 §5) --');

test('health.js queries OBJECT_TYPE with canonical uppercase values', () => {
  // Space-Track stores PAYLOAD / DEBRIS / ROCKET BODY uppercase (derive.js
  // groups agree). Title case in health.js matched nothing — the panel read
  // 0 payloads / 0 debris against an 18k-payload catalog.
  const src = readFileSync(new URL('../../../functions/api/admin/health.js', import.meta.url), 'utf8');
  for (const lit of ['PAYLOAD', 'DEBRIS']) {
    assert.ok(src.includes(`OBJECT_TYPE = '${lit}'`), `health.js must query '${lit}' (uppercase)`);
  }
  assert.ok(!src.includes("OBJECT_TYPE = 'Payload'"), 'title-case Payload query must not return');
  assert.ok(!src.includes("OBJECT_TYPE = 'Debris'"), 'title-case Debris query must not return');
});

test('the Actions crons are the documented schedule', () => {
  assert.deepEqual(ACTIONS_CRONS.map(c => c.cron), ['17 */6 * * *', '35 17 * * *', '40 17 * * 3']);
});

test('GP: :17 of every 6th hour', () => {
  const from = Date.UTC(2026, 7, 1, 10, 0, 0); // 10:00Z → next 6h boundary is 12:17Z
  assert.equal(nextRun('17 */6 * * *', from), Date.UTC(2026, 7, 1, 12, 17, 0));
});

test('GP: match is strictly after the from timestamp', () => {
  const at = Date.UTC(2026, 7, 1, 0, 17, 0);
  assert.equal(nextRun('17 */6 * * *', at), Date.UTC(2026, 7, 1, 6, 17, 0));
});

test('DAILY: 17:35Z every day', () => {
  const from = Date.UTC(2026, 7, 1, 10, 0, 0);
  assert.equal(nextRun('35 17 * * *', from), Date.UTC(2026, 7, 1, 17, 35, 0));
});

test('WEEKLY: Wednesdays 17:40Z (2026-08-01 is a Saturday)', () => {
  const from = Date.UTC(2026, 7, 1, 10, 0, 0);
  assert.equal(nextRun('40 17 * * 3', from), Date.UTC(2026, 7, 5, 17, 40, 0));
});

test('nextDue picks the earliest of the three jobs', () => {
  const from = Date.UTC(2026, 7, 1, 10, 0, 0);
  const next = nextDue(from);
  assert.equal(next.job, 'GP');
  assert.equal(next.at, Date.UTC(2026, 7, 1, 12, 17, 0));
});

test('nextDue defaults to now and returns within a year', () => {
  const next = nextDue();
  assert.ok(next && next.at > Date.now() && next.at < Date.now() + 366 * 86400000);
});

console.log('\n-- /api/hit beacon (functions/api/hit.js) --');

// A D1-shaped binding over node:sqlite, same shim as pages-api.test.mjs.
function localD1(db) {
  const norm = (a) => a.map((v) => (v === undefined ? null : v));
  return {
    prepare(sql) {
      const stmt = { sql, args: [] };
      stmt.bind = (...a) => { stmt.args = norm(a); return stmt; };
      stmt.all = async () => ({ results: db.prepare(sql).all(...stmt.args) });
      stmt.first = async () => db.prepare(sql).get(...stmt.args) ?? null;
      stmt.run = async () => {
        const i = db.prepare(sql).run(...stmt.args);
        return { meta: { last_row_id: Number(i.lastInsertRowid), changes: Number(i.changes) } };
      };
      return stmt;
    },
  };
}

function seededPageViewsDb() {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const ROOT = path.resolve(HERE, '../../..');
  const SCHEMA = readFileSync(path.join(ROOT, 'd1/orbit.sql'), 'utf8');
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return db;
}

// A minimal EventContext stand-in that mirrors the real Pages Functions
// shape: waitUntil reads `this`, exactly like Cloudflare's actual
// EventContext class. Destructuring `{ waitUntil }` off an instance and
// calling it unbound throws "Cannot read properties of undefined (reading
// '_pending')" — exactly the bug this test catches (object-literal shorthand
// methods close over the outer scope instead and would hide the bug).
class FakeEventContext {
  constructor(request, env) {
    this.request = request;
    this.env = env;
    this._pending = [];
  }
  waitUntil(p) { this._pending.push(p); }
}
function fakeContext({ request, env }) {
  return new FakeEventContext(request, env);
}

await testAsync('POST /api/hit inserts a page_views row (waitUntil bound correctly)', async () => {
  const db = seededPageViewsDb();
  const env = { ORBIT_DB: localD1(db), ADMIN_SECRET: 'test-secret' };
  const ctx = fakeContext({
    request: new Request('https://x/api/hit', {
      method: 'POST',
      body: JSON.stringify({ path: '/orbit/', ref: 'https://example.com/some/page' }),
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) Safari/605', 'CF-Connecting-IP': '203.0.113.7' },
    }),
    env,
  });
  const res = await hitOnRequest(ctx);
  assert.equal(res.status, 204);
  // The insert is scheduled via ctx.waitUntil — await it before asserting the row landed.
  await Promise.all(ctx._pending);
  const row = db.prepare('SELECT path, referrer, ua_class FROM page_views').get();
  assert.equal(row.path, '/orbit/');
  assert.equal(row.referrer, 'https://example.com', 'referrer stored as origin only, never the full URL');
  assert.equal(row.ua_class, 'desktop');
});

await testAsync('a bot UA is a 204 no-op, no row written', async () => {
  const db = seededPageViewsDb();
  const env = { ORBIT_DB: localD1(db), ADMIN_SECRET: 'test-secret' };
  const ctx = fakeContext({
    request: new Request('https://x/api/hit', {
      method: 'POST',
      body: JSON.stringify({ path: '/' }),
      headers: { 'User-Agent': 'Googlebot/2.1' },
    }),
    env,
  });
  const res = await hitOnRequest(ctx);
  assert.equal(res.status, 204);
  await Promise.all(ctx._pending);
  const row = db.prepare('SELECT COUNT(*) AS n FROM page_views').get();
  assert.equal(row.n, 0);
});

console.log('\n-- /api/admin/brief (manual editor, plan 38 task 8) --');

function briefRequest(body) {
  return new Request('https://x/api/admin/brief', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function seedCard(r2, date, overrides = {}) {
  const card = {
    generated_at: `${date}T00:00:00.000Z`,
    citation: 'Space-Track',
    facts: { new_objects: 3, decays: 1 },
    narrative: 'A prior AI narrative about three new objects.',
    narrative_status: 'ok',
    narrative_source: 'ai',
    ...overrides,
  };
  r2.puts.set(`brief/${date}.json`, { body: JSON.stringify(card), opts: {} });
  return card;
}

await testAsync('overwrites narrative, sets narrative_source manual, leaves facts untouched', async () => {
  const r2 = fakeR2();
  seedCard(r2, '2026-08-01');
  const env = { ORBIT_R2: r2 };
  const res = await briefEditPost({
    request: briefRequest({ date: '2026-08-01', narrative: 'A'.repeat(65) }),
    env,
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.narrative_source, 'manual');

  const stored = JSON.parse(r2.puts.get('brief/2026-08-01.json').body);
  assert.equal(stored.narrative_source, 'manual');
  assert.equal(stored.narrative, 'A'.repeat(65));
  assert.deepEqual(stored.facts, { new_objects: 3, decays: 1 }, 'facts must be untouched by a manual edit');
});

await testAsync('defaults date to today when omitted', async () => {
  const r2 = fakeR2();
  const today = new Date().toISOString().slice(0, 10);
  seedCard(r2, today);
  const env = { ORBIT_R2: r2 };
  const res = await briefEditPost({ request: briefRequest({ narrative: 'B'.repeat(65) }), env });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.date, today);
});

await testAsync('missing day (no auto card yet) is rejected, not silently created', async () => {
  const r2 = fakeR2();
  const env = { ORBIT_R2: r2 };
  const res = await briefEditPost({
    request: briefRequest({ date: '2026-01-01', narrative: 'C'.repeat(65) }),
    env,
  });
  assert.equal(res.status, 404);
});

await testAsync('forbidden collision language is rejected on manual text too', async () => {
  const r2 = fakeR2();
  seedCard(r2, '2026-08-01');
  const env = { ORBIT_R2: r2 };
  const res = await briefEditPost({
    request: briefRequest({
      date: '2026-08-01',
      narrative: 'This object has a predicted conjunction with another satellite next week for sure.',
    }),
    env,
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /conjunction|collision/i);
});

await testAsync('manual text may contain a number absent from the facts (no grounding gate)', async () => {
  const r2 = fakeR2();
  seedCard(r2, '2026-08-01');
  const env = { ORBIT_R2: r2 };
  const narrative = 'A hand-written note about 42 objects that the automated facts never counted.'.padEnd(65, ' .');
  const res = await briefEditPost({ request: briefRequest({ date: '2026-08-01', narrative }), env });
  assert.equal(res.status, 200, 'manual narrative must skip the number-grounding gate entirely');
});

await testAsync('too-short narrative is rejected', async () => {
  const r2 = fakeR2();
  seedCard(r2, '2026-08-01');
  const env = { ORBIT_R2: r2 };
  const res = await briefEditPost({ request: briefRequest({ date: '2026-08-01', narrative: 'too short' }), env });
  assert.equal(res.status, 400);
});

await testAsync('malformed date is rejected', async () => {
  const r2 = fakeR2();
  const env = { ORBIT_R2: r2 };
  const res = await briefEditPost({
    request: briefRequest({ date: '08/01/2026', narrative: 'D'.repeat(65) }),
    env,
  });
  assert.equal(res.status, 400);
});

await testAsync('rewrites the index after a manual save', async () => {
  const r2 = fakeR2();
  seedCard(r2, '2026-08-01');
  seedCard(r2, '2026-08-02', { narrative: null, narrative_status: 'skipped: nothing to report', narrative_source: 'none' });
  const env = { ORBIT_R2: r2 };
  const res = await briefEditPost({
    request: briefRequest({ date: '2026-08-01', narrative: 'E'.repeat(65) }),
    env,
  });
  assert.equal(res.status, 200);
  const index = JSON.parse(r2.puts.get('brief/index.json').body);
  assert.equal(index.total, 2);
  const day = index.days.find((d) => d.date === '2026-08-01');
  assert.equal(day.narrative_source, 'manual');
});

await testAsync('editing today also refreshes brief/latest.json', async () => {
  const r2 = fakeR2();
  const today = new Date().toISOString().slice(0, 10);
  seedCard(r2, today);
  const env = { ORBIT_R2: r2 };
  const res = await briefEditPost({
    request: briefRequest({ date: today, narrative: 'F'.repeat(65) }),
    env,
  });
  assert.equal(res.status, 200);
  const latest = JSON.parse(r2.puts.get('brief/latest.json').body);
  assert.equal(latest.narrative_source, 'manual');
  assert.equal(latest.narrative, 'F'.repeat(65));
});

await testAsync('editing a past day does not touch brief/latest.json', async () => {
  const r2 = fakeR2();
  seedCard(r2, '2020-01-01');
  r2.puts.set('brief/latest.json', { body: JSON.stringify({ narrative_source: 'ai', narrative: 'untouched' }), opts: {} });
  const env = { ORBIT_R2: r2 };
  const res = await briefEditPost({
    request: briefRequest({ date: '2020-01-01', narrative: 'G'.repeat(65) }),
    env,
  });
  assert.equal(res.status, 200);
  const latest = JSON.parse(r2.puts.get('brief/latest.json').body);
  assert.equal(latest.narrative_source, 'ai', 'a past-day edit must not overwrite today\'s live card');
});

await testAsync('optional note is stored, capped at 500 chars', async () => {
  const r2 = fakeR2();
  seedCard(r2, '2026-08-01');
  const env = { ORBIT_R2: r2 };
  const res = await briefEditPost({
    request: briefRequest({ date: '2026-08-01', narrative: 'H'.repeat(65), note: 'x'.repeat(600) }),
    env,
  });
  assert.equal(res.status, 200);
  const stored = JSON.parse(r2.puts.get('brief/2026-08-01.json').body);
  assert.equal(stored.editor_note.length, 500);
});

await testAsync('missing ORBIT_R2 binding is a 503, not a crash', async () => {
  const res = await briefEditPost({ request: briefRequest({ narrative: 'I'.repeat(65) }), env: {} });
  assert.equal(res.status, 503);
});

// ── Summary ────────────────────────────────────────────────────────────────

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
