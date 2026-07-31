# Mars Colony — Asset Branding, Unit Scale & Drone Altitude Control

Built 2026-07-10 (follow-on to `06_terrain_roughness_movement.md`). User direction via Q&A: brand-tinted metal panels in **cyan/teal** (NOT the amber logo color), **color-only** (no logo decal — Tripo's UV atlases are auto-unwrapped scatter charts, per-panel painting isn't practical), and a **real-world size bump** for the small-reading units.

## Materials (models.js `applyBrandFinish`)

All four GLBs shipped with Tripo's flat defaults (roughness 0.9/0.5, metalness 0, no tint — verified in each GLB's JSON). Now, on load:
- roughness 0.38, metalness 0.6, envMapIntensity 1.2
- `color.lerp(0x2ec4d6, 0.22)` — cyan-teal multiply on top of the basecolor texture (subtle; the humanoid's existing teal suit panels pop hardest)

**Metalness needs an environment**: with no envMap, PBR metal reads flat-dark. `createMarsEnvMap()` in main.js bakes a tiny Mars-toned gradient sphere (same horizon/zenith colors as the sky shader) through `PMREMGenerator` into `scene.environment` — one-time cost, no asset, no extra draw calls. Renderer also gained `ACESFilmicToneMapping` (exposure 1.05) so highlights roll off instead of clipping.

## Unit scale (models.js MODELS)

Chase cam frames the rover's 3m; strictly-real-scale smaller units read lost on screen:
- drone 2.0 → 2.5m, recon 1.1 → 1.4m, humanoid 1.8 → 2.2m, rover unchanged (3.0m).

## Drone altitude (drone.js + hud.js + main.js + style.css)

- Ceiling `MAX_ALT` 60 → **150m** AGL.
- **Vertical altitude slider** in the drone HUD panel (0 at bottom → 150m at top): dragging commands `commandAlt(t)` — an autopilot that takes off (if landed), climbs/descends proportionally (eased inside ~2m), and **lands when dragged to the floor**. One control spans the full vertical envelope.
- Manual climb input (R/F / touch) always cancels the slider target; knob live-tracks actual altitude when not dragging; slider blurs after change so arrow keys don't re-command it.
- Vertical slider CSS = `writing-mode: vertical-lr` + `direction: rtl` (modern Chrome/FF/Safari; project already requires modern via three 0.185).

## Mobile layout fix (same session)

Full-size drone board covered half a small portrait screen and buried the sticks:
- Root cause #1: `.mars-hud__dronectl` had `align-items: stretch` — the stat chip and LAND button ballooned to the alt-slider column's full height. Now `center`.
- Coarse/narrow media block: slider 62px, compact stat/button/gaps; board measures ~190×100px (6–9% of screen, zero touch-zone overlap — verified with bounding-rect checks at 375×812 and 390×560).
- Inventory becomes a counts-only chip (list hidden) lifted above the left stick zone — it sat right on the resting pad. **Cascade trap**: same-specificity mobile overrides MUST come after the base rules in the file; the first attempt silently lost to the later base rule.
- Resting joystick pads: idle opacity 0.3 → 0.5 (near-invisible over dark terrain was read as "no controls").
- `.mars-dronectl__stat span` nowrap ("ALT 0.0 m" wrapped in the compact chip).
- **Fold-to-chip + right-rail dock (mobile only)**: even compacted, any bottom-center placement sat exactly where the chase cam frames the drone. On phones the board is docked on the right rail below GEAR (minimap → GEAR → drone controls) as a right-aligned COLUMN, and defaults to a small live-altitude chip ("▴ 12 m", ~58×32px) that expands on tap (`data-collapsed` + `.mars-dronectl__toggle`; fold + dock CSS live only inside the coarse/narrow media block so desktop keeps the full bottom-center board). Expanded column is 84px wide at the right edge — clear of the center-framed drone; on very short screens its bottom transiently overlaps the right stick zone's top corner while open. Left-center docking was rejected: collides with the variable-height telemetry panel. State persisted (`mc-dronectl`).

## Verified (headless Chrome, `__mc`)

Materials on all four units (roughness/metalness/tint/envMap applied, scene.environment set, ACES on), autopilot: commandAlt(100) → alt 99.9 & target cleared, →20 → 20.1, →0 → lands, manual climb cancels target, ceiling 150. Slider renders vertical, max 150, tracks live alt. Wide screenshots: rover reads champagne-metal with specular, humanoid/drones bigger + shinier, no JS errors.
