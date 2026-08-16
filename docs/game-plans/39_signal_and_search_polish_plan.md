# Signal, Search & Cinematics Polish Plan

*Written 2026-08-17, against the working tree as of `33ab81cc` (plan 38 closed). This is
the low-risk half of a gap analysis run against
[Orbital_Relay_Feature_Specification.md](Orbital_Relay_Feature_Specification.md)'s 20
numbered features + Advanced Features list. The speculative half — features needing new
upstream data sources or genuinely new algorithms — is
[40_speculative_features_plan.md](40_speculative_features_plan.md). Splitting them is
deliberate: everything here builds on data and code that already exist in this repo today,
so each task should land in a single session the way plan 38's tasks did.*

## Why these six and not the others

The gap analysis found ~13 unshipped items from the spec. Grounding each against the
actual codebase (not just the feature name) split them into two tiers:

- **This plan** — hooks into data/code that already exists: existing D1 columns, an
  existing algorithm, an existing UI extension point, or (in two cases) a feature that
  is already built and only needs finishing.
- **Plan 40** — needs a new upstream data source Space-Track/CelesTrak don't provide
  (launch schedules, sensor pointing specs), new persistent storage this repo doesn't
  have (TLE-epoch history), or a genuinely new algorithm with no existing test corpus to
  validate against (maneuver detection, decay-rate modeling). Those deserve their own
  scoping pass before code — see that plan's "Open decisions" section.

Two corrections the grounding pass turned up against the original gap analysis, both
**already shipped** and removed from scope here:

- **Orbit-class search already exists.** `functions/api/search.js:72` whitelists a
  `regime` filter (`LEO`/`MEO`/`GEO`/`HEO`) over the `regime` column, and
  `public/spacetrack/index.html:164` (`#f-regime`) already surfaces it in the filter
  panel, both desktop and mobile (`#fd-regime`, line 312). There is no gap here.
- **Bloom is already wired**, just deliberately untuned.
  [`sat-engine.js:667-702`](../../public/orbit-engine/sat-engine.js#L667-L702)'s
  `_applyCinematics()` enables `scene.postProcessStages.bloom` at `cinematics: 'high'`,
  guarded for missing WebGL2/stage support. The code comment says visual tuning was
  deferred because the dev sandbox can't render (Cesium Ion 403 blocks tile fetches, so
  the canvas renders black locally) — this plan's D-task is that deferred tuning pass,
  not new plumbing.

---

## A. Mission field in search

**Gap, correctly scoped:** `OBJECT_NAME`/`OBJECT_ID` search already exists
(`#f-q`/`#fd-q`, `public/spacetrack/index.html:145,293`) and already does a `LIKE`
contains-match (`functions/api/search.js:66`). There is no `mission` column anywhere in
`objects` or `satcat` — Space-Track does not carry a mission-taxonomy field, so this
cannot be a new filter column, only a documentation/UX fix.

**Do:**
- Update the search input's `placeholder` to make clear name-search already covers
  mission strings in practice (most `OBJECT_NAME` values *are* the mission/payload name
  — e.g. `STARLINK-1234`, `LANDSAT 9`) — `"name, mission, intl designator, NORAD"`.
- Add a one-line glossary note in `/wiki/` clarifying "mission" is not a distinct
  Space-Track field and is covered by name search.

**Done when:** `npm test` green (resolve.mjs catches nothing here, this is copy-only);
`/wiki/` glossary has the note.

**Effort:** trivial, one session covers this plus B below.

---

## B. Pass notifications

**Files:** `public/spacetrack/signal/signal.js`, a new
`public/spacetrack/signal/notifications.js`

**What already exists:** `predictPasses`/`visibilityWindows` in
[`signal/compute.js:83,119`](../../public/spacetrack/signal/compute.js) are pure,
Node-tested functions that already compute exact AOS/LOS pass windows for the selected
object and observer location. The algorithmic core is done — this task is entirely
browser-side UI wiring, no backend change.

**Build:**
- `notifications.js`: wraps the browser `Notification` API. `requestPermission()` gated
  behind an explicit user action (a toggle in the Signal panel), never auto-prompted on
  page load — an unsolicited permission prompt on first visit is the single fastest way
  to get a page's notifications permanently blocked by the browser.
- On permission grant, schedule a `setTimeout` (not a service worker — this repo has no
  service worker anywhere, and this feature does not need one to fire while the tab is
  open) for each upcoming pass's AOS time from `predictPasses`'s existing output. Cap the
  schedule to the passes already computed and visible in the panel (do not scan further
  ahead than the UI already shows) — no new computation, just a timer over the existing
  numbers.
- Notification body: object name, AOS time, max elevation — the same fields the pass
  list already renders, reused, not derived fresh.
