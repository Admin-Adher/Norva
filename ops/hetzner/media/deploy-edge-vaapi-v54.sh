#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly SOURCE_ROOT='/home/adrien/norva-deployments/mkv-vaapi-v53-11a301100cd0'
readonly TARGET_ROOT='/home/adrien/norva-deployments/mkv-vaapi-v54-9bbcddbecb3b'
readonly ARCHIVE='/home/adrien/norva-edge-vaapi-v54-20260817-225008.tar.gz'
readonly ARCHIVE_SHA256='9bbcddbecb3b2804398bbe07f57b0658f7766befa245acacbaa10d49a1480dde'
readonly SOURCE_OPS="${SOURCE_ROOT}/ops/hetzner"
readonly TARGET_OPS="${TARGET_ROOT}/ops/hetzner"
readonly DB_CONTAINER='norva-db'
readonly GATEWAY_CONTAINER='norva-media-gateway'
readonly GATEWAY_IMAGE='norva-media-gateway:vaapi-3d9cbd892800'
readonly GATEWAY_IMAGE_ID='sha256:1997592fd597b1f51735a2bcece179a0c3ab4b55502440b4c86ec19dfc2f0ad6'
readonly GATEWAY_ID='a7250ec1-171b-4bcf-ad7d-41bac56130ec'
readonly GATEWAY_URL='http://norva-media-gateway:8080'
readonly ACTIVE_CALLBACK='https://api.norva.tv/functions/v1/norva-playback'
readonly FUNCTION_CONTAINERS=(norva-edge-functions norva-edge-functions-2)

RUNTIME_MUTATED=0
SELECTION_DRAINED=0
SELECTED_USER_HASH=''

compose_from() {
  local root="$1"
  shift
  docker compose \
    --env-file "${root}/.env" \
    -f "${root}/docker-compose.supabase.yml" \
    "$@"
}

container_working_dir() {
  docker inspect "$1" --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}'
}

edge_health() {
  local container="$1"
  local ip
  ip="$(docker inspect "${container}" --format '{{range .NetworkSettings.Networks}}{{println .IPAddress}}{{end}}' | sed -n '1p')"
  [[ -n "${ip}" ]] || return 1
  curl --fail --silent --show-error --max-time 10 "http://${ip}:9000/norva-playback/health"
}

wait_edge_state() {
  local expected_version="$1"
  local expected_state="$2"
  local expected_selected="$3"
  local deadline=$((SECONDS + 70))
  while (( SECONDS < deadline )); do
    local ready=1
    local container health
    for container in "${FUNCTION_CONTAINERS[@]}"; do
      health="$(edge_health "${container}" 2>/dev/null || true)"
      [[ "${health}" == *"\"version\":${expected_version}"* \
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
          && h.version === 105
          && h.activeSessions === 0
          && h.videoEncoder?.backend === "vaapi"
          && h.videoEncoder?.ready === true
          && h.videoEncoderCapacity?.active === 0
          && h.vodInputPump?.active === 0
          && h.rawPumpCount === 0
          && h.viewerStartupReservations === 0
          && h.viewerSessionStartupAdmissions === 0
          && h.viewerSessionStartupLockCount === 0
          && h.viewerSessionStartupWaiters === 0
          && h.backgroundCpuProcessCount === 0
          && h.mkvH264FastStart?.copyActivationReady === true
          && h.mkvCompleteHlsCache?.enabled === true
          && h.vaapiVodFastStart?.enabled === true
          && h.vaapiVodFastStart?.targetBufferSeconds === 6
          && h.vaapiVodFastStart?.minimumEncodeRateX === 2;
        if (!ok) process.exit(1);
      }).catch(() => process.exit(1));
  '
}

active_canary_session_count() {
  docker exec "${DB_CONTAINER}" psql -X -U postgres -d postgres -Atc \
    "select count(*) from public.cloud_gateway_sessions where gateway_id='${GATEWAY_ID}'::uuid and status in ('pending','starting','ready') and expires_at > now();"
}

wait_no_canary_sessions() {
  local deadline=$((SECONDS + 45))
  while (( SECONDS < deadline )); do
    [[ "$(active_canary_session_count)" == '0' ]] && return 0
    sleep 2
  done
  return 1
}

set_canary_selection() {
  local value="$1"
  docker exec -i "${DB_CONTAINER}" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null <<SQL
update public.cloud_runtime_config
set value='${value}'
where key='NORVA_MEDIA_GATEWAY_CANARY_USER_HASHES';
SQL
}

