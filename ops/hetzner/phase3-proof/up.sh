#!/usr/bin/env bash
set -euo pipefail
readonly HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "$HERE"
[[ -f "$HERE/.env" ]] || { printf 'run bootstrap.sh first\n' >&2; exit 1; }
"$HERE/preflight.sh"
docker compose --project-name norva-phase3-proof --env-file "$HERE/.env" -f "$HERE/docker-compose.yml" up -d
