#!/usr/bin/env bash
set -euo pipefail
readonly HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "$HERE"
[[ -f "$HERE/.env" ]] || { printf 'missing proof .env; refusing implicit target\n' >&2; exit 1; }
docker compose --project-name norva-phase3-proof --env-file "$HERE/.env" -f "$HERE/docker-compose.yml" down
