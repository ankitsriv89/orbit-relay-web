# Multi-Planet Colony Roadmap — build every body, phase by phase

> **Updated 2026-07-26 (plan 31)** — this doc was written 2026-07-11 describing Mars Colony as a
> "rover/drone/on-foot sample-collection loop." Since then, plans 09–30 shipped a much larger
> system on Mars only (see "What the engine actually is today" below). The tiering/phase
> structure below is unchanged and still the sequencing plan — only the "what exists" framing
> has been corrected. See [`docs/mars-sim-engine-spec.md`](../mars-sim-engine-spec.md) for a
> portable, code-independent spec of every subsystem, written so any of them can be reproduced
> for a new body without this repo's source.

## Context

Mars Colony (real MOLA/HiRISE DEM + rover/drone/on-foot/legged-walker gameplay, base-building,
hazards, missions, a 3D globe site-hub with cloud save, and a procedural music/dance
companion system) has proven the pattern: real NASA elevation + imagery data, dropped into a
Three.js terrain/vehicle engine, produces something genuinely differentiated. Competitive
research (2026-07-11) confirms the niche is open — official NASA tools (Moon Trek, Eyes on
the Solar System, Solar Wanderer) do real-data 3D visualization with **no gameplay**; existing
browser lunar-colony games (Lunar Colony, ARTEMIS IV) have gameplay but **fictional/procedural
terrain**. Nobody combines real DEM data with rover/drone/colony gameplay in-browser. The goal
now is to extend Mars Colony's engine across every body with usable NASA/JPL/USGS data,
sequenced by data quality and asset-pipeline reuse so early phases fund the harder later ones.

## What the engine actually is today (corrected 2026-07-26)

As of plan 30, Mars Colony is a fleet-and-systems sim, not a single-loop demo. Full subsystem
detail — including what varies per body vs. what's shared — lives in
[`docs/mars-sim-engine-spec.md`](../mars-sim-engine-spec.md); summary:

- **7 switchable units** — rover, recon drone, lift drone, on-foot humanoid, van (mobile base),
  Gratbot (quadruped walker), Makadane (octopod walker) — plus a non-switchable 8th, **ONGAK**,
  a deployable music-companion/courier robot (CALL/DEPLOY/PARCEL) docked with Gratbot.
- **Shared legged-locomotion engine** (`walker-rig.js`) — N-leg analytic IK used by both
  Gratbot and Makadane; the strongest candidate for direct reuse on any future legged-terrain
  body.
- **Physics** — single shared gravity constant (currently Mars' 3.72 m/s², used by
  drone/humanoid/rover vertical integrators) — this is the main per-body parameter to swap.
- **Hazards/weather** — real-MEDA-grounded dust storms + wind-drift (drones only, rovers
  wind-immune), dust devils, soft-terrain hazard zones, rover condition state machine
  (ok/rolled/bogged) with rocking-recovery.
- **Base-building** — checkposts + an HQ capstone, derived purely from existing save state (no
  separate save format).
- **Mission system** — per-site typed objective-step chains (`missions.js`), generalized from
  the original tutorial.
- **Site-hub + saves** — a 3D rotatable globe (`hub.js`) with real lon/lat pins per site,
  per-site save namespacing (`mc-<siteId>-*`), three reset tiers (Run/Site/Game), and BYOC
  cloud sync via the player's own Google Drive (`drive.file` scope, no backend).
- **Telemetry** — consent-gated, anonymous-UUID analytics (Cloudflare Pages Function + D1),
  feeding both the web build and the external Capacitor Android app.
- **Companion/music/dance** — a from-scratch procedural WebAudio synthwave engine (`music.js`,
  own 11-track playlist, no external catalog dependency), beat-synced dance moves on Gratbot,
  and an NPC hologram companion (Ariana) at the field lab.
- **Terrain** — GPU geometry-clipmap LOD (Wave 5), decoupling render cost from world size.

All of the above shipped **Jezero-first, then generalized to every site** — as of plan 30 the
engine is fully data-driven: nothing is site-specific any more except a PRNG salt, so a new
Mars site is an asset pair plus one `sites.js` object. **Moon has none of it** —
`public/moon-colony/` is still exactly the Phase A scaffold below (environment/rover/sites
generalized for low-gravity/no-atmosphere, `SITES` intentionally empty). The "Moon forks
Mars's engine" architecture decision (Phase A, below) now means forking a codebase several
times larger than what existed when the fork was made — Phase B needs an explicit call on
whether to re-fork from current Mars state or backport the missing systems, before real site
data lands. Not decided here; flagged so it isn't missed.

