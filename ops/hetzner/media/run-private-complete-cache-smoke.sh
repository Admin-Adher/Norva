#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly IMAGE="${1:-${NORVA_COMPLETE_CACHE_CANARY_IMAGE:-}}"
readonly IMAGE_BUNDLE_SHA256="${2:-${NORVA_COMPLETE_CACHE_CANARY_BUNDLE_SHA256:-}}"
readonly PRIMARY_CONTAINER="${NORVA_COMPLETE_CACHE_PRIMARY_CONTAINER:-norva-media-gateway}"
readonly PROVIDER_CONTAINER='norva-media-cache-canary-provider'
readonly GATEWAY_CONTAINER='norva-media-cache-canary'
readonly NETWORK='norva_default'

[[ "${IMAGE}" =~ ^norva-media-gateway:vaapi-[a-z0-9][a-z0-9._-]{5,95}$ ]] || {
  echo 'COMPLETE_CACHE_CANARY_FAIL image' >&2
  exit 1
}
[[ "${IMAGE_BUNDLE_SHA256}" =~ ^[0-9a-f]{64}$ ]] || {
  echo 'COMPLETE_CACHE_CANARY_FAIL bundle' >&2
  exit 1
}
for command_name in docker openssl; do
  command -v "${command_name}" >/dev/null 2>&1 || {
    echo "COMPLETE_CACHE_CANARY_FAIL missing-${command_name}" >&2
    exit 1
  }
done
IMAGE_ID="$(docker image inspect "${IMAGE}" --format '{{.Id}}')"
readonly IMAGE_ID
[[ "${IMAGE_ID}" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  echo 'COMPLETE_CACHE_CANARY_FAIL image-id' >&2
  exit 1
}
[[ "$(docker image inspect "${IMAGE}" --format '{{index .Config.Labels "norva.bundle.sha256"}}')" == "${IMAGE_BUNDLE_SHA256}" ]] || {
  echo 'COMPLETE_CACHE_CANARY_FAIL bundle-drift' >&2
  exit 1
}
[[ "$(docker inspect "${PRIMARY_CONTAINER}" --format '{{.State.Health.Status}}')" == 'healthy' ]]
PRIMARY_IMAGE="$(docker inspect "${PRIMARY_CONTAINER}" --format '{{.Config.Image}}')"
PRIMARY_IMAGE_ID="$(docker inspect "${PRIMARY_CONTAINER}" --format '{{.Image}}')"
PRIMARY_RESTARTS="$(docker inspect "${PRIMARY_CONTAINER}" --format '{{.RestartCount}}')"
PRIMARY_OOM="$(docker inspect "${PRIMARY_CONTAINER}" --format '{{.State.OOMKilled}}')"
readonly PRIMARY_IMAGE PRIMARY_IMAGE_ID PRIMARY_RESTARTS PRIMARY_OOM

CANARY_DIR="$(mktemp -d /home/adrien/norva-complete-cache-canary.XXXXXX)"
install -d -m 0700 "${CANARY_DIR}/fixture" "${CANARY_DIR}/output" "${CANARY_DIR}/cache"
CANARY_ENV="${CANARY_DIR}/canary.env"
readonly CANARY_ENV
{
  printf 'GATEWAY_TOKEN=%s\n' "$(openssl rand -hex 32)"
  printf 'MKV_H264_FAST_START_PROOF_HMAC_KEY=%s\n' "$(openssl rand -hex 32)"
  printf 'MKV_COMPLETE_HLS_CACHE_MANIFEST_HMAC_KEY=%s\n' "$(openssl rand -hex 32)"
} > "${CANARY_ENV}"
chmod 0600 "${CANARY_ENV}"
PROVIDER_STARTED=0
GATEWAY_STARTED=0

cleanup() {
  if [[ "${GATEWAY_STARTED}" == '1' ]]; then
    docker stop --time 10 "${GATEWAY_CONTAINER}" >/dev/null 2>&1 || true
    docker rm -f "${GATEWAY_CONTAINER}" >/dev/null 2>&1 || true
  fi
  if [[ "${PROVIDER_STARTED}" == '1' ]]; then
    docker stop --time 5 "${PROVIDER_CONTAINER}" >/dev/null 2>&1 || true
    docker rm -f "${PROVIDER_CONTAINER}" >/dev/null 2>&1 || true
  fi
  case "${CANARY_DIR}" in
    /home/adrien/norva-complete-cache-canary.*) rm -rf -- "${CANARY_DIR}" ;;
    *) echo 'COMPLETE_CACHE_CANARY_WARN temp-path-not-removed' >&2 ;;
  esac
}
trap cleanup EXIT INT TERM

