# 21 — Gale HiRISE fidelity bump + Gale↔Jezero feature sync

**Goal:** (1) Pull the real HiRISE/1m-DEM detail Gale is currently throwing away into
the rendered + physics terrain; (2) bring Gale to full gameplay parity with Jezero, since
the two sites diverged as Waves 4–12 landed Jezero-first. After this, both sites play
identically and Gale looks as sharp as its sources allow.

**Decisions locked (2026-07-18):** heightmap → 4096 / albedo stays 4096 (lowest OOM
risk, no albedo asset split); full feature parity + data-driven mission counts.

---

## Part A — Gale HiRISE fidelity bump

### Current state
`sites.js` gale / `prep_site.sh` gale block:
- DEM source = **1m** `MSL_Gale_DEM_Mosaic_1m_v3` → heightmap **2048px = 4.4 m/px**
  (undersampling the native DEM ~4×).
- Ortho source = **0.25m** HiRISE LRGB → albedo **4096px = 2.2 m/px** (kept).
- `segments`: desktop 640, mobile 192. `clipQuads`: 96 / 64.

### Why the bump is now affordable (Wave 5 changed the cost model)
The `sites.js` note "512→25.6ms … 640 is the knee, 768 costs 35ms" was measured on the
**pre-Wave-5 single full plane** (`seg²·2` triangles everywhere) and is **stale**. Under
the Wave 5 geometry clipmap (`terrain.js:163`), render triangle count is `≈ levels · m² · 2`
— independent of `seg`. Raising `seg` now only:
1. shrinks the finest near-camera step `s0 = worldSize/seg`, and
2. adds **one** clipmap level per doubling (`K = ceil(log2(seg/m))`) ≈ `m²·2 ≈ 18k` tris.

So finer near-camera geometry is cheap. The real ceilings became **memory** and **CPU
grid build time**, not per-frame triangles.

### Changes
1. **`scripts/mars-terrain/prep_site.sh`** — gale case: `HEIGHTMAP_RES=2048 → 4096`
   (2.2 m/px, matches the 1m DEM). `TEXTURE_RES` stays 4096. Update the header comment
   ("2048 for Gale" → "4096 for Gale") and the inline rationale.
2. **Re-run `./prep_site.sh gale`** (offline; needs GDAL + S3-mirror network). Re-bake
   the printed `elevMin`/`elevMax` into `sites.js` — finer resampling shifts them
   slightly; do **not** keep the 2048-era values.
3. **`sites.js` gale `segments`**: desktop `640 → 1024` (s0 = 8.8 m quads, was 14.1 m),
   mobile stays 192. Rewrite the stale ms-per-frame comment to describe the clipmap cost
   model + the memory/grid-build ceilings instead. (seg=1024, m=96 → 5 levels; steps
   8.8/17.6/35.2/70.3/140.6 m; outer footprint 13.5 km > 9 km worldSize. ~88k tris.)
4. **Mobile heightmap guard (per-device URL).** The heightmap is decoded via
   `canvas.getImageData` for the CPU sampler (`terrain.js:38`). 4096² = 16.7M px is
   **exactly at the iOS Safari canvas ceiling** and a 67 MB pixel copy. Keep the existing
   2048 file as the mobile heightmap:
   - `prep_site.sh` gale: also emit `heightmap-mobile.png` at 2048 (or retain the current
     2048 as that file before regenerating the 4096).
   - `sites.js` gale: add `heightmapUrlMobile: 'assets/gale/heightmap-mobile.png'`.
   - `main.js`/`terrain.js`: `loadTerrain` picks `heightmapUrlMobile` when
     `matchMedia('(pointer: coarse)')` and the field exists; desktop uses `heightmapUrl`.
   - The CPU grid is `(seg+1)²` regardless of heightmap res, so mobile physics is
     unaffected by which heightmap it decodes.
5. **Release the transient pixel array.** After the `grid` build loop (`terrain.js:232`),
   null the `pixels`/`ctx` refs so V8 can GC the 67 MB desktop copy (the `CanvasTexture`
   keeps its own backing store for the GPU heightmap).

### Memory budget (desktop, worst case)
- Heightmap GPU texture 4096² RGBA, no mips = **67 MB VRAM**.
- Albedo 4096² + mips ≈ **89 MB VRAM**. Terrain textures ≈ 156 MB.
- Transient heightmap canvas decode ≈ 67 MB (freed after grid build, step A5).
- CPU grid seg=1024 → 1025²·4 = **4.2 MB**; build ≈ 1.05M bilinear samples (fast).

