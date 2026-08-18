#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly DEPLOY_ROOT='/home/adrien/norva-media-deployments/3d9cbd892800'
readonly SCRIPT_DIR="${DEPLOY_ROOT}/ops/hetzner/media"
readonly ENV_PATH="${SCRIPT_DIR}/.env.media-vaapi"
readonly IMAGE='norva-media-gateway:vaapi-3d9cbd892800'
readonly IMAGE_ID='sha256:1997592fd597b1f51735a2bcece179a0c3ab4b55502440b4c86ec19dfc2f0ad6'
readonly IMAGE_BUNDLE_SHA256='3d9cbd892800cf4630fac059e6cbe618e6e3b0b8a83196003e32934b018b0185'
readonly ACTIVE_IMAGE='norva-media-gateway:vaapi-53705bd7e404'
readonly ACTIVE_IMAGE_ID='sha256:7d4cd36a567785471be857d4b4464755a36b734dab430eb8f6675b51cd8bf3af'
readonly PROVIDER_CONTAINER='norva-media-v105-provider'
readonly GATEWAY_CONTAINER='norva-media-v105-canary'
readonly NETWORK='norva_default'

fail() {
  echo "VAAPI_V105_POLICY_CANARY_FAIL:$1" >&2
  exit 1
}

[[ -f "${ENV_PATH}" && "$(stat -c '%a' "${ENV_PATH}")" == '600' ]] || fail 'env'
[[ -f "${SCRIPT_DIR}/private-vaapi-smoke-provider.mjs" ]] || fail 'provider-script'
[[ -f "${SCRIPT_DIR}/private-vaapi-smoke-client.mjs" ]] || fail 'client-script'
[[ "$(docker image inspect "${IMAGE}" --format '{{.Id}}')" == "${IMAGE_ID}" ]] || fail 'candidate-image-drift'
[[ "$(docker image inspect "${IMAGE}" --format '{{index .Config.Labels "norva.bundle.sha256"}}')" == "${IMAGE_BUNDLE_SHA256}" ]] \
  || fail 'candidate-bundle-drift'
[[ "$(docker inspect norva-media-gateway --format '{{.Config.Image}}')" == "${ACTIVE_IMAGE}" ]] \
  || fail 'active-image-drift'
[[ "$(docker image inspect "${ACTIVE_IMAGE}" --format '{{.Id}}')" == "${ACTIVE_IMAGE_ID}" ]] \
  || fail 'active-image-id-drift'
[[ "$(docker inspect norva-media-gateway --format '{{.State.Health.Status}}')" == 'healthy' ]] \
  || fail 'active-gateway-unhealthy'
[[ "$(docker inspect norva-media-gateway --format '{{.RestartCount}}')" == '0' ]] \
  || fail 'active-gateway-restarted'
[[ "$(docker inspect norva-media-gateway --format '{{.State.OOMKilled}}')" == 'false' ]] \
  || fail 'active-gateway-oom'
docker network inspect "${NETWORK}" >/dev/null || fail 'network'

CANARY_DIR="$(mktemp -d /home/adrien/norva-media-v105-canary.XXXXXX)"
install -d -m 0700 "${CANARY_DIR}/fixture" "${CANARY_DIR}/output" "${CANARY_DIR}/cache"
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
    /home/adrien/norva-media-v105-canary.*) rm -rf -- "${CANARY_DIR}" ;;
    *) echo 'VAAPI_V105_POLICY_CANARY_WARN:temp-path-not-removed' >&2 ;;
  esac
}
trap cleanup EXIT INT TERM

for name in "${PROVIDER_CONTAINER}" "${GATEWAY_CONTAINER}"; do
  if docker container inspect "${name}" >/dev/null 2>&1; then
    fail "protected-container:${name}"
  fi
done

echo '===GENERATE_V105_HEVC_EAC3_FIXTURE==='
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

