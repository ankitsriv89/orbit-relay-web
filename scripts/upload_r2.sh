#!/usr/bin/env bash
#
# upload_r2.sh — mirror the music media listed in media-manifest.txt into a
# Cloudflare R2 bucket, preserving the same relative key so the rewritten URLs
# in the JSON snapshot resolve.
#
# Prereqs:
#   * snapshot_music.sh has been run (media-manifest.txt exists)
#   * wrangler is installed and logged in:  wrangler login
#   * an R2 bucket exists:                   wrangler r2 bucket create <BUCKET>
#   * public access enabled on the bucket (dashboard) -> note the pub-XXXX.r2.dev
#     host, and pass it as R2_BASE to snapshot_music.sh so the JSON URLs match.
#
# Usage:
#   R2_BUCKET="signal-music" ./upload_r2.sh
#
# Env:
#   R2_BUCKET   target R2 bucket name (REQUIRED)
#   SRC_HOST    live media host to download from (default https://marsapiens.com)
#   KEY_PREFIX  key prefix inside the bucket (default "music") — MUST match the
#               path segment after the host in R2_BASE used for the snapshot.
#               (R2_BASE = https://pub-XXXX.r2.dev/<KEY_PREFIX>)
#   REMOTE      pass --remote to wrangler (real R2). Default on. Set REMOTE=0 to dry-run.
#
set -euo pipefail

R2_BUCKET="${R2_BUCKET:?Set R2_BUCKET, e.g. signal-music}"
SRC_HOST="${SRC_HOST:-https://marsapiens.com}"
KEY_PREFIX="${KEY_PREFIX:-music}"
REMOTE="${REMOTE:-1}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="$HERE/../media-manifest.txt"
MIRROR="$HERE/../media-mirror"

[[ -f "$MANIFEST" ]] || { echo "No manifest at $MANIFEST — run snapshot_music.sh first." >&2; exit 1; }
mkdir -p "$MIRROR"

remote_flag="--remote"
[[ "$REMOTE" == "0" ]] && remote_flag=""

# URL-encode a path for downloading (spaces, apostrophes, etc.)
urlenc() {
  python3 -c 'import sys,urllib.parse; print("/".join(urllib.parse.quote(p) for p in sys.argv[1].split("/")))' "$1"
}

total=$(grep -c . "$MANIFEST" || echo 0)
n=0
echo "==> Uploading $total media files to r2://$R2_BUCKET/$KEY_PREFIX/ (remote=$REMOTE)"

# Manifest is TSV:  <source-rel-path-on-live-host> <TAB> <flat-key>
while IFS=$'\t' read -r rel flatkey; do
  [[ -z "$rel" ]] && continue
  n=$((n+1))
  local_path="$MIRROR/$rel"
  key="$KEY_PREFIX/$flatkey"

  # 1. download from live host if not already mirrored
  if [[ ! -s "$local_path" ]]; then
    mkdir -p "$(dirname "$local_path")"
    enc="$(urlenc "$rel")"
    echo "[$n/$total] download  $rel"
    curl -fsS "$SRC_HOST/$enc" -o "$local_path" || { echo "  !! download failed: $rel" >&2; continue; }
  fi

  # 2. upload to R2 under the flat (project-name-free) key
  echo "[$n/$total] r2 put    $key"
  wrangler r2 object put "$R2_BUCKET/$key" --file="$local_path" $remote_flag \
    --content-type="audio/mpeg" >/dev/null
done < "$MANIFEST"

echo
echo "==> Done. $n files uploaded under r2://$R2_BUCKET/$KEY_PREFIX/"
echo "==> Verify a file is publicly reachable, e.g.:"
echo "    curl -I \"https://pub-XXXX.r2.dev/$KEY_PREFIX/\$(head -1 \"$MANIFEST\" | cut -f2)\""
echo "==> If the public host differs from the R2_BASE used in snapshot_music.sh,"
echo "    re-run snapshot_music.sh with the correct R2_BASE."
