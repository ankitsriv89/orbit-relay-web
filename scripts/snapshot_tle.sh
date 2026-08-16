#!/usr/bin/env bash
#
# snapshot_tle.sh — fetch a baseline TLE snapshot for the standalone Orbital
# Relay, one file per Celestrak group, written to public/data/tle/celestrak/.
#
# Why a baseline snapshot: the page reads data/tle/celestrak/<group>.txt for an
# instant first plot (works even if the live Pages Function is cold), and the
# in-page "refresh" control re-pulls live via /api/tle?source=celestrak.
#
# Celestrak rate-limits per client (HTTP 403 "GP data has not updated since your
# last request"), so this script SLEEPS between groups. Re-run occasionally to
# refresh the shipped baseline, then redeploy.
#
# Usage:  ./snapshot_tle.sh
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(cd "$HERE/.." && pwd)/public/data/tle/celestrak"
BASE="https://celestrak.org/NORAD/elements/gp.php?FORMAT=TLE&GROUP="
SLEEP="${SLEEP:-4}"   # seconds between groups, to dodge the 403 cooldown

# Must match ALLOWED_GROUPS in the Pages Function (functions/api/tle.js) and the
# data-group values in public/orbit/index.html.
#
# NOT named GROUPS: some shells/dotfiles predefine GROUPS as an array (id -Gn
# style GIDs). Assigning a plain string to an existing array name only
# overwrites index 0, so `for g in $GROUPS` silently iterates a single stale
# numeric GID instead of the real list — this bit a real run (2026-08-02,
# GROUPS=([0]="1000" [1]="20" ...) in the invoking shell). TLE_GROUPS avoids
# the collision outright.
TLE_GROUPS="stations starlink gps-ops glo-ops galileo beidou qianfan hulianwang \
irnss iridium-NEXT weather geo resource last-30-days oneweb cosmos-2251-debris \
active military"

mkdir -p "$OUT"
echo "==> Writing baseline TLE snapshot to: $OUT"
echo

for g in $TLE_GROUPS; do
  # The Celestrak group name is mixed-case (iridium-NEXT) but the page looks the
  # baseline up by the LOWERCASED slug, so the filename must be lowercase or the
  # snapshot 404s and that group silently always takes the slow API path.
  slug="$(printf '%s' "$g" | tr '[:upper:]' '[:lower:]')"
  out="$OUT/${slug}.txt"
  body="$(curl -fsS --max-time 20 "${BASE}${g}" || true)"
  if [[ -z "$body" ]] || grep -q "Invalid query" <<<"$body" \
     || grep -q "^GP data has not updated" <<<"$body"; then
    echo "  !! $g — no usable data (throttled or invalid); keeping existing file if any"
  else
    printf '%s' "$body" > "$out"
    # Starlink (~10k objects) and active (~16k objects) are both far larger
    # than anything the page renders (cap 600 / 150 respectively) — ship a
    # trimmed baseline (600 sats = 1800 lines) for both; the live refresh can
    # still pull the full set via /api/tle.
    if [[ "$g" == "starlink" || "$g" == "active" ]]; then
      head -1800 "$out" > "$out.trim" && mv "$out.trim" "$out"
    fi
    n=$(grep -c '^1 ' "$out" || true)
    echo "  ok $g — $n objects -> ${slug}.txt"
  fi
  sleep "$SLEEP"
done

echo
echo "==> Done. Commit the refreshed files under public/data/tle/celestrak/ and redeploy."
