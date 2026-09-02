# CLAUDE.md — Orbital Relay

**Status: complete and deployed** (`orbitalrelay.space`). The 20-feature target spec
(`docs/game-plans/Orbital_Relay_Feature_Specification.md`) is delivered. Work here now
is maintenance, bug fixes, and the occasional new feature — not a phased build. There is
no task list.

The *process* — what to run, what to check, the invariants a change must not break.
`AGENTS.md` is the architecture map. If the two disagree about a path or command, trust
the working tree and fix whichever is stale.

**When a request is ambiguous, ask** — don't guess and run, don't spiral into
inferring intent. A short question resolves it faster than either.

Detail that most sessions don't need lives in `.claude/rules/` (loads on matching
paths): `testing-e2e` (running the Playwright suite on this box) · `ingest-d1`
(D1 read-cost, the Space-Track budget, deploy confirmation). Permanent record:
`docs/issues-and-resolutions.md`, `docs/build-logs/`. Model policy:
`~/.claude/CLAUDE.md` — default Sonnet.

---

## What this repo is

`orbitalrelay.space` — a satellite visualization platform on Cloudflare Pages. Eleven
routes, all static ES modules with **no build step**: `/`, `/orbit/`, `/spacetrack/`
(+ `/signal/`, `/conjunctions/`, `/brief/`, `/analytics/`), `/constellations/`,
`/objects/` (+ crawlable per-object shells), `/about/`, `/wiki/`. Backed by Pages
Functions in `functions/api/` over D1 + R2 — the `orbit-catalog` D1 fed by
`workers/orbit-ingest/` and the `orbit-profiles` D1 fed by `workers/orbit-profiles/`,
both on GitHub Actions. (Route table with descriptions: `AGENTS.md`.)

## The no-build-step rule shapes everything

No bundler, no transpiler, no import map. What you write is what the browser parses.
Three consequences, each of which has caused a production outage:

1. **A syntax error in one ES module executes zero statements of that module** — the
   whole file silently does nothing (`catalog.js` shipped a `const LOD FAR_THRESHOLD`
   typo; 1,465 lines were dead until someone loaded the page).
2. **Module specifiers are filesystem arithmetic against the importing file's
   directory**, not the page's. Broke twice (`fb66525f`, `dcbb42aa`).
3. **Browsers don't add `.js`.** Every specifier needs its exact extension; anything
   not starting with `.` or `/` is unresolvable.

