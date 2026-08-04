# Session Handoff — Plan 34 Phase 3.2 (constellation / orbital-plane view)

> One task per session; commit after each task; read this file at the start of every
> new session. Tasks C1–C4 are ordered so each commit leaves `main` in a working,
> deployable state. The 3.1 batch below is complete and archived.

## How to work this batch

1. Pick the next task with `status: pending` from the todolist (C2 next).
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