### Current site table (corrected 2026-07-26)
- **Mars — 8 playable** (plan 30 took this from 2 to 8): Jezero Crater (Perseverance), Gale
  Crater (Curiosity), Gusev Crater (Spirit/MER-A), NE Syrtis (MRO survey, unflown), Elysium
  Planitia (InSight), Meridiani Planum (Opportunity/MER-B), Olympus Mons (Mariner 9 survey,
  unflown), Hellas Planitia (MGS survey, unflown). Each ships the full plan-09–28 feature set.
- **Mars — 0 locked**: `LOCKED_SITES = []`. The array stays exported (hub.js spreads it
  unconditionally) and is where the next unbuilt Mars site lands.
- **Moon — 0 sites**: `SITES = {}`, confirmed unchanged since Phase A. Boots to a clear
  "SITES is empty" error by design, not a silent fallback.

## Data tiering (from 2026-07-11 research pass — still valid)

| Tier | Bodies | Data character | Asset pipeline |
|---|---|---|---|
| **1 — DEM+imagery, high-res** | Moon, Mercury, Mars (done), Vesta, Ceres | Real elevation (GeoTIFF) + real color/albedo imagery, global or near-global coverage | Reuse Mars terrain.js pipeline near-as-is (prep_site.sh → heightmap+ortho pair) |
| **2 — mesh-based** | Bennu, Ryugu | Laser-scanned 3D shape models (OBJ, down to 20–75cm), not heightmaps | New loader (import mesh directly), but reuse rover/physics/gameplay code; micro-gravity is a new mechanic |
| **3 — compromised data** | Venus (radar-only, no true color), Pluto/Charon (300m DEM but only ~40% globe, single flyby) | Usable but needs either stylization (Venus) or fixed-scene design (Pluto — can't roam past the mapped hemisphere) | Terrain pipeline reused; site design constrained by coverage |
| **4 — sparse/backdrop only** | Europa, Ganymede, Callisto, Io, Titan, Enceladus, Rhea | Patchy Galileo/Cassini coverage, low-res, large gaps; Titan haze-obscured optically | Not viable as detailed roam-sims yet; revisit only if new mission data lands (Europa Clipper, Dragonfly) |

Phase order follows this tiering: cheapest reuse and best data first, so each phase both ships
a body and matures the shared engine for the next.

## Phase A — Engine generalization (done for Moon's fork point, now stale vs. current Mars)

**Architecture decision (2026-07-11, supersedes the original "shared `bodies/` config inside
mars-colony" idea below):** Mars Colony stays **completely untouched** — no shared-config
refactor inside `public/mars-colony/`. Instead, `public/moon-colony/` is a **fork** of
mars-colony (full copy of `js/`, `style.css`, `index.html`; Mars-specific `assets/jezero`,
`assets/gale` removed, shared `assets/models/` kept) and *this fork* becomes the reusable base
for every subsequent body — Vesta/Ceres/etc. will fork from Moon (or a later-generalized copy),
not from Mars. No `bodies/<name>.js` shared-config file, no in-game body switcher — each body
is its own folder/deploy path, consistent with the "individual folders, separate domain later"
decision in the same planning session.

**Scaffold status: DONE (2026-07-11), unchanged as of 2026-07-26.** `public/moon-colony/`
created and generalized for a low-gravity, no-atmosphere body:
- `environment.js` — no-atmosphere sky (near-black horizon/zenith, no sun halo, neutral-white
  sun light, zeroed FogExp2 density, darker/cooler hemisphere fill).
- `rover.js` — `SLOPE_K` lowered to an **unverified** low-gravity estimate (2.2 vs Mars' 3.0);
  speed/gear constants left as Mars placeholders with a TODO (no real Apollo LRV figures
  sourced yet).
- `sites.js` — Moon-specific `M_PER_DEG` (lunar radius) and `SOL_MS` (real synodic period);
  `SITES` intentionally **empty** — `main.js` throws a clear error at boot rather than
  silently falling back to a nonexistent Mars site.
- `main.js` / `rocks.js` / `terrain.js` / `hud.js` / `index.html` / `README.md` — Mars-specific
  text, tones, and the `jezero`-literal PRNG salt generalized or corrected.
- Verified headless (Playwright): page boots and throws exactly the intended `SITES is empty`
  error, no unrelated JS errors.
- **Not yet touched**: `drone.js` gravity-dependent hover/climb tuning (deferred to B.3
  alongside rover feel — needs a real site to tune against); CSS class names keep the `mars-*`
  prefix as an internal namespace (harmless, not user-facing).
- **Now also not touched**: none of plans 09–30's systems (missions, hazards, base-building,
  hub/globe+saves, telemetry, walker units, companion/music) exist in `moon-colony/` at all —
  this fork point predates all of it. Re-forking closer to Phase B start is worth considering.
- **Deferred to Phase A.5**: WebGPURenderer adoption (see below) — not yet applied to either
  mars-colony or moon-colony.

- **A.5 WebGPURenderer adoption.** Switch import to `three/webgpu` (production-ready since
  r171, Sept 2025) with automatic WebGL2 fallback — zero-config, no behavior change for
  unsupported browsers. Do this on moon-colony (or whichever fork becomes the template) rather
  than per-body, so it benefits every subsequent terrain. Verify existing shaders/materials
  (terrain blend, dust, brand-tinted finishes) render identically under WebGPU before relying
  on it; keep WebGL2 path as the tested safety net. **Not yet done.**

## Phase B — Moon (first new body)

Best data of anything on the list (LOLA 118m DEM, finer than Mars MOLA; LROC 100m imagery),
and closest to a drop-in reuse of the existing pipeline. Engine scaffold
(gravity/atmosphere generalization) is done as of Phase A above — B.1/B.2 (real site data) is
the remaining blocker before this is playable, and the re-fork-vs-backport question (see
"What the engine actually is today" above) should be settled before this phase resumes.

- **B.1 Site sourcing.** 2–3 sites via USGS Astrogeology / JPL Moon Trek: Apollo 11/17 landing
  sites (historic hook, good imagery), Shackleton crater rim (south pole,
  permanently-shadowed-region contrast, ISRU/ice-mining hook), Mare Imbrium or Tycho crater
  (dramatic terrain, rays). **Not started** — `moon-colony/js/sites.js` SITES is empty.
- **B.2 prep_site.sh extension.** Adapt existing DEM/ortho crop-and-tile script for
  LOLA/LROC source format (GeoTIFF, same as Mars — should be close to a direct port).
  **Not started.**
- **B.3 Low-gravity feel.** rover.js's `SLOPE_K` has a placeholder estimate (see Phase A
  scaffold status above); needs real playtest tuning once a real site exists to drive on.
  drone.js hover/climb constants haven't been touched at all yet — same treatment needed.
- **B.4 No-atmosphere rendering.** Done as part of the Phase A scaffold (environment.js) —
  sky, fog, lighting all generalized. Visual polish (e.g. starfield) still nice-to-have, not
  blocking.
- **B.5 Regolith color/dust mechanic.** Real LROC imagery for base albedo; optionally a
  lunar-dust-adhesion visual gag (rover/suit gets grey exactly like Apollo footage) —
  nice-to-have, not blocking.

Deploy after B.1–B.3 (dust mechanic can trail). No hub landing-page card added yet
(intentional — avoid linking a non-playable page); add one once a real site lands. (The
top-level Solar System Map, plan 32, shows Moon as a locked/no-link node in the meantime —
consistent with this "no card until playable" rule.)

## Phase C — Mercury, Vesta, Ceres (Tier 1 remainder)

Same pipeline as Moon, run back-to-back since Phase A/B will have matured the multi-body
plumbing. Suggested order: **Vesta and Ceres first** (Dawn data, sub-100m resolution in
places, genuinely striking terrain — Vesta's giant Rheasilvia impact basin, Ceres's Occator
crater bright spots are strong visual hooks), then **Mercury** (MESSENGER 665m DEM — coarser,
and no atmosphere/extreme-temperature framing needed rather than dramatic new mechanics, so
treat as lower priority filler unless the heat/scorched-terrain angle proves compelling in art
direction).

- **C.1 Vesta** — Rheasilvia basin site; asteroid-belt framing (very low gravity ~0.25 m/s² —
  second big physics differentiator after Moon).
- **C.2 Ceres** — Occator crater (bright salt deposits — real, photographed, strong "what is
  that" hook); dwarf-planet framing.
- **C.3 Mercury** — one or two sites (Caloris Basin); extreme-temperature-cycle art direction
  (no new physics needed, day/night texture-only differentiation).

## Phase D — Bennu, Ryugu (mesh-based, micro-gravity)

The most mechanically distinct build on the roadmap — worth treating as its own mini-project
once Phase A.4's mesh-import stub is real.

- **D.1 Shape-model import.** Bennu (OSIRIS-REx, down to 20cm in patches) and Ryugu
  (Hayabusa2) meshes from NASA 3D Resources / mission archives — direct mesh load, no
  heightmap-to-mesh step.
- **D.2 Micro-gravity movement.** Rover-as-currently-built doesn't make sense at Bennu's
  micro-g (~10⁻⁵ g) — likely needs a tethered/thruster-hop movement mode instead of wheeled
  traversal. Scope this as new gameplay, not a physics-constant tweak.
- **D.3 Sample-grab framing.** Real mission hook: OSIRIS-REx's TAG (Touch-And-Go) sample
  maneuver — could reuse the existing sample-collection/lab-analysis loop (Mars Wave 1.5) with
  a mission-accurate collection animation instead of rover pickup.

## Phase E — Venus, Pluto/Charon (Tier 3, compromised data)

Lowest priority among "real data" bodies — each needs a design workaround, not just a data
swap.

- **E.1 Venus** — radar elevation is real and usable (Magellan, ~4.6km), but there's no
  true-color imagery (cloud-obscured) — surface color must be stylized/art-directed rather
  than sourced, flag this clearly in any player-facing "real NASA data" framing so it doesn't
  misrepresent sourced-vs-invented.
- **E.2 Pluto/Charon** — good resolution (300m) but only ~40% global coverage from the New
  Horizons flyby — design as a bounded fixed-scene site (Sputnik Planitia / Tombaugh Regio),
  not open-world roaming; make the coverage boundary a hard map edge rather than fading into
  fabricated terrain.

## Phase F — reassess Tier 4 (Europa, Titan, Enceladus, etc.)

Do not build these as detailed sims on current data — coverage is too sparse (patchy
Galileo/Cassini, Titan haze-obscured). Revisit if/when new mission data lands (Europa Clipper
arrives ~2030, Dragonfly targets Titan ~2034) or if a lower-fidelity "vignette" treatment
(fixed camera, small mapped patch only, no roaming) is deemed worth doing earlier for
breadth/marketing reasons — that's a scope call to make explicitly later, not a default. Plan
30 (Solar System Map) surfaces these as two labeled "coming soon" moon-cluster rings (Jovian,
Saturnian) in the meantime, without claiming Jupiter/Saturn themselves are playable bodies.

## Sequencing summary

1. **Phase A** (engine generalization) + **Phase B** (Moon) — do together, ship first.
   Re-fork-vs-backport decision (new, 2026-07-26) needs resolving before B resumes.
2. **Phase C** (Vesta → Ceres → Mercury) — same pipeline, incremental.
3. **Phase D** (Bennu, Ryugu) — biggest new-mechanic investment; sequence after C so the team
   isn't context-switching between "new pipeline" and "new mechanic" at the same time.
4. **Phase E** (Venus, Pluto/Charon) — lowest data quality among real-data bodies; fine to
   defer behind D.
5. **Phase F** (Europa/Titan/etc.) — explicitly parked, not scheduled.

## Verification

Each phase ships the same way Mars Colony waves have: deploy to staging, run through the
existing E2E pattern (site loads, terrain renders at target segment count, rover/drone spawn
and respond to controls, sample-collection loop completes) adapted for the new body's
gravity/lighting, then merge to main per the existing branch-then-merge workflow.
Body-specific physics (low-g bounce, micro-g hop-thrust) needs manual playtest per
`.claude/skills/verify` pattern — automated E2E can check that controls respond, not that the
feel is right.
