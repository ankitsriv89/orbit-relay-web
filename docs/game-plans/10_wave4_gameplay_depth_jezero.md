# Wave 4 — Gameplay Depth, Jezero only

Approved 2026-07-12. Doc 05 gates Wave 4 ("gameplay depth") behind Wave 2
(site expansion), but Wave 2 hasn't started — so, same resequencing logic as
Wave 3: **build Wave 4 completely on Jezero first, then copy the proven
pattern to new sites in Wave 2.** Gale is untouched throughout; every new
module no-ops on sites without `hazards`/`missions` fields.

## Build order (and why)

1. **Missions layer** (generalizes tutorial.js) — other pieces hang content
   off objectives; land the plumbing first.
2. **Hazards** — night cold-drain (trivial), soft sand (feeds vehicle feel),
   dust storms (touches the most systems: FOG, visibility, solar).
3. **Vehicle feel** (slip + rollover) — after hazards, because slip IS soft
   sand's effect on the wheel rig, and rollover risk is a sibling of
   rover.js's existing `SLOPE_K` slope computation.
4. **Science map overlays** — fully independent, safest last.

Each piece is independently playable/deployable in this order.

## 1. Missions layer — `js/missions.js` replaces `js/tutorial.js`

Tutorial becomes mission `'tutorial'` (autostart flag), preserving its exact
7 steps. Runner keeps tutorial.js's philosophy verbatim: dumb step tracker,
no polling, main.js owns every gate. `advance(matchId, value)` broadcasts to
all active chains (call sites don't name a mission — same spirit as
tutorial.js's "call sites just announce what happened").

Step types: `action` (boolean id-match — today's tutorial gate), `survey`
(scalar vs. target), `collect` (running count), `rescue`/`tow` (action-shaped
over existing sling/deliver mechanics — no new interaction code).

- `sites.js`: additive `missions: ['tutorial']` on Jezero only.
- `hud.js`: `setObjective` unchanged; new MISSIONS menu section (replaces the
  SIM-section ▶ TUTORIAL button); `onSkipTutorial` → `onSkipMission`.
- Persistence: `mc-mission-<id>-done` per mission (replaces
  `mc-tutorial-done`; existing players replay the tutorial once). Completion
  survives RESET MISSION like the science archive. In-progress state is
  session-only.
- `window.__mc.tutorial` getter → `get missions()`.

## 2. Hazards — 3 separate additions, not one module

**2a. Night cold-drain — no new module.** One multiplier in main.js's
existing battery-drain loop: `coldDrain = 1 + (1 - env.daylight()) *
NIGHT_DRAIN_K`.

**2b. Soft sand — new `js/hazardZones.js`.** colliders.js-shaped registry
returning continuous typed data (`sample(x,z) → {type, intensity, falloff,
effect} | null`), NOT a blocking boolean — colliders.js stays hard-blocking
only. `sites.js` gains `hazards.softSand: [{x,z,r,intensity}]` on Jezero
(dune fields near Séítah). rover.js gains a `sandFactor` term in the
existing multiplicative speedFactor chain + `get inHazard()` (atBoundary
idiom). New `hud.setHazard()` banner, `setBoundary`'s exact cached-toggle
idiom, separate `#mc-hazard` element.

**2c. Dust storms — new `js/weather.js`.** A single ramping intensity
timeline (idle → ramp → peak → decay, randomized intervals), shaped like
environment.js's SUN_DIR mutation but owned separately (hazard concern, not
base lighting). `forceStorm()` debug hook for E2E. Timing constants live in
weather.js (matching SLOPE_K/GEARS precedent); sites.js only carries
narrative config (`hazards.dustStorm: {peakIntensity}` — presence enables).
main.js mutates `FOG.density` from `weather.intensity` per frame;
environment.js's `update()` gains the `scene.fog.density` sync line
(mirroring its existing FOG.color sync) and main.js syncs the terrain
shader's `uFogDensity` uniform (terrain.js copies density by VALUE at
creation — color is by reference, density is not). Storm also multiplies a
`stormFactor` speed term in rover.js (separate from sandFactor) and cuts
solar recharge.

## 3. Vehicle feel — folds into rover.js/wheels.js, no new module

- **Wheel slip:** `wheels.js` `update(dt, speed, steerInput, slip = 1)` —
  `omega = speed * slip / w.r`. rover.js computes `slipRatio` from
  `inHazard.effect`; wheels visibly overspin in soft sand. `get slipRatio()`
  exposed for E2E.
- **Rollover risk:** computed beside the existing slopeMag work in rover.js.
  Thresholds in slopeMag (=1−normal.y) space: risk ramps 0→1 over
  ROLL_START 0.05 (≈18°) → ROLL_MAX 0.18 (≈35°), smoothed to avoid
  micro-relief flicker. (The plan's earlier 0.55 constant was in the wrong
  space — 0.55 slopeMag ≈ 63°, unreachable.) `get rolloverRisk()` getter.
- **HUD:** new ROLL row in the telemetry grid (`is-low`/`is-crit` idiom,
  BATT precedent) — graduated readout, not a banner. Rover-only.

## 4. Science map overlays — elevation / slope / path

Mode toggle lives in the MENU (new SCIENCE OVERLAYS section: PHOTO /
ELEVATION / SLOPE / PATH), not the HUD — matches the menu-not-HUD-chrome
bias (SOL CYCLE / RESET / replays are all menu-only).

fog.js: `setOverlayMode(mode)` + a `currentMode`-gated base-canvas pick in
`render()` (the one genuinely new plumbing). Elevation/slope rasters reuse
`buildBase()`'s existing FOG_RES `sampleHeight` grid + gradient math, built
lazily on first switch (H/gradient fields cached in a shared helper). Slope
ramp green→red, consistent with the ROLL telemetry language. PATH =
breadcrumb polyline from a capped array main.js appends to on the existing
0.1s telemetry tick, passed as `extras.path` (extras-bag precedent). Fog
composite applies identically in all modes; only the base swaps.
Persistence: `mc-overlay-mode` (mc-tele/mc-dronectl convention).

## Files

- **New:** `js/missions.js`, `js/hazardZones.js`, `js/weather.js`
- **Deleted:** `js/tutorial.js`
- **Edited:** `js/main.js`, `js/rover.js`, `js/wheels.js`, `js/hud.js`,
  `js/fog.js`, `js/sites.js`, `js/environment.js` (density sync line),
  `style.css`, `.claude/skills/verify/SKILL.md`

## Verification

Per piece, headless via `window.__mc` (channel='chrome', evaluate-polling,
canvas toDataURL — see verify skill):
1. **Missions:** same 7-step drive as the Wave 3 tutorial script, asserting
   `missions` chain ids + `mc-mission-tutorial-done`.
2. **Hazards:** teleport into a softSand zone → `rover.inHazard.type` +
   measured speed drop; night via sol-cycle → higher drain; forceStorm() →
   FOG.density rise/decay.
3. **Vehicle feel:** steep-slope teleport → rolloverRisk rises/decays; sand
   zone → slipRatio > 1.
4. **Overlays:** toDataURL diff per mode; slope-mode pixel probe steep-vs-
   flat; path trail growth + pixel probe.

Manual playtest via the `run` skill after each piece lands.
