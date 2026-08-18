#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly REVISION='b266dd296875'
readonly ARCHIVE="/home/adrien/norva-edge-media-lab-${REVISION}.tar.gz"
readonly ARCHIVE_SHA256='95386ccdb7ddbc49558a1b2ea605862ece5f52b2846f11a9f489d773e4670eae'
readonly TARGET_ROOT="/home/adrien/norva-deployments/mkv-vaapi-v54-lab-${REVISION}"
readonly TARGET_OPS="${TARGET_ROOT}/ops/hetzner"
readonly LAB_RUNNER_CONTAINER='norva-media-lab-runner'
readonly LAB_RUNNER_URL='http://norva-media-lab-runner:8093'
readonly FUNCTION_CONTAINERS=(norva-edge-functions norva-edge-functions-2)

SOURCE_OPS=''
SOURCE_ROOT=''
RUNTIME_MUTATED=0

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

container_ip() {
  docker inspect "$1" --format '{{range .NetworkSettings.Networks}}{{println .IPAddress}}{{end}}' | sed -n '1p'
}

edge_health() {
  local container="$1"
  local ip
  ip="$(container_ip "${container}")"
  [[ -n "${ip}" ]] || return 1
  curl --fail --silent --show-error --max-time 10 "http://${ip}:9000/norva-playback/health"
}

wait_edge_ready() {
  local expected_ops="$1"
  local deadline=$((SECONDS + 90))
  while (( SECONDS < deadline )); do
    local ready=1
    local container health
    for container in "${FUNCTION_CONTAINERS[@]}"; do
      [[ "$(container_working_dir "${container}" 2>/dev/null || true)" == "${expected_ops}" ]] || ready=0
      [[ "$(docker inspect "${container}" --format '{{.State.Health.Status}}' 2>/dev/null || true)" == 'healthy' ]] || ready=0
      health="$(edge_health "${container}" 2>/dev/null || true)"
      [[ "${health}" == *'"version":54'* \
          && "${health}" == *'"mediaGatewayCanaryRouting":{"protocol":1,"state":"ready","selectedUsers":1'* ]] \
        || ready=0
    done
    [[ "${ready}" == '1' ]] && return 0
    sleep 2
  done
  return 1
}

runner_health() {
  docker exec "${LAB_RUNNER_CONTAINER}" node -e '
    fetch("http://127.0.0.1:8093/health", {
      headers: { Authorization: "Bearer " + process.env.MEDIA_LAB_RUNNER_TOKEN },
    }).then(async (response) => {
      const body = await response.json();
      if (!response.ok || body.ok !== true || body.protocol !== 1 ||
          body.busy !== false || body.physicalAdapterReady !== true) process.exit(1);
    }).catch(() => process.exit(1));
  '
}

edge_to_runner_health() {
  local container="$1"
  docker exec "${container}" bash -lc '
    set -euo pipefail
    exec 3<>/dev/tcp/norva-media-lab-runner/8093
    printf "GET /health HTTP/1.1\r\nHost: norva-media-lab-runner:8093\r\nAuthorization: Bearer %s\r\nConnection: close\r\n\r\n" \
      "${NORVA_MEDIA_LAB_RUNNER_TOKEN}" >&3
    response="$(timeout 12 cat <&3)"
    [[ "${response}" == HTTP/1.1\ 200* ]]
    [[ "${response}" == *"\"ok\":true"* ]]
    [[ "${response}" == *"\"protocol\":1"* ]]
    [[ "${response}" == *"\"busy\":false"* ]]
    [[ "${response}" == *"\"physicalAdapterReady\":true"* ]]
  '
}

upsert_env() {
  local key="$1"
  local value="$2"
  local target="${TARGET_OPS}/.env"
  local temporary
  temporary="$(mktemp "${TARGET_OPS}/.env.tmp.XXXXXX")"
  awk -v prefix="${key}=" 'index($0, prefix) != 1 { print }' "${target}" > "${temporary}"
  printf '%s=%s\n' "${key}" "${value}" >> "${temporary}"
  chmod 0600 "${temporary}"
  mv -f "${temporary}" "${target}"
}

rollback() {
  local exit_code="${1:-$?}"
  local restored=1
  [[ "${exit_code}" != '0' ]] || exit_code=1
  trap - ERR INT TERM
  set +e

  if [[ "${RUNTIME_MUTATED}" == '1' && -n "${SOURCE_OPS}" ]]; then
    echo '===PRIVATE_MEDIA_LAB_EDGE_ROLLBACK_START===' >&2
    compose_from "${SOURCE_OPS}" up -d --no-deps --force-recreate functions >/dev/null || restored=0
    compose_from "${SOURCE_OPS}" up -d --no-deps --force-recreate functions2 >/dev/null || restored=0
    wait_edge_ready "${SOURCE_OPS}" || restored=0
  fi

  unset runner_token actor_key 2>/dev/null || true
  if [[ "${restored}" == '1' ]]; then
    echo '===PRIVATE_MEDIA_LAB_EDGE_ROLLBACK_OK===' >&2
  else
    echo '===PRIVATE_MEDIA_LAB_EDGE_ROLLBACK_INCOMPLETE_INSPECT_REQUIRED===' >&2
  fi
  exit "${exit_code}"
}

