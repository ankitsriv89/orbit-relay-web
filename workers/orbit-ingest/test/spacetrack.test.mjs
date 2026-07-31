/**
 * spacetrack.js unit tests — no network, no wrangler, no dependencies.
 *
 *     node workers/orbit-ingest/test/spacetrack.test.mjs
 *
 * The point of this file is the budget guard. Everything else here is
 * scaffolding to let that be asserted honestly: the plan's rule is "feed it a
 * fixture that would trigger 40 calls, confirm it aborts", because a runaway
 * loop must not be able to get the Space-Track account suspended.
 *
 * D1 and KV are faked rather than mocked wholesale — the fake D1 really counts
 * rows, so the guard is exercised against real arithmetic, not a stubbed
 * return value that would pass even if the query were wrong.
 */
import assert from 'node:assert/strict';

const { query, session, Q, MAX_CALLS_PER_HOUR, BudgetExceededError } =
  await import('../src/spacetrack.js');
const { GP_PREDICATES } = await import('../src/derive.js');

/* ── Fakes ──────────────────────────────────────────────────────────────── */

function fakeDB() {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...a) { args = a; return stmt; },
        async first() {
          if (/COUNT\(\*\)/i.test(sql)) {
            const since = args[0];
            return { n: calls.filter(c => c.ts > since).length };
          }
          return null;
        },
        async run() {
          if (/^INSERT INTO api_calls/i.test(sql)) {
            calls.push({ id: calls.length + 1, ts: args[0], class: args[1], url: args[2] });
            return { meta: { last_row_id: calls.length } };
          }
          if (/^UPDATE api_calls/i.test(sql)) {
            const row = calls.find(c => c.id === args[3]);
            if (row) Object.assign(row, { status: args[0], rows: args[1], ms: args[2] });
            return { meta: {} };
          }
          return { meta: {} };
        },
      };
      return stmt;
    },
  };
}

function fakeKV() {
  const m = new Map();
  return {
    store: m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, v); },
  };
}

function makeEnv(over = {}) {
  return {
    ORBIT_DB: fakeDB(),
    ORBIT_KV: fakeKV(),
    SPACETRACK_IDENTITY: 'someone@example.com',
    SPACETRACK_PASSWORD: 'hunter2',
    ...over,
  };
}

/** Records every fetch and replies from a scripted handler. */
function installFetch(handler) {
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), init });
    return handler(String(url), init, seen.length);
  };
  return seen;
}

function jsonResp(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

function loginResp() {
  return new Response('""', {
    status: 200,
    headers: { 'set-cookie': 'chocolatechip=abc123; Path=/; HttpOnly' },
  });
}

/* ── Runner ─────────────────────────────────────────────────────────────── */

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(true);
    console.log('  PASS  ' + name);
  } catch (e) {
    results.push(false);
    console.log('  FAIL  ' + name + '\n        ' + (e && e.message));
  }
}

/* ── Tests ──────────────────────────────────────────────────────────────── */

console.log('\n-- auth --');

await test('login POSTs identity/password to /ajaxauth/login and caches the cookie', async () => {
  const env = makeEnv();
  const seen = installFetch((url) =>
    url.endsWith('/ajaxauth/login') ? loginResp() : jsonResp([]));

  const cookie = await session(env);

  assert.equal(seen.length, 1);
  assert.ok(seen[0].url.endsWith('/ajaxauth/login'), seen[0].url);
  assert.equal(seen[0].init.method, 'POST');
  const body = new URLSearchParams(seen[0].init.body);
  assert.equal(body.get('identity'), 'someone@example.com');
  assert.equal(body.get('password'), 'hunter2');
  assert.equal(cookie, 'chocolatechip=abc123');
  assert.equal(await env.ORBIT_KV.get('spacetrack:cookie'), 'chocolatechip=abc123');
});

await test('a cached cookie is reused instead of re-authenticating', async () => {
  const env = makeEnv();
  await env.ORBIT_KV.put('spacetrack:cookie', 'chocolatechip=cached');
  const seen = installFetch(() => jsonResp([{ NORAD_CAT_ID: 25544 }]));

  await query(env, 'gp', Q.gpDelta());

  assert.equal(seen.filter(s => s.url.includes('/ajaxauth/login')).length, 0);
  assert.equal(seen[0].init.headers.Cookie, 'chocolatechip=cached');
});

await test('missing secrets fail with an actionable message, not a 401 loop', async () => {
  const env = makeEnv({ SPACETRACK_IDENTITY: undefined, SPACETRACK_PASSWORD: undefined });
  installFetch(() => jsonResp([]));
  await assert.rejects(() => session(env), /wrangler secret put/);
});

await test('a dead cached cookie triggers exactly ONE re-auth, never a loop', async () => {
  const env = makeEnv();
  await env.ORBIT_KV.put('spacetrack:cookie', 'chocolatechip=stale');
  // Every query 401s — a naive retry would spin forever and burn the budget.
  const seen = installFetch((url) =>
    url.includes('/ajaxauth/login') ? loginResp() : jsonResp({ error: 'nope' }, 401));

  await assert.rejects(() => query(env, 'gp', Q.gpDelta()));

  assert.equal(seen.filter(s => s.url.includes('/ajaxauth/login')).length, 1);
  assert.equal(seen.filter(s => s.url.includes('/basicspacedata/')).length, 2);
});

