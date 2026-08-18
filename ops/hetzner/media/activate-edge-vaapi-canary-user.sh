#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly MEDIA_ROOT='/home/adrien/norva-media-deployments/53705bd7e404/ops/hetzner/media'
readonly ENV_PATH="${MEDIA_ROOT}/.env.media-vaapi"
readonly COMPOSE_PATH="${MEDIA_ROOT}/docker-compose.vaapi.yml"
readonly CALLBACK_BACKUP="${MEDIA_ROOT}/.env.media-vaapi.rollback-canary-private"
readonly PRIVATE_CALLBACK='http://127.0.0.1:9'
readonly ACTIVE_CALLBACK='https://api.norva.tv/functions/v1/norva-playback'
readonly DB_CONTAINER='norva-db'
readonly GATEWAY_CONTAINER='norva-media-gateway'
readonly GATEWAY_IMAGE='norva-media-gateway:vaapi-53705bd7e404'
readonly GATEWAY_IMAGE_ID='sha256:7d4cd36a567785471be857d4b4464755a36b734dab430eb8f6675b51cd8bf3af'
readonly GATEWAY_ID='a7250ec1-171b-4bcf-ad7d-41bac56130ec'
readonly GATEWAY_URL='http://norva-media-gateway:8080'
readonly FUNCTION_CONTAINERS=(norva-edge-functions norva-edge-functions-2)

CALLBACK_MUTATED=0
SELECTION_MUTATED=0

die() {
  printf 'EDGE_VAAPI_CANARY_ACTIVATION_FAILED:%s\n' "$1" >&2
  rollback_activation 1
}

compose_gateway() {
  docker compose --env-file "${ENV_PATH}" -f "${COMPOSE_PATH}" "$@"
}

edge_health() {
  local container="$1"
  local ip
  ip="$(docker inspect "${container}" --format '{{range .NetworkSettings.Networks}}{{println .IPAddress}}{{end}}' | sed -n '1p')"
  [[ -n "${ip}" ]] || return 1
  curl --fail --silent --show-error --max-time 10 "http://${ip}:9000/norva-playback/health"
}

wait_edge_state() {
  local expected_state="$1"
  local expected_selected="$2"
  local deadline=$((SECONDS + 50))
  while (( SECONDS < deadline )); do
    local ready=1
    local container health
    for container in "${FUNCTION_CONTAINERS[@]}"; do
      health="$(edge_health "${container}" 2>/dev/null || true)"
      [[ "${health}" == *'"version":53'* \
          && "${health}" == *"\"mediaGatewayCanaryRouting\":{\"protocol\":1,\"state\":\"${expected_state}\",\"selectedUsers\":${expected_selected}"* ]] \
        || ready=0
    done
    [[ "${ready}" == '1' ]] && return 0
    sleep 2
  done
  return 1
}

assert_gateway_idle() {
  docker exec "${GATEWAY_CONTAINER}" node -e '
    fetch("http://127.0.0.1:8080/health")
      .then(async (response) => {
        const h = await response.json();
        const ok = response.ok && h.ok === true
          && h.activeSessions === 0
          && h.videoEncoderCapacity?.active === 0
          && h.vodInputPump?.active === 0
          && h.rawPumpCount === 0
          && h.viewerSessionStartupLockCount === 0
          && h.backgroundCpuProcessCount === 0;
        if (!ok) process.exit(1);
      }).catch(() => process.exit(1));
  '
}

