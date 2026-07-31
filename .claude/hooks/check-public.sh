#!/usr/bin/env bash
# PostToolUse guardrail for public/ assets.
#
# Why this exists: this repo has no build step, so nothing between the editor
# and the browser ever parses these files. A syntax error executes ZERO
# statements of an ES module, and a bad path 404s silently — both stay
# invisible until a human loads the page. That failure mode has shipped to
# production three times here (fb66525f, dcbb42aa, and the catalog.js typo).
#
# Reads the PostToolUse JSON payload on stdin; blocks with feedback to Claude
# when the static checks fail. Exits 0 (silent) for anything outside public/.
set -uo pipefail

payload=$(cat)
file=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // .tool_response.filePath // empty')

case "$file" in
  */public/*.js|*/public/*.html|*/public/*.css) ;;
  *) exit 0 ;;
esac

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
[ -f scripts/check/syntax.mjs ] || exit 0

if out=$(node scripts/check/syntax.mjs 2>&1 && node scripts/check/resolve.mjs 2>&1); then
  exit 0
fi

# jq -Rs builds the JSON string, so quotes/newlines in the output can't break
# the envelope.
printf '%s' "$out" | tail -20 | jq -Rs '{
  decision: "block",
  reason: ("Static checks failed after this edit — fix before continuing.\n\nThis repo has no build step: a syntax error executes zero statements of the module, and a bad path 404s silently. Neither surfaces until someone loads the page.\n\n" + .)
}'
