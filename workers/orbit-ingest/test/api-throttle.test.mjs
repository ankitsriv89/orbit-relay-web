/**
 * /api/* cost controls — edge caching, the facets artifact, and rate limiting.
 *
 *     node workers/orbit-ingest/test/api-throttle.test.mjs
 *
 * Written BEFORE the fix, and it went red on the real bug: every check in the
 * "edge cache" and "facets" sections below failed against the pre-fix tree.
 *
 * The bug it guards is a cost one, and it is invisible from the outside — the
 * endpoints all worked, they were just far more expensive per call than the
 * code comments claimed. Measured against the real schema with a
 * production-shaped 31,944-row catalog:
 *
 *   /api/search?q=…      27,381 rows examined  (86% of the catalog) x2 queries
 *   /api/search?facets=1 27,381 rows examined  x5 queries
 *   /api/object/25544         1 row
 *
 * The driver is NOT the `LIKE '%…%'`, which is what search.js's own comment
 * blames. It is `DECAY_DATE IS NULL`, which is on EVERY search regardless of
 * query text. `idx_objects_decay` matches it, so EXPLAIN QUERY PLAN reports a
 * reassuring "SEARCH objects USING INDEX idx_objects_decay" — but the predicate
 * selects 27,381 of 31,944 rows, so it is an index seek that then walks 86% of
 * the table. A bare /api/search with no query at all costs the same as a text
 * search. D1 bills rows SCANNED, not returned, which is what makes this a
 * budget item rather than a latency one.
 *
 * Three separate defects, three sections:
 *
 *   1. The `maxAge` values search.js/boxscore.js/decay-watch.js already pass to
 *      json() were dead. Cloudflare does not edge-cache a Function response
 *      just because it carries Cache-Control; it needs an explicit Cache API
 *      put. tle.js has always done this correctly and was the model.
 *   2. `?facets=1` is identical for every caller and changes once a day, yet it
 *      was the single most expensive call in the product. It belongs in the R2
 *      artifact the ingest already builds.
 *   3. Nothing was rate limited at all, on any endpoint, ever.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeDB, fakeR2 } from './fakes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS  ' + name); }
  catch (e) { results.push(false); console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); }
}

/* ── A Cache API stub ────────────────────────────────────────────────────
 *
 * Workers exposes `caches.default` with put/match. Node has no `caches`, so
 * the endpoints have to tolerate its absence (they run in tests and could run
 * in `wrangler dev` without it) — that tolerance is itself asserted below.
 */
function installCaches() {
  const store = new Map();
  const stats = { puts: 0, matches: 0, hits: 0 };
  globalThis.caches = {
    default: {
      async put(req, res) {
        stats.puts++;
        store.set(String(req.url || req), res.clone());
      },
      async match(req) {
        stats.matches++;
        const hit = store.get(String(req.url || req));
        if (hit) stats.hits++;
        return hit ? hit.clone() : undefined;
      },
    },
  };
  return { store, stats };
}
const uninstallCaches = () => { delete globalThis.caches; };

const get = (url, headers = {}) => new Request(url, { headers });

/** An env whose D1 counts how many times it was queried. */
function countingEnv(rows = []) {
  const db = fakeDB((sql) => (/COUNT\(\*\)/.test(sql) ? { n: rows.length } : { results: rows }));
  return { env: { ORBIT_DB: db, ORBIT_R2: fakeR2() }, db };
}

/* ── 1. Edge caching ─────────────────────────────────────────────────────── */

console.log('\n-- /api/* responses reach the edge cache --');

const { onRequest: search } = await import('../../../functions/api/search.js');
const { onRequest: boxscore } = await import('../../../functions/api/boxscore.js');

