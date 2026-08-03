#!/usr/bin/env bash
# =============================================================================
# 04-deploy-edge-functions.sh — reload configured norva-* functions on self-host
# =============================================================================
# In the self-host stack, edge functions are NOT "deployed" to a remote — the
# `functions` (edge-runtime) container serves them directly from the repo's
# supabase/functions dir, which the compose mounts read-only. "Deploying" =
# sync the code + recreate each runtime so it re-reads both code and env.
#
# This script:
#   1. sanity-checks that every function in supabase/config.toml has a dir,
#   2. validates the rendered Compose configuration without printing it,
#   3. recreates every configured edge-runtime replica one at a time.
#
# GitHub CI validates the functions but does not deploy them to the Hetzner
# runtime. Until an explicit SSH deploy workflow exists, production deployment
# is a reviewed manual operation: update the checkout, then run this script.
# `supabase/config.toml` is only the checked-in function inventory used by the
# sanity check below. Runtime authentication is configured by Compose and by
# each function's own authorization boundary.
# =============================================================================
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
FUNCS_DIR="$REPO/supabase/functions"
CONFIG="$REPO/supabase/config.toml"
COMPOSE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/docker-compose.supabase.yml"
ENV_FILE="$(dirname "$COMPOSE")/.env"

[[ -d "$FUNCS_DIR" ]] || { echo "ERROR: $FUNCS_DIR not found" >&2; exit 1; }

echo ">> Verifying each configured function has a directory"
missing=0
# Extract [functions.NAME] headers from config.toml and check the dir exists.
mapfile -t configured_functions < <(
  grep -oE '^\[functions\.[a-z0-9-]+\]' "$CONFIG" |
    sed -E 's/^\[functions\.(.*)\]$/\1/'
)
if [[ ${#configured_functions[@]} -eq 0 ]]; then
  echo "ERROR: no functions declared in $CONFIG" >&2
  exit 1
fi

for fn in "${configured_functions[@]}"; do
  if [[ -d "$FUNCS_DIR/$fn" ]]; then
    echo "   ok   $fn"
  else
    echo "   MISS $fn  (declared in config.toml, no dir)" >&2
    missing=1
  fi
done
if (( missing != 0 )); then
  echo "ERROR: one or more functions declared in $CONFIG are missing" >&2
  exit 1
fi

declared=${#configured_functions[@]}
present=$(find "$FUNCS_DIR" -maxdepth 1 -mindepth 1 -type d -name 'norva-*' | wc -l | tr -d ' ')
echo ">> config.toml declares $declared functions; $present norva-* dirs present."

echo ">> Recreating edge-runtime replicas to reload code and environment"
if command -v docker >/dev/null 2>&1 && [[ -f "$COMPOSE" ]]; then
  [[ -f "$ENV_FILE" ]] || {
    echo "ERROR: $ENV_FILE not found" >&2
    exit 1
  }
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE" config --quiet

  # Kong round-robins across functions, functions2, ... . Discover the compose
  # services so a deploy cannot leave a stale replica serving old code.
  mapfile -t function_services < <(
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE" config --services |
      grep -E '^functions[0-9]*$'
  )
  if [[ ${#function_services[@]} -eq 0 ]]; then
    echo "ERROR: no edge-runtime service found in $COMPOSE" >&2
    exit 1
  fi
  for service in "${function_services[@]}"; do
    echo ">> Recreating $service"
    previous_container_id="$(
      docker compose --env-file "$ENV_FILE" -f "$COMPOSE" ps -q "$service"
    )"
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE" \
      up -d --no-deps --force-recreate "$service"

    container_id="$(
      docker compose --env-file "$ENV_FILE" -f "$COMPOSE" ps -q "$service"
    )"
    [[ -n "$container_id" ]] || {
      echo "ERROR: $service has no running container after recreation" >&2
      exit 1
    }
    if [[ -n "$previous_container_id" \
        && "$container_id" == "$previous_container_id" ]]; then
      echo "ERROR: $service was not recreated" >&2
      exit 1
    fi

    deadline=$((SECONDS + 60))
    while true; do
      health=$(docker inspect --format \
        '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
        "$container_id")
      [[ "$health" == "healthy" || "$health" == "running" ]] && break
      if (( SECONDS >= deadline )); then
        echo "ERROR: $service did not become healthy within 60 seconds (status: $health)" >&2
        exit 1
      fi
      sleep 1
    done
    echo "   $service is $health"
  done
  echo ">> edge-runtime replicas recreated: ${function_services[*]}."
else
  echo "   (docker/compose not found here — run on the box:"
  echo "    docker compose --env-file .env -f docker-compose.supabase.yml up -d --no-deps --force-recreate functions"
  echo "    then verify health before recreating functions2 )"
fi

echo ">> Done. Smoke-test e.g.:  curl -i \$FUNCTIONS_BASE_URL/norva-playback  (expect 401 without auth)"
