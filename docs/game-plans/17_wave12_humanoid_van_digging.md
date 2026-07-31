# 17 — Wave 12: Humanoid embodiment, the mobile van, digging, recon work

**Goal:** the humanoid and the recon drone go idle the moment the tutorial and survey
missions are cleared — both only do things the rover already does, or a one-off errand.
This wave gives each a permanent job, and makes the humanoid *feel* like a real machine
walking on real ground (the Unitree/Optimus read) rather than a walk-cycle floating over
a mesh.

**Resequencing note (2026-07-17):** this jumps ahead of Wave 5 (terrain LOD) and Wave 2
(site expansion), which `05_mars_colony_phase_next.md` had as next. Same rationale that
pulled Waves 3/4/6/7 forward: everything here is **unit-layer and entirely
site-independent**, so every site added in Wave 2 inherits it for free — whereas doing
Wave 2 first would mean replicating an unfinished unit layer across 7 sites. Wave 5 → Wave 2
stay next-after; Wave 13 (mobile app, scoped at the end of this doc) makes Wave 5 *more*
valuable, not less.

---

## Rig discovery (done 2026-07-17 — this is what makes items 1-3 cheap)

Parsed straight out of `assets/models/humanoid.glb`'s JSON chunk. The Tripo export ships a
**41-joint `Armature` skin and ZERO animation clips** (which is why `humanoid.js` drives the
bones by hand). Verified hierarchy:

```
Armature > Root > Hip > Pelvis > L_Thigh > L_Calf > L_Foot > L_ToeBase
Armature > Root > Hip > Waist  > Spine01 > Spine02 > NeckTwist01 > NeckTwist02 > Head
```

Rest-pose limb lengths (raw GLB units, **pre** `models.js` `size: 2.6` scale — the IK solves
in rig-local space, so the scale is transparent):

| Segment | Bone hop | Length |
|---|---|---|
| Femur | `L_Thigh → L_Calf` | 0.208 |
| Tibia | `L_Calf → L_Foot` | 0.259 |
| Foot | `L_Foot → L_ToeBase` | 0.039 |

Also present and currently **unused**: `Pelvis`, `Waist`, `Spine01/02`, `Head`, both `Foot`s,
both `ToeBase`s, and the full `*Twist01/02` set. Today's `WALK_BONES` drives only 8 of the 41
(`L/R_Thigh`, `L/R_Calf`, `L/R_Upperarm`, `L/R_Forearm`). Everything below is unlocked by
bones that already exist — no re-rig, no new asset.

---

## 1. Humanoid slope tilt — do first

**Current:** `humanoid.js:141` — `mesh.rotation.y = heading` is the *entire* orientation.
The body ignores terrain completely: it stands bolt-upright on a 30° slope.

**The design call — a walker is NOT a rover.** The obvious move is to copy `rover.js`'s
`_tiltQuat.setFromUnitVectors(_up, normal)` full normal-align. **Don't.** The rover's chassis
is rigidly coupled to its wheels, so the whole body genuinely matches the ground plane. A
biped's torso stays *gravity-vertical* and the legs absorb the grade — a full normal-align on
a steep slope would lay the humanoid face-down into the hill.

Model it as travel-relative pitch + lateral roll instead, from the **same**
`terrain.sampleGroundNormal` the `speedFactor` already samples (no new sampling):

- `pitch = gradeAlongTravel × PITCH_GAIN` (~0.5) — leans into a climb, braces back on a
  descent. This is what real walkers do.
- `roll  = gradeLateral × ROLL_GAIN` (~0.15) — deliberately small; walking across a hill you
  keep your head level, you don't tilt sideways.
- Clamp both to ±0.35 rad so a cliff face can't produce a horizontal robot.
- Airborne (`airY > 0`): decay both toward 0 — no ground coupling during the ~1.8 s Mars hang.

**Implementation:** replace the `rotation.y` assignment with a quaternion compose
(yaw × pitch × roll) + slerp, exactly the rover's `1 - exp(-12·dt)` idiom. ~20 lines.

**Trap to not reintroduce:** stay in quaternion space end-to-end. `rover.js:458` documents
this at length — assigning `mesh.rotation.y` after a tilt re-derives eulers from a tilted
quaternion, and that decomposition is discontinuous: past ~3/4 turn the x/z terms flip by π
and the mesh visibly snaps (the "flicker past 270°" bug).

---

## 2. Realistic walking — the Unitree/Optimus read

Four fixes, ordered by payoff-per-line.

### 2.1 Foot skate — the #1 tell, ~3 lines

