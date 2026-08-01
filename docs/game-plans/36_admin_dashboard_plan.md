# Admin Dashboard for Orbital Relay

## Context

`orbitalrelay.space` runs 8 public routes, 9 Pages Functions over D1 + R2, and an ingest
pipeline scheduled by GitHub Actions — and there is currently **no way to observe any of
it**. Concretely:

- The ingest run report (`{job, ok, steps[], total_ms, d1_requests, r2_puts}`) is
  `console.log`'d by `scheduled()` and **never persisted**. Since Actions is the real
  scheduler, even that stdout is in the wrong place. A failed nightly ingest is invisible
  until someone notices stale data.
- **Nothing records visitors.** `functions/api/telemetry.js` was deleted in `695bcaea`;
  no gtag, no Plausible, no beacon. There is zero traffic data.
- Inspecting D1 means `wrangler d1 execute` from a terminal with credentials.
- There is **no auth anywhere** in the repo — every `/api/*` route is public with
  `Access-Control-Allow-Origin: *`.

The outcome: a password-protected `/admin/` dashboard that surfaces cron/ingest health,
visitor analytics, a read-only SQL console, and system health — built so that **adding a
new panel later is one new file plus one line in a registry**, and usable on a phone.

---

## Decisions already made

1. **Auth** — single `ADMIN_PASSWORD` secret; `POST /api/admin/login` returns an HttpOnly
   HMAC-signed cookie. Stateless, no session table.
2. **Visitors** — *both* a self-hosted beacon → new D1 `page_views` table, *and* a
   Cloudflare GraphQL Analytics proxy, shown side by side.
3. **DB** — read-only SQL console (arbitrary `SELECT`, non-`SELECT` rejected, row cap).
4. **Cron** — persist run reports to a new D1 `ingest_runs` table.

---

## Two facts verified against the working tree

**1. The e2e panel-selector gap — FIXED 2026-08-01, before build start.**
`test_mobile_dom.py:53` and `test_mobile_responsive.py:90,243` select
`[id$="-hud"].key-hud`, but no element carried a bare `key-hud` class — only
`key-hud--collapsed`/`-toggle`/`-body`. Those assertions were vacuous.

Fixed by adding the bare class to all 15 panels across 7 HTML files
(`orbital-hud key-hud key-hud--collapsed`). Purely additive: no CSS rule and no JS
anywhere targets bare `.key-hud`, so it is visually inert. Two latent test bugs surfaced
once the previously-dead code paths started executing, and were also fixed:

- Both suites' failure-summary loops unpacked 3-tuples from a `check()` that appends
  2-tuples — they crashed with `ValueError` *after* printing the count.
- `test_mobile_dom.py` used `wait_until='commit'` + `sleep(1)`; at that point
  `document.readyState` is still `loading` and `document.body` is `null`, so
  `getComputedStyle(document.body)` threw. Now `domcontentloaded` (both mobile and tablet
  paths), which still does not wait for the Cesium CDN.

Baselines: `test_mobile_dom` **16/20 → 31/33**; `test_mobile_responsive` **108/122 →
131/140**.

**Remaining known-red, pre-existing and unrelated to the admin work** — do not mistake
these for regressions:
- `/orbit/` has genuinely only **2** HUD panels (`iss-hud`, `layers-hud`) against an
  assertion of `>= 3` (7 failures across the two suites). A test-expectation question, not
  a page defect — left as-is deliberately rather than loosening the assertion.
- `/orbit/` Cesium `resolutionScale` on 2 mobile viewports.
- `/spacetrack/` "citation visible" on the 2 phone viewports.

→ `/admin/` panels must therefore carry **both** classes to be seen by these suites.

**2. `.dev.vars` is not in `.gitignore`.** It has `.env` and `.env.local` but no
`.dev.vars`. This is the highest-consequence line in the whole plan.