console.log('\n-- budget guard --');

await test(`aborts once ${MAX_CALLS_PER_HOUR} calls are logged in the rolling hour`, async () => {
  const env = makeEnv();
  await env.ORBIT_KV.put('spacetrack:cookie', 'chocolatechip=cached');
  const seen = installFetch(() => jsonResp([]));

  // The plan's fixture: a loop that would make 40 calls.
  let made = 0, aborted = null;
  for (let i = 0; i < 40; i++) {
    try { await query(env, 'gp', Q.gpDelta()); made++; }
    catch (e) { aborted = e; break; }
  }

  assert.ok(aborted instanceof BudgetExceededError, `expected abort, got ${aborted}`);
  assert.equal(made, MAX_CALLS_PER_HOUR);
  assert.equal(seen.length, MAX_CALLS_PER_HOUR, 'no request may be sent after the abort');
});

await test('calls that fall outside the rolling hour do not count', async () => {
  const env = makeEnv();
  await env.ORBIT_KV.put('spacetrack:cookie', 'chocolatechip=cached');
  installFetch(() => jsonResp([]));

  // 30 calls, all logged 2 hours ago — the window is rolling, not cumulative.
  const old = Date.now() - 2 * 3600_000;
  for (let i = 0; i < 30; i++) {
    env.ORBIT_DB.calls.push({ id: i + 1, ts: old, class: 'gp', url: 'x' });
  }
  await query(env, 'gp', Q.gpDelta());   // must not throw
});

await test('the call is logged BEFORE it is sent, so a thrown request still counts', async () => {
  const env = makeEnv();
  await env.ORBIT_KV.put('spacetrack:cookie', 'chocolatechip=cached');
  installFetch(() => { throw new Error('network died'); });

  await assert.rejects(() => query(env, 'gp', Q.gpDelta()), /network died/);
  assert.equal(env.ORBIT_DB.calls.length, 1,
               'a request that throws must still consume budget');
});

console.log('\n-- queries --');

await test('SPACETRACK_BASE switches every request to the test server', async () => {
  const env = makeEnv({ SPACETRACK_BASE: 'https://test.space-track.example' });
  const seen = installFetch((url) =>
    url.includes('/ajaxauth/login') ? loginResp() : jsonResp([]));

  await query(env, 'gp', Q.gpDelta());

  assert.ok(seen.every(s => s.url.startsWith('https://test.space-track.example')),
            seen.map(s => s.url).join('\n'));
});

await test('every GP query asks for JSON, never the Alpha-5-lossy TLE format', () => {
  for (const build of [Q.gpDelta, Q.gpFull]) {
    const p = build();
    assert.ok(p.includes('format/json'), p);
    assert.ok(!p.includes('format/tle'), p);
  }
});

await test('the GP delta window matches the 6-hourly cron, not the 1-hour example', () => {
  // now-0.042 is a 1-HOUR window. Using it on a 6-hour cron silently drops
  // five hours of elsets every run — the failure is invisible in the data.
  const p = Q.gpDelta();
  assert.ok(p.includes('CREATION_DATE/%3Enow-0.28'), p);
  assert.ok(!p.includes('now-0.042'), p);
});

await test('GP queries filter to on-orbit objects (decay_date/null-val)', () => {
  assert.ok(Q.gpDelta().includes('decay_date/null-val'));
  assert.ok(Q.gpFull().includes('decay_date/null-val'));
});

await test('GP queries never use a predicates/ projection, even if one is passed', () => {
  // Found in production 2026-07-27: a predicates/ projection on class/gp with
  // format/json comes back with TLE_LINE0/1/2 simply absent, even when they
  // are explicitly listed — not a 400, not empty strings, just missing. Every
  // one of ~31,600 seeded rows landed with TLE_LINE1/2 NULL, which silently
  // broke every group bundle and the source=spacetrack /api/tle path. GP_
  // PREDICATES is still exported for its schema-vs-modeldef test, but it must
  // never reach the GP query string — passing it here proves that even a
  // caller mistake can't reintroduce the bug.
  const withArg = Q.gpDelta(GP_PREDICATES);
  assert.ok(!withArg.includes('predicates/'), withArg);
  assert.equal(withArg, Q.gpDelta());

  const fullWithArg = Q.gpFull(GP_PREDICATES);
  assert.ok(!fullWithArg.includes('predicates/'), fullWithArg);
  assert.equal(fullWithArg, Q.gpFull());
});

await test('GP_HISTORY is never queried (1/lifetime)', () => {
  const all = Object.values(Q).map(f => (f.length ? f(1) : f())).join(' ');
  assert.ok(!/gp_history/i.test(all), all);
});

/* ── Summary ────────────────────────────────────────────────────────────── */

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
