#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly DEPLOY_ROOT='/home/adrien/norva-media-deployments/27a72a5fbf51'
readonly SCRIPT_DIR="${DEPLOY_ROOT}/ops/hetzner/media"
readonly ENV_PATH="${SCRIPT_DIR}/.env.media-vaapi"
readonly IMAGE='norva-media-gateway:vaapi-05140081c99c'
readonly IMAGE_ID='sha256:187ece84d3a5fa78e1d82e82db8d0b3a218b8cd847f2b6936f76b000eb127ceb'
readonly IMAGE_BUNDLE_SHA256='05140081c99c4f1a3e8bd8ea62f69668498ca0c4cb55b3b37d78cfacf1fbc669'
readonly PROVIDER_CONTAINER='norva-media-canary-provider'
readonly GATEWAY_CONTAINER='norva-media-fastpath-canary'
readonly NETWORK='norva_default'

[[ -f "${ENV_PATH}" ]] || { echo 'FASTPATH_CANARY_FAIL env-missing' >&2; exit 1; }
[[ "$(stat -c '%a' "${ENV_PATH}")" == '600' ]] || { echo 'FASTPATH_CANARY_FAIL env-mode' >&2; exit 1; }
[[ "$(docker image inspect "${IMAGE}" --format '{{.Id}}')" == "${IMAGE_ID}" ]] || {
  echo 'FASTPATH_CANARY_FAIL image-drift' >&2
  exit 1
}
[[ "$(docker image inspect "${IMAGE}" --format '{{index .Config.Labels "norva.bundle.sha256"}}')" == "${IMAGE_BUNDLE_SHA256}" ]] || {
  echo 'FASTPATH_CANARY_FAIL image-bundle-drift' >&2
  exit 1
}
docker inspect norva-media-gateway --format '{{.State.Health.Status}}' | grep -qx 'healthy'

CANARY_DIR="$(mktemp -d /home/adrien/norva-h264-fastpath-canary.XXXXXX)"
install -d -m 0700 "${CANARY_DIR}/fixtures" "${CANARY_DIR}/output"
PROVIDER_STARTED=0
GATEWAY_STARTED=0
cleanup() {
  if [[ "${PROVIDER_STARTED}" == '1' ]]; then
    docker stop --time 5 "${PROVIDER_CONTAINER}" >/dev/null 2>&1 || true
    docker rm -f "${PROVIDER_CONTAINER}" >/dev/null 2>&1 || true
  fi
  if [[ "${GATEWAY_STARTED}" == '1' ]]; then
    docker stop --time 10 "${GATEWAY_CONTAINER}" >/dev/null 2>&1 || true
    docker rm -f "${GATEWAY_CONTAINER}" >/dev/null 2>&1 || true
  fi
  case "${CANARY_DIR}" in
    /home/adrien/norva-h264-fastpath-canary.*) rm -rf -- "${CANARY_DIR}" ;;
    *) echo 'FASTPATH_CANARY_WARN temp-path-not-removed' >&2 ;;
  esac
}
trap cleanup EXIT INT TERM

remove_stale_stopped_canary() {
  local name="$1"
  if ! docker container inspect "${name}" >/dev/null 2>&1; then
    return 0
  fi
  local image status
  image="$(docker inspect "${name}" --format '{{.Config.Image}}')"
  status="$(docker inspect "${name}" --format '{{.State.Status}}')"
  if [[ "${image}" != "${IMAGE}" || "${status}" == 'running' ]]; then
    echo "FASTPATH_CANARY_FAIL protected-existing-container:${name}:${status}" >&2
    return 1
  fi
  docker rm -f "${name}" >/dev/null
  ! docker container inspect "${name}" >/dev/null 2>&1
}

remove_stale_stopped_canary "${PROVIDER_CONTAINER}"
remove_stale_stopped_canary "${GATEWAY_CONTAINER}"