rollback() {
  local exit_code="${1:-$?}"
  local runtime_restored=1
  local selection_restored=1
  [[ "${exit_code}" != '0' ]] || exit_code=1
  trap - ERR INT TERM
  set +e

  if [[ "${RUNTIME_MUTATED}" == '1' ]]; then
    echo '===EDGE_V54_ROLLBACK_START===' >&2
    if [[ "${SELECTED_USER_HASH}" =~ ^[0-9a-f]{64}$ ]]; then
      set_canary_selection '' || selection_restored=0
    fi
    compose_from "${SOURCE_OPS}" up -d --no-deps --force-recreate functions >/dev/null \
      || runtime_restored=0
    compose_from "${SOURCE_OPS}" up -d --no-deps --force-recreate functions2 >/dev/null \
      || runtime_restored=0
    for container in "${FUNCTION_CONTAINERS[@]}"; do
      [[ "$(container_working_dir "${container}" 2>/dev/null)" == "${SOURCE_OPS}" ]] || runtime_restored=0
      [[ "$(docker inspect "${container}" --format '{{.State.Health.Status}}' 2>/dev/null)" == 'healthy' ]] \
        || runtime_restored=0
    done
    wait_edge_state 53 standby 0 || runtime_restored=0
  fi

  if [[ "${SELECTION_DRAINED}" == '1' && "${SELECTED_USER_HASH}" =~ ^[0-9a-f]{64}$ ]]; then
    set_canary_selection "${SELECTED_USER_HASH}" || selection_restored=0
    wait_edge_state 53 ready 1 || selection_restored=0
  fi

  unset SELECTED_USER_HASH gateway_token db_canary_token 2>/dev/null || true
  if [[ "${runtime_restored}" == '1' && "${selection_restored}" == '1' ]]; then
    echo '===EDGE_V54_ROLLBACK_OK===' >&2
  else
    echo '===EDGE_V54_ROLLBACK_INCOMPLETE_INSPECT_REQUIRED===' >&2
  fi
  exit "${exit_code}"
}

die() {
  printf 'EDGE_V54_DEPLOY_FAILED:%s\n' "$1" >&2
  rollback 1
}

trap rollback ERR INT TERM

[[ -f "${ARCHIVE}" ]] || die 'archive-missing'
echo "${ARCHIVE_SHA256}  ${ARCHIVE}" | sha256sum -c - >/dev/null || die 'archive-integrity'
[[ -d "${SOURCE_ROOT}/supabase/functions" ]] || die 'source-functions'
[[ -f "${SOURCE_OPS}/docker-compose.supabase.yml" ]] || die 'source-compose'
SOURCE_ENV_REAL="$(readlink -f -- "${SOURCE_OPS}/.env")" || die 'source-env-resolve'
[[ -n "${SOURCE_ENV_REAL}" && -f "${SOURCE_ENV_REAL}" ]] || die 'source-env'
[[ "$(stat -c '%a' "${SOURCE_ENV_REAL}")" == '600' ]] || die 'source-env-mode'
[[ "$(stat -c '%U:%G' "${SOURCE_ENV_REAL}")" == 'adrien:adrien' ]] || die 'source-env-owner'
[[ ! -e "${TARGET_ROOT}" ]] || die 'target-already-exists'

for container in "${FUNCTION_CONTAINERS[@]}"; do
  [[ "$(container_working_dir "${container}")" == "${SOURCE_OPS}" ]] || die "source-runtime-drift-${container}"
  [[ "$(docker inspect "${container}" --format '{{.State.Health.Status}}')" == 'healthy' ]] || die "source-unhealthy-${container}"
done
wait_edge_state 53 ready 1 || die 'source-edge-state'

