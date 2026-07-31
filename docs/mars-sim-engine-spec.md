# Mars Sim Engine — Portable Reproduction Spec

**Purpose of this document:** this is a spec, not a code dump. Each section below describes a
subsystem of the Mars Sim engine (`public/mars-colony/`) well enough — purpose, core
data/algorithm shape, and what changes per celestial body — that someone (or an AI coding
agent) could rebuild it **from scratch, on any machine, without access to this repo's
source**, for a new body (Moon, Mercury, Vesta, Ceres, ...). Each section ends with a
standalone **reproduction prompt**: a self-contained instruction block you can hand to a
coding agent cold. See [`docs/game-plans/08_multi_planet_colony_roadmap.md`](game-plans/08_multi_planet_colony_roadmap.md)
for which bodies are next and why, and [`docs/game-plans/31_engine_spec_and_roadmap_update.md`](game-plans/31_engine_spec_and_roadmap_update.md)
for why this doc exists.

Stack assumption throughout: vanilla JS + Three.js, no build step, no framework, no backend
required for the core game loop (cloud save and telemetry are optional, backend-adjacent
add-ons, covered separately below).

---

## 1. Boot / site config pattern

**Purpose:** let one engine serve multiple named landing sites (and, by extension, multiple
bodies) without a plugin system.

