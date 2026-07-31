# 30 — Six new Mars sites (Gusev, NE Syrtis, InSight, Meridiani, Olympus, Hellas)

**Goal:** grow Mars Colony from 2 playable sites to 8, using the best real data that exists
for each location. Every site ships with the full plan-09–28 feature set (missions, hazards,
base-building, checkposts, photo recon, survey zones, buried core, Ariana briefing) — the
engine is fully data-driven, so a site is an asset pair plus one `sites.js` object.

**Why now:** plan 29's Gale-parity pass proved the last Jezero-only content (Ariana's briefing)
is now per-site data. Nothing in the engine is site-specific any more except a PRNG salt, so
adding sites is a data exercise. More sites also front-loads the map variety the roadmap's
multiplayer phase will want.

---

## Data reality (verified 2026-07-25 against the asc-pds-services S3 mirror)

The three sites currently pinned as `LOCKED_SITES` (Hellas, Olympus, Meridiani) have **no
high-resolution DEM**. The best global DEM is `Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif`
at **200 m/px** — 10× coarser than Jezero's 20 m DTM. At a 6 km worldSize that is 30 elevation
samples across: a smooth blob. They are still buildable, but only at a **larger worldSize**.

Two discoveries changed the plan:

1. **`Mars_MRO_CTX_Equi_Mosaics_Robbins/6mpp/`** — CTX quadrangle mosaics at **6 m/px**,
   quads MC08–MC23 (±30° lat). This gives Meridiani and Olympus Jezero-grade *texture* even
   though their geometry stays 200 m.
2. **`mars2020_landing_site_dtm/` and `insight_landing_site_dtm/`** carry co-registered
   **20 m DTM + 6 m ORTHO** pairs — byte-for-byte the Jezero recipe, same meters-Eqc SRS —
   at Gusev, NE Syrtis and Elysium Planitia. These are *better* sites than the pinned three.

### Verified source table

**AS BUILT** — final values after the bakes (two rows changed from the estimates above:
InSight needed a different DTM, and Olympus needed a bigger, re-centred crop).

| Site | DEM source | m/px | Imagery source | m/px | worldSize | relief |
|---|---|---|---|---|---|---|
| **Gusev** | `mars2020_landing_site_dtm/F21_043907_1652_F21_043841_1654_20m_DTM.tif` | 20.2 | `F21_043841_1654_XN_14S184W_6m_ORTHO.tif` | 6.06 | 6 km | 114 m |
| **NE Syrtis** | `mars2020_landing_site_dtm/D21_035237_2021_F01_036358_2020_20m_DTM.tif` | 20.2 | `D21_035237_2021_XN_22N022W_6m_ORTHO.tif` | 6.06 | 6 km | 940 m |
| **InSight** | `insight_landing_site_dtm/F02_036761_1828_F04_037262_1841_20m_DTM_destripe.tif` | 20.2 | `F04_037262_1841_XN_04N224W_6m_ORTHO.tif` | 6.06 | 6 km | 67 m |
| **Meridiani** | `Mars/HRSC_MOLA_Blend/…BlendDEM_Global_200mp_v2.tif` | 200 | `…Robbins/6mpp/MC19_6mpp.16bit.tif` | 6 | 30 km | 673 m |
| **Olympus** | same global blend | 200 | `…Robbins/6mpp/MC09_6mpp.16bit.tif` | 6 | **90 km** | 3407 m |
| **Hellas** | same global blend | 200 | `Mars/CTX_EZs/Hellas_Hellas2_CTX_BlockAdj_dd.tif` | 5.0 | 30 km | 3268 m |

Centres as built: Gusev (175.50523 E, 14.59151 S) · NE Syrtis (21.90430 W, 21.65871 N) ·
InSight (135.62263 E, 4.50239 N) · Meridiani (5.348 W, 2.113 S) ·
Olympus (133.1678 W, 18.3271 N) · Hellas (102.97 E, 39.56 S).

Olympus is the only site with **positive** elevations (+17,629 to +21,036 m) and Hellas the
only one that **crosses the datum** (−694 to +2,574 m).

