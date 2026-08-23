#!/usr/bin/env bash
set -euo pipefail

readonly ROOT='/var/lib/norva-phase3-proof'
readonly PRODUCTION_ROOT='/var/lib/norva'
readonly PROJECT='norva-phase3-proof'
readonly COMPOSE_FILE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/docker-compose.yml"
readonly MIN_AVAILABLE_MIB="${PHASE3_PROOF_MIN_AVAILABLE_MIB:-8192}"
readonly MIN_DISK_GIB="${PHASE3_PROOF_MIN_DISK_GIB:-80}"
readonly PORTS=(55432 58000)

die() { printf 'phase3-proof preflight: %s\n' "$*" >&2; exit 1; }

cd -- "$(dirname -- "$COMPOSE_FILE")"

[[ "$(id -un)" == 'adrien' ]] || die 'must run as the dedicated Hetzner operator account'
[[ -f "$COMPOSE_FILE" ]] || die 'dedicated compose file is missing'
[[ "$ROOT" == '/var/lib/norva-phase3-proof' && "$ROOT" != "$PRODUCTION_ROOT" ]] || die 'unsafe staging root'
[[ ! -L "$ROOT" ]] || die 'staging root must not be a symlink'
[[ ! -e "$ROOT" || "$(realpath -m -- "$ROOT")" == "$ROOT" ]] || die 'staging root does not resolve exactly'
command -v docker >/dev/null || die 'docker is unavailable'
docker info >/dev/null || die 'docker daemon is unavailable'

available_mib="$(free -m | awk '/^Mem:/ { print $7 }')"
(( available_mib >= MIN_AVAILABLE_MIB )) || die "only ${available_mib} MiB available; need ${MIN_AVAILABLE_MIB} MiB"
available_gib="$(df -BG /var/lib | awk 'NR==2 {gsub(/G/,"",$4); print $4}')"
(( available_gib >= MIN_DISK_GIB )) || die "only ${available_gib} GiB free; need ${MIN_DISK_GIB} GiB"

for port in "${PORTS[@]}"; do
  if ss -ltnH "( sport = :${port} )" | grep -q .; then
    die "localhost port ${port} is already bound"
  fi
done

if [[ "${PHASE3_PROOF_ALLOW_EXISTS:-0}" != '1' ]] \
  && docker ps -a --format '{{.Names}}' | grep -Eq '^norva-phase3-proof-'; then
  die 'a phase3-proof container already exists; use down.sh or destroy.sh deliberately'
fi
if [[ "${PHASE3_PROOF_ALLOW_EXISTS:-0}" != '1' ]] \
  && docker network inspect norva-phase3-proof-net >/dev/null 2>&1; then
  die 'phase3-proof network already exists; use down.sh or destroy.sh deliberately'
fi

if [[ -f .env ]]; then
  [[ "$(stat -c '%a' .env)" == '600' ]] || die '.env permissions must be 600'
  grep -qx 'PHASE3_PROOF_ENV=1' .env || die '.env is not an explicit proof environment'
  if grep -Eqi '(api\.norva\.tv|norva\.tv|resend|firebase|revenuecat|telegram|revolut|cloudflare)' .env; then
    die '.env contains a prohibited production/external integration marker'
  fi
  docker compose --project-name "$PROJECT" --env-file .env -f "$COMPOSE_FILE" config >/dev/null \
    || die 'dedicated compose does not validate'
elif [[ "${PHASE3_PROOF_REQUIRE_ENV:-0}" == '1' ]]; then
  die 'proof .env is required at this stage'
fi

printf 'phase3-proof preflight PASS: available=%sMiB disk=%sGiB ports=%s,%s project=%s root=%s\n' \
  "$available_mib" "$available_gib" "${PORTS[0]}" "${PORTS[1]}" "$PROJECT" "$ROOT"
