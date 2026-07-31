# Mars Colony — Phase Next

Approved 2026-07-09. Grounded against the actual code (terrain.js / rover.js / drone.js / prep_site.sh), not just ideas.

**Answered before planning:** `terrainSegments` was a shared 256/128 for both sites (Gale under-resolved); heightmaps are 8-bit (Gale = 3.16 m quantization steps); rover slope-traction already exists (rover.js `SLOPE_K`) — dropped from the list.

## Phase 0 — Drone feature pass (do first)

- **0.1 Rotor spin.** GLB re-export with separate rotor nodes (Tripo/Blender) was attempted and **skipped** — local mesh-split tooling OOM'd the machine (no Blender installed; trimesh split ran the system out of memory). Instead: `rotors.js` procedural rotor overlay — 4 spinning two-blade rotors + speed-faded blur discs per drone, hubs placed from the loaded model's bounding box (X-quad layout), spin-up/down tied to take-off/landing/battery. Revisit real rotor-node re-export when Blender is available on a bigger box.
- **0.2 Lift drone actually lifting.** Collecting a sample leaves a sealed **sample cache container** at the site (MSR-style depot caching). Lift drone (only) hovers low over a container → SLING (E) → container hangs from a cable with pendulum lag; while slung: max speed ×0.6, climb ×0.7, battery drain ×1.6. Deliver by hovering over the **FIELD LAB** pad (new procedural structure near spawn). Lab tracks delivered/analyzed samples in HUD + menu.

## Wave 1 — Terrain fidelity

- **1.1 16-bit heightmaps.** RG-packed PNG (R=high byte, G=low byte) from prep_site.sh; terrain.js decodes `(R·256+G)/65535` in both the vertex shader and the CPU sampler. Decode is exactly backward-compatible with 8-bit grayscale (R=G ⇒ v/255). Kills Gale's 3.16 m stepping.
- **1.2 Per-site quality.** `segments` per site in sites.js (Gale 512 desktop / 192 mobile; Jezero 256/128). Gale heightmap → 2048, Gale albedo → 4096 (HiRISE source is 0.25 m — 2048 over 9 km was the single biggest waste).
- **1.3 Material blending.** Fragment-shader dust/bedrock blend by slope + low-frequency patchiness, on top of the real ortho (subtle — the photo stays the base).
- **1.4 Sample-coordinate QA.** Arithmetic re-check of `samples[]` offsets vs real lon/lat; full QGIS visual pass deferred.

**Deploy after Phase 0 + Wave 1** (commit → push ankesrtw → wrangler pages deploy).

## Wave 1.5 — Real-data collectible loop (do before Wave 2) — DONE 2026-07-11

Small enough not to delay site expansion; reuses data/patterns that already exist rather than adding new subsystems.