`dustStorm.peakIntensity` became the per-site atmospheric signature rather than a knob:
Meridiani **0.9** (a global dust storm killed Opportunity) · Hellas **0.85** (a storm nursery)
· Gusev **0.75** (dust devils cleaned Spirit's panels) · Jezero 0.7 · InSight 0.7 · NE Syrtis
0.65 · Gale 0.6 · Olympus **0.35** (a tenth of datum pressure — barely enough air to lift
dust).

**Landing sites confirmed inside coverage:** Spirit (175.4729 E, 14.5692 S), InSight
(135.6234 E, 4.5024 N), Opportunity (354.4734 E, 1.9462 S).

**Hellas must move.** Its current pin (70 E, 42.4 S) has no CTX coverage — the EZ mosaics sit
at 99.66–106.28 E / 37.32–41.81 S. The site relocates onto the real imagery, on the basin's
eastern floor-and-rim transition.

### As-built notes (2026-07-25)

Things that only surfaced once the bakes ran:

- **Stereo DTMs are angled parallelograms, not filled rectangles.** Five of the seven
  products in `insight_landing_site_dtm/` have their *bounding box* over InSight's lander but
  **no data** at it. `gdallocationinfo` across all seven found the one real pair
  (`F02_036761_1828_F04_037262_1841`), which reports −2613.95 m at the lander — a number the
  running game now reproduces as ground −2613.65 m under the spawned rover. Always probe the
  actual pixel, never trust the bounding box.
- **Centre the AOI on the mission arc, not the landing site.** Gusev centred on Spirit's
  touchdown clipped Columbia Hills off the east edge and gave 78 m of relief. Re-centred on
  the midpoint of the real 4.7 km drive it holds both ends and 114 m.
- **Derive feature positions from the DEM, not from memory.** Hill coordinates for Gusev came
  from scanning the DTM for local maxima. The world frame then reproduced Spirit's *published*
  landing coordinate exactly (HUD reads 14.56919 S, 175.47291 E) — which is the real check
  that the whole projection chain is right.
- **Check slopes before accepting a dramatic window.** NE Syrtis was picked by scanning for
  maximum relief; the 940 m result was only kept after measuring median 7.3°, p90 18.3°, 2.7%
  over 25° — i.e. a drivable ramp, not a cliff.
- **`LOCKED_SITES` and `SITES` must not share an id.** `hub.js` concatenates both into one pin
  array, so a site promoted to playable while still listed as locked renders two overlapping
  globe pins. Now guarded by an E2E check.

### SRS gotcha

The two global rasters (HRSC/MOLA blend, CTX Robbins quads) are in **degrees**, while the
landing-site DTM/ortho pairs are in **meters** (Equirectangular Mars 2000, but with differing
`lon_0`: 180 for Gusev/InSight, −180 for NE Syrtis). `prep_site.sh` passes `-te` in the
source's native SRS, so each case block carries bounds in its own units. Degree-SRS sites get
a `-te_srs EPSG:4326`-style explicit bound instead of raw meters.

---

## Two site tiers

**Tier A — traverse sites (6 km, 20 m DTM).** Gusev, NE Syrtis, InSight. Identical treatment
to Jezero: `segments` 384/128, rover-scale traverse, ~13 samples, 3 survey zones, 4 photo
spots, soft-sand hazards on real aeolian ground, HQ + checkposts, one survey-gated buried core.

**Tier B — regional sites (30–72 km, 200 m DEM).** Meridiani, Olympus, Hellas. Same feature
set, but distances are drone-and-van scale rather than rover scale. `segments` raised (the
Wave 5 clipmap decouples render cost from `segments`, so the finest step tracks the DEM, not
the budget) and the mission text/positions spread to match. These read as *expeditions* —
which is exactly what Olympus' caldera and Hellas' basin floor should feel like.

---

## Per-site content (real science, `[SIM]` where invented)

- **Gusev / Columbia Hills — Spirit · MER-A, landed 2004-01-04.** Bonneville Crater, Husband
  Hill, Home Plate, the Troy silica deposits (a candidate hot-spring biosignature), Comanche
  carbonates, Adirondack (first rock target). Completes the rover trilogy with Curiosity·MSL
  and Perseverance·Mars 2020.
- **NE Syrtis — Mars 2020 finalist, unflown.** Olivine-carbonate bedrock, Nili Fossae
  fracture system, ancient hydrothermal alteration. Framed in-game as a survey expedition.
- **InSight / Elysium Planitia — InSight, landed 2018-11-26.** Homestead hollow, SEIS
  seismometer, HP³ "mole", marsquake epicentres. A geophysics station, not a traverse.
- **Meridiani Planum — Opportunity · MER-B, landed 2004-01-25.** Eagle Crater ("hole in one"),
  Endurance, Victoria, Endeavour Crater rim, the blueberries (hematite concretions),
  Heat Shield Rock (first meteorite found on another planet).
- **Olympus Mons.** The caldera complex — six nested collapse craters, ~3 km scarps. Largest
  volcano in the solar system.
- **Hellas Planitia.** Deepest basin on Mars; the relocated AOI covers the eastern floor and
  rim transition where the CTX EZ imagery lives.

---

## Work per site

1. `prep_site.sh` case block (sources, AOI bounds in native SRS, resolutions).
2. Run the bake → `heightmap.png` + `albedo.jpg` (+ `heightmap-mobile.png` where the
   heightmap exceeds 2048). Paste the printed `elevMin`/`elevMax` into `sites.js` — never
   reuse another site's.
3. `sites.js` `SITES` entry: identity, elevation range, worldSize, segments, center,
   `landingUtc`, `tint` (CTX/ortho sources are grayscale → Mars-rust tint; only Gale's HiRISE
   is true colour), spawn, `briefing`, `surveyZones`, `photoSpots`, `missions`, `hq`,
   `hazards`, `samples` (each with `finding`, some with `outpost`, one `buried`).
4. Remove the site from `LOCKED_SITES` so the hub pin becomes playable.
5. Extend `tests/e2e/test_gale_parity.py` to assert the same parity invariants for it.

## Verification

`test_gale_parity.py` generalizes to a site list — it already asserts every per-site system is
populated, all points lie inside `worldSize`, counts are data-driven, hazards bite at runtime,
the briefing names *this* site and leaks no other's proper nouns, and briefing lines fit the
banner at six widths. Plus a manual `verify`-skill pass per site for terrain sanity (no
sinking, no clipmap seams, spawn on solid ground).

---
Lead Designer and Prompter: Ankit Srivastava
Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