[[ "$(docker inspect "${GATEWAY_CONTAINER}" --format '{{.Config.Image}}')" == "${GATEWAY_IMAGE}" ]] || die 'gateway-tag'
[[ "$(docker inspect "${GATEWAY_CONTAINER}" --format '{{.Image}}' 2>/dev/null || true)" == "${GATEWAY_IMAGE_ID}" ]] || die 'gateway-id'
[[ "$(docker inspect "${GATEWAY_CONTAINER}" --format '{{.State.Health.Status}}')" == 'healthy' ]] || die 'gateway-health'
[[ "$(docker inspect "${GATEWAY_CONTAINER}" --format '{{.RestartCount}}')" == '0' ]] || die 'gateway-restarts'
[[ "$(docker inspect "${GATEWAY_CONTAINER}" --format '{{.State.OOMKilled}}')" == 'false' ]] || die 'gateway-oom'
docker inspect "${GATEWAY_CONTAINER}" --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -qx "NORVA_EDGE_CALLBACK_BASE=${ACTIVE_CALLBACK}" || die 'gateway-callback'
assert_gateway_idle || die 'gateway-not-idle-ready'
[[ "$(active_canary_session_count)" == '0' ]] || die 'active-canary-session'

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
gateway_token="$(docker inspect "${GATEWAY_CONTAINER}" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^GATEWAY_TOKEN=//p')"
db_canary_token="$(docker exec "${DB_CONTAINER}" psql -X -U postgres -d postgres -Atc \
  "select value from public.cloud_runtime_config where key='NORVA_MEDIA_GATEWAY_CANARY_TOKEN';")"
[[ -n "${gateway_token}" && "${gateway_token}" == "${db_canary_token}" ]] || die 'canary-token'
unset gateway_token db_canary_token db_canary_url db_canary_id config_count

install -d -m 0750 "${TARGET_ROOT}"
cp -a "${SOURCE_ROOT}/." "${TARGET_ROOT}/"
install -m 0600 "${SOURCE_ENV_REAL}" "${TARGET_OPS}/.env"
[[ ! -L "${TARGET_OPS}/.env" ]] || die 'target-env-link'
[[ "$(stat -c '%a' "${TARGET_OPS}/.env")" == '600' ]] || die 'target-env-mode'
[[ "$(stat -c '%U:%G' "${TARGET_OPS}/.env")" == 'adrien:adrien' ]] || die 'target-env-owner'
tar -xzf "${ARCHIVE}" -C "${TARGET_ROOT}"

printf '%s\n' \
  'a7a31dca6004980ca7088eba65f64ba1b691c416faee978d1e560427b7c12546  supabase/functions/norva-playback/index.ts' \
  'a80553e64b60c7b3eea5248679932ba7d6ee6a13144feb4ef93e2855cf894b1a  supabase/functions/_shared/media-gateway-canary-routing.mjs' \
  'a0967191a93343b94c609a47ff99fb34351adf8624f3568749db8be9da4326fc  supabase/functions/_shared/media-gateway-session-lifecycle.mjs' \
  '767d3315c950070c93c827adc9c2bc583b17b3adba2a425fa0ca7dbbb1039dda  ops/hetzner/scripts/04-deploy-edge-functions.sh' \
  | (cd "${TARGET_ROOT}" && sha256sum -c -) >/dev/null || die 'payload-integrity'
compose_from "${TARGET_OPS}" config --quiet || die 'target-compose'

echo '===EDGE_V54_CANARY_DRAIN==='
SELECTION_DRAINED=1
set_canary_selection ''
wait_edge_state 53 standby 0 || die 'edge-drain'
wait_no_canary_sessions || die 'canary-session-drain-timeout'
assert_gateway_idle || die 'gateway-busy-after-drain'

echo '===EDGE_V54_DEPLOY_START==='
RUNTIME_MUTATED=1
bash "${TARGET_OPS}/scripts/04-deploy-edge-functions.sh"
for container in "${FUNCTION_CONTAINERS[@]}"; do
  [[ "$(container_working_dir "${container}")" == "${TARGET_OPS}" ]] || die "target-runtime-drift-${container}"
  [[ "$(docker inspect "${container}" --format '{{.State.Health.Status}}')" == 'healthy' ]] || die "target-unhealthy-${container}"
done
wait_edge_state 54 standby 0 || die 'target-standby-state'

echo '===EDGE_V54_CANARY_RESTORE==='
set_canary_selection "${SELECTED_USER_HASH}"
wait_edge_state 54 ready 1 || die 'target-ready-state'
assert_gateway_idle || die 'gateway-final-state'
[[ "$(active_canary_session_count)" == '0' ]] || die 'unexpected-final-session'

SELECTION_DRAINED=0
unset SELECTED_USER_HASH
RUNTIME_MUTATED=0
trap - ERR INT TERM

echo '===EDGE_V54_DEPLOYED_ONE_USER_OK==='
echo 'replicas=2 version=54 canary_state=ready selected_users=1 gateway_version=105 rollback=armed'
