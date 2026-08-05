# Session Handoff — Plan 34 Phase 3.3 (cinematic pass, spec #20)

> One task per session; commit after each task; read this file at the start of every
> new session. Tasks C1–C5 are ordered so each commit leaves `main` in a working,
> deployable state. **The 3.2 batch (C1–C4) is complete and archived** below.

## How to work this batch

1. Pick the next task with `status: pending` from the todolist (C2 next).
2. Read the linked plan docs (§References) and the "Load-bearing details" below —
   they encode outages this repo has already had.
3. Implement, then commit with a message matching repo style (see `git log`:
   `fix:`, `feat:`, `test(e2e):`, `refactor:` + short imperative subject).
4. Append "done / status" under the task below, and if anything surprising came up,
   add it to "Surprises & decisions". Keep this file committed — it is the memory.

## C2 prep notes (explored at end of the C1 session, not yet implemented)

- **Engine hook**: `sat-engine.js` `_refreshOcclusion()` (line ~591) runs on
  `scene.preRender` — once per drawn frame, NOT in the 280 ms propagation tick.
  It computes `fade = farSideFade(prim.position, cam)` (both ECEF metres) and
  writes `prim.color` rebuilt from the `baseColor` snapshot, only when
  `|fade − _appliedFade| ≥ 0.01` (every write dirties the collection's packed
  buffer; a parked camera must settle to zero writes). Eclipse multiplies into
  the same alpha: `b.a * fade * eclipse`. **`occlusion.test.mjs`'s purity test
  slices sat-engine.js from the literal `_refreshOcclusion()` to `setSatColor(`
  and asserts `baseColor` appears and `= prim.color` does not** — keep both
  invariants intact while editing inside that slice.
- **Sun position**: the vendored satellite.min.js (v5.0.0, 22 KB trimmed build)
  has **no `sunPosition`** — don't try to reuse it. Cesium provides ECEF sun
  positions: `Cesium.SunPosition.compute(viewer.clock.currentTime, scratch)`
  (one call per frame is the budget, matching the "deliberately does NOT call
  requestRender()" discipline) or `viewer.scene.sun.positionWC` (already updated
  by Scene.update each frame). Same ECEF-metre frame as `prim.position`.
- **Gating**: the plan (§3.3, line 394-396) says the whole pass ships behind a
  quality toggle persisted via `shared/state.js`. /orbit/ already imports
  `State` (`/spacetrack/shared/state.js`, orbital-relay.js:29) and subscribes to
  `trajectory.revs`. Suggest a new key (e.g. `quality: { cinematics: 'high' |
  'low' }`) in `spacetrack_state_v1`. The engine needs a setter (a field the
  page flips, or `engine.setCinematics(...)`) — the eclipse pass lives in the
  SHARED engine, so /spacetrack/, /starlink/ and /constellations/ inherit it
  once wired; the latter two don't import State, so they keep the engine
  default. Plan text centers on /orbit/ — keep C2's UI work there.
- **UI**: /orbit/'s HUDs are `iss-hud` + `layers-hud` via `wireHudToggle`.
  A cinematic-quality row belongs in the layers HUD following the revs-toggle
  precedent — authored TWICE (`#revs-toggle` desktop + `#revs-toggle-drawer`),
  kept in sync by `syncRevsButtons()` querying `[data-revs-label]` globally.
  A quality control will need the same double-authoring + a global-sync pattern
  unless it lives somewhere not duplicated. Read `public/orbit/index.html`'s
  layers-hud markup in C2.
- **Defaults**: plan warns this box renders ~5 fps under SwiftShader and bloom
  on mobile is expensive. Suggest: no saved key → default `low` on mobile /
  `high` on desktop at first boot, persisted thereafter. Decide in C2.
- **Verification**: `npm test` (now 20 orbit-ingest suites) + a custom headless
  Playwright probe like the 3.2 pattern. The canvas renders black in this
  sandbox (Cesium Ion 403), so eclipse *visuals* can't be eyeballed — assert
  toggle/DOM state, the engine flag, sun-position plumbing and zero console
  errors, and trust C1's unit tests for the math.

## Task list

- [x] **C1 Shadow math + tests** (commit `b276191a`): `eclipseShadowFactor(p,
      sun, { earthR })` + `SUN_ANGULAR_RADIUS_RAD` (0.266°) added to
      `public/orbit-engine/astro.js` beside `footprintRadiusM()`. Cylinder
      model: lit when `p·ŝ ≥ 0` (incl. the terminator), graded smoothstep across
      the penumbra between umbra radius `earthR − band` and `earthR + band`,
      `band = L·tan(θ_sun)` growing with depth L behind the terminator plane
      (~195 km at GEO depth, ~4.6 km at 1,000 km). Degenerate sun/origin → 1
      (lit, never NaN); scale-invariant (metres vs km). **Not called anywhere
      yet — inert until C2.** New suite
      `workers/orbit-ingest/test/eclipse-compute.test.mjs` (14 checks, all
      closed-form geometry: mid-penumbra at perp=R is exactly 0.5, exact umbra/
      penumbra boundaries, monotone ramp, GEO equinox eclipse, off-axis sun,
      unit invariance, domain `L < R/tanθ` pinned across the whole camera range)
      wired as suite #20 in the orbit-ingest `npm test` chain. `npm test` green:
      72/72 syntax, 62 files resolve, 20 suites. Repo is now 9 commits ahead of
      origin — push when the user asks.
