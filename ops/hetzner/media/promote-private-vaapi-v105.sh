#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly MEDIA_ROOT='/home/adrien/norva-media-deployments/53705bd7e404/ops/hetzner/media'
readonly COMPOSE_PATH="${MEDIA_ROOT}/docker-compose.vaapi.yml"
readonly ENV_PATH="${MEDIA_ROOT}/.env.media-vaapi"
readonly BACKUP_PATH="${MEDIA_ROOT}/.env.media-vaapi.rollback-53705bd7e404"
readonly DB_CONTAINER='norva-db'
readonly GATEWAY_CONTAINER='norva-media-gateway'
readonly GATEWAY_ID='a7250ec1-171b-4bcf-ad7d-41bac56130ec'
readonly GATEWAY_URL='http://norva-media-gateway:8080'
readonly ACTIVE_CALLBACK='https://api.norva.tv/functions/v1/norva-playback'
readonly OLD_IMAGE='norva-media-gateway:vaapi-53705bd7e404'
readonly OLD_IMAGE_ID='sha256:7d4cd36a567785471be857d4b4464755a36b734dab430eb8f6675b51cd8bf3af'
readonly NEW_IMAGE='norva-media-gateway:vaapi-3d9cbd892800'
readonly NEW_IMAGE_ID='sha256:1997592fd597b1f51735a2bcece179a0c3ab4b55502440b4c86ec19dfc2f0ad6'
readonly NEW_BUNDLE_SHA256='3d9cbd892800cf4630fac059e6cbe618e6e3b0b8a83196003e32934b018b0185'
readonly FUNCTION_CONTAINERS=(norva-edge-functions norva-edge-functions-2)

PROMOTION_STARTED=0
SELECTION_DRAINED=0
SELECTED_USER_HASH=''

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
  local deadline=$((SECONDS + 60))
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
  local expected_version="$1"
  docker exec -e EXPECTED_GATEWAY_VERSION="${expected_version}" "${GATEWAY_CONTAINER}" node -e '
    fetch("http://127.0.0.1:8080/health")
      .then(async (response) => {
        const h = await response.json();
        const expectedVersion = Number(process.env.EXPECTED_GATEWAY_VERSION);
        const ok = response.ok && h.ok === true
          && h.version === expectedVersion
          && h.activeSessions === 0
          && h.videoEncoder?.backend === "vaapi"
          && h.videoEncoder?.ready === true
          && h.videoEncoderCapacity?.active === 0
          && h.videoEncoderCapacity?.maxActive === 4
          && h.vodInputPump?.active === 0
          && h.rawPumpCount === 0
          && h.viewerStartupReservations === 0
          && h.viewerSessionStartupAdmissions === 0
          && h.viewerSessionStartupLockCount === 0
          && h.viewerSessionStartupWaiters === 0
          && h.backgroundCpuProcessCount === 0
          && h.mkvH264FastStart?.copyActivationReady === true
          && h.mkvCompleteHlsCache?.enabled === true;
        if (!ok) process.exit(1);
        if (expectedVersion === 105) {
          const v = h.vaapiVodFastStart;
          if (v?.protocol !== 1 || v?.enabled !== true
              || v?.targetBufferSeconds !== 6 || v?.minimumEncodeRateX !== 2) process.exit(1);
        }
      })
      .catch(() => process.exit(1));
  '
}

assert_no_canary_sessions() {
  local active_sessions
  active_sessions="$(docker exec "${DB_CONTAINER}" psql -X -U postgres -d postgres -Atc \
    "select count(*) from public.cloud_gateway_sessions where gateway_id='${GATEWAY_ID}'::uuid and status in ('pending','starting','ready') and expires_at > now();")"
  [[ "${active_sessions}" == '0' ]]
}

set_canary_selection() {
  local value="$1"
  docker exec -i "${DB_CONTAINER}" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null <<SQL
update public.cloud_runtime_config
set value='${value}'
where key='NORVA_MEDIA_GATEWAY_CANARY_USER_HASHES';
SQL
}