probe_callback_from_gateway() {
  docker exec -i "${GATEWAY_CONTAINER}" node --input-type=module <<'NODE'
const base = String(process.env.NORVA_EDGE_CALLBACK_BASE || '').replace(/\/+$/, '');
const token = String(process.env.GATEWAY_TOKEN || '');
if (!base || !token) process.exit(1);
try {
  const response = await fetch(`${base}/account-activity`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: '{"keys":[]}',
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json();
  if (!response.ok || body?.ok !== true || body?.touched !== 0) process.exit(1);
  process.stdout.write('{"ok":true,"touched":0}');
} catch {
  process.exit(1);
}
NODE
}

rollback_activation() {
  local exit_code="${1:-$?}"
  local selection_drained=1
  local callback_restored=1
  [[ "${exit_code}" != '0' ]] || exit_code=1
  trap - ERR INT TERM
  set +e
  if [[ "${SELECTION_MUTATED}" == '1' ]]; then
    if ! docker exec "${DB_CONTAINER}" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -c \
      "update public.cloud_runtime_config set value='' where key='NORVA_MEDIA_GATEWAY_CANARY_USER_HASHES';" >/dev/null; then
      selection_drained=0
    elif ! wait_edge_state standby 0; then
      selection_drained=0
    fi
  fi
  if [[ "${CALLBACK_MUTATED}" == '1' ]]; then
    if [[ "${selection_drained}" == '1' && -f "${CALLBACK_BACKUP}" ]]; then
      install -m 0600 "${CALLBACK_BACKUP}" "${ENV_PATH}" || callback_restored=0
      if [[ "${callback_restored}" == '1' ]]; then
        compose_gateway up -d --no-build --pull never --wait --wait-timeout 180 gateway >/dev/null \
          || callback_restored=0
      fi
    else
      callback_restored=0
    fi
  fi
  unset gateway_token db_canary_token 2>/dev/null || true
  if [[ "${SELECTION_MUTATED}" == '1' || "${CALLBACK_MUTATED}" == '1' ]]; then
    if [[ "${selection_drained}" == '1' && "${callback_restored}" == '1' ]]; then
      echo '===EDGE_VAAPI_CANARY_ACTIVATION_ROLLED_BACK===' >&2
    else
      echo '===EDGE_VAAPI_CANARY_ROLLBACK_INCOMPLETE_INSPECT_REQUIRED===' >&2
    fi
  fi
  exit "${exit_code}"
}

trap rollback_activation ERR INT TERM

if [[ "$#" == '0' && -t 0 ]]; then
  read -r -p 'UUID exact du compte canary: ' CANARY_USER_INPUT
  set -- "${CANARY_USER_INPUT}"
  unset CANARY_USER_INPUT
fi
[[ "$#" == '1' ]] || die 'usage-user-uuid'
readonly USER_ID="${1,,}"
[[ "${USER_ID}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || die 'user-uuid'

[[ -f "${ENV_PATH}" && "$(stat -c '%a' "${ENV_PATH}")" == '600' ]] || die 'media-env'
[[ -f "${COMPOSE_PATH}" ]] || die 'compose'
grep -qx "MEDIA_GATEWAY_IMAGE=${GATEWAY_IMAGE}" "${ENV_PATH}" || die 'image-config'
grep -qx "NORVA_EDGE_CALLBACK_BASE=${PRIVATE_CALLBACK}" "${ENV_PATH}" || die 'callback-not-private'
[[ "$(docker inspect "${GATEWAY_CONTAINER}" --format '{{.Config.Image}}')" == "${GATEWAY_IMAGE}" ]] || die 'gateway-image-tag'
[[ "$(docker inspect "${GATEWAY_CONTAINER}" --format '{{.Image}}')" == "${GATEWAY_IMAGE_ID}" ]] || die 'gateway-image-id'
[[ "$(docker inspect "${GATEWAY_CONTAINER}" --format '{{.State.Health.Status}}')" == 'healthy' ]] || die 'gateway-health'
assert_gateway_idle || die 'gateway-not-idle'

user_exists="$(docker exec "${DB_CONTAINER}" psql -X -U postgres -d postgres -Atc "select count(*) from auth.users where id='${USER_ID}'::uuid;")"
[[ "${user_exists}" == '1' ]] || die 'user-not-found'
config_count="$(docker exec "${DB_CONTAINER}" psql -X -U postgres -d postgres -Atc \
  "select count(*) from public.cloud_runtime_config where key in ('NORVA_MEDIA_GATEWAY_CANARY_URL','NORVA_MEDIA_GATEWAY_CANARY_TOKEN','NORVA_MEDIA_GATEWAY_CANARY_ID','NORVA_MEDIA_GATEWAY_CANARY_USER_HASHES') and is_secret is true;")"
[[ "${config_count}" == '4' ]] || die 'standby-config'
selected_length="$(docker exec "${DB_CONTAINER}" psql -X -U postgres -d postgres -Atc \
  "select coalesce((select length(value) from public.cloud_runtime_config where key='NORVA_MEDIA_GATEWAY_CANARY_USER_HASHES'),-1);")"
[[ "${selected_length}" == '0' ]] || die 'account-already-selected'
db_canary_url="$(docker exec "${DB_CONTAINER}" psql -X -U postgres -d postgres -Atc \
  "select value from public.cloud_runtime_config where key='NORVA_MEDIA_GATEWAY_CANARY_URL';")"
db_canary_id="$(docker exec "${DB_CONTAINER}" psql -X -U postgres -d postgres -Atc \
  "select value from public.cloud_runtime_config where key='NORVA_MEDIA_GATEWAY_CANARY_ID';")"
[[ "${db_canary_url}" == "${GATEWAY_URL}" && "${db_canary_id}" == "${GATEWAY_ID}" ]] || die 'standby-binding'
gateway_token="$(sed -n 's/^GATEWAY_TOKEN=//p' "${ENV_PATH}")"
db_canary_token="$(docker exec "${DB_CONTAINER}" psql -X -U postgres -d postgres -Atc \
  "select value from public.cloud_runtime_config where key='NORVA_MEDIA_GATEWAY_CANARY_TOKEN';")"
[[ -n "${gateway_token}" && "${gateway_token}" == "${db_canary_token}" ]] || die 'standby-token-binding'

wait_edge_state standby 0 || die 'edge-not-standby'

if [[ -f "${CALLBACK_BACKUP}" ]]; then
  cmp -s "${CALLBACK_BACKUP}" "${ENV_PATH}" || die 'callback-backup-drift'
else
  install -m 0600 "${ENV_PATH}" "${CALLBACK_BACKUP}"
fi

CALLBACK_MUTATED=1
sed -i "s#^NORVA_EDGE_CALLBACK_BASE=${PRIVATE_CALLBACK}\$#NORVA_EDGE_CALLBACK_BASE=${ACTIVE_CALLBACK}#" "${ENV_PATH}"
grep -qx "NORVA_EDGE_CALLBACK_BASE=${ACTIVE_CALLBACK}" "${ENV_PATH}" || die 'callback-write'
compose_gateway config --quiet || die 'callback-compose'
compose_gateway up -d --no-build --pull never --wait --wait-timeout 180 gateway
[[ "$(docker inspect "${GATEWAY_CONTAINER}" --format '{{.Image}}')" == "${GATEWAY_IMAGE_ID}" ]] || die 'callback-recreate-image'
[[ "$(docker inspect "${GATEWAY_CONTAINER}" --format '{{.State.Health.Status}}')" == 'healthy' ]] || die 'callback-recreate-health'
docker inspect "${GATEWAY_CONTAINER}" --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -qx "NORVA_EDGE_CALLBACK_BASE=${ACTIVE_CALLBACK}" || die 'callback-runtime'
assert_gateway_idle || die 'callback-recreate-not-idle'

activity_response="$(probe_callback_from_gateway)" || die 'callback-auth-probe'
[[ "${activity_response}" == '{"ok":true,"touched":0}' ]] || die 'callback-auth-response'

readonly USER_HASH="$(printf '%s' "${USER_ID}" | sha256sum | awk '{print $1}')"
[[ "${USER_HASH}" =~ ^[0-9a-f]{64}$ ]] || die 'user-hash'
SELECTION_MUTATED=1
docker exec "${DB_CONTAINER}" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -c \
  "update public.cloud_runtime_config set value='${USER_HASH}' where key='NORVA_MEDIA_GATEWAY_CANARY_USER_HASHES';" >/dev/null
wait_edge_state ready 1 || die 'edge-not-ready'

unset gateway_token db_canary_token
CALLBACK_MUTATED=0
SELECTION_MUTATED=0
trap - ERR INT TERM

echo '===EDGE_VAAPI_CANARY_ONE_USER_READY_OK==='
echo 'selected_users=1 gateway_callback=authenticated route=private rollback=armed'
