# AGENTS.md — SIGNAL standalone playground

Compact context for OpenCode sessions. If a fact is obvious from filenames, it isn't here.

## Repo identity

- This is **its own git repo**, separate from the parent project. Remote: `https://github.com/ankesrtw/msrp-t2.git`.
- `public/` is the Cloudflare Pages deploy root. `_headers` and `_redirects` must stay at the root of `public/` (Pages only reads them there).
- No package manager, no build step, no CI. Frontends are static ES modules / vanilla JS.
- `media-mirror/` and `media-manifest.txt` are `.gitignore`d (local caches only).

## Deploy

```bash
cd standalone
source ~/.nvm/nvm.sh  # wrangler needs nvm's node+npm
wrangler pages deploy public --project-name signal-playground --commit-dirty=true
```

Some README snippets omit `--commit-dirty=true`; it is harmless and required when the working tree has uncommitted changes.

**Live URL: `signal-playground-0uj.pages.dev`** (production alias, no deploy-hash prefix), **not**
`signal-playground.pages.dev` — that bare subdomain belongs to an unrelated Cloudflare Pages
project (a different account's "Signals Testing Playground" JS-frameworks demo) that claimed the
name first, so Cloudflare suffixed this project's domain with `-0uj`. Confirm with
`wrangler pages project list` if this ever needs re-checking — don't assume the bare name is this
project just because `--project-name signal-playground` is what you pass to `wrangler`.

## Local dev

Most pages just need a static server:

```bash
cd public
python3 -m http.server 8931
# http://localhost:8931/mars-colony/
# http://localhost:8931/game-v2/
# etc.
```

`wrangler pages dev public` also works if you need the Pages Function (`/api/tle`).

## Project map

| Path | What | Notes |
|---|---|---|
| `public/index.html` + `hub.css` | SIGNAL hub | Cards route to each app below |
| `public/game/` | Autonomous War V1 | Babylon.js, self-hosted in `vendor/babylon/` |
| `public/game-v2/` | Autonomous War V2 | Three.js r172 ES modules, no build; shares assets from `../game/assets/` via importmap |
| `public/mars-colony/` | Real-terrain Mars sim | **Actively iterated** (recent commits). Three.js 0.185.1 via CDN. `README.md` has dev/deploy notes |
| `public/moon-colony/` | Moon fork | **Scaffold only** — `js/sites.js` has no sites; it throws at boot by design until Phase B.1 |
| `public/rocket-lab/` | Rocket builder V1 | Three.js 0.160.1 |
| `public/rocket-lab-v2/` | Rocket builder V2 | Three.js + Rapier |
| `public/rocket-island/` | Procedural launch-site sim | Three.js 0.160.1, no GLB/texture charter |
| `public/antimatter-frontier/` | Antimatter management sim | Three.js 0.160.1 |
| `public/colony-stats/` | Colony telemetry dashboard | Static dashboard reading EventForge snapshots |
| `public/music/` | Listening app | Static JSON in `music/data/`; audio streams from R2 (see below) |
| `public/orbit-engine/` | **Shared globe engine** | `astro.js` + `tle.js` + `sat-engine.js` + `propagate.worker.js` + vendored `satellite.min.js`. Imported by BOTH pages below — it had already been fixed twice in two copies, so do not fork it. The worker URL is **absolute**: a relative one resolves against the page and silently falls back to synchronous SGP4 |
| `public/orbit-engine/conjunction.js` + `screen.worker.js` + `screen-client.js` | Derived close-approach screening (wave 5) | The maths takes its propagator by **injection**, so it is unit-tested in Node against analytic orbits with closed-form answers. Screening runs in a SECOND, **module** worker — never the 280 ms render tick — and has **no synchronous fallback** on purpose. The coarse gate is derived from the step (`threshold + 22.4·Δt/2`), never tuned: a tuned gate misses conjunctions silently and looks like "there were none" |
| `public/orbit/` | Orbital Relay — the cinematic Celestrak view | CesiumJS CDN + the shared engine; TLE via `functions/api/tle.js`. Sats are PointPrimitives in one collection, never Entities (plan 33 waves 0-1). Baseline filenames are **lowercase** even when the Celestrak group name isn't |
| `public/spacetrack/` | Space-Track catalog | The ~28k-object catalog, sliced by type · country · regime · era · operator. Same engine; D1 via `/api/search` + `/api/object/:norad`. SPACE-TRACK on `/orbit/` is a LINK here, not a source switch (plan 33 wave 3) |
| `eventforge/` | Go telemetry pipeline | Docker Compose + ClickHouse + Redpanda + Grafana (see its own README) |
| `functions/api/tle.js` | Pages Function | TLE proxy + edge cache; falls back to `public/orbit/data/tle/celestrak/<group>.txt`, or reads the R2 bundle for `source=spacetrack` |
| `functions/api/{search,summary,object/[norad],feed,decay-watch,boxscore,brief}.js` | Pages Functions | The catalog endpoints behind `/spacetrack/`. Tested for real in `workers/orbit-ingest/test/pages-api.test.mjs`. `brief.js` deliberately has **no D1 fallback** — rebuilding the card on a read would need inference, or would pair fresh facts with a sentence checked against older ones |
| `workers/orbit-ingest/src/brief.js` | Daily brief (wave 6) | **Facts in SQL, narrative optional.** A model is asked only to phrase numbers that were already computed, once a day at ingest, never per request. `checkNarrative()` rejects any sentence containing a numeral absent from the facts — *including a correct one the model derived*, since from the output alone that is indistinguishable from invention. Off unless `ORBIT_AI_CARDS` is set; with it off the panel is still a live digest. Provider is swappable (`scripts/ai-node.mjs`) but Workers AI is the default — one call a day makes latency and cost moot, so the tiebreak is operational surface |
| `workers/orbit-ingest/` | Space-Track ingest | Runs from **GitHub Actions**, not the Worker's crons — the GP job needs ~300 ms CPU against Workers Free's 10 ms. `scripts/env-node.mjs` is a Workers-shaped `env` over the D1 HTTP API + R2 SigV4. `npm test` = 222 checks, no network |
| `scripts/` | Bash helpers | `snapshot_music.sh`, `upload_r2.sh`, `snapshot_tle.sh` |

## Versioning trap: Three.js

- `mars-colony/` and `moon-colony/` use **Three.js 0.185.1 via CDN** import map.
- Other games (`game-v2/`, `rocket-lab-v2/`, `rocket-island/`, `antimatter-frontier/`) use **Three.js 0.160.1** (self-hosted or CDN). Do not upgrade one and assume the others follow.

## Music / R2 workflow

When the catalog changes, re-run the full sequence before deploy:

```bash
cd scripts
BRAND="SIGNAL" R2_BASE="https://pub-XXXX.r2.dev/music" ./snapshot_music.sh
R2_BUCKET="signal-music" ./upload_r2.sh
```

- `R2_BASE` must match `upload_r2.sh`'s `KEY_PREFIX` (default `music`).
- `snapshot_music.sh` scrubs the old project name and rewrites media URLs to R2.
- `upload_r2.sh` is idempotent (skips mirrored files).
- `media-manifest.txt` is generated, not committed.

## Orbital Relay TLE

Refresh the shipped baseline snapshot occasionally:

```bash
cd scripts
./snapshot_tle.sh
# then commit public/orbit/data/tle/celestrak/*.txt and redeploy
```

The script sleeps between Celestrak group fetches to avoid rate limits.

## EventForge

Standalone Go project. Use `make` from inside `eventforge/`:

```bash
cd eventforge
make up      # docker compose up + create topics
make sim     # run simulator
make verify  # ClickHouse row/freshness check
make bench RATE=15000
make down    # stop containers
make clean   # stop + wipe volumes
```

- `go.mod` pins Go 1.25.0. `make build` compiles all packages.
- `make proto` regenerates Go bindings from `proto/telemetry.proto` (needs `protoc` + `protoc-gen-go`).
- Exporter writes `snapshots/latest.json` which the future dashboard will read.

## Verification

- This repo has a local OpenCode skill: `.claude/skills/verify/SKILL.md`.
- Use it for Playwright-based headless checks of the `public/` games after code changes.
- Critical notes from that skill:
  - This box is slow (SwiftShader, ~5fps WebGL); use keyboard events, not `page.click`.
  - Always cache-bust with `?cb=<timestamp>`.
  - Check for stray headless Chrome processes with `ps aux | grep chrome-linux64` before debugging a hang.
  - `mars-colony/` debug handle is `window.__mc`.

## Things not to do

- Don't add a build step for the static frontends unless explicitly asked.
- Don't commit `media-mirror/` or `media-manifest.txt`.
- Don't move `_headers` or `_redirects` out of `public/`.
- Don't try to run `moon-colony/` until a site is added to `js/sites.js`.
- Don't point the TLE tracker at third-party CORS proxies; the baseline file + `/api/tle` are the supported paths.

## References

- `README.md` — full deploy sequence, reliability notes, route map.
- `eventforge/README.md` — telemetry pipeline architecture.
- `public/mars-colony/README.md` — Mars Colony dev/deploy notes.
- `.claude/skills/verify/SKILL.md` — Playwright E2E guide for `public/` games.
- `docs/issues-and-resolutions.md` — recent bug resolutions and measured constants.

## SpaceTrack multi-page refactoring (in progress)

### Completed (committed)
- `public/spacetrack/shared/state.js` — centralized state (selected object, filters, time, camera) persisted via localStorage
- `public/spacetrack/shared/api.js` — shared API fetch wrappers (search, summary, object, feed, etc.)
- `public/spacetrack/shared/navigation.js` — nav component builder (used by JS-driven pages)
- `public/spacetrack/shared/globe.js` — Cesium Viewer/SatEngine init wrapper
- `public/spacetrack/shared/ui.js` — collapsible panel, dropdown menu, time-warp, footer builders
- `public/spacetrack/shared/utils.js` — `num()`, `relTime()`, `fmtLat()`, `TYPE_COLORS`, `setText()`, etc.
- `public/spacetrack/index.html` — Catalog page (globe + filters + results + dossier). Nav is static HTML in markup (no JS dependency).
- `public/spacetrack/catalog.js` — Catalog page app logic (renders sats, opens dossier, wire HUD toggles, time warp)
- `public/spacetrack/signal/index.html` — Signal page HTML scaffold (visibility, coverage, passes, RF tabs)
- `public/spacetrack/spacetrack.css` — added `.spacetrack-nav` styles, replaced old `.orbital-topbar` overrides

### Still needed (next session)

1. **`public/spacetrack/signal/signal.js`** — Signal page JS implementation
2. **`public/spacetrack/conjunctions/`** — Conjunctions page (HTML + JS). Port code from current `spacetrack.js` lines ~628-827 (conjunction screening logic, `ConjunctionScreener`, `runScreen`, `renderConjunctions`)
3. **`public/spacetrack/brief/`** — Brief page (HTML + JS). Port `loadBrief()`, `renderBrief()` from `spacetrack.js` lines ~396-486
4. **`public/spacetrack/analytics/`** — Analytics page (HTML + JS). Port `loadAnalytics()`, `renderAnalytics()`, `renderBars()`, `st-country-matrix` from `spacetrack.js` lines ~488-612
5. **Navigate from Catalog page to other pages must preserve selected object state** — currently `state.js` handles this via localStorage, but each page should read the shared state on boot and restore the selected object/dossier if one is set
6. **`_redirects`** — might need SPA-style redirects for `/spacetrack/signal/` → `/spacetrack/signal/index.html` etc. (Cloudflare Pages should auto-resolve this for directory-style paths)

### Key decision
The new nav is **static HTML in the markup**, not rendered by JS, so pages load and render immediately without JS dependency for the nav. Each page is a separate index.html. The `shared/` modules export helpers that each page's JS can import.

### Current nav link structure (in each HTML file)
```html
<nav class="spacetrack-nav" id="main-nav" role="navigation"
     aria-label="SpaceTrack main navigation">
  <a href="/spacetrack/" class="spacetrack-nav__brand">◂ SPACETRACK</a>
  <ul class="spacetrack-nav__list" role="menubar">
    <li><a href="/spacetrack/"       class="spacetrack-nav__link spacetrack-nav__link--active">CATALOG</a></li>
    <li><a href="/spacetrack/signal/" class="spacetrack-nav__link">SIGNAL</a></li>
    <li><a href="/spacetrack/conjunctions/" class="spacetrack-nav__link">CONJUNCTIONS</a></li>
    <li><a href="/spacetrack/brief/" class="spacetrack-nav__link">BRIEF</a></li>
    <li><a href="/spacetrack/analytics/" class="spacetrack-nav__link">ANALYTICS</a></li>
  </ul>
  <a href="/orbit/" class="spacetrack-nav__source-link">CELESTRAK ↗</a>
</nav>
```
When creating new pages, copy this nav block and set `spacetrack-nav__link--active` on the current page's link.