generate_fixture() {
  local audio_codec="$1"
  local output_name="$2"
  local audio_args=()
  if [[ "${audio_codec}" == 'aac' ]]; then
    audio_args=(-c:a aac -profile:a aac_low -ar 48000 -ac 2 -b:a 160k)
  elif [[ "${audio_codec}" == 'eac3' ]]; then
    audio_args=(-c:a eac3 -ar 48000 -ac 2 -b:a 384k)
  else
    echo 'FASTPATH_CANARY_FAIL fixture-audio-invalid' >&2
    return 1
  fi
  docker run --rm \
    --network none \
    --user 1000:1000 \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --pids-limit 128 \
    --cpus 2 \
    --memory 1g \
    -v "${CANARY_DIR}/fixtures:/canary" \
    --entrypoint ffmpeg \
    "${IMAGE}" \
    -hide_banner -v warning -stats -nostdin -y \
    -f lavfi -i testsrc2=size=1280x720:rate=30 \
    -f lavfi -i sine=frequency=1000:sample_rate=48000 \
    -t 14 \
    -map 0:0 -map 1:0 \
    -vf format=yuv420p \
    -c:v libx264 -preset veryfast -profile:v high -level:v 4.0 -pix_fmt yuv420p \
    -g 60 -keyint_min 60 -sc_threshold 0 -bf 0 \
    -x264-params 'open-gop=0:keyint=60:min-keyint=60:scenecut=0:bframes=0' \
    "${audio_args[@]}" \
    -f matroska "/canary/${output_name}"
  test -s "${CANARY_DIR}/fixtures/${output_name}"
}

