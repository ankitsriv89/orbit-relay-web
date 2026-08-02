# CLAUDE.md — Orbital Relay

Working agreement for coding sessions in this repo. `AGENTS.md` is the architecture map
(what lives where, and why); this file is the *process* — what to run, what to check, and
the invariants a change must not break.

If the two ever disagree about a path or a command, trust what you verify against the
working tree and fix whichever file is stale.

---

## What this repo is

`orbitalrelay.space` — a satellite visualization platform on Cloudflare Pages. Ten routes,
all static ES modules with **no build step**:

| Route | What |
|---|---|
| `/` | Landing page |
| `/orbit/` | Orbital Relay — cinematic Celestrak view |
| `/spacetrack/` | The ~28k-object Space-Track catalog |
| `/spacetrack/signal/` | Visibility, coverage, pass prediction, RF link budget |
| `/spacetrack/conjunctions/` | Derived close-approach screening |
| `/spacetrack/brief/` | Daily brief |
| `/spacetrack/analytics/` | Catalog analytics |
| `/starlink/` | Starlink constellation view |
| `/about/` | Data sources, how it works, privacy, legal |
| `/wiki/` | Per-route app reference + glossary of derived terms |

Backed by 9 Pages Functions in `functions/api/` over D1 + R2, fed by
`workers/orbit-ingest/` running from GitHub Actions.

---

## The no-build-step rule shapes everything

There is no bundler, no transpiler, no import map in `public/`. What you write is what the
browser parses. Three consequences that have each already caused a production outage:

1. **A syntax error in one ES module executes zero statements of that module.** Not a
   partial failure — the whole file silently does nothing. `catalog.js` shipped a
   `const LOD FAR_THRESHOLD` typo and all 1,465 lines were dead until someone loaded the
   page.
2. **Module specifiers are pure filesystem arithmetic against the importing file's
   directory** — not the page's. `../orbit-engine/` from `spacetrack/signal/signal.js`
   resolves to `public/spacetrack/orbit-engine/`, which does not exist. This broke twice
   (`fb66525f`, `dcbb42aa`).
3. **Browsers do not add `.js`.** Every specifier needs its exact extension, and anything
   not starting with `.` or `/` is unresolvable.

**Rule: cross-package references are root-absolute** (`/orbit-engine/…`, `/orbit/orbit.css`,
`/css/tokens.css`). Depth-invariant, and it matches what `sat-engine.js:119` and
`screen-client.js:46` already enforce for worker URLs. Keep intra-package imports relative
(`./shared/utils.js`) — those never change depth.

Corollary: **cache-control for `/css/*` and `/js/*` cannot be `immutable`**, because
filenames are not content-hashed and hashing would require the build step this repo
forbids. Use `max-age=3600, stale-while-revalidate=86400`.

---

## Commands

```bash
npm test                      # syntax + resolve checks + the orbit-ingest suite
npm run dev                   # wrangler pages dev public  → :8788
cd public && python3 -m http.server 8931   # static-only, faster for pure frontend work
```

Deploy is automatic on push to `main` (Cloudflare Pages). For a manual deploy:

```bash
source ~/.nvm/nvm.sh          # wrangler needs nvm's node+npm
wrangler pages deploy public --project-name orbit-relay-web --commit-dirty=true
```

**Project name — verified 2026-08-01 with `wrangler pages project list`:** the live
project is **`orbit-relay-web`** (`orbit-relay-web.pages.dev` + `orbitalrelay.space`,
git-connected). Two names in this repo are wrong and deploying to either is a mistake:

- `signal-playground` (`signal-playground-0uj.pages.dev`) is a **separate, stale** project
  that does *not* serve `orbitalrelay.space`. It is what this file and `AGENTS.md` used to
  name; a manual deploy there ships to the wrong site.