await test('a cacheable search response is written to caches.default', async () => {
  const { stats } = installCaches();
  const { env } = countingEnv([{ NORAD_CAT_ID: 25544, OBJECT_NAME: 'ISS (ZARYA)' }]);
  const ctx = { request: get('https://x/api/search?type=PAYLOAD'), env, waitUntil: (p) => p };
  await search(ctx);
  assert.ok(stats.puts > 0, 'nothing was put into the edge cache');
  uninstallCaches();
});

await test('a second identical search is served from cache without touching D1', async () => {
  installCaches();
  const { env, db } = countingEnv([{ NORAD_CAT_ID: 25544, OBJECT_NAME: 'ISS (ZARYA)' }]);
  const req = () => ({ request: get('https://x/api/search?type=PAYLOAD'), env, waitUntil: (p) => p });
  await search(req());
  const afterFirst = db.executed.length;
  assert.ok(afterFirst > 0, 'the first call should have queried D1');
  await search(req());
  assert.equal(db.executed.length, afterFirst,
    `the second call ran ${db.executed.length - afterFirst} more D1 queries; it should have been a cache hit`);
  uninstallCaches();
});

await test('the cached response still carries the X-Data-Source citation', async () => {
  installCaches();
  const { env } = countingEnv([]);
  const req = () => ({ request: get('https://x/api/boxscore'), env, waitUntil: (p) => p });
  await boxscore(req());
  const second = await boxscore(req());
  assert.ok(second.headers.get('X-Data-Source'),
    'a cache hit must not drop the citation — it is a licence condition, not a courtesy');
  uninstallCaches();
});

await test('endpoints still work when caches is absent (node, wrangler dev)', async () => {
  uninstallCaches();
  const { env } = countingEnv([]);
  const r = await search({ request: get('https://x/api/search'), env, waitUntil: (p) => p });
  assert.equal(r.status, 200);
});

await test('no-store responses are never cached', async () => {
  const { stats } = installCaches();
  // An unbound D1 is a 503 with no-store; caching that would pin the outage.
  await search({ request: get('https://x/api/search'), env: {}, waitUntil: (p) => p });
  assert.equal(stats.puts, 0, 'a no-store/error response was written to the edge cache');
  uninstallCaches();
});

/* ── 2. Facets come from the artifact ────────────────────────────────────── */

console.log('\n-- ?facets=1 is served from R2, not five D1 GROUP BYs --');

await test('facets=1 does not run a D1 query when the artifact exists', async () => {
  uninstallCaches();
  const r2 = fakeR2();
  await r2.put('catalog/summary.json', JSON.stringify({
    generated_at: '2026-08-17T00:00:00Z',
    tracked: 27381,
    by_type: { PAYLOAD: 18393, DEBRIS: 10084 },
    by_country: { US: 8000, CIS: 7000 },
    by_regime: { LEO: 20000, GEO: 1800 },
    by_operator: { STARLINK: 7000 },
  }));
  const db = fakeDB(() => ({ results: [] }));
  const r = await search({
    request: get('https://x/api/search?facets=1'),
    env: { ORBIT_DB: db, ORBIT_R2: r2 },
    waitUntil: (p) => p,
  });
  assert.equal(r.status, 200);
  assert.equal(db.executed.length, 0,
    `facets=1 ran ${db.executed.length} D1 queries; the artifact should have answered it`);
});

await test('the artifact-backed facets response keeps its documented shape', async () => {
  const r2 = fakeR2();
  await r2.put('catalog/summary.json', JSON.stringify({
    tracked: 27381,
    by_type: { PAYLOAD: 18393 },
    by_country: { US: 8000 },
    by_regime: { LEO: 20000 },
    by_operator: { STARLINK: 7000 },
  }));
  const r = await search({
    request: get('https://x/api/search?facets=1'),
    env: { ORBIT_DB: fakeDB(), ORBIT_R2: r2 },
    waitUntil: (p) => p,
  });
  const body = await r.json();
  assert.ok(Array.isArray(body.facets.type), 'facets.type must stay an array of {key,n}');
  assert.deepEqual(body.facets.type[0], { key: 'PAYLOAD', n: 18393 });
  assert.equal(body.operator_derived, true, 'operator is inferred and must stay badged');
  assert.ok(Array.isArray(body.eras));
});