- [x] **C2 Quality toggle + eclipse wiring** (commit pending): state key,
      /orbit/ HUD control (desktop + drawer), engine sun per frame + multiply
      into `_refreshOcclusion`'s alpha behind the toggle.
      - **State**: `quality.cinematics` ('high'|'low', default 'high') added to
        `spacetrack_state_v1`; `State.STORAGE_KEY` now exported so callers can
        distinguish "saved" from "default".
      - **Engine**: `SatEngine.cinematics` field (default 'high') +
        `setCinematics(level)` (validates, no-ops on same, `requestRender()` on
        flip — the first frame after a change rewrites every visible point).
        `_refreshOcclusion()` computes ONE `sunDirectionEcef(this.now())` per
        drawn frame in 'high' and multiplies `alpha = fade × eclipseShadowFactor`,
        skipping it in 'low' — a day-side sat is exactly the old behaviour, and
        the 0.01 no-op threshold applies to the combined multiplier. Both
        occlusion.test.mjs purity invariants held (baseColor rebuild, no read
        back off the live primitive, no fade in the tick slice).
      - **New pure function `sunDirectionEcef(date)` in astro.js** (Meeus/NOAA
        solar position: mean longitude + equation of centre + nutation/
        aberration + GMST → ECEF unit vector, ~0.01° accuracy). **Why**: the
        prep notes' `Cesium.SunPosition.compute` does NOT exist in Cesium
        1.113's classic build — verified live (`Cesium.SunPosition` is
        undefined; scene.sun has no positionWC either). First attempt used the
        Schlyter constant set, whose epoch bias put the equinox ~1.4 days late
        (decl −0.589° at the true instant) — caught by the new closed-form
        tests; Meeus constants are exact (equinox −0.010°, solstices ±23.436°,
        J2000 −23.03°).
      - **/orbit/ UI**: CINEMATICS row in the layers HUD + mobile drawer
        (authored twice like revs-toggle; `data-cinematics`/`data-cinematics-label`,
        synced by a global query). **First-boot device default**: no saved key →
        'low' on mobile / 'high' on desktop, persisted immediately (the plan
        warns bloom — C3, same toggle — is expensive on mobile). Boot wiring:
        resolve → `engine.setCinematics` → sync buttons → wire both buttons →
        `State.subscribe` (engine + buttons on change). `isMobile` had to be
        added to orbital-relay.js's hud.js import (it was not imported; the
        ReferenceError aborted module eval and left `stationEntities` in TDZ —
        the probe's second pageerror was that downstream symptom).
      - **/spacetrack/** (all 5 pages): `globe.js` applies
        `State.get('quality.cinematics')` to the engine at init — no toggle UI,
        follows the persisted key, engine default when unset. /starlink/ +
        /constellations/ don't import State → engine default 'high'.
      - **Verified**: `npm test` green — 72/72 syntax, 62 files resolve, 528
        checks / 20 suites (eclipse suite now 24: the 14 C1 checks + 6 new
        sun-direction tests: unit norm, solstice/equinox declination anchors
        ±0.5°, seasonality, and an integration test feeding the real sun axis
        into `eclipseShadowFactor` — antipode eclipsed, sub-solar point lit).
        New probe `c2_cinematics_probe.py` (serve.py 8932, pattern from the
        c4_constellations probe): **26/26** at 1400×900 + 390×844 — first-boot
        default (desktop high / mobile low) persisted to storage; button text/
        aria-pressed/--on; desktop + drawer stay in sync through both clicks;
        reload keeps the level; **deterministic sun-plumbing proof**: sat
        parked at the true sun's antipode (6,800 km, camera on the same ray) —
        'low' leaves alpha ≈ 1 (camera fade only), 'high' multiplies the
        eclipse factor to 0.000; pass invariant `prim.color.alpha ==
        baseColor.a × _appliedFade` holds; zero console/page errors. Also
        confirmed /spacetrack/ boots with `engine.cinematics === 'high'` and no
        errors. `window.__orbit.state` added to the debug handle (module scope
        isn't global — the probe couldn't reach `State` otherwise).
- [ ] **C3 Bloom**: `scene.postProcessStages.bloom` behind the toggle.
- [ ] **C4 Star skyBox**: procedural cubemap behind the toggle (no external
      assets — the 3.2 MB lesson from plan 34 §1.3).
- [ ] **C5 Batch close**: verification battery + build log / changelog /
      issues log + archive this batch.

## Load-bearing details (from the 3.2 batch, still current)

- **No build step.** Plain ES modules; a SyntaxError kills the whole page/module
  tree. Cross-package refs are root-absolute (`/shared/…`, `/orbit-engine/…`),
  intra-package relative. Verify by opening the pages, not by reading.
- **Worker URL must stay absolute** (`/orbit-engine/propagate.worker.js`): a
  relative URL resolves against the page and silently falls back to synchronous
  SGP4.
- **`X-Data-Source` citation**: every API response must carry it
  (`functions/api/_orbit.js:17-19`) — unchanged by this batch, don't touch.
- **Nav + filter drawer**: mobile drawer duplicates nav verbatim. Layer
  checkboxes no longer need hand-duplication as of S11 — `public/orbit/layers.js`'s
  `LAYERS` registry + `renderLayerList()` builds both `#layer-list` and
  `#layer-list-drawer` from one source. The revs-toggle button (S6) and
  hamburger/nav chrome are still hand-duplicated.
- **State shape** (`public/spacetrack/shared/state.js`, key `spacetrack_state_v1`).
  /orbit/ uses it ONLY for `trajectory.revs`; /starlink/ and /constellations/
  do NOT use State at all.
- **Overlay pattern** (plan 34 2.2): `public/spacetrack/overlays/*.js` are
  factories `createX({viewer, engine, getRendered})`; every overlay entity must
  route through `engine.addManagedEntity` or it escapes `destroy()`.
- **serve.py**: `python3 tests/e2e/serve.py 8932` (no-store header, root = public/).
  Chrome strays: `ps aux | grep chrome-linux64` before debugging a hang. SwiftShader
  is slow — keyboard events, not `page.click`, and cache-bust with `?cb=<ts>`.
- **Headless probes on this box**: `instanceof Cesium.*MaterialProperty` reads are
  unreliable against the CDN build; `material.getType()` (`'PolylineDash'`/
  `'PolylineGlow'`) is the reliable discriminator. Canvas renders black (Cesium
  Ion 403 in this sandbox) — verify DOM/console behavior, not pixels.
- **Node/nvm**: `node` is not on PATH; source `~/.nvm/nvm.sh && nvm use 24` first.
- `reports/orbit_wave0.png` is an uncommitted E2E artifact — leave it alone.

## References

- `docs/game-plans/34_unblock_landing_refactor_plan.md` — Phase 3.3 = this batch
  (§3.3 lines 384-396: bloom via `scene.postProcessStages.bloom`; star skyBox
  cubemap, keep small; eclipse shadow cylinder test "fits naturally in astro.js
  beside footprintRadiusM()"; all behind a quality toggle persisted via
  `shared/state.js`; sequencing step 9+).
- `docs/game-plans/Orbital_Relay_Feature_Specification.md` — feature #20
  (cinematic effects, lines 107-109: glow, bloom, HDR stars, atmospheric
  scattering, orbit pulses, sunlight terminator, eclipse shadows).
- `CLAUDE.md` + `AGENTS.md` — invariants, mobile contract, commands.

## Surprises & decisions

- **Cesium 1.113 has no `SunPosition` — the prep notes' suggested API is gone.**
  Verified live: `Cesium.SunPosition` is undefined, and `scene.sun` exposes no
  positionWC in the classic build. The sun direction is now a pure
  `sunDirectionEcef(date)` in astro.js (Meeus/NOAA formulation, GMST rotation
  to ECEF, ~0.01°), unit-tested with astronomy-given anchors. This is the
  same "don't rely on the vendored library for the sun" trap the prep notes
  flagged for satellite.js — Cesium turned out to be the same trap in 1.113.
- **Schlyter's sun constants carry an epoch bias that the solstice anchors
  cannot catch.** The first implementation (the classic "Position of the Sun"
  constant set) passed June/December ±0.5° but put the 2026 equinox ~1.4 days
  late (decl −0.589° at the true instant) — a phase error in the mean
  longitude that vanishes at the solstices and shows up at the crossings.
  Swapped to the Meeus/NOAA constants (equinox −0.010°, J2000 −23.03°). The
  four-anchor declination suite (both solstices AND both equinoxes) is what
  made the swap testable at all.
- **First-boot device default needs the raw storage, not `State.get`.** The
  state.js default 'high' is indistinguishable from a saved 'high', so the
  "no saved key → mobile low" rule reads `localStorage` via the newly exported
  `State.STORAGE_KEY`. `State` is a plain module export — module scope is not
  global, so the headless probe drives state through the new
  `window.__orbit.state` debug handle.
- **`isMobile` was not imported by orbital-relay.js** — the C2 code was the
  first caller. The ReferenceError aborted module evaluation and the probe's
  second pageerror (`stationEntities` TDZ) was the downstream symptom, which
  is why the probe reported two errors for one root cause.
- **The eclipse pass is provable without pixels** (canvas renders black here):
  park one sat at the antipode of the REAL sun direction (imported from
  astro.js in the page via dynamic `import()`), put the camera on the same
  ray, diff alpha between 'low' and 'high' — 1.0 vs 0.000. Deterministic
  closed-form geometry, no reliance on which sats happen to be in shadow.
- **The vendored satellite.js has no sun position.** v5.0.0 trimmed build (22
  KB) exposes no `sunPosition` — the standard library's sun module wasn't
  vendored in. Resolved (with the Cesium 1.113 gap above) by the pure
  `sunDirectionEcef` in astro.js.
- **Units: metres by default.** `eclipseShadowFactor` defaults `earthR` to
  `EARTH_R_KM * 1000` to match `farSideFade` and the ECEF-metre `prim.position`
  the engine feeds it; the function itself is unit-agnostic (scale-invariance
  is pinned by a test) as long as p/sun/earthR agree.
- **Cylinder + graded penumbra, not binary.** The plan asks for the cheap
  cylinder test; the penumbra smoothstep (band = L·tanθ) keeps a satellite
  crossing the shadow edge from popping between two brightnesses — the same
  call `farSideFade`'s grading makes (see its doc comment).
- **Boundary placement is the loaded decision in C1's tests**: umbra radius
  `earthR − band`, penumbra outer `earthR + band`, and perp = R exactly ⇒
  factor = 0.5 (a closed form, pinned by smoothstep(0.5) = 0.5). Tests
  recompute `band` from the exported constant rather than re-deriving the
  implementation's formula verbatim.

---

# Session Handoff — Plan 34 Phase 3.2 (constellation / orbital-plane view)

> One task per session; commit after each task; read this file at the start of every
> new session. Tasks C1–C4 are ordered so each commit leaves `main` in a working,
> deployable state. **The 3.2 batch (C1–C4) is complete and archived** (see the
> archived 3.1 batch below for the same format).

## How to work this batch

1. Pick the next task with `status: pending` from the todolist (C3 next).
2. Read the linked plan docs (§References) and the "Load-bearing details" below —
   they encode outages this repo has already had.
3. Implement, then commit with a message matching repo style (see `git log`:
   `fix:`, `feat:`, `test(e2e):`, `refactor:` + short imperative subject).
4. Append "done / status" under the task below, and if anything surprising came up,
   add it to "Surprises & decisions". Keep this file committed — it is the memory.

## C2 prep notes (explored at end of the C1 session, not yet implemented)

Page model: `public/starlink/index.html` + `starlink.js` + `starlink.css` — the
exact template to copy for `public/constellations/`. Facts the next session needs:

- **starlink.js layout map**: HUDs at `top: calc(90px + var(--sa-top))`, left/right
  `24px`; mobile (max-width 600px) `76px + sa-top`, `12px` sides, `--hud-blur: 8px`,
  `.orbital-hud` padding 12px 16px, `.key-hud-toggle` min-height 44px; time-warp
  bottom `120px` desktop / `60px` mobile; `.sat-detail` bottom `72px` desktop /
  `100px` mobile, max-width none; `.orbital-sat-bar` bottom `24px` centered;
  landscape-short (max-height 500px) variant at `56px` with max-height + overflow-y
  auto; 480px variant shrinks further. `wireHudToggle('stats-hud',
  'stats-hud-toggle', 'stats-hud-body')` etc.
- **Planned HUD set for /constellations/**: stats (LOADED/RENDERED/PLANES/AVG ALT/
  AVG PERIOD), **planes list** (P01 · RAAN 212° · 48 · LEO, click → fly to that
  plane's ring via `Cesium.BoundingSphere.fromPoints(ringPositions)` +
  `viewer.camera.flyToBoundingSphere`), density slider (min 40 step 10,
  max = full count — **no fetch-all button**: plane counts need the full TLE
  bundle at boot anyway, so the slider max is the total from the start), sat-bar,
  time-warp 0/1/10/100/1000, inspector with an extra PLANE row, footer citation,
  mission clock.
- **A constellation selector bar** (5 buttons: STARLINK/ONEWEB/GPS/GALILEO/IRIDIUM)
  is the primary control and must stay visible — plan a fixed bar directly under
  the topbar (`top: calc(52px + var(--sa-top))`, centered, nowrap horizontal
  scroll on mobile), pushing the three HUDs down to ~`96px` desktop / ~`128px`
  mobile (the mobile contract viewport table in
  `tests/e2e/test_mobile_responsive.py` is the gate — HUDs must not overlap the
  selector bar).
- **Data**: `fetchTLE(group, {source:'celestrak'})` + `parseTLEChunked(text)`
  (chunked matters for ~8000 Starlink TLEs; `parseTLE` is fine for the others).
  Groups: `starlink`, `oneweb`, `gps-ops`, `galileo`, `iridium-NEXT` (all in
  `ALLOWED_GROUPS`). Derive per sat: `planeElements({raanRad: satrec.nodeo,
  inclRad: satrec.inclo, noRadPerMin: satrec.no})`; render order for the density
  cap: iterate planes sorted by RAAN, then their members (progressive fill of
  every plane). `groupIntoPlanes` tolerance 5° (default).
- **Render**: rings as two polylines (width 1.2 glow 0.15 + width 0.6 glow 0.08,
  `arcType: ArcType.NONE`, `positions: planeRingDeg(...) → Cartesian3.fromDegrees(lon,
  lat, smaKm*1000)`) via `engine.addManagedEntity(viewer.entities.add(...))` —
  regime-shells.js is the reference; sats via `engine.addSatellite(satrec,
  shellColor, 3, false, {satrec, l1, l2, name, group, plane, norad, pulse:false})`.
  Shell palette: LEO `#4ee2ff`, MEO `#8effa0`, GEO `#ffe066`, HEO `#ff6ec7`
  (regime-shells.js values — re-declare in constellations.js view layer, they're
  not exported).
- **CSS**: `constellations.css` self-contained like starlink.css (own `:root` with
  the `--font-mono`/`--sa-*`/`--hud-blur` tokens + scoped
  `body[data-page-id="constellation-view"]`); do NOT link starlink.css. Link
  order: `/css/tokens.css`, `/css/chrome.css` (covers `.vfx-overlay`/`.noise-layer`
  and chrome), then `constellations.css`.
- **JS wiring to copy**: viewer construction block (starlink.js:47-93), `initMobileListener`,
  `syncRevsButtons(currentRevs())` + `wireRevsButton(revs-toggle)` (hud.js), the
  `.tw-btn[data-rate]` handler, `engine.pickSat` click inspector (add `#sat-detail-norad`
  like /orbit/ S8 — satrec.satnum), `window.__constellations` debug handle shaped
  like `window.__starlink`, `beforeunload → engine.destroy()`. Preset param:
  `new URLSearchParams(location.search).get('c')` — default `starlink`.
- **Verification**: resolve.mjs will check the new HTML/JS refs (Cesium CDN URLs
  are allowlisted); `npm test` then a custom Playwright probe like S8-S10 (the
  shared E2E suites don't know /starlink/ and shouldn't be touched for this page).

## Task list

- [x] **C4 Batch close** (docs commit, NOT pushed — user request): full verification
      battery at batch head + this log / build log / changelog / issues log updated.
      - **`npm test`**: green — 72/72 syntax, 62 files resolve, 19 orbit-ingest
        suites / 508 checks (incl. 23/23 constellation).
      - **New constellation probe** (`serve.py 8932`, `?cb` cache-busted): **38/38**
        at 1400×900 + 390×844 — boot; stats HUD (LOADED/RENDERED/PLANES) consistent
        with the plane rows; slider max == full count; default group starlink;
        desktop bar/HUD clearances (selector bar below nav, HUDs below bar); mobile
        hamburger visible ≥32px + stacked HUDs don't overlap; warp
        ❚❚/1×/10×/100×/1000×; REV toggle; mission clock; citation; fonts ≥11px; no
        page scroll (incl. after orientation change); oneweb switch (16 planes on
        the baseline path); inspector via `satEntities[i].meta` populates all 9
        fields live; mobile menu lists all destinations; touch targets ≥32px
        (buttons/toggles/plane rows); zero real console/page errors (only the
        expected `/api/tle` 404 under the Functions-less static server).
      - **`test_mobile_responsive.py`**: 125/136; **`test_mobile_dom.py`**: 27/29.
        All 13 failures proven pre-existing, none from C1–C3 (`git diff
        3a9b0365..HEAD` on `public/orbit`, `public/spacetrack`, `public/orbit-engine`,
        `tests/e2e` is empty): stale `/orbit/` `>=3` HUD threshold (2 by design),
        stale resolutionScale allowlist (`0.85` deliberate), mobile citation gap
        (footer hidden by design, open task), and a **new finding** — the dom
        suite's exact `/spacetrack/` HUD count is stale (wants 5, has 3 since
        `25ab2721`). All logged in `docs/issues-and-resolutions.md`; the stale
        expectations are one-line suite fixes for a future bug-fixing session.
      - **Redirects** re-verified under `wrangler pages dev public`: `/starlink`,
        `/starlink/`, `/starlink/*` all 302 → `/constellations/?c=starlink`; target
        200.
      - **Probe-authoring notes for the next session** (cost red runs): 404 console
        text has no URL — filter on `page.on('response')`; drive the debug handle
        with `satEntities[i].meta` (entries[i] is `{...planeElements, rec}` and
        `inspectSatellite` silently no-ops); serve.py exercises the baseline path —
        assert plane counts relatively, not absolutely.
      - **State**: repo is 7 commits ahead of origin. Push when the user asks.
- [x] **C3 /starlink/ redirect** (commit `3e6d5600`): `public/_redirects` now maps every
      `/starlink` spelling (`/starlink`, `/starlink/`, `/starlink/*`) to
      `/constellations/?c=starlink` with **302** (the old `/starlink → /starlink/`
      301 line is replaced, not stacked). The 13 nav links were deliberately left
      pointing at `/starlink/` — they redirect; renaming them in 13 places was the
      rejected churn option. `public/starlink/` files are dead behind the redirect
      but kept (delete in a future pure-deletion pass, after the rewrite is old
      enough to trust). Verified with `wrangler pages dev public` (local dev server
      honors `_redirects`, unlike serve.py): `/starlink`, `/starlink/`,
      `/starlink/foo` all 302 → `.../constellations/?c=starlink`; target serves 200
      and the `?c=` preset defaults to `starlink` (constellations.js:515-516).
      `npm test` green (72/72 syntax, 62 files resolve — the HTML hrefs to
      `/starlink/` still resolve while the files exist; no suite navigates to
      `/starlink/` so no E2E impact). No changes beyond `_redirects` + this file.
- [x] **C2 Page** (commit `3fc91871`): the `/constellations/` view page —
      `public/constellations/{index.html,constellations.css,constellations.js}`
      (all new), plus `groupConstellation` (two-level) + 8 tests added to
      `compute.js` / `constellation-compute.test.mjs` (uncommitted from the C1
      session — they now ride in this commit; see "Surprises").
      - **Data/grouping**: `fetchTLE(group, {source:'celestrak', live:true})` per
        constellation; starlink via `parseTLEChunked`, others `parseTLE`;
        `planeElements({raanRad: satrec.nodeo, inclRad: satrec.inclo, noRadPerMin:
        satrec.no})`; `groupConstellation(entries, {inclTolDeg:1, raanTolDeg:5})`
        (inclination band gap-split, then RAAN gap-split per band). Cache keyed per
        constellation — switching never refetches. Every constellation loads fully at
        boot (density slider max = total; NO fetch-all button).
      - **Render**: `buildRings` — two-ring glow per plane (width 1.2/glow 0.15/alpha
        0.25 + width 0.6/glow 0.08/alpha 0.12, `arcType: ArcType.NONE`, 180 segments
        via `planeRingDeg`, `engine.addManagedEntity`); `renderSats` — `addSatellite(
        satrec, shellColor, 3, false, meta)` with `show` toggling for the density cap,
        progressive fill plane-major (planes sorted by RAAN, then members).
      - **UI**: selector bar (5 buttons, primary control), stats HUD (LOADED/RENDERED/
        PLANES/AVG ALT/AVG PERIOD + LIVE), planes HUD (rows `P01 · RAAN 44° · 155 ·
        LEO`, click → `flyToPlane` via `BoundingSphere.fromPoints(ringPositions)` +
        `flyToBoundingSphere`, offset `{0, -55°, radius*3}`), density HUD (slider min
        40 step 10 + `revs-toggle`), sat-bar, time-warp 0/1/10/100/1000 + recenter +
        cam-alt, inspector (GROUP/PLANE/NORAD/LAT/LON/ALT/VEL/PERIOD/REGIME), footer
        citation + mission clock. HUD wiring: `wireHudToggle` ×3,
        `initMobileListener`, `initHamburgerMenu`, `syncRevsButtons` +
        `wireRevsButton`. `?c=` preset param, default `starlink`;
        `window.__constellations` debug handle.
      - **Verified**: live bundles all five constellations (starlink 47 planes,
        oneweb 16, gps 8, galileo 4, iridium 7; member totals exact); `npm test`
        green (72/72 syntax, 62 files resolve, 23/23 constellation checks);
        custom Playwright probe (S8-S10 workaround, `serve.py 8932`) 57/57 at
        1400×900 + 390×844: boot, bar/HUD clearances, no collapsed-panel
        overlaps, slider max = total, plane list + fly-to, inspector fields,
        REV cycle, warp rates, oneweb switch (651/16/32 rings), mission clock,
        citation, hamburger reveal + mobile menu, HUD exclusivity, touch
        targets ≥32, fonts ≥11px, no page scroll, orientation change, zero
        console/page errors.
      - **Layout decisions** (deviations from C2 prep notes, see Surprises):
        mobile breakpoint is **768px** (was 600px) and the hamburger reveal
        lives in this file (orbit.css variant) — prep notes hadn't accounted
        for the nav growing 34→64px when the hamburger shows; HUD tops
        desktop 96px / mobile 136px; mobile top HUDs **stack** (stats 136,
        planes 208) because side-by-side toggles (~200px each) overlap at
        390px; inspector desktop bottom-LEFT (density owns bottom-right);
        landscape-short keeps the 136/208 stack (clears both nav shapes).
- [x] **C1 Compute + tests** (commit `6b0d271a`): `public/constellations/compute.js` —
      pure plane arithmetic (no satellite.js/Cesium/DOM, imports only
      `../orbit-engine/astro.js`):
      `smaKmFromMeanMotion` (Kepler, n rad/min→rad/s), `altKmFromSma`,
      `planeElements({raanRad, inclRad, noRadPerMin})` → `{raanDeg, inclDeg, smaKm,
      altKm, shell}` (shell via `orbitRegime`), `circularMeanDeg` (wrap-aware,
      normalised to [0,360) with a 1e-6° wrap-residue collapse), `groupIntoPlanes`
      (gap-clustering on circular RAAN, anchored at the largest gap so planes
      straddling 0°/360° stay whole; returns planes sorted by RAAN with per-plane
      mean incl/SMA/shell/count/members), `planeRingDeg({raanDeg, inclDeg,
      radiusKm}, segments)` (great-circle ring as {lat,lon}° directions, frame
      `r = Rz(RAAN)·Rx(incl)·v`, v = r·(cos u, sin u, 0); radius is a caller-side
      altitude).
      `workers/orbit-ingest/test/constellation-compute.test.mjs` — 15 checks against
      synthetic constellations with known answers (Kepler closed form vs GPS/Starlink
      periods, wrap-straddling planes, singletons, tolerance boundary, ring normal/
      meridian/equatorial/closure). Wired into the orbit-ingest `npm test` chain
      (after catalog-compute). `npm test` green: 71/71 syntax, 60 files resolve,
      19 orbit-ingest suites.
      **Test-authoring notes** (surprises that cost a few red runs):
      (a) a plane mean slightly <0° is legitimately 359.9x° and sorts last — compare
      planes by circular distance, never by array index; (b) `circularMeanDeg` needed
      the wrap-residue collapse or a [358,2] mean renders as 359.9999999999999 and
      sorts wrong; (c) planeRingDeg returns *directions*, radius is applied by the
      caller as a Cesium altitude — assert on unit vectors.

## Load-bearing details (from the 3.1 batch, still current)

- **No build step.** Plain ES modules; a SyntaxError kills the whole page/module
  tree. Cross-package refs are root-absolute (`/shared/…`, `/orbit-engine/…`),
  intra-package relative. Verify by opening the pages, not by reading.
- **Worker URL must stay absolute** (`/orbit-engine/propagate.worker.js`): a
  relative URL resolves against the page and silently falls back to synchronous
  SGP4.
- **`X-Data-Source` citation**: every API response must carry it
  (`functions/api/_orbit.js:17-19`) — unchanged by this batch, don't touch.
- **Nav + filter drawer**: mobile drawer duplicates nav verbatim. Layer
  checkboxes no longer need hand-duplication as of S11 — `public/orbit/layers.js`'s
  `LAYERS` registry + `renderLayerList()` builds both `#layer-list` and
  `#layer-list-drawer` from one source. The revs-toggle button (S6) and
  hamburger/nav chrome are still hand-duplicated.
- **State shape** (`public/spacetrack/shared/state.js`, key `spacetrack_state_v1`).
  /orbit/, /starlink/ and (planned) /constellations/ do NOT use State except
  `trajectory.revs` via `/shared/hud.js`.
- **Overlay pattern** (plan 34 2.2): `public/spacetrack/overlays/*.js` are
  factories `createX({viewer, engine, getRendered})`; every overlay entity must
  route through `engine.addManagedEntity` or it escapes `destroy()`.
- **serve.py**: `python3 tests/e2e/serve.py 8932` (no-store header, root = public/).
  Chrome strays: `ps aux | grep chrome-linux64` before debugging a hang. SwiftShader
  is slow — keyboard events, not `page.click`, and cache-bust with `?cb=<ts>`.
- **Headless probes on this box**: `instanceof Cesium.*MaterialProperty` reads are
  unreliable against the CDN build; `material.getType()` (`'PolylineDash'`/
  `'PolylineGlow'`) is the reliable discriminator.
- **Node/nvm**: `node` is not on PATH; source `~/.nvm/nvm.sh && nvm use 24` first.
- `reports/orbit_wave0.png` is an uncommitted E2E artifact — leave it alone.

## References

- `docs/game-plans/34_unblock_landing_refactor_plan.md` — Phase 3.2 = this batch
  (§3.2 lines 370-382: group by RAAN+incl+SMA, plane great-circle rings with the
  shell they occupy, Starlink/OneWeb/GPS/Galileo/Iridium, pure client-side, verify
  frame rate before raising caps; sequencing step 8; §0.6 says /starlink/ becomes a
  preset).
- `docs/game-plans/Orbital_Relay_Feature_Specification.md` — feature #7
  (constellation view).
- `CLAUDE.md` + `AGENTS.md` — invariants, mobile contract, commands.

## Surprises & decisions

- **RAAN-only grouping fails on live Starlink — the plan's §3.2 "group by
  RAAN+incl+SMA" needs two levels.** Live bundle (10,766 sats) spans 4 shells
  (43°/53°/70°/97.5°) whose RAAN ranges interleave; within the 53° shell
  TLE-epoch scatter makes RAANs quasi-continuous (max gap 2.08° vs 5° design
  spacing), so a pure RAAN gap-split merges the whole constellation into ONE
  plane. Fixed with `groupConstellation`: inclination-band gap-split
  (`inclTolDeg: 1.0` — GPS spread 53.16–57.02° bounds it) FIRST, then
  `groupIntoPlanes` per band. Honest limits: Starlink's dense 43°/53° shells
  each collapse to one plane (design slots unrecoverable from epochs); the
  70°/97.5° shells and all four other constellations split exactly (48/16/8/4/7
  planes live; oneweb 16 vs 18 design — fine). Only `starlink.txt` baseline is
  trimmed (600 sats, RAANs degenerate ≈53° — grouped as one plane in the
  baseline, which the page probe confirmed: 4 planes); the other four baseline
  files are untrimmed. C1's committed `groupIntoPlanes` (RAAN-only) + its tests
  are superseded by this — keep the RAAN-only function (compute.js exports both;
  the contrast test "a pure RAAN split WOULD merge the multi-shell group" pins
  the reason it exists).
- **Mobile breakpoint is 768px, not 600px, and the hamburger reveal was the
  missing piece.** Prep notes assumed the 600px selector strip with HUD tops at
  128px, but chrome.css has NO `.hamburger-btn` rules (deliberate drift between
  /orbit/ and /spacetrack/) — the page's own CSS must both style it and reveal
  it (`@media (max-width:768px) { display:flex }`, orbit variant). Revealing it
  grows the nav 34→64px tall, which invalidates every prep-note offset: selector
  top 68, HUD tops 136. The probe caught this exactly backwards (nav bottom 34 =
  hamburger hidden — measured against the buggy state, the offsets looked fine).
- **Mobile top HUDs stack instead of sharing a row.** The two collapsed toggles
  (~252px + ~203px wide at 390px) physically overlap side-by-side. Stacked:
  stats top 136, planes top 208, both left-anchored. hud.js mobile exclusivity
  still applies (expanded stats covers the planes toggle — close first, then
  open).
- **Plane-row separators are text nodes, not CSS** — the probe's textContent
  assertion caught the row reading `P01RAAN 44°155 · LEO`; separators are now
  ` · ` spans in the DOM (`P01 · RAAN 44° · 155 · LEO`) so screen readers and
  the probe contract agree with the visual.
- **Probe-authoring notes** (cost a few red runs): (a) `page.evaluate` takes
  exactly one arg — pass `[a, b]` and destructure; (b) passing a state object
  where a position belongs gives NaN distances (measured `{flight, alt}` against
  `cam_before`); (c) `fmtLat` yields `48.60° S` (hemisphere suffix) — assert
  `'°' in lat`, not `endswith('°')`; (d) SwiftShader cold starts make fixed
  sleeps lie — poll for the expected state (oneweb 651 sats took 1–5s);
  (e) on mobile the fly-to first poll at t=0 is legitimately 0.0 — the flight
  completes by the second poll (altitude 28,374→39,541 km); (f) a vacuous
  assertion (`entityCount >= planes.length*2` with planes=0) masked a timing
  failure — assert against `ringEntities.length` directly.
- **Data path chosen: Celestrak group TLEs via existing `/api/tle`** (groups
  `starlink`, `oneweb`, `gps-ops`, `galileo`, `iridium-NEXT` — all in
  `functions/api/tle.js` ALLOWED_GROUPS), plane elements derived client-side from
  `satrec` (`nodeo`/`inclo`/`no`). The plan's §3.2 text names `/api/search?tle=1`
  + `/api/object/:norad`, but `search.js`'s `MAX_LIMIT = 500` can't return a full
  Starlink shell and /api/search doesn't even return RAAN/SMA columns; the TLE path
  is the established full-constellation pattern in this repo (starlink.js) and keeps
  the "no backend work" promise literally. Baseline `starlink.txt` is trimmed to
  600 sats (S12); live fetch gets all ~8000.
- **Plane grouping is RAAN-clustering with per-plane mean incl/SMA** — within one
  Celestrak group incl/SMA vary by fractions, so a pure RAAN gap-split (tolerance
  5°) is exact; the plan's "RAAN + inclination + SMA" is realised via the means
  carried on each plane.
- **Cesium rings are Earth-fixed schematics** — RAAN is inertial, the drawn ring is
  static like the GEO belt / regime shells; documented in compute.js header.
- **/starlink/ redirect decision pending C3**: the 3.1 batch's `/starlink/` page
  becomes a preset; plan is `public/_redirects` `/starlink/*` →
  `/constellations/?c=starlink 302`, keeping the 13 existing `/starlink/` nav links
  (renaming them in 13 places is churn; they redirect). `public/starlink/` files
  become dead behind the redirect — delete in a future pure-deletion pass.
