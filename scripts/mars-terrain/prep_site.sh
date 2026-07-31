#!/usr/bin/env bash
# ============================================================
# prep_site.sh — offline, one-time real-Mars-terrain asset prep.
#
# NOT part of the game runtime. Run manually whenever a site's
# heightmap/texture needs (re)generating. Requires GDAL (gdal_translate,
# gdalwarp, gdalinfo — v3.8.4 confirmed on the dev machine).
#
# Usage:
#   ./prep_site.sh jezero
#   ./prep_site.sh gale
#
# Output (per site), written directly into
# standalone/public/mars-colony/assets/<site>/:
#   heightmap.png   RG-packed 16-bit elevation (R=high byte, G=low byte;
#                   see pack_rg16.py) — 1024px default, 4096 for Gale
#   heightmap-mobile.png  Gale only: a 2048px downsample of the same map
#                   (packed at the SAME elev scale) — the 4096
#                   canvas.getImageData() decode sits at the iOS Safari
#                   canvas ceiling, so phones load this instead.
#   albedo.jpg      JPEG quality 85 — 2048px default, 4096 for Gale
#                   (its HiRISE source is 0.25 m/px; 2048 over 9 km wasted it)
#
# All sources are read via GDAL /vsicurl/ (HTTP range reads) against the
# asc-pds-services S3 mirror — the planetarymaps.usgs.gov URLs redirect
# there anyway, and /vsicurl/ stalls on the redirecting host. Only the
# cropped AOI ever touches local disk, so even Gale's 3.6GB DEM and its
# multi-GB HiRISE ortho COG are safe on a disk-constrained machine.
#
# AOI bounds below are in the rasters' native SRS: Equirectangular
# Mars 2000 Sphere (R=3396190m), units = meters; 1 degree = 59274.6975m.
# They were derived from real mission geography (see the case blocks)
# and verified in-bounds against every source raster's actual extent
# (gdalinfo, 2026-07-08):
#   Jezero DTM/ortho  x[4573663..4605583]  y[1079453..1109693]  (20m / 6m px)
#   Gale DEM          x[8127993..8160973]  y[-302221..-244781]  (1m px, Float32,
#                     NoData -32767)
#   Gale ortho COG    x[8140000..8149000]  y[-289000..-270000]  (25cm RGB,
#                     full overview pyramid — the warp reads a coarse level,
#                     NOT base resolution)
# The Gale ortho corridor is only 9km wide — that is what fixes Gale's
# worldSize at 9000, not the DEM.
# ============================================================
set -euo pipefail

SITE="${1:?Usage: prep_site.sh <jezero|gale|gusev|syrtis|insight|meridiani>}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${SCRIPT_DIR}/../../public/mars-colony/assets/${SITE}"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

# Per-site overrides live in the case blocks below (Gale's 1m DEM and
# 0.25m HiRISE ortho earn 2048/4096; Jezero's 20m/6m CTX pair does not).
HEIGHTMAP_RES=1024        # heightmap.png is HEIGHTMAP_RES x HEIGHTMAP_RES
HEIGHTMAP_MOBILE_RES=     # optional phone-safe downsample (Gale sets it)
TEXTURE_RES=2048          # albedo.jpg is TEXTURE_RES x TEXTURE_RES

# ---- per-source overrides for the "regional" sites -------------------------
# The mission-site DTM/ortho pairs share one SRS, so one set of bounds does
# both. The global products do NOT: the HRSC/MOLA blended DEM is in DEGREES
# while the CTX Robbins quads are Equirectangular Mars METRES (lon_0 = -180).
# A site whose DEM and ortho disagree sets DEM_* in the DEM's own units;
# unset, they fall back to the shared ULX/ULY/LRX/LRY below.
DEM_ULX=; DEM_ULY=; DEM_LRX=; DEM_LRY=
# The CTX quads are 16-bit; JPEG output must be Byte, so those sites set
# ORTHO_SCALE=1 to add "-ot Byte -scale". Leave it EMPTY for the 8-bit
# mission orthos — an unconditional -scale would contrast-stretch Jezero and
# Gale into different-looking albedo than they ship today.
ORTHO_SCALE=

