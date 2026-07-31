# Wave 10 — HUD/layout reshuffle (as built, 2026-07-17)

Plan of record: `~/.claude/plans/few-more-bugs-i-effervescent-wigderson.md` items #13-#16
plus the carry-overs Wave 9 deferred here. Built after Wave 11 (placement/3D/naming);
verified 21/21 across desktop 1440×900, portrait 390×844, landscape 844×390.

## As built

- **10.3+10.2 desktop reshuffle** (`e1cf7fe`, one media block `(min-width:900px) and
  (pointer:fine)` LAST in the HUD cascade): map column (minimap → compass → GPS, clock
  strip inside the minimap) mirrors to the LEFT; telemetry takes top-right; GEAR drops to
  the freed bottom-right corner; drone board docks bottom-left above the inventory.
  Bottom-center stays clear for the chase-cam-framed unit. GEAR and dronectl never
  co-show (rover-only vs drone-only) but keep separate docks for muscle memory.
- **10.4 OVERLAYS dropdown** (`ded45d3`): top-bar button, desktop-only (390px bar is
  full). Mirrors the menu's PHOTO/ELEVATION/SLOPE/PATH through the SAME handler +
  is-active list (`#mc-overlay-modes button, #mc-drop-modes button` — one array), plus a
  live `SAMPLES n/total · ANALYZED n` tally fed by setInventory (boot state set at
  construction — setInventory only fires on the first change). Static panel contents;
  closes on outside pointerdown.
- **10.1 landscape-first mobile** (`ba76cd1`): CSS-only rotate card
  `(orientation:portrait) and (pointer:coarse) and (max-width:899px)` dims + blocks
  input; `screen.orientation.lock('landscape')` attempted best-effort (boot + first
  pointerdown) and quietly rejected elsewhere (iOS Safari unsupported, others
  fullscreen-gated).
- **Carry-overs** (`c877880`): `makeLabel`/`plateScale` exported from outposts.js →
  FIELD LAB wears the same camera-scaled plate (`lab.update(dt, camera)` now takes the
  camera). Landscape phones `(orientation:landscape) and (pointer:coarse) and
  (min-width:700px)`: NV button returns to the top bar, GPS card docks BESIDE the
  right-rail minimap (`right:160px`), inventory chip moves beside the telemetry card.

## Gotchas recorded

- The telemetry card renders **208px wide** on mobile (`max-width:186` is content-box +
  20 padding + 2 border) — anything docked beside it must clear 220px, not 198px.
- The mobile inventory chip's portrait lift (`bottom: calc(min(45vw,260px) + 10px)`)
  lands ON the telemetry card in landscape (45vw > screen height) — landscape gets its
  own dock.
- Playwright `is_mobile=True, has_touch=True` correctly drives the `pointer:coarse` +
  `orientation` media queries — DOM-rect assertions beat screenshots for layout checks
  on this box.

## Deferred

- Wave 9.5 B-items (Ariana hologram / recon scan mission / humanoid tether / repair
  shop) — user picks before build. Their UI now lands in this stabilized layout.
