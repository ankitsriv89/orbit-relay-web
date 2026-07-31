Antimatter Frontier – Game Design DocumentVersion: 1.0
Date: June 2026
Genre: Physics-Accurate Management Simulation + 3D Visualization Game
Platform: Web (React + Three.js / R3F) – Static deploy on Cloudflare Pages + S3
Target Audience: Science enthusiasts, space nerds, Kerbal Space Program / Factorio fans
Core Theme: From today’s picogram reality to building enough antimatter for interstellar travel  1. High-Level VisionStart with real-world constraints (trillions per gram, nanogram production) and scale up through research, investment, and engineering until you can launch probes and crewed ships to Alpha Centauri using accurate relativistic antimatter rocket physics.Tagline: “Turn the most expensive substance in the universe into humanity’s ticket to the stars.”2. Core Gameplay LoopProduce → Build/upgrade accelerators, manage power & cooling.
Store → Handle limited capacity, decay, and safety.
Research → Unlock better efficiency, new tech, lower costs.
Plan & Launch → Use real physics calculator to design missions.
Visualize → Watch hyper-realistic 3D launches and journeys.

Win Condition: Successfully deliver a probe (then crewed ship) to Alpha Centauri (4.37 ly).3. Key FeaturesProduction LabMultiple accelerator tiers (Linear → Synchrotron → Dedicated Factory).
Real-time production: grams/day at late game.
Energy, cooling, and cost tracking based on real estimates.

Storage & ContainmentPenning traps → Antihydrogen ice → Advanced neutral traps.
Risk of catastrophic annihilation if containment fails (mini-game / event).

Mission Planner (Physics Engine)Accurate relativistic photon rocket calculator (accel + decel mass ratios).
Inputs: payload mass, target speed (β = v/c), destination distance.
Outputs: antimatter required, total fuel, trip time (ship + Earth frame), energy released.
Multiple destinations: Mars, Jupiter, Alpha Centauri, etc.

3D Visualization EngineHyper-realistic space scenes (PBR materials, HDR, post-processing).
Antimatter annihilation effects: glowing particles, gamma bursts, engine plumes.
Relativistic visuals: aberration of light, Doppler shift, time dilation indicators.
Ship construction & customization view.

Research & Progression Tech TreeEfficiency improvements (production cost from $10¹⁵/g → $10⁶/g).
New propulsion modes (catalyzed, beamed-core, pure photon rocket).
Storage breakthroughs, radiation shielding, crew life support.

Economy & ResourcesMoney, Energy (MW/GW), Antimatter stock, Scientists, Reputation.
Global events, funding rounds, government contracts.

4. Technical Specification (for Coding Agents)Frontend Stack (Recommended)React 19 + TypeScript + Vite
@react
-three/fiber + @react
-three/drei + @react
-three/postprocessing
Zustand (state management)
Tailwind CSS + shadcn/ui for management panels
Three.js for custom shaders (annihilation, relativistic effects)

Physics Module (Pure TS)calculateAntimatterRequired(payloadKg: number, cruiseBeta: number, distanceLy: number)
Relativistic gamma, mass ratio (accel+decel), proper time, Earth time.
Energy output: E = 2 * m * c²

DeploymentStatic build → Cloudflare Pages (primary) + S3 backup
No backend needed for v1 (all client-side)

Performance Targets60 FPS on mid-range devices
Up to 10,000 particles for annihilation effects (InstancedMesh + shaders)

5. Visual Style & Art DirectionOverall Aesthetic: Clean futuristic sci-fi with grounded realism (NASA + CERN influence + subtle cyberpunk accents).
Color Palette: Deep space blacks, electric cyan/blue (matter), magenta/red (antimatter), white/gold accents.
UI Style: Holographic overlays, dark theme, real-time graphs, Kerbal-like instrumentation.

Reference Images for Coding Agents (Visual Targets):
https://antimatterproduction.co/header.jpg
https://cms.interestingengineering.com/wp-content/uploads/2026/04/paul-trap-antimatter-research.jpg

https://kimbody1535.wordpress.com/wp-content/uploads/2013/04/isv-venture-star-avatar-10474082-2500-1351.jpg


https://nick-stevens.com/wp-content/uploads/2018/11/beam-core-am-rocket-plansx-1200x659.jpg

https://i.imgur.com/IbBzsrx.png



6. Phase RoadmapPhase 1 (MVP – 2-4 weeks)Physics calculator + basic production sim
Simple 3D ship + annihilation effect
Basic React UI

Phase 2Full management screens + resources
Storage system + risk events

Phase 3Tech tree + research
Hyper-realistic visuals & shaders

Phase 4Travel simulation with relativistic camera effects
Multiple missions

Phase 5 (Polish)Sound, achievements, save system, mobile support

