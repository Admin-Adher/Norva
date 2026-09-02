#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../../.." && pwd -P)"
readonly CLIENT_PATH="${SCRIPT_DIR}/private-subtitle-heavy-resume-smoke-client.mjs"
readonly PROVIDER_PATH="${SCRIPT_DIR}/private-vaapi-smoke-provider.mjs"
readonly SUBTITLE_PATH="${REPO_ROOT}/tests/fixtures/shared-cache-en.srt"
readonly GATEWAY_CONTAINER="${CANARY_GATEWAY_CONTAINER:?CANARY_GATEWAY_CONTAINER is required}"
readonly PROVIDER_CONTAINER='norva-media-subtitle-heavy-provider'
readonly NETWORK="${NORVA_CANARY_DOCKER_NETWORK:-norva_default}"

die() {
  printf 'SUBTITLE_HEAVY_RESUME_SMOKE_FAIL:%s\n' "$1" >&2
  exit 1
}

[[ "${GATEWAY_CONTAINER}" != 'norva-media-gateway' ]] || die 'production-gateway-refused'
[[ "${GATEWAY_CONTAINER}" =~ ^norva-media-gateway-[a-z0-9-]+-canary$ ]] || die 'canary-name-invalid'
[[ -f "${CLIENT_PATH}" ]] || die 'client-missing'
[[ -f "${PROVIDER_PATH}" ]] || die 'provider-missing'
[[ -f "${SUBTITLE_PATH}" ]] || die 'subtitle-fixture-missing'
docker inspect "${GATEWAY_CONTAINER}" >/dev/null 2>&1 || die 'gateway-missing'
[[ "$(docker inspect "${GATEWAY_CONTAINER}" --format '{{.State.Status}}')" == 'running' ]] \
  || die 'gateway-not-running'
if docker container inspect "${PROVIDER_CONTAINER}" >/dev/null 2>&1; then
  die 'provider-container-already-exists'
fi

readonly IMAGE="$(docker inspect "${GATEWAY_CONTAINER}" --format '{{.Config.Image}}')"
[[ -n "${IMAGE}" ]] || die 'gateway-image-missing'

CANARY_DIR="$(mktemp -d /home/adrien/norva-subtitle-heavy-resume.XXXXXX)"
PROVIDER_STARTED=0
cleanup() {
  if [[ "${PROVIDER_STARTED}" == '1' ]]; then
    docker stop --time 5 "${PROVIDER_CONTAINER}" >/dev/null 2>&1 || true
  fi
  case "${CANARY_DIR}" in
    /home/adrien/norva-subtitle-heavy-resume.*) rm -rf -- "${CANARY_DIR}" ;;
    *) printf 'SUBTITLE_HEAVY_RESUME_SMOKE_WARN:temp-path-not-removed\n' >&2 ;;
  esac
}
trap cleanup EXIT INT TERM

install -m 0600 "${SUBTITLE_PATH}" "${CANARY_DIR}/input.srt"

languages=(
  eng fra spa deu ita por ara hin ben urd tam tel mal mar guj pan
  tur rus ukr pol nld swe nor dan fin ces ron ell heb fas kor jpn
)
ffmpeg_args=(
  -hide_banner -v warning -stats -nostdin -y
  -vaapi_device /dev/dri/renderD128
  -f lavfi -i testsrc2=size=1280x720:rate=30
  -f lavfi -i sine=frequency=1000:sample_rate=48000
  -i /canary/input.srt
  -t 45
  -map 0:0 -map 1:0
)
for index in "${!languages[@]}"; do
  ffmpeg_args+=(
    -map 2:0
    -metadata:s:s:"${index}" language="${languages[${index}]}"
    -metadata:s:s:"${index}" title="Exact-${languages[${index}]}"
  )
done
ffmpeg_args+=(
  -vf format=nv12,hwupload
  -c:v h264_vaapi -profile:v high -qp 25 -g 48 -bf 0
  -force_key_frames 'expr:gte(t,n_forced*2)'
  -c:a eac3 -ar 48000 -ac 2 -b:a 384k
  -c:s srt
  -f matroska /canary/fixture-subtitle-heavy.mkv
)

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
  "${ffmpeg_args[@]}"
[[ -s "${CANARY_DIR}/fixture-subtitle-heavy.mkv" ]] || die 'fixture-empty'

subtitle_count="$(docker run --rm \
  --network none \
  --user 1000:1000 \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 64 \
  --cpus 0.5 \
  --memory 256m \
  -v "${CANARY_DIR}:/canary:ro" \
  --entrypoint ffprobe \
  "${IMAGE}" \
  -v error -select_streams s -show_entries stream=index -of csv=p=0 \
  /canary/fixture-subtitle-heavy.mkv | wc -l | tr -d '[:space:]')"
[[ "${subtitle_count}" == '32' ]] || die "fixture-subtitle-count-${subtitle_count}"

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
  -e NORVA_CANARY_FIXTURE_PATH=/canary/fixture-subtitle-heavy.mkv \
  -e NORVA_CANARY_FIXTURE_ROUTE=/fixture-subtitle-heavy.mkv \
  -v "${CANARY_DIR}:/canary:ro" \
  -v "${PROVIDER_PATH}:/opt/private-vaapi-smoke-provider.mjs:ro" \
  --entrypoint node \
  "${IMAGE}" \
  /opt/private-vaapi-smoke-provider.mjs >/dev/null
PROVIDER_STARTED=1

provider_ready=0
for _ in $(seq 1 20); do
  if docker exec "${PROVIDER_CONTAINER}" node -e \
    "fetch('http://127.0.0.1:8090/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"; then
    provider_ready=1
    break
  fi
  sleep 1
done
[[ "${provider_ready}" == '1' ]] || die 'provider-not-ready'

readonly LOG_SINCE="$(date --iso-8601=seconds)"
receipt="$(docker exec -i \
  -e NORVA_CANARY_PROVIDER_ORIGIN="http://${PROVIDER_CONTAINER}:8090" \
  "${GATEWAY_CONTAINER}" \
  node --input-type=module - < "${CLIENT_PATH}")" || die 'client-failed'

gateway_logs="$(docker logs --since "${LOG_SINCE}" "${GATEWAY_CONTAINER}" 2>&1)"
if grep -Eq 'There are 2 hardware devices|Impossible to convert between the formats|auto_scale_[0-9]+.*Failed' \
  <<<"${gateway_logs}"; then
  die 'vaapi-device-graph-regression'
fi
grep -q '^NORVA_SUBTITLE_HEAVY_RESUME_SMOKE_OK ' <<<"${receipt}" || die 'receipt-missing'

printf '%s\n' "${receipt}"
printf 'SUBTITLE_HEAVY_RESUME_SMOKE_COMPLETE\n'
