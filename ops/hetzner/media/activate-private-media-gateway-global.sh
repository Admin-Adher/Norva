#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly MEDIA_ROOT='/home/adrien/norva-media-deployments/b180cdcbf0be/ops/hetzner/media'
readonly ENV_PATH="${MEDIA_ROOT}/.env.media-vaapi"
readonly DB_CONTAINER='norva-db'
readonly GATEWAY_CONTAINER='norva-media-gateway'
readonly GATEWAY_IMAGE='norva-media-gateway:vaapi-b180cdcbf0be'
readonly GATEWAY_IMAGE_ID='sha256:921869a5afaf3ef24167231af0fe292972cc31e5b46d16d0b50ca3512b99f1c1'
readonly GATEWAY_ID='a7250ec1-171b-4bcf-ad7d-41bac56130ec'
readonly ACTIVE_CALLBACK='https://api.norva.tv/functions/v1/norva-playback'
readonly FUNCTION_VERSION='56'
readonly EDGE_RUNTIME_CONFIG_CACHE_SETTLE_SECONDS=35
readonly FUNCTION_CONTAINERS=(norva-edge-functions norva-edge-functions-2)
readonly ROLLBACK_DIR="${MEDIA_ROOT}/rollbacks"
readonly ROLLBACK_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
readonly ROLLBACK_SQL="${ROLLBACK_DIR}/media-gateway-global-${ROLLBACK_STAMP}.sql"

CONFIG_MUTATED=0

die() {
  printf 'PRIVATE_MEDIA_GATEWAY_GLOBAL_FAILED:%s\n' "$1" >&2
  restore_previous_config 1
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
  local deadline=$((SECONDS + 90))
  while (( SECONDS < deadline )); do
    local ready=1
    local container health
    for container in "${FUNCTION_CONTAINERS[@]}"; do
      health="$(edge_health "${container}" 2>/dev/null || true)"
      [[ "${health}" == *"\"version\":${FUNCTION_VERSION}"* \
          && "${health}" == *'"gatewayConfigured":true'* \
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
          && h.version === 109
          && h.videoEncoder?.backend === "vaapi"
          && h.videoEncoder?.ready === true
          && h.mkvH264FastStart?.copyActivationReady === true
          && h.mkvCompleteHlsCache?.enabled === true
          && h.finiteMkvSeekBroker?.plannedSupersessionReopensImmediately === true
          && h.activeSessions === 0
          && h.videoEncoderCapacity?.active === 0
          && h.vodInputPump?.active === 0
          && h.finiteMkvSeekBroker?.active === 0
          && h.rawPumpCount === 0
          && h.viewerSessionStartupLockCount === 0
          && h.backgroundCpuProcessCount === 0;
        if (!ok) process.exit(1);
      }).catch(() => process.exit(1));
  '
}

probe_edge_connectivity() {
  local edge
  for edge in "${FUNCTION_CONTAINERS[@]}"; do
    docker exec "${edge}" bash -lc \
      'exec 3<>/dev/tcp/norva-media-gateway/8080; printf "GET /health HTTP/1.0\r\nHost: norva-media-gateway\r\nConnection: close\r\n\r\n" >&3; IFS= read -r status <&3; [[ "$status" == *" 200 "* ]]' \
      || return 1
  done
}

restore_previous_config() {
  local status="${1:-$?}"
  local restored=0
  trap - ERR INT TERM
  set +e
  if [[ "${CONFIG_MUTATED}" == '1' && -s "${ROLLBACK_SQL}" ]]; then
    if docker exec -i "${DB_CONTAINER}" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres \
      < "${ROLLBACK_SQL}" >/dev/null; then
      sleep "${EDGE_RUNTIME_CONFIG_CACHE_SETTLE_SECONDS}"
      if wait_edge_state ready 1; then
        restored=1
      fi
    fi
    if [[ "${restored}" == '1' ]]; then
      echo '===PRIVATE_MEDIA_GATEWAY_GLOBAL_ROLLED_BACK===' >&2
    else
      echo '===PRIVATE_MEDIA_GATEWAY_GLOBAL_ROLLBACK_INCOMPLETE_INSPECT_REQUIRED===' >&2
    fi
  fi
  exit "${status}"
}

trap 'restore_previous_config $?' ERR INT TERM