- **C4: mobile nav brand/source links are sub-32px tap targets on ALL three pages**
  (measured 390px: `/orbit/` brand 28px / links 18px; `/spacetrack/` + `/constellations/`
  14px). `chrome.css`'s mobile block hides only `.spacetrack-nav__list`; the brand
  and source links stay at `font-size: 0.55rem`. Shared pre-existing chrome, not a
  C2 regression (the C2 probe's "touch targets ≥32" selector set excluded nav
  links). Left as a documented open item — a chrome.css follow-up should hide or
  restyle them below 768px.
- **C4: `test_mobile_dom.py`'s `/spacetrack/` HUD count is stale (5→3)** — set by
  `2d163738`, broken by `25ab2721` (activity/boxscore moved to Brief), caught only
  by the C4 battery since the 3.1 S14 battery ran before that suite's per-page map
  existed. One-line fix (`3`) for a future session; the suite's own comment says an
  exact count exists to catch panels going missing, so keep it exact.

---

# Session Handoff — Plan 34 Phase 3.1 (step 7) batch

> One task per session; commit after each task; read this file at the start of every
> new session. Tasks S2–S14 are ordered so each commit leaves `main` in a working,
> deployable state.

## How to work this batch

1. Pick the next task with `status: pending` from the todolist (S2 next).
2. Read the linked plan docs (§References) and the "Load-bearing details" below —
   they encode outages this repo has already had.
