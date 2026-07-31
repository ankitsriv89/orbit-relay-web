# Wave 6 — Hazard Consequences & Drone Wind (Jezero-first)

Approved 2026-07-12. Grounded against the actual code (weather.js / drone.js / rover.js / hazardZones.js) and against real mission data (research pass, sources below). Design decisions locked with the user:

- **Wind feel: grounded exaggeration.** Real phenomena (MEDA storm timing/magnitudes, dust-devil frequency, Ingenuity counter-steer) with the *force on drones* scaled up to be felt — same deliberate choice as the ~20% unit-scale bump. Calm weather = zero drift. Real m/s numbers shown on the HUD.
- **Rollover recovery: any unit nearby assists + self-recovery by rocking the wheels** (alternating throttle pulses build righting momentum).
- **Dust devils: in scope for this wave.**

## Real-data grounding (research 2026-07-12)

| Fact | Source | Game use |
|---|---|---|
| Jezero storm winds hit 20 m/s (Jan 2022, damaged MEDA's wind sensor) | Perseverance MEDA | Storm wind peak = `intensity × 20 m/s` |
| Typical daily Jezero winds: gentle, few m/s | MEDA first-250-sols | Calm = below drift threshold → no effect |
| ~4 convective vortices/day pass the rover; >1/hour just after noon; >25% dusty | MEDA vortex stats | Dust-devil spawn timer, daylight-biased, noon-peaked (game-compressed) |
| Dust devils 5–500 m diameter, rotational winds 3–30 m/s | MEDA + HiRISE | Column visual 10–30 m; vortex wind up to 30 m/s injected locally |
| Ingenuity held position by tilting INTO the wind; flew in 4–8 m/s, later measured up to 25 m/s | Ingenuity flight data | Player counter-steer IS the real control law; validates the mechanic |
| Mars air ≈ 1/100 Earth density → 20 m/s Mars ≈ 2 m/s Earth push; The-Martian-style rover-toppling is fiction | NASA fact-and-fiction | Rovers immune to wind force (keep existing storm *drag* only); drone force exaggerated deliberately (`WIND_PUSH`) |
| Rover tilt: 45° hardware tip-over, 30° ops/fault-protection cap, 31–32° all-time records | MER/MSL/M2020 ops | Existing `ROLL_MAX` 0.18 slopeMag ≈ 35° confirmed correct — between ops limit and hardware limit |
| Spirit at Troy (2009): low-cohesion sulfate sand under a normal-looking veneer; escape throttling buried the wheels deeper; never freed | MER mission logs | Bogged state: plain throttle digs DEEPER; rocking technique escapes; tow rescue is the counterfactual |

## Build pieces (order)

### 6.1 Storm wind vector — weather.js + drone.js + hud.js
- weather.js: `windDir` (radians, random init, slow wander ~0.02 rad/s), `windSpeed = intensity × WIND_PEAK(20)` × gust factor (low-freq noise 0.7–1.3). Exposed as `windX/windZ` getters (m/s, world plane). Zero when idle.
- main.js: builds a `wind.sample(x, z)` facade = storm wind + dust-devil vortices (colliders.forUnit idiom — no new module for an aggregator).
- drone.js: optional `wind` param; when airborne, position integrates `(vel + wind × WIND_PUSH) × dt`. `WIND_PUSH = 0.35` — the one deliberately unreal constant, documented in-code. Landed = no effect. Tilt already follows velocity error, so drift reads visually and the player counter-tilts like Ingenuity.
- hud.js: wind needle + m/s readout docked on the existing `#mc-compass` dial (10 Hz update, same no-CSS-transition rule as the compass needle — wrap-around).

### 6.2 Dust devils — new dustDevils.js
- Spawn: every 3–6 min game time, gated on `env.daylight()` (none at night), doubled rate in the post-noon window. 1–2 alive max (perf).
- Entity: wandering column (~2–4 m/s ground speed, slow heading wander), lifetime 60–120 s, THREE.Points particle column (effects.js dust idiom, one shared pool), 10–30 m diameter, height ~80–150 m.
- Wind injection: `sampleWind(x, z)` — tangential vortex up to 30 m/s inside the radius (falloff to rim), feeds the main.js wind facade. Drone inside = strong swirl + jitter. Rover inside = dust burst + slight camera shake only (real: no force).
- Minimap: small swirl marker via fog.js `extras` bag (above fog).

### 6.3 Bump & jump + physical rollover — rover.js + rocks.js
- Suspension bounce: track `d(groundY)/dt`; damped spring on a visual chassis y-offset + small pitch jitter, scaled by |speed|. The existing physics-only micro-relief (terrain.js `micro`) finally becomes visible ride feel. No new module (inertia precedent).
- Decorative pebbles: small instanced tetra scatter added in rocks.js (no colliders — the micro-relief IS their physics).
- Roughness → risk: at speed, ground-delta transients add spikes to `rolloverRisk` (fast over rough ground is genuinely dangerous).
- Flip: `rolloverRisk ≥ 0.97` while `|speed| ≥ ROLL_SPEED_MIN` held ROLL_HOLD_S (~0.6 s) → rollover state: controls locked, chassis animates 90° onto its side (~0.8 s), battery penalty (−8%), HUD `ROLLOVER` banner (boundary-banner idiom), synth alarm cue.
- Righting: (a) rocking — alternating throttle sign pulses build a righting meter (each swing animates a rock; full meter rights it, ~6–10 good pulses); (b) assisted — ANY other unit within ASSIST_RANGE (8 m) holds E → rights in 3 s (sling `E`-idiom). E2E hooks: state + meter exposed on the rover handle.

### 6.4 Bogged-down + escape — rover.js
- Bog meter 0..1: fills while driving in `inHazard.effect ≥ 0.55` (rate ∝ effect × |throttle|), drains slowly outside. Full → `bogged` state: speed target forced 0, wheels churn at max slip (wheels.js already takes `slip`).
- Escape (Spirit lesson): plain sustained throttle RAISES the meter's depth (digs in, slower escape); alternating rock pulses lower it; another unit within TOW_RANGE holding E tows it out in ~4 s with the sling-cable visual as winch line.
- HUD `BOGGED DOWN` banner + churn cue.

### 6.5 Sound + polish
- sound.js: wind-bed gain rides max(storm wind, nearby vortex) — the bed already exists; flip alarm, bog-churn, righting-success cues (synth, asset-free).
- Missions regression: tutorial drive step is near spawn on firm ground — no gating needed; verify in E2E.

### E2E (verify skill patterns)
- Storm wind: `__mc.weather.forceStorm()` → measure drone drift with zero input ≠ 0 and ≈ windVec × WIND_PUSH; landed drone drift = 0; HUD readout shows m/s.
- Dust devil: force-spawn hook (`__mc.dustDevils.force(x,z)`), fly drone through, assert lateral kick; rover through = no velocity change.
- Rollover: drive fast onto steep delta-front slope (or force-set risk via debug), assert flip → locked controls → rocking pulses right it; assist path with humanoid.
- Bog: park in Séítah zone, throttle until bogged; assert plain throttle deepens, rocking escapes; tow path.
- Regression: full missions/tutorial chain still green.

## Sources
- NASA "The Fact and Fiction of Martian Dust Storms" — 60 mph storm cap, 1/100 atmosphere
- MEDA / Perseverance Jezero meteorology (Nature Geoscience 2023; Science Advances abn3783) — vortex counts, 20 m/s storm, sensor damage
- Ingenuity flight-control reports + arXiv 2410.19132 — tilt-into-wind, 4–25 m/s winds, Mach-0.7 gust margin
- MER mission logs: Spirit at Troy (2009) embedding; 30° ops tilt limits, 31–32° records; 45° structural