probe_callback_from_gateway() {
  docker exec -i "${GATEWAY_CONTAINER}" node --input-type=module <<'NODE'
const base = String(process.env.NORVA_EDGE_CALLBACK_BASE || '').replace(/\/+$/, '');
const token = String(process.env.GATEWAY_TOKEN || '');
if (!base || !token) process.exit(1);
try {
  const response = await fetch(`${base}/account-activity`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{"keys":[]}',
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json();
  if (!response.ok || body?.ok !== true || body?.touched !== 0) process.exit(1);
} catch {
  process.exit(1);
}
NODE
}

rollback() {
  local exit_code="${1:-$?}"
  local image_restored=1
  local selection_restored=1
  [[ "${exit_code}" != '0' ]] || exit_code=1
  trap - ERR INT TERM
  set +e

  if [[ "${PROMOTION_STARTED}" == '1' ]]; then
    echo '===PRIVATE_V105_PROMOTION_ROLLBACK_START===' >&2
    install -m 0600 "${BACKUP_PATH}" "${ENV_PATH}" || image_restored=0
    if [[ "${image_restored}" == '1' ]]; then
      compose_gateway up -d --no-build --pull never --wait --wait-timeout 180 gateway >/dev/null \
        || image_restored=0
    fi
    if [[ "$(docker inspect "${GATEWAY_CONTAINER}" --format '{{.Image}}' 2>/dev/null || true)" != "${OLD_IMAGE_ID}" ]] \
      || [[ "$(docker inspect "${GATEWAY_CONTAINER}" --format '{{.State.Health.Status}}' 2>/dev/null || true)" != 'healthy' ]]; then
      image_restored=0
    fi
  fi

  if [[ "${SELECTION_DRAINED}" == '1' && "${SELECTED_USER_HASH}" =~ ^[0-9a-f]{64}$ ]]; then
    set_canary_selection "${SELECTED_USER_HASH}" || selection_restored=0
    wait_edge_state ready 1 || selection_restored=0
  fi

  unset gateway_token db_canary_token SELECTED_USER_HASH 2>/dev/null || true
  if [[ "${image_restored}" == '1' && "${selection_restored}" == '1' ]]; then
    echo '===PRIVATE_V105_PROMOTION_ROLLBACK_OK===' >&2
  else
    echo '===PRIVATE_V105_PROMOTION_ROLLBACK_INCOMPLETE_INSPECT_REQUIRED===' >&2
  fi
  exit "${exit_code}"
}

die() {
  printf 'PRIVATE_V105_PROMOTION_FAILED:%s\n' "$1" >&2
  rollback 1
}

trap rollback ERR INT TERM

[[ -f "${COMPOSE_PATH}" && -f "${ENV_PATH}" ]] || die 'runtime-files'
[[ "$(stat -c '%a' "${ENV_PATH}")" == '600' ]] || die 'env-mode'
[[ ! -e "${BACKUP_PATH}" ]] || die 'rollback-backup-already-exists'
grep -qx "MEDIA_GATEWAY_IMAGE=${OLD_IMAGE}" "${ENV_PATH}" || die 'old-image-config'
grep -qx "NORVA_EDGE_CALLBACK_BASE=${ACTIVE_CALLBACK}" "${ENV_PATH}" || die 'callback-not-active'
[[ "$(docker inspect "${GATEWAY_CONTAINER}" --format '{{.Config.Image}}')" == "${OLD_IMAGE}" ]] || die 'old-image-tag'
[[ "$(docker inspect "${GATEWAY_CONTAINER}" --format '{{.Image}}')" == "${OLD_IMAGE_ID}" ]] || die 'old-image-id'
[[ "$(docker inspect "${GATEWAY_CONTAINER}" --format '{{.State.Health.Status}}')" == 'healthy' ]] || die 'old-health'
[[ "$(docker inspect "${GATEWAY_CONTAINER}" --format '{{.RestartCount}}')" == '0' ]] || die 'old-restarts'
[[ "$(docker inspect "${GATEWAY_CONTAINER}" --format '{{.State.OOMKilled}}' 2>/dev/null || true)" == 'false' ]] || die 'old-oom'
for transient in norva-media-v105-provider norva-media-v105-canary; do
  if docker container inspect "${transient}" >/dev/null 2>&1; then
    die "transient-container-still-present-${transient}"
  fi
done
assert_gateway_idle 104 || die 'old-not-idle'
assert_no_canary_sessions || die 'old-canary-session-active'
wait_edge_state ready 1 || die 'edge-not-ready-one-user'

config_count="$(docker exec "${DB_CONTAINER}" psql -X -U postgres -d postgres -Atc \
  "select count(*) from public.cloud_runtime_config where key in ('NORVA_MEDIA_GATEWAY_CANARY_URL','NORVA_MEDIA_GATEWAY_CANARY_TOKEN','NORVA_MEDIA_GATEWAY_CANARY_ID','NORVA_MEDIA_GATEWAY_CANARY_USER_HASHES') and is_secret is true;")"
[[ "${config_count}" == '4' ]] || die 'canary-config'
SELECTED_USER_HASH="$(docker exec "${DB_CONTAINER}" psql -X -U postgres -d postgres -Atc \
  "select value from public.cloud_runtime_config where key='NORVA_MEDIA_GATEWAY_CANARY_USER_HASHES';")"
[[ "${SELECTED_USER_HASH}" =~ ^[0-9a-f]{64}$ ]] || die 'selected-user-hash'
db_canary_url="$(docker exec "${DB_CONTAINER}" psql -X -U postgres -d postgres -Atc \
  "select value from public.cloud_runtime_config where key='NORVA_MEDIA_GATEWAY_CANARY_URL';")"
db_canary_id="$(docker exec "${DB_CONTAINER}" psql -X -U postgres -d postgres -Atc \
  "select value from public.cloud_runtime_config where key='NORVA_MEDIA_GATEWAY_CANARY_ID';")"
[[ "${db_canary_url}" == "${GATEWAY_URL}" && "${db_canary_id}" == "${GATEWAY_ID}" ]] || die 'canary-binding'
gateway_token="$(sed -n 's/^GATEWAY_TOKEN=//p' "${ENV_PATH}")"
db_canary_token="$(docker exec "${DB_CONTAINER}" psql -X -U postgres -d postgres -Atc \
  "select value from public.cloud_runtime_config where key='NORVA_MEDIA_GATEWAY_CANARY_TOKEN';")"
[[ -n "${gateway_token}" && "${gateway_token}" == "${db_canary_token}" ]] || die 'canary-token-binding'
unset gateway_token db_canary_token db_canary_url db_canary_id config_count

[[ "$(docker image inspect "${NEW_IMAGE}" --format '{{.Id}}')" == "${NEW_IMAGE_ID}" ]] || die 'candidate-image-id'
[[ "$(docker image inspect "${NEW_IMAGE}" --format '{{index .Config.Labels "norva.bundle.sha256"}}')" == "${NEW_BUNDLE_SHA256}" ]] \
  || die 'candidate-bundle'
compose_gateway config --quiet || die 'old-compose'

echo '===PRIVATE_V105_CANARY_DRAIN==='
SELECTION_DRAINED=1
set_canary_selection ''
wait_edge_state standby 0 || die 'edge-drain'
assert_no_canary_sessions || die 'canary-session-after-drain'
assert_gateway_idle 104 || die 'gateway-busy-after-drain'

install -m 0600 "${ENV_PATH}" "${BACKUP_PATH}"
PROMOTION_STARTED=1
sed -i "s#^MEDIA_GATEWAY_IMAGE=${OLD_IMAGE}\$#MEDIA_GATEWAY_IMAGE=${NEW_IMAGE}#" "${ENV_PATH}"
chmod 0600 "${ENV_PATH}"
grep -qx "MEDIA_GATEWAY_IMAGE=${NEW_IMAGE}" "${ENV_PATH}" || die 'candidate-image-write'
grep -qx "NORVA_EDGE_CALLBACK_BASE=${ACTIVE_CALLBACK}" "${ENV_PATH}" || die 'callback-drift'
compose_gateway config --quiet || die 'candidate-compose'

echo '===PRIVATE_V105_PROMOTION_START==='
compose_gateway up -d --no-build --pull never --wait --wait-timeout 180 gateway
[[ "$(docker inspect "${GATEWAY_CONTAINER}" --format '{{.Config.Image}}')" == "${NEW_IMAGE}" ]] || die 'promoted-tag'
[[ "$(docker inspect "${GATEWAY_CONTAINER}" --format '{{.Image}}')" == "${NEW_IMAGE_ID}" ]] || die 'promoted-id'
[[ "$(docker inspect "${GATEWAY_CONTAINER}" --format '{{.State.Health.Status}}')" == 'healthy' ]] || die 'promoted-health'
[[ "$(docker inspect "${GATEWAY_CONTAINER}" --format '{{.RestartCount}}')" == '0' ]] || die 'promoted-restarts'
[[ "$(docker inspect "${GATEWAY_CONTAINER}" --format '{{.State.OOMKilled}}')" == 'false' ]] || die 'promoted-oom'
docker inspect "${GATEWAY_CONTAINER}" --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -qx "NORVA_EDGE_CALLBACK_BASE=${ACTIVE_CALLBACK}" || die 'promoted-callback'
assert_gateway_idle 105 || die 'promoted-not-ready-idle'
probe_callback_from_gateway || die 'promoted-callback-probe'

echo '===PRIVATE_V105_CANARY_RESTORE==='
set_canary_selection "${SELECTED_USER_HASH}"
wait_edge_state ready 1 || die 'edge-restore'
SELECTION_DRAINED=0
assert_no_canary_sessions || die 'unexpected-session-after-restore'
assert_gateway_idle 105 || die 'promoted-final-state'

unset SELECTED_USER_HASH
PROMOTION_STARTED=0
trap - ERR INT TERM

echo '===PRIVATE_V105_PROMOTION_OK==='
docker inspect "${GATEWAY_CONTAINER}" --format \
  'image={{.Config.Image}} image_id={{.Image}} status={{.State.Status}} health={{.State.Health.Status}} restarts={{.RestartCount}} oom={{.State.OOMKilled}}'
echo 'gateway_version=105 vaapi_fast_start=enabled target_buffer_seconds=6 minimum_encode_rate_x=2 selected_users=1 callback=authenticated'
printf 'ROLLBACK_ENV=%s\n' "${BACKUP_PATH}"
