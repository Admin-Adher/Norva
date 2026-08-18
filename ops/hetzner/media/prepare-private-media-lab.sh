#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly RELEASE_ROOT="$(cd -- "${SCRIPT_DIR}/../../.." && pwd -P)"
readonly COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.media-lab.yml"
readonly ENV_FILE="${SCRIPT_DIR}/.env.media-lab"
readonly SOURCE_MARKER="${SCRIPT_DIR}/media-lab-runner-source.sha256"
readonly PRIMARY_CONTAINER='norva-media-gateway'
readonly PRIMARY_IMAGE='norva-media-gateway:vaapi-3d9cbd892800'
readonly PRIMARY_IMAGE_ID='sha256:1997592fd597b1f51735a2bcece179a0c3ab4b55502440b4c86ec19dfc2f0ad6'
readonly LAB_GATEWAY_CONTAINER='norva-media-lab-gateway'
readonly LAB_RUNNER_CONTAINER='norva-media-lab-runner'
readonly LAB_NETWORK='norva_default'

CURRENT_GATE='bootstrap'
STARTED_THIS_RUN='false'
FAIL_REPORTED='false'

die() {
  FAIL_REPORTED='true'
  printf 'PRIVATE_MEDIA_LAB_PREPARE_FAIL:%s\n' "$1" >&2
  exit 1
}

on_exit() {
  local exit_code="$?"
  trap - EXIT
  if [[ "${exit_code}" -ne 0 ]]; then
    if [[ "${FAIL_REPORTED}" != 'true' ]]; then
    printf 'PRIVATE_MEDIA_LAB_PREPARE_FAIL:unexpected-%s\n' "${CURRENT_GATE}" >&2
    fi
    if [[ "${STARTED_THIS_RUN}" == 'true' && -f "${ENV_FILE}" ]]; then
      docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" down --remove-orphans >/dev/null 2>&1 || true
    fi
  fi
  exit "${exit_code}"
}
trap on_exit EXIT

CURRENT_GATE='local-files'
for required in \
  "${COMPOSE_FILE}" \
  "${SOURCE_MARKER}" \
  "${RELEASE_ROOT}/services/media-lab-runner/Dockerfile" \
  "${RELEASE_ROOT}/services/media-lab-runner/package-lock.json" \
  "${RELEASE_ROOT}/services/media-lab-runner/scripts/run-private-case.js" \
  "${RELEASE_ROOT}/services/media-gateway/src/ocr_pgs.py" \
  "${RELEASE_ROOT}/public/js/vendor/hls-1.5.7.min.js"; do
  [[ -f "${required}" ]] || die "missing-$(basename -- "${required}")"
done

runner_source_sha="$(tr -d '\r\n' < "${SOURCE_MARKER}")"
[[ "${runner_source_sha}" =~ ^[0-9a-f]{64}$ ]] || die 'runner-source-marker'
runner_revision="${runner_source_sha:0:12}"
runner_image="norva-media-lab-runner:${runner_revision}"

CURRENT_GATE='host-prerequisites'
for command_name in docker openssl sha256sum getent sudo; do
  command -v "${command_name}" >/dev/null 2>&1 || die "missing-${command_name}"
done
docker compose version >/dev/null 2>&1 || die 'docker-compose'
[[ -c /dev/dri/renderD128 ]] || die 'render-device'
render_gid="$(getent group render | awk -F: 'NR==1 {print $3}')"
[[ "${render_gid}" =~ ^[0-9]+$ ]] || die 'render-group'
docker network inspect "${LAB_NETWORK}" >/dev/null 2>&1 || die 'docker-network'

CURRENT_GATE='primary-gateway-invariant'
[[ "$(docker inspect "${PRIMARY_CONTAINER}" --format '{{.Config.Image}}')" == "${PRIMARY_IMAGE}" ]] || die 'primary-image-tag'
[[ "$(docker inspect "${PRIMARY_CONTAINER}" --format '{{.Image}}')" == "${PRIMARY_IMAGE_ID}" ]] || die 'primary-image-id'
[[ "$(docker inspect "${PRIMARY_CONTAINER}" --format '{{.State.Health.Status}}')" == 'healthy' ]] || die 'primary-health'
[[ "$(docker inspect "${PRIMARY_CONTAINER}" --format '{{.RestartCount}}')" == '0' ]] || die 'primary-restarts'
[[ "$(docker inspect "${PRIMARY_CONTAINER}" --format '{{.State.OOMKilled}}')" == 'false' ]] || die 'primary-oom'

