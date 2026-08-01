# Orbital Relay — Trajectory Paths (past orbit + multi-rev)

## Context

Executes **§3.1 "Past orbit + multi-rev"** of
[34_unblock_landing_refactor_plan.md](34_unblock_landing_refactor_plan.md), which is
spec feature **#3 Orbit Prediction** ("draw previous and future orbits", "predict multiple
orbital revolutions") in
[Orbital_Relay_Feature_Specification.md](Orbital_Relay_Feature_Specification.md).

Split into its own file because the parent plan allots this one bullet, and the execution
detail below would unbalance a document that covers four phases.

**Trajectory rendering already ships.** `addInspectVisuals()` (`sat-engine.js:527`) draws an
orbit ring + ground track + footprint, and all four globe routes already call it on
selection: `orbital-relay.js:290`, `starlink.js:238`, `catalog.js:801` and `:839`,
`signal.js:56`. The `/spacetrack/` catalog additionally runs a 60-sample breadcrumb trail
(`catalog.js:728-773`), already marked complete as Tier 1.4 in
`public/spacetrack/VISUALIZATION-PLAN.md:8`.

What is missing is **extent**. Both samplers walk `for (let i = 0; i <= steps; i++)` over
exactly one orbital period forward from now — forward-only, single-rev, no user control:

- `sat-engine.js:281` — `_samplePath()`, the synchronous fallback
- `propagate.worker.js:144` — `path()`, the worker job

**Outcome:** the selected object shows a dashed trailing past arc and a glowing future arc
of 1–3 revolutions, controlled by one cycle button, on all four globe routes.

### Correction to the parent plan

§3.1 states *"Change the loop bound to `-steps/2 … +steps*revs`. Two files, one bound each."*
The two files and the signed bound are right, but two things make it more than a bound change:

1. **`steps` is doing double duty** — it is both the vertex count and, implicitly, the
   resolution across one period. Left alone, 3 revs at 120 steps gives 40 vertices per
   revolution, which reads as visibly polygonal. `steps` has to scale with the span.
2. **A single polyline cannot distinguish past from future.** Direction only reads if the
   trailing arc is styled differently, which means a second entity.

Also note the line references in §3.1 (`sat-engine.js:457, :534`) have drifted; the hardcoded
`steps` values are at `:457` (orbit ring, 90) and `:534`/`:470` (inspect orbit and ground
track, 120).

---

## Scope

**Selected object only.** Not the visible set. This is a deliberate performance boundary:

