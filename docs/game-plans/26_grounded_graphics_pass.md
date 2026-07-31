# Plan 26 — Grounded Graphics Pass (Mars Sim, Option 1)

**Goal:** Push Mars Sim's Three.js visuals toward AAA-grade *grounded realism* — make the
**existing real geometry and DEM/orbital data** read like real Mars footage. No generated
assets, no geometry changes. Lighting/shading/VFX layers only. NASA-accurate identity preserved 100%.

Driven by the `threejs-aaa-graphics-builder` skill, run in an adapted **grounded-realism profile**:
the skill's external-asset-sourcing gates (Tripo 3D, Gemini textures for hero surfaces) are
deliberately **skipped** — hero surfaces (rover, humanoid, drone, van, terrain) are real NASA
forms and must not be re-modeled/stylized. Only render/lighting/material recipes apply.

## Baseline (already strong — not "basic")
- ACES Filmic tone mapping + tuned exposure (`main.js:185`)
- Image-based lighting: procedural Mars sky baked via `PMREMGenerator` → `scene.environment` (`main.js:84-203`)
- Custom terrain clipmap shader with sun dir + fog (`terrain.js:56-195`)
- PBR `MeshStandardMaterial` w/ `envMapIntensity`; procedural sky shader; day/night `FogExp2`; mobile/desktop QUALITY tiers

## Gaps this plan fills
| Gap | Fix | Real-data risk |
|---|---|---|
| No dynamic shadows anywhere | Sun-cast PCFSoft shadows, moving ortho frustum | Zero — looks *more* like footage |
| No post-processing | EffectComposer: GTAO (AO) + subtle bloom + OutputPass + vignette | Zero — pixel math on existing geometry |
| Flat surfaces up close | Procedural detail normal maps on terrain + rock | Low — micro-relief only, no new shapes |

## Constraint: offline / vendored Three (r185)
Capacitor native build resolves `three/addons/` → `public/mars-colony/vendor/three/addons/`
(only `loaders`+`utils` present today). Post-processing addons are **NOT** vendored and cannot
load from a CDN (CSP + offline WebView). **Wave 1 must vendor the r185 post-processing closure**
(`npm pack three@0.185.0`) and verify offline import before any composer code.

## Waves (each = one checkpoint commit, no push)
1. **Vendor post-processing addons** — extract r185 `jsm/postprocessing/*` + `jsm/shaders/*`
   dependency closure for EffectComposer, RenderPass, GTAOPass, UnrealBloomPass, OutputPass,
   ShaderPass, VignetteShader. Copy into `vendor/three/addons/{postprocessing,shaders}/`.
   Update `vendor/three/VERSION.txt`. Verify every `import` resolves offline (node module-load smoke).
2. **Shadows** — `renderer.shadowMap = PCFSoftShadowMap`, `outputColorSpace = SRGBColorSpace`;
   `sun.castShadow`, ortho `sun.shadow.camera` sized to a bounded radius around the camera
   (sun already follows camera → moving frustum), tuned `bias`/`normalBias`; flag casters
   (rover, recon, lift, humanoid, van, rocks, outposts, sample markers) + terrain `receiveShadow`.
   Gate shadow-map size by QUALITY (smaller/off on mobile). Do not let shadows hide collision reads.
3. **Post-processing pipeline** — `EffectComposer` (HalfFloat targets): `RenderPass` → `GTAOPass`
   (**desktop only**, contact AO in crevices/under units) → `UnrealBloomPass` (low strength, high
   threshold — sun glint on metal only, not a wash) → `OutputPass` (moves ACES tone-map + sRGB to
   pass end, bloom stays linear-HDR) → subtle `VignetteShader`. Route **both** render sites
   (`main.js:860`, `main.js:1446`) through the composer; resize updates composer + pass resolution.
   Gate GTAO/bloom by QUALITY.
4. **Detail normal maps** — perturb terrain fragment-shader normal from height derivatives / procedural
   noise; add a canvas-noise `normalMap` to rock material. Stable under motion (clipmap ring), no tiling swim.
5. **Verify + re-score** — Playwright headless (per `.claude/skills/verify`), before/after desktop
   + mobile (375x812) screenshots, `renderer.info` diagnostics (draw calls/tris/programs), console
   error scan, canvas-pixel check. Re-run the AAA visual scorecard. Update this doc as-built.

## Performance guardrails (OOM history — plan 24)
- Screen-space passes (GTAO/bloom) add **GPU fill cost only**, no new meshes — safe from OOM.
- All new cost gated behind existing `QUALITY.coarse` (mobile): shadows small/off, GTAO off, bloom optional.
- DPR already capped at 2. After each wave: capture `renderer.info` + frame evidence; if FPS drops,
  cut post/shadow cost first (per render-recipes.md).
- WebGL context-loss telemetry already wired (`main.js:179`) — watch it during verify.

## Out of scope (Option 2/3 — not this plan)
- Photoreal generated regolith/rock PBR textures (Gemini) — Option 2, later.
- Tripo 3D set-dressing / hero re-models — Option 3, rejected for real-data drift.

## AS-BUILT (2026-07-20)
- **Wave 1 DONE** (`3fbff89f`): 15-file r185 post-processing closure vendored + offline-verified.
- **Wave 2 DONE but GATED OFF** (`087786d2` build, `f96c66ba` gate): full sun-shadow pipeline
  — moving ortho frustum, caster sweep, hand-rolled terrain PCF sampler, tightened bias/frustum.
  Casters render into the 2048 map correctly (verified: 4.7% occupied, valid packed depth), but
  **cast shadows don't appear under SwiftShader** (headless verify GPU) — a quirk sampling a
  shadow render-target texture inside a custom `ShaderMaterial`. Not confirmable on a real GPU
  from this box. `SHADOWS=false` in main.js; whole path no-ops when off (tris 176k→118k, zero
  errors, terrain renders clean). **Flip `SHADOWS` to `!QUALITY.coarse` to test on real hardware.**
- **Waves 3–5 DEFERRED**: per user redirect (2026-07-20) — "gameplay best, skip visual additions
  that aren't working, don't burn tokens." Shadows (the flagship win) didn't land in the verifiable
  env, so the remaining lower-value visual waves (post-processing, normals) are paused pending a
  decision to (a) stop here, or (b) do only the cheap/reliable screen-space color-grade + vignette.

## References consulted (skill gates)
- `render-recipes.md`, `checklists/material-lighting-quality.md`, `checklists/performance-safe-visual-detail.md` — loaded.
- `visual-scorecard.md` + `checklists/aaa-visual-scorecard.md` — to load at Wave 5 (scoring gate).

---
Lead Designer and Prompter: Ankit Srivastava
