/**
 * Space-Track client — auth, budget guard, query helpers.
 *
 * Every outbound request in this project goes through `query()`. That is the
 * point: the rate ceiling is enforced in one place, and breaching the
 * documented per-class retrieval rates is grounds for account suspension,
 * which is real and manual to reverse.
 *
 * Auth model (there is no API key — the credentials ARE the secrets):
 *   POST {base}/ajaxauth/login   body: identity=...&password=...
 *   -> session cookie, valid 2 hours, extended another 2h by /app/data/whoami
 * The docs are emphatic that any other login URL fails. Credentials live in
 * Wrangler secrets and no request ever originates from a browser — 10 USC
 * 2274(c)(3) requires each user to hold their own account.
 */

const LOGIN_PATH  = '/ajaxauth/login';
const WHOAMI_PATH = '/app/data/whoami';
const QUERY_PATH  = '/basicspacedata/query';

const COOKIE_KV_KEY = 'spacetrack:cookie';
// Cookies last 2h; expire ours early so a job never starts on one about to die.
const COOKIE_TTL_S  = 90 * 60;

/* ── Budget guard ───────────────────────────────────────────────────────────
 * Documented ceiling is <30 requests/minute and <300/hour. We sit at ~8
 * calls/day in steady state, so anything approaching 25 in an hour means a
 * loop has run away — abort rather than find out by getting suspended.
 */
export const MAX_CALLS_PER_HOUR = 25;

export class BudgetExceededError extends Error {
  constructor(count) {
    super(`Space-Track budget guard: ${count} calls in the last hour ` +
          `(limit ${MAX_CALLS_PER_HOUR}) — aborting before we get suspended.`);
    this.name = 'BudgetExceededError';
  }
}

async function callsInLastHour(env) {
  const since = Date.now() - 3600_000;
  const row = await env.ORBIT_DB
    .prepare('SELECT COUNT(*) AS n FROM api_calls WHERE ts > ?')
    .bind(since)
    .first();
  return row ? row.n : 0;
}

// Logged BEFORE the request is sent, so a request that hangs or throws still
// counts against the budget. A crash that skipped the log would let a retry
// loop spend the whole hourly allowance invisibly.
async function logCallStart(env, cls, url) {
  const res = await env.ORBIT_DB
    .prepare('INSERT INTO api_calls (ts, class, url) VALUES (?, ?, ?)')
    .bind(Date.now(), cls, url)
    .run();
  return res.meta ? res.meta.last_row_id : null;
}

async function logCallEnd(env, id, status, rows, ms) {
  if (id == null) return;
  await env.ORBIT_DB
    .prepare('UPDATE api_calls SET status = ?, rows = ?, ms = ? WHERE id = ?')
    .bind(status, rows, ms, id)
    .run();
}

/* ── Session ────────────────────────────────────────────────────────────── */

function base(env) {
  // Set SPACETRACK_BASE to the test server to move development off production.
  return (env.SPACETRACK_BASE || 'https://www.space-track.org').replace(/\/+$/, '');
}

function readSetCookie(resp) {
  // Workers exposes getSetCookie() on newer runtimes; fall back to the single
  // header. Space-Track returns one session cookie (`chocolatechip`).
  const all = typeof resp.headers.getSetCookie === 'function'
    ? resp.headers.getSetCookie()
    : [resp.headers.get('set-cookie')].filter(Boolean);
  return all
    .map(c => String(c).split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

async function login(env) {
  const identity = env.SPACETRACK_IDENTITY;
  const password = env.SPACETRACK_PASSWORD;
  if (!identity || !password) {
    throw new Error('SPACETRACK_IDENTITY / SPACETRACK_PASSWORD are unset — ' +
                    'run `wrangler secret put` from workers/orbit-ingest/.');
  }

  const url = base(env) + LOGIN_PATH;
  const id  = await logCallStart(env, 'auth', url);
  const t0  = Date.now();

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ identity, password }).toString(),
  });
  await logCallEnd(env, id, resp.status, null, Date.now() - t0);

  if (!resp.ok) {
    throw new Error(`Space-Track login failed: ${resp.status} ${await resp.text()}`);
  }
  const cookie = readSetCookie(resp);
  if (!cookie) throw new Error('Space-Track login returned no session cookie.');

  await env.ORBIT_KV.put(COOKIE_KV_KEY, cookie, { expirationTtl: COOKIE_TTL_S });
  return cookie;
}

