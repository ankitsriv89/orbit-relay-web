# 18 — Waves 12.10–12.17 as-built: van.glb landing + the Wave 12 B-items

Continuation of `17_wave12_humanoid_van_digging.md`. Everything below is SHIPPED and
E2E-verified (headless, 2026-07-18). One commit per wave, local-only until push is asked.

| Wave | What | Commit |
|---|---|---|
| 12.10 | van.glb lands — textured source, wheel rig, roof-stow panels | `b7cfda5` |
| 12.11 | Field repair at the deployed van, 0.4× base-bay rate | `dba9225` |
| 12.12 | Survey chain: ESTABLISH A FORWARD BASE step | `87b8069` |
| 12.13 | Recon photo mission — real frame captures + album | `f02ea17` |
| 12.14 | Van roof deck follows the van, carries landed drones | `d3a5256` |
| 12.15 | Buried samples — survey-localized subsurface core | `bbe53c2` |
| 12.16 | Van cargo bay — bulk ground logistics | `77b795b` |
| 12.17 | Recon sensor cone — imaging footprint visual | `04e0013` |

## 12.10 — van.glb

Three Tripo exports existed; **repair-van-texured.glb won**: same complete 84-part
geometry as `filled-parts-complete`, plus 84 baked textures (white hull / dark window
panels / tire treads). `segmented` was the incomplete draft. Compressed 1.69 MB → 671 KB
with `gltf-transform dedup+flatten+weld+resize512+webp+quantize` (three 0.185 loads
EXT_texture_webp + KHR_mesh_quantization natively).

- **Wheels move, but NOT via GLB nodes.** Tripo's part split bleeds tires into
  suspension arms (a node-level re-pivot would swing the suspension), so the van reuses
  the rover's `wheels.js` overlay rig: six hubs measured by vertex clustering
  (`VAN_WHEELS_GLB` in van.js), ω = v/r spin + MMSEV all-wheel steer.
- **Orientation proof:** isolated front axle (raw x −0.34; mid/rear pair +0.11/+0.33)
  AND the dropping/narrowing roofline both sit at raw −X → yaw −π/2 maps the nose to
  −Z forward. Verified in nose-on renders.
- **Grounding:** GLB and wheel-rig fallback both put wheel contact at origin height →
  `CLEARANCE 0.12` (was 0.5 — the van hovered). Dock-ring y derives from clearance.
- **Panels roof-stow** (180° hinge, staggered heights) — the old 90° side-fold
  curtained the textured hull. Hinges re-seat on the measured roof at GLB swap.

## 12.11–12.17 in one paragraph each

- **Field repair (12.11):** basePad/vanPad resolved separately in the dock check;
  charging equal, repair at `FIELD_REPAIR_FACTOR 0.4` at the van — bays stay special.
  Frame-exact E2E: field/base = 0.40.
- **Forward base (12.12):** survey chain leads with `forward-base` (van deployed
  >600 m from every base pad) — Neretva (~5.5 km) is one-way recon range, so the chain
  teaches the van loop; `return-base` accepts the deployed van's dock and now fires
  outside the survey gate (it ends the photo chain too).
- **Photo mission (12.13):** `photos.js` — P / HUD PHOTO over a `photoSpots` target at
  ≥8 m AGL grabs a REAL frame (render + canvas downscale, 360 px jpeg), filed in the
  SURVEY IMAGING menu album (`mc-photos`, archive spirit). Mission counts per-SESSION
  firsts so RESET keeps it completable. TGT chases the nearest unimaged target; camera
  glyphs on the minimap.
- **Roof deck (12.14):** `colliders.addDeck` gained `owner` + exclusion — the van must
  not ground on its own roof (self-referential lift-off). The deck record is mutated
  per frame to follow the van; landed drones inside the old radius are teleported by
  the frame delta, so the roof CARRIES them. Verified: lift seats at exactly 2.48 m.
- **Buried samples (12.15):** `buried: { surveyZone }` samples have NO marker, ever.
  Recon fog coverage of the named zone ≥0.65 flips `surveyed` (toast: SUBSURFACE
  ANOMALY LOCATED) — TGT then points at bare coordinates; only the humanoid drill
  extracts it. Reveal check runs OUTSIDE the mission gate: fog is session-only,
  mission completion persists.
- **Cargo bay (12.16):** the DRIVEN van auto-loads field caches within 6 m (cap 3),
  bulk-delivers within 12 m of the lab pad through the same path as the sling
  (lab.deliver + analysis queue + 'deliver' broadcast).
- **Sensor cone (12.17):** additive nadir cone + footprint ring under the recon
  (tan ~26° half-FOV), only while it's the driven unit and airborne. Pure visual.

## Landmines for future waves

- Deck records with an `owner` are invisible to that unit's `forUnit` facade only —
  bare `colliders.deckHeight(x,z)` still sees them (that asymmetry is the fix).
- The photo mission's `count: 4` in missions.js must track `photoSpots.length`.
- Buried reveal + forward-base + return-base are per-frame `advance()` broadcasts —
  keep them idempotent (no-op unless a chain waits) when adding chains.
- E2E on SwiftShader: never measure rates over wall time — count rAF ticks.
