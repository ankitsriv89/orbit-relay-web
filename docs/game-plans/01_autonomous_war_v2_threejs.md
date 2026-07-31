# 01 — Autonomous War V2 (Three.js port + graphics overhaul)

**Goal:** Build a Three.js version of *Autonomous War* (`/game-v2/`) at full feature parity with the
Babylon.js original (`/game/`), then push the graphics/performance well beyond it. Keep the Babylon
version untouched. Surface both on the SIGNAL hub landing page with descriptions.

This realises the README's stated intent ("Future experiments — Autonomous War v3 / three.js — drop
into `public/`") and the memory note calling SIGNAL the "future AW v3 home".

## Decisions (confirmed with user)

- **Scope:** full feature parity + enhancement — all 7 arenas, 5 enemy types, 3 weapons, 10 waves,
  grenades, pickups, particles, radar, combo/killstreak, damage direction, procedural audio.
- **Loading:** self-hosted Three.js **ES modules + `<script type="importmap">`**, no build step,
  no CDN dependency (mirrors the self-hosted-Babylon reliability pattern).
- **Path:** `/game-v2/`. Hub shows two game cards (Babylon v1 + Three.js v2).

## Source mapping (Babylon → Three.js v2)

| Babylon module | Lines | V2 plan |
|---|---|---|
| `scenes.js` | 1241 | **Reuse near-verbatim** — pure data (only `Math.PI`). Copy as ES module `scenes.js` with `export`. |
| `audio.js` | 689 | **Reuse verbatim** — pure Web Audio. Copy as ES module. |
| `hud.js` | 502 | **Rewrite as DOM/CSS** — Babylon.GUI 2D overlays → HTML elements (cleaner, no GUI dep). |
| `enemies.js` | 848 | **Rewrite** — `Color3`→`THREE.Color`, `TransformNode`→`Group`, `instantiateModelsToScene`→GLTF `clone`, `PointLight`, billboard HP bars→sprites, dust→GPU points. |
| `game.js` | 2870 | **Rewrite** — `Engine`/`Scene`→`WebGLRenderer`+`Scene`, `UniversalCamera`→`PerspectiveCamera`, `ShadowGenerator`→PCFSoft shadow maps, `GlowLayer`→`UnrealBloomPass`, `pickWithRay`→`THREE.Raycaster`, `ParticleSystem`→pooled `Points`/sprite systems, `DynamicTexture`→canvas textures, `registerBeforeRender`→update list. |

## v2 file layout

```
public/game-v2/
  index.html              importmap + module entry; overlays (start/gameover/win/settings), scene picker
  css/style.css           extracted styles (no inline <style>/<script> per CLAUDE.md)
  vendor/three/           self-hosted three.module.js + core + addons/{loaders,postprocessing,shaders,utils}
  src/
    main.js               boot, engine, render loop, state machine, input, shooting, grenades, pickups
    scenes.js             scene configs (data) + buildScene() environment builder
    enemies.js            ENEMY_TYPES, WAVE_CONFIGS, WaveManager, Enemy class
    hud.js                DOM HUD, radar, damage-direction indicator
    audio.js              procedural Web Audio (verbatim from v1)
    fx.js                 particle pools (fire/smoke/spark/explosion), post-processing setup, texture factories
  assets → reference ../game/assets (no duplication: 14 GLBs + 7 ground + 7 skybox textures)
```

## Graphics enhancements over v1

- **Renderer:** ACESFilmic tone mapping, sRGB output, physically-correct lights, PCFSoft shadows.
- **Materials:** `MeshStandardMaterial` (PBR: roughness/metalness) instead of Babylon `StandardMaterial`.
- **Post-processing:** EffectComposer → RenderPass → UnrealBloomPass (replaces GlowLayer, stronger) →
  optional SSAO (high preset) → OutputPass (tone map + sRGB) → CSS vignette/scanlines on top.
- **Shadows:** directional sun with tuned shadow camera frustum fit to play area; soft PCF.
- **Particles:** GPU `THREE.Points` pools with additive blending + soft round sprite; reused, not
  per-shot allocated (perf win over v1's per-event ParticleSystem churn).
- **Quality presets** (auto/low/medium/high): pixel ratio cap, shadow map size, bloom on/off, SSAO
  on/off, particle scale, post-processing on/off. Auto-detect by cores/DPR/mobile.
- **Fog:** exp2 fog matched to scene config; sky sphere via equirect texture or procedural canvas.

## Parity checklist (must all work)

Movement (WASD+slide collision) · pointer-lock mouse-look (clamped pitch) · 3 weapons (rifle/shotgun/
minigun, spread, auto, reload, ammo) · weapon switch (1/2/3 + scroll) · grenades (G, arc, AOE) ·
raycast hits + headshots + wall sparks · explosive barrels (chain AOE) · 5 enemy types w/ AI (seek,
zigzag, fly, fire-back tracers, footsteps) · health bars · death collapse+explosion · 10 waves +
preview + end-of-wave stats + pickups between waves · radar minimap · damage-direction arrow ·
combo + killstreak · low-HP heartbeat/vignette · screen shake · reload dip · scene picker (7 arenas) ·
settings (volumes, sensitivity, fog, quality) · pause/mute · procedural SFX + ambient + music ·
global soundtrack mini-player + EXIT to hub.

## Deploy

No build step. `wrangler pages deploy public --project-name signal-playground` ships `/game-v2/`
alongside `/game/`. Assets referenced from `../game/assets` resolve under the same Pages origin.
