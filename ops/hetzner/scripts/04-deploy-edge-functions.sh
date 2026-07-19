#!/usr/bin/env bash
# =============================================================================
# 04-deploy-edge-functions.sh — serve the 19 norva-* functions on self-host
# =============================================================================
# In the self-host stack, edge functions are NOT "deployed" to a remote — the
# `functions` (edge-runtime) container serves them directly from the repo's
# supabase/functions dir, which the compose mounts read-only. "Deploying" =
# sync the code + restart the runtime so it re-reads them.
#
# This script:
#   1. sanity-checks that every function in supabase/config.toml has a dir,
#   2. restarts every configured edge-runtime replica to pick up changes.
#
# CI ADAPTATION (do this once, separately): .github/workflows/deploy-supabase-
# functions.yml today runs `supabase functions deploy --project-ref
# oupsceccxsonaalhueff` (the MANAGED project). For self-host, replace that step
# with an SSH deploy that pulls the repo on the box and runs THIS script, e.g.:
#     ssh deploy@box 'cd /opt/norva && git pull && \
#         ops/hetzner/scripts/04-deploy-edge-functions.sh'
# Keep supabase/config.toml as the source of truth for verify_jwt per function.
# =============================================================================
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
FUNCS_DIR="$REPO/supabase/functions"
CONFIG="$REPO/supabase/config.toml"
COMPOSE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/docker-compose.supabase.yml"

[[ -d "$FUNCS_DIR" ]] || { echo "ERROR: $FUNCS_DIR not found" >&2; exit 1; }

echo ">> Verifying each configured function has a directory"
missing=0
# Extract [functions.NAME] headers from config.toml and check the dir exists.
grep -oE '^\[functions\.[a-z0-9-]+\]' "$CONFIG" | sed -E 's/^\[functions\.(.*)\]$/\1/' | while read -r fn; do
  if [[ -d "$FUNCS_DIR/$fn" ]]; then
    echo "   ok   $fn"
  else
    echo "   MISS $fn  (declared in config.toml, no dir)" >&2
    missing=1
  fi
done
# (subshell can't set parent var; re-check count directly)
declared=$(grep -cE '^\[functions\.[a-z0-9-]+\]' "$CONFIG")
present=$(find "$FUNCS_DIR" -maxdepth 1 -mindepth 1 -type d -name 'norva-*' | wc -l | tr -d ' ')
echo ">> config.toml declares $declared functions; $present norva-* dirs present."

echo ">> Restarting edge-runtime replicas to reload functions"
if command -v docker >/dev/null 2>&1 && [[ -f "$COMPOSE" ]]; then
  # Kong round-robins across functions, functions2, ... . Discover the compose
  # services so a deploy cannot leave a stale replica serving old code.
  mapfile -t function_services < <(
    docker compose -f "$COMPOSE" config --services | grep -E '^functions[0-9]*$'
  )
  if [[ ${#function_services[@]} -eq 0 ]]; then
    echo "ERROR: no edge-runtime service found in $COMPOSE" >&2
    exit 1
  fi
  docker compose -f "$COMPOSE" restart "${function_services[@]}"
  echo ">> edge-runtime replicas restarted: ${function_services[*]}."
else
  echo "   (docker/compose not found here — run on the box:"
  echo "    docker compose -f docker-compose.supabase.yml restart functions functions2 )"
fi

echo ">> Done. Smoke-test e.g.:  curl -i \$FUNCTIONS_BASE_URL/norva-playback  (expect 401 without auth)"