start_provider() {
  local fixture_name="$1"
  local fixture_route="$2"
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
    -e "NORVA_CANARY_FIXTURE_PATH=/canary/${fixture_name}" \
    -e "NORVA_CANARY_FIXTURE_ROUTE=${fixture_route}" \
    -v "${CANARY_DIR}/fixtures:/canary:ro" \
    -v "${SCRIPT_DIR}/private-vaapi-smoke-provider.mjs:/opt/private-vaapi-smoke-provider.mjs:ro" \
    --entrypoint node \
    "${IMAGE}" \
    /opt/private-vaapi-smoke-provider.mjs >/dev/null
  PROVIDER_STARTED=1
  for unused in 1 2 3 4 5 6 7 8 9 10; do
    if docker exec "${PROVIDER_CONTAINER}" node -e \
      "fetch('http://127.0.0.1:8090/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

stop_provider() {
  docker stop --time 5 "${PROVIDER_CONTAINER}" >/dev/null
  docker rm -f "${PROVIDER_CONTAINER}" >/dev/null
  if docker container inspect "${PROVIDER_CONTAINER}" >/dev/null 2>&1; then
    echo 'FASTPATH_CANARY_FAIL provider-removal-incomplete' >&2
    return 1
  fi
  PROVIDER_STARTED=0
}

print_analyzer_diagnostics() {
  local fixture_name="$1"
  echo '===FASTPATH_ANALYZER_DIAGNOSTIC_FORMAT===' >&2
  docker exec "${PROVIDER_CONTAINER}" ffprobe \
    -v error -select_streams V:0 -show_format \
    -show_entries format=duration,size,start_time -of compact=p=1:nk=0 \
    "/canary/${fixture_name}" >&2 || true
  echo '===FASTPATH_ANALYZER_DIAGNOSTIC_STREAM===' >&2
  docker exec "${PROVIDER_CONTAINER}" ffprobe \
    -v error -select_streams V:0 -show_streams \
    -show_entries stream=index,time_base,profile,level,refs,r_frame_rate,avg_frame_rate,pix_fmt,width,height \
    -of compact=p=1:nk=0 "/canary/${fixture_name}" >&2 || true
  echo '===FASTPATH_ANALYZER_DIAGNOSTIC_KEY_PACKETS===' >&2
  docker exec "${PROVIDER_CONTAINER}" ffprobe \
    -v error -select_streams V:0 -show_packets \
    -show_entries packet=stream_index,pts,dts,duration,flags \
    -of compact=p=1:nk=0 "/canary/${fixture_name}" \
    | grep -E 'flags=[A-Z_]*K' | head -16 >&2 || true
  echo '===FASTPATH_ANALYZER_DIAGNOSTIC_IDR_PACKETS===' >&2
  docker exec "${PROVIDER_CONTAINER}" ffmpeg \
    -v error -nostdin -copyts -copytb 1 -avoid_negative_ts disabled \
    -i "/canary/${fixture_name}" -map 0:V:0 -c:v copy \
    -bsf:v h264_mp4toannexb,filter_units=pass_types=5 \
    -f framecrc pipe:1 \
    | grep -E '^(#tb|0,)' | head -20 >&2 || true
  echo '===FASTPATH_ANALYZER_DIAGNOSTIC_GATEWAY_LOGS===' >&2
  docker logs --tail 120 "${GATEWAY_CONTAINER}" >&2 2>&1 || true
}

echo '===GENERATE_H264_CLOSED_GOP_FIXTURES==='
generate_fixture aac fixture-h264-aac.mkv
generate_fixture eac3 fixture-h264-eac3.mkv

echo '===START_EPHEMERAL_CACHELESS_GATEWAY==='
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
  --env-file "${ENV_PATH}" \
  -e PORT=8080 \
  -e OUTPUT_DIR=/canary-output \
  -e PUBLIC_BASE_URL=http://norva-media-fastpath-canary:8080 \
  -e ACCOUNT_ACTIVITY_REPORT_MS=0 \
  -e MEDIA_GATEWAY_VIDEO_ENCODER=vaapi \
  -e MEDIA_GATEWAY_VAAPI_DEVICE=/dev/dri/renderD128 \
  -e MAX_ACTIVE_VIDEO_ENCODER_SESSIONS=2 \
  -e MKV_COMPLETE_HLS_CACHE_ENABLED=false \
  --entrypoint node \
  "${IMAGE}" /app/src/index.js >/dev/null
GATEWAY_STARTED=1
for unused in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if docker exec "${GATEWAY_CONTAINER}" node -e \
    "fetch('http://127.0.0.1:8080/health').then(r=>r.json()).then(h=>{if(!h.ok||!h.videoEncoder?.ready||h.mkvCompleteHlsCache?.enabled)process.exit(1)}).catch(()=>process.exit(1))"; then
    break
  fi
  sleep 1
done
docker exec "${GATEWAY_CONTAINER}" node -e \
  "fetch('http://127.0.0.1:8080/health').then(r=>r.json()).then(h=>{if(!h.ok||!h.videoEncoder?.ready||h.mkvCompleteHlsCache?.enabled)process.exit(1)}).catch(()=>process.exit(1))"

echo '===H264_AAC_COPY_REPLAY==='
start_provider fixture-h264-aac.mkv /fixture-h264-aac.mkv
if ! docker exec -e NORVA_CANARY_CASE=aac -i "${GATEWAY_CONTAINER}" node --input-type=module - \
  < "${SCRIPT_DIR}/private-h264-fastpath-smoke-client.mjs"; then
  print_analyzer_diagnostics fixture-h264-aac.mkv
  exit 1
fi
stop_provider

echo '===H264_EAC3_AUDIO_ONLY_TRANSCODE_REPLAY==='
start_provider fixture-h264-eac3.mkv /fixture-h264-eac3.mkv
if ! docker exec -e NORVA_CANARY_CASE=eac3 -i "${GATEWAY_CONTAINER}" node --input-type=module - \
  < "${SCRIPT_DIR}/private-h264-fastpath-smoke-client.mjs"; then
  print_analyzer_diagnostics fixture-h264-eac3.mkv
  exit 1
fi
stop_provider

echo '===FASTPATH_POST_STATE==='
docker inspect norva-media-gateway --format \
  'primary_status={{.State.Status}} primary_health={{.State.Health.Status}} primary_restarts={{.RestartCount}} primary_oom={{.State.OOMKilled}}'
docker stats --no-stream --format \
  'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.PIDs}}' \
  norva-media-gateway norva-db "${GATEWAY_CONTAINER}"
du -sh /srv/norva-media/output /srv/norva-media/cache
echo '===PRIVATE_H264_FASTPATH_SMOKE_COMPLETE==='
