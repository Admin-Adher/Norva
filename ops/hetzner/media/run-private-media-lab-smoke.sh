#!/usr/bin/env bash
set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly ENV_FILE="${SCRIPT_DIR}/.env.media-lab"
readonly COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.media-lab.yml"
readonly SOURCE_MARKER="${SCRIPT_DIR}/media-lab-runner-source.sha256"
readonly PRIMARY_CONTAINER='norva-media-gateway'
readonly PRIMARY_IMAGE='norva-media-gateway:vaapi-04505a4b21d0'
readonly LAB_GATEWAY_CONTAINER='norva-media-lab-gateway'
readonly LAB_RUNNER_CONTAINER='norva-media-lab-runner'

die() {
  printf 'PRIVATE_MEDIA_LAB_SMOKE_FAIL:%s\n' "$1" >&2
  exit 1
}

[[ -f "${ENV_FILE}" && -f "${COMPOSE_FILE}" && -f "${SOURCE_MARKER}" ]] || die 'deployment-files'
[[ "$(stat -c '%a' "${ENV_FILE}")" == '600' ]] || die 'env-mode'
runner_source_sha="$(tr -d '\r\n' < "${SOURCE_MARKER}")"
[[ "${runner_source_sha}" =~ ^[0-9a-f]{64}$ ]] || die 'runner-source-marker'
runner_image="norva-media-lab-runner:${runner_source_sha:0:12}"
requested_case="${1:-h264-closed-aac}"
if [[ "${requested_case}" != 'all' && ! "${requested_case}" =~ ^(h264-closed-aac|h264-closed-ac3|h264-open-gop|h264-multi-audio|hevc-eac3-cold|h264-level52|h264-bad-timestamps|h264-pgs|h264-no-etag|hevc-full-cache|provider-458)$ ]]; then
  die 'fixture-id'
fi

[[ "$(docker inspect "${PRIMARY_CONTAINER}" --format '{{.Config.Image}}')" == "${PRIMARY_IMAGE}" ]] || die 'primary-image'
[[ "$(docker inspect "${PRIMARY_CONTAINER}" --format '{{.State.Health.Status}}')" == 'healthy' ]] || die 'primary-health'
for container in "${LAB_GATEWAY_CONTAINER}" "${LAB_RUNNER_CONTAINER}"; do
  [[ "$(docker inspect "${container}" --format '{{.State.Health.Status}}')" == 'healthy' ]] || die "${container}-health"
  [[ "$(docker inspect "${container}" --format '{{.RestartCount}}')" == '0' ]] || die "${container}-restarts"
  [[ "$(docker inspect "${container}" --format '{{.State.OOMKilled}}')" == 'false' ]] || die "${container}-oom"
done
[[ "$(docker inspect "${LAB_RUNNER_CONTAINER}" --format '{{.Config.Image}}')" == "${runner_image}" ]] || die 'runner-image'
[[ "$(docker image inspect "${runner_image}" --format '{{index .Config.Labels "norva.media-lab-runner.source-sha256"}}')" == "${runner_source_sha}" ]] || die 'runner-image-label'

printf '===PRIVATE_MEDIA_LAB_%s_START===\n' "${requested_case^^}"
docker exec "${LAB_RUNNER_CONTAINER}" node /app/scripts/run-private-case.js "${requested_case}"

docker exec "${LAB_RUNNER_CONTAINER}" node -e \
  "fetch('http://127.0.0.1:8093/health',{headers:{Authorization:'Bearer '+process.env.MEDIA_LAB_RUNNER_TOKEN}}).then(async r=>{const h=await r.json();process.exit(r.ok&&h.ok===true&&h.busy===false?0:1)}).catch(()=>process.exit(1))"
docker exec "${LAB_GATEWAY_CONTAINER}" node -e \
  "fetch('http://127.0.0.1:8080/health').then(async r=>{const h=await r.json();const ok=r.ok&&h.ok===true&&h.activeSessions===0&&h.videoEncoderCapacity?.active===0&&h.vodInputPump?.active===0&&h.rawPumpCount===0&&h.viewerSessionStartupLockCount===0&&h.mkvCompleteHlsCache?.stats?.activeLeases===0;process.exit(ok?0:1)}).catch(()=>process.exit(1))"

for container in "${LAB_GATEWAY_CONTAINER}" "${LAB_RUNNER_CONTAINER}" "${PRIMARY_CONTAINER}"; do
  [[ "$(docker inspect "${container}" --format '{{.State.Health.Status}}')" == 'healthy' ]] || die "${container}-post-health"
  [[ "$(docker inspect "${container}" --format '{{.RestartCount}}')" == '0' ]] || die "${container}-post-restarts"
  [[ "$(docker inspect "${container}" --format '{{.State.OOMKilled}}')" == 'false' ]] || die "${container}-post-oom"
done

printf '===PRIVATE_MEDIA_LAB_POST_STATE===\n'
docker stats --no-stream --format 'name={{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}} pids={{.PIDs}}' \
  "${LAB_GATEWAY_CONTAINER}" "${LAB_RUNNER_CONTAINER}" "${PRIMARY_CONTAINER}" norva-db
du -sh /srv/norva-media-lab/output /srv/norva-media-lab/cache
printf '===PRIVATE_MEDIA_LAB_SMOKE_OK===\n'
printf 'fixture=%s runner_image=%s source_sha=%s edge_enabled=false\n' \
  "${requested_case}" "${runner_image}" "${runner_source_sha}"
