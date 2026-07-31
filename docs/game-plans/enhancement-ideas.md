Graphics — quick wins (1–2 days)
1. Wire up PBR environment reflections
parts.js already uses MeshStandardMaterial with envMapIntensity, but world.js never sets scene.environment. Metal tanks and engine bells are missing the main “real rocket” cue.

Do: In world.js, after the renderer is created:

RoomEnvironment + PMREMGenerator from Three addons
scene.environment = pmrem.fromScene(env).texture
Optionally a second, lower-res env updated when applyPreset() changes sky colors
Effect: Alloy tanks, copper fuel lines, and soot bells pick up sky/ocean color without new textures.

2. Keep the world alive during ascent
ascent.js calls scene.render() only — no scene.update(elapsed). Ocean waves, clouds, embers, and grade grain freeze mid-launch.

Do: In the ascent loop:

scene.update(clock.getElapsedTime());
scene.render();
Or scene.setAnimating(true) + scene.tick() for the flight phase.

3. Social / hero frame
You have og-image.png but no meta tags; og:url still points at the Signal playground.

Do: Add og:image, twitter:image, canonical URL for marsapiens.com. Cheap polish for shares.

4. prefers-reduced-motion
Scanlines, coachmark pulses, camera lerp, and film grain can nauseate some users.

Do: CSS + JS flag: disable VFX overlay, reduce camera lerp speed, skip grain in post.js when matchMedia('(prefers-reduced-motion: reduce)').

Graphics — atmosphere & world (3–5 days)
5. Sky upgrades (sky.js, presets.js)
Current sky is strong (gradient, clouds, sun disc). Next layer:

Addition	Notes
Moon disc
Night preset: secondary light body opposite sun, drives ocean glitter
Star field upgrade
Replace point-stars with milky-way band shader layer (fade with uSpace)
Cloud shadows on island
Cheap: project cloud noise onto terrain uniform in island.js vertex shader
Preset: CLEAR NOON
High sun, low haze, crisp shadows — good contrast for screenshots
Preset: STORM
Dark clouds, choppy ocean (uChoppy boost), rain particles
6. Ocean upgrades (ocean.js)
Gerstner + glitter is already better than Water.js for perf. Add:

Shore foam ring — extra fragment term where length(xz) < uShoreR, white FBM foam
Rocket reflection — very subtle: sample sky color in fresnel, not full mirror (too expensive)
Launch disturbance — during ignition/liftoff, radial ripple uniform centered on pad (decays over ~3s)
Wake during ascent — if camera is low, expand uShoreR calm zone as rocket climbs (pad boil effect)
7. Post stack (post.js, world.js)
You have bloom + vignette + chroma + grain. Layered upgrades:

Pass	Purpose
Exposure pulse
Brief bloom/exposure bump at T-0 (sell ignition)
Launch-only DOF
BokehPass or custom: shallow focus on rocket during trench shot, open up at aerial
Preset grade LUT
Warm dawn vs cool night color matrices in GradeShader (not just bloom strength)
Heat shimmer
Optional full-screen UV wobble near pad when setLaunchEffects('ignition')
Software GL tier should keep the current direct-render path (no composer).

8. Island & pad choreography (island.js, particles.js)
The complex is already detailed (tower, arms, deluge, trench). Make it move:

Service arms retract — on prelight, swing arms rotate away over 1.2s (tower children)
Hold-down clamps open — eight arms rotate outward at ignition
Floodlight cones — night/dusk: visible SpotLight cones + volumetric fake (cone mesh with additive gradient)
Pad wet deck — dark reflective plane on apron with simple ripple shader when deluge runs
Water tower level — subtle bowl shimmer uniform tied to uTime
particles.js launch layering (flame / steam / deluge) is excellent — extend with:

Acoustic barrier steam — horizontal sheet along blast wall during ignition
Spark shower — short additive burst at clamp release
SRB-style orange trail — if bottom stage has boosters, tint flame system per engine count
Graphics — vehicle & flight (3–5 days)
9. Exhaust & staging (ascent.js, physics-rapier.js)
Current exhaust is Points with simple downward drift; stage sep is scripted tumble.

Upgrade path:

Piece	Implementation
Multi-nozzle exhaust
One particle system per engineGlow child, not single nozzleY()
Mach diamond
Additive ring meshes in exhaust cone, scale with throttle
Rapier debris
Wire initRapier() + createDebrisWorld() — jettisoned stages tumble with physics
Contrail
Above ~8 km, thin additive ribbon following rocket path (from trace)
Engine glow bloom
Emissive boost on bells during thrust; feeds bloom threshold
10. Trace-driven motion (big cinematic win)
Ascent uses fixed altitude = eased * 140 while telemetry samples the flight trace by normalized progress — they can disagree.

