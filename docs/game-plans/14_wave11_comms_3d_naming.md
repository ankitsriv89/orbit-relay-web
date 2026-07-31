# Wave 11 — Comms 3D pass, base-layout fix, Signal renaming (Jezero)

Approved 2026-07-17. Sequencing decision: **Wave 11 → Wave 10 (HUD reshuffle) → Wave 9.5 (B-items)** —
layout stabilizes before new content lands UI in it. 9.5 item selection still pending user pick
(Ariana hologram / recon scan mission / humanoid tether / repair shop).

## Origin (playtest 2026-07-17)

1. Wave 9 comm setups (relay masts, chargepads) read procedural — want real 3D assets.
2. The HQ built ON TOP of a solar chargepad.
3. Structure name plates far too big.
4. Brand: standalone must have zero `marsapiens` mentions — HQ becomes **Signal Headquarters**.
5. "Getting bogged down — ROCK W/S" confusion → not a bug (Wave 6 soft-sand at Séítah dune
   margins) but the zones are invisible, so it feels random.

## Root causes

- **HQ/pad overlap:** chargepads + comms masts never register with colliders; outposts'
  `findSpot` blocked test only sees registered statics. Boot pad ring 16 vs HQ ring 25 with
  r 11.5 footprint → overlap on the wrong bearing. Placement is re-derived at boot, so the
  fix relocates existing players' HQs automatically.
- **Plates:** `LABEL_H` 3 m × `LABEL_MAX` 7 camera-distance scale → ~21 m sign from a drone.

## Build items (commit locally per item)

1. **Placement dodge** — masts become static colliders (r ~1.2, h 9); outposts `findSpot`
   gains an avoid callback (main.js: pads + masts); pad/mast ring placement itself goes
   statics-aware so boot/onBuilt placements can't stack either.
2. **3D hooks** — `chargepad` entry in `STATIC_MODELS` + `attachStaticModel` in chargepad.js
   (fallback-first, station.glb pattern). Antenna hook already exists. User generates in
   Tripo Studio → `assets/models/antenna.glb` + `chargepad.glb` (mast ~9 m tall; pad ~7 m
   across with solar wings). 404 keeps fallbacks — offline guarantee intact.
3. **Plates smaller** — LABEL_H 3→1.8, LABEL_MAX 7→3; verify at chase-cam + drone distances.
4. **Rename** — sites.js `hq.name` → 'Signal Headquarters'; hud.js tutorial line;
   colony-stats topbar → `SIGNAL · MARS COLONY · MISSION CONTROL`; README reworded.
   Scope: code + public + README only (docs history stays).
5. **Soft-sand minimap layer** — tan translucent circles via fog.js `extras` (caches idiom).
   In-world dune decals rejected: 170 m flat disc fights the bumpy terrain mesh on this GPU.
6. **Visual verification pass** — verify-skill headless captures: lab base layout, HQ spot,
   plates at several distances, masts/pads day + night. Fix what shows; run affected E2E.