echo '===START_V105_PRIVATE_PROVIDER==='
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
docker exec "${PROVIDER_CONTAINER}" node -e \
  "fetch('http://127.0.0.1:8090/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

echo '===START_EPHEMERAL_V105_GATEWAY==='
docker run -d \
  --name "${GATEWAY_CONTAINER}" \
  --network "${NETWORK}" \
  --init \
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
  --env-file "${ENV_PATH}" \
  -e PORT=8080 \
  -e OUTPUT_DIR=/canary-output \
  -e PUBLIC_BASE_URL="http://${GATEWAY_CONTAINER}:8080" \
  -e NORVA_EDGE_CALLBACK_BASE=http://127.0.0.1:9 \
  -e ACCOUNT_ACTIVITY_REPORT_MS=0 \
  -e MEDIA_GATEWAY_VIDEO_ENCODER=vaapi \
  -e MEDIA_GATEWAY_VAAPI_DEVICE=/dev/dri/renderD128 \
  -e MAX_ACTIVE_VIDEO_ENCODER_SESSIONS=2 \
  -e MKV_COMPLETE_HLS_CACHE_ENABLED=false \
  -e MKV_CACHE_SINGLE_INSTANCE_ATTESTED=false \
  --entrypoint node \
  "${IMAGE_ID}" /app/src/index.js >/dev/null
GATEWAY_STARTED=1

for unused in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if docker exec "${GATEWAY_CONTAINER}" node -e \
    "fetch('http://127.0.0.1:8080/health').then(r=>r.json()).then(h=>{if(!h.ok||h.version!==105||h.videoEncoder?.backend!=='vaapi'||!h.videoEncoder?.ready||!h.vaapiVodFastStart?.enabled||h.vaapiVodFastStart?.targetBufferSeconds!==6||h.vaapiVodFastStart?.minimumEncodeRateX!==2||h.mkvCompleteHlsCache?.enabled===true)process.exit(1)}).catch(()=>process.exit(1))"; then
    break
  fi
  sleep 1
done
docker exec "${GATEWAY_CONTAINER}" node -e \
  "fetch('http://127.0.0.1:8080/health').then(r=>r.json()).then(h=>{if(!h.ok||h.version!==105||h.videoEncoder?.backend!=='vaapi'||!h.videoEncoder?.ready||!h.vaapiVodFastStart?.enabled||h.vaapiVodFastStart?.targetBufferSeconds!==6||h.vaapiVodFastStart?.minimumEncodeRateX!==2||h.mkvCompleteHlsCache?.enabled===true)process.exit(1)}).catch(()=>process.exit(1))"

echo '===RUN_V105_VAAPI_POLICY_SMOKE==='
docker exec \
  -e NORVA_CANARY_GATEWAY_ORIGIN=http://127.0.0.1:8080 \
  -e NORVA_CANARY_PROVIDER_ORIGIN="http://${PROVIDER_CONTAINER}:8090" \
  -e NORVA_CANARY_PLAYBACK_SESSION_ID=norva-private-vaapi-v105-policy-canary \
  -i "${GATEWAY_CONTAINER}" node --input-type=module - \
  < "${SCRIPT_DIR}/private-vaapi-smoke-client.mjs"

echo '===V105_POLICY_POST_STATE==='
docker inspect norva-media-gateway --format \
  'primary_image={{.Config.Image}} primary_status={{.State.Status}} primary_health={{.State.Health.Status}} primary_restarts={{.RestartCount}} primary_oom={{.State.OOMKilled}}'
docker stats --no-stream --format \
  'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.PIDs}}' \
  norva-media-gateway norva-db "${GATEWAY_CONTAINER}"
echo '===PRIVATE_VAAPI_V105_POLICY_SMOKE_OK==='
echo "candidate_image=${IMAGE} candidate_id=${IMAGE_ID} bundle=${IMAGE_BUNDLE_SHA256}"
