#!/usr/bin/env bash
set -Eeuo pipefail

readonly MEDIA_ROOT='/home/adrien/norva-media-deployments/53705bd7e404/ops/hetzner/media'
readonly ENV_PATH="${MEDIA_ROOT}/.env.media-vaapi"
readonly COMPOSE_PATH="${MEDIA_ROOT}/docker-compose.vaapi.yml"
readonly CALLBACK_BACKUP="${MEDIA_ROOT}/.env.media-vaapi.rollback-canary-private"
readonly PRIVATE_CALLBACK='http://127.0.0.1:9'
readonly ACTIVE_CALLBACK='https://api.norva.tv/functions/v1/norva-playback'
readonly DB_CONTAINER='norva-db'
readonly GATEWAY_CONTAINER='norva-media-gateway'
readonly GATEWAY_IMAGE_ID='sha256:7d4cd36a567785471be857d4b4464755a36b734dab430eb8f6675b51cd8bf3af'
readonly GATEWAY_ID='a7250ec1-171b-4bcf-ad7d-41bac56130ec'
readonly FUNCTION_CONTAINERS=(norva-edge-functions norva-edge-functions-2)

die() {
  printf 'EDGE_VAAPI_CANARY_DEACTIVATION_FAILED:%s\n' "$1" >&2
  exit 1
}

edge_health() {
  local container="$1"
  local ip
  ip="$(docker inspect "${container}" --format '{{range .NetworkSettings.Networks}}{{println .IPAddress}}{{end}}' | sed -n '1p')"
  [[ -n "${ip}" ]] || return 1
  curl --fail --silent --show-error --max-time 10 "http://${ip}:9000/norva-playback/health"
}

wait_standby() {
  local deadline=$((SECONDS + 50))
  while (( SECONDS < deadline )); do
    local ready=1
    local container health
    for container in "${FUNCTION_CONTAINERS[@]}"; do
      health="$(edge_health "${container}" 2>/dev/null || true)"
      [[ "${health}" == *'"version":53'* \
          && "${health}" == *'"mediaGatewayCanaryRouting":{"protocol":1,"state":"standby","selectedUsers":0'* ]] \
        || ready=0
    done
    [[ "${ready}" == '1' ]] && return 0
    sleep 2
  done
  return 1
}

[[ -f "${ENV_PATH}" && "$(stat -c '%a' "${ENV_PATH}")" == '600' ]] || die 'media-env'
[[ -f "${CALLBACK_BACKUP}" && "$(stat -c '%a' "${CALLBACK_BACKUP}")" == '600' ]] || die 'callback-backup'
grep -qx "NORVA_EDGE_CALLBACK_BASE=${ACTIVE_CALLBACK}" "${ENV_PATH}" || die 'callback-not-active'
grep -qx "NORVA_EDGE_CALLBACK_BASE=${PRIVATE_CALLBACK}" "${CALLBACK_BACKUP}" || die 'callback-backup-invalid'

docker exec "${DB_CONTAINER}" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -c \
  "update public.cloud_runtime_config set value='' where key='NORVA_MEDIA_GATEWAY_CANARY_USER_HASHES';" >/dev/null
wait_standby || die 'edge-not-standby'

active_sessions="$(docker exec "${DB_CONTAINER}" psql -X -U postgres -d postgres -Atc \
  "select count(*) from public.cloud_gateway_sessions where gateway_id='${GATEWAY_ID}'::uuid and status in ('pending','starting','ready') and expires_at > now();")"
[[ "${active_sessions}" == '0' ]] || die 'canary-session-still-active'

install -m 0600 "${CALLBACK_BACKUP}" "${ENV_PATH}"
docker compose --env-file "${ENV_PATH}" -f "${COMPOSE_PATH}" config --quiet || die 'private-compose'
docker compose --env-file "${ENV_PATH}" -f "${COMPOSE_PATH}" \
  up -d --no-build --pull never --wait --wait-timeout 180 gateway
[[ "$(docker inspect "${GATEWAY_CONTAINER}" --format '{{.Image}}')" == "${GATEWAY_IMAGE_ID}" ]] || die 'gateway-image'
[[ "$(docker inspect "${GATEWAY_CONTAINER}" --format '{{.State.Health.Status}}')" == 'healthy' ]] || die 'gateway-health'
docker inspect "${GATEWAY_CONTAINER}" --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -qx "NORVA_EDGE_CALLBACK_BASE=${PRIVATE_CALLBACK}" || die 'gateway-callback'

echo '===EDGE_VAAPI_CANARY_ONE_USER_DEACTIVATED_OK==='
echo 'selected_users=0 gateway_callback=private route=standby'