for name in "${PROVIDER_CONTAINER}" "${GATEWAY_CONTAINER}"; do
  if docker container inspect "${name}" >/dev/null 2>&1; then
    image="$(docker inspect "${name}" --format '{{.Config.Image}}')"
    status="$(docker inspect "${name}" --format '{{.State.Status}}')"
    [[ "${image}" == "${IMAGE_ID}" && "${status}" != 'running' ]] || {
      echo "COMPLETE_CACHE_CANARY_FAIL protected-container:${name}:${status}" >&2
      exit 1
    }
    docker rm -f "${name}" >/dev/null
  fi
done

echo '===GENERATE_COMPLETE_CACHE_HEVC_FIXTURE==='
docker run --rm \
  --network none \
  --user 1000:1000 \
  --group-add 993 \
  --device /dev/dri/renderD128:/dev/dri/renderD128 \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 128 \
  --cpus 2 \
  --memory 1g \
  -v "${CANARY_DIR}/fixture:/canary" \
  --entrypoint ffmpeg \
  "${IMAGE_ID}" \
  -hide_banner -v warning -stats -nostdin -y \
  -vaapi_device /dev/dri/renderD128 \
  -f lavfi -i testsrc2=size=1280x720:rate=30 \
  -f lavfi -i sine=frequency=1000:sample_rate=48000 \
  -t 14 -map 0:0 -map 1:0 \
  -vf format=nv12,hwupload \
  -c:v hevc_vaapi -profile:v main -qp 25 -g 48 -bf 0 \
  -force_key_frames 'expr:gte(t,n_forced*2)' \
  -c:a eac3 -ar 48000 -ac 2 -b:a 384k \
  -f matroska /canary/fixture-hevc-eac3.mkv
test -s "${CANARY_DIR}/fixture/fixture-hevc-eac3.mkv"

echo '===START_COMPLETE_CACHE_PRIVATE_PROVIDER==='
docker run -d \
  --name "${PROVIDER_CONTAINER}" \
  --network "${NETWORK}" \
  --user 1000:1000 \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 64 \
  --cpus 0.5 \
  --memory 256m \
  -v "${CANARY_DIR}/fixture:/canary:ro" \
  -v "${SCRIPT_DIR}/private-vaapi-smoke-provider.mjs:/opt/private-vaapi-smoke-provider.mjs:ro" \
  --entrypoint node \
  "${IMAGE_ID}" /opt/private-vaapi-smoke-provider.mjs >/dev/null
PROVIDER_STARTED=1

for unused in 1 2 3 4 5 6 7 8 9 10; do
  if docker exec "${PROVIDER_CONTAINER}" node -e \
    "fetch('http://127.0.0.1:8090/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"; then
    break
  fi
  sleep 1
done

