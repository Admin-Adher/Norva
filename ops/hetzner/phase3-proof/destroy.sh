#!/usr/bin/env bash
set -euo pipefail

readonly HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly ROOT='/var/lib/norva-phase3-proof'
readonly PRODUCTION_ROOT='/var/lib/norva'
readonly ENV_FILE="$HERE/.env"

die() { printf 'phase3-proof destroy: %s\n' "$*" >&2; exit 1; }
cd -- "$HERE"
[[ "$(id -un)" == 'adrien' ]] || die 'must run as adrien'
[[ "$ROOT" == '/var/lib/norva-phase3-proof' && "$ROOT" != "$PRODUCTION_ROOT" ]] || die 'unsafe root'
[[ ! -L "$ROOT" ]] || die 'refusing symlink root'
[[ ! -e "$ROOT" || "$(realpath -m -- "$ROOT")" == "$ROOT" ]] || die 'root resolves unexpectedly'
[[ -f "$ENV_FILE" ]] || die 'proof .env is required to identify the project'
grep -qx 'PHASE3_PROOF_ENV=1' "$ENV_FILE" || die 'not a proof environment'

docker compose --project-name norva-phase3-proof --env-file "$ENV_FILE" -f "$HERE/docker-compose.yml" down -v --remove-orphans
docker volume rm norva-phase3-proof-db-config norva-phase3-proof-deno-cache 2>/dev/null || true
if [[ -e "$ROOT" ]]; then
  # PostgreSQL writes bind-mounted files as its container UID.  A plain host
  # rm cannot reliably remove them, so use the already pinned proof database
  # image as root with no network and mount only the guarded proof root.
  docker run --rm --user 0:0 --network none \
    -v "$ROOT:/proof-root" \
    --entrypoint /bin/sh supabase/postgres:17.6.1.136 \
    -ec 'find /proof-root -mindepth 1 -depth -delete'
fi
printf 'phase3-proof destroyed; proof root is empty and production root was never targeted\n'