Every polyline in this repo is a Cesium **Entity** (`viewer.entities.add({polyline: …})`),
while every satellite is a batched PointPrimitive in one collection. That asymmetry is
intentional for points and incidental for lines. Drawing a path per visible object means 500
Entities on `/spacetrack/` (`RENDER_CAP`, `catalog.js:15`) or up to 8000 on `/starlink/`
(`SAT_CAP_FULL`, `starlink.js:24`) — reintroducing exactly the per-Entity pattern that
`sat-engine.js:10-30` documents as having blown the heap to 1.2 GB (issue #71).

`Cesium.PolylineCollection` — the batching primitive — is **unused anywhere in this repo**.
Migrating to it is the prerequisite for multi-object paths, and the crossover is roughly
30–50 simultaneous paths. Out of scope here; see "Follow-ups".

### Cost of what is in scope

~120 → ~360 propagations per 2 s refresh, in the worker, for one object. Negligible against a
steady tick of up to 500 propagations every 280 ms. The worker's 64-entry `pathRecs` LRU
(`propagate.worker.js:60-81`) is unaffected because past and future jobs share one TLE key.

---

## 1. Engine — give paths a signed span

### `public/orbit-engine/propagate.worker.js`

`path()` at `:132` gains two optional params, `spanFrom` and `spanTo`, in **revolutions**
(signed, fractional), defaulting to `0` and `1` so every existing caller is unchanged:

```js
function path(job, l1, l2, kind, steps, t0Ms, periodMin, spanFrom = 0, spanTo = 1) {
    ...
    const span = spanTo - spanFrom;
    for (let i = 0; i <= steps; i++) {
        const rev  = spanFrom + (i / steps) * span;
        const date = new Date(t0Ms + rev * period * 60000);
```

Negative `rev` propagates backwards. SGP4 is symmetric about the epoch and handles this
without a guard. Thread both params through the `case 'path'` dispatch at `:185`.

### `public/orbit-engine/sat-engine.js`

Mirror the change in three places, keeping the sync fallback and the worker numerically
identical — `tests/e2e/test_orbit.py:176` asserts they agree within 1.0 m:

- `_samplePath(satrec, steps, heightOf, spanFrom = 0, spanTo = 1)` at `:277`
- `computeOrbitPath` / `computeGroundTrack` at `:290`/`:295` — forward the span
- `requestPath()` at `:235` and `workerPath()` at `:251` — accept a span, pass it to both
  the worker message and the `sync()` fallback closure

**Resolution:** scale vertex count with span, `Math.round(baseSteps * Math.abs(span))`,
clamped to ~480 so a future higher rev count cannot blow up the transferred buffer.

## 2. Engine — split the inspect visuals

`addInspectVisuals(meta, cssColor, { revs = 1 } = {})` at `:527` gains a fourth entity in the
returned bag. `removeEntities()` at `:548` already iterates `Object.values()`, so teardown
needs no change.

```js
return {
    past: this.viewer.entities.add({          // NEW — dashed, -0.5 rev → now
        polyline: {
            positions: new Cesium.CallbackProperty(
                this.workerPath(meta, 'orbit', 60, 2000, -0.5, 0), false),
            width: 1.2,
            material: new Cesium.PolylineDashMaterialProperty({
                color: accent.withAlpha(0.25), dashLength: 10,
            }),
            arcType: Cesium.ArcType.NONE,
        },
    }),
    orbit: /* as today, but span 0 → revs, steps scaled */,
    track: this.addGroundTrack(meta, cssColor, { width: 1.4, alpha: 0.4 }),
    foot:  this.addFootprint(meta.satrec, cssColor, { fill: 0.06, outline: 0.4, width: 1 }),
};
```

`PolylineDashMaterialProperty` is reused exactly as `addGroundTrack()` at `:472` uses it.

**Ground track stays at one period.** Three revolutions of ground track is three
near-identical sinusoids offset by nodal regression — noisier, not more informative.

### The render trap

`tuneViewerForDevice()` sets `requestRenderMode = true` (`sat-engine.js:73-84`). A rev-count
change that mutates an existing polyline **must** call `engine.requestRender()`, or the globe
freezes into a still image *and every existing test still passes*
(`docs/issues-and-resolutions.md:25`).

Simplest correct approach: on rev change, tear down and rebuild via `removeEntities()` +
`addInspectVisuals()`. Both already call `requestRender()` (`:528`, `:550`).

## 3. UI — the rev-count button

State key `trajectory.revs` (default `1`), persisted via `spacetrack/shared/state.js`,
matching how `time.rate` is handled in `shared/globe.js:70-103`.

A shared `cycleRevs()` + label helper goes in `public/shared/hud.js` — the cross-route UI
module created by §2.1 — imported root-absolute as `/shared/hud.js`, which all four routes
already do.

| Route | Insertion point | Note |
|---|---|---|
| `/spacetrack/` | 5th `st-toggle-btn`, `index.html:100-116` | Cleanest home. **Must reset in `clearRendered()`** (`catalog.js:553-575`) exactly as the other four toggles do. |
| `/spacetrack/signal/` | Beside `#time-warp`, `signal/index.html:137` | Single object; cheapest route. |
| `/starlink/` | `#density-hud-body`, `starlink/index.html:74` | Selection-only, so the 8000-object slider is not a factor. |
| `/orbit/` | `layers-hud-body` **and** `#layer-list-drawer` | **Author twice** — desktop panel and mobile drawer are duplicated verbatim, mirrored at `index.html:88-101`. Must **not** carry class `layer-cb`, or `reloadAllLayers()` (`orbital-relay.js:425-438`) treats it as a Celestrak layer. |

The `/orbit/` duplication disappears once §3.1's **JS layer registry** lands. If that is
sequenced first, this button is authored once instead of twice.

`catalog.js` has **two** `addInspectVisuals` call sites — `:801` (meta path) and `:839`
(API-TLE path) — both need the revs argument. `conjunctions.js:298-366` has the same two-entry
shape.

Mobile: ≥44 px touch target per `CLAUDE.md`; the existing `st-toggle-btn` rule already
satisfies it.

## 4. Fix the E2E assertion first

`tests/e2e/test_orbit.py:179-186` asserts that *some* entity has a polyline with `> 50`
positions:

```js
return viewer.entities.values.some(e => {
    if (!e.polyline || !e.polyline.positions) return false;
    const p = e.polyline.positions.getValue(t);
    return !!p && p.length > 50;
});
```

A new past-orbit polyline satisfies this accidentally — the test would stay green even if the
ground track broke completely.

Per `CLAUDE.md` ("write the guardrail before the fix and watch it go red on the real bug"):
tighten it to assert on the ground-track entity specifically (`clampToGround === true`), and
**confirm it goes red against current HEAD** by temporarily breaking the ground track. Only
then add assertions for the new past polyline and for rev count changing the future path's
vertex count.

---

## Verification

1. **`npm test`** — must be green. Catches a syntax error killing a whole ES module
   (`catalog.js` shipped exactly that) and any unresolvable specifier.
2. **`npm run dev`**, load all four routes, select an object, **console clean**. A globe that
   renders is not proof — a dead module fails silently.
3. **Watch for the freeze.** Cycle revs, then leave the camera still. If the globe stops
   updating, a `requestRender()` is missing. This failure mode passes every existing test.
4. **Worker/sync agreement.** `__orbit.disableWorker('test')` then re-select; the dashed past
   arc must be unchanged. `test_orbit.py:176` covers the tick, not paths — verify the
   negative-span path visually under both.
5. **390 px**, plus 412/820/1133/1400 per `tests/e2e/test_mobile_responsive.py`, including
   landscape phone. No horizontal page scroll; touch target ≥ 44 px.
6. **`tests/e2e/`** via the `verify` skill rather than hand-rolled Playwright.
7. **`/orbit/` drawer parity** — the mobile drawer copy of the button must work, not just the
   desktop panel.

## Follow-ups (not in this plan)

- **Multi-object trajectories.** Needs the `Cesium.PolylineCollection` migration; crossover
  ~30–50 paths. The natural pairing is §3.2's constellation / orbital-plane view, which wants
  batched great-circle rings for the same reason.
- **Ground-track multi-rev**, if repeat-cycle visualization (spec #4) is picked up.
- **`_pathJobs` has no timeout and no cancellation** (`sat-engine.js:235-243`). Jobs settle
  only on worker reply or `disableWorker()`, so rapid selection churn leaks map entries.
  Pre-existing; marginally worsened by a second job per selection.