die() {
  printf 'PRIVATE_MEDIA_LAB_EDGE_ACTIVATION_FAILED:%s\n' "$1" >&2
  return 1
}

trap 'rollback $?' ERR INT TERM

for command_name in docker curl openssl sha256sum awk sed tar readlink stat mktemp python3; do
  command -v "${command_name}" >/dev/null 2>&1 || die "missing-${command_name}"
done

[[ -f "${ARCHIVE}" ]] || die 'archive-missing'
echo "${ARCHIVE_SHA256}  ${ARCHIVE}" | sha256sum -c - >/dev/null || die 'archive-integrity'
[[ ! -e "${TARGET_ROOT}" ]] || die 'target-already-exists'

for container in "${FUNCTION_CONTAINERS[@]}"; do
  [[ "$(docker inspect "${container}" --format '{{.State.Health.Status}}')" == 'healthy' ]] || die "source-unhealthy-${container}"
  [[ "$(docker inspect "${container}" --format '{{.State.OOMKilled}}')" == 'false' ]] || die "source-oom-${container}"
done
SOURCE_OPS="$(container_working_dir "${FUNCTION_CONTAINERS[0]}")"
[[ "${SOURCE_OPS}" =~ ^/home/adrien/norva-deployments/[^/]+/ops/hetzner$ ]] || die 'source-ops-scope'
[[ "$(container_working_dir "${FUNCTION_CONTAINERS[1]}")" == "${SOURCE_OPS}" ]] || die 'source-replica-drift'
SOURCE_ROOT="${SOURCE_OPS%/ops/hetzner}"
[[ "$(readlink -f -- "${SOURCE_OPS}")" == "${SOURCE_OPS}" ]] || die 'source-ops-link'
[[ -f "${SOURCE_OPS}/docker-compose.supabase.yml" && -d "${SOURCE_ROOT}/supabase/functions" ]] || die 'source-layout'
[[ ! -e "${SOURCE_ROOT}/supabase/functions/norva-admin-media-lab" ]] || die 'lab-already-present'
wait_edge_ready "${SOURCE_OPS}" || die 'source-edge-state'

source_env_real="$(readlink -f -- "${SOURCE_OPS}/.env")"
[[ -f "${source_env_real}" ]] || die 'source-env'
[[ "$(stat -c '%a' "${source_env_real}")" == '600' ]] || die 'source-env-mode'
[[ "$(stat -c '%U:%G' "${source_env_real}")" == 'adrien:adrien' ]] || die 'source-env-owner'

[[ "$(docker inspect "${LAB_RUNNER_CONTAINER}" --format '{{.State.Health.Status}}')" == 'healthy' ]] || die 'runner-container-health'
[[ "$(docker inspect "${LAB_RUNNER_CONTAINER}" --format '{{.RestartCount}}')" == '0' ]] || die 'runner-container-restarts'
[[ "$(docker inspect "${LAB_RUNNER_CONTAINER}" --format '{{.State.OOMKilled}}')" == 'false' ]] || die 'runner-container-oom'
[[ "$(docker inspect "${LAB_RUNNER_CONTAINER}" --format '{{json .HostConfig.PortBindings}}')" == 'null' \
    || "$(docker inspect "${LAB_RUNNER_CONTAINER}" --format '{{json .HostConfig.PortBindings}}')" == '{}' ]] \
  || die 'runner-public-port'
runner_health || die 'runner-health'
runner_token="$(docker inspect "${LAB_RUNNER_CONTAINER}" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^MEDIA_LAB_RUNNER_TOKEN=//p')"
[[ "${runner_token}" =~ ^[0-9a-f]{64}$ ]] || die 'runner-token-shape'

install -d -m 0750 "${TARGET_ROOT}"
cp -a "${SOURCE_ROOT}/." "${TARGET_ROOT}/"
rm -f -- "${TARGET_OPS}/.env"
install -m 0600 "${source_env_real}" "${TARGET_OPS}/.env"
tar -xzf "${ARCHIVE}" -C "${TARGET_ROOT}"

printf '%s\n' \
  '4357009f3aef11c1d9094b7eb57ca94a8cf3d1a090f89279ca652ee6035e5279  supabase/config.toml' \
  '74f9540af53f4ecadc1efa6cdcdb939c0e738654cd6475b3a2adce6d8a026c33  supabase/functions/norva-admin-media-lab/index.ts' \
  '2d61dff980a339aa0802bf0b60649e2007fa02ea893c7e190c8df45281bdbd3e  supabase/functions/_shared/media-lab-contract.mjs' \
  | (cd "${TARGET_ROOT}" && sha256sum -c -) >/dev/null || die 'payload-integrity'