Also confirmed: `wireHudToggle`'s `exclusive` only branches on `'always'` / `'mobile'`
([hud.js:58](public/shared/hud.js#L58)), so passing `'never'` yields non-exclusive
behaviour correctly. `body.hud-panel-open .key-hud--collapsed { display: none }` lives in
[spacetrack.css:963](public/spacetrack/spacetrack.css#L963) — which `/admin/` will not
link, so it cannot bite us.

---

## File manifest

**New — Pages Functions**

| Path | Purpose |
|---|---|
| `functions/api/_admin.js` | HMAC sign/verify, cookie helpers, `adminJson()`. Underscore = not routed. |
| `functions/api/admin/_middleware.js` | The single auth gate for `/api/admin/*`. |
| `functions/api/admin/login.js` / `logout.js` | Password → cookie; expire cookie. |
| `functions/api/admin/query.js` | Read-only SQL console. |
| `functions/api/admin/runs.js` | Ingest run history from `ingest_runs`. |
| `functions/api/admin/visitors.js` | First-party `page_views` aggregates. |
| `functions/api/admin/cf-analytics.js` | Cloudflare GraphQL proxy. |
| `functions/api/admin/health.js` | Table counts, `api_calls` budget, artifact freshness. |
| `functions/api/hit.js` | Public pageview beacon. **Not** under `/admin/`. |

**New — frontend** (`public/admin/`): `index.html`, `admin.css`, `admin.js`,
`registry.js`, `api.js`, and `panels/{health,runs,visitors,cf,sql}.js`.
Plus `public/js/beacon.js`.

**Changed:** `d1/orbit.sql` (append), `workers/orbit-ingest/src/index.js`,
`workers/orbit-ingest/scripts/run-ingest.mjs`, `workers/orbit-ingest/package.json`
(test script is an explicit `&&` chain — a new test file is **not** auto-discovered),
`public/_headers`, `public/_redirects`, `.gitignore`, and 8 × `index.html` (one beacon
line each).

---

## Build sequence

Ordering is forced by `scripts/check/resolve.mjs`: an HTML `href` to a directory fails
unless that directory has an `index.html`, and every `src` must exist on disk. So targets
are created before referrers.

1. **Schema** — append to `d1/orbit.sql`; extend `test/schema.test.mjs`.
2. **`_admin.js` + `test/admin.test.mjs`** — pure functions, testable with no bindings.
   **Write the SQL-guard tests first and watch them go red** against a naive
   `startsWith('select')` (CLAUDE.md requires seeing a guardrail fail on the real bug).
3. **`_middleware.js` + `login.js` + `logout.js`** — verify with `curl`.
4. **Shell** (`index.html`, `admin.css`, `admin.js`, `registry.js`) with **one** panel.
   Get the mobile layout right before adding five.
5. **`health.js` + `panels/health.js`** — proves the registry round-trip.
6. **`query.js` + `panels/sql.js`.**
7. **`ingest_runs` write path** → `runs.js` + `panels/runs.js`.
8. **Beacon**: `hit.js` → `public/js/beacon.js` → the 8 HTML edits → `visitors.js` +
   `panels/visitors.js`.
9. **CF GraphQL proxy** last — only piece with an external dependency.
10. **`_headers` / `_redirects` / `.gitignore`**, then `npm test`, then mobile checks.

---

## 1. Auth (`functions/api/_admin.js`)

Cookie value `v1.<b64url(payload)>.<b64url(hmac)>`, payload `{sub, iat, exp}`, 12h TTL,
HMAC-SHA256 via `crypto.subtle` with key from `ADMIN_SECRET`.

```js
export async function verifyToken(env, token) {
  if (!env?.ADMIN_SECRET || typeof token !== 'string') return null;
  const [v, p, s] = token.split('.');
  if (v !== 'v1' || !p || !s) return null;
  let bytes, sig;
  try { bytes = b64uDecode(p); sig = b64uDecode(s); } catch (_) { return null; }
  // crypto.subtle.verify IS the constant-time compare — no hand-rolled one needed.
  if (!await crypto.subtle.verify('HMAC', await key(env.ADMIN_SECRET), sig, bytes)) return null;
  let claims;
  try { claims = JSON.parse(new TextDecoder().decode(bytes)); } catch (_) { return null; }
  // Expiry is checked ONLY after the signature verifies — an unsigned payload's exp
  // is attacker-controlled and must never influence control flow.
  if (typeof claims?.exp !== 'number' || claims.exp < Date.now()) return null;
  return claims;
}
```

The **password** compare does need constant time (raw secret): HMAC both sides under the
same key and XOR-compare the two 32-byte digests.

Cookie: `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200`. `Strict` is right —
`/admin/` is only reached by typing the URL, and it is the cheapest CSRF defence for the
`POST` endpoints.

**Do not reuse `json()` from [_catalog.js:23](functions/api/_catalog.js#L23)** — it
hardcodes `Access-Control-Allow-Origin: *`, which is incompatible with credentialed
requests. `_admin.js` gets its own `adminJson()` with **no CORS headers** and
`Cache-Control: no-store`. Same-origin only, which is exactly what we want.

### Middleware, not per-file guards

Per-file guards **fail open** — a new endpoint added later with a forgotten guard is
silently public. The middleware fails closed. Lockout is avoided by an explicit allowlist
inside the gate rather than by moving `login.js` out of the directory:

```js
// functions/api/admin/_middleware.js
const PUBLIC = new Set(['/api/admin/login', '/api/admin/logout']);

export async function onRequest(context) {
  const { request, env, next } = context;
  const { pathname } = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });

  // Misconfiguration is a 503, never an open door. This precedes the allowlist
  // deliberately: absent secrets must not degrade to "no auth required".
  if (!env.ADMIN_SECRET || !env.ADMIN_PASSWORD) {
    return adminJson({ error: 'Admin is not configured on this deployment.' }, 503);
  }
  if (PUBLIC.has(pathname)) return next();

  const claims = await verifyToken(env, readCookie(request, 'orbit_admin'));
  if (!claims) return adminJson({ error: 'unauthorized' }, 401);
  context.data.admin = claims;
  return next();
}
```

**Protect only the API, not the static HTML.** Pages serves `public/**` before Functions
routing; a `functions/admin/_middleware.js` would put auth on the static-asset path and
risks locking out the login page itself. The shell renders nothing until
`/api/admin/health` returns 200, so an unauthenticated visitor sees a login form and
nothing else. Trust boundary stays in exactly one file. Consequence: the shell must
contain **no secrets** — no zone IDs, no canned queries leaking anything not already in
the committed `d1/orbit.sql`.

---

## 2. SQL console safety (`functions/api/admin/query.js`)

A **whitelist of shape**, not a blacklist of keywords. Threats the naive checks miss:
`SELECT 1; DROP TABLE objects` (multi-statement — `env-node.mjs`'s `exec()` documents
batches, so the HTTP path definitely runs them); `/*x*/DELETE …`;
`WITH t AS (SELECT 1) DELETE …` (starts with `WITH`, which CTEs legitimately need);
`PRAGMA writable_schema=ON`; `ATTACH DATABASE`; `SELECT load_extension(…)`;
`INSERT INTO t SELECT …`.

```js
/** Strip comments and string literals so keywords cannot hide inside either. */
export function stripNoise(sql) { /* --, /*…*​/, '…'/"…" → ' ?? ' placeholder */ }

export function guardSelect(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'empty query' };
  if (raw.length > 4000) return { ok: false, reason: 'query too long (4000 char cap)' };
  const bare = stripNoise(raw).trim().replace(/;\s*$/, '');   // one trailing ; allowed
  if (bare.includes(';')) return { ok: false, reason: 'multiple statements are not allowed' };
  if (!/^\s*(select|with)\b/i.test(bare)) return { ok: false, reason: 'only SELECT (or WITH…SELECT)' };
  const m = FORBIDDEN.exec(bare);   // insert|update|delete|drop|alter|create|replace|
  if (m) return { ok: false, reason: `forbidden keyword: ${m[1].toUpperCase()}` };
  return { ok: true, sql: bare };   // truncate|attach|detach|pragma|vacuum|reindex|
}                                   // analyze|begin|commit|rollback|savepoint|release|
                                    // grant|revoke|load_extension|writable_schema
```

`WITH … DELETE` is caught because `DELETE` is in `FORBIDDEN`, and a literal `'delete'`
inside a string cannot false-positive because strings are already blanked.

**Row cap:** wrap — `SELECT * FROM (${sql}) LIMIT ${ROW_CAP + 1}` with `ROW_CAP = 500`.
Appending `LIMIT` to a query that already has one is a syntax error, and parsing to detect
one is a losing game. The `+1` lets the response report `truncated: true` honestly. Time
with `Date.now()` around `.all()`.

**There is no timeout, and the code should say so** rather than implying one. D1 exposes no
per-query timeout and Workers cannot cancel an in-flight D1 call. Mitigation is the row
cap + char cap + the fact that this is behind auth.

---

## 3. Beacon

**Record:** `ts`, `path`, `referrer` (**origin only** — never the full third-party URL),
`country` (`request.cf.country`), `ip_hash`, `ua_class` (bucketed
`mobile|tablet|desktop|bot`, never the raw UA).

**IP hashing — daily-rotating salt, derived not stored:**
`SHA-256(dayStamp | ip | ADMIN_SECRET)` truncated to 8 bytes. Daily rotation supports
"uniques today" while being deliberately **not** correlatable across days — the property
that makes this defensible without a cookie banner.

**Write-per-pageview is fine at this traffic level** (D1 free tier: 100k writes/day).
Batching would need a Durable Object or Queue, neither bound to this Pages project. Do
the cheap things instead: `ctx.waitUntil()` the insert and return `204` immediately, and
early-return on `ua_class === 'bot'`. Put the ceiling and the sampling lever
(`Math.random() < 1/N`) in a comment for whoever hits it.

**`public/js/beacon.js`** — no imports, entire body in `try/catch`. Per CLAUDE.md a
throwing module executes zero further statements, and this file lands on all 8 pages at
once; a bug here is an 8-page outage.

```js
try {
  if (!navigator.webdriver) {
    const body = JSON.stringify({
      path: location.pathname,
      ref: document.referrer ? new URL(document.referrer).origin : '',
    });
    if (navigator.sendBeacon) navigator.sendBeacon('/api/hit', new Blob([body], { type: 'application/json' }));
    else fetch('/api/hit', { method: 'POST', body, keepalive: true, headers: { 'Content-Type': 'application/json' } });
  }
} catch (_) { /* analytics must never break a page */ }
```

Create the file **before** the 8 HTML edits or `check:resolve` fails.

---

## 4. Schema — append to `d1/orbit.sql`

**Append, don't add a migration directory.** The repo's convention is one re-runnable
`IF NOT EXISTS` file applied with `wrangler d1 execute orbit-catalog --remote --file
d1/orbit.sql`. A second mechanism would have no runner.

```sql
CREATE TABLE IF NOT EXISTS page_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL, path TEXT NOT NULL, referrer TEXT,   -- referrer: ORIGIN only
  country TEXT, ip_hash TEXT, ua_class TEXT
);
CREATE INDEX IF NOT EXISTS idx_page_views_ts   ON page_views(ts DESC);
CREATE INDEX IF NOT EXISTS idx_page_views_path ON page_views(path);

CREATE TABLE IF NOT EXISTS ingest_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,          -- epoch ms, run START
  job TEXT NOT NULL, ok INTEGER NOT NULL,
  total_ms INTEGER, d1_requests INTEGER, r2_puts INTEGER,
  source TEXT,                  -- actions | worker-cron | manual
  steps TEXT                    -- report.steps[], JSON
);
CREATE INDEX IF NOT EXISTS idx_ingest_runs_ts ON ingest_runs(ts DESC);
```

---

## 5. Persisting the ingest report

One `recordRun(env, report, source)` in `workers/orbit-ingest/src/index.js`:

```js
// Failure here must NEVER fail the run: losing a log row beats losing an ingest.
// steps is JSON.stringify'd explicitly because env-node.mjs's sqlLiteral() throws
// on a non-string object — which would fail the Actions path ONLY.
export async function recordRun(env, report, source = 'worker-cron') {
  if (!env?.ORBIT_DB) return;
  try {
    await env.ORBIT_DB.prepare(
      `INSERT INTO ingest_runs (ts, job, ok, total_ms, d1_requests, r2_puts, source, steps)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(Date.now() - (report.total_ms || 0), String(report.job || 'unknown'),
           report.ok ? 1 : 0, report.total_ms ?? null, report.d1_requests ?? null,
           report.r2_puts ?? null, source, JSON.stringify(report.steps || [])).run();
  } catch (err) { console.error('[orbit-ingest] recordRun failed:', err); }
}
```

Three call sites: `scheduled()` (`worker-cron`), `POST /run` (`manual`), and — the one
that actually matters, since Actions is the real scheduler —
`scripts/run-ingest.mjs` (`actions`), **after** `total_ms`/`d1_requests`/`r2_puts` are
assigned and `await`ed **before** `process.exit()` (which does not flush pending promises).

**Next-due** is computed client-side from the **Actions** crons (`17 */6 * * *`,
`35 17 * * *`, `40 17 * * 3`) — not `wrangler.toml`'s, which are documented as
deployable-and-unused and would display a schedule that never fires.

---

## 6. Extensibility: the panel registry

```js
/**
 * @typedef {object} AdminPanel
 * @property {string} id           DOM id becomes `${id}-hud`
 * @property {string} title        rendered as `// ${title}`
 * @property {number} [order]      sort key
 * @property {boolean} [open]      start expanded on desktop (never mobile)
 * @property {() => Promise<any>} [load]
 * @property {(el, data, ctx) => void} render   ctx = { reload() }
 * @property {number} [refreshMs]
 */
```

```js
// public/admin/registry.js — adding a panel is ONE new file + ONE line here
import health from './panels/health.js';
/* … */
export const PANELS = [health, runs, visitors, cf, sql];
```

The shell (`admin.js`) sorts the registry, builds each panel's DOM with
`document.createElement` (never `innerHTML` — repo rule), appends to
`<main id="admin-panels">`, and calls
`wireHudToggle(hudId, toggleId, bodyId, { exclusive: 'never' })`. `'never'` is correct
because this page is a scrolling column, not fixed corners — panels cannot overlap, so a
mobile accordion would only hide data. Add `'never'` to `wireHudToggle`'s JSDoc so the
intent survives the next refactor (the code already handles it).

Each panel gets **both** classes: `orbital-hud key-hud key-hud--collapsed`. `load()`
errors are caught per-panel and rendered as an `.st-hint` — **one panel's failure must not
blank the dashboard**.

---

## 7. Mobile layout & CSS

**Link `/css/tokens.css` + `/css/chrome.css` + `./admin.css` — NOT `orbit.css` +
`spacetrack.css`.** Three concrete reasons:

1. `.orbital-hud` is `position: fixed` ([orbit.css:72](public/orbit/orbit.css#L72)), and
   corner placement comes from hand-written `body[data-page-id=…] #x-hud` lists at
   [spacetrack.css:57-131](public/spacetrack/spacetrack.css#L57-L131). Panels here have
   **runtime ids from the registry**, so they can never appear in those lists — they'd all
   stack at the viewport origin.
2. Fixing that means editing four long selector lists per new panel — the exact
   copy-paste the extensibility requirement rules out.
3. `/admin/` needs `position: static` in a scrolling column, the opposite of the
   `.orbital-hud` premise.

`admin.css` re-declares the handful of HUD *visual* rules it needs, scoped under
`body[data-page-id="admin"]`, with `position: static; width: 100%`. This duplicates some
CSS; comment the trade-off. Values stay shared via `tokens.css`. Layout: a single
`flex-direction: column` scrolling list, `max-width: 900px`, padded with `var(--sa-*)`
insets. Touch targets **≥44px** (note `.st-btn` is only 36px in `spacetrack.css` — do not
copy that value). Wide content (SQL results) scrolls in its own `overflow-x: auto`
container.

**On the e2e contract:** `/admin/` legitimately scrolls vertically, so it violates the
`body overflow hidden` / `no page scroll` assertions that encode the *globe-page*
contract. **Do not add `/admin/` to the `PAGES` dict** in `test_mobile_dom.py` /
`test_mobile_responsive.py` (the landing page isn't there either). Add a new
`tests/e2e/test_admin_mobile.py` asserting the contract that applies: ≥3 panels matching
`[id$="-hud"].key-hud`, all collapsed at 390px, **no horizontal** scroll
(`scrollWidth <= innerWidth`), touch targets ≥44px, login form reachable. Never force
`overflow: hidden` on `/admin/` to satisfy a test written for a different page type.

---

## 8. CF GraphQL proxy

`POST https://api.cloudflare.com/client/v4/graphql`,
`Authorization: Bearer ${env.CLOUDFLARE_ANALYTICS_TOKEN}`. Query
`zones(filter:{zoneTag}) { httpRequests1dGroups(...) { dimensions{date} sum{requests
pageViews bytes threats} uniq{uniques} } }` — `httpRequests1dGroups` is the
free-plan dataset (`httpRequestsAdaptiveGroups` needs a paid plan).

Secrets: `CLOUDFLARE_ANALYTICS_TOKEN` (Analytics:Read only — deliberately **not** the
Actions `CLOUDFLARE_API_TOKEN`, which carries `D1:Edit` and must never reach a Pages
Function) and `CLOUDFLARE_ZONE_ID`. Degrade to a rendered `.st-hint` on permission errors;
this is the only externally-dependent panel and must not take the dashboard down.

---

## 9. Headers, redirects, nav

```
# _headers, above the global /* block
/admin/*
  Cache-Control: no-store, no-cache, must-revalidate
  X-Robots-Tag: noindex, nofollow, noarchive
  Referrer-Policy: no-referrer
/api/admin/*
  Cache-Control: no-store, no-cache, must-revalidate
  X-Robots-Tag: noindex, nofollow
```
`_redirects`: `/admin  /admin/  301`.

**Do not add `/admin/` to the public nav.** Per AGENTS.md every nav change must touch both
the desktop `ul` and the mobile drawer (and the bottom nav) on every page — 21 edits to
advertise a login form. Reach it by typing the URL. `/admin/` gets its own minimal nav (a
`◂ HOME` brand link and a logout button).

`resolve.mjs` still requires `public/admin/index.html` to link **at least one stylesheet
that resolves** (`/css/tokens.css`) and every one of its own `src`/`href` to exist —
so all five `panels/*.js` must exist before `npm test` passes.

---

## Verification

1. `npm test` — `check:syntax` + `check:resolve` cover all new JS and HTML. **Add
   `test/admin.test.mjs` to `workers/orbit-ingest/package.json`'s `test` script** — it is
   an explicit `&&` chain, not a glob.
2. `admin.test.mjs` must cover: `guardSelect` rejects every threat row in §2;
   `stripNoise` blanks comments and strings; `mintToken`/`verifyToken` round-trip;
   tampered signature fails; expired token fails; token signed with a different secret
   fails. **Written before the endpoint, and seen red.**
3. **`.dev.vars` at the repo root** (next to `wrangler.toml`, not in `public/`) with
   `ADMIN_PASSWORD`, `ADMIN_SECRET`, `CLOUDFLARE_ANALYTICS_TOKEN`, `CLOUDFLARE_ZONE_ID`
   — **and `.dev.vars` + `.dev.vars.*` added to `.gitignore` in the same commit.**
4. `npm run dev`, then: `curl -X POST localhost:8788/api/admin/login -d '{"password":"…"}'`
   → cookie; an admin endpoint without the cookie → 401; with it → 200. Load `/admin/`,
   console clean.
5. **390×844**, plus 412×915, 820×1180, 1133×744 (landscape — the column must still
   scroll), 1400×900: all panels collapsed, title bars ≥44px, no horizontal scroll, SQL
   grid scrolls inside itself, login usable with a mobile keyboard.
6. Deploy secrets with
   `wrangler pages secret put ADMIN_PASSWORD --project-name orbit-relay-web`.
   **Resolved 2026-08-01** via `wrangler pages project list`: the live project is
   `orbit-relay-web` (git-connected, serves `orbitalrelay.space`). `signal-playground` is
   a stale separate project, and `wrangler.toml`'s `name = "orbit-relay"` matches no
   project at all — it is inert for a git-connected Pages project. CLAUDE.md's deploy
   command has been corrected; `wrangler.toml` was deliberately left alone.

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **`ORBIT_DB` is not actually read-only.** `wrangler.toml` says "read side only" — that's a comment, not a binding property. The console is one guard bug from `DROP TABLE objects`. | **Highest** | Whitelist-shaped guard, tested first, multi-statement rejected outright. |
| **`.dev.vars` committed** (not currently gitignored). | **Highest** | `.gitignore` edit in the same commit that creates the file. |
| **Beacon breaks all 8 pages** — a throwing module executes zero statements. | High | Whole body in `try/catch`, no imports; check all 8 consoles after the edit. |
| **`recordRun` fails an ingest**, or `steps` unstringified fails the Actions path only. | High | try/catch mirroring `step()`; explicit `JSON.stringify`. |
| **`await recordRun` omitted before `process.exit`** → insert silently dropped. | Medium | Explicit `await`. |
| **`Access-Control-Allow-Origin: *` reused for admin.** | Medium | Own `adminJson()`; never import `json()` from `_catalog.js` into admin code. |
| **CSS duplication** — CLAUDE.md warns against a fourth copy of HUD code; this is a partial fourth copy of HUD *CSS*. | Medium | Scoped under `body[data-page-id="admin"]`, commented, values shared via `tokens.css`. Flag as a candidate for the plan-34 tokens migration. |
| **Middleware failing open** if secrets are unset. | Medium | `!ADMIN_SECRET → 503` check precedes the allowlist, deliberately. |
| Pre-existing red in the mobile suites read as a regression from this work. | Medium | Record the baseline before starting (see §"Two facts"). |
