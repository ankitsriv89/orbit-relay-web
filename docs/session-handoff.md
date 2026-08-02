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
