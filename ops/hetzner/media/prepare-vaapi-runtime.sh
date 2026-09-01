#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly EXPECTED_IMAGE='norva-media-gateway:vaapi-27a72a5fbf51'
readonly EXPECTED_IMAGE_ID='sha256:0a46547ba4d365f1132fc0471b4500cd428683624f0097497659c59ec0384ece'
readonly EXPECTED_BUNDLE_SHA256='27a72a5fbf51e43a34cf41a08383b912fceeb70fce07b11d40a24f7ea1ccdd56'
readonly EXPECTED_UID='1000'
readonly EXPECTED_GID='1000'
readonly EXPECTED_RENDER_GID='993'
readonly EXPECTED_NETWORK='norva_default'
readonly EXPECTED_PORT='8081'

die() {
  printf 'PREPARE_FAILED:%s\n' "$1" >&2
  exit 1
}

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly COMPOSE_PATH="${SCRIPT_DIR}/docker-compose.vaapi.yml"
readonly ENV_PATH="${SCRIPT_DIR}/.env.media-vaapi"

[[ -f "${COMPOSE_PATH}" ]] || die 'compose-missing'
[[ ! -e "${ENV_PATH}" ]] || die 'env-already-exists'
command -v docker >/dev/null 2>&1 || die 'docker-missing'
command -v openssl >/dev/null 2>&1 || die 'openssl-missing'
command -v ss >/dev/null 2>&1 || die 'ss-missing'
command -v getent >/dev/null 2>&1 || die 'getent-missing'
command -v sudo >/dev/null 2>&1 || die 'sudo-missing'
[[ "$(id -u)" == "${EXPECTED_UID}" ]] || die 'unexpected-uid'
[[ "$(id -g)" == "${EXPECTED_GID}" ]] || die 'unexpected-gid'
[[ "$(getent group render | cut -d: -f3)" == "${EXPECTED_RENDER_GID}" ]] || die 'unexpected-render-gid'
docker network inspect "${EXPECTED_NETWORK}" >/dev/null 2>&1 || die 'docker-network-missing'
if ss -ltnH "sport = :${EXPECTED_PORT}" | grep -q .; then
  die 'port-already-listening'
fi

readonly IMAGE_ID="$(docker image inspect "${EXPECTED_IMAGE}" --format '{{.Id}}')"
readonly BUNDLE_LABEL="$(docker image inspect "${EXPECTED_IMAGE}" --format '{{index .Config.Labels "norva.bundle.sha256"}}')"
[[ "${IMAGE_ID}" == "${EXPECTED_IMAGE_ID}" ]] || die 'image-id-mismatch'
[[ "${BUNDLE_LABEL}" == "${EXPECTED_BUNDLE_SHA256}" ]] || die 'bundle-label-mismatch'

readonly TOKEN_COUNT="$(docker exec norva-db psql -X -U postgres -d postgres -Atq \
  -c "SELECT count(*) FROM public.cloud_runtime_config WHERE key = 'NORVA_MEDIA_GATEWAY_TOKEN' AND length(value) > 0")"
[[ "${TOKEN_COUNT}" == '1' ]] || die 'gateway-token-cardinality'
readonly GATEWAY_TOKEN_VALUE="$(docker exec norva-db psql -X -U postgres -d postgres -Atq \
  -c "SELECT value FROM public.cloud_runtime_config WHERE key = 'NORVA_MEDIA_GATEWAY_TOKEN' AND length(value) > 0")"
[[ "${GATEWAY_TOKEN_VALUE}" =~ ^[A-Za-z0-9._~-]{32,256}$ ]] || die 'gateway-token-grammar'

readonly PROOF_HMAC_KEY="$(openssl rand -hex 32)"
readonly CACHE_HMAC_KEY="$(openssl rand -hex 32)"
[[ "${PROOF_HMAC_KEY}" =~ ^[a-f0-9]{64}$ ]] || die 'proof-key-generation'
[[ "${CACHE_HMAC_KEY}" =~ ^[a-f0-9]{64}$ ]] || die 'cache-key-generation'
[[ "${PROOF_HMAC_KEY}" != "${CACHE_HMAC_KEY}" ]] || die 'hmac-key-collision'

