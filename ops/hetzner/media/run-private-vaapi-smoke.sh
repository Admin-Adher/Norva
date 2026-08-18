#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly DEPLOY_ROOT='/home/adrien/norva-media-deployments/27a72a5fbf51'
readonly SCRIPT_DIR="${DEPLOY_ROOT}/ops/hetzner/media"
readonly ENV_PATH="${SCRIPT_DIR}/.env.media-vaapi"
readonly IMAGE='norva-media-gateway:vaapi-27a72a5fbf51'
readonly IMAGE_ID='sha256:0a46547ba4d365f1132fc0471b4500cd428683624f0097497659c59ec0384ece'
readonly PROVIDER_CONTAINER='norva-media-canary-provider'
readonly NETWORK='norva_default'

[[ -f "${ENV_PATH}" ]] || { echo 'CANARY_FAIL env-missing' >&2; exit 1; }
[[ "$(stat -c '%a' "${ENV_PATH}")" == '600' ]] || { echo 'CANARY_FAIL env-mode' >&2; exit 1; }
[[ "$(docker image inspect "${IMAGE}" --format '{{.Id}}')" == "${IMAGE_ID}" ]] || {
  echo 'CANARY_FAIL image-drift' >&2
  exit 1
}
docker inspect norva-media-gateway --format '{{.State.Health.Status}}' | grep -qx 'healthy'
docker inspect norva-media-gateway --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -q '^NORVA_EDGE_CALLBACK_BASE=http://127.0.0.1:9$'
if docker container inspect "${PROVIDER_CONTAINER}" >/dev/null 2>&1; then
  echo 'CANARY_FAIL provider-container-already-exists' >&2
  exit 1
fi

CANARY_DIR="$(mktemp -d /home/adrien/norva-media-canary.XXXXXX)"
PROVIDER_STARTED=0
cleanup() {
  if [[ "${PROVIDER_STARTED}" == '1' ]]; then
    docker stop --time 5 "${PROVIDER_CONTAINER}" >/dev/null 2>&1 || true
  fi
  case "${CANARY_DIR}" in
    /home/adrien/norva-media-canary.*) rm -rf -- "${CANARY_DIR}" ;;
    *) echo 'CANARY_WARN temp-path-not-removed' >&2 ;;
  esac
}
trap cleanup EXIT INT TERM

echo '===GENERATE_PRIVATE_HEVC_EAC3_FIXTURE==='
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
  -v "${CANARY_DIR}:/canary" \
  --entrypoint ffmpeg \
  "${IMAGE}" \
  -hide_banner -v warning -stats -nostdin -y \
  -vaapi_device /dev/dri/renderD128 \
  -f lavfi -i testsrc2=size=1280x720:rate=30 \
  -f lavfi -i sine=frequency=1000:sample_rate=48000 \
  -t 14 \
  -map 0:0 -map 1:0 \
  -vf format=nv12,hwupload \
  -c:v hevc_vaapi -profile:v main -qp 25 -g 48 -bf 0 \
  -force_key_frames 'expr:gte(t,n_forced*2)' \
  -c:a eac3 -ar 48000 -ac 2 -b:a 384k \
  -f matroska /canary/fixture-hevc-eac3.mkv
test -s "${CANARY_DIR}/fixture-hevc-eac3.mkv"

echo '===START_PRIVATE_RANGE_PROVIDER==='
docker run -d --rm \
  --name "${PROVIDER_CONTAINER}" \
  --network "${NETWORK}" \
  --user 1000:1000 \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 64 \
  --cpus 0.5 \
  --memory 256m \
  -v "${CANARY_DIR}:/canary:ro" \
  -v "${SCRIPT_DIR}/private-vaapi-smoke-provider.mjs:/opt/private-vaapi-smoke-provider.mjs:ro" \
  --entrypoint node \
  "${IMAGE}" \
  /opt/private-vaapi-smoke-provider.mjs >/dev/null
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

echo '===RUN_REAL_GATEWAY_VAAPI_SMOKE==='
docker exec -i norva-media-gateway node --input-type=module - \
  < "${SCRIPT_DIR}/private-vaapi-smoke-client.mjs"

echo '===POST_SMOKE_STATE==='
docker inspect norva-media-gateway --format \
  'status={{.State.Status}} health={{.State.Health.Status}} restarts={{.RestartCount}} oom={{.State.OOMKilled}}'
docker stats --no-stream --format \
  'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.PIDs}}' \
  norva-media-gateway norva-db
du -sh /srv/norva-media/output /srv/norva-media/cache
echo '===PRIVATE_VAAPI_SMOKE_COMPLETE==='
