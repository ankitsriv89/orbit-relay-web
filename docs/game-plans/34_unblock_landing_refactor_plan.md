# Orbital Relay — Unblock, Landing Page, Features & Refactor

## Context

`docs/game-plans/Orbital_Relay_Feature_Specification.md` describes a 20-feature cinematic
satellite visualization platform. The repo implements a substantial part of it already —
a shared `orbit-engine/` (SGP4 in a worker, PointPrimitive rendering, a genuinely
well-built dependency-injected conjunction screener), 9 Pages Functions over D1 + R2, and
a Space-Track ingest worker with 3,600 lines of tests.

Three things prompted this work:

1. **The `/spacetrack/` app is entirely dead at HEAD.** `catalog.js:1194` reads
   `const LOD FAR_THRESHOLD = 5000000;` — a hard `SyntaxError` (verified with
   `node --check`, exit 1). An ES module with a parse error executes zero statements, so
   all 1,465 lines of the catalog page never run. Separately, the four nested pages use
   `../orbit-engine/` from depth 2, which resolves to `public/spacetrack/orbit-engine/`
   (does not exist), so Signal and Conjunctions load with no Cesium, no satellite.js and
   no CSS. Nothing in the repo would catch this: root `package.json` has no `test`
   script, and CI never runs the suite that does exist.
2. **The landing page is a 48-line placeholder** that consumes zero backend data, ships
   3.2 MB of oversized PNGs, and links to only 2 of the 6 app pages that exist.
3. **Real feature gaps** against the spec, several of which are one-line changes against
   an engine that already supports them.

Intended outcome: a green test gate, a landing page that reflects the product, the
highest-value missing spec features, and a codebase where the `orbit-engine/` discipline
(pure math, injectable, Node-testable) reaches the page layer.

---

## Phase 0 — Unblock + guardrail

Nothing else can be verified until this lands. All of it is mechanical.