`stride += dt * 6` is a **fixed** cadence, but actual walk speed is
`throttle × WALK_SPEED × speedFactor`, where `speedFactor` spans 0.3–1.0 with slope *and*
tether drag. So climbing a steep slope at 30% speed still pumps the legs at 100% cadence —
the feet visibly skate across the ground.

```js
stride += dt * STRIDE_RATE * Math.abs(actualSpeed) / WALK_SPEED;
```

Cadence then falls out of ground speed automatically. Highest realism-per-line change in the
whole wave.

### 2.2 Foot IK + planting — the real "robot on terrain" cue

Two-bone analytic IK per leg (law of cosines over femur 0.208 / tibia 0.259; the knee hinges
on its single bend axis), targeting a foot position sampled from `terrain.sampleGroundHeight`
at **that foot's own x/z** — not the body's.

- **Stance-phase feet are world-locked** — they do not move while bearing weight. That is the
  anti-skate guarantee *mechanically*, rather than by tuning 2.1.
- Swing-phase feet arc to the next plant point.
- Foot pitch aligns to `sampleGroundNormal` at its own spot; `ToeBase` rolls at push-off.

Result: on rubble one boot sits 15 cm above the other and both are flat to their own patch of
ground — precisely the Unitree/Optimus read. This is the big one; give it its own commit.

**Risk (the only real one in the wave):** IK bugs read as broken knees. Mitigate by landing
2.1 + 2.3 first (they stand alone and already look good), then putting 2.2 behind a `useIk`
flag so a bad solve falls back to the swing-only cycle.

### 2.3 Pelvis / spine / head chain — weight, ~30 lines

- `Pelvis` drops ~3 cm at midstance and sways laterally over the stance leg (weight shift).
- `Spine01/02` counter-lean so the torso holds gravity-vertical while the legs eat the grade —
  works *with* item 1: item 1 tilts the whole mesh, the spine gives some of it back.
- `Head` stabilizes to a level gaze.

This is what separates "puppet with swinging limbs" from "a mass balancing over its feet".

### 2.4 Apollo lope — Mars-specific, pure gain

At 0.38 g a normal walking gait is genuinely unstable above ~0.7 m/s; the Apollo crews
spontaneously switched to a two-footed bounding lope. It is the most-cited "this is not
Earth" gait detail in existence, and it is *free*: above a speed threshold, cross-fade the
gait — both feet leave the ground together, longer airborne phase, arms out for balance —
reusing the `airY` / `GRAVITY_MARS` integrator the jump already runs on. No new physics.

### 2.5 Robot reskin (optional, independent)

If the desired read is an Optimus/Unitree-class robot rather than the current figure, that is
a `MODELS.humanoid.url` swap in `models.js` and nothing else — **all** the gait work above
drives *bones*, so it lands identically on any re-rigged humanoid. Verify on export that
Tripo's auto-rig reproduces the same `L_Thigh` / `L_Calf` / `L_Foot` naming (it is consistent
across generations today — that is why `WALK_BONES` works at all — but confirm rather than
assume).

---

## 3. Digging / coring

**What's wrong:** collection is instant walk-up-press-E. No weight, no animation, and nothing
about it says a *humanoid* did it.

**Design:** for `outpost`-flagged samples, E starts a **timed core** instead of an instant
grab. The narrative is already sitting in the data — Rochette's `note` in `sites.js` literally
reads *"First cored sample, Sep 2021"*. The game just never dramatized it.

- `DIG_SECS` ~4.5 s. Progress rides the **existing** banner-percentage idiom — both
  `hud.setHazard({type, pct})` and `setNode`'s `NODE ▸ SAMPLE n%` already render a live
  percentage. Reuse, don't invent.
- **Interruptible:** any throttle input cancels and resets (no partial credit) — which makes
  standing still a deliberate act.
- **Animation:** drive `L_Hand`/`R_Hand` + `Spine01` into a crouch-and-drill pose over the
  dig. The rig has the bones (see discovery above).
- **Dust:** `effects.js` `spawnDust(x, y, z, count)` already exists and is already
  terrain-aware — spawn at the tool point through the dig.
- **Sound:** `sound.js` synthesized-cue pattern — a low drill whine spooling with progress,
  same shape as `sound.update`'s engine norm.
- **The rover keeps instant collect** (it has a real robotic arm; the humanoid is the one
  holding a tool). This also makes the two ground units feel *different* instead of redundant.

**B-item (defer):** genuinely buried samples, no visible marker until dug at a surveyed spot.
That's a new content type, not a reskin — ship the drill first.

---

## 4. Mobile van — humanoid-driven mobile base

**Identity, and this is the whole point: the van is NOT rover-2.**