**Shape:** a single `sites.js` module exports one config object per site: DEM heightmap URL,
orthophoto URL, world-scale (meters/pixel), spawn point, real lon/lat center (for hub-map
pin placement), a list of real named sample locations (each with lon/lat or local
coordinates), hazard-zone definitions, and a `playable: true|false` flag. `main.js` reads
`?site=` from the URL (or a persisted last-site key) and boots that config; if no valid site
exists, it throws a clear, loud error rather than silently falling back to whatever site
happens to be first in the object — this is deliberate (see Moon's current empty `SITES`).

**Varies per body:** every field in the site config; also two body-level constants living
alongside the site table — `M_PER_DEG` (meters per degree of latitude, i.e. the body's radius)
and `SOL_MS` (real length of one day/rotation) — used by the mission clock and hub-globe math.

**Reproduction prompt:**
> "Build a `sites.js` module exporting a `SITES` object keyed by site id, each entry holding:
> heightmap URL, orthophoto URL, meters-per-pixel world scale, spawn coordinates, real
> lon/lat center, an array of named sample locations, hazard-zone polygons, and a `playable`
> boolean. Export two body-level constants: meters-per-degree-latitude (body radius) and
> synodic-day-length-ms. Boot logic reads a `?site=` query param or a persisted last-site
> value; if the resolved site is missing or `SITES` is empty, throw an explicit, readable
> error instead of falling back to an arbitrary default."

---

## 2. Terrain + environment

**Purpose:** render real DEM elevation data as a walkable/driveable 3D terrain with
decoupled render cost, plus a sky/lighting setup that matches the body's atmosphere.

**Shape:** a heightmap (grayscale PNG or GeoTIFF-derived raster) drives a GPU **geometry
clipmap** — concentric rings of terrain mesh at decreasing resolution outward from the active
unit, so render cost stays roughly constant regardless of total world size (this replaced an
earlier flat-high-res mesh once world sizes grew — see Wave 5 LOD). A separate CPU-side height
sampler (bilinear-interpolated lookup into the same raster) answers physics queries (ground
height under a unit) without touching the GPU mesh. Environment is a sky dome + directional
sun light + optional `FogExp2` haze, with day/night driven by a compressed "sol" cycle
(`CYCLE_S` = real-time seconds per in-game day, deliberately compressed from a real ~24.6h sol
so players see day/night cycle).

**Varies per body:** heightmap/ortho source and resolution; presence/density of atmosphere
(haze density, sky color gradient, sun halo on/off); `CYCLE_S`; rock/debris field density and
color grading to match surface albedo.

**Reproduction prompt:**
> "Build a terrain renderer that loads a heightmap + orthophoto texture pair and displays it
> as a GPU geometry-climap: concentric LOD rings around the active unit's position, each ring
> coarser than the last, so render cost is decoupled from total world size. Separately expose
> a CPU height-sampler function (bilinear interpolation into the same heightmap raster) for
> physics/placement queries. Add a sky dome + directional sun + optional exponential fog,
> parameterized by: atmosphere density (0 for airless bodies), sun color/intensity, and a
> compressed day/night cycle length in real seconds."

---

## 3. Physics

**Purpose:** one shared gravity constant driving every vertical-motion integrator (drone
free-fall, humanoid jump arcs, rover airtime/cliff-fall, walker-rig fall recovery).

**Shape:** a single exported constant (Mars: 3.72 m/s²) consumed by every module doing
vertical integration — deliberately centralized so a body swap is a one-line change, not a
grep-and-replace across units.

**Varies per body:** the gravity constant itself (Moon ≈1.62, Mercury ≈3.7, Vesta ≈0.25,
Ceres ≈0.27 m/s² — order-of-magnitude differences change *game feel*, not just numbers: low-g
bodies need real playtest tuning of jump height, fall damage thresholds, and vehicle airtime,
not just a constant swap).

**Reproduction prompt:**
> "Export a single gravity constant (m/s²) from one module. Every subsystem doing vertical
> physics integration (flight units' free-fall, on-foot jump arcs, ground vehicles' airtime
> and cliff-fall, legged-walker recovery) imports this same constant — never hardcode gravity
> locally in a unit file. Document that changing this constant for a new body requires a
> manual playtest pass, not just a value swap, especially for low-gravity bodies where jump
> height and vehicle airtime become qualitatively different game feel."

---

## 4. Hazards & weather

**Purpose:** environmental danger and variety beyond static terrain — storms, localized
vortices, soft/graded terrain hazards, and a vehicle condition/damage state machine.

**Shape:** a scalar "storm intensity" timeline drives fog density, solar-charging penalty, and
a wind vector that displaces flight units (ground units are wind-immune by design — keeps
driving predictable while flying feels weather-exposed). Separately, wandering "dust devil"
vortex objects move across the terrain on a randomized path, grounded in the body's real
meteorological data where available (Mars uses real MEDA instrument statistics for frequency/
intensity). Hazard zones are graded-effect polygons (e.g. soft sand slows and can bog a
vehicle) distinct from binary obstacle colliders. A vehicle condition state machine
(ok → rolled → bogged, etc.) tracks cumulative hazard exposure with a rocking/effort-based
recovery mechanic rather than an instant reset.

**Varies per body:** whether weather exists at all (airless bodies like the Moon have no wind/
dust storms — this layer may be entirely absent); real meteorological data source if
available; hazard zone types relevant to the terrain (Mars: soft sand dunes; a differently
composed regolith might need a different hazard type).

**Reproduction prompt:**
> "Build a storm-intensity scalar that animates over time (calm → building → peak → clearing)
> and drives: fog density, a solar-power penalty, and a wind vector applied only to
> flight-capable units (ground vehicles stay wind-immune). Add independently-wandering vortex
> hazard objects with randomized paths. Add graded (non-binary) hazard-zone polygons that
> apply a movement/traction penalty distinct from hard obstacle collision. Add a vehicle
> condition state machine (nominal → degraded states) driven by cumulative hazard exposure,
> with an effort-based recovery action rather than instant reset. For airless/atmosphere-less
> bodies, this entire subsystem may be scoped out — check whether the body has weather before
> building it."

---

## 5. Ground & aerial vehicles

**Purpose:** a driveable rover/base-vehicle and a flyable drone, both terrain-aware.

**Shape:** ground vehicles (rover, van) use throttle/steer input, terrain-follow height
sampling (subsystem 2) plus a slope-tilt visual, and a "ride over small obstacles" facade
(separate climb-radius/probe-radius parameters) so they don't get stuck on every pebble.
Wheels are a procedurally-spinning overlay mesh (the vehicle body GLB is one fused mesh with
no animation rig, so wheel spin is faked geometrically, not via skeletal animation). Flight
units use tilt-driven physics (pitch/roll toward a target velocity vector) with gravity
free-fall on power loss (subsystem 3), plus a procedurally-spinning rotor overlay for the same
fused-mesh reason.

**Varies per body:** slope-handling constant (steeper effective traction needed on
lower-friction/lower-gravity surfaces — treat as an unverified estimate requiring playtest,
not a formula); top speed/torque (real reference vehicle data if available, e.g. Apollo LRV
figures for the Moon); flight unit hover/climb constants (untuned for any non-Mars body yet).

**Reproduction prompt:**
> "Build a ground vehicle controller: throttle/steer input, terrain-height-follow with visual
> slope tilt, and a small-obstacle ride-over facade (a climb radius and probe radius, so minor
> terrain bumps don't block movement). Represent wheel rotation as a procedural spinning
> overlay mesh, not skeletal animation, since the vehicle model is a single fused mesh. Build
> a flight unit controller: tilt-driven physics toward a target velocity, gravity free-fall
> integration on power loss, procedural spinning-rotor overlay. Expose a slope-traction
> constant and flight hover/climb constants as named, clearly-flagged-as-unverified parameters
> requiring playtest tuning per body."

---

## 6. Legged locomotion (`walker-rig.js`) — the portable centerpiece

**Purpose:** a shared N-legged procedural walking engine, currently powering two distinct unit
types (a quadruped and an octopod) from one rig implementation — the single most reusable
subsystem for any future body with legged units.

**Shape:** each leg is a procedural chain of Object3D nodes (not a skinned/rigged GLB
skeleton). Foot placement uses **two-bone analytic IK** (upper segment + lower segment solved
geometrically for a target foot position, optionally with a coxa/yaw joint for legs that
splay outward from the body, like a quadruped's vs. an octopod's wider stance). A gait
controller cycles leg phase offsets (e.g. alternating tetrapod gait for 8 legs, diagonal gait
for 4) so the body doesn't look like it's sliding. The body root tilts to conform to local
terrain slope (sampled per-foot via subsystem 2's height sampler) so the walker looks
grounded on uneven ground, not floating a fixed height above a flat plane. The same rig
exposes a hook for **beat-synced pose overrides** (used by the dance-move system, subsystem
10) — i.e. the gait state machine can be temporarily preempted by an externally-driven pose
without fighting the IK solver.

**Known past bugs worth avoiding when reproducing:** a 180°-flip hip-angle bug from solving IK
with an ambiguous elbow/knee-bend direction (always pick the bend direction consistent with
the leg's natural resting pose, don't let the geometric solve pick arbitrarily); a
world-vs-local-space quaternion mixup when applying terrain-tilt on top of a pose override
(always compose rotations in a single consistent space, don't multiply a world-space terrain
quaternion into a pose defined in local space); an accumulator bug in terrain-tilt smoothing
(don't re-integrate a delta onto itself every frame — smooth toward the raw sampled tilt value
each frame, don't accumulate a running offset).

**Varies per body:** leg count and gait pattern per unit type (defined once per unit, not per
body); terrain-tilt behavior is gravity/body-agnostic (works from height-sampling alone); no
body-specific constants beyond whatever slope-traction estimate is shared with subsystem 5.

**Reproduction prompt:**
> "Build a reusable N-legged walker rig: each leg is a procedural 2-3 joint chain (not a
> skinned mesh skeleton), solved with two-bone analytic IK toward a target foot-placement
> point, with an optional yaw joint for legs that splay from the body at an angle. Add a gait
> controller that assigns phase offsets per leg for a chosen gait pattern (alternating-tetrapod
> for many-legged, diagonal for four-legged), lifting and placing each foot in a cycle rather
> than sliding. Sample terrain height/slope under each foot and tilt the body root to conform
> to local ground slope, smoothing toward the raw sampled value each frame (do not accumulate
> a running delta — recompute from scratch and lerp toward it). Always resolve the IK
> bend/elbow direction consistently with the leg's rest pose, never let the geometric solve
> pick an ambiguous direction. Expose a hook to temporarily override the gait's leg-target
> poses from an external driver (for a future beat-synced animation feature) without breaking
> the terrain-conforming tilt, keeping all pose composition in one consistent transform space
> (don't mix world-space and local-space quaternions when combining a pose override with
> terrain tilt)."

---

## 7. Sample-collection, missions, and derived base-building

**Purpose:** the core objective loop — find/collect real named samples, analyze them, and let
a base grow visually as a *side effect* of that progress rather than a separately-tracked
system.

**Shape:** sample markers exist at real named locations from the site config (subsystem 1);
proximity-based collection adds to an inventory; a "field lab" analysis queue simulates
processing time and appends results to a persistent science archive. A generalized mission
system defines per-site step chains (originally a single hardcoded tutorial, generalized into
typed objective steps: reach location, collect N samples, analyze a sample, etc.) so new
sites need only a new step-chain definition, not new mission code. Base-building
(checkposts, then a capstone HQ structure once all missions complete) is **pure derivation**
from existing save state (which samples are analyzed + which missions are done) — there is no
separate "base save" to keep in sync; the base literally recomputes what should exist every
time from the same state the mission/sample systems already persist.

**Varies per body:** the real named sample locations and their narrative framing (only
content, no engine change); nothing structural — this subsystem is essentially body-agnostic
once subsystem 1's site config is filled in.

**Reproduction prompt:**
> "Build sample markers at named locations (from the site config), with proximity-based
> collection into an inventory. Build an analysis queue that simulates processing delay and
> writes results into a persistent per-site archive. Build a generalized mission system: typed
> objective steps (go-to, collect-N, analyze-one, etc.) chained per site, so a new site needs
> only a new step-chain, not new mission code. Build base-structure visuals (waypoint markers,
> then a capstone structure) that are **pure derivations** computed from existing
> sample/mission save state every load — do not create a separate save format for base
> progress; if it can be recomputed from state you already persist, recompute it, don't store
> it twice."

---

## 8. Site-hub / globe picker + saves + cloud sync

**Purpose:** a first-scene 3D globe showing every site as a real-lon/lat pin, letting players
pick a site, with per-site-isolated save data and optional cross-device cloud sync.

**Shape:** a short-lived Three.js scene (disposed before the main game boots — one WebGL
context alive at a time) renders a textured sphere using the body's real equirectangular
color map, with pins placed via lon/lat → unit-sphere xyz conversion. Playable sites (assets
present) render as bright interactive pins showing a progress summary read from that site's
save namespace; sites without assets render as dim "LOCKED · COMING SOON" pins, driven by the
`playable` flag from subsystem 1 — never by "is in the site list" alone, since a site can be
listed as a locked placeholder before assets exist. Clicking a playable pin flies the camera
toward it, fades out, tears down the hub scene, then hands off to the main game boot for that
site. Saves are namespaced per-site (`<prefix>-<siteId>-<key>`) so multiple sites never bleed
progress into each other; a small set of genuinely global keys (control bindings, audio
prefs) stay unnamespaced on purpose. Optional cloud sync uses the player's own cloud-drive
account (last-write-wins merge, no backend server, no shared credentials) — purely additive,
the game is fully playable without it.

**Varies per body:** the globe texture (real equirectangular map for that body) and pin
coordinates; nothing else — this subsystem is written once and reused as-is across bodies,
provided each body's `sites.js` supplies real lon/lat and a `playable` flag.

**Reproduction prompt:**
> "Build a short-lived 3D globe scene: a textured sphere using a body's real equirectangular
> color map, with pins placed via lon/lat-to-unit-sphere-xyz conversion for every site in that
> body's site config. Sites with a `playable` flag get bright interactive pins showing a
> progress summary from that site's save namespace; sites without it get dim
> 'locked/coming soon' pins with no click-through. Clicking a playable pin eases the camera
> toward it, fades the view, fully disposes the hub scene's geometry/textures (never keep two
> WebGL contexts alive at once), then boots the main game for that site. Namespace all
> per-site save keys under that site's id; keep only genuinely account-wide settings
> (keybinds, audio preferences) unnamespaced. Treat cloud sync as a fully optional, additive
> layer using the player's own cloud storage account with last-write-wins merge — the game
> must be completely playable with cloud sync entirely absent."

---

## 9. Telemetry (optional, backend-adjacent)

**Purpose:** privacy-respecting, consent-gated analytics for both the web build and any
native app wrapper.

**Shape:** an anonymous random UUID (not tied to any account) is generated client-side only
after explicit opt-in consent; events post to a lightweight serverless ingest endpoint. This
is entirely decoupled from gameplay — the game functions identically with telemetry disabled
or unreachable.

**Varies per body:** nothing — this is body-agnostic infrastructure, reused as-is.

**Reproduction prompt:**
> "Add an optional, consent-gated telemetry client: on explicit opt-in only, generate a random
> anonymous UUID (no account linkage) stored locally, and post gameplay events to a
> serverless ingest endpoint. The game must work identically with this disabled, absent, or
> the endpoint unreachable — never block or degrade gameplay on a telemetry failure."

---

## 10. Companion / music / dance (optional, high novelty)

**Purpose:** an ambient procedural soundtrack plus a deployable companion robot that reacts to
it, and a beat-synced choreography layer on a legged unit.

**Shape:** a fully procedural WebAudio synthesis engine generates the soundtrack from a small
authored playlist of parameter presets (no audio asset files at all) — a lookahead scheduler
keeps playback sample-accurate, and a derived "beat clock" function exposes the current beat
phase for other systems to sync against. A separate deployable companion unit can be
called/deployed/parked, carries a small cargo slot (a lightweight fetch/deliver loop), uses
spatial (positional) audio panning, and pulses visually in sync with the beat clock. A legged
unit (subsystem 6) can be commanded into a small library of dance poses that are timed against
the same beat clock via the walker-rig's pose-override hook.

**Varies per body:** nothing structurally — purely a novelty/flavor layer, fully independent
of terrain/gravity/site data. Could be omitted entirely for a more "serious" body if desired.

**Reproduction prompt:**
> "Build a fully procedural WebAudio music engine (synthesized, not sample-based) driven by a
> small set of authored parameter presets, with a lookahead scheduler for sample-accurate
> playback and a derived function exposing current beat phase. Build a small deployable
> companion unit with call/deploy/park states, a one-slot cargo/courier loop, spatial audio
> panning, and a beat-synced visual pulse. Optionally add a small library of timed dance poses
> triggerable on a legged unit (subsystem 6), synced to the same beat-phase function via that
> rig's pose-override hook. This entire subsystem is independent of body/terrain/physics and
> can be skipped for a body where it doesn't fit the tone."

---

## 11. HUD / UX conventions (apply throughout)

- **Fake-shadow idiom**: no real-time shadow maps; a soft blob/decal shadow is drawn under
  each unit instead, plus drive-dust and wheel-track decals for movement feedback. Cheap,
  looks correct at the camera distances this game uses.
- **Procedural-fallback-first model loading**: every unit/structure tries to load a real GLB
  model, but has a procedural (primitive-geometry) fallback so the game is never blocked or
  broken by a missing/slow asset — build and verify the procedural version first, swap in the
  real model after.
- **Unified Pointer Events**: one input path handles mouse, touch, and pen — don't branch
  separate mouse-event and touch-event handlers; use `pointerdown/move/up` uniformly, with a
  movement-distance threshold to distinguish a tap/click from a drag.
- **On-screen virtual joysticks** for touch, laid out landscape-first on mobile.

**Reproduction prompt:**
> "Use decal/blob fake shadows instead of real-time shadow mapping for all units. Every model
> load attempts a real GLB asset but falls back to a simple procedural primitive shape if the
> asset is missing or still loading — build the procedural fallback first, treat the real
> asset as a visual upgrade, never a hard dependency. Use unified Pointer Events (not separate
> mouse/touch handlers) throughout, with a small movement-distance threshold to distinguish a
> tap from a drag. Provide on-screen virtual joysticks for touch input, landscape-oriented by
default on mobile."

---

## How to use this for a new body

1. Fill in subsystem 1 (site config) with real data for the new body.
2. Set subsystem 3's gravity constant; flag subsystem 5/6's traction and hover/climb constants
   as unverified pending playtest.
3. Decide whether subsystem 4 (weather/hazards) applies at all (airless bodies likely skip it
   entirely).
4. Reuse subsystems 6–11 close to as-is — they're the most body-agnostic layers.
5. Playtest the body-specific feel (gravity, traction) before shipping — automated tests can
   confirm controls respond, not that the feel is right.
