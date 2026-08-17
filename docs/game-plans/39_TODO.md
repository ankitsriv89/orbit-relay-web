# Plan 39 — Task List

One task per session, same discipline as [38_TODO.md](38_TODO.md). Each is self-contained:
it names the files, the gate, and what "done" means, so a cold session can start from this
file plus [the plan](39_signal_and_search_polish_plan.md) without re-deriving context.

**Every task ends with `npm test` green.**

Status: `[ ]` not started · `[~]` in progress · `[x]` done (record the commit).

**All five tasks (1–5) landed in the plan-39 batch commit, 2026-08-17** — see
[docs/build-logs/2026-08-17_build_log_02.md](../build-logs/2026-08-17_build_log_02.md)
for the build, the blocker bugs found and fixed, and the verification battery.

---

## [x] 1 — Mission-search clarity + wiki note

**Why first:** smallest task, no code path changes, good warm-up for the plan.

**Build**
- `public/spacetrack/index.html`: update both `#f-q` and `#fd-q` placeholders from
  `"name, intl designator, NORAD"` to `"name, mission, intl designator, NORAD"`.
- `/wiki/` glossary: one-line note that "mission" is not a distinct Space-Track field and
  is covered by the existing name search (`OBJECT_NAME` usually *is* the mission/payload
  name).

**Done when:** `npm test` green; both placeholders updated; wiki note added.

---

## [x] 2 — Pass notifications

**Files:** `public/spacetrack/signal/signal.js`, new
`public/spacetrack/signal/notifications.js`

- Browser `Notification` API wrapper, permission requested only on explicit toggle click
  — never auto-prompted on load.
- `setTimeout`-scheduled notifications from `predictPasses`'s existing pass list (no new
  computation) — capped to the passes already rendered.
- Clear timers on deselection and `beforeunload`.
- Toggle is ≥44px, has a visible on/off state (not just relying on the browser's native
  permission icon).

**Done when:** `npm test` green; e2e check that the toggle exists, is ≥44px, and
`Notification.requestPermission` isn't called before the toggle is clicked; manual
verification in a real browser tab (headless sandboxes are inconsistent for
`Notification`).

---

## [x] 3 — Launch history — per-launch grouping

**Files:** `workers/orbit-ingest/src/derive.js`, `functions/api/analytics.js` (or a new
sibling endpoint), `public/spacetrack/analytics/analytics.js`,
`workers/orbit-ingest/test/derive.test.mjs`

- New `catalog/launches.json` artifact: `GROUP BY substr(OBJECT_ID, 1, 8)` over `objects`,
  joined to `launch_sites` for the name, rolling up date/site/object-count/type-breakdown.
  Own artifact, not folded into `analytics.json` (different shape — rows vs aggregates).
- New `.st-card--wide` section on `/spacetrack/analytics/`: reverse-chronological table,
  not a timeline viz. Row click could filter the catalog page via `f-q` (reuses existing
  search).
- Label as *catalog entries grouped by launch*, using plan 38 task 9's existing glossary
  distinction — not a launch-authority count.

**Test:** fixture asserting `YYYY-NNN` grouping rolls up payload + rocket body + debris
into one row; a launch spanning two ingest days still groups as one.

**Done when:** `npm test` green; loads under `npm run dev` clean console; five viewports,
no horizontal page scroll (table gets its own `overflow-x: auto`).

---

## [x] 4 — Bloom/HDR tuning pass

**Files:** `public/orbit-engine/sat-engine.js`

- Tune `bloom.uniforms` (`glowOnly`, `contrast`, `brightness`, `delta`, `sigma`,
  `stepSize`) for a point-primitive starfield scene, using this machine's real GPU
  (D3D11 ANGLE launch args per CLAUDE.md) — the original defaults were left untuned
  because the original dev sandbox couldn't render (Cesium Ion 403).
- Keep every existing guard (WebGL2 check, missing-stage check, `cinematics==='low'`
  disable, skyBox-in-both-levels) unchanged — uniform values only.
- Optional stretch: a tone-mapping `PostProcessStageLibrary` preset, same gating — only
  if tuned bloom alone doesn't hit the "cinematic" bar.

**Done when:** `npm test` green (no tested logic touched); screenshot at `cinematics:
'high'` via D3D11 GPU launch args (not SwiftShader) shows bloom without blown-out
satellite points; `'low'` unaffected.

---

## [x] 5 — Comm-link animation (ground-to-satellite)

**Files:** `public/orbit-engine/sat-engine.js`, `public/orbit/orbital-relay.js` (confirm
exact wiring point at task start), new `public/orbit-engine/comm-links.js`

- `Cesium.PolylineCollection` (primitive, not `viewer.entities` — sats are
  PointPrimitives, never Entities, CLAUDE.md invariant).
- Ground-station endpoints from `signal.js:129`'s `groundStations`/`FALLBACK_STATIONS`;
  satellite endpoint from the existing per-frame point position, not re-propagated.
- Link visible only during an active visibility window
  (`signal/compute.js`'s `visibilityWindows`) — no new physics, reuses task 2's
  algorithmic dependency.
- Any Entity-based styling element routes through `addManagedEntity`/
  `removeManagedEntity` so the existing cross-file managed-cleanup test covers it.
- Ground-to-satellite only. Inter-satellite (sat-to-sat) links are explicitly out of
  scope — no data establishes real link topology between satellites.
- Extract the "which station-pairs are linked right now" selection logic into a pure,
  Node-testable function (same pattern as `signal-compute.test.mjs`).

**Done when:** `npm test` green including the new pure-function test; loads under
`npm run dev` clean console; 390px check that comm-links don't break Signal's mobile
layout; managed-entity cleanup test still passes.

---

## Standing invariants for every task in this plan

- **`npm test` green before "it works."** Then load the route under `npm run dev` with a
  clean console.
- **Root-absolute cross-package imports, relative intra-package.**
- **No `innerHTML` with API-derived data.**
- **Mobile is a requirement** — 390 / 412 / 820 / 1133 / 1400, no horizontal page scroll,
  ≥44px touch targets.
- **Sats are PointPrimitives, never Entities** — load-bearing for task 5.
- **Space-Track citation ships on every new endpoint.**

**No landing-page sync needed for any task in this plan** — none add or remove a whole
route.