S3="https://asc-pds-services.s3.us-west-2.amazonaws.com"

case "$SITE" in
  jezero)
    # 6km x 6km centered at (77.415E, 18.455N) = (4588750.7, 1093914.5)m —
    # spans Octavia E. Butler Landing (+2127,+615) -> Séítah -> western
    # delta front (Wildcat/Skinner Ridge) -> Neretva Vallis (Cheyava Falls).
    DEM_SRC="/vsicurl/${S3}/mosaic/mars2020_trn/CTX/JEZ_ctx_B_soc_008_DTM_MOLAtopography_DeltaGeoid_20m_Eqc_latTs0_lon0.tif"
    ORTHO_SRC="/vsicurl/${S3}/mosaic/mars2020_trn/CTX/JEZ_ctx_B_soc_008_orthoMosaic_6m_Eqc_latTs0_lon0.tif"
    ULX=4585750.7; ULY=1096914.5; LRX=4591750.7; LRY=1090914.5   # 6000m
    ;;
  gale)
    # 9km x 9km centered at (8144500, -276000)m = (137.4026E, 4.6563S) —
    # x-range is EXACTLY the HiRISE ortho corridor. Spans Bradbury Landing
    # (+2315,-3959) -> Yellowknife Bay (John Klein/Cumberland) -> Murray
    # formation -> Vera Rubin Ridge (-1342..-1579,+3777..+3954).
    DEM_SRC="/vsicurl/${S3}/mosaic/Mars/MSL/MSL_Gale_DEM_Mosaic_1m_v3.tif"
    ORTHO_SRC="/vsicurl/${S3}/mosaic/Mars/MSL/MSL_Gale_HiRISE-LRGB_78quads_sharp_cog.tif"
    ULX=8140000; ULY=-271500; LRX=8149000; LRY=-280500           # 9000m
    HEIGHTMAP_RES=4096          # 1m source DEM: 2.2m/px at 4096 (vs 4.4 at 2048)
    HEIGHTMAP_MOBILE_RES=2048   # phone-safe downsample of the same (see header)
    TEXTURE_RES=4096            # 0.25m HiRISE: 2.2m/px at 4096 (vs 4.4 at 2048)
    ;;
  gusev)
    # 6km x 6km centered at (175.50523E, 14.59151S) = (-266426.2,
    # -864907.4)m — the MIDPOINT of Spirit's mission arc, not its landing
    # site. Centering on the landing itself (175.4729E, 14.5692S) clipped
    # Columbia Hills off the east edge and yielded only 78m of relief;
    # this framing puts Spirit's Columbia Memorial Station in the NW
    # (world -1916, -1323) and the Husband Hill massif in the SE
    # (+1916, +1323), i.e. the real 4.7km drive, with ~145m of relief.
    # Hill positions were derived by sampling this DTM for local maxima
    # rather than from published coordinates — the topography IS the
    # source of truth here.
    # Same 20m-DTM + 6m-ortho pairing as Jezero, from the Mars 2020
    # landing-site candidate survey (the DTM long outlived that role).
    # NOTE: this pair's Eqc has lon_0 = 180, so x = (lon-180)*M_PER_DEG.
    DEM_SRC="/vsicurl/${S3}/mosaic/mars2020_landing_site_dtm/F21_043907_1652_F21_043841_1654_20m_DTM.tif"
    ORTHO_SRC="/vsicurl/${S3}/mosaic/mars2020_landing_site_dtm/F21_043841_1654_XN_14S184W_6m_ORTHO.tif"
    ULX=-269426.2; ULY=-861907.4; LRX=-263426.2; LRY=-867907.4   # 6000m
    ;;
  syrtis)
    # 6km x 6km centered at (21.90430W, 21.65871N) = (9371074.8,
    # 1283813.7)m — the NE Syrtis scarp, picked by scanning the whole DTM
    # for the 6km window with the most relief (933m, vs 1330m across the
    # full 37x46km product). Slopes: median 7.3deg, p90 18.3deg, only 2.7%
    # over 25deg — a big, drivable ramp from the basin floor in the NW up
    # onto the Syrtis Major plateau in the SE, not a cliff wall.
    # NOTE: this pair's Eqc has lon_0 = -180, so x = (lon+180)*M_PER_DEG.
    DEM_SRC="/vsicurl/${S3}/mosaic/mars2020_landing_site_dtm/D21_035237_2021_F01_036358_2020_20m_DTM.tif"
    ORTHO_SRC="/vsicurl/${S3}/mosaic/mars2020_landing_site_dtm/D21_035237_2021_XN_22N022W_6m_ORTHO.tif"
    ULX=9368074.8; ULY=1286813.7; LRX=9374074.8; LRY=1280813.7   # 6000m
    ;;
  insight)
    # 6km x 6km centered EXACTLY on InSight's lander (135.6234E, 4.5024N)
    # = (-2630455, 266878)m, so world (0,0) IS the landing site.
    # Only 67m of relief — and that is the point: Elysium Planitia was
    # picked precisely because it is the flattest, dullest ground on Mars,
    # since InSight was a stationary geophysics station, not a rover.
    # NOTE: these stereo DTMs are angled parallelograms, not filled
    # rectangles. Five of the seven products in this collection have their
    # bounding box over the lander but NO DATA there; this pair is the one
    # that actually covers it (verified with gdallocationinfo: -2613.95m,
    # matching InSight's published elevation).
    # NOTE: this pair's Eqc has lon_0 = 180, so x = (lon-180)*M_PER_DEG.
    DEM_SRC="/vsicurl/${S3}/mosaic/insight_landing_site_dtm/F02_036761_1828_F04_037262_1841_20m_DTM_destripe.tif"
    ORTHO_SRC="/vsicurl/${S3}/mosaic/insight_landing_site_dtm/F04_037262_1841_XN_04N224W_6m_ORTHO.tif"
    ULX=-2633455; ULY=269878; LRX=-2627455; LRY=263878           # 6000m
    ;;
  meridiani)
    # 30km x 30km centered at (5.348W, 2.113S) — the first REGIONAL site.
    # Meridiani has no high-res DEM (nothing but the 200m global blend), so
    # a 6km crop would be 30 elevation samples across: a featureless blob.
    # At 30km the same DEM gives 150 samples AND the crop spans Opportunity's
    # actual 14-year drive — Eagle Crater, where it landed, in the NW
    # (world -10586,-9887), out past Victoria (-10195,-3734) to the rim and
    # floor of the 22km Endeavour Crater in the SE (+10551,+9899).
    # 668m of relief, nearly all of it Endeavour.
    # DUAL SRS: the blended DEM is in DEGREES, the CTX quad in Eqc METRES
    # (lon_0 = -180), so DEM_* carries the degree bounds separately.
    DEM_SRC="/vsicurl/${S3}/mosaic/Mars/HRSC_MOLA_Blend/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif"
    ORTHO_SRC="/vsicurl/${S3}/mosaic/Mars/Mars_MRO_CTX_Equi_Mosaics_Robbins/6mpp/MC19_6mpp.16bit.tif"
    DEM_ULX=-5.601059; DEM_ULY=-1.859941; DEM_LRX=-5.094941; DEM_LRY=-2.366059
    ULX=10337444.5; ULY=-110247.4; LRX=10367444.5; LRY=-140247.4   # 30000m
    TEXTURE_RES=4096     # 6m/px source over 30km = 7.3m/px at 4096
    ORTHO_SCALE=1        # CTX quads are 16-bit; JPEG needs Byte
    ;;
  olympus)
    # 90km x 90km centered on the Olympus Mons caldera complex
    # (133.1678W, 18.3271N). The nested collapse craters measure ~78km
    # across, so 90km frames the whole complex with its rim just inside —
    # 3.75km of relief, the most vertical thing in the game by a factor of
    # four, and elevations that are POSITIVE (+16.8 to +20.6 km) because
    # this is the summit of the tallest volcano in the solar system.
    #
    # The centre was found by IMAGING the DEM, not from published figures:
    # a first pass at the textbook (133.8W, 18.65N) put the caldera in the
    # SE corner and clipped it, and taking the DEM's global maximum landed
    # on a flank high at (133.06W, 17.31N), ~90km off. Rendering relief to
    # PNG and measuring the depression directly was the only reliable fix.
    #
    # At 200m DEM this is 450 samples across — the one regional site where
    # the global blend genuinely matches the scale of the landform.
    # The AOI sits 64km inside MC09's western edge (the quad stops at 135W).
    # DUAL SRS: blended DEM in DEGREES, CTX quad in Eqc METRES (lon_0=-180).
    DEM_SRC="/vsicurl/${S3}/mosaic/Mars/HRSC_MOLA_Blend/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif"
    ORTHO_SRC="/vsicurl/${S3}/mosaic/Mars/Mars_MRO_CTX_Equi_Mosaics_Robbins/6mpp/MC09_6mpp.16bit.tif"
    DEM_ULX=-133.926977; DEM_ULY=19.086277; DEM_LRX=-132.408623; DEM_LRY=17.567923
    ULX=2730964.5; ULY=1131333.3; LRX=2820964.5; LRY=1041333.3     # 90000m
    TEXTURE_RES=4096     # 6m/px source over 90km = 22m/px at 4096
    ORTHO_SCALE=1        # CTX quads are 16-bit; JPEG needs Byte
    ;;
  hellas)
    # 30km x 30km centered at (102.97E, 39.56S), on the eastern Hellas
    # basin floor-and-rim transition.
    # RELOCATED from the old LOCKED_SITES pin at (70E, 42.4S): that spot has
    # no CTX coverage at all. The Hellas exploration-zone mosaics sit at
    # 99.66-106.28E / 37.32-41.81S, so the site moved onto the real imagery
    # rather than shipping a Viking-resolution blur.
    # Unlike Meridiani/Olympus, BOTH sources here are in DEGREES (the CTX_EZ
    # mosaics are, unlike the Robbins quads), so one set of bounds does both
    # and no DEM_* override is needed.
    # NOTE: at 39.56S the equirectangular projection stretches east-west by
    # 1/cos(lat) = 1.30, so this "30km" square is 30km north-south but about
    # 23km east-west on the actual ground. Same distortion Jezero and Gale
    # already carry, just larger this far from the equator.
    DEM_SRC="/vsicurl/${S3}/mosaic/Mars/HRSC_MOLA_Blend/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif"
    ORTHO_SRC="/vsicurl/${S3}/mosaic/Mars/CTX_EZs/Hellas_Hellas2_CTX_BlockAdj_dd.tif"
    ULX=102.716941; ULY=-39.306941; LRX=103.223059; LRY=-39.813059  # 30000m
    TEXTURE_RES=4096     # 5m/px source over 30km = 7.3m/px at 4096
    ;;
  *)
    echo "Unknown site: $SITE (expected jezero, gale, gusev, syrtis, insight, meridiani, olympus or hellas)" >&2
    exit 1
    ;;