CURRENT_GATE='private-runtime-directories'
runtime_uid="$(id -u)"
runtime_gid="$(id -g)"
sudo install -d -m 0750 -o "${runtime_uid}" -g "${runtime_gid}" /srv/norva-media-lab
sudo install -d -m 0750 -o "${runtime_uid}" -g "${runtime_gid}" /srv/norva-media-lab/output
sudo install -d -m 0750 -o "${runtime_uid}" -g "${runtime_gid}" /srv/norva-media-lab/cache

CURRENT_GATE='private-environment'
if [[ ! -f "${ENV_FILE}" ]]; then
  runner_token="$(openssl rand -hex 32)"
  gateway_token="$(openssl rand -hex 32)"
  fast_start_key="$(openssl rand -hex 32)"
  cache_key="$(openssl rand -hex 32)"
  cat > "${ENV_FILE}" <<EOF
MEDIA_LAB_UID=${runtime_uid}
MEDIA_LAB_GID=${runtime_gid}
RENDER_GID=${render_gid}
NORVA_DOCKER_NETWORK=${LAB_NETWORK}
MEDIA_LAB_GATEWAY_IMAGE=${PRIMARY_IMAGE}
MEDIA_LAB_RUNNER_IMAGE=${runner_image}
MEDIA_LAB_RUNNER_SOURCE_SHA=${runner_source_sha}
MEDIA_LAB_GATEWAY_CPUS=4.0
MEDIA_LAB_GATEWAY_MEMORY_LIMIT=6g
MEDIA_LAB_GATEWAY_MEMORY_RESERVATION=1g
MEDIA_LAB_RUNNER_CPUS=2.0
MEDIA_LAB_RUNNER_MEMORY_LIMIT=3g
MEDIA_LAB_RUNNER_MEMORY_RESERVATION=512m
MEDIA_LAB_GATEWAY_OUTPUT_DIR=/srv/norva-media-lab/output
MEDIA_LAB_GATEWAY_CACHE_DIR=/srv/norva-media-lab/cache
MEDIA_LAB_RUNNER_TOKEN=${runner_token}
MEDIA_LAB_GATEWAY_TOKEN=${gateway_token}
MEDIA_LAB_FAST_START_HMAC_KEY=${fast_start_key}
MEDIA_LAB_CACHE_HMAC_KEY=${cache_key}
MEDIA_LAB_CACHE_TTL_MS=86400000
MEDIA_LAB_CACHE_MAX_BYTES=8589934592
MEDIA_LAB_CACHE_MIN_FREE_BYTES=171798691840
MEDIA_LAB_CACHE_MAX_ENTRY_BYTES=2147483648
MEDIA_LAB_CACHE_MAX_FILES=4000
MEDIA_LAB_CACHE_MAX_PLAYLIST_BYTES=1048576
MEDIA_LAB_CACHE_PRUNE_INTERVAL_MS=300000
MEDIA_LAB_RUN_TIMEOUT_MS=600000
MEDIA_LAB_GATEWAY_SESSION_TIMEOUT_MS=180000
MEDIA_LAB_BROWSER_TIMEOUT_MS=60000
EOF
  unset runner_token gateway_token fast_start_key cache_key
fi
chmod 0600 "${ENV_FILE}"
[[ "$(stat -c '%a' "${ENV_FILE}")" == '600' ]] || die 'env-mode'
grep -qx "MEDIA_LAB_UID=${runtime_uid}" "${ENV_FILE}" || die 'env-uid'
grep -qx "MEDIA_LAB_GID=${runtime_gid}" "${ENV_FILE}" || die 'env-gid'
grep -qx "RENDER_GID=${render_gid}" "${ENV_FILE}" || die 'env-render-gid'
grep -qx "MEDIA_LAB_GATEWAY_IMAGE=${PRIMARY_IMAGE}" "${ENV_FILE}" || die 'env-gateway-image'
grep -qx "MEDIA_LAB_RUNNER_IMAGE=${runner_image}" "${ENV_FILE}" || die 'env-runner-image'
grep -qx "MEDIA_LAB_RUNNER_SOURCE_SHA=${runner_source_sha}" "${ENV_FILE}" || die 'env-runner-source'
for secret_name in MEDIA_LAB_RUNNER_TOKEN MEDIA_LAB_GATEWAY_TOKEN MEDIA_LAB_FAST_START_HMAC_KEY MEDIA_LAB_CACHE_HMAC_KEY; do
  secret_value="$(sed -n "s/^${secret_name}=//p" "${ENV_FILE}")"
  [[ "${secret_value}" =~ ^[0-9a-f]{64}$ ]] || die "env-${secret_name,,}"