3. Implement, then commit with a message matching repo style (see `git log`:
   `fix:`, `feat:`, `test(e2e):`, `refactor:` + short imperative subject).
4. Append "done / status" under the task below, and if anything surprising came up,
   add it to "Surprises & decisions". Keep this file committed — it is the memory.
5. The S14 verification session runs the full E2E battery and must be green before
   pushing to `main` (deploy is automatic on push).

## Task list

- [x] **S1 E2E guardrail** (commit `35a9d088`): ground-track assertion in
      `tests/e2e/test_orbit.py` now keys on `polyline.clampToGround === true`, so a
      future past-orbit arc or orbit ring can never satisfy it again.
      Red-run note: the intended "break the ground track → confirm red" run did not
      execute (background process died before starting); the break was reverted
      uncommitted. If you want the red proof, flip `clampToGround: false` in
      sat-engine.js `addInspectVisuals` and run `python3 tests/e2e/test_orbit.py
      --no-mobile` against `python3 tests/e2e/serve.py 8932` — expect the one
      ground-track check to fail.
- [x] **S2 Engine span** (commit `61dca213`): propagate.worker.js `path()`
      and sat-engine.js `_samplePath()` take signed `spanFrom`/`spanTo` in
      revolutions (default `0..1` — inert for every existing caller); vertex
      count scales `Math.round(|span|·steps)` clamped to 480, so multi-rev
      resolution stays constant; `computeOrbitPath`, `computeGroundTrack`,
      `requestPath`, `workerPath` forward the span to both the worker message
      and the sync fallback. `npm test` green (65/65 syntax, 53 files resolve,
      60/60 orbit-ingest).