esac

mkdir -p "$OUT_DIR"

# Fall back to the shared bounds unless the site gave the DEM its own.
: "${DEM_ULX:=$ULX}" "${DEM_ULY:=$ULY}" "${DEM_LRX:=$LRX}" "${DEM_LRY:=$LRY}"

echo "== ${SITE}: crop DEM to AOI + resample to ${HEIGHTMAP_RES}px (streamed) =="
# Crop and downsample in one warp: -te takes (xmin ymin xmax ymax).
gdalwarp --config GDAL_HTTP_TIMEOUT 120 --config GDAL_HTTP_MAX_RETRY 5 \
  -te "$DEM_ULX" "$DEM_LRY" "$DEM_LRX" "$DEM_ULY" \
  -ts "$HEIGHTMAP_RES" "$HEIGHTMAP_RES" -r bilinear \
  -of GTiff "$DEM_SRC" "${WORK_DIR}/dem_aoi.tif"

echo "== ${SITE}: elevation min/max =="
gdalinfo -stats "${WORK_DIR}/dem_aoi.tif" > "${WORK_DIR}/dem_stats.txt"
ELEV_MIN=$(grep STATISTICS_MINIMUM "${WORK_DIR}/dem_stats.txt" | cut -d= -f2)
ELEV_MAX=$(grep STATISTICS_MAXIMUM "${WORK_DIR}/dem_stats.txt" | cut -d= -f2)
echo "  elevMin=${ELEV_MIN} elevMax=${ELEV_MAX}  <-- paste into js/sites.js"
# Sanity: a min at/near the Gale NoData value (-32767) means the AOI has
# holes and the 16-bit scale below would be garbage. Abort loudly.
awk -v m="$ELEV_MIN" 'BEGIN { if (m < -10000) { print "FATAL: elevMin " m " looks like NoData leakage — AOI has holes"; exit 1 } }'