/**
 * Cached session cookie. The daily jobs fire at 17:20 and 17:25 specifically so
 * they share one session; the 6-hourly GP run always re-auths because a cookie
 * cannot survive 6 hours.
 */
export async function session(env, { force = false } = {}) {
  if (!force) {
    const cached = await env.ORBIT_KV.get(COOKIE_KV_KEY);
    if (cached) return cached;
  }
  return login(env);
}

/* ── Query ──────────────────────────────────────────────────────────────── */

/**
 * Run one basicspacedata query.
 *
 * @param {object} env
 * @param {string} cls   class name, for the api_calls log and the budget audit
 * @param {string} path  predicate path after /query/, e.g.
 *                       'class/gp/decay_date/null-val/CREATION_DATE/%3Enow-0.28/format/json'
 * @returns {Promise<Array>} parsed JSON rows
 *
 * Always request format/json, never format/tle: TLE format only covers catalog
 * numbers below 100,000 and above that Space-Track emits Alpha-5, which
 * silently corrupts satnum in satellite.js. JSON carries NORAD_CAT_ID as a true
 * integer AND TLE_LINE1/TLE_LINE2 as fields — a reliable join key with no loss.
 */
export async function query(env, cls, path) {
  const count = await callsInLastHour(env);
  if (count >= MAX_CALLS_PER_HOUR) throw new BudgetExceededError(count);

  const url = `${base(env)}${QUERY_PATH}/${path.replace(/^\/+/, '')}`;
  let cookie = await session(env);

  const send = (c) => fetch(url, {
    headers: { Cookie: c, Accept: 'application/json' },
  });

  const id = await logCallStart(env, cls, url);
  const t0 = Date.now();
  let resp = await send(cookie);

  // A cached cookie can be dead early (server-side logout, password change).
  // One forced re-auth, then give up — never loop on auth failures.
  if (resp.status === 401 || resp.status === 403) {
    cookie = await session(env, { force: true });
    resp = await send(cookie);
  }

  const text = await resp.text();
  if (!resp.ok) {
    await logCallEnd(env, id, resp.status, null, Date.now() - t0);
    throw new Error(`Space-Track ${cls} query failed: ${resp.status} ${text.slice(0, 300)}`);
  }

  let rows;
  try {
    rows = JSON.parse(text);
  } catch (_) {
    await logCallEnd(env, id, resp.status, null, Date.now() - t0);
    throw new Error(`Space-Track ${cls} returned non-JSON: ${text.slice(0, 300)}`);
  }
  if (!Array.isArray(rows)) rows = rows ? [rows] : [];

  await logCallEnd(env, id, resp.status, rows.length, Date.now() - t0);
  return rows;
}

/**
 * Streaming variant of `query()`, for responses too large to hold in memory.
 *
 * A 6.7-hour GP delta is not a handful of rows: 18 SPCS regenerates elsets
 * continuously, so most of the ~28k active catalog has a fresh elset in any
 * 6-hour window and the response runs to 10-20 MB. `query()` would buffer that
 * as text AND as ~28k parsed objects — past a Worker's 128 MB ceiling. This
 * returns the live response for `streamJsonRows()` to consume incrementally.
 *
 * The caller MUST call `finish(rowCount)` when the stream is drained, so the
 * api_calls row gets its status and row count. The budget entry itself is
 * already written — as in `query()`, the call is logged before it is sent, so
 * an abandoned stream still counts against the hour.
 *
 * @returns {Promise<{resp: Response, finish: (rows:number) => Promise<void>}>}
 */