- `wrangler.toml`'s `name = "orbit-relay"` matches **no** project at all. It is inert for
  Pages (the dashboard's git integration owns the deploy), which is why it went unnoticed.

Use `orbitalrelay.space` for canonical/OG tags. Re-confirm with
`wrangler pages project list` before hardcoding anything else.

---

## Before you say a change works

In order, cheapest first:

1. **`npm test`.** Must be green. It runs `scripts/check/syntax.mjs` (every
   `public/**/*.js` + `functions/**/*.js` through `node --check`),
   `scripts/check/resolve.mjs` (every HTML `src`/`href`, every static ESM specifier, every
   `new Worker()` URL, every CSS `url()` resolved against the real filesystem), then the
   222-check `orbit-ingest` suite. All offline, no network, seconds.
2. **Load the affected route** under `npm run dev` and confirm the console is clean. A
   globe page that renders is not proof — a dead module fails silently.
3. **Check it at 390px** (see the mobile section — this is not optional).
4. **`tests/e2e/`** for behavioral changes. `.claude/skills/verify` drives headless
   Chromium; use the `verify` skill rather than hand-rolling Playwright.

When you add a guardrail, **write it before the fix and watch it go red on the real bug.**
A check that has never failed on a bug it claims to catch has not been tested.

---

## The landing page must stay in sync with the product

`/` is the front door — the app-card grid, the routes table above, and `/wiki/`'s app
reference all assert "this is the full list of what exists." A route that exists but isn't
listed there is effectively unlisted; a route listed there that no longer exists is a dead
link a visitor will hit before you do.

**When a session adds or removes a whole route/page/app** (a new `/something/` directory
under `public/` with its own `index.html`, or the deletion of one), update, in the same
session:

- The routes table at the top of this file.
- `public/index.html`'s `.app-grid` (a new `<a class="app-card">`) and `site-footer__grid`
  nav columns — or their removal.
- `public/wiki/index.html`'s `#apps` section — add or remove that route's reference block.
- `_redirects` (extensionless → trailing-slash redirect) and `_headers`
  (cache-control block) for the new/removed path, matching the existing entries' pattern.

This does **not** cover every feature added to an existing page (a new filter, a new
overlay, a new HUD panel) — only whole routes appearing or disappearing. Advertising every
in-page feature on the landing page would make it a permanently-stale changelog; the
app-card's one-line description only needs to stay roughly true to what the page does, not
enumerate its filters. `/wiki/`'s per-route reference is the place for filter-level detail
when it's worth documenting — update it when a change there would otherwise make the Wiki
actively wrong, not on every feature commit.

Treat this as a step in "Before you say a change works," not a separate pass: check it at
the same time you're already touring the affected routes under `npm run dev`.

---

## Mobile responsiveness is a requirement, not a pass

**Every UI change ships mobile-responsive.** Verify at 390×844 (iPhone 14), 412×915
(Pixel 7), 820×1180 (iPad Air), 1133×744 (iPad Mini landscape) and 1400×900 — the exact
viewport table in `tests/e2e/test_mobile_responsive.py`. Landscape phone matters too:
these are globe pages and people rotate them.

Non-negotiables:

- **`<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">`.**
  Every page except `/` already has `viewport-fit=cover`; new pages match it.
- **Safe-area insets via `--sa-top/right/bottom/left`.** Read
  [orbit.css:1-31](public/orbit/orbit.css#L1-L31) before touching fixed chrome — the
  comment there explains why the HUD stack *adds* insets rather than wrapping offsets in
  `max()`, and why `max()` would collapse the gaps between stacked panels and put one
  panel's toggle under another's body. That reasoning is load-bearing; do not "simplify"
  it.
- **No horizontal page scroll at any viewport.** Wide content (tables, matrices, the
  country grid) scrolls inside its own `overflow-x: auto` container.
- **Touch targets ≥ 44px.** The globe pages are dense; chips and toggles are the usual
  offenders.
- **`backdrop-filter` is halved on mobile** (`--hud-blur`). A 16px blur over a full-screen
  WebGL canvas is one of the most expensive things a phone GPU can be asked for. If you
  add blurred chrome, respect the breakpoint.
- **Respect `prefers-reduced-motion`.** There is no reduced-motion handling anywhere in
  the repo today — any new animation is where that starts.
- **Test with a real WebGL page, not just a DOM snapshot.** This box is SwiftShader at
  ~5fps; `tests/e2e/test_mobile_dom.py` exists precisely because a full render is too slow
  to be a fast gate.

`public/css/tokens.css` now holds the shared color/font tokens (linked by `landing.css`);
`orbit.css` and `spacetrack.css` still declare their own `--sa-*`/`--panel-*`/`--hud-blur`
on purpose — migrating those without behaviour change is unstarted, so `spacetrack.css`
still has **no `:root`** and inherits those vars from `orbit.css` purely by hand-written
`<link>` order. Do not reorder those `<link>` tags. The shared nav/hamburger/mobile-menu/
filter-drawer chrome that used to be duplicated across `orbit.css` and `spacetrack.css`
now lives in `public/css/chrome.css`, linked root-absolute after both — a handful of
selectors (`.hamburger-btn`, `.mobile-menu__inner`, `.spacetrack-nav__brand`) are still
duplicated on purpose because their rule bodies had already drifted between the two pages;
that drift is documented inline where it lives, not silently merged.

---

## Invariants that look like bugs

Do not "fix" these without reading the reasoning first:

- **The conjunction screener takes its propagator by injection** so it can be unit-tested
  in Node against closed-form analytic orbits. Preserve that when refactoring — it is the
  one place in this repo where the maths is genuinely proven, and it is the model for
  extracting pure functions out of DOM handlers.
- **The coarse screening gate is derived from the step** (`threshold + 22.4·Δt/2`), never
  tuned. A tuned gate misses conjunctions silently and looks exactly like "there were
  none."
- **Screening runs in a second, module worker with no synchronous fallback**, on purpose —
  never on the 280ms render tick.
- **`brief.js` has no D1 fallback**, deliberately: rebuilding the card on a read would pair
  fresh facts with a sentence checked against older ones.
- **`checkNarrative()` rejects any sentence containing a numeral absent from the facts —
  including a correct one the model derived.** From the output alone that is
  indistinguishable from invention.
- **`parseEpochUTC` and `CITATION` are duplicated across bundles on purpose** and asserted
  byte-identical by `derive.test.mjs`. Do not de-dupe those two.
- **The Space-Track citation is legally required** and returned on every API response as
  `X-Data-Source` ([_orbit.js:17-19](functions/api/_orbit.js#L17-L19)). It must be visible
  in the product, and the conjunction screener's `⚠ UNOFFICIAL — NOT FOR COLLISION
  AVOIDANCE` framing ships in the **HTML**, not only the JS, so it cannot be lost to a
  failed fetch.
- **`operator` is derived**, inferred from `OBJECT_NAME`, not authoritative. Every endpoint
  returns `operator_derived: true`; badge it as derived wherever it is shown.
- **Sats on `/orbit/` are PointPrimitives in one collection, never Entities.** Anything
  added via `viewer.entities.add` escapes `engine.destroy()` cleanup
  ([sat-engine.js:581](public/orbit-engine/sat-engine.js#L581)).
- **Celestrak baseline filenames are lowercase** even when the group name is not.

---

## Things not to do

- Don't add a build step for the static frontends unless explicitly asked.
- Don't fork `public/orbit-engine/` — it was already fixed twice in two copies before it
  was shared.
- Don't use a relative `new Worker()` URL. It resolves against the page and silently falls
  back to synchronous SGP4; `npm test` now enforces absolute.
- Don't move `_headers` or `_redirects` out of `public/` — Pages only reads them there.
- Don't point the TLE tracker at third-party CORS proxies. The baseline file at
  `/data/tle` + `/api/tle` are the supported paths.
- Don't commit `media-mirror/` or `media-manifest.txt`.
- Don't use `insertAdjacentHTML` with anything user- or API-derived.
- Don't add a fourth copy of the HUD/nav/time-warp code. There are already three.

---

## Current work

See [docs/game-plans/34_unblock_landing_refactor_plan.md](docs/game-plans/34_unblock_landing_refactor_plan.md)
for the active plan and
[docs/game-plans/Orbital_Relay_Feature_Specification.md](docs/game-plans/Orbital_Relay_Feature_Specification.md)
for the 20-feature target spec.

### Admin dashboard (plan 36) — status 2026-08-01

Built in `0017b156` + `3761cf8c`, **deployed** in `75d3ee93` + `e335604b`.
`docs/game-plans/36_admin_dashboard_plan.md` is the spec. **npm test 302/302 green
offline.** Verified end-to-end against production on deploy day:

- curl matrix on `orbitalrelay.space`: 401 no-cookie / 401 wrong pw / 200 login /
  200 health+runs+visitors / 400 SQL guard / 200 query. Pre-fix prod returned **200
  for everything** (options-object `adminJson` ignored the status) — the login form
  never appeared and session expiry was invisible.
- Remote D1 migration applied — `page_views` + `ingest_runs` exist in prod.
- Health panel reads real counts (31,944 objects / 18,393 payloads / 10,084 debris);
  the original title-case `OBJECT_TYPE` query matched nothing.
- `tests/e2e/test_admin_mobile.py`: 21/21 (static server, API intercepted).

Known states / decisions:

- **Secrets: user keeps the old dev identity — no reset.** My `wrangler pages secret
  put` of the `.dev.vars` values DID propagate to prod (~2 min); if the old password
  is wanted back, `printf '<old>' | wrangler pages secret put ADMIN_PASSWORD
  --project-name orbit-relay-web`. Don't diagnose a "failed" put by waiting 10 s —
  propagation is real, just not instant.
- `CLOUDFLARE_ANALYTICS_TOKEN` / `CLOUDFLARE_ZONE_ID` never set — cf-analytics panel
  renders "not configured". User opted to skip.
- `latestIngest` shows `—` until the next Actions run records its first `ingest_runs`
  row; `artifactAge` shows `unknown` until the next daily artifact build writes
  `customMetadata.generated` (the current R2 summary.json predates it).

Admin-specific invariants (do not regress):
- **`adminJson(body, status)` takes a positional status** — every call site passes
  `(body, 401)`. The options-object signature broke all admin error statuses;
  `admin.test.mjs` guards it.
- **Next-due comes from `public/admin/cron.js`'s `ACTIONS_CRONS`** (Actions schedule),
  never `wrangler.toml`'s crons, which are documented as deployable-and-unused.
- Frontend error fallbacks live in `public/admin/api.js`'s `STATUS_MESSAGES`; server
  messages win when present.
- Panel DOM is built with `createElement` (repo rule, no `innerHTML`); `loadPanel`
  renders per-panel errors without blanking the dashboard; `panelTimers` must be
  cleared on logout.
- The `X-Data-Source` citation rides on **every** admin response including
  login/logout (`adminJson` `extraHeaders`).
- `OBJECT_TYPE` filters use the uppercase values Space-Track stores
  (`PAYLOAD`/`DEBRIS`/`ROCKET BODY`) — guarded by admin.test.mjs.

Sequencing, and why: **Phase 0 (unblock + test gate) → 2.1 HUD unification → tokens.css →
Phase 1 landing → rest of Phase 2 → Phase 3 features.** Refactor precedes features because
three Phase 3 items are blocked on it — time rates touch the time-warp code that exists in
three copies, dossier completeness needs the extracted `shared/dossier.js`, and new filters
need the layer registry or the 15 existing checkboxes get duplicated a second time.

**Phase 0, 2.1, and 1.1 are done as of 2026-08-01.** HUD unification landed in
`62f206a3` (`public/shared/hud.js`, with the mobile-only panel-exclusivity gate promoted
to an explicit `exclusive` option rather than silently dropped). `public/css/tokens.css`
exists and is linked by `landing.css`. The rest of 2.1's "pure deletion" checklist is also
done: `shared/navigation.js`/`ui.js` were already gone; `public/shared/dossier.js` now
holds the `open`/`close`/`refreshLive` logic that was duplicated between `catalog.js` and
`conjunctions.js` (and fixes a real gap — `conjunctions.js` never synced
`State.selectedObject` on dossier-open, so Signal never picked up a selection made from
the Conjunctions page; it does now); every page routes through `shared/api.js`'s `API`
object instead of hand-rolled `fetch`; `functions/api/_catalog.js` carries the shared
`clamp`/`safeParse`/`artifactOrDb` helpers; `public/theme/palette.js` unifies the normal
and colorblind-safe palettes; `public/css/chrome.css` holds the shared nav/hamburger/
mobile-menu/filter-drawer CSS; and `functions/api/telemetry.js` (unbound `TELEMETRY_DB`,
unrelated Mars-Sim analytics) is deleted along with `d1/telemetry.sql`.

**Phase 2.2 (structural) is done as of 2026-08-02.** `npm test` is green (12 suites,
346 checks). The pure maths are extracted and Node-tested in `workers/orbit-ingest/test/`
(`signal-compute.test.mjs`, `catalog-compute.test.mjs`, following the `conjunction.test.mjs`
import pattern): `signal/compute.js` (visibility windows, passes, coverage circle, link
budget) and `catalog/compute.js` (`binHeatmap`, `heatmapStyle`, `ageRamp`, `ageColorCss` —
ramp takes an explicit `nowMs`). `catalog.js`'s five overlay sections (heatmap, debris,
launch-sites, age, LOD) are split into `public/spacetrack/overlays/{heatmap,debris,launch-sites,age,lod}.js`,
each constructed via a `create*({ viewer, engine, getRendered, ... })` factory wired from
catalog.js — overlays no longer reach into catalog.js's module state. `clearRendered()`
delegates to overlay `reset()`s. Entity lifecycle is centralized in the engine:
`addManagedEntity`/`removeManagedEntity` + `_managedEntities` in `sat-engine.js`
(an overlay entity that bypasses it escapes `engine.destroy()` — guarded by a cross-file
test). All 11 unguarded `addEventListener` calls became the `on(id, ev, fn)` helper in
`shared/utils.js`. Every page's `window.__spacetrack` handle is built by
`exposeDebug(page, api)` in `shared/debug.js` (`source` is now the page name). `initGlobe()`
registers `beforeunload`/`camera.changed` itself. e2e (`tests/e2e`) still to re-run when box
load drops; the `__spacetrack` member surface was preserved byte-for-byte for the suites
that read it.