### 0.1 Fix the parse error
- [public/spacetrack/catalog.js:1194](public/spacetrack/catalog.js#L1194) —
  `const LOD FAR_THRESHOLD` → `const LOD_FAR_THRESHOLD`. The name is already used
  correctly at [catalog.js:1199](public/spacetrack/catalog.js#L1199).
- Also at [catalog.js:1225](public/spacetrack/catalog.js#L1225): `wirePresetBtns(precentId, decayId)`
  → `recentId` (works, but misspelled).

### 0.2 Fix module import paths
`../orbit-engine/` → `../../orbit-engine/` in:
- [public/spacetrack/shared/globe.js:1](public/spacetrack/shared/globe.js#L1) — note this
  file is at depth 1 but `../orbit-engine/` still resolves outside `public/`; it needs
  `../../orbit-engine/`.
- [public/spacetrack/signal/signal.js:1](public/spacetrack/signal/signal.js#L1)
- [public/spacetrack/conjunctions/conjunctions.js:1](public/spacetrack/conjunctions/conjunctions.js#L1) and `:4`

### 0.3 Fix HTML asset paths + two missing files
**Convert every cross-package reference to root-absolute** (`/orbit-engine/…`,
`/orbit/orbit.css`, `/spacetrack/spacetrack.css`) rather than counting `../`. This is
depth-invariant and matches the rule `sat-engine.js:119` / `screen-client.js:46` already
enforce for worker URLs — same failure mode, same fix. Depth-relative paths caused this bug
twice already (commits `fb66525f`, `dcbb42aa`). Keep intra-package imports relative
(`./shared/utils.js`) since those never change depth.

In `spacetrack/{signal,conjunctions,brief,analytics}/index.html` — **broader than the 12
refs first identified**, all verified:
- `../orbit-engine/cesium-base.js`, `../orbit-engine/vendor/satellite.min.js`, `../orbit/orbit.css`
- `../spacetrack.css` → resolves to `public/spacetrack.css`, **which does not exist**
  (real file is `public/spacetrack/spacetrack.css`). Also broken.
- `../orbit/` used for the brand/HOME link and the CELESTRAK link → resolves to
  `/spacetrack/orbit/`. Also broken.

`spacetrack/index.html` (depth 1) is already correct — do not touch it.

**Two referenced files that do not exist:**
- **`/icon.svg`** — referenced as the favicon by **all 5** spacetrack pages
  (`index.html:6` in each). Never existed. Ship a real vector `public/icon.svg`; this also
  serves Phase 1.3's image-weight fix from one artifact.
- **`/starlink/`** — linked from **13 places across 6 files**
  (`orbit/index.html:38` and `:56`, plus the nav source-link and mobile-menu-source in each
  of the 5 spacetrack pages). No such directory. Resolved by 0.6.

### 0.4 Fix the TLE baseline path
[public/orbit-engine/tle.js:6](public/orbit-engine/tle.js#L6) —
`TLE_FILE_BASE = '/orbit/data/tle'` but the files live at `public/data/tle/celestrak/`.
`public/orbit/data/` does not exist, so every baseline fetch 404s and silently falls
through to `/api/tle` ([tle.js:99-106](public/orbit-engine/tle.js#L99-L106) swallows it).
Change to `/data/tle`. Cross-check `scripts/snapshot_tle.sh` writes to the same place and
update AGENTS.md's "Orbital Relay TLE" section, which names the old path.

### 0.5 Fix the red test
`workers/orbit-ingest/test/conjunction.test.mjs:454` asserts the `⚠ UNOFFICIAL` badge is
in `public/spacetrack/index.html`; the multi-page split moved it to
[conjunctions/index.html:59](public/spacetrack/conjunctions/index.html#L59). Suite is
currently 24/25. Repoint the assertion.

### 0.6 Resolve the Starlink dead UI
[orbital-relay.js:319-389](public/orbit/orbital-relay.js#L319-L389) and `:598-609` wire a
complete Starlink panel (`starlink-controls`, `sl-slider`, `sl-count-display`,
`sl-total-display`, `sl-fetch-all`, `layer-status-starlink`) whose IDs **do not exist** in
`orbit/index.html`. Every `getElementById` returns null. 40 Starlink sats load at
`:434-438` and are immediately set `e.show = false` — permanently invisible with no UI to
reveal them.

**Restore the markup rather than deleting the code.** The JS is complete and appears
correct; only the DOM is missing, so this is a markup-only change that revives a real
capability (a progressive-load slider up to `SAT_CAP_FULL`). Deleting ~90 lines here only
to rewrite them in 3.2 would be wasted work. Add the panel plus a `data-group="starlink"`
checkbox to **both** the desktop panel and the mobile drawer (they are duplicated verbatim
— which is exactly what 3.1's filter registry fixes).

Point the 13 `/starlink/` links at the Starlink filter on `/orbit/` for now; 3.2
generalizes this into a real constellation page where `/starlink/` becomes a preset.

### 0.7 Add the guardrail that would have caught all of the above
New `scripts/check/` run as root `npm test`. Constraints: no build step, no new
dependencies, Node 24 already present, must finish in seconds.

**Check 1 — `syntax.mjs`** (catches 0.1). Walk `public/**/*.js` + `functions/**/*.js`,
skipping `orbit-engine/vendor/` (minified third-party classic scripts), `.venv/`,
`node_modules/`. `spawnSync(process.execPath, ['--check', file])` on each. Root
`package.json` has `"type": "module"`, so `.js` is treated as ESM — this is the exact
invocation already proven to reproduce the `catalog.js` error. ~40 files, ~2 s.

**Check 2 — `resolve.mjs`** (catches 0.2/0.3/0.4). The key insight: with no build step,
browser module resolution is *pure filesystem path arithmetic against `public/` as web
root*, fully simulable with zero dependencies.

1. **Seed from HTML, not JS** — this is the layer that broke in 0.3 and that a JS-only walk
   would miss entirely. Glob `public/**/*.html`; extract every `src=`/`href=` on
   `<script>`, `<link>`, `<img>`, `<a>`.
2. **Resolve as the browser does** — strip `?query`/`#hash`; skip `http(s)://`, `//`,
   `mailto:`, bare `#`; `/`-prefixed → `path.join(PUBLIC_ROOT, ref)`; otherwise
   `path.resolve(path.dirname(file), ref)`.
3. **Assert existence** — a directory or trailing-`/` path is valid if `<dir>/index.html`
   exists (Pages directory-index semantics, which is what makes `/spacetrack/signal/`
   legal). This catches `/starlink/` and `/icon.svg` for free.
4. **Recurse into JS** — for every `.js` under `public/` (referenced or not), regex the
   static ESM forms (`import … from '…'`, `import '…'`, `export … from '…'`) and resolve
   **against the importing file's directory, not the page's**. Encoding that distinction is
   the entire point — it is exactly what the `../orbit-engine` bug got wrong. Require an
   exact extension; browsers do not add `.js`. Any specifier not starting with `.` or `/`
   is an error (no import map, no `node_modules` in `public/`).
5. **Worker URLs** — regex `new Worker('…')` and assert the URL both resolves *and is
   absolute*. AGENTS.md documents that a relative worker URL "silently falls back to
   synchronous SGP4"; this turns a documented trap into an enforced invariant.
6. **CSS `url(…)`** — resolved against the CSS file's directory. Cheap; catches the next
   missing background image.
7. **One invariant, not a path list**: every `public/**/*.html` must reference at least one
   stylesheet that exists. That states the 0.3 symptom ("4 pages load with NO CSS") in a
   form that survives future reorganization.

Output `<file>:<line>  <specifier>  →  <resolved>  MISSING`, exit 1 on any. Document in the
header that it does not see dynamic `import(expr)`, template-literal URLs, or
DOM-constructed `src`; a short `scripts/check/known-external.txt` allowlist covers the CDN
Cesium URLs. Every one of the HEAD bugs is static, so coverage is real where it matters.

Then: `"test": "node scripts/check/syntax.mjs && node scripts/check/resolve.mjs && npm --prefix workers/orbit-ingest test"`.

### 0.8 CI
`.github/workflows/orbit-ingest.yml` is a *scheduled ingest* workflow — wrong place, and
its concurrency group and secret surface have nothing to do with CI. Add a **new**
`.github/workflows/ci.yml`: `on: [push, pull_request]`, `setup-node@v4` with Node 24, run
root `npm test`. No secrets — every check is offline, matching the existing "no network"
test discipline.

**Write the checker before finishing the fixes**, so you watch it go red on the real bugs
and then green. That is the only way to know the guardrail actually guards.

**Verification for Phase 0:** `npm test` green (should report 25/25 from the nested suite
plus the new checks). Then `npx wrangler pages dev public` and load all six pages —
`/`, `/orbit/`, `/spacetrack/`, and the four nested ones — confirming a globe renders and
the console is clean on each. `tests/e2e/` has Playwright coverage; the local
`.claude/skills/verify` skill drives headless Chromium (note its warnings: SwiftShader is
~5fps, use keyboard events not `page.click`, always cache-bust).

---

## Phase 1 — Landing page

Current: [public/index.html](public/index.html) is 48 lines, one flat centered flex column,
no semantic sectioning. [public/css/landing.css](public/css/landing.css) is 162 lines with
**zero** custom properties. [public/js/landing.js](public/js/landing.js) is a 6-line no-op
stub. System font stack, while every product page uses `--font-mono` (JetBrains Mono) —
the landing page's typographic voice is disconnected from the product's.

### 1.1 Design system first
Create `public/css/tokens.css` as the single source of truth, `@import`ed (or
`<link>`ed first) by `landing.css`, `orbit.css` and `spacetrack.css`:
- Move the 86 `--` declarations already in [orbit.css:1-31](public/orbit/orbit.css#L1-L31)
  (`--font-mono`, `--sa-*` safe-area insets, `--hud-blur`, `--panel-*`, `--nav-height`, …).
- Add the **colour tokens that do not exist anywhere today** — 63 hex literals in JS plus
  46 in CSS describe one ~10-colour palette.
- This also fixes a live bug: `spacetrack.css` has **no `:root`** and consumes
  `var(--font-mono)` 13 times plus `var(--sa-*)`, inheriting them from `orbit.css` purely
  by hand-written `<link>` order across 5 files — four of which are broken until 0.3.

The landing page adopts the product's terminal/mono aesthetic rather than the current
generic gradient-card look. Load the `frontend-design` skill before writing the CSS.

### 1.2 Structure
Replace the flat column with real semantic sections:

1. **Hero** — `<canvas>` starfield + orbit-arc motion behind mono type. A few KB of
   vanilla 2D canvas, **not** Cesium (the entry page must not pull the full Cesium bundle;
   mobile load already suffers). Guard the whole animation behind
   `matchMedia('(prefers-reduced-motion: reduce)')` — there is no reduced-motion handling
   anywhere in the repo today.
2. **Live stat strip** — real numbers from `/api/summary`, which is already a 900 s-cached
   flat R2 read returning `{tracked, last_elset_ingest, by_type, by_regime, by_country[25],
   by_operator}`. "28,431 objects tracked · 11,204 payloads · last elset 2 h ago". One
   `fetch`, zero new backend work. Must degrade to static copy if the fetch fails —
   `/api/summary` has a D1 fallback that drops `by_country`/`by_operator` and sets
   `stale:true`.
3. **App cards — all six destinations**, not the current two: `/orbit/` (Celestrak
   cinematic view), `/spacetrack/` (28k catalog), `/spacetrack/signal/`,
   `/spacetrack/conjunctions/`, `/spacetrack/brief/`, `/spacetrack/analytics/`. Each with a
   real one-line description of what it does, replacing the emoji placeholders.
4. **Data provenance** — the Space-Track citation string is legally required and already
   returned on every API response as `X-Data-Source`
   ([functions/api/_orbit.js:17-19](functions/api/_orbit.js#L17-L19)). It belongs on the
   landing page. Note the conjunction screener's `⚠ UNOFFICIAL — NOT FOR COLLISION
   AVOIDANCE` framing should carry through here too.
5. **Footer** — tech credits, source link.

### 1.3 Asset weight
`public/orbit/logo.png` is **1,538,370 bytes** at 1254×1254, rendered at 80 CSS px.
`public/orbit/favicon.png` is **1,741,114 bytes** at 1024×1024. That is 3.2 MB for a
thumbnail and a favicon. Downscale to a 96 px logo + 32/180 px favicons (keep one ~512 px
for PWA/OG), target < 40 KB total.

### 1.4 Head / SEO
Currently missing entirely: `<meta name="description">`, OpenGraph, Twitter card,
canonical, `theme-color`. Add all, plus an OG image.

### 1.5 Add `public/_headers` and `public/_redirects`
**Neither file exists**, despite AGENTS.md stating they must stay at the root of `public/`.
Add `_headers` for cache-control on static assets and basic security headers. This is also
where the four nested `/spacetrack/*/` directory routes should be confirmed to resolve.

---

## Phase 2 — Refactor

Runs against the green gate from Phase 0. Split into pure deletion (no behaviour change,
land immediately) and structural work.

### 2.1 Pure deletion — ~650 lines, zero behaviour change
- **Delete `shared/navigation.js` (97 lines) and `shared/ui.js` (186 lines).** Zero
  importers, verified. AGENTS.md's own "Key decision" section explains the nav became
  static HTML instead. `ui.js:152-167` duplicates `globe.js:82-90` verbatim, and
  `ui.js:39`'s `insertAdjacentHTML` is the last arbitrary-HTML sink in the codebase.
  **Salvage before deleting:** `ui.js:152-167`'s time-warp builder is one of the three
  places 3.1's rate change must touch — fold it into `globe.js` first.
- **Collapse the 3 copies of the HUD code.** ~230 of 676 lines of `orbital-relay.js`
  duplicate `shared/hud.js` + `shared/globe.js` (`collapsePanel`, `wireHudToggle`,
  `initHamburgerMenu`, `initFilterDrawer`, the MQ handler, the viewer config,
  `updateClock`, time-warp wiring). `analytics.js:5-40` is a **third** copy that
  re-declares `MOBILE_MQ`/`_hudPanels`/`collapsePanel` locally despite `hud.js` being a
  sibling import away. Move `hud.js` to a neutral `public/shared/hud.js` (it is currently
  under `spacetrack/shared/`, which `orbit/` cannot reasonably import from — the directory
  is really `spacetrack/internal/`).
  **Behaviour has already diverged, and `orbit/` is the correct side.**
  `orbital-relay.js:76/84` gate on `isMobile()`; `hud.js:48/54` do not. The `orbit/` version
  carries comments explaining exactly why ("On narrow screens keep only one panel expanded
  so cards don't overlap"; "while one panel is open, hide the OTHER collapsed chips so an
  expanded panel can never cover (and block taps on) another chip"). `hud.js` has the same
  code with the comments and the guard stripped — an accidental regression that makes HUD
  panels mutually exclusive on desktop, where there is room for several. Promote the gate
  into `hud.js` as an option (`wireHudToggle(hudId, toggleId, bodyId, { exclusive: 'mobile' })`)
  rather than silently dropping it.
- **Extract `shared/dossier.js`.** `catalog.js:775-882` ≡ `conjunctions.js:289-376`,
  ~95 lines verbatim including all 13 `setText('d-*')` calls. Export
  `{open, close, refreshLive}` taking `{engine, onSelect}`.
- **Route every fetch through `shared/api.js`.** It already exports a typed `API` object;
  `catalog.js` uses it for 2 of 8 endpoints and hand-rolls raw `fetch` for 6 (`:438, 471,
  507, 610, 811, 1252, 1282, 1363`); `conjunctions/signal/brief/analytics` bypass it
  entirely. Kills 8 duplicated `if (!r.ok) throw` blocks and the one stray `.then()` chain.
- **De-dupe the API helpers.** `clamp` ×3 (`search.js:159`, `feed.js:69`,
  `decay-watch.js:97`), `safeParse` ×3 (`feed.js:64`, `object/[norad].js:102`,
  `derive.js:469`), the R2-then-D1 fallback block ×3 (`summary.js:20-30`, `feed.js:28-39`,
  `analytics.js:22-32`), the CORS object defined 3× with different shapes. Add `clamp`,
  `safeParse`, `artifactOrDb(env, key, fallbackFn)` to `_catalog.js`. Delete the never-imported
  `_orbit.js:24 citationHeaders()`.
  *Keep* the deliberate cross-bundle duplication of `parseEpochUTC` and `CITATION` — those
  are documented and asserted byte-identical by `derive.test.mjs`.
- **De-dupe CSS.** 37 selectors defined in both `orbit.css` and `spacetrack.css` (all of
  `.mobile-menu*`, `.mobile-bottom-nav*`, `.filter-drawer*`, `.spacetrack-nav*`) → move to
  `public/css/chrome.css`. Delete 6 dead selectors (`.st-conj`, `.st-feed--decay`,
  `.st-page-grid`, `.st-site-label`, `.year-label`, `.year-status`).
- **Unify the palette.** `CB_TYPE_COLORS`/`CB_COUNTRY_COLORS` at `catalog.js:48-73` and
  `TYPE_COLORS`/`COUNTRY_COLORS` at `shared/utils.js:53-79` are two halves of one table in
  two files. Single `public/theme/palette.js`, generated from the same list as the CSS
  colour tokens from 1.1.

### 2.2 Structural
- **Split `catalog.js` (1,465 lines, 17 responsibilities).** Extract
  `overlays/{heatmap,debris,launch-sites,age,lod}.js`, each taking
  `{viewer, engine, getRendered}`: hover `:191-235`, heatmap `:237-310`, debris `:905-976`,
  launch sites `:978-1147`, age `:1149-1188`, LOD `:1190-1220`, presets `:1222-1300`.
  Leaves ~500 lines of page glue.
  While there: `catalog.js` reaches around `SatEngine` to `viewer.entities.add` directly at
  `:748, :946, :1102, :1396`, so those entities escape `engine.destroy()` cleanup
  ([sat-engine.js:581](public/orbit-engine/sat-engine.js#L581)). Route them through the engine.
- **Extract pure math out of DOM handlers so it becomes testable.** This is the
  highest-leverage structural change: `orbit-engine/conjunction.js` takes its propagator by
  **injection specifically so it can be unit-tested in Node against closed-form analytic
  orbits** — that discipline never reached the page layer. These are all mathematically
  self-contained but trapped inside `addEventListener` callbacks reading `$('rf-freq').value`:
  `signal.js:172-191` (visibility-window state machine), `:317-334` (pass detection),
  `:369-396` (link budget), `:241-256` (coverage-circle spherical geometry),
  `catalog.js:1154-1165` (age→rgba ramp), `:249-292` (heatmap binning).
  New `signal/compute.js` + `catalog/compute.js` of pure functions; handlers become
  read-inputs → call → render. **Add the first frontend unit tests** against them, in the
  existing `workers/orbit-ingest/test/` harness (which already reaches into
  `public/orbit-engine/`).
- **Tame the globals.** 39 module-level `let`s; `catalog.js` alone has 14, and
  `clearRendered()` at `:553-575` exists purely to untangle six flags by hand — reading
  `debrisCloudVisible`/`launchSitesVisible`/`ageColorMode` that are all *declared after it*
  and only work via hoisting. `window.__spacetrack` is assigned by 5 modules with 5
  incompatible shapes (last import wins, silently) — unify to one shape.
  `shared/globe.js` is a singleton with import side effects: sets `window.viewer` at `:23`,
  registers `beforeunload` at module top level `:117`, injects DOM at `:82`. Make
  `initGlobe()` own its lifecycle explicitly.
- **Error handling.** 6 swallowed catches leave `dossier-status` at `'loading…'` forever
  (`catalog.js:844`, `conjunctions.js:347`, `signal.js:60`). 9 unguarded
  `$('id').addEventListener` calls (`signal.js:106,110,142,218,279,362`;
  `catalog.js:710,711,719`) throw at import if an ID is missing, unregistering every later
  handler. Add an `on(id, ev, fn)` helper that no-ops on a missing node.
- **`functions/api/telemetry.js:59`** reads `env.TELEMETRY_DB`, which is **not bound** in
  `wrangler.toml` — the endpoint is permanently in its accept-and-drop path. Either bind it
  or delete the endpoint; it is Mars-Sim game analytics unrelated to the orbit catalog.

---

## Phase 3 — Features

Ranked by value ÷ effort. All four tracks requested.

### 3.1 Cheap client-side wins (data already served)
- **Past orbit + multi-rev** (spec #3). `sat-engine.js:277-292` and
  `propagate.worker.js:144-153` sample **forward from now for exactly one period** —
  the loop is `i = 0..steps`, never negative, and `steps` is hardcoded 90/120
  (`sat-engine.js:457, :534`). Change the loop bound to `-steps/2 … +steps*revs`. Two files,
  one bound each. Closes "draw previous and future orbits" and "predict multiple orbital
  revolutions".
- **Time rates** (spec #14). Currently 0/1×/60×/600× (`orbit/index.html:372-375`,
  `shared/globe.js:85-88`). Spec asks 1×/10×/100×/1000×. Note this touches the duplicated
  time-warp wiring — do it *after* 2.1 collapses the copies, not before.
- **Dossier completeness** (spec #2). `apogee_km`/`perigee_km` are computed and normalised
  by `object/[norad].js:90-91` and have **zero frontend references**. Same for `regime`,
  `debris_family`, `launch_year`, `first_seen`, `satcat_rcs_m2`. The `/orbit/` inspector
  (`orbital-relay.js:470-492`) shows only name/group/lat/lon/alt/vel/period/regime — no
  NORAD, COSPAR, operator, country or launch date, all of which `/spacetrack/`'s dossier
  already renders. Unify via the `shared/dossier.js` extracted in 2.1.
  Badge `operator` as derived — it is inferred from `OBJECT_NAME` by `operators.js`, not
  authoritative, and every endpoint already returns `operator_derived: true`.
- **LEO/MEO/HEO shells** (spec #13). Only the GEO belt is drawn
  (`catalog.js:1388-1424`, two glowing rings). Reuse that exact code path for the other
  three regimes; `astro.js:52-57 orbitRegime()` already classifies them.
- **The `.vfx-overlay` CSS that was never written.** `.vfx-overlay` and `.noise-layer`
  divs exist in all four globe-page HTMLs (e.g. `orbit/index.html:21-23`) with **zero**
  matching CSS rules — confirmed by grep. Either write the film-grain/vignette treatment
  they imply (cheap, pure CSS, contributes to spec #20) or delete the dead markup.
- **Missing filters** (spec #1). No Active, no Military, no Rocket Body toggle on `/orbit/`.
  The 15 existing filters are hardcoded HTML checkboxes **duplicated verbatim** between the
  desktop panel (`orbit/index.html:122-313`) and mobile drawer (`:444-613`), read via
  `cb.dataset.{group,color,cap}` at `orbital-relay.js:588-618`. Replace with a **JS layer
  registry** that renders both copies from one array — this is a prerequisite for adding
  filters without doubling the markup again.

### 3.2 Constellation / orbital-plane view (spec #7, fully missing)
Highest-value missing visual. Group objects by RAAN (`RA_OF_ASC_NODE`) + inclination +
semi-major axis into orbital planes, render each plane as a great-circle ring with the
shell it occupies. Starlink / OneWeb / GPS / Galileo / Iridium.

**Pure client-side** — the elements are already served: `/api/search?tle=1&limit=500`
returns `TLE_LINE1/2`, and `/api/object/:norad` returns `RA_OF_ASC_NODE`, `INCLINATION`,
`SEMIMAJOR_AXIS` directly. No backend work.

Caveat: `RENDER_CAP = 500` (`catalog.js:15`) and `SAT_CAP_FULL = 8000`
(`orbital-relay.js:31`) currently bound how many objects can be on screen; a full Starlink
shell view will need those raised, which is what the LOD system at `catalog.js:1190-1220`
is for. Verify frame rate before raising caps.

### 3.3 Cinematic pass (spec #20)
Currently: atmospheric scattering and the day/night terminator exist (Cesium built-ins,
`orbital-relay.js:219-228`); bloom, HDR starfield and eclipse shadow are all absent —
zero `PostProcessStage` hits in the tree.
- Bloom via `scene.postProcessStages.bloom`.
- A star `skyBox` (Cesium supports a cubemap; needs asset sourcing — keep it small given
  the 3.2 MB lesson from 1.3).
- Eclipse/umbra shading: test each satellite against Earth's shadow cylinder — cheap
  analytic test, fits naturally in `astro.js` beside `footprintRadiusM()`.

**Must ship behind a quality toggle** persisted via `shared/state.js`. This box renders at
~5 fps under SwiftShader, and bloom on mobile is expensive.

### 3.4 Space weather + ground stations (new backend)
The only track requiring backend work. Both slot cleanly into the existing ingest
architecture — `workers/orbit-ingest/src/index.js` dispatches on `event.cron` through a
`step()` helper (`:39-51`) that deliberately does not chain on success, so a new source
cannot take down the existing ones.

- **Space weather** (spec #16). No Kp, Ap, solar flux or geomagnetic data exists anywhere.
  Add a NOAA SWPC ingest (`ingest-spaceweather.js`, following the shape of
  `ingest-boxscore.js` — the smallest existing example at 58 lines), a D1 table, an R2
  artifact, and a `/api/space-weather` endpoint using the `artifactOrDb` helper from 2.1.
  Render Kp/aurora as a globe overlay. Note SWPC is a *different* provider from
  Space-Track — the citation handling (`_orbit.js:17-19`) is currently single-source and
  will need a second attribution string.
  Radiation belts and eclipse regions are geometric, not fetched — they can be drawn from
  the same analytic work as 3.3's eclipse shading.
- **Ground stations** (enables spec #6 comm links). `signal.js:73-94` already hardcodes 20
  `GROUND_STATIONS` that are only `<select>` options and are **never rendered on the
  globe**, and `signal.js:362-404` already computes a full link budget (EIRP, path loss,
  G/T, SNR, margin) that **draws nothing**. So the maths exists; what is missing is a real
  table plus the rendering. Add a `ground_stations` D1 table, seed it, serve it, render the
  stations as globe markers, and animate the sat↔ground link the link budget already
  characterises. Inter-satellite links are a further step.
  Related: `objects.SITE` is a raw code (`AFETR`) with **no human-readable mapping anywhere
  in the repo**, despite `orbit.sql:98-99` claiming SATCAT carries one. A site-name lookup
  table would improve the dossier and `/api/analytics.top_launch_sites` at the same time.

### Not scoped
Sensor swaths (#17), historical replay (#18), maneuver detection, launch countdowns and
pass notifications are out of scope for this pass. Maneuver detection in particular needs
elset *history*, and `objects` keeps only the latest elset per NORAD — it would need a new
time-series table and a retention policy. Worth a follow-up plan.

Also note: **pass prediction (#15) already exists and is fully built** at
`signal.js:279-359` (arbitrary lat/lon, 1–30 days, elevation mask, duration filter) — it is
simply unreachable until Phase 0 fixes the imports. It lacks only a geolocation button;
`navigator.geolocation` appears nowhere in the repo.

---

## Sequencing

```
1  Phase 0        parse error · import/asset paths · icon.svg · TLE path · red test
                  · starlink markup · npm test + ci.yml     ── GREEN GATE ──
2  2.1 HUD        unify the 3 copies — biggest deletion, do it while the code is
                  still simple, and before the landing page forks a 4th nav
3  1.1 + 2.1      tokens.css / palette — landing and product palette together
4  Phase 1        landing page: structure, live summary, starfield, images, SEO
5  2.1 rest       dossier + results extraction, api.js routing, dead-code deletion
6  2.2            catalog.js split + first frontend unit tests → npm test grows
7  3.1            past-orbit · time rates · dossier fields · vfx css · shells
                  (all XS/S, land together)
8  3.2 + 3.1      constellation view (+ /starlink/) · filter registry
9+ 3.3, 3.4       cinematic pass, then space weather + ground stations
```

Step 2 before step 4 deliberately: the landing page's sticky header should reuse the
unified nav conventions rather than fork a fourth copy.

## Open decisions

Reasonable defaults are assumed for all of these; flag if you disagree.

1. **`shared/` location.** Both the landing page and `/orbit/` want `api.js` and `hud.js`,
   which currently live under `public/spacetrack/shared/`. Assumed: move to
   `public/shared/` in 2.1 — one-time path churn across ~6 files, cleaner end state.
2. **`functions/api/telemetry.js`.** Reads an unbound `TELEMETRY_DB`; it is Mars-Sim game
   analytics unrelated to this catalog. Assumed: delete the endpoint and `d1/telemetry.sql`.
   Bind it instead if the game still reports here. Dead code that *looks* live is worse
   than absent code.
3. **Ground stations storage (3.4).** Assumed: a static JSON file, not a D1 table —
   ~50 curated stations that barely change do not need a database, and `signal.js:73-94`
   already hardcodes 20.
4. **Canonical hostname.** `wrangler.toml:3` says `orbitalrelay.space` and commit
   `40bfca83` set the Cesium Ion token for it — assumed correct for OG/canonical tags.
   Note AGENTS.md instead documents deploying to `signal-playground-0uj.pages.dev`, so
   confirm which is production before hardcoding.
5. **Cache-control for `/css/*` (1.5).** Without content-hashed filenames, `immutable`
   long-TTL caching is unsafe, and hashing would require a build step that AGENTS.md
   forbids. Assumed: `max-age=3600, stale-while-revalidate=86400`.

## Verification

- **Phase 0:** `npm test` green (25/25 nested + the new parse/import/asset checks). Then
  `npx wrangler pages dev public` and load all six routes, confirming a globe renders and
  the console is clean. Deliberately reintroduce the `LOD FAR_THRESHOLD` typo and a bad
  `../orbit-engine/` path to confirm the new checks actually fail.
- **Phase 1:** Lighthouse on `/` — verify total transfer drops from ~3.2 MB, and that the
  stat strip degrades to static copy when `/api/summary` is blocked. Check the hero with
  `prefers-reduced-motion: reduce` forced.
- **Phase 2:** `npm test` after every extraction. The refactor is behaviour-preserving, so
  the E2E suite in `tests/e2e/` is the real gate — run it before and after and diff.
  Confirm `engine.destroy()` now reclaims the entities that were escaping it.
- **Phase 3:** New unit tests for the pure functions extracted in 2.2 and for the
  orbital-plane grouping, run in the existing Node harness. Visual checks via the
  `.claude/skills/verify` Playwright skill — note its constraints (SwiftShader ~5 fps, use
  keyboard events not `page.click`, always cache-bust with `?cb=<timestamp>`, check for
  stray `chrome-linux64` processes before debugging a hang).
- Deploy per AGENTS.md:
  `wrangler pages deploy public --project-name signal-playground --commit-dirty=true`.