**Rule: cross-package references are root-absolute** (`/orbit-engine/…`,
`/css/tokens.css`) — depth-invariant. Intra-package imports stay relative
(`./shared/utils.js`). **Corollary:** cache-control for `/css/*` and `/js/*` can't be
`immutable` (filenames aren't content-hashed) — use
`max-age=3600, stale-while-revalidate=86400`.

## Commands

```bash
npm test                                   # syntax + resolve + orbit-ingest suite — offline, seconds
npm run dev                                 # wrangler pages dev public → :8788
cd public && py -3 -m http.server 8931      # static-only, faster for pure frontend work
```

Deploy is automatic on push to `main`. Manual: `source ~/.nvm/nvm.sh && wrangler pages
deploy public --project-name orbit-relay-web --commit-dirty=true`. **After any push,
confirm the deploy shipped** — `ci` green says nothing about the Pages build
(see `.claude/rules/ingest-d1.md`).

## Before you say a change works

1. **`npm test`** — green.
2. **Load the affected route** under `npm run dev`, console clean. A globe that renders
   is not proof — a dead module fails silently.
3. **Check it at 390px** — mobile is a requirement (below).
4. **`tests/e2e/`** for behavioural changes — see `.claude/rules/testing-e2e.md`.

When you add a guardrail, **write it before the fix and watch it go red on the real bug.**

## The landing page must stay in sync with the product

`/` and `/wiki/` assert "this is the full list of what exists." **When a session adds or
removes a whole route** (`public/<something>/index.html`), update in the same session:
the route table in `AGENTS.md`, `public/index.html`'s `.app-grid` + footer nav,
`public/wiki/index.html`'s `#apps`, and `_redirects` + `_headers` for the path. This is
**whole routes only** — not every in-page filter or overlay. Do it while you're already
touring the affected routes under `npm run dev`.

## Mobile responsiveness is a requirement, not a pass

**Every UI change ships mobile-responsive.** Verify at 390×844, 412×915, 820×1180,
1133×744, 1400×900 — the viewport table in `tests/e2e/test_mobile_responsive.py`.
Landscape phone matters (globe pages, people rotate them).

- **`<meta name="viewport" content="…, viewport-fit=cover">`** on every page.
- **Safe-area insets via `--sa-top/right/bottom/left`.** Read `orbit.css:1-31` before
  touching fixed chrome — the comment explains why the HUD stack *adds* insets rather
  than wrapping offsets in `max()`. That reasoning is load-bearing; don't "simplify" it.
- **No horizontal page scroll at any viewport** — wide content scrolls in its own
  `overflow-x: auto` container.
- **Touch targets ≥ 44px.** **`backdrop-filter` is halved on mobile** (`--hud-blur`) —
  a 16px blur over a full-screen WebGL canvas is one of the most expensive things a
  phone GPU can do.
- **Respect `prefers-reduced-motion`** — no handling exists yet; any new animation is
  where it starts.

`public/css/tokens.css` holds shared color/font tokens. `orbit.css` and `spacetrack.css`
still declare their own `--sa-*`/`--panel-*`/`--hud-blur` on purpose; `spacetrack.css`
has **no `:root`** and inherits from `orbit.css` by hand-written `<link>` order — do not
reorder those tags. Shared nav/hamburger/menu/drawer chrome is in `public/css/chrome.css`,
linked root-absolute after both; a few selectors stay duplicated on purpose because their
bodies had already drifted (documented inline).

## Invariants that look like bugs

Do not "fix" these without reading the reasoning:

- **The conjunction screener takes its propagator by injection** so it's unit-testable in
  Node against closed-form orbits. It's the one place the maths is genuinely proven, and
  the model for extracting pure functions out of DOM handlers.
- **The coarse screening gate is derived from the step** (`threshold + 22.4·Δt/2`), never
  tuned. A tuned gate misses conjunctions silently and looks exactly like "there were none."
- **Screening runs in a module worker with no synchronous fallback**, never on the 280ms
  render tick.
- **`brief.js` and `checkNarrative()`:** `brief.js` has no D1 fallback (a read would pair
  fresh facts with older sentences); `checkNarrative()` rejects any sentence with a
  numeral absent from the facts, *including a correct derived one* — from the output alone
  that's indistinguishable from invention.
- **The Space-Track citation is legally required** — returned on every API response as
  `X-Data-Source`, visible in the product, and the screener's `⚠ UNOFFICIAL — NOT FOR
  COLLISION AVOIDANCE` framing ships in the **HTML**, not only JS.
- **`operator` is derived** (inferred from `OBJECT_NAME`) — every endpoint returns
  `operator_derived: true`; badge it as derived everywhere shown.
- **Sats on `/orbit/` are PointPrimitives in one collection, never Entities.** Anything
  via `viewer.entities.add` escapes `engine.destroy()` cleanup.
- **No globe route may reacquire Cesium ion.** Imagery is the bundled offline
  `NaturalEarthII`; terrain is `EllipsoidTerrainProvider` passed **explicitly** (Viewer
  silently defaults both to ion — that's how `/constellations/` burned the account quota).
  `tests/e2e/test_imagery.py` asserts the network log is ion-free on all five routes.
- **`tuneBaseImagery()` is load-bearing.** The globe is deliberately unlit so the base
  texture composites at full value — and NaturalEarthII unlit is a glowing cyan ball.
  Tone the *imagery layer*, never the lighting. Darker is not strictly better — past
  ~0.30 brightness the ocean greys out.
- **Orbit rings are sampled SGP4, not circles** — they look circular because most tracked
  orbits are. Eccentricity renders faithfully (MOLNIYA varies 431% of radius; ISS 0.38%).
  Check an eccentric object before suspecting the propagator. `/constellations/` plane
  rings are the deliberate exception — true great circles, a schematic of the plane.
- **CZML was assessed and rejected for rendering** (2026-08-19) — it creates Entities
  (the pattern that blew the heap to 1.2 GB) and caps near 4k sats. CZML *export* of one
  selected object is still a reasonable future feature.

D1 query invariants (keyset paging, the group-bundle floor, the `decay` NOT EXISTS rule):
`.claude/rules/ingest-d1.md`.

## Things not to do

- No build step for the static frontends unless explicitly asked.
- Don't fork `public/orbit-engine/` — already fixed twice in two copies before it was shared.
- No relative `new Worker()` URL — resolves against the page and silently falls back to
  synchronous SGP4. `npm test` enforces absolute.
- Don't move `_headers` / `_redirects` out of `public/` — Pages only reads them there.
- Don't point the TLE tracker at third-party CORS proxies — `/data/tle` + `/api/tle` are
  the supported paths.
- No `insertAdjacentHTML` with user- or API-derived content.
- No fourth copy of the HUD/nav/time-warp code. There are already three.
- Don't commit `media-mirror/` or `media-manifest.txt`.

**Stale-guidance note:** this repo was split from a larger playground. If you find
guidance referencing `mars-colony/`, `game-v2/`, `rocket-lab/`, `.claude/skills/verify/`,
`scripts/mars-terrain/`, `test_plan27/28.py`, or `test_site_parity.py` — it's stale, they
were removed in the 2026-08-17 cleanup. Use `tests/e2e/` directly.