export async function queryStream(env, cls, path) {
  const count = await callsInLastHour(env);
  if (count >= MAX_CALLS_PER_HOUR) throw new BudgetExceededError(count);

  const url = `${base(env)}${QUERY_PATH}/${path.replace(/^\/+/, '')}`;
  let cookie = await session(env);

  const send = (c) => fetch(url, {
    headers: { Cookie: c, Accept: 'application/json' },
  });

  const id = await logCallStart(env, cls, url);
  const t0 = Date.now();
  let resp = await send(cookie);

  if (resp.status === 401 || resp.status === 403) {
    cookie = await session(env, { force: true });
    resp = await send(cookie);
  }

  if (!resp.ok) {
    const text = await resp.text();
    await logCallEnd(env, id, resp.status, null, Date.now() - t0);
    throw new Error(`Space-Track ${cls} query failed: ${resp.status} ${text.slice(0, 300)}`);
  }

  return {
    resp,
    finish: (rows) => logCallEnd(env, id, resp.status, rows, Date.now() - t0),
  };
}

/** Extend the current cookie's life; also a cheap liveness check. */
export async function whoami(env) {
  const resp = await fetch(base(env) + WHOAMI_PATH, {
    headers: { Cookie: await session(env) },
  });
  return resp.ok ? resp.json() : null;
}

/* ── Query builders ─────────────────────────────────────────────────────────
 * Kept together so the cadence and its delta window are visibly coupled. THE
 * WINDOW MUST MATCH THE CRON: `now-0.042` is a 1-hour window, so a 6-hour cron
 * using it would silently drop five hours of elsets every run. 0.28 days is
 * 6.72h — the cadence plus overlap margin, and upserts are idempotent, so
 * re-fetching a few rows is free while missing any is not.
 */

/**
 * `Q.gpDelta`/`Q.gpFull` do NOT use a `predicates/` projection — found in
 * production 2026-07-27, at the cost of a real full-catalog call. A
 * `predicates/` projection on `class/gp` with `format/json`, even one that
 * explicitly lists TLE_LINE0/TLE_LINE1/TLE_LINE2, comes back with those three
 * fields simply absent — not empty strings, not a 400, just missing — for
 * every one of ~31,600 seeded rows. `TLE_LINE1`/`2` are synthesized by
 * Space-Track from the numeric elements rather than stored columns, and the
 * modeldef listing them (`fixtures/modeldef_gp.json`) does not guarantee they
 * survive a predicates-narrowed response the way real columns do.
 * `fixtures/sample_gp.json` — captured as a FULL, unfiltered response — has
 * always carried them, which is exactly why every unit suite passed while
 * production silently broke: nothing exercised the narrowed shape.
 *
 * `GP_PREDICATES` (derive.js) stays exported and schema-tested — still useful
 * documentation of the columns this project stores from GP, and other classes
 * may adopt a real `predicates/` projection later — but GP itself always takes
 * the full record. `p` is accepted and ignored so call sites need no change.
 */
export const Q = {
  gpDelta:    (_p) => `class/gp/decay_date/null-val/CREATION_DATE/%3Enow-0.28/format/json`,
  gpFull:     (_p) => `class/gp/decay_date/null-val/epoch/%3Enow-10/format/json`,
  satcatFrom: (file) => `class/satcat/CURRENT/Y/FILE/%3E${file}/format/json`,
  decayDaily: () => 'class/decay/MSG_EPOCH/%3Enow-1/format/json',
  decay60Day: () => 'class/decay/MSG_EPOCH/%3Enow-8/source/60day_msg/format/json',
  boxscore:   () => 'class/boxscore/format/json',
  tipRecent:  () => 'class/tip/INSERT_EPOCH/%3Enow-0.042/format/json',
  // ~60 static rows, SITE_CODE -> LAUNCH_SITE. Queried weekly (plan 38 task 2)
  // via the plain, unfiltered class query since the whole table is small and
  // effectively static — there is no delta cursor worth maintaining.
  launchSites: () => 'class/launch_site/format/json',
  // GP_HISTORY is 1/lifetime and we never query it. Listed so the omission
  // reads as deliberate rather than forgotten.
};