| | Rover | Van |
|---|---|---|
| Role | science scout | logistics / support |
| Speed | fast | slow, torquey (climbs what the rover can't) |
| Crew | solo | **carries the android — and only the android can drive it** |
| Collect | instant arm | — |
| Special | fragile | **deploys as a mobile base**; tether anchor |

Only the humanoid can drive it. That is what finally makes the humanoid **load-bearing**
rather than a spare body — it answers "lying idle" structurally, instead of with more errands.

### 4.1 New unit `van.js`

Forked from `rover.js`'s structure (same terrain-follow, same gravity integrator, same
collider facade, same gear/inertia idioms), retuned: lower top speed, gentler `SLOPE_K` +
higher `MIN_SPEED_FACTOR` (torque), bigger `BODY_RADIUS` (~2.2), higher hull, heavier
`drainRate`. Registers in `colliders` like every other unit.

### 4.2 Mount / dismount

- Humanoid within `MOUNT_R` (~4 m) + E → humanoid **stowed** (mesh hidden, sim skipped),
  active unit becomes the van.
- E again → humanoid reappears at the van's side via `teleport()` (terrain+deck grounded —
  bare position writes arrive mid-fall, the documented Wave 9 trap), active unit becomes the
  humanoid.
- `units[]` in `main.js` is fixed at boot: add the van as a 5th entry, and have `switchUnit()`
  **skip stowed units** (the `(activeIndex + 1) % units.length` walk gains a stowed guard).
  The van is unselectable while driverless.
- **A driverless van does not move.** No driver, no drive — diegetic, and it's what forces the
  pairing.

### 4.3 Deploy = mobile base (the payoff)

Parked + deployed (legs down, panels out; ~2 s animation reusing outposts' `scale.y` ease-in
idiom) → the van registers a chargepad-equivalent at its own position. `chargepads.addPad(x, z)`
already exists and `padAt()` is a pure distance test, so **docking, charging and repair come
free** — in the field, anywhere. Undeploy removes it.

Also: register the van as a `colliders.addDeck` drivable roof, and add it to the tether-anchor
list in `main.js` (currently rover-or-chargepad; the van is the natural third).

This makes the van a *decision*: drive 2 km out, deploy, and the whole fleet has a field base —
instead of everything orbiting the FIELD LAB forever.

### 4.4 Cargo bay (B-item, defer)

Van carries cache containers as a ground alternative to the lift drone. Real value, but it
competes with the sling loop for the same job. Ship the mobile base first.

**Asset:** `van.glb` via Tripo — ~5.5 m, 6-wheel pressurized-rover silhouette (NASA's real
SEV/MMSEV is exactly this vehicle). Procedural box fallback per the fallback-first idiom.

---

## 5. Recon drone

**What's wrong:** exactly ONE survey zone exists (`sites.js` `surveyZone`), it's consumed once
by the survey mission, and then the recon has no job forever.

### 5.1 Multi-zone survey