TEMP_ENV="$(mktemp "${SCRIPT_DIR}/.env.media-vaapi.tmp.XXXXXX")"
cleanup() {
  if [[ -n "${TEMP_ENV:-}" && -e "${TEMP_ENV}" ]]; then
    rm -f -- "${TEMP_ENV}"
  fi
}
trap cleanup EXIT

cat >"${TEMP_ENV}" <<EOF
MEDIA_GATEWAY_UID=${EXPECTED_UID}
MEDIA_GATEWAY_GID=${EXPECTED_GID}
RENDER_GID=${EXPECTED_RENDER_GID}
NORVA_DOCKER_NETWORK=${EXPECTED_NETWORK}
MEDIA_GATEWAY_HOST_PORT=${EXPECTED_PORT}
MEDIA_GATEWAY_IMAGE=${EXPECTED_IMAGE}
MEDIA_GATEWAY_CPUS=6.0
MEDIA_GATEWAY_MEMORY_LIMIT=10g
MEDIA_GATEWAY_MEMORY_RESERVATION=2g
MAX_ACTIVE_VIDEO_ENCODER_SESSIONS=4
MEDIA_GATEWAY_OUTPUT_DIR=/srv/norva-media/output
MEDIA_GATEWAY_CACHE_DIR=/srv/norva-media/cache
PUBLIC_BASE_URL=https://media.norva.tv
# Private canary: keep every Gateway callback off production until the explicit
# cutover step replaces this value after validation.
NORVA_EDGE_CALLBACK_BASE=http://127.0.0.1:9
NORVA_BACKEND_ORIGINS=https://api.norva.tv
GATEWAY_TOKEN=${GATEWAY_TOKEN_VALUE}
MKV_H264_FAST_START_PROOF_HMAC_KEY=${PROOF_HMAC_KEY}
MKV_H264_FAST_START_PROOF_HMAC_PREVIOUS_KEY=
MKV_COMPLETE_HLS_CACHE_MANIFEST_HMAC_KEY=${CACHE_HMAC_KEY}
PROVIDER_PROXY_URLS=
PROVIDER_PROXY_SOCKS_URLS=
PROVIDER_PROXY_SLOT_OVERRIDES=
MKV_COMPLETE_HLS_CACHE_TTL_MS=604800000
MKV_COMPLETE_HLS_CACHE_MAX_BYTES=103079215104
MKV_COMPLETE_HLS_CACHE_MIN_FREE_BYTES=171798691840
MKV_COMPLETE_HLS_CACHE_MAX_ENTRY_BYTES=25769803776
MKV_COMPLETE_HLS_CACHE_MAX_FILES=20000
MKV_COMPLETE_HLS_CACHE_MAX_PLAYLIST_BYTES=8388608
MKV_COMPLETE_HLS_CACHE_PRUNE_INTERVAL_MS=900000
EOF

chmod 0600 "${TEMP_ENV}"
docker compose --env-file "${TEMP_ENV}" -f "${COMPOSE_PATH}" config -q || die 'compose-config-invalid'
sudo install -d -m 0750 -o "${EXPECTED_UID}" -g "${EXPECTED_GID}" \
  /srv/norva-media /srv/norva-media/output /srv/norva-media/cache
mv -- "${TEMP_ENV}" "${ENV_PATH}"
TEMP_ENV=''
chmod 0600 "${ENV_PATH}"

printf 'PREPARE_OK\n'
printf 'IMAGE=%s\n' "${EXPECTED_IMAGE}"
printf 'IMAGE_ID=%s\n' "${IMAGE_ID}"
printf 'ENV_MODE=%s\n' "$(stat -c '%a' "${ENV_PATH}")"
printf 'OUTPUT_OWNER=%s\n' "$(stat -c '%u:%g:%a' /srv/norva-media/output)"
printf 'CACHE_OWNER=%s\n' "$(stat -c '%u:%g:%a' /srv/norva-media/cache)"
