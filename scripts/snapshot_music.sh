#!/usr/bin/env bash
#
# snapshot_music.sh — build the static JSON snapshot for the standalone SIGNAL
# music app, with all media URLs rewritten to a neutral R2 base.
#
# What it does (read-only against the live site):
#   1. GET /music/albums                     -> data/albums.json
#   2. for each album: GET .../tracks        -> data/albums/<ID>.tracks.json
#   3. for each track: GET /music/tracks/<id>-> data/tracks/<id>.json   (lore+lyrics)
#   4. builds data/tracks-default.json       (default queue for the mini-player)
#   5. rewrites every track `url` / `cover_url` from the live host to $R2_BASE
#   6. mirrors the referenced media files into ./media-mirror/ and writes
#      media-manifest.txt (consumed by upload_r2.sh)
#
# Re-run whenever the music catalog changes, then re-run upload_r2.sh.
#
# Usage:
#   R2_BASE="https://pub-XXXX.r2.dev/music" ./snapshot_music.sh
#
# Env:
#   SRC_API   live API base   (default https://marsapiens.com/api)
#   SRC_HOST  live media host  (default https://marsapiens.com) — the prefix of
#             the track `url` fields that gets swapped for $R2_BASE
#   R2_BASE   neutral public base the rewritten URLs point at (REQUIRED)
#
set -euo pipefail

SRC_API="${SRC_API:-https://marsapiens.com/api}"
SRC_HOST="${SRC_HOST:-https://marsapiens.com}"
R2_BASE="${R2_BASE:?Set R2_BASE, e.g. https://pub-XXXX.r2.dev/music}"
BRAND="${BRAND:-SIGNAL}"   # neutral name that replaces the scrubbed project name

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MUSIC_DIR="$(cd "$HERE/../public/music" && pwd)"   # deploy root is public/
DATA="$MUSIC_DIR/data"
MIRROR="$HERE/../media-mirror"
MANIFEST="$HERE/../media-manifest.txt"

mkdir -p "$DATA/albums" "$DATA/tracks" "$MIRROR"
: > "$MANIFEST"

# strip trailing slash off R2_BASE
R2_BASE="${R2_BASE%/}"

echo "==> Source API : $SRC_API"
echo "==> Media host : $SRC_HOST  ->  $R2_BASE"
echo

# Python rewriter, written once to a temp file so it doesn't consume stdin
# (the JSON to rewrite is piped in on stdin).
REWRITER="$(mktemp --suffix=.py)"
cat > "$REWRITER" <<'PY'
import json, sys, os, re
src_host, r2_base, manifest, brand = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
data = json.load(sys.stdin)
mf = open(manifest, "a")

# Scrub the project name from all written content (artist, lore, lyrics, titles,
# descriptions, ...), case-insensitively, replacing it with the neutral brand.
_brand_re = re.compile(r"marsapiens", re.IGNORECASE)
def scrub(s):
    return _brand_re.sub(brand, s)

def fix(u):
    # Rewrite <src_host>/<path>/<file>  ->  <r2_base>/<basename>
    # Flattening to the basename strips every project-named folder segment
    # (e.g. assets/music/default/marsapiens/...) from the public URL.
    if not u or u == "null":
        return u
    if u.startswith(src_host + "/"):
        rel = u[len(src_host) + 1:]            # source path on the live host
        base = os.path.basename(rel)           # flat key on R2
        mf.write(rel + "\t" + base + "\n")     # TSV: source-rel <TAB> flat-key
        return r2_base + "/" + base
    return u

def fix_track(t):
    for k in ("url", "cover_url", "video_url"):
        if k in t and isinstance(t[k], str):
            t[k] = fix(t[k])
    return t

if "tracks" in data:
    data["tracks"] = [fix_track(t) for t in data["tracks"]]
if "track" in data:
    data["track"] = fix_track(data["track"])
if "albums" in data:
    for a in data["albums"]:
        if isinstance(a.get("cover_url"), str):
            a["cover_url"] = fix(a["cover_url"])

# Scrub the project name from every remaining string value, but never touch the
# media-URL fields (already rewritten to the R2 host).
URL_FIELDS = {"url", "cover_url", "video_url"}
def scrub_tree(o, key=None):
    if isinstance(o, dict):
        return {k: scrub_tree(v, k) for k, v in o.items()}
    if isinstance(o, list):
        return [scrub_tree(v) for v in o]
    if isinstance(o, str) and key not in URL_FIELDS:
        return scrub(o)
    return o
data = scrub_tree(data)

mf.close()
json.dump(data, sys.stdout)
PY
trap 'rm -f "$REWRITER"' EXIT

# Rewrite url + cover_url for every track in a JSON {tracks:[...]} or {track:{...}}
# Reads stdin JSON, writes rewritten JSON to stdout.
rewrite_tracks_json() {
  python3 "$REWRITER" "$SRC_HOST" "$R2_BASE" "$MANIFEST" "$BRAND"
}

# 1. Albums -----------------------------------------------------------------
echo "==> /music/albums"
curl -fsS "$SRC_API/music/albums" | rewrite_tracks_json > "$DATA/albums.json"
album_ids=$(jq -r '.albums[].id' "$DATA/albums.json")

default_tmp="$(mktemp)"
echo '{"tracks":[]}' > "$default_tmp"

# 2 + 3. Per-album tracks, per-track detail --------------------------------
for aid in $album_ids; do
  status=$(jq -r --arg id "$aid" '.albums[] | select(.id==$id) | .status' "$DATA/albums.json")
  echo "==> album $aid (status: $status)"
  curl -fsS "$SRC_API/music/albums/$aid/tracks" | rewrite_tracks_json > "$DATA/albums/$aid.tracks.json"

  # Track detail (lore + lyrics)
  for tid in $(jq -r '.tracks[].id' "$DATA/albums/$aid.tracks.json"); do
    curl -fsS "$SRC_API/music/tracks/$tid" | rewrite_tracks_json > "$DATA/tracks/$tid.json"
  done

  # Feed released-album tracks into the default queue
  if [[ "$status" == "released" ]]; then
    merged="$(mktemp)"
    jq -s '{tracks: (.[0].tracks + .[1].tracks)}' "$default_tmp" "$DATA/albums/$aid.tracks.json" > "$merged"
    mv "$merged" "$default_tmp"
  fi
done

# 4. Default queue ----------------------------------------------------------
mv "$default_tmp" "$DATA/tracks-default.json"

# Dedupe media manifest
sort -u "$MANIFEST" -o "$MANIFEST"

echo
echo "==> Snapshot written to: $DATA"
echo "==> Media files to mirror to R2: $(wc -l < "$MANIFEST") (see $MANIFEST)"
echo "==> Next: ./upload_r2.sh   (downloads listed media from $SRC_HOST and uploads to R2)"