- Clear all pending timers on object deselection and on page unload (`beforeunload`,
  same pattern `sat-engine.js`'s cleanup uses).
- Respect `prefers-reduced-motion`? No — this is not an animation. It is still subject
  to CLAUDE.md's touch-target rule for the toggle (≥44px) and needs a visible on/off
  state, not just a browser-native permission icon, since a denied/blocked permission
  needs to read clearly as off rather than silently doing nothing.

**Test:** `workers/orbit-ingest/test/` already Node-tests `compute.js` — no change needed
there since this task adds no new pure function, only browser glue. Add a DOM-level check
to `tests/e2e/` (or extend an existing signal e2e test if one exists) asserting the
toggle exists, is ≥44px, and that `Notification.requestPermission` is not called until
the toggle is clicked (stub `window.Notification` in the test).

**Done when:** `npm test` green; manual check in a real browser (headless Chromium's
`Notification` support is inconsistent across sandboxes — this is one of the few features
in this repo that needs an actual browser tab, not just `npm run dev` + console check) that
toggling on schedules a notification and toggling off/deselecting clears it.

---

## C. Launch history — per-launch grouping

**Files:** `workers/orbit-ingest/src/derive.js`, `functions/api/analytics.js` (new
endpoint or extended artifact section), `public/spacetrack/analytics/analytics.js`,
`workers/orbit-ingest/test/derive.test.mjs`

**Gap, correctly scoped:** `analytics.js` today only aggregates *by year/decade*
(`launches_by_year`, `launches_by_decade`) — nothing about a single launch event grouping
its co-manifested payloads, upper stage, and debris together. Space-Track's `OBJECT_ID`
(COSPAR / international designator, format `YYYY-NNNLLL`) already groups every object
from one launch under a shared `YYYY-NNN` prefix — this repo already uses that exact
prefix as the `debris_family` key (see `objects.js` derivation of `debris_family`, cited
in the grounding pass). No new ingest, no new upstream call.

**Build:**
- A derived `launches` view: `GROUP BY substr(OBJECT_ID, 1, 8)` (the `YYYY-NNN` prefix)
  over `objects`, rolling up `LAUNCH_DATE`, `SITE` (joined through `launch_sites` from
  plan 38 A1.5 for the name), object count, and a type breakdown (payload / rocket body /
  debris count within that launch).
- Add this as a new `catalog/launches.json` artifact (own R2 key, own daily build step in
  `buildAnalytics` or a sibling function) rather than growing `analytics.json` further —
  a per-launch list is a different shape (rows, potentially thousands) from
  `analytics.json`'s aggregate-shape sections, and mixing them risks the same
  "one artifact, two different filtering rules" confusion plan 38's A1 already had to
  document carefully for `altitude_bins` vs `launches_by_decade`.
- Frontend: a new `.st-card--wide` section on `/spacetrack/analytics/` — a scrollable,
  reverse-chronological table (site name, date, object count, type breakdown), not a
  timeline visualization (a genuine visual timeline is a bigger, separable UI task; a
  sortable table ships the "per-launch" information need first). Clicking a row could
  filter the catalog page to that `OBJECT_ID` prefix via `f-q` — reuses existing search,
  no new filter plumbing.
- Label clearly: this is *catalog entries grouped by launch*, not a launch-authority
  count — reuse the "catalog entry vs. launch" glossary distinction plan 38 task 9 just
  added to `/wiki/`. A launch that put up 60 Starlinks is still one row; a launch that
  also shed debris the same week is still one row, correctly, because they share the
  `OBJECT_ID` prefix.

**Test:** extend `derive.test.mjs` with a fixture asserting the `YYYY-NNN` grouping (a
launch with a payload + rocket body + one piece of debris rolls up to one row with
`n: 3`), and that a launch with objects added across two different daily ingests (same
`OBJECT_ID` prefix, different `first_seen`) still groups as one launch, not two.

**Done when:** `npm test` green; `/spacetrack/analytics/` loads the new table under
`npm run dev` with a clean console; five viewports, no horizontal page scroll (the table
gets its own `overflow-x: auto`, same pattern as `.st-country-matrix`).

---

## D. Bloom/HDR tuning pass

**Files:** `public/orbit-engine/sat-engine.js`

**This is a tuning task, not new plumbing** — see the correction above. `_applyCinematics()`
already gates `scene.postProcessStages.bloom.enabled` on `cinematics === 'high'`, at
Cesium's untuned defaults.

**Build:**
- Tune `bloom.uniforms.glowOnly`, `.contrast`, `.brightness`, `.delta`, `.sigma`,
  `.stepSize` for a satellite-point-and-thin-orbit-line scene specifically — Cesium's
  defaults are tuned for generic 3D content and are very likely too aggressive for a
  starfield of point primitives (probable blown-out highlights on every bright satellite
  point). **Requires eyeballing a real GPU-rendered frame** — per CLAUDE.md's browser
  section, this machine can do that now (the D3D11 ANGLE launch args), which the
  original implementer's dev sandbox could not. This unblocks work that was explicitly
  left for "when a real renderer can be eyeballed."
- Optional HDR-adjacent addition: a subtle tone-mapping `PostProcessStage` (Cesium ships
  `Cesium.PostProcessStageLibrary` presets) gated the same way, same `cinematics` level —
  only if bloom tuning alone doesn't hit the "cinematic" bar the spec asks for. Treat as
  a stretch sub-item, not a requirement — don't add a second stage's guard/fallback
  complexity if tuned bloom alone reads well.
- Preserve every existing guard: WebGL2 check, missing-`bloom`-getter check, the
  `cinematics === 'low'` disable path, and the skyBox-in-both-levels behavior — none of
  that changes, only the uniform values.

**Test:** no new Node-testable logic (this is shader uniform tuning, not derivable
maths) — verification is visual, via `tests/e2e/test_orbit.py`'s existing WebGL-capable
launch args (`--use-gl=angle --use-angle=d3d11 ...` per CLAUDE.md) plus a manual screenshot
comparison at `cinematics: 'high'` vs `'low'`.

**Done when:** `npm test` green (no logic changed, only uniform values — this should not
touch any tested code path); a screenshot at `high` visibly reads as bloom-enhanced
without blown-out/washed-out satellite points, taken via the D3D11 GPU launch args, not
SwiftShader (bloom tuning judged on SwiftShader software rendering would not transfer).

---

## E. Comm-link animation

**Files:** `public/orbit-engine/sat-engine.js`, `public/orbit/orbital-relay.js` (or the
page wiring it in — confirm the exact entry point when starting this task), a new
`public/orbit-engine/comm-links.js`

**The hard constraint, stated up front:** satellites are `PointPrimitive`s in one
`PointPrimitiveCollection`, **never Entities**
([sat-engine.js:12](../../public/orbit-engine/sat-engine.js#L12), CLAUDE.md's invariants
section) — anything added via `viewer.entities.add` escapes `engine.destroy()`'s cleanup.
A comm-link needs a line between two live, moving point positions, redrawn every frame —
that rules out `Cesium.Entity`-based polylines (the `dossier.js` trail pattern) as the
model here, because a per-frame Entity position callback for N links is a different (and
here, wrong) performance and cleanup profile than the primitive path.

**Build:**
- Use a `Cesium.PolylineCollection` (a primitive collection, siblings with the existing
  `PointPrimitiveCollection` pattern) owned by the engine, not `viewer.entities`.
- Ground-station endpoints already exist:
  `groundStations`/`FALLBACK_STATIONS` in `signal.js:129`. Sat endpoints are already
  live positions in the point collection — read from the same per-frame position the
  point-rendering pass already computes, don't re-propagate.
- Scope to **visualizing an existing visibility window**, not new physics: draw a link
  only while `signal/compute.js`'s `visibilityWindows` says the selected satellite is
  above the horizon for a given ground station — reuses B's algorithmic dependency, adds
  no new maths.
- Route creation/destruction through `addManagedEntity`/`removeManagedEntity`
  (`sat-engine.js:925-940`) if any Entity-based element is used for styling (e.g. a label
  at the link midpoint) — the cross-file test guarding "no overlay entity bypasses
  managed cleanup" already exists per plan 36 Phase 2.2 and should catch a regression
  here for free if this task follows that pattern.
- Inter-satellite links (sat-to-sat, not sat-to-ground) are explicitly **out of scope**
  for this task — no existing data establishes which satellites are meant to be linked
  (that's a constellation-topology fact this repo doesn't have), and guessing at it
  (e.g. "nearest N Starlinks") would be inventing a relationship the underlying TLE data
  doesn't assert. Ground-to-satellite only, tied to Signal's existing selected-object +
  ground-station model.

**Test:** a Node-level test is possible for the geometry-selection logic (which station
pairs are "linked" at a given time, given `visibilityWindows`'s existing output) — extract
that into a pure function and test it the way `signal-compute.test.mjs` already tests its
neighbors, rather than leaving the whole feature untestable inside a Cesium render loop.

**Done when:** `npm test` green including the new pure-function test; loads under
`npm run dev` with a clean console; verify at 390px that toggling comm-links doesn't
break the Signal panel's mobile layout; confirm via the cross-file managed-entity test
that nothing escapes `engine.destroy()`.

---

## Standing invariants for every task in this plan

Same as plan 38's, restated because they apply identically here:

- **`npm test` green before "it works."** Then load the route under `npm run dev` with a
  clean console.
- **Root-absolute cross-package imports, relative intra-package.**
- **No `innerHTML` with API-derived data.**
- **Mobile is a requirement** — 390 / 412 / 820 / 1133 / 1400, no horizontal page scroll,
  ≥44px touch targets.
- **Sats are PointPrimitives, never Entities** (task E is the one task in this plan where
  this is load-bearing, not incidental).
- **The Space-Track citation ships on every new endpoint** (`X-Data-Source` via
  `json()`/`withCitation`, same as every task in plan 38).

## No landing-page sync needed

None of A–E add or remove a whole route. C adds a section to an existing page
(`/spacetrack/analytics/`); B and E add UI to an existing page (`/spacetrack/signal/`,
`/orbit/`). CLAUDE.md's landing-page sync rule doesn't apply to any of them — only
`/wiki/`'s per-route reference may need a line if a task changes what a route's filters
do (A already calls this out for the search placeholder change).

---

*Task list tracked in [39_TODO.md](39_TODO.md), one session per task, same discipline as
plan 38.*