[[ "$#" == '0' ]] || die 'unexpected-arguments'
[[ -f "${ENV_PATH}" && "$(stat -c '%a' "${ENV_PATH}")" == '600' ]] || die 'media-env'
grep -qx "MEDIA_GATEWAY_IMAGE=${GATEWAY_IMAGE}" "${ENV_PATH}" || die 'image-config'
grep -qx "NORVA_EDGE_CALLBACK_BASE=${ACTIVE_CALLBACK}" "${ENV_PATH}" || die 'callback-not-authenticated'
[[ "$(docker inspect "${GATEWAY_CONTAINER}" --format '{{.Config.Image}}')" == "${GATEWAY_IMAGE}" ]] || die 'gateway-image-tag'
[[ "$(docker inspect "${GATEWAY_CONTAINER}" --format '{{.Image}}')" == "${GATEWAY_IMAGE_ID}" ]] || die 'gateway-image-id'
[[ "$(docker inspect "${GATEWAY_CONTAINER}" --format '{{.State.Health.Status}}')" == 'healthy' ]] || die 'gateway-health'
[[ "$(docker inspect "${GATEWAY_CONTAINER}" --format '{{.RestartCount}}')" == '0' ]] || die 'gateway-restarts'
[[ "$(docker inspect "${GATEWAY_CONTAINER}" --format '{{.State.OOMKilled}}')" == 'false' ]] || die 'gateway-oom'
assert_gateway_idle || die 'gateway-not-idle'

for edge in "${FUNCTION_CONTAINERS[@]}"; do
  env_lines="$(docker inspect "${edge}" --format '{{range .Config.Env}}{{println .}}{{end}}')"
  grep -qx 'NORVA_MEDIA_GATEWAY_URL=' <<<"${env_lines}" || die "${edge}-default-url-env"
  if grep -q '^NORVA_MEDIA_GATEWAY_TOKEN=.' <<<"${env_lines}"; then
    die "${edge}-default-token-env"
  fi
done

config_shape="$(docker exec "${DB_CONTAINER}" psql -X -U postgres -d postgres -Atc \
  "select count(*) || '|' || count(*) filter (where is_secret) from public.cloud_runtime_config where key in ('NORVA_MEDIA_GATEWAY_URL','NORVA_MEDIA_GATEWAY_TOKEN','NORVA_MEDIA_GATEWAY_CANARY_URL','NORVA_MEDIA_GATEWAY_CANARY_TOKEN','NORVA_MEDIA_GATEWAY_CANARY_ID','NORVA_MEDIA_GATEWAY_CANARY_USER_HASHES');")"
[[ "${config_shape}" == '6|6' ]] || die 'runtime-config-shape'

binding_state="$(docker exec "${DB_CONTAINER}" psql -X -U postgres -d postgres -Atc \
  "select (select value='http://norva-media-gateway:8080' from public.cloud_runtime_config where key='NORVA_MEDIA_GATEWAY_CANARY_URL')::int || '|' || (select value='${GATEWAY_ID}' from public.cloud_runtime_config where key='NORVA_MEDIA_GATEWAY_CANARY_ID')::int || '|' || (select length(value) from public.cloud_runtime_config where key='NORVA_MEDIA_GATEWAY_CANARY_USER_HASHES') || '|' || (select (value=(select value from public.cloud_runtime_config where key='NORVA_MEDIA_GATEWAY_CANARY_TOKEN'))::int from public.cloud_runtime_config where key='NORVA_MEDIA_GATEWAY_TOKEN');")"
[[ "${binding_state}" =~ ^1\|1\|64\|[01]$ ]] || die 'canary-binding-state'

gateway_token="$(sed -n 's/^GATEWAY_TOKEN=//p' "${ENV_PATH}")"
db_canary_token="$(docker exec "${DB_CONTAINER}" psql -X -U postgres -d postgres -Atc \
  "select value from public.cloud_runtime_config where key='NORVA_MEDIA_GATEWAY_CANARY_TOKEN';")"
[[ -n "${gateway_token}" && "${gateway_token}" == "${db_canary_token}" ]] || die 'gateway-token-binding'
unset gateway_token db_canary_token

active_state="$(docker exec "${DB_CONTAINER}" psql -X -U postgres -d postgres -Atc \
  "select (select count(*) from public.cloud_playback_sessions where status in ('pending','ready') and expires_at > now()) || '|' || (select count(*) from public.cloud_gateway_sessions where status in ('pending','starting','ready') and expires_at > now());")"
