# Orbital Relay — CZML trajectory export

## Context

Prompted by the CZML Sandcastle demo (`sandcastle.cesium.com/?id=czml`) and the
assessment that followed it on 2026-08-19, now recorded in CLAUDE.md's "Invariants that
look like bugs":

- **CZML is wrong for rendering here.** `CzmlDataSource` creates Entities — the pattern
  that blew the heap to 1.2 GB (issue #71) — caps near 4k satellites, wants positions
  baked ahead of time (fighting live TLE propagation), and offers nothing we lack, since
  `viewer.clock` is already the single time source with time-warp as `clock.multiplier`.
- **CZML is right for export.** One object at a time sidesteps every objection above.

**This plan does not change rendering.** Not one satellite is drawn differently. It adds
a button that produces a file.

### What it actually does

A user selects an object on `/spacetrack/`, the dossier opens, they press **EXPORT CZML**,
and a `.czml` file downloads. The site itself is unchanged.

The value is entirely in where that file goes *next*: it is a portable, self-contained
trajectory that loads in Cesium Sandcastle (drag-and-drop), STK (CZML is an AGI format),
any other CesiumJS app, or a colleague's machine that has no access to this site. Today
that trajectory exists only inside a browser tab. This lets it leave.

**Scope boundary — this is an interoperability feature, not a visualization one.** It
does not add a viewer, a preview, a re-import path, or any new globe rendering. If a
future session wants "load a CZML someone hands us," that is a different feature with the
Entity-cost problem back in play, and it needs its own plan.

---

## Why this is cheap

The propagation is already there and already correct. `_samplePath()`
([sat-engine.js:620](public/orbit-engine/sat-engine.js#L620)) and `path()`
([propagate.worker.js:132](public/orbit-engine/propagate.worker.js#L132)) already walk a
signed span calling real SGP4 per vertex, and are asserted to agree within 1.0 m
(`tests/e2e/test_orbit.py:176`). Export is serialization of arithmetic we already trust.

### Four things that are NOT reusable as-is

Verified by reading the code — each one shapes the design below:

1. **The existing samplers return `Cesium.Cartesian3[]`, not numbers.** `_samplePath` ends
   in `Cesium.Cartesian3.fromDegrees(...)` (`sat-engine.js:634`). A pure, Node-testable
   CZML builder must not take Cesium objects, so the builder accepts plain
   `{t, x, y, z}` and a thin adapter unwraps `.x/.y/.z`.
2. **The existing sampling is per-revolution and capped at 480 vertices**
   (`propagate.worker.js:162`) — tuned for a smooth-looking polyline. An export wants
   *uniform time steps over a wall-clock span* (e.g. 60 s over 24 h = 1,440 samples).
   Different question, so export samples on its own schedule rather than bending the
   render path.
3. **`CITATION` is server-only.** It lives in
   [_orbit.js:17](functions/api/_orbit.js#L17), duplicated in
   `workers/orbit-ingest/src/derive.js:28`, and `derive.test.mjs:356` asserts the two are
   **byte-identical** because divergence is a licence problem. `public/` cannot import
   either. **Do not add a third copy** — that breaks a tested invariant. The frontend
   already receives the string on every API response as the `X-Data-Source` header
   (`_orbit.js:17-19`); read it from there and fall back to a short generic attribution
   only if absent.
4. **`orbitalPeriodMin` and `geoAt` live in `astro.js`**, which imports nothing from
   Cesium — safe to reuse directly.

---

## 1. The builder — `public/shared/czml-export.js`

Pure module. No DOM, no Cesium, no `satellite.js`. Same discipline as
`signal/compute.js` and `constellations/compute.js`, so it is unit-testable in Node.

```js
export function buildCzml({ name, noradId, samples, startMs, endMs, citation })
```

`samples` is `[{ t, x, y, z }]` — `t` in **seconds since `startMs`**, `x/y/z` in **ECEF
metres**. Returns a CZML array (a JS value, not a string; the caller serializes).

Two packets:

```js
[
  {
    id: 'document',
    name: `${name} trajectory`,
    version: '1.0',
    description: citation,              // licence rides in the file itself
    clock: {
      interval: `${isoStart}/${isoEnd}`,
      currentTime: isoStart,
      multiplier: 60,
      range: 'LOOP_STOP',
      step: 'SYSTEM_CLOCK_MULTIPLIER',
    },
  },
  {
    id: `norad-${noradId}`,
    name,
    availability: `${isoStart}/${isoEnd}`,
    description: citation,
    position: {
      epoch: isoStart,
      referenceFrame: 'FIXED',          // ECEF — see note below
      cartesian: [t0,x0,y0,z0, t1,x1,y1,z1, …],   // flat, per CZML spec
      interpolationAlgorithm: 'LAGRANGE',
      interpolationDegree: 5,
    },
    path: {
      material: { solidColor: { color: { rgba: [0, 255, 255, 180] } } },
      width: 2, leadTime: 0, trailTime: 5400, resolution: 60,
    },
    point: { color: { rgba: [0,255,255,255] }, pixelSize: 8 },
    label: { text: name, font: '11pt monospace', pixelOffset: { cartesian2: [12, 0] },
             fillColor: { rgba: [0,255,255,255] } },
  },
]
```

**`referenceFrame: 'FIXED'` is load-bearing and easy to get wrong.** CZML's default is
`INERTIAL` (ECI). Our samplers produce Earth-fixed ECEF (`geodeticToEcef`,
`propagate.worker.js:34-52`). Omitting this makes the orbit appear to rotate wrongly
against the globe — a bug that *looks* like bad propagation. Assert it in the test.

Also: ISO strings must be real UTC (`toISOString()`), and `t` values must be seconds
relative to `epoch`, not absolute — the classic CZML off-by-epoch mistake.

## 2. The sampler adapter — in the export module, Cesium-free

Reuses `orbitalPeriodMin` + `geoAt` from `/orbit-engine/astro.js` and the same
geodetic→ECEF conversion the worker uses. Walks **uniform wall-clock steps**:

```js
const stepSec = chooseStep(spanHours);   // see table
for (let t = 0; t <= spanSec; t += stepSec) { … }
```

| Span | Step | Samples |
|---|---|---|
| 1 h | 10 s | 361 |
| 6 h | 30 s | 721 |
| 24 h | 60 s | 1,441 |

Rationale: LAGRANGE degree 5 over a 60 s step is standard for orbital ephemeris and
interpolates to well under a metre for LEO. Hard-cap samples at **5,000** so a future
span cannot produce a multi-MB file.

**Do this off the render path.** 1,441 synchronous SGP4 calls is roughly the ~54,000-
propagation main-thread stall that audit finding M-18 fixed (`propagate.worker.js:14-15`),
scaled down — tolerable as a one-shot on a click, but it *will* jank the globe for a beat.
Two acceptable options; pick at implementation time:
- Simplest: run it synchronously, disable the button and show `WORKING…` for the duration.
- Better: extend `propagate.worker.js` with an `export` job mirroring `path()`. Preferred
  if it stays under ~40 lines, since the worker already has the satrec cached.

## 3. The UI — one button in the dossier

`public/shared/dossier.js` already owns the panel and holds `dossierSatrec` plus the
selected object's metadata (`:30`, `:22-37`), and every globe route already routes
through it. That makes it the single insertion point — **not** four per-page copies
(CLAUDE.md: "Don't add a fourth copy").

- Button in the dossier footer, following the existing `st-toggle-btn` pattern (≥44 px
  touch target, already satisfied by that rule).
- Build the file with `Blob` + `URL.createObjectURL` + a synthetic `<a download>`, then
  **`URL.revokeObjectURL` in a `finally`** — the dossier is opened and closed repeatedly
  and leaked blob URLs accumulate for the tab's lifetime.
- **`createElement` only. No `insertAdjacentHTML`** (repo rule — the object name is
  API-derived and would be an injection vector).
- Filename: `norad-<id>-<yyyymmdd>.czml`.
- Citation: read `X-Data-Source` off the response the dossier already made
  (`shared/api.js`), pass into `buildCzml`. Never hardcode a third copy.

Span control: a small cycle button (`1H` / `6H` / `24H`) beside Export, matching how
`currentRevs` already cycles in `/shared/hud.js`. Default **6H**.

## 4. Tests — `workers/orbit-ingest/test/czml-export.test.mjs`

Follows the `signal-compute.test.mjs` / `catalog-compute.test.mjs` import pattern so
`npm test` picks it up with no runner change.

Assert:
1. Exactly two packets; first is `id: 'document'` with `version: '1.0'`.
2. `cartesian` length is `4 × sampleCount` (flat quadruples, not nested).
3. First sample's `t` is `0`; `t` increases monotonically; last equals span in seconds.
4. **`referenceFrame === 'FIXED'`** — the §1 trap.
5. `epoch` parses as a valid ISO UTC instant and matches `availability`'s start.
6. `description` contains the citation string passed in.
7. `JSON.parse(JSON.stringify(czml))` round-trips — no `undefined`/`NaN` leaking in
   (a `NaN` from a decayed elset would silently serialize to `null` and produce a file
   that loads but draws nothing).
8. A degenerate satrec (`no = 0`, the case `propagate.worker.js:156-157` guards) produces
   either a valid file or a clean throw — never `NaN` coordinates.

Guardrail-first, per CLAUDE.md: write #4 and #7 and watch them go red against a
deliberately broken builder before wiring the button.

---

## Verification

1. **`npm test`** — green, including the new suite.
2. **`npm run dev`**, `/spacetrack/`, select an object, export. **Console clean.**
3. **The real acceptance test — load the file in Cesium Sandcastle.** Drag the `.czml`
   onto `sandcastle.cesium.com`. The satellite must appear, animate along its path when
   the clock runs, and the orbit must sit *stationary in the Earth-fixed frame* rather
   than precessing visibly — that is the `referenceFrame` check with eyes on it.
4. **Cross-check against the live globe.** Export, then compare the CZML's first position
   against `engine.geo(satrec)` at the same instant. Should agree to ~1 m, the same bound
   `test_orbit.py:176` uses.
5. **Export an eccentric object** (a Molniya, e ≈ 0.716 — altitude swings 2,072→38,346 km
   per the 2026-08-19 measurement). The exported path must be a visible ellipse. Note the
   trimmed baseline `/data/tle/` files carry no Molniya, so this needs a live `/api/tle`
   or D1 elset.
6. **390 px**, plus 412/820/1133/1400 per `tests/e2e/test_mobile_responsive.py`. No
   horizontal scroll; button ≥44 px.
7. **Blob URL hygiene** — open/export/close ~20 times, confirm no growth in
   `performance.memory.usedJSHeapSize`.

## Not in scope

- **CZML import / rendering.** Reintroduces the Entity cost this was rejected for.
- **Bulk export** of a filtered set. 500 objects × 1,441 samples is a ~100 MB file; if
  ever wanted it belongs server-side as an R2 artifact, not a browser blob.
- **Other formats** (OEM/CCSDS, KML). Same builder shape, separate plans.
- **A landing-page / wiki entry.** This adds no route, so per CLAUDE.md the landing page
  and `/wiki/` app reference do not need updating — though a `/wiki/` glossary line for
  "CZML" would be reasonable if the term appears in the UI.
