# CLAUDE.md — Orbital Relay

Working agreement for coding sessions in this repo. `AGENTS.md` is the architecture map
(what lives where, and why); this file is the *process* — what to run, what to check, and
the invariants a change must not break.

If the two ever disagree about a path or a command, trust what you verify against the
working tree and fix whichever file is stale.

---

## What this repo is

`orbitalrelay.space` — a satellite visualization platform on Cloudflare Pages. Six routes,
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
wrangler pages deploy public --project-name signal-playground --commit-dirty=true
```

**Hostname note:** `wrangler.toml` and `README.md` say `orbitalrelay.space`; `AGENTS.md`
documents `signal-playground-0uj.pages.dev`. Both are real — the latter is the Pages
project alias, the former the custom domain. Use `orbitalrelay.space` for canonical/OG
tags. Confirm with `wrangler pages project list` before hardcoding anything else.

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

Two things to know about the current state: `public/css/landing.css` has **zero** custom
properties and one media query, and `spacetrack.css` has **no `:root`** — it consumes
`var(--font-mono)` and `var(--sa-*)` 13+ times, inheriting them from `orbit.css` purely by
hand-written `<link>` order. A shared `public/css/tokens.css` is the fix; until it lands,
do not reorder those `<link>` tags.

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

Sequencing, and why: **Phase 0 (unblock + test gate) → 2.1 HUD unification → tokens.css →
Phase 1 landing → rest of Phase 2 → Phase 3 features.** Refactor precedes features because
three Phase 3 items are blocked on it — time rates touch the time-warp code that exists in
three copies, dossier completeness needs the extracted `shared/dossier.js`, and new filters
need the layer registry or the 15 existing checkboxes get duplicated a second time.

**Phase 0 is partly done already.** Commits `db2584c6`/`dcbb42aa`/`fb66525f` landed after
the plan was written and fixed the `catalog.js` parse error, the `../orbit-engine/` import
paths and the TLE baseline path; `public/starlink/` now exists. Re-verify before working a
Phase 0 item rather than trusting the doc. Still open at time of writing: `../spacetrack.css`
in the four nested pages, the missing `/icon.svg`, the red badge assertion in
`conjunction.test.mjs:458`, `npm test` itself, and `_headers`/`_redirects`.