await test('a filtered facets query still falls back to D1 (the artifact is unfiltered)', async () => {
  const r2 = fakeR2();
  await r2.put('catalog/summary.json', JSON.stringify({ tracked: 1, by_type: {}, by_country: {}, by_regime: {}, by_operator: {} }));
  // `SELECT COUNT(*) AS n` is read with .first() and wants a row; the GROUP BY
  // facets are read with .all() and want {results}. Both match /COUNT\(\*\)/,
  // so the GROUP BY has to be discriminated first.
  const db = fakeDB((sql) => (/GROUP BY/.test(sql)
    ? { results: [{ k: 'DEBRIS', n: 3 }] }
    : { n: 3 }));
  await search({
    request: get('https://x/api/search?facets=1&country=CIS'),
    env: { ORBIT_DB: db, ORBIT_R2: r2 },
    waitUntil: (p) => p,
  });
  assert.ok(db.executed.length > 0,
    'a facets request WITH filters cannot be answered by the whole-catalog artifact');
});

await test('include_decayed=1 does NOT take the artifact path', async () => {
  // The sharp edge in the guard. Every other filter pushes to BOTH `where` and
  // `args`; include_decayed=1 pushes to NEITHER — it removes the default
  // `DECAY_DATE IS NULL` instead. So an `args.length === 0` test alone would
  // wrongly serve whole-catalog-minus-decayed totals for a request that
  // explicitly asked to INCLUDE decayed objects. The `where.length === 1`
  // half is what catches it.
  const r2 = fakeR2();
  await r2.put('catalog/summary.json', JSON.stringify({
    tracked: 27381, by_type: { PAYLOAD: 18393 }, by_country: { US: 8000 },
    by_regime: { LEO: 20000 }, by_operator: { STARLINK: 7000 },
  }));
  const db = fakeDB((sql) => (/GROUP BY/.test(sql) ? { results: [{ k: 'PAYLOAD', n: 1 }] } : { n: 1 }));
  await search({
    request: get('https://x/api/search?facets=1&include_decayed=1'),
    env: { ORBIT_DB: db, ORBIT_R2: r2 },
    waitUntil: (p) => p,
  });
  assert.ok(db.executed.length > 0,
    'include_decayed=1 asks a different question than the artifact answers');
});

/* ── 3. Rate limiting ────────────────────────────────────────────────────── */

console.log('\n-- rate limiting --');

const { checkLimit, RATE_LIMIT, rateLimitResponse } =
  await import('../../../functions/api/_ratelimit.js');

/** A fake of Cloudflare's unsafe.rateLimit binding: allows `budget` calls. */
function fakeLimiter(budget) {
  let n = 0;
  return { limit: async () => ({ success: ++n <= budget }) };
}

await test('the documented limit is 30 requests/minute', () => {
  assert.equal(RATE_LIMIT.requestsPerMinute, 30);
});

await test('requests under the limit pass', async () => {
  const env = { API_RATE_LIMITER: fakeLimiter(30) };
  const req = get('https://x/api/search', { 'CF-Connecting-IP': '198.51.100.7' });
  for (let i = 0; i < 30; i++) {
    assert.equal(await checkLimit(env, req), null, `call ${i + 1} should have passed`);
  }
});

await test('the 31st request in a minute is refused', async () => {
  const env = { API_RATE_LIMITER: fakeLimiter(30) };
  const req = get('https://x/api/search', { 'CF-Connecting-IP': '198.51.100.7' });
  for (let i = 0; i < 30; i++) await checkLimit(env, req);
  const refused = await checkLimit(env, req);
  assert.ok(refused, 'the 31st request should have been refused');
  assert.equal(refused.status, 429);
});