done
unset secret_value

CURRENT_GATE='compose-config'
docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" config -q

CURRENT_GATE='runner-image-build'
docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" build --pull=false runner
[[ "$(docker image inspect "${runner_image}" --format '{{index .Config.Labels "norva.media-lab-runner.source-sha256"}}')" == "${runner_source_sha}" ]] \
  || die 'runner-image-label'
docker run --rm --network none --entrypoint node "${runner_image}" --check /app/src/server.js
docker run --rm --network none --entrypoint node "${runner_image}" --check /app/scripts/run-private-case.js
docker run --rm --network none --entrypoint chromium "${runner_image}" --version >/dev/null

CURRENT_GATE='isolated-start'
STARTED_THIS_RUN='true'
docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" up -d --wait --wait-timeout 180 gateway runner

CURRENT_GATE='isolated-container-state'
for container in "${LAB_GATEWAY_CONTAINER}" "${LAB_RUNNER_CONTAINER}"; do
  [[ "$(docker inspect "${container}" --format '{{.State.Status}}')" == 'running' ]] || die "${container}-status"
  [[ "$(docker inspect "${container}" --format '{{.State.Health.Status}}')" == 'healthy' ]] || die "${container}-health"
  [[ "$(docker inspect "${container}" --format '{{.RestartCount}}')" == '0' ]] || die "${container}-restarts"
  [[ "$(docker inspect "${container}" --format '{{.State.OOMKilled}}')" == 'false' ]] || die "${container}-oom"
  port_bindings="$(docker inspect "${container}" --format '{{json .HostConfig.PortBindings}}')"
  [[ "${port_bindings}" == 'null' || "${port_bindings}" == '{}' ]] || die "${container}-public-port"
done
[[ "$(docker inspect "${LAB_RUNNER_CONTAINER}" --format '{{.Config.Image}}')" == "${runner_image}" ]] || die 'runner-container-image'
[[ "$(docker inspect "${LAB_GATEWAY_CONTAINER}" --format '{{.Config.Image}}')" == "${PRIMARY_IMAGE}" ]] || die 'lab-gateway-container-image'

CURRENT_GATE='isolated-health'
docker exec "${LAB_RUNNER_CONTAINER}" node -e \
  "fetch('http://127.0.0.1:8093/health',{headers:{Authorization:'Bearer '+process.env.MEDIA_LAB_RUNNER_TOKEN}}).then(async r=>{const h=await r.json();if(!r.ok||h.ok!==true||h.protocol!==1||h.busy!==false||h.physicalAdapterReady!==true)process.exit(1);process.stdout.write(JSON.stringify(h))}).catch(()=>process.exit(1))"
printf '\n'
docker exec "${LAB_GATEWAY_CONTAINER}" node -e \
  "fetch('http://127.0.0.1:8080/health').then(async r=>{const h=await r.json();if(!r.ok||h.ok!==true||h.version!==105||h.activeSessions!==0||h.videoEncoder?.backend!=='vaapi'||h.videoEncoder?.ready!==true||h.videoEncoderCapacity?.active!==0||h.videoEncoderCapacity?.maxActive!==1||h.mkvCompleteHlsCache?.enabled!==true)process.exit(1);process.stdout.write(JSON.stringify({version:h.version,activeSessions:h.activeSessions,encoder:h.videoEncoder.backend,maxActive:h.videoEncoderCapacity.maxActive,cache:h.mkvCompleteHlsCache.enabled}))}).catch(()=>process.exit(1))"
printf '\n'

CURRENT_GATE='final-primary-invariant'
[[ "$(docker inspect "${PRIMARY_CONTAINER}" --format '{{.Config.Image}}')" == "${PRIMARY_IMAGE}" ]] || die 'primary-drift-image'
[[ "$(docker inspect "${PRIMARY_CONTAINER}" --format '{{.State.Health.Status}}')" == 'healthy' ]] || die 'primary-drift-health'

STARTED_THIS_RUN='false'
printf '===PRIVATE_MEDIA_LAB_PREPARE_OK===\n'
printf 'runner_image=%s source_sha=%s gateway_image=%s edge_enabled=false network=%s\n' \
  "${runner_image}" "${runner_source_sha}" "${PRIMARY_IMAGE}" "${LAB_NETWORK}"
