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
- [ ] **S2 Engine span**: propagate.worker.js `path()` (:144) takes signed
      `{start, span, steps}`; sat-engine.js `_samplePath()` (:281),
      `computeOrbitPath`, `requestPath`, `workerPath` propagate span. Inert until S3.
- [ ] **S3 Past orbit + revs**: `addInspectVisuals` (sat-engine.js:527) takes
      `{revs}` — past-orbit polyline (`clampToGround: true`, faded) + future path
      extended to `revs` periods; `steps` scales with span so resolution is
      constant; **do not reuse the TLE `steps` constant for both extent and
      resolution** (plan 35 correction).
- [ ] **S4 Revs UI plumbing**: `public/spacetrack/shared/hud.js` — `cycleRevs`,
      `revsLabel`, `syncRevsButtons`, `wireRevsButton`; State-backed under the
      existing `spacetrack_state_v1` preferences (see state.js shape below).
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

- (none yet)