- **1.5.1 Real-data findings on collectibles. DONE.** The pickable markers at real lon/lat already existed (Phase 0.2); what was missing was the science payoff. Every sample in `sites.js` now carries a `finding` — the real published mission result (e.g. John Klein smectite clays/habitability, Cheyava Falls leopard-spot biosignature candidate, Cumberland first in-situ K-Ar dating) — revealed in-game only after lab analysis.
- **1.5.3 Minimap wayfinding pass. DONE (2026-07-11).** Photo × relief hybrid base — the site ortho contrast-stretched (2–98 percentile), site-tinted (fixes Jezero's gray tile), and multiplied with a real-DEM hillshade (256² `terrain.sampleHeight` grid, NW light, 2.5× exaggeration, one-off at boot). Overlays above the fog: unit dots ("you are here" — active = white + heading tick, idle dimmer), teal FIELD LAB square, pulsing ring on the current TGT marker, north arrow + 1 KM scale bar. Display canvas 512px (2× fog buffer) for crisp furniture in the 140px tile. Verified both sites via canvas pixel probes.
- **1.5.2 Simulated edge-node analysis + persistent science archive. DONE.** New `analysis.js`: delivered caches process FIFO, one at a time, 28s each on the lab's "Jetson-class edge node" (timed sim, no backend). Live `NODE ▸ <SAMPLE> n%` line in the HUD inventory box; completion reveals the finding in the menu LAB list (`ANALYZED ✦`), files a record in the SCIENCE ARCHIVE menu section, and persists to localStorage `mc-results` (survives reloads, spans sites; re-analysis replaces the old record; corrupt storage falls back clean). E2E-verified headless (collect→sling→deliver→analyze→archive→reload persistence); verify recipe persisted in `.claude/skills/verify/SKILL.md`.

## Wave 2 — Site expansion (5–10 sites + Hellas) — RESEQUENCED to last content wave, see note below

**Resequencing decision (2026-07-12):** same logic as the Wave 3/Wave 4 pull-forwards — perfect Jezero completely (hazard consequences + base-building, formerly Waves 6-7, now Waves 6-7 still but built BEFORE this section) before replicating the pattern to new sites. Wave 2 now runs LAST among content waves, once Jezero carries missions + hazards + rollover/stuck/wind + base-building all proven. Wave 5 (terrain LOD) stays a prerequisite check immediately before this wave since Hellas specifically needs it.

Target roster (each = one prep_site.sh case + one sites.js object + samples list):
1. **Hadriacus Palus** — ready 1 m DEM + 0.5 m ortho pair; rugged highlands. First.
2. **InSight — Elysium Planitia** — CTX pair; lander/seismometer archetype.
3. **Gusev Crater (Spirit)** — Columbia Hills, Home Plate; CTX/HiRISE DEM archive work.
4. **Meridiani Planum (Opportunity)** — long-traverse; Victoria/Endeavour craters.
5. **MSR extended Jezero** — crater rim, 8-stereo-pair HiRISE terrain.
6. **Phoenix — Vastitas Borealis** — polar terrain, ice mechanics hook.
7. **Hellas Planitia** — eastern-basin 10–20 km site; needs a local CTX/HiRISE DEM/ortho pair from the archive (MOLA/THEMIS too coarse); flagship dust-storm site. May require terrain LOD (Wave 5) if the crop goes past ~10 km.
8.–10. From the USGS Human Exploration Zone archive (1,354 HiRISE DEM+ortho pairs) as fillers.

Site-picker menu will need a scrollable grid once count passes ~4.

## Wave 4 — Gameplay depth (resequenced 2026-07-12: built on Jezero BEFORE Wave 2 — see `09`'s precedent; plan: `docs/game-plans/10_wave4_gameplay_depth_jezero.md`)

Missions layer (per-site objective chains: survey %, collection chains, rescue/tow), per-site hazards (dust storms, soft sand, night cold-drain), science map overlays (elevation/slope/path), vehicle feel (wheel spin, slide, rollover warning).

- **Guided tutorial** — built ahead of schedule as its own resequenced Wave 3, before Wave 2. See `docs/game-plans/09_wave3_polish_jezero.md`. At project completion, extend into a full guided tour for visitors; integrate progressively across subsequent phases here — each new mechanic (missions, hazards, overlays) adds its own tutorial step.

Also folds in (deferred from the 2026-07-11 idea pass — each is net-new engineering surface, better designed against the full Wave 2 site roster):
- **Drone FOV / sensors** — no raycasting/frustum code exists today; new subsystem.
- **Microrobotic swarm** — new entity type + boids/formation logic; reconsider input model (touch/drag, not mouse-only) given the mobile-first control scheme already built.
- **AI hologram assistant** — nothing like this exists in the repo; scope down first (scripted/canned hints vs. real LLM calls — a real LLM means a new Lambda + cost surface, breaking the current no-backend vanilla-game pattern) before estimating further.
- **More drone/rover/humanoid variety, terrain-matched** — asset pipeline (Tripo GLB → `models.js` MODELS map → `applyBrandFinish()`) is proven and cheap; sequence after Wave 2 so variants can be matched to the full site roster instead of just Jezero/Gale.

## Wave 5 — Scale enabler (plan immediately before Wave 2, once Waves 6-7 are done)

Terrain LOD (clipmap rings around active unit; CPU sampler stays fixed-res) — prerequisite for Hellas-scale (>10 km) maps. Purely a rendering/perf prerequisite, not content — stays pinned right before Wave 2 regardless of the Wave 6/7 pull-forward below.

## Wave 6 — Hazard consequences & drone wind (idea pass 2026-07-12; RESEQUENCED 2026-07-12 to build NOW on Jezero, before Wave 2)

Turns existing warning gauges into real consequences; all three reuse systems already built rather than adding new subsystems.

- **Rover rollover.** `rover.js` already computes `rolloverRisk` (0..1 gauge, `ROLL_START`/`ROLL_MAX` in slopeMag space) but nothing physically flips the rover today. Add small dense pebble colliders (denser than rocks.js's boulders) that jolt pitch/roll on contact at speed; crossing `ROLL_MAX` while fast over one flips the rover onto its side (mesh rotates ~90° on its long axis, controls lock out). Recovery: humanoid walks over and interacts (reuse the sling `E`-key idiom) to right it.
- **Soft-sand stuck + winch rescue.** hazardZones.js already reports continuous `inHazard`/`intensity`. Add a stuck state: dwelling in a high-intensity zone above a slip threshold for N seconds bogs the rover to a full stop (wheels still spin via the existing `slip` param). Rescue: another unit approaches within tow range and holds interact — reuse the cargo sling-cable visual as a "winch line," drag free over a few seconds.
- **Drone wind buffeting in storms.** weather.js already drives `FOG.density` on a storm timeline — extend it to also emit a wind vector (magnitude/direction), stronger near storm peak. drone.js integrates lateral drift from that vector into its existing velocity integration; player must counter-steer to hold course/landing. HUD: wind-direction indicator docked near the existing compass dial.

Shared plumbing: hazardZones.js registry, weather.js timeline, rover's `rolloverRisk` math, effects.js's dust/particle idiom, sound.js's synthesized-cue pattern (flip alert, tow-strain groan, wind howl swell).

## Wave 7 — Base-building (idea pass 2026-07-12; RESEQUENCED 2026-07-12 to build NOW on Jezero, right after Wave 6, before Wave 2)

Natural extension of what already exists: FIELD LAB is already a placed structure (lab.js/station.glb), analysis.js already produces a scored result per sample, missions.js already gates content per-site. Good findings at a sample site unlock a checkpost/outpost structure built there — same Tripo → `models.js` MODELS map → `applyBrandFinish()` pipeline already proven for units. Placement and unlock logic driven by mission/analysis outcomes already computed; no new subsystem, just new structure entries + placement rules.

## Wave 9 — Multiplayer colony (idea pass 2026-07-12, distant future — separate architecture decision, not a content wave; renumbered from Wave 8 to sit after Wave 2's resequence)

Age-of-Empires-style shared world: multiple players collecting samples, building labs/checkposts/water systems concurrently. This is a genre and architecture change, not an extension — today the game is fully client-side (no build step, no backend, single-tab physics/state), matching the project's deliberate no-backend vanilla-game pattern (see Wave 4's AI-hologram note for the same tension). Needs, at minimum: authoritative server or peer state, network sync/interpolation, conflict resolution for shared resources (sample claims, structure ownership), almost certainly a Lambda+WebSocket (API Gateway) or similar backend — a new cost surface and infra pattern distinct from everything else in this repo. **Do not start without a dedicated scoping/cost discussion first** (aws-pricing MCP for WebSocket API Gateway + Lambda + connection-state storage costs, and an explicit decision on whether this stays the same game or becomes a new project).
