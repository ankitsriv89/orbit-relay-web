# AGENTS.md — Orbital Relay

Compact architecture map. If a fact is obvious from filenames, it isn't here.
Process, commands and invariants live in [CLAUDE.md](CLAUDE.md); this file is *what lives
where, and why*.

## Repo identity

- Its own git repo. **Domain: `orbitalrelay.space`.** Cloudflare Pages project
  `orbit-relay-web` (`orbit-relay-web.pages.dev` + `orbitalrelay.space`), git-connected —
  verified 2026-08-01 with `wrangler pages project list`. `signal-playground`
  (`signal-playground-0uj.pages.dev`) is a **separate stale project** that does not serve
  this domain, and `wrangler.toml`'s `name = "orbit-relay"` matches no project at all
  (inert — the git integration owns the deploy). Don't assume a name is this project just
  because that's what you pass to `--project-name`; re-confirm with
  `wrangler pages project list`.
- `public/` is the Pages deploy root. `_headers` and `_redirects` must stay at the root of
  `public/` (Pages only reads them there).
- **No build step.** Frontends are static ES modules / vanilla JS. See CLAUDE.md for the
  three failure modes this implies — they have each caused an outage.
- Deploy is automatic on push to `main`.
- `media-mirror/` and `media-manifest.txt` are `.gitignore`d (local caches only).

> **Historical note.** Earlier revisions of this file documented a multi-game playground
> (`mars-colony/`, `game-v2/`, `rocket-lab/`, `music/`, `eventforge/`, a Three.js version
> trap, an R2 music workflow). **None of that is in this repo** — it was split out. If you
> find guidance referring to those paths, it is stale.

## Project map

