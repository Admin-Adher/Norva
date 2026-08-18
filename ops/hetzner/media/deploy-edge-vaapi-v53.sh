#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly SOURCE_ROOT='/home/adrien/norva-deployments/mkv-44d0f79'
readonly TARGET_ROOT='/home/adrien/norva-deployments/mkv-vaapi-v53-11a301100cd0'
readonly ARCHIVE='/home/adrien/norva-edge-vaapi-v53-20260817-220219.tar.gz'
readonly ARCHIVE_SHA256='11a301100cd02597d5c4f995184b875b1127baebba55e8422ae938cb56810e25'
readonly SOURCE_OPS="${SOURCE_ROOT}/ops/hetzner"
readonly TARGET_OPS="${TARGET_ROOT}/ops/hetzner"
readonly MEDIA_ROOT='/home/adrien/norva-media-deployments/53705bd7e404/ops/hetzner/media'
readonly DB_CONTAINER='norva-db'
readonly GATEWAY_CONTAINER='norva-media-gateway'
readonly GATEWAY_IMAGE='norva-media-gateway:vaapi-53705bd7e404'
readonly GATEWAY_IMAGE_ID='sha256:7d4cd36a567785471be857d4b4464755a36b734dab430eb8f6675b51cd8bf3af'
readonly FUNCTION_CONTAINERS=(norva-edge-functions norva-edge-functions-2)

DEPLOY_STARTED=0

die() {
  printf 'EDGE_V53_DEPLOY_FAILED:%s\n' "$1" >&2
  rollback 1
}

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

rollback() {
  local exit_code="${1:-$?}"
  [[ "${exit_code}" != '0' ]] || exit_code=1
  trap - ERR INT TERM
  if [[ "${DEPLOY_STARTED}" == '1' ]]; then
    echo '===EDGE_V53_ROLLBACK_START===' >&2
    set +e
    compose_from "${SOURCE_OPS}" up -d --no-deps --force-recreate functions
    compose_from "${SOURCE_OPS}" up -d --no-deps --force-recreate functions2
    rollback_ok=1
    for container in "${FUNCTION_CONTAINERS[@]}"; do
      [[ "$(container_working_dir "${container}" 2>/dev/null)" == "${SOURCE_OPS}" ]] || rollback_ok=0
      [[ "$(docker inspect "${container}" --format '{{.State.Health.Status}}' 2>/dev/null)" == 'healthy' ]] || rollback_ok=0
    done
    if [[ "${rollback_ok}" == '1' ]]; then
      echo '===EDGE_V53_ROLLBACK_OK===' >&2
    else
      echo '===EDGE_V53_ROLLBACK_INCOMPLETE===' >&2
    fi
  fi
  exit "${exit_code}"
}

trap rollback ERR INT TERM

[[ -f "${ARCHIVE}" ]] || die 'archive-missing'
echo "${ARCHIVE_SHA256}  ${ARCHIVE}" | sha256sum -c - >/dev/null || die 'archive-integrity'
[[ -d "${SOURCE_ROOT}/supabase/functions" ]] || die 'source-functions-missing'
SOURCE_ENV_REAL="$(readlink -f -- "${SOURCE_OPS}/.env")" || die 'source-env-resolve'
[[ -n "${SOURCE_ENV_REAL}" && -f "${SOURCE_ENV_REAL}" ]] || die 'source-env'
[[ "$(stat -c '%a' "${SOURCE_ENV_REAL}")" == '600' ]] || die 'source-env-mode'
[[ "$(stat -c '%U:%G' "${SOURCE_ENV_REAL}")" == 'adrien:adrien' ]] || die 'source-env-owner'
[[ -f "${SOURCE_OPS}/docker-compose.supabase.yml" ]] || die 'source-compose'
[[ ! -e "${TARGET_ROOT}" ]] || die 'target-already-exists'

for container in "${FUNCTION_CONTAINERS[@]}"; do
  [[ "$(container_working_dir "${container}")" == "${SOURCE_OPS}" ]] || die "source-runtime-drift-${container}"
  [[ "$(docker inspect "${container}" --format '{{.State.Health.Status}}')" == 'healthy' ]] || die "source-runtime-unhealthy-${container}"
done

[[ "$(docker inspect "${GATEWAY_CONTAINER}" --format '{{.Config.Image}}')" == "${GATEWAY_IMAGE}" ]] || die 'gateway-image-tag'
[[ "$(docker inspect "${GATEWAY_CONTAINER}" --format '{{.Image}}')" == "${GATEWAY_IMAGE_ID}" ]] || die 'gateway-image-id'
[[ "$(docker inspect "${GATEWAY_CONTAINER}" --format '{{.State.Health.Status}}')" == 'healthy' ]] || die 'gateway-health'
docker inspect "${GATEWAY_CONTAINER}" --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -qx 'NORVA_EDGE_CALLBACK_BASE=http://127.0.0.1:9' || die 'gateway-not-private'