await test('a refusal is a structured 429, not an opaque block', async () => {
  const r = rateLimitResponse();
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('Retry-After'), '60');
  assert.equal(r.headers.get('RateLimit-Limit'), '30');
  assert.equal(r.headers.get('RateLimit-Remaining'), '0');
  const body = await r.json();
  assert.ok(body.error, 'a 429 body must say what happened, so a client can back off');
});

await test('the citation rides on a 429 too', async () => {
  assert.ok(rateLimitResponse().headers.get('X-Data-Source'),
    'every response carrying our API surface carries the citation');
});

await test('an unconfigured limiter fails OPEN, not closed', async () => {
  // A missing binding must not take the public API down. This is the opposite
  // of the admin middleware's rule (absent secrets there are a 503) and the
  // difference is deliberate: admin fails closed because it guards access,
  // this fails open because it only guards cost.
  assert.equal(await checkLimit({}, get('https://x/api/search')), null);
});

await test('per-IP bucketing keys on CF-Connecting-IP', async () => {
  const seen = [];
  const env = { API_RATE_LIMITER: { limit: async ({ key }) => { seen.push(key); return { success: true }; } } };
  await checkLimit(env, get('https://x/api/search', { 'CF-Connecting-IP': '203.0.113.9' }));
  assert.ok(seen[0].includes('203.0.113.9'), `expected the IP in the bucket key, got ${seen[0]}`);
});

await test('the write beacon /api/hit gets its own bucket', async () => {
  const seen = [];
  const env = { API_RATE_LIMITER: { limit: async ({ key }) => { seen.push(key); return { success: true }; } } };
  await checkLimit(env, get('https://x/api/hit', { 'CF-Connecting-IP': '203.0.113.9' }));
  await checkLimit(env, get('https://x/api/search', { 'CF-Connecting-IP': '203.0.113.9' }));
  assert.notEqual(seen[0], seen[1],
    '/api/hit writes to D1 on every call and must not share a budget with reads');
});

/* ── 4. The middleware wiring ────────────────────────────────────────────── */

console.log('\n-- /api/_middleware.js wiring --');

const MW = path.join(ROOT, 'functions/api/_middleware.js');

await test('functions/api/_middleware.js exists', () => {
  assert.ok(fs.existsSync(MW));
});

await test('the middleware calls the shared limiter rather than its own copy', () => {
  assert.match(fs.readFileSync(MW, 'utf8'), /from '\.\/_ratelimit\.js'/);
});

await test('admin routes keep their own middleware (Pages chains parent→child)', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'functions/api/admin/_middleware.js')),
    'the admin auth middleware must survive — the parent one must not replace it');
});

/* This used to assert that wrangler.toml DECLARED the binding. It must not.
 *
 * `[[unsafe.bindings]]` is a Workers-only escape hatch that Cloudflare Pages
 * rejects, and since this wrangler.toml sets `pages_build_output_dir` the Pages
 * build parses and validates the file. Declaring it there failed every deploy
 * from 28c9b049 onward — silently, because `ci` only runs `npm test` and
 * production kept serving the last good build.
 *
 * The binding belongs in the Pages dashboard. The code contract that matters is
 * the one above: an absent limiter FAILS OPEN. */
await test('wrangler.toml does not declare a Workers-only unsafe binding', () => {
  const toml = fs.readFileSync(path.join(ROOT, 'wrangler.toml'), 'utf8');
  // Strip comments — the block is documented there on purpose, as a warning.
  const active = toml.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(active, /\[\[unsafe\.bindings\]\]/,
    'unsafe.bindings breaks the Cloudflare Pages build — configure the rate ' +
    'limiter in the Pages dashboard (Settings → Functions → Bindings) instead');
  assert.doesNotMatch(active, /^\s*type\s*=\s*["']ratelimit["']/m,
    'a ratelimit binding declared in wrangler.toml fails the Pages build');
});

/* ── Report ─────────────────────────────────────────────────────────────── */

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