Do: Drive rocketRoot.position and pitch from flight.trace by real time t, with smooth interpolation. Stage sep when trace stage changes, not fixed sepTimes[].

Effect: Telemetry, camera, and motion feel like one simulation.

11. Camera polish (ascent.js)
Auto cuts are good (trench → track → aerial). Add:

Shake on ignition (small random offset, decaying)
Tower hero — first 0.5s: camera behind trench wall peeking at engines
Max-Q pass — brief telemetry flash + subtle camera vibration when trace q peaks
Orbit hold — at end, slow roll revealing curvature / star field (setSpaceFactor already exists)
Reset via recenterCamera() — not hardcoded (9, 7, 13)
12. GLB models (assets.js, parts.js)
Procedural meshes are already high quality (PBR, weld lines, gridfins). GLB path exists but no models in repo.

Priority models (low poly, <500k per part):

Command pod (hero close-ups)
Engine bell (reused across engines)
Fairing (tall silhouette)
Host on CDN / public/rocket-island/assets/models/, set geom.glb on catalog entries. Procedural fallback stays.

13. Space transition (world.js, sky.js)
setSpaceFactor() already fades fog, stars, ocean. Push further:

Earth limb glow — sky shader: orange band at horizon when uSpace > 0.3
Atmosphere scatter on rocket — faint blue rim light on upper stages in space
City lights on island — night preset: emissive dots on uFade terrain opposite pad (fake with texture or scattered points)
Graphics — performance tiers (perf.js)
Add a medium tier between software and high:

Tier	Bloom	Ocean seg	Particles	Shadows	Notes
Low
off
96
25%
off
current software
Medium
on, half res
140
60%
on, 1024
laptops
High
full
220
100%
2048
current GPU
Also:

Build mode idle: animating: false + dirty-flag renders — saves battery on static VAB view
Ascent only: full animation + composer
DPR cap on mobile: pixelRatioCap: 1.5 at widths < 768px
Other enhancements — gameplay & feel
14. Unify mission verdict with flight sim
Today: missions use Tsiolkovsky Δv vs requiredDv; challenges use flight.reachedOrbit.

Proposal:

Planning HUD — keep Δv bar (Tsiolkovsky) for building
Launch verdict — use flight.reachedOrbit + margin; show both numbers on verdict card (“Budget 9,200 · Flown orbit ✓”)
NO_LIFTOFF — still from TWR < 1 or integrator never lifting
Players trust telemetry when it matches the outcome.

15. Launch-linked challenges
On successful launch, silently run evaluateChallenge for orbit challenges; toast medals on verdict. Challenges button becomes “history + hard modes,” not the only path.

16. Manual flight mode (optional hard mode)
Wire flight.js control() to ▲/▼ throttle and ◀/▶ pitch; show rl-telem-controls. Unlock via challenge or dept “Flight ops.” High skill ceiling without changing default autopilot.

17. Radial mount UX (assembly.js, ui.js)
Graphics + UX: clicking SRB highlights valid parent tanks in emissive green; drag ghost snaps to side of highlighted tank. INTEGRATION panel: dropdown “mount on stage N tank.”

18. Audio (missing entirely — huge immersion gap)
No sound today. Layered launch sequence:

Phase	Sound
Prelight
Pad hum, deluge rush
Ignition
Low rumble + crackle
Liftoff
Building roar, clamp release clank
Ascent
Distant thunder, wind shear
Stage sep
Muffled pop
Verdict
Tier-specific sting
Web Audio with preloaded OGG; mute toggle in header. No build step needed.

19. Share & export
Share design — encode serialize() to URL hash or short code (lz-string)
Screenshot — renderer.domElement.toDataURL() on verdict (“mission card” with tier + rocket thumbnail)
Replay — store last flight.trace, scrub bar on verdict screen
20. Tests & smoke harness
window.__rocketLab is ready for:

computeVehicle golden cases
simulateAscent orbit reach
Headless launch → verdict path
Prevents physics/visual drift when tuning graphics.

Suggested implementation order
Week 1 — Feel
Week 2 — Launch spectacle
Week 3 — World depth
Week 4 — Product
PMREM env map
Ascent update loop
Trace-driven motion
recenterCamera reset
Multi-nozzle exhaust
Pad choreography
Rapier debris
Exposure pulse + shake
Ocean foam + pad ripple
Sky moon + storm preset
Service arm animation
Audio layer
Unified verdict
Challenge on launch
GLB hero models
Share / screenshot
If you want only three changes this week
PMREM + ascent update() — metals pop, launch doesn’t freeze the ocean
Trace-driven ascent motion — telemetry and animation finally agree
Launch audio + ignition exposure pulse — biggest perceived quality jump for players
Tell me which bucket you want implemented first (graphics spectacle, sim coherence, or audio/UX), and I can start patching the codebase in that order.