echo '===START_EPHEMERAL_COMPLETE_CACHE_GATEWAY==='
docker run -d \
  --name "${GATEWAY_CONTAINER}" \
  --network "${NETWORK}" \
  --user 1000:1000 \
  --group-add 993 \
  --device /dev/dri/renderD128:/dev/dri/renderD128 \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 512 \
  --cpus 4 \
  --memory 6g \
  --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=268435456 \
  -v "${CANARY_DIR}/output:/canary-output" \
  -v "${CANARY_DIR}/cache:/canary-cache" \
  --env-file "${CANARY_ENV}" \
  -e PORT=8080 \
  -e OUTPUT_DIR=/canary-output \
  -e PUBLIC_BASE_URL=http://norva-media-cache-canary:8080 \
  -e ACCOUNT_ACTIVITY_REPORT_MS=0 \
  -e MEDIA_GATEWAY_VIDEO_ENCODER=vaapi \
  -e MEDIA_GATEWAY_VAAPI_DEVICE=/dev/dri/renderD128 \
  -e MAX_ACTIVE_VIDEO_ENCODER_SESSIONS=2 \
  -e MKV_COMPLETE_HLS_CACHE_ENABLED=true \
  -e MKV_CACHE_COORDINATION_MODE=local \
  -e MKV_CACHE_SINGLE_INSTANCE_ATTESTED=true \
  -e MKV_COMPLETE_HLS_CACHE_ROOT=/canary-cache \
  -e MKV_COMPLETE_HLS_CACHE_MAX_BYTES=2147483648 \
  -e MKV_COMPLETE_HLS_CACHE_MIN_FREE_BYTES=1073741824 \
  --entrypoint node \
  "${IMAGE_ID}" /app/src/index.js >/dev/null
GATEWAY_STARTED=1

for unused in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if docker exec "${GATEWAY_CONTAINER}" node -e \
    "fetch('http://127.0.0.1:8080/health').then(r=>r.json()).then(h=>{if(!h.ok||!h.videoEncoder?.ready||!h.mkvCompleteHlsCache?.enabled)process.exit(1)}).catch(()=>process.exit(1))"; then
    break
  fi
  sleep 1
done
docker exec "${GATEWAY_CONTAINER}" node -e \
  "fetch('http://127.0.0.1:8080/health').then(r=>r.json()).then(h=>{if(!h.ok||!h.videoEncoder?.ready||!h.mkvCompleteHlsCache?.enabled)process.exit(1)}).catch(()=>process.exit(1))"

echo '===RUN_COLD_TO_ZERO_PROVIDER_CACHE_REPLAY==='
docker exec -i "${GATEWAY_CONTAINER}" node --input-type=module - \
  < "${SCRIPT_DIR}/private-complete-cache-smoke-client.mjs"

echo '===COMPLETE_CACHE_POST_STATE==='
docker inspect "${PRIMARY_CONTAINER}" --format \
  'primary_status={{.State.Status}} primary_health={{.State.Health.Status}} primary_restarts={{.RestartCount}} primary_oom={{.State.OOMKilled}}'
[[ "$(docker inspect "${PRIMARY_CONTAINER}" --format '{{.Config.Image}}')" == "${PRIMARY_IMAGE}" ]]
[[ "$(docker inspect "${PRIMARY_CONTAINER}" --format '{{.Image}}')" == "${PRIMARY_IMAGE_ID}" ]]
[[ "$(docker inspect "${PRIMARY_CONTAINER}" --format '{{.State.Health.Status}}')" == 'healthy' ]]
[[ "$(docker inspect "${PRIMARY_CONTAINER}" --format '{{.RestartCount}}')" == "${PRIMARY_RESTARTS}" ]]
[[ "$(docker inspect "${PRIMARY_CONTAINER}" --format '{{.State.OOMKilled}}')" == "${PRIMARY_OOM}" ]]
docker stats --no-stream --format \
  'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.PIDs}}' \
  "${PRIMARY_CONTAINER}" norva-db "${GATEWAY_CONTAINER}"
echo '===PRIVATE_COMPLETE_CACHE_SMOKE_OK==='
echo "candidate_image=${IMAGE} candidate_id=${IMAGE_ID} bundle=${IMAGE_BUNDLE_SHA256}"