### Verify (Part A)
Use the `verify` skill (headless Chromium on `public/mars-colony?site=gale`), CDP canary
**before** `goto` (per project memory). Check: no sinking / correct ride on the finer grid,
no clipmap seams, frame time on the weakest desktop tier, load time, and **mobile
viewport** boots on the 2048 heightmap without an OOM/canvas failure.

---

## Part B — Gale ↔ Jezero feature sync

### Why this is ~90% a data task
The engine is fully data-driven. The **only** per-site branch outside `sites.js` is a
deterministic salt in `rocks.js:46`. Every system no-ops when its field is absent
(`?? []`, optional chaining): missions, `surveyZones`, `photoSpots`, `hazards`, `hq`,
buried cores, sample `outpost`s. So parity = populate the Gale object with real Gale
geography, plus **one** code coupling fix.

### The one code fix — data-driven mission counts
`missions.js` hardcodes Jezero's array lengths:
- `survey` step `scan-zone` → `target: 3` (`missions.js:60`)
- `photo` step `photo-count` → `count: 4` + "IMAGE ALL FOUR TARGETS" text (`missions.js:73`)

Make `createMissions(site, …)` resolve these from `site.surveyZones.length` /
`site.photoSpots.length` at instance-build time (patch a per-instance copy of the step;
don't mutate the shared `MISSIONS` template). Generalize the photo text to "IMAGE ALL
TARGETS FROM THE AIR (P)". Then either site can carry any count.

### Gale data to add to `sites.js` (real geography; finalize coords at build)
World frame: origin = crop center (137.40264°E, −4.65629°N), x=east, z=south, valid ±4500.
Anchored to existing Gale sample coords already in `sites.js`.

- **`surveyZones`** (3 recon scout targets, spread across quadrants):
  - `bagnold` — Bagnold Dunes active dune field ≈ (−700, 1500), r 200
  - `peace-vallis` — Peace Vallis alluvial fan ≈ (900, −4200), r 180
  - `vera-rubin` — Vera Rubin Ridge ≈ (−1450, 3860), r 200
- **`photoSpots`** (aerial photo-recon; count now data-driven — 4 to mirror Jezero):
  - `murray-buttes` Murray Buttes ≈ (−1250, 2500)
  - `vera-rubin-ridge` Vera Rubin Ridge ≈ (−1450, 3860)
  - `yellowknife-bay` Yellowknife Bay ≈ (2375, −3560)
  - `mount-sharp-foothills` Mount Sharp foothills / South Ridge ≈ (2600, 3300)
- **`missions`**: `['tutorial', 'survey', 'photo']`.
- **`hq`**: `{ name: 'Signal Gale Station' }`.
- **`hazards`**: `softSand` anchored on the real active dunes —
  Bagnold main (−700, 1500, r 220, 0.7), a second Bagnold patch, and the sandy floor near
  Peace Vallis; `dustStorm.peakIntensity ≈ 0.6`.
- **Buried subsurface core** (survey-gated dig; `buried.surveyZone` must match a zone id):
  a lakebed core gated by `surveyZone: 'bagnold'` (or `peace-vallis`), with a `[SIM]`
  finding consistent with Gale's lacustrine record.
- **Sample `outpost` checkposts** on the key drill sites: John Klein, Cumberland,
  Windjana, Buckskin, Vera Rubin — mirroring Jezero's per-sample `outpost: { name: … }`.

### Verify (Part B)
`verify` skill on `?site=gale`: survey mission (3 zones) and photo mission (4 targets)
complete and their counts match the arrays; hazard soft-sand zones bog the rover on the
dunes; buried core reveals only after its survey zone is mapped; HQ builds after all
missions complete; sample outposts place. Re-run the Jezero scenario to confirm the
data-driven-count refactor didn't regress Jezero (still 3 / 4).

---

## Part C — Docs & wrap-up
- This game plan (21). Build log row after any push (per `docs-conventions.md`).
- As-built doc after the work lands; `issues-and-resolutions.md` for any bug fixed.
- No infra/API change → no architecture/diagram update needed.

## Sequencing
1. Part B code fix (data-driven counts) + Gale data — playable parity, no asset regen.
2. Part A prep_site regen + seg/mobile-URL wiring — fidelity bump.
3. Verify both sites; docs.

(Rationale for B-before-A: parity is pure data/one refactor and unblocks playtesting Gale
immediately; the asset regen is the slower, network-bound step.)

---
Lead Designer and Prompter: Ankit Srivastava
Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