echo "== ${SITE}: quantize to 16-bit + RG-pack heightmap.png =="
# Canvas getImageData() is 8-bit per channel, so 16-bit elevation ships as
# R=high/G=low bytes (pack_rg16.py); terrain.js decodes (R*256+G)/65535.
gdal_translate -q -of PNG -ot UInt16 -scale "$ELEV_MIN" "$ELEV_MAX" 0 65535 \
  "${WORK_DIR}/dem_aoi.tif" "${WORK_DIR}/dem_16.png"
PY="${SCRIPT_DIR}/.venv/bin/python"
[ -x "$PY" ] || PY=python3
"$PY" "${SCRIPT_DIR}/pack_rg16.py" "${WORK_DIR}/dem_16.png" "${OUT_DIR}/heightmap.png"

# Mobile heightmap (Gale): downsample the SAME already-local DEM to a
# phone-safe res and pack with the SAME ELEV_MIN/MAX scale, so both maps
# decode to identical meters (terrain.js picks one by device).
if [ -n "${HEIGHTMAP_MOBILE_RES:-}" ]; then
  echo "== ${SITE}: mobile heightmap ${HEIGHTMAP_MOBILE_RES}px (same elev scale) =="
  gdal_translate -q -of PNG -ot UInt16 -scale "$ELEV_MIN" "$ELEV_MAX" 0 65535 \
    -outsize "$HEIGHTMAP_MOBILE_RES" "$HEIGHTMAP_MOBILE_RES" -r average \
    "${WORK_DIR}/dem_aoi.tif" "${WORK_DIR}/dem_mob_16.png"
  "$PY" "${SCRIPT_DIR}/pack_rg16.py" "${WORK_DIR}/dem_mob_16.png" "${OUT_DIR}/heightmap-mobile.png"
  rm -f "${OUT_DIR}/heightmap-mobile.png.aux.xml"
fi

echo "== ${SITE}: crop + resample ortho to ${TEXTURE_RES}px (streamed, uses COG overviews) =="
gdalwarp --config GDAL_HTTP_TIMEOUT 120 --config GDAL_HTTP_MAX_RETRY 5 \
  -te "$ULX" "$LRY" "$LRX" "$ULY" \
  -ts "$TEXTURE_RES" "$TEXTURE_RES" -r bilinear \
  -of GTiff "$ORTHO_SRC" "${WORK_DIR}/ortho_aoi.tif"
gdal_translate -q -of JPEG -co QUALITY=85 ${ORTHO_SCALE:+-ot Byte -scale} \
  "${WORK_DIR}/ortho_aoi.tif" "${OUT_DIR}/albedo.jpg"
rm -f "${OUT_DIR}/albedo.jpg.aux.xml" "${OUT_DIR}/heightmap.png.aux.xml"

echo "== done =="
du -sh "${OUT_DIR}"
echo "Update js/sites.js '${SITE}' with elevMin=${ELEV_MIN}, elevMax=${ELEV_MAX}."
