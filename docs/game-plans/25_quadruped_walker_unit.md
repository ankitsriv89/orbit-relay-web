# Plan 25 — Legged Walker Units ("Strider" quad + "Arachne" octopod)

A four-legged robot that walks Mars terrain, added as a new fleet unit
alongside Rover / Recon Drone / Lift Drone / Humanoid / Van. Octopod
("Arachne") is a Mk-II on the same code path — see §7.

> **AS-BUILT (2026-07-20):** both walkers shipped together in one wave via a
> shared `walker-rig.js` engine (procedural, no GLB). `strider.js` + `arachne.js`
> are thin specs over it. Reference-matched livery + a HUD dossier chip/lightbox
> from the concept renders (`assets/dossier/`). Verified 20/20 in headless
> Chromium (locomotion, anti-skate, terrain-conform, dossier UI). The one real
> bug found + fixed in build: the humanoid's `swingT=(sin+1)/2` swing inverts the
> lift and slams the foot ~1.1 m at touchdown on a multi-leg body — replaced with
> a continuity-planted swing (plant captured from the foot's actual commanded
> position, so skate is impossible by construction). See §5a.

## 1. Why (mission-accurate)

Wheels bog in loose regolith and can't take steep rocky slopes — the exact
reason JPL/NASA prototype legged/hybrid rovers (LEMUR, DuAxel) and why
ANYmal/Spot get tested in Mars-analog terrain. The Strider fills the fleet
gap between the fast-but-slope-limited Rover and the go-anywhere-but-slow
Humanoid: lower center of gravity, best slope tolerance in the fleet,
sure-footed across boulder fields.

## 2. What we already have (reuse)

The Wave 12.2 foot-IK in `humanoid.js` is the whole locomotion engine, and
it is already N-leg-ready in spirit:

- `solveIk(thighBone, targetWorldX,Y,Z)` — two-bone analytic (law of
  cosines) solve, parent-local forward/up plane. Generic to any 2-bone leg.
- `solveLeg(thigh, calf, planted, plant, phase, lateral)` — one leg's
  stance/swing. **Already parameterized by `phase` and `lateral`.**
- `plantFoot()` / `plantIdle()` — world-lock a stance foot (anti-skate).
- `groundAt(x,z)` = `terrain.sampleGroundHeight` (+ deck) — per-foot
  terrain-adaptive footfall, already working.

A biped is 2 calls to `solveLeg`. A quadruped is 4; an octopod is 8. The
solver, terrain sampling, and anti-skate lock are done. The new work is a
leg array, a gait table, and a terrain-tilting body.

## 3. Core decisions

- **Procedural articulated rig, not a GLB (v1).** Build hip→thigh→calf as
  nested `Object3D` groups in code. Works fully offline with zero asset
  pipeline, dodges the GLB bone-orientation risk. A Tripo GLB can swap in
  later for beauty only (see §3a for why procedural won't read as cheap).
- **Multi-material treatment (not flat white).** `humanoid.js:498` uses one
  flat `0xf2f2f2` suit color — fine for a spacesuit, wrong default for a
  robot. Strider follows the rover's precedent (`rover.js:584/594/601`,
  separate materials per part) instead:
  - Chassis: burnt-orange composite `0xc0522d`, `metalness:0.2, roughness:0.55`
    (Mars Sim livery, not sci-fi white/grey)
  - Leg segments (femur/tibia): titanium `0x4a4a4a`, `metalness:0.7,
    roughness:0.35` — visually distinct from the body as jointed hardware
  - Joint hubs (hip/knee pivots): near-black `0x1a1a1a` — anchors where the
    IK actually bends
  - Sensor/head accent: small `emissive: 0x2288ff` lens/strip, low
    intensity — reads as "alive" for near-zero cost
  - Panel lines/AO: 2-3 slightly inset boxes per body panel instead of one
    box — free depth/shadow occlusion under the sim's existing directional
    light, no textures needed
  All still procedural, offline-safe, IK-friendly — just proper materials
  instead of one flat color.
- **Generalize the leg loop** from 2 hardcoded legs to
  `legs[] = [{thigh, calf, phase, longOffset, latOffset}]`. `solveIk` and
  `solveLeg` reused unchanged; `solveLeg` gains a `longOffset` (front/back)
  in addition to the existing `lateral`.
- **Body follows terrain.** Unlike the biped (stays gravity-vertical), the
  Strider body pitches/rolls onto the ground via the existing
  `terrain.sampleGroundNormal()`. That slope-hugging tilt is the visual
  signature of a legged robot.
- **No lope / jump** (biped-only physics). The Strider trades speed for
  stability + slope tolerance — a distinct fleet role.

## 4. Gait table (phase offsets only)

| Gait  | FL   | FR   | BL   | BR   | When |
|-------|------|------|------|------|------|
| Trot  | 0    | 0.5  | 0.5  | 0    | cruising (diagonal pairs) |
| Crawl | 0    | 0.5  | 0.25 | 0.75 | steep / rough (one foot at a time, always 3 down) |

Cadence still scales with actual ground speed (reuse the Wave 12.1
foot-skate fix so a slow climb doesn't pump legs at full rate).

## 5. Build steps

1. New module `public/mars-colony/js/strider.js` — copy the `humanoid.js`
   skeleton (heading, stride, boundary, tether-optional), swap the mesh
   builder for a procedural 4-leg robot rig, replace the 2-leg IK block
   with the generalized `legs[]` loop.
2. Body-tilt: apply `sampleGroundNormal()` pitch/roll to the body group
   (opposite of the humanoid's gravity-vertical choice).
3. Gait state machine: trot ↔ crawl on a slope threshold; turn-in-place.
4. Wire in `main.js`:
   - `import { createStrider }`; instantiate with
     `colliders.forUnit('strider')`.
   - Add to `units[]` ([main.js:419]): `kind: 'ground'`, `drainRate ~0.06`
     (efficient legged), `charge: 100`.
5. `models.js` — optional registry entry (only if a GLB is added later;
   procedural rig needs none).
6. `colliders.js` — a `forUnit('strider')` collider (boulders + structures
   + other units), same facade as the humanoid.
7. HUD — add a controls line ([hud.js] ~238) and gear/telemetry follow.
8. Slope tolerance — allow steeper traverse than the rover in the movement
   clamp; this is the unit's whole point.

## 6. Testing (mandatory)

Add E2E to `tests/e2e/test_browser.py` for the new unit:
- Unit appears in fleet, Tab-cycles to it, HUD shows its name/controls.
- WASD drives it; it stays on terrain; no console errors.
- Slope traverse the rover can't complete succeeds.
- Mobile viewport (375×812) — stick control works.
Run only the new/affected tests (per testing rules). CI runs the full suite.

## 7. Octopod ("Arachne") Mk-II — later

Same code path, 8 entries in `legs[]`, denser gait ripple. The one real
addition: quad legs mount mammal-style in the body fore-aft plane, so the
current `solveIk` plane assumption holds unchanged. Octopod legs **splay
radially**, so some point sideways — `solveIk` must be generalized to solve
in each leg's own radial plane (rotate the solve plane by the leg's mount
azimuth) rather than the hardcoded body-forward plane. That generalization
is exactly why the quadruped ships first and the octopod is a follow-on.

## 8. Open questions

- Call-signs: "Strider" (quad) / "Arachne" (octo) — confirm or rename.
- Does the Strider get its own dock/charge behavior, or share the pad logic?
- Should it carry/tow anything (sample sling like the Lift Drone), or is it
  a pure traversal/recon unit in v1?
