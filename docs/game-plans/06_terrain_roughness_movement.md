# Mars Colony — Terrain Roughness + Movement Realism Pass

Approved and built 2026-07-10. Follow-up to `05_mars_colony_phase_next.md` Wave 1; overlaps Wave 3's "vehicle feel" item.

## Problem

Rover/humanoid movement read as unreal; the surface read as too flat. Investigation showed the physics/telemetry pipeline was already genuinely DEM-driven (slope tilt, speed falloff, live HUD slope/elev) — the gap was resolution:

- Real slope stats (computed from the shipped heightmaps): Gale native-res (4.4m/px) slope mean 5.7°, p90 11°, p99 27°, max 73°; Jezero (5.9m/px) mean 3.8°, p90 7.5°, max 34°. The data has plenty of roughness.
- But the mesh (and the seg-keyed CPU sampler that physics reads) only expressed it at 17.6m/quad (Gale, 512 seg) / 23.4m/quad (Jezero, 256 seg) — real meter-scale relief smoothed away.
- Below DEM resolution entirely: real regolith has decimeter-scale ripples/clasts no orbital DEM (1–20m/px) can hold; rocks.js scattered them visually but they never perturbed ground contact.

## Phase A — use the real data harder (sites.js)

Segment raise, measured on the weakest target GPU (this box's Intel HSW GT1, headless Chrome, interleaved best-of-rounds):

| Gale seg | ms/frame | quad |
|---|---|---|
| 512 (old) | 25.6 | 17.6m |
| **640 (new)** | **28.4** | **14.1m** |
| 768 | 35.3 | 11.7m |

640 is the knee — 768 costs ~10ms for little visible gain. Jezero 256→384 (23.4→15.6m quads) is noise-level on frame time (its terrain is far under budget). Mobile segments unchanged (192/128).

Note: physics sampling fidelity is capped by mesh density on purpose — the CPU sampler mirrors the rendered vertex grid (terrain.js "no-sinking" invariant), so raising `segments` is what feeds physics more real detail. A finer-than-mesh sampler would put units below the drawn triangles in concave spots.

## Phase B — sub-DEM micro-relief (terrain.js)

New `sampleGroundHeight`/`sampleGroundNormal` + exported `micro` params:

- Two-octave smoothstep-faded value noise (wavelengths 2.6m / 0.9m), deterministic (rocks.js-style imul hash, site-salted), **strictly additive 0..0.18m** — units always ride ON or ABOVE the rendered mesh, preserving the no-sinking invariant.
- **Physics-only, never rendered.** Only rover.js + humanoid.js ground contact use the ground samplers (ride height, tilt normal at eps 0.6m). Drone AGL, camera ground-clamp, rock/marker/lab placement, and ELEV telemetry all stay on the smooth DEM samplers — areoid-relative ELEV never carries invented bumps.
- HUD SLOPE now reports the ground-contact slope for ground units (IMU-style — what the wheels feel), smooth DEM slope for drones (main.js telemetry block).
- Tunable live via `window.__mc.terrain.micro` (amp/wl1/wl2).
- Boulder-footprint taper was considered and dropped: bumps ≤0.18m don't fight the collision radius, and it would create a rocks↔terrain circular dependency.

`SLOPE_K` retuning turned out unnecessary: worst-case micro slope costs ~10% speed on the rover (desired texture), negligible on the humanoid.

## Phase C — procedural wheel movement (wheels.js, same session)

The rover GLB is one fused Tripo mesh (single node, zero animations — verified in the GLB JSON chunk), so baked wheels can't spin and re-export stays blocked on this machine. `wheels.js` is the rotors.js idiom applied to wheels:

- **Overlay wheels enclose the baked ones**: lugged tread ring (12 cleats), 3-spoke hub cap on the outer face, sized ~5% over the measured baked-wheel extents so the static bake hides inside.
- **Layout measured, not guessed**: the loaded, normalized model's vertices were clustered in group space (browser-side, via `__mc`). Six hubs: front pair z≈-1.14, mid z≈0.18, rear z≈1.07. First attempt used the wheels' vertical extent for radius and the baked rims poked out — the bake merges wheel tops into arms/fenders, so the fore-aft extent (rZ) is the true radius. Values hardcoded in `WHEELS_GLB` (group-local meters).
- **Motion**: spin ω = signed ground speed / wheel radius (reverse rolls backward); front pair steers with input, rear pair counter-steers at 60% (real Curiosity 4-wheel steer), mid fixed; speed-faded blur discs past ~8 rad/s so G2/G3 speeds read as motion, not strobing.
- The procedural fallback chassis lost its static wheels — the rig serves both fallback and GLB (`layout()` re-runs from the onReady callback since `attachUnitModel` clears the group).
- **Perf**: +126 draw calls, measured zero frame-time cost (28.7→28.5 ms, GPU-fill-bound on the HSW GT1) — no geometry merging needed.

## Verified

Headless Chrome (channel='chrome') against `window.__mc`, both sites: segment counts render, micro-relief delta ∈ [0, amp] and deterministic, ground normal rougher than smooth (Gale mean 5.08°→5.48°, Jezero 4.05°→4.44°), 10s rover drive shows varying tilt (spread ~0.06 quat) + height travel, HUD SLOPE live, no page JS errors.

Wheels: 6 overlay wheels present, 2s forward drive rolls +43 rad (matches ω=v/r at G2), steer yaws front +0.45 / mid 0 / rear -0.27 rad, reverse rolls negative; screenshots from side/rear/low confirm overlays fully enclose the baked wheels (no poke-through) and read as the rover's real wheels.