| Path | What | Notes |
|---|---|---|
| `public/index.html` + `css/landing.css` | Landing page | Currently a 48-line placeholder consuming no backend data; Phase 1 of plan 34 rebuilds it |
| `public/orbit/` | **Orbital Relay** — cinematic Celestrak view | CesiumJS CDN + shared engine; TLE via `functions/api/tle.js`. Sats are PointPrimitives in one collection, never Entities. Baseline filenames are **lowercase** even when the Celestrak group name isn't |
| `public/spacetrack/` | **Space-Track catalog** | ~28k objects sliced by type · country · regime · era · operator. Same engine; D1 via `/api/search` + `/api/object/:norad`. SPACE-TRACK on `/orbit/` is a LINK here, not a source switch |
| `public/spacetrack/{signal,conjunctions,brief,analytics}/` | The four nested pages | Each a separate `index.html` with **static HTML nav** (see below). Depth 2 — cross-package refs must be root-absolute |
| `public/spacetrack/shared/` | Page-layer helpers | `state.js` (localStorage-persisted selection/filters/time/camera), `api.js` (typed fetch wrappers), `globe.js` (Viewer/SatEngine init), `hud.js` (collapsible panels), `utils.js` (`num`, `relTime`, `fmtLat`, `TYPE_COLORS`, `setText`, `on`), `debug.js` (`exposeDebug(page, api)` — all 5 pages' `window.__spacetrack`). **`navigation.js` and `ui.js` have zero importers** — dead since the nav became static HTML |
| `public/spacetrack/{signal,catalog}/compute.js` + `public/spacetrack/overlays/` | Pure math + overlay splits (plan 34 2.2) | Signal/link-budget and heatmap/age-ramp maths are pure and Node-tested (`workers/orbit-ingest/test/{signal-compute,catalog-compute}.test.mjs`). Overlay modules (`heatmap`, `debris`, `launch-sites`, `age`, `lod`) are factories taking `{viewer, engine, getRendered}`; `clearRendered()` delegates to their `reset()`. Every overlay entity routes through `engine.addManagedEntity` or it escapes `destroy()` |
| `public/starlink/` | Starlink constellation view | Linked from 13 places across the spacetrack nav and `/orbit/` |
| `public/admin/` | **Admin dashboard** (plan 36) | Password-protected; login via `POST /api/admin/login` → HttpOnly HMAC cookie. Panels via `registry.js` — one new file + one line each. `cron.js` computes next-due **client-side from the Actions crons**, never `wrangler.toml`'s (deployable-and-unused). Not in the public nav — reached by typing the URL. 401/400/503 status semantics are **load-bearing** (frontend `api.js` maps bare statuses to messages) — do not regress `adminJson()` to options-object style |
| `public/js/beacon.js` | Pageview beacon, all 8 public pages | Whole body in `try/catch`, no imports — a throwing module here is an 8-page outage. `hit.js` ignores bots, records origin-only referrer, daily-rotating `ip_hash` |
| `public/orbit-engine/` | **Shared globe engine** | `astro.js` + `tle.js` + `sat-engine.js` + `propagate.worker.js` + vendored `satellite.min.js`. Imported by `/orbit/` AND `/spacetrack/` — it had already been fixed twice in two copies, so do not fork it. The worker URL is **absolute**: a relative one resolves against the page and silently falls back to synchronous SGP4 |
| `public/orbit-engine/conjunction.js` + `screen.worker.js` + `screen-client.js` | Close-approach screening | The maths takes its propagator by **injection**, so it is unit-tested in Node against analytic orbits with closed-form answers. Screening runs in a SECOND, **module** worker — never the 280ms render tick — and has **no synchronous fallback** on purpose. The coarse gate is derived from the step (`threshold + 22.4·Δt/2`), never tuned: a tuned gate misses conjunctions silently and looks like "there were none" |
| `public/data/tle/celestrak/` | Shipped TLE baseline | `tle.js` reads `/data/tle`. Refresh with `scripts/snapshot_tle.sh` |
| `functions/api/tle.js` | Pages Function | TLE proxy + edge cache; falls back to the shipped baseline, or reads the R2 bundle for `source=spacetrack` |
| `functions/api/{search,summary,object/[norad],feed,decay-watch,boxscore,brief,analytics,space-weather}.js` | Catalog endpoints | Behind `/spacetrack/`. Tested for real in `workers/orbit-ingest/test/pages-api.test.mjs`. `brief.js` deliberately has **no D1 fallback** — rebuilding the card on a read would pair fresh facts with a sentence checked against older ones. `space-weather.js` is the ONE endpoint with no Space-Track data — its `X-Data-Source` header carries `SWPC_CITATION` (NOAA), not `CITATION` |
| `functions/api/_orbit.js` + `_catalog.js` | Shared function helpers | `_orbit.js:17-19` is the `X-Data-Source` citation, legally required on every response. `_catalog.js` also carries `clamp`/`safeParse`/`artifactOrDb` shared by the R2-then-D1 endpoints |
| `workers/orbit-ingest/src/brief.js` | Daily brief | **Facts in SQL, narrative optional.** A model is asked only to phrase numbers already computed, once a day at ingest, never per request. `checkNarrative()` rejects any sentence containing a numeral absent from the facts — *including a correct one the model derived*, since from the output alone that is indistinguishable from invention. Off unless `ORBIT_AI_CARDS` is set; with it off the panel is still a live digest. Provider swappable (`scripts/ai-node.mjs`), Workers AI default — one call a day makes latency and cost moot, so the tiebreak is operational surface |
| `workers/orbit-ingest/` | Space-Track ingest | Runs from **GitHub Actions**, not the Worker's crons — the GP job needs ~300ms CPU against Workers Free's 10ms. `scripts/env-node.mjs` is a Workers-shaped `env` over the D1 HTTP API + R2 SigV4. Its `npm test` is 301 checks, no network |
| `d1/orbit.sql` | D1 schema | `objects.SITE`/`satcat.SITE` are the raw code (`AFETR`); the human-readable name lives in `launch_sites`, populated weekly from Space-Track's `launch_site` class (plan 38 task 2) |
| `tests/e2e/` | Playwright suites | Including `test_mobile_responsive.py` and `test_mobile_dom.py` — the viewport table there is the mobile contract |
| `scripts/` | Bash helpers | `snapshot_tle.sh` (sleeps between Celestrak group fetches to avoid rate limits), `upload_r2.sh` |
| `scripts/mars-terrain/` | **Leftover** | Unrelated to the orbit catalog; carries a large `.venv/`. Not part of any active plan |

## Frontend conventions

**Cross-package references are root-absolute; intra-package imports are relative.** See
CLAUDE.md — this is the single rule that prevents the class of bug that broke this repo
three times.

### Nav

The nav is **static HTML in the markup**, not rendered by JS, so pages render immediately
without a JS dependency. Each page is a separate `index.html`. When creating a page, copy
this block and set `--active` on the current link:

```html
<nav class="spacetrack-nav" id="main-nav" role="navigation"
     aria-label="SpaceTrack main navigation">
  <a href="/spacetrack/" class="spacetrack-nav__brand">◂ SPACETRACK</a>
  <ul class="spacetrack-nav__list" role="menubar">
    <li><a href="/spacetrack/"             class="spacetrack-nav__link spacetrack-nav__link--active">CATALOG</a></li>
    <li><a href="/spacetrack/signal/"      class="spacetrack-nav__link">SIGNAL</a></li>
    <li><a href="/spacetrack/conjunctions/" class="spacetrack-nav__link">CONJUNCTIONS</a></li>
    <li><a href="/spacetrack/brief/"       class="spacetrack-nav__link">BRIEF</a></li>
    <li><a href="/spacetrack/analytics/"   class="spacetrack-nav__link">ANALYTICS</a></li>
  </ul>
  <a href="/starlink/" class="spacetrack-nav__source-link">STARLINK ↗</a>
  <a href="/orbit/"    class="spacetrack-nav__source-link">CELESTRAK ↗</a>
</nav>
```

Each page also carries a **mobile drawer that duplicates this list verbatim**, plus (on
`/orbit/`) a filter drawer duplicating the desktop filter panel's 15 checkboxes. Every nav
or filter change must touch both copies until plan 34's registry lands. Adding a link to
one and not the other is the most common mobile regression in this repo.

### CSS

`orbit/orbit.css` owns the `:root` token block (`--font-mono`, `--sa-*`, `--hud-blur`,
`--panel-*`, `--nav-height`). **`spacetrack.css` has no `:root`** and inherits those tokens
purely by hand-written `<link>` order — so link order across the five spacetrack pages is
load-bearing until `public/css/tokens.css` exists. `landing.css` shares nothing with either.

37 selectors are defined identically in both `orbit.css` and `spacetrack.css` (all
`.mobile-menu*`, `.mobile-bottom-nav*`, `.filter-drawer*`, `.spacetrack-nav*`).

### Known dead/divergent code

Useful to know before you spend time on it:

- `shared/navigation.js` (97 lines) and `shared/ui.js` (186 lines) — **zero importers.**
- HUD code exists in **three copies**: `orbital-relay.js`, `shared/hud.js`, and a third
  partial in `analytics.js:5-40`. They have **diverged, and `orbit/` is the correct side**:
  `orbital-relay.js:76/84` gate panel-exclusivity on `isMobile()`; `hud.js:48/54` have the
  same code with the guard and the explanatory comments stripped, which makes HUD panels
  mutually exclusive on desktop where there is room for several.
- `.vfx-overlay` and `.noise-layer` divs exist in all four globe-page HTMLs with **zero**
  matching CSS rules.
- `catalog.js:775-882` ≡ `conjunctions.js:289-376`, ~95 lines verbatim.

## Verification

- `npm test` — syntax + resolve checks + the orbit-ingest suite. Offline, seconds.
- `.claude/skills/verify/SKILL.md` — Playwright headless checks. Critical notes:
  - This box is slow (SwiftShader, ~5fps WebGL); use keyboard events, not `page.click`.
  - Always cache-bust with `?cb=<timestamp>`.
  - Check `ps aux | grep chrome-linux64` for strays before debugging a hang.
- **Every UI change is verified at the mobile viewports** in
  `tests/e2e/test_mobile_responsive.py`. See CLAUDE.md's mobile section for the contract.

## Data & attribution

Space-Track.org (USSPACECOM / 18th Space Defense Squadron) and Celestrak. The citation is
returned on every API response as `X-Data-Source` and must be visible in the product. The
conjunction screener ships `⚠ UNOFFICIAL — NOT FOR COLLISION AVOIDANCE` **in the HTML**, not
only the JS — Space-Track's own position is that public TLEs should not be used for
conjunction assessment, and that disclaimer is the reason deriving our own screening is
acceptable at all.

Space weather (plan 34, §3.4) comes from NOAA SWPC — a *different* provider. It carries
its own attribution (`SWPC_CITATION`, public-domain U.S. government work, so courtesy
rather than licence-conditioned): `/api/space-weather` names NOAA in `X-Data-Source`
because its body carries **no** Space-Track data, and `json()`/`artifactOrDb` in
`_catalog.js` take a `citation` override for exactly that. `SWPC_CITATION` is duplicated
across bundles and asserted byte-identical **and ASCII-only** by derive.test.mjs — the
ASCII pin exists because a non-Latin-1 character in the header throws on every
response. `d1/orbit.sql` carries the `space_weather` table (kind/time_tag/value/meta,
truncate-and-reload per kind).

## References

- [CLAUDE.md](CLAUDE.md) — commands, invariants, mobile contract, what not to do.
- [README.md](README.md) — deploy and route map.
- [docs/game-plans/34_unblock_landing_refactor_plan.md](docs/game-plans/34_unblock_landing_refactor_plan.md) — active plan.
- [docs/game-plans/Orbital_Relay_Feature_Specification.md](docs/game-plans/Orbital_Relay_Feature_Specification.md) — 20-feature target spec.
- `.claude/skills/verify/SKILL.md` — Playwright E2E guide.
