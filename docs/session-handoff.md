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
- [x] **S4 Revs UI plumbing**: `cycleRevs`, `revsLabel`, `syncRevsButtons`, `setRevs`,
      `wireRevsButton`, `currentRevs`/`normalizeRevsCount`, `REVS_OPTIONS` → added to
      `public/shared/hud.js` (the file moved there in 2.1; the handoff's earlier
      `public/spacetrack/shared/hud.js` path is stale). State-backed: key
      `trajectory.revs` (default 1) added to `spacetrack_state_v1` in
      `spacetrack/shared/state.js`, matching plan 35 §3 (`trajectory.revs` rather
      than anything under `preferences`). `REVS_OPTIONS = [1,3,5]` — the same revs the
      S3 headless probe exercised (121/361/481 pts).
- [ ] **S5 Dossier revs-awareness**: `public/shared/dossier.js` — `createDossier`
      accepts `revs` and rebuilds visuals on revs change (subscribe, don't poll).
- [ ] **S6 Revs buttons on all four routes**: catalog (5th `.st-toggle-btn` in the
      orbit HUD, + `clearRendered()` must reset it), signal, starlink, orbit
      (via the S11 registry). signal.js + starlink.js must rebuild inspect visuals
      on revs change (they draw via `addInspectVisuals` directly, not createDossier).
- [ ] **S7 Time rates 1×/10×/100×/1000×**: `initTimeWarpButtons` in
      `public/spacetrack/shared/globe.js`; hardcoded buttons in
      `public/orbit/index.html` + `public/starlink/index.html`; normalize a saved
      legacy rate (0/1/60/600) to the nearest new rate.
- [ ] **S8 Dossier on /orbit/**: replace inline `.sat-detail` markup in
      `public/orbit/index.html` with `.st-dossier*` (copy spacetrack markup/CSS —
      `orbit.css` has NO st-dossier rules); `orbital-relay.js` calls
      `createDossier` and adds `data-norad` metas to SatPoint instances; keep the
      M1 mobile gate passing (HUD with visible text must exist at mobile width).
- [ ] **S9 Regime shells**: extract the GEO shell-ring code from catalog.js into a
      helper; draw LEO/MEO/HEO/GEO rings via the registry (S11).
- [ ] **S10 VFX CSS**: `.vfx-overlay`/`.noise-layer` exist in 7 HTML files with zero
      CSS — add film-grain + vignette to `/css/chrome.css` + `public/starlink/starlink.css`
      under `prefers-reduced-motion: no-preference` (disable in reduced-motion);
      reuses the existing 8-page `beacon.js` convention, no new markup.
- [ ] **S11 Layer registry**: `public/orbit/layers.js` — `LAYERS` array + `renderLayerList`
      (same 15 + new: Active, Military, Rocket Body) + sync/hooks; orbital-relay.js
      consumes it; checkboxes mirrored in the mobile filter drawer; kills the
      duplicating pattern for good. layer-label CSS coverage in the M6 mobile check
      (`tests/e2e/test_mobile_responsive.py:216`) applies to the drawer, not the
      layers panel.
- [ ] **S12 Backend layers**: `functions/api/tle.js` ALLOWED_GROUPS +=
      `active`, `military`; `scripts/snapshot_tle.sh` fetch them; baseline files
      `public/data/tle/celestrak/{active,military}.txt`; fallback path must handle
      missing baselines gracefully.
- [ ] **S13 E2E assertions**: past-orbit polyline present; rev count changes the
      future path vertex count; dossier ids on /orbit/; baseline-check skips
      spacetrack layer checkboxes (S11 registry changes /orbit/ markup — update
      the orbit-layer baseline in `tests/e2e/test_orbit.py`).
- [ ] **S14 Verify**: `npm test`; dev-server console check; `test_orbit.py` full,
      `test_mobile_dom.py`, `test_mobile_responsive.py`; then push (deploy is
      automatic). Fix any failures in follow-up commits.

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
- **Nav + filter drawer**: mobile drawer duplicates nav verbatim + filter
  checkboxes. Every layer-list change must touch both the desktop panel and the
  drawer until the S11 registry lands (the registry IS the fix).
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