active_routed_sessions="$(
  docker exec "${DB_CONTAINER}" psql -X -U postgres -d postgres -Atc \
    "select count(*) from public.cloud_gateway_sessions where gateway_id is not null and status in ('pending','starting','ready') and expires_at > now();"
)"
[[ "${active_routed_sessions}" == '0' ]] || die 'active-routed-session'
existing_canary_config="$(
  docker exec "${DB_CONTAINER}" psql -X -U postgres -d postgres -Atc \
    "select count(*) from public.cloud_runtime_config where key in ('NORVA_MEDIA_GATEWAY_CANARY_URL','NORVA_MEDIA_GATEWAY_CANARY_TOKEN','NORVA_MEDIA_GATEWAY_CANARY_ID','NORVA_MEDIA_GATEWAY_CANARY_USER_HASHES');"
)"
[[ "${existing_canary_config}" == '0' ]] || die 'canary-config-already-present'

install -d -m 0750 "${TARGET_ROOT}"
cp -a "${SOURCE_ROOT}/." "${TARGET_ROOT}/"
# The active revision intentionally links to the canonical deployment secret.
# Freeze a private regular-file copy in the immutable target revision instead
# of carrying that cross-revision symlink forward.
install -m 0600 "${SOURCE_ENV_REAL}" "${TARGET_OPS}/.env"
[[ ! -L "${TARGET_OPS}/.env" ]] || die 'target-env-link'
[[ "$(stat -c '%a' "${TARGET_OPS}/.env")" == '600' ]] || die 'target-env-mode'
[[ "$(stat -c '%U:%G' "${TARGET_OPS}/.env")" == 'adrien:adrien' ]] || die 'target-env-owner'
tar -xzf "${ARCHIVE}" -C "${TARGET_ROOT}"

printf '%s\n' \
  '9bcab057acd25a1cc748bc83853eee16dd70b0a06ef9857931378206110a8350  supabase/functions/norva-playback/index.ts' \
  'a80553e64b60c7b3eea5248679932ba7d6ee6a13144feb4ef93e2855cf894b1a  supabase/functions/_shared/media-gateway-canary-routing.mjs' \
  'a0967191a93343b94c609a47ff99fb34351adf8624f3568749db8be9da4326fc  supabase/functions/_shared/media-gateway-session-lifecycle.mjs' \
  '2c65ac2a921604136b5eb00b8dc6a18c8b38b5fd1de87426268c03e67b2975bf  ops/hetzner/scripts/04-deploy-edge-functions.sh' \
  'f871981b184dc89c1853e89e2d587bf7cfdbd335785f82bfddd0df6bed400ecf  supabase/migrations/20260817213000_media_gateway_canary_route.sql' \
  '3e55ea74add94d51e3408e23985b1b36f71c8b514e62baff25ad52ce3454e1c8  ops/hetzner/media/stage-edge-vaapi-canary.sh' \
  '24921cc2c334ce06d4ff3b6288e83019adc2a30bc6aa21f8d252a16a57664399  ops/hetzner/media/unstage-edge-vaapi-canary.sh' \
  | (cd "${TARGET_ROOT}" && sha256sum -c -) >/dev/null || die 'payload-integrity'

compose_from "${TARGET_OPS}" config --quiet || die 'target-compose-invalid'
DEPLOY_STARTED=1
bash "${TARGET_OPS}/scripts/04-deploy-edge-functions.sh"

for container in "${FUNCTION_CONTAINERS[@]}"; do
  [[ "$(container_working_dir "${container}")" == "${TARGET_OPS}" ]] || die "target-runtime-drift-${container}"
  [[ "$(docker inspect "${container}" --format '{{.State.Health.Status}}')" == 'healthy' ]] || die "target-runtime-unhealthy-${container}"
done

post_canary_config="$(
  docker exec "${DB_CONTAINER}" psql -X -U postgres -d postgres -Atc \
    "select count(*) from public.cloud_runtime_config where key in ('NORVA_MEDIA_GATEWAY_CANARY_URL','NORVA_MEDIA_GATEWAY_CANARY_TOKEN','NORVA_MEDIA_GATEWAY_CANARY_ID','NORVA_MEDIA_GATEWAY_CANARY_USER_HASHES');"
)"
[[ "${post_canary_config}" == '0' ]] || die 'route-mutated-during-code-deploy'

install -m 0640 "${TARGET_ROOT}/supabase/migrations/20260817213000_media_gateway_canary_route.sql" \
  "${MEDIA_ROOT}/20260817213000_media_gateway_canary_route.sql"
install -m 0700 "${TARGET_ROOT}/ops/hetzner/media/stage-edge-vaapi-canary.sh" \
  "${MEDIA_ROOT}/stage-edge-vaapi-canary.sh"
install -m 0700 "${TARGET_ROOT}/ops/hetzner/media/unstage-edge-vaapi-canary.sh" \
  "${MEDIA_ROOT}/unstage-edge-vaapi-canary.sh"

DEPLOY_STARTED=0
trap - ERR INT TERM

echo '===EDGE_V53_DEPLOYED_ROUTE_OFF_OK==='
echo 'replicas=2 version=53 canary_state=off selected_users=0 gateway_callback=private'