[[ "${active_state}" == '0|0' ]] || die 'sessions-not-drained'

wait_edge_state ready 1 || die 'edge-canary-not-ready'
probe_edge_connectivity || die 'edge-gateway-connectivity'

install -d -m 0700 "${ROLLBACK_DIR}"
{
  printf 'begin;\n'
  docker exec "${DB_CONTAINER}" psql -X -U postgres -d postgres -Atc \
    "select format('update public.cloud_runtime_config set value=%L where key=%L;', value, key) from public.cloud_runtime_config where key in ('NORVA_MEDIA_GATEWAY_URL','NORVA_MEDIA_GATEWAY_TOKEN','NORVA_MEDIA_GATEWAY_CANARY_USER_HASHES') order by key;"
  printf 'commit;\n'
} > "${ROLLBACK_SQL}"
chmod 0600 "${ROLLBACK_SQL}"
[[ "$(grep -c '^update public.cloud_runtime_config' "${ROLLBACK_SQL}")" == '3' ]] || die 'rollback-capture'
sha256sum "${ROLLBACK_SQL}" > "${ROLLBACK_SQL}.sha256"
chmod 0600 "${ROLLBACK_SQL}.sha256"

CONFIG_MUTATED=1
docker exec -i "${DB_CONTAINER}" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null <<'SQL'
begin;
do $global_route$
declare
  v_canary_url text;
  v_canary_token text;
begin
  select value into strict v_canary_url
  from public.cloud_runtime_config
  where key = 'NORVA_MEDIA_GATEWAY_CANARY_URL' and is_secret is true;

  select value into strict v_canary_token
  from public.cloud_runtime_config
  where key = 'NORVA_MEDIA_GATEWAY_CANARY_TOKEN' and is_secret is true;

  if v_canary_url <> 'http://norva-media-gateway:8080' or length(v_canary_token) < 32 then
    raise exception 'private media gateway binding is invalid';
  end if;

  update public.cloud_runtime_config
  set value = v_canary_url
  where key = 'NORVA_MEDIA_GATEWAY_URL' and is_secret is true;
  if not found then raise exception 'default media gateway URL is missing'; end if;

  update public.cloud_runtime_config
  set value = v_canary_token
  where key = 'NORVA_MEDIA_GATEWAY_TOKEN' and is_secret is true;
  if not found then raise exception 'default media gateway token is missing'; end if;

  update public.cloud_runtime_config
  set value = ''
  where key = 'NORVA_MEDIA_GATEWAY_CANARY_USER_HASHES' and is_secret is true;
  if not found then raise exception 'canary selection is missing'; end if;
end
$global_route$;
commit;
SQL

sleep "${EDGE_RUNTIME_CONFIG_CACHE_SETTLE_SECONDS}"
wait_edge_state standby 0 || die 'edge-global-route-not-ready'

global_state="$(docker exec "${DB_CONTAINER}" psql -X -U postgres -d postgres -Atc \
  "select (select value=(select value from public.cloud_runtime_config where key='NORVA_MEDIA_GATEWAY_CANARY_URL') from public.cloud_runtime_config where key='NORVA_MEDIA_GATEWAY_URL')::int || '|' || (select value=(select value from public.cloud_runtime_config where key='NORVA_MEDIA_GATEWAY_CANARY_TOKEN') from public.cloud_runtime_config where key='NORVA_MEDIA_GATEWAY_TOKEN')::int || '|' || (select length(value) from public.cloud_runtime_config where key='NORVA_MEDIA_GATEWAY_CANARY_USER_HASHES');")"
[[ "${global_state}" == '1|1|0' ]] || die 'global-binding-verification'
probe_edge_connectivity || die 'edge-global-connectivity'
assert_gateway_idle || die 'gateway-post-route-not-idle'

CONFIG_MUTATED=0
trap - ERR INT TERM

echo '===PRIVATE_MEDIA_GATEWAY_GLOBAL_READY_OK==='
echo 'audience=all-current-and-future-users route=default-private selected_users=0 gateway_version=109 edge_version=56 rollback=armed'
printf 'ROLLBACK_SQL=%s\n' "${ROLLBACK_SQL}"