- [x] **S3 Past orbit + revs** (commit `d0080735`): `addInspectVisuals` takes
      `{revs}` — fourth bag entity `past` (dashed, at altitude, `-0.5 → 0`
      revs) + future path `0 → revs`; vertex count scales with span inside
      the samplers (S2), so resolution is constant. Ground track stays one
      period. A revs change must rebuild via `removeEntities()` +
      `addInspectVisuals()` (both `requestRender()`). Verified headless on
      `/orbit/`: past = 31 pts (60 base × 0.5 + 1), orbit = 121/361/481 at
      revs 1/3/5 (480 clamp), sync fallback agrees (31 / 241), console clean.
- [x] **S4 Revs UI plumbing** (commit `d03d532c`): `cycleRevs`, `revsLabel`, `syncRevsButtons`, `setRevs`,
      `wireRevsButton`, `currentRevs`/`normalizeRevsCount`, `REVS_OPTIONS` → added to
      `public/shared/hud.js` (the file moved there in 2.1; the handoff's earlier
      `public/spacetrack/shared/hud.js` path is stale). State-backed: key
      `trajectory.revs` (default 1) added to `spacetrack_state_v1` in
      `spacetrack/shared/state.js`, matching plan 35 §3 (`trajectory.revs` rather
      than anything under `preferences`). `REVS_OPTIONS = [1,3,5]` — the same revs the
      S3 headless probe exercised (121/361/481 pts).