python3 - "${TARGET_OPS}/docker-compose.supabase.yml" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
keys = (
    "NORVA_MEDIA_LAB_ENABLED",
    "NORVA_MEDIA_LAB_RUNNER_URL",
    "NORVA_MEDIA_LAB_RUNNER_TOKEN",
    "NORVA_MEDIA_LAB_ACTOR_HMAC_KEY",
)
if any(key in text for key in keys):
    raise SystemExit("media Lab compose keys already present")
needle = "      NORVA_MEDIA_GATEWAY_CANARY_USER_HASHES: ${NORVA_MEDIA_GATEWAY_CANARY_USER_HASHES:-}\n"
if text.count(needle) != 1:
    raise SystemExit("media Gateway canary env anchor drift")
addition = needle + (
    "      # Private, admin-only fixed-corpus media Lab. All values fail closed.\n"
    "      NORVA_MEDIA_LAB_ENABLED: ${NORVA_MEDIA_LAB_ENABLED:-false}\n"
    "      NORVA_MEDIA_LAB_RUNNER_URL: ${NORVA_MEDIA_LAB_RUNNER_URL:-}\n"
    "      NORVA_MEDIA_LAB_RUNNER_TOKEN: ${NORVA_MEDIA_LAB_RUNNER_TOKEN:-}\n"
    "      NORVA_MEDIA_LAB_ACTOR_HMAC_KEY: ${NORVA_MEDIA_LAB_ACTOR_HMAC_KEY:-}\n"
)
path.write_text(text.replace(needle, addition), encoding="utf-8")
PY

actor_key="$(openssl rand -hex 32)"
[[ "${actor_key}" =~ ^[0-9a-f]{64}$ ]] || die 'actor-key-generation'
upsert_env 'NORVA_MEDIA_LAB_ENABLED' 'true'
upsert_env 'NORVA_MEDIA_LAB_RUNNER_URL' "${LAB_RUNNER_URL}"
upsert_env 'NORVA_MEDIA_LAB_RUNNER_TOKEN' "${runner_token}"
upsert_env 'NORVA_MEDIA_LAB_ACTOR_HMAC_KEY' "${actor_key}"
unset runner_token actor_key

[[ "$(stat -c '%a' "${TARGET_OPS}/.env")" == '600' ]] || die 'target-env-mode'
[[ "$(stat -c '%U:%G' "${TARGET_OPS}/.env")" == 'adrien:adrien' ]] || die 'target-env-owner'
grep -qx 'NORVA_MEDIA_LAB_ENABLED=true' "${TARGET_OPS}/.env" || die 'target-env-enabled'
grep -qx "NORVA_MEDIA_LAB_RUNNER_URL=${LAB_RUNNER_URL}" "${TARGET_OPS}/.env" || die 'target-env-runner-url'
compose_from "${TARGET_OPS}" config --quiet || die 'target-compose'

echo '===PRIVATE_MEDIA_LAB_EDGE_ACTIVATION_START==='
RUNTIME_MUTATED=1
bash "${TARGET_OPS}/scripts/04-deploy-edge-functions.sh"
wait_edge_ready "${TARGET_OPS}" || die 'target-edge-state'

for container in "${FUNCTION_CONTAINERS[@]}"; do
  docker inspect "${container}" --format '{{range .Config.Env}}{{println .}}{{end}}' \
    | grep -qx 'NORVA_MEDIA_LAB_ENABLED=true' || die "edge-lab-disabled-${container}"
  docker inspect "${container}" --format '{{range .Config.Env}}{{println .}}{{end}}' \
    | grep -q '^NORVA_MEDIA_LAB_RUNNER_TOKEN=.' || die "edge-runner-token-${container}"
  docker inspect "${container}" --format '{{range .Config.Env}}{{println .}}{{end}}' \
    | grep -Eq '^NORVA_MEDIA_LAB_ACTOR_HMAC_KEY=[0-9a-f]{64}$' || die "edge-actor-key-${container}"
  edge_to_runner_health "${container}" || die "edge-runner-health-${container}"
  ip="$(container_ip "${container}")"
  response_file="$(mktemp)"
  response_code="$(curl --silent --show-error --max-time 15 -o "${response_file}" -w '%{http_code}' \
    "http://${ip}:9000/norva-admin-media-lab/current")"
  [[ "${response_code}" == '403' ]] || die "edge-unauthorized-status-${container}"
  grep -Eq '^\{"protocol":1,"error":"admin-required"\}$' "${response_file}" \
    || die "edge-unauthorized-body-${container}"
  rm -f -- "${response_file}"
done

RUNTIME_MUTATED=0
trap - ERR INT TERM

echo '===PRIVATE_MEDIA_LAB_EDGE_ACTIVATION_OK==='
echo "revision=${REVISION} replicas=2 runner=private physical_adapter=ready selected_users=1 rollback_source=${SOURCE_ROOT}"
