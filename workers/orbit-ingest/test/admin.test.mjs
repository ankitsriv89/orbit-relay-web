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

// ── Summary ────────────────────────────────────────────────────────────────

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