- [x] **S5 Dossier revs-awareness** (commit `1c8d4616`): `createDossier` takes
      `revs` (number | getter, default `currentRevs()` from `/shared/hud.js`),
      stores `dossierVisualMeta` for the last `addInspectVisuals` call, passes
      `{ revs }` at both open paths, and subscribes to `State.subscribe('trajectory.revs')`
      (subscribe, don't poll) to teardown-and-rebuild visuals while a dossier is
      open; no-op when closed. Callers (catalog/conjunctions) unchanged — they
      get the State-driven default. `npm test` green (65/65 syntax, 53 resolve,
      60/60 orbit-ingest).
- [x] **S6 Revs buttons on all four routes** (commit `ab974c23`): catalog gets
      a 5th `.st-toggle-btn` in the orbit HUD — no `clearRendered()` reset
      needed, since `trajectory.revs` is a persistent cross-route preference,
      not a per-query overlay toggle, and `createDossier` (S5) already
      subscribes to it. signal.js/starlink.js/orbital-relay.js call
      `addInspectVisuals` directly (not `createDossier`), so each now tracks
      its last-inspected `meta` and subscribes to `REVS_STATE_PATH` to tear
      down + rebuild on change. `/orbit/` authors the button twice (desktop
      `#revs-toggle` + drawer `#revs-toggle-drawer`, since S11's registry
      hasn't landed) — not class `layer-cb`, so `reloadAllLayers()` doesn't
      treat it as a Celestrak layer; `syncRevsButtons()` queries
      `[data-revs-label]` globally so the two stay in sync with no manual
      mirror. Added `.st-toggle-btn`/`.st-toggle-btn--on`/`.hud-row--toggle`
      CSS to `orbit.css` and `starlink.css` (spacetrack.css only). Headless
      probe on `/orbit/`: button exists, cycles REV 1×→3×→5×→1×, drawer
      stays in sync every click, zero console errors. `npm test` green
      (65/65 syntax, 53 resolve, 12 suites/348 checks).
- [x] **S7 Time rates 1×/10×/100×/1000×** (commit `579df166`): replaced the
      0/1/60/600 preset in `initTimeWarpButtons` (`public/spacetrack/shared/globe.js`,
      used by catalog.js + signal.js) with 0/1/10/100/1000; added
      `normalizeTimeRate()` mapping legacy saved rates (60→10, 600→1000) to
      the nearest new preset via `LEGACY_TIME_RATE_MAP` (0/1 map to
      themselves), applied to the `State.get('time.rate')` restore path.
      `clock.multiplier = rate` is a direct sim-seconds-per-real-second
      value, so this is a pure preset swap, not a semantics change.
      `/orbit/` and `/starlink/` hardcode their own `.tw-btn[data-rate]`
      buttons and never persist `time.rate` (no `State`/localStorage there
      at all), so they only needed the label/value swap in their HTML —
      no migration logic. Headless probe on all 4 routes: `.tw-btn[data-rate]`
      values read back as `['0','1','10','100','1000']`, zero console errors.
      `npm test` green.
- [x] **S8 Dossier on /orbit/** (commit `905d2f53`): `#sat-detail`
      markup in `public/orbit/index.html` restructured with `.st-dossier`/
      `.st-dossier__id` classes (spacetrack's visual skin) while **keeping every
      existing id** (`#sat-detail`, `#sat-detail-alt`, `#sat-detail-close`, …) —
      `tests/e2e/test_orbit.py` keys on those directly. Added
      `.st-dossier`/`.st-dossier__id` rules to `orbit.css` (mirrors
      spacetrack.css: `max-height`/`overflow-y` + the small id line, plus an
      11px mobile font floor for M6). New `#sat-detail-norad` line shows
      `NORAD <satrec.satnum>` — `satellite.js`'s `twoline2satrec` already parses
      the NORAD catalog id out of TLE line 1 for free.
      **Deliberately did NOT wire up shared `createDossier`** (`/shared/dossier.js`):
      it fetches live data from `/spacetrack/object/{norad}` and requires a
      `State.set`/`subscribe`-capable object, but /orbit/ is Celestrak-sourced —
      many tracked objects (new launches, non-US) won't resolve against the
      Space-Track catalog, and /orbit/ was deliberately kept State-free for
      everything except `trajectory.revs`. User confirmed this scope
      (visual-parity-only, keep the existing local `inspectSatellite()` logic)
      when asked directly — see "Surprises & decisions". Verified headless on
      `/orbit/` (custom Playwright probe, not the broken shared suite — see
      below): inspector opens on click, `#sat-detail-norad` reads
      `NORAD 25544` for ISS, all fields populate, close button works, zero
      console errors; repeated at 390×844 — card fits on screen, no text
      under 11px. `npm test` green (65/65 syntax, 53 resolve, 60/60
      orbit-ingest).
- [x] **S9 Regime shells** (commit `4d4055ac`): `public/spacetrack/overlays/regime-shells.js`
      — `createRegimeShells({ viewer, engine })`, the exact two-ring-glow construction
      the GEO belt used, parameterized over `SHELLS = [LEO 1200km, MEO 20200km, GEO
      35786km, HEO 39000km]` (altitude bands chosen to sit inside each of
      `orbitRegime()`'s thresholds in `orbit-engine/astro.js:52-57`, not on the boundary).
      catalog.js's old `addGeoBelt()` IIFE is deleted; the overlay is constructed
      once alongside the other overlays and is **not** part of `clearRendered()` —
      unlike debris/launch-sites it doesn't derive from query results, so it isn't
      rebuilt per-query. Defaults to visible (user confirmed: preserve today's
      always-on GEO-belt behavior) with a `SHELLS` toggle row (`#regime-shells-toggle`,
      `.st-toggle-btn`) added to `/spacetrack/index.html`'s catalog HUD, below `ORBIT`
      — no registry (S11) yet, so this is one more hand-authored HUD row, same as
      `revs-toggle` was in S6. Only `/spacetrack/` (catalog.js) got it — the GEO belt
      was catalog-only to begin with; `/orbit/`, `/starlink/`, signal/conjunctions
      dossiers don't draw any belt today and are out of scope for S9.
      `catalog-compute.test.mjs`'s "every overlay entity routes through the engine"
      check was catalog.js-only and went red because `viewer.entities.add(` moved out
      of catalog.js into the new overlay file (false-negative, not a real regression)
      — updated to scan `catalog.js` + `debris.js` + `launch-sites.js` +
      `regime-shells.js` together. `npm test` green (66/66 syntax — one new file —,
      54/54 resolve, 13 suites). Headless probe on `/spacetrack/`: toggle starts
      "ON", cycles OFF→ON correctly, zero non-network console errors at 1400×900 and
      390×844; touch-target height (17px) matches the existing `.st-toggle-btn`
      baseline (`age-color-toggle`/`revs-toggle`), not a new regression. Canvas itself
      renders black in this sandbox (Cesium Ion 403 — pre-existing, unrelated to this
      change, see "Load-bearing details" / env-quirks memory), so ring color/rendering
      was not eyeballed — only DOM/console behavior was verified headless.
- [x] **S10 VFX CSS** (commit `63fc6813`): `.vfx-overlay`/`.noise-layer` styled in
      `/css/chrome.css` (covers /orbit/, /spacetrack/ + its 4 sub-pages, all of
      which already link chrome.css) and duplicated into
      `public/starlink/starlink.css` (the one page that doesn't link
      chrome.css — same duplication pattern the file's own header
      documents for `.hamburger-btn` etc.). `.vfx-overlay` is `position:
      fixed; inset:0; z-index:2; pointer-events:none` (canvas sits at z:0,
      HUD panels start at 15+, so it layers between them without ever
      intercepting globe drag/click — markup already has `aria-hidden`).
      `::after` on `.vfx-overlay` draws the vignette (radial-gradient,
      transparent center → dark edge); `.noise-layer` is a tiled SVG
      turbulence filter animated via `steps()` keyframes for a film-grain
      flicker. The SVG data URI is **base64-encoded**, not the usual
      percent-escaped inline form — the inline form's literal `filter="url(#n)"`
      substring inside the SVG source gets matched by
      `scripts/check/resolve.mjs`'s naive `url(...)` regex (it doesn't
      parse nesting) and 404s as a phantom path `public/css/#n`; base64
      has no literal `url(` substring so the checker's own `isExternal()`
      short-circuit on `data:` handles it correctly. `@media
      (prefers-reduced-motion: reduce)` disables the animation — this is
      the first use of that query in the repo (CLAUDE.md flagged zero
      existing reduced-motion handling). `npm test` green (66/66 syntax,
      54/54 resolve, 13 suites). Headless probe (custom Playwright script,
      not `tests/e2e/` — see S8/S9's same workaround) across
      /orbit/, /spacetrack/, /starlink/ at 1400×900 and 390×844: overlay
      present with correct pointer-events/z-index/vignette/animation on
      all 6, zero CSS-attributable console errors (the /spacetrack/ 404s
      seen are `/api/*` calls against the static-file-only dev server —
      pre-existing, unrelated); `emulate_media(reduced_motion='reduce')`
      confirmed `animationName` reads `none`.
- [x] **S11 Layer registry** (commit `b2b3b13d`): `public/orbit/layers.js` —
      `LAYERS` array (6 sections, same 15 groups, byte-identical `data-group`/
      `data-color`/`data-cap`/`data-builtin` values) + `ISS_LAYER` (the
      always-on, checkbox-less row) + `renderLayerList(mountId, idSuffix)`,
      which builds `<li class="layer-item">` rows via `createElement` (repo
      rule, no `innerHTML`) into either `#layer-list` or `#layer-list-drawer`.
      `orbital-relay.js` calls `renderLayerList('layer-list')` and
      `renderLayerList('layer-list-drawer', '-drawer')` right after
      `initHamburgerMenu()`, before the drawer-mirror wiring, the `.layer-cb`
      change-handler `querySelectorAll`, and `reloadAllLayers()` — all three
      assume the checkboxes already exist. `index.html`'s two `<ul>`s are now
      empty mount points; every id/class the rest of the page (and
      `tests/e2e/test_orbit.py`'s `set_layer()`, which selects by
      `data-group`) depends on is unchanged. **Active/Military/Rocket-Body
      were deliberately NOT added** — `functions/api/tle.js`'s
      `ALLOWED_GROUPS` and the baseline `.txt` files don't exist yet (that's
      S12), and `test_orbit.py`'s "every non-builtin layer ships a baseline
      snapshot" check would go red immediately if the registry listed a group
      with no backend/baseline behind it. S12 should add those three groups
      to `LAYERS` in the same commit it adds backend support, not before.
      Headless probe (custom Playwright script, not `tests/e2e/` — see S8-S10's
      same workaround) at 1400×900 and 390×844: main/drawer checkbox counts
      both 15, `data-group` order identical between the two, all 6 section
      labels present, ISS row has no `<input>` and both status spans read `1`;
      toggling GPS on the main panel mirrors `checked` to the drawer copy and
      both `layer-status-gps-ops[-drawer]` spans update to the loaded count;
      opening the mobile drawer shows all 15 checkboxes; zero console errors
      on either viewport. `npm test` green (67/67 syntax — one new file —,
      55/55 resolve, 13 suites).
- [x] **S12 Backend layers** (commit `4688fae6`): `functions/api/tle.js`
      `ALLOWED_GROUPS` += `active`, `military`. Both need a Space-Track predicate
      in `workers/orbit-ingest/src/derive.js`'s `GROUPS` too — `ALLOWED_GROUPS`
      gates `?source=spacetrack` as well as Celestrak, and a group with no
      `GROUPS[slug]` definition passes validation then 404s on R2 (caught by
      `derive.test.mjs`'s "every group the API accepts has a definition").
      `active` is plain `OBJECT_TYPE = 'PAYLOAD'` — the `buildGroupArtifacts()`
      wrapper query already ANDs in `DECAY_DATE IS NULL` (Space-Track's own
      definition of "active"), so no extra predicate narrows it further.
      `military` is an `OBJECT_NAME IN (...)` hand-list (SAR-Lupe, Sapphire, the
      SDA PRAETORIAN cluster ×21, Victus Haze — the exact names from a live
      Celestrak `GROUP=military` fetch, 2026-08-02) marked `approximate: true`,
      same as `sbas` — Celestrak's own `military` group is a small curated set
      with no shared name prefix or orbit signature to predicate on.
      `public/orbit/layers.js` gets a new "🎖 OTHER" section with both as
      checkboxes (cap 150 each). `scripts/snapshot_tle.sh`'s `GROUPS` list grew
      the two slugs. Updated three test fixtures to match: `derive.test.mjs`'s
      approximate-groups list (now `['glo-ops', 'military', 'sbas']`),
      `sqlite.test.mjs`'s `SPECIMENS` (added `active`/`military` synthetic rows
      so "every group matches its specimen" actually exercises the two new
      predicates), `env-node.test.mjs`'s hardcoded group count (`20` →
      `Object.keys(GROUPS).length`, since it was a magic number that silently
      drifts every time a group is added).
      **`public/data/tle/celestrak/active.txt` is a known gap**: Celestrak's
      GP endpoint rate-limits per client and returned 403 on every attempt to
      fetch `GROUP=active` this session (it's Celestrak's largest bundle — the
      full active-payload catalog) even after 45s/60s/120s waits; the user
      declined further retries. `military.txt` fetched fine (24 objects, no
      trim needed — the `starlink.txt`-style 1800-line trim only applies once
      `active.txt` is fetched, expected to be thousands of objects).
      `fetchTLE()` (`orbit-engine/tle.js`) already falls through to the live
      `/api/tle` proxy on a missing/invalid baseline file, so the ACTIVE
      checkbox works today via the slow path — it just fails
      `test_orbit.py`'s "every non-builtin layer group ships a baseline
      snapshot" check until someone runs
      `scripts/snapshot_tle.sh` (ideally from a different network/timing than
      this session used) and commits the resulting `active.txt`. **S13/S14
      should either fetch it first, or accept that one E2E check will be
      red until it's supplied — do not fabricate placeholder TLE data.**
      No plain "rocket bodies" Celestrak GP group exists (verified live:
      `GROUP=rocket-bodies` and `GROUP=rb` both 400) — that spec filter needs
      `OBJECT_TYPE` classification, a Space-Track concept, and stays out of
      scope for this registry. `npm test` green (67/67 syntax, 55/55 resolve,
      13 suites, all group-predicate tests updated and passing).
- [x] **S13 E2E assertions** (commits `7da13758`, `1baa98a8`): four new checks added to
      `tests/e2e/test_orbit.py`'s `run()`, right after the existing "inspector
      shows an altitude" check:
      - **Dossier ids**: `#sat-detail-norad` matches `/NORAD \d+/` for the ISS
        (`NORAD 25544`) and `#sat-detail-name` is non-trivial — the S8 markup
        finally has assertions, not just a headless-probe verification note.
      - **Past-orbit polyline + revs-aware future path** (plan 35 §2/§3,
        S1/S3/S6): a helper `inspect_vertex_counts()` reads
        `viewer.entities.values` and classifies each polyline by
        `material.getType()` (`'PolylineDash'`/`'PolylineGlow'`) — but the
        **ground track (S1) is ALSO `PolylineDash`**, so material type alone
        is not enough. Discovered this the hard way: the first version of
        this check (material-type only) read the past arc as `121` — the
        ground track's length, not the past arc's real `31` — because both
        matched the same branch and the ground track (added first) won.
        Confirmed via a standalone Playwright probe against live entity data
        before touching the assertion again. Fixed by requiring
        `clampToGround !== true` (unwrapped via
        `Cesium.Property.getValueOrUndefined`, same pattern as the S1
        guardrail) in addition to the dash material, which is exactly what
        the ground track sets and the past arc does not. Verified: past stays
        `31` across REV 1×/3×/5×/1× (fixed half-rev, per S3); future scales
        `121→361→481→121` (120 base steps × revs + 1, clamped to 480, per
        S2/S3); the REV toggle is clicked 3× total to land back on 1× before
        continuing (REVS_OPTIONS is `[1,3,5]`, cyclic) so it doesn't leak
        into later checks.
      - **Baseline-check**: the existing "every non-builtin layer group ships
        a baseline snapshot" check went red the moment S12 added the `active`
        checkbox without a baseline file (Celestrak rate-limited every fetch
        attempt that session). First fix was a `KNOWN_MISSING_BASELINES =
        {'active'}` allowance (asserting the missing set was exactly
        `{'active'}`, not a blanket pass, so a REAL regression in some other
        group's baseline would still fail loudly) — but `active.txt` landed
        for real a commit later (`a95c7c4c`, `scripts/snapshot_tle.sh` re-run
        once Celestrak's rate limit cleared, trimmed to 600 sats/1800 lines
        like `starlink.txt`), closing the gap the allowance existed for.
        Per CLAUDE.md's "don't keep complexity for scenarios that can't
        happen," the allowance was reverted back to the original plain
        `missing == []` assertion once the file existed — a permanent carve-out
        for a resolved gap would itself be the kind of dead conditional the
        repo avoids. (Original task wording said "skip spacetrack layer
        checkboxes" — that was stale/inapplicable regardless: this suite
        never navigates to `/spacetrack/` for this check and `.layer-cb` only
        matches `/orbit/`'s own checkboxes.) Also note `active` appears twice
        in the raw `missing` list when it's absent — desktop panel + drawer
        both carry `data-group="active"` — expected, not a bug.
      Full `test_orbit.py --no-mobile` run: every check through
      `perf_gate`'s startup passed (including all 5 new/changed ones above);
      the pre-existing "visible sats advance between ticks" check is FLAKY
      independent of this batch — observed both PASS (44236 m moved) and FAIL
      (0 m moved) across identical back-to-back runs with zero code changes
      in between, and `git log` on `tests/e2e/test_orbit.py` shows
      `wait_ticks`/this assertion predate S1. **S14 should investigate this
      flake** (likely a `tickCount` polling race under this box's slow
      SwiftShader/2-core contention) rather than treat one red run as a
      regression. `npm test` still green (67/67 syntax, 55/55 resolve, 13
      suites) — this task only touched the Python E2E suite.
- [x] **S14 Verify** (commit `db5bd162`): full battery run.
      - **`npm test`**: green (67/67 syntax, 55/55 resolve, 13 suites).
      - **Console check** (static server, not `npm run dev` — see below): all
        8 routes (`/`, `/orbit/`, `/spacetrack/` + its 4 sub-pages,
        `/starlink/`) loaded with zero unexpected console errors (only the
        documented `/api/*` 404 noise from a Functions-less static server).
      - **`test_orbit.py --no-mobile`**: every check through the `source`
        section passed cleanly across two consecutive full runs, including
        all of S13's new assertions and the simplified baseline check
        (`missing: []` — confirms `active.txt` resolves now). The perf/
        fallback/spacetrack gates always hit the 280s script timeout mid
        `perf_gate`'s 45s soak — that's the fixed test budget, not a hang;
        the suite makes real progress every run (see "the suite hangs" note
        below, superseding the older claim that it produced zero output).
        The pre-existing "visible sats advance between ticks" check is
        confirmed FLAKY (not a regression): failed once, passed twice across
        three otherwise-identical runs with no code changes in between.
      - **`test_mobile_dom.py`**: 31/31 passed, fully clean.
      - **`test_mobile_responsive.py`**: 131/140 passed. All 9 failures
        traced to real causes, none a regression from S1-S13:
        - 5× "N HUD panels found" — the hardcoded `>= 3` threshold in this
          suite's `test_layout()` is stale for `/orbit/` (2 HUDs by design,
          matching `test_mobile_dom.py`'s already-correct per-page
          `PAGES = {'/orbit/': 2, '/spacetrack/': 5}`, which this second
          suite never adopted). Not touched — out of scope for a
          verification pass; a future task should port the same per-page
          map into `test_mobile_responsive.py`.
        - 2× "Cesium resolutionScale set for mobile DPR" — the check only
          accepts `1.0`/`0.5`; the actual, deliberately-documented value is
          `0.85` (`sat-engine.js:73-75`, present since the very first commit
          of this file). Stale test allowlist, not a product regression.
        - 2× "citation visible" on `/spacetrack/` mobile — see the CSS
          cascade bug + mobile-citation-gap writeup in "Surprises &
          decisions". Fixed the CSS bug (moved `orbit.css`'s base
          `.orbital-footer` rule before its own `@media` override so the
          mobile-hide actually wins on `/orbit/` too, matching
          `/spacetrack/`'s already-correct behavior); the deeper
          "citation has no mobile surface on either page" finding is
          intentionally left unfixed, per the user's direction, as a
          follow-up design task.
      - **Not run**: `npm run dev` (needs nvm-managed wrangler, not
        available in this session) — substituted `tests/e2e/serve.py`
        (static, no-cache) for the console check, which is sufficient for a
        pure-frontend verification pass; no Pages Functions changed in this
        batch.
      - **Pushed**: S1-S14 is now the full plan-34 3.1 batch, complete and
        on `main`.

## Load-bearing details (from the previous session's investigation)

- **No build step.** Plain ES modules; a SyntaxError kills the whole page/module
  tree. Cross-package refs are root-absolute (`/shared/…`, `/orbit-engine/…`),
  intra-package relative. Verify by opening the pages, not by reading.
- **Path sampler structure** (plan 35 correction — do NOT treat as a bound change):
  `_samplePath` in `public/orbit-engine/sat-engine.js:281` and worker `path()` in
  `public/orbit-engine/propagate.worker.js:144` both walk `for (i = 0; i <= steps;
  i++)` forward-only, one period. `steps` does double duty (resolution vs extent) —
  split it. The worker is a second module worker; keep the synchronous fallback for
  path jobs (only conjunction screening deliberately has none).
- **Worker URL must stay absolute** (`/orbit-engine/propagate.worker.js`): a
  relative URL resolves against the page and silently falls back to synchronous
  SGP4.
- **`X-Data-Source` citation**: every API response must carry it
  (`functions/api/_orbit.js:17-19`) — unchanged by this batch, don't touch.
- **HUD exclusivity**: `orbit/orbital-relay.js:76/84` gates panel-exclusivity on
  `isMobile()`; `shared/hud.js:48/54` (used by all four spacetrack routes) strips
  the guard — desktop allows several panels open. Don't "fix" either copy to match
  the other without the mobile contract review.
- **Nav + filter drawer**: mobile drawer duplicates nav verbatim. Layer
  checkboxes no longer need hand-duplication as of S11 — `public/orbit/layers.js`'s
  `LAYERS` registry + `renderLayerList()` builds both `#layer-list` and
  `#layer-list-drawer` from one source; add a new layer there, not in
  `index.html`. The revs-toggle button (S6) and hamburger/nav chrome are
  still hand-duplicated — S11 only covers the constellation layer list.
- **Tests that gate /orbit/ markup** (keep passing):
  - `tests/e2e/test_orbit.py:958`-ish: `.tw-btn`, `.source-btn`, `.refresh-btn`
    exist; `#sat-detail` visible after click; `.layer-cb[data-group]` checked;
    `window.__orbit` globals; layer-label count = 15 (changes in S11); HUD with
    visible text at mobile width (M1).
  - `tests/e2e/test_mobile_dom.py`: `PAGES = {'/orbit/': 2, '/spacetrack/': 5}`
    HUD counts — adding/removing HUDs on any page changes this.
  - `tests/e2e/test_mobile_responsive.py:216`: queries
    `.layer-label, label.layer-label, label:has(.layer-cb)` for the filter drawer.
- **State shape** (`public/spacetrack/shared/state.js`, key `spacetrack_state_v1`):
  `filters {q,type,country,regime,era,operator}`, `time {rate:1,paused:false}`,
  `preferences {…}`, `camera`, `selection`. /orbit/ and /starlink/ do NOT use State
  — the /orbit/ revs button persists to localStorage itself (orbit key is
  `orbit_state_v1`, see orbital-relay.js).
- **Overlay pattern** (plan 34 2.2): `public/spacetrack/overlays/*.js` are
  factories `createX({viewer, engine, getRendered})` with `setEnabled`/`reset`
  wired through `engine.addManagedEntity`; `clearRendered()` delegates to their
  `reset()`. Every overlay entity must route through `addManagedEntity` or it
  escapes `destroy()`.
- **Rates today**: 0/1/60/600 (paused/1s per step/60s/600s per tick). New target
  1×/10×/100×/1000× where × = real seconds per simulation second (i.e. 1, 10, 100,
  1000 s per tick with the 1s-per-tick engine — verify `rate * dt` semantics in
  sat-engine.js tick before picking raw values).
- **serve.py**: `python3 tests/e2e/serve.py 8932` (no-store header, root = public/).
  Run E2E with `python3 tests/e2e/test_orbit.py --no-mobile` etc. Chrome strays:
  `ps aux | grep chrome-linux64` before debugging a hang. SwiftShader is slow —
  keyboard events, not `page.click`, and cache-bust with `?cb=<ts>`.
- **rg is unavailable** on this box — use grep/Glob/Grep tools.
- `reports/orbit_wave0.png` is an uncommitted E2E artifact; it was modified in the
  working tree before this batch started — leave it alone, never commit it.

## References

- `docs/game-plans/34_unblock_landing_refactor_plan.md` — Phase 3.1 = this batch.
- `docs/game-plans/35_trajectory_paths_plan.md` — S2/S3 detail (read fully first).
- `docs/game-plans/Orbital_Relay_Feature_Specification.md` — feature #3 (trajectory,
  multiple revs), §1 filters.
- `CLAUDE.md` + `AGENTS.md` — invariants, mobile contract, commands.

## Surprises & decisions

- **S14 found and fixed a real, pre-existing CSS cascade bug on /orbit/**:
  `orbit.css`'s unconditional `.orbital-footer { display: flex; ... }` rule
  used to live at the BOTTOM of the file (after the `@media (max-width:
  768px) { .orbital-footer { display: none } }` mobile-hide block), so the
  later unconditional rule won the cascade and silently undid the hide —
  `/orbit/`'s footer (and the Space-Track citation it contains) was actually
  `display: flex` at 390px width despite the override existing, contradicting
  its own "hidden on mobile, replaced by bottom nav" comment.
  `/spacetrack/` never had this bug because `spacetrack.css` loads AFTER
  `orbit.css` and re-asserts its own later `@media { display: none }`, which
  wins regardless of orbit.css's internal ordering. Fixed by moving the base
  `.orbital-footer` rule (+ its two dependent rules, `span + span::before`
  and `__cite`) to before the `@media` block, matching the ordering that
  already worked correctly for every other mobile-overridden rule in this
  file. Caught by `test_mobile_responsive.py`'s "citation visible" check
  failing on `/spacetrack/` mobile but passing on `/orbit/` mobile — backwards
  from what the CSS intended, which was the tell that something was inverted
  rather than both pages just being flaky.
  **Deeper finding, NOT fixed, needs a follow-up task**: with the cascade bug
  fixed, the Space-Track citation now has **no visible surface on mobile on
  EITHER page** — `.orbital-footer__cite` only exists inside the footer, and
  both pages correctly hide that footer below 768px with nothing replacing
  it. CLAUDE.md requires the citation "visible in the product," and this is a
  pre-existing gap (not introduced by this fix — `/spacetrack/` already had
  it; the fix just made `/orbit/` consistent rather than accidentally
  compliant). User's call: document only, no quick patch — this needs a
  deliberate design decision (a persistent mini-footer? a citation line in
  the mobile nav/bottom bar? a HUD row?) rather than a bolted-on fix under
  a verification task's scope. `test_mobile_responsive.py`'s "citation
  visible" check will now legitimately fail on BOTH pages' phone-width
  viewports (390/412px) — this is a real, known gap, not a regression to
  chase in S14.
- **S8's `createDossier` reuse question was put to the user directly** rather
  than assumed: `/shared/dossier.js` needs a `State` object and fetches
  `/spacetrack/object/{norad}`, which /orbit/ doesn't have and whose data
  wouldn't reliably resolve for Celestrak-only objects. User chose
  visual-parity-only (copy the `.st-dossier` CSS skin, keep the existing local
  TLE-only `inspectSatellite()` logic) over full `createDossier` wiring with a
  `State` shim. If a future task wants the full catalog dossier on /orbit/
  (country, launch site, decay, RCS), that is new scope, not something S8 left
  half-done.
- **`test_orbit.py --no-mobile` would not complete even at a 280s timeout**,
  with zero output written before the timeout killed it (background run,
  `timeout 280 python3 tests/e2e/test_orbit.py --no-mobile`, exit 124, empty
  log). Zero stray `chrome-linux64` processes and `uptime` load ~3 beforehand,
  so this isn't the "stray Chrome" or "box too contended" failure mode
  documented elsewhere in this file — the suite itself is hanging somewhere
  before its first `print`. This predates S8 (the suite was already flagged
  "still to re-run" since Phase 2.2) and S8 was verified instead with a
  standalone Playwright probe against the same `#sat-detail` ids and
  `window.__orbit.inspectSatellite` the real suite uses (see S8 above).
  **S14 needs to root-cause the hang itself**, not just re-run individual
  assertions — a suite that cannot finish is a bigger problem than any one
  stale check.
- **S1's ground-track guardrail was red from birth** (fixed in `a860c02e`):
  `e.polyline.clampToGround` on Cesium 1.113's Entity API is a
  `ConstantProperty` wrapper, not the raw boolean — `!== true` filtered out
  every entity. The S1 red-run note said only the red-run never executed; the
  green run hadn't either. Fixed with
  `Cesium.Property.getValueOrUndefined(clampToGround, t) === true`. A raw
  comparison must not be reintroduced in S13's new past-orbit assertions —
  past-orbit's clampToGround is `undefined` (unset), which the unwrap keeps
  excluded.
- **The E2E suite is broken by plan-34 drift, not by this batch.** Running
  `test_orbit.py --no-mobile` exposed stale checks (never green-run since
  Phase 2.2 — CLAUDE.md said "e2e still to re-run"):
  - Source-nav checks targeted removed `source-btn[data-source]` markup;
    re-pointed at the static nav (`.spacetrack-nav__source-link[href="/orbit/"]`,
    `a.spacetrack-nav__link--active` → `/spacetrack/`) — same commit `a860c02e`.
  - `signal-hud` → `activity-hud` (catalog page renamed the feed panel;
    `feed-list`/`decay-list`/`box-list` ids survived).
  - The whole wave-5 `conjunction_gate` targets ids that moved to
    `/spacetrack/conjunctions/`: `c-window/c-threshold/c-run/c-cancel/c-status/
    c-list/c-progress` exist there (no `conj-hud*` on either page), and that
    page's `__spacetrack` still exposes `runScreen/addObjects/screener/
    lastScreen/clearRendered/render/openDossier/closeDossier` — the gate needs
    a `page.goto('/spacetrack/conjunctions/')` + selector updates, plus the
    slot-mate exclusivity check (`signal-hud-toggle.click()` at
    `test_orbit.py:609` crashes the suite on null — that crash is why
    `brief_gate` status is still unknown). **S14's battery repair must include
    this.**
- **Handoff's `(clampToGround: true)` for the past arc conflicts with plan 35
  §2** — the plan's code sketch (kind `'orbit'`, `ArcType.NONE`, no clamp)
  won; the past arc is a dashed arc at orbital altitude, verified
  `PolylineDash/clamp=undefined/pts=31`. S13 should discriminate past-orbit
  from ground track by material type + `clampToGround !== true`, not by
  clamping.
- **Headless probes on this box**: `instanceof Cesium.PolylineDashMaterialProperty`
  reads are unreliable against the CDN build (minified constructor names);
  `material.getType()` (`'PolylineDash'`/`'PolylineGlow'`) is the reliable
  discriminator.