`surveyZone` → `surveyZones[]`, 3-4 per site. `fog.revealedFraction(cx, cz, r)` already
generalizes, the `survey` step type already takes a scalar target, and the minimap ring layer
already renders one — all three just need to loop. **The content already exists:** Jezero's
`[SIM]` samples are already written as recon-flavoured survey targets — Relay Ridge (*"clear
line of sight across the site"*), Dust Devil Flats (*"fresh dust-devil tracks"*), Neretva
Vallis. They're just not wired to zones.

### 5.2 Hazard early-warning — the recon's standing job

`dustDevils.js` already tracks live vortex positions, `weather.js` already runs a storm
timeline, and the minimap currently draws devils **unconditionally**. Gate that on recon
scouting: devils and the storm front only appear on the map once the recon has flown within
`SCAN_R` of them, and they fade after N sols.

Suddenly the recon has a permanent purpose — fly ahead of the ground fleet and see what's
coming — and it turns the Wave 6 hazards into something you play *around* rather than just
suffer.

### 5.3 Route spotter (falls out of 5.2 free)

With the van deployed far afield, the recon is the natural way to scout the route out. No new
code beyond 5.2.

**B-item:** drone FOV / sensor cone (the deferred Wave 4 idea) — real raycasting, new
subsystem. 5.2 gets ~80% of the value at ~5% of the cost by reusing fog reveal.

---

## 6. Sequencing & sizing

| # | Item | New modules | ~Lines | GLB | Risk |
|---|---|---|---|---|---|
| 1 | Slope tilt | 0 | ~20 | — | Low |
| 2.1 | Foot skate | 0 | ~3 | — | Low |
| 2.3 | Pelvis/spine/head | 0 | ~30 | — | Low |
| 3 | Digging | 0 | ~70 | — | Low |
| 2.2 | Foot IK | 0 | ~120 | — | **Medium** |
| 2.4 | Apollo lope | 0 | ~40 | — | Low |
| 5.1 | Multi-zone survey | 0 | ~60 | — | Low |
| 5.2 | Hazard early-warning | 0 | ~50 | — | Low |
| 4 | Mobile van | `van.js` | ~350 | `van.glb` | Medium |

**Build order:** 1 → 2.1 → 2.3 → 3 → 2.2 → 2.4 → 5.1 → 5.2 → 4

**Rationale:** tilt/skate/pelvis are tiny and *compound* — each makes the next more visible.
Digging is self-contained and reuses existing dust/sound/percentage plumbing. Foot IK is the
biggest risk, so land it once the gait is already good (it's an upgrade, not a rescue). The
van is the biggest new surface — last, so it inherits a finished humanoid to put in the
driver's seat.

Commit locally per todo item (resume-checkpoint convention); push only when asked.

---

## 7. Tripo assets needed

| Model key | For | Footprint | Priority |
|---|---|---|---|
| `van.glb` | Mobile van | ~5.5 m, 6-wheel pressurized rover | High — item 4 blocks on it |
| `humanoid.glb` (reskin) | Optimus/Unitree-class robot | ~2.6 m | Optional (2.5) — must re-rig with same bone names |

Both ride the existing `MODELS` / `attachUnitModel` pipeline. Generate **after** the code is
merged, not before (the fallback-first idiom means nothing blocks on the asset) — and note the
2026-07-17 lesson: constants sized to procedural fallbacks *break* the moment a real GLB swaps
in. Re-measure placement/collision constants when `van.glb` lands.

---

## 8. E2E verification

Per `.claude/rules/testing.md` + the `verify` skill. Key assertions:

- **Tilt:** pitch/roll magnitudes on a known steep patch vs flat (scan `sampleGroundNormal` on
  a grid — Jezero's steepest ≈ 0.16 slopeMag ≈ 32°, per the verify skill's measured
  reference). Explicitly assert **no euler flip past 270° heading**.
- **Skate:** foot world-position delta during stance ≈ 0 across a fixed frame count at 30%
  `speedFactor`.
- **IK:** knee angle within joint limits; foot y == `sampleGroundHeight` at that foot's own
  x/z ±2 cm.
- **Dig:** `DIG_SECS` elapsed → collected; interrupt at 50% → *not* collected, progress reset.
- **Van:** driverless van doesn't move under throttle; mount hides the humanoid; dismount
  grounds it (not mid-fall); deploy → `padAt()` true at the van's position → another unit
  charges there.
- **Recon:** each zone advances independently; a devil stays hidden until the recon is within
  `SCAN_R`.

Box gotchas (all documented in the verify skill, all previously cost real debug rounds): poll
via `evaluate` not `wait_for_function`; **cache-bust the URL**; kill stray chrome first;
W = throttle **−1**; `teleport()` then settle with zero-input updates before measuring.

---

## Wave 13 — mobile app (forward scope, NOT this wave)

**The good news: this is packaging, not a rewrite.** The game is already mobile-first —
Wave 10.1 landscape-first + rotate prompt + opportunistic orientation lock, touch joysticks
(`touch.js`), `isTouchDevice()` gating, per-site mobile mesh density (`segments.mobile`),
mobile HUD homes.

Three paths, cheapest first:

1. **PWA** — manifest + service worker + offline cache. No store, no wrapper, installs to the
   home screen; closest to the repo's no-build/no-backend grain. The real work is the cache
   strategy: each site pulls ~20 MB of GLBs + heightmap + albedo, so it needs a versioned
   precache of the shell plus a lazy per-site cache.
2. **Capacitor wrapper** — the PWA in a native shell for App Store / Play presence. Assets
   bundle or first-run download. **Adds a build step and a package manager to a repo that
   deliberately has neither** — that's a real architectural decision, not a detail.
3. **Flutter WebView** — only if the existing companion app is the intended host.

**Hard prerequisite for any offline story:** Three.js currently loads from a **CDN import
map**. Offline requires self-hosting it — the same trap `game-v2` already solved by
self-hosting its Babylon/Three deps. Do this first regardless of path.

**Also worth flagging:** Wave 5 (terrain LOD) pays off more on a phone than anywhere else.
Sequencing mobile behind it is worth considering.

**Decide 1 vs 2 explicitly before starting** — store presence? true offline? monetization?
That's a scoping conversation, not a plan detail.
