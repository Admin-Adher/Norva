#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly DEPLOY_ROOT='/home/adrien/norva-media-deployments/53705bd7e404'
readonly SCRIPT_DIR="${DEPLOY_ROOT}/ops/hetzner/media"
readonly COMPOSE_PATH="${SCRIPT_DIR}/docker-compose.vaapi.yml"
readonly ENV_PATH="${SCRIPT_DIR}/.env.media-vaapi"
readonly BACKUP_PATH="${SCRIPT_DIR}/.env.media-vaapi.rollback-05140081c99c"
readonly CONTAINER='norva-media-gateway'
readonly OLD_IMAGE='norva-media-gateway:vaapi-05140081c99c'
readonly OLD_IMAGE_ID='sha256:187ece84d3a5fa78e1d82e82db8d0b3a218b8cd847f2b6936f76b000eb127ceb'
readonly NEW_IMAGE='norva-media-gateway:vaapi-53705bd7e404'
readonly NEW_IMAGE_ID='sha256:7d4cd36a567785471be857d4b4464755a36b734dab430eb8f6675b51cd8bf3af'
readonly NEW_BUNDLE_SHA256='53705bd7e404f5a1805c4ff3ab75cd2ef81f3f38ac843d7135c4e2f3856d2c11'

PROMOTION_STARTED=0

die() {
  printf 'PRIVATE_PROMOTION_FAILED:%s\n' "$1" >&2
  rollback 1
}

assert_idle_health() {
  docker exec "${CONTAINER}" node -e '
    fetch("http://127.0.0.1:8080/health")
      .then(async (response) => {
        const health = await response.json();
        const idle = response.ok && health.ok === true
          && health.activeSessions === 0
          && health.videoEncoder?.backend === "vaapi"
          && health.videoEncoder?.ready === true
          && health.videoEncoderCapacity?.active === 0
          && health.videoEncoderCapacity?.maxActive === 4
          && health.vodInputPump?.active === 0
          && health.rawPumpCount === 0
          && health.viewerStartupReservations === 0
          && health.viewerSessionStartupAdmissions === 0
          && health.viewerSessionStartupLockCount === 0
          && health.viewerSessionStartupWaiters === 0
          && health.backgroundCpuProcessCount === 0
          && health.mkvH264FastStart?.copyActivationReady === true
          && health.mkvCompleteHlsCache?.enabled === true;
        if (!idle) process.exit(1);
        console.log(JSON.stringify({
          activeSessions: health.activeSessions,
          activeEncoders: health.videoEncoderCapacity.active,
          activePumps: health.vodInputPump.active,
          rawPumps: health.rawPumpCount,
          startupLocks: health.viewerSessionStartupLockCount,
          fastCopyReady: health.mkvH264FastStart.copyActivationReady,
          completeCacheEnabled: health.mkvCompleteHlsCache.enabled,
        }));
      })
      .catch(() => process.exit(1));
  '
}

rollback() {
  local exit_code="${1:-$?}"
  if [[ "${exit_code}" == '0' ]]; then
    exit_code=1
  fi
  trap - ERR INT TERM
  if [[ "${PROMOTION_STARTED}" == '1' ]]; then
    echo '===PRIVATE_PROMOTION_ROLLBACK_START===' >&2
    install -m 0600 "${BACKUP_PATH}" "${ENV_PATH}" || true
    docker compose --env-file "${ENV_PATH}" -f "${COMPOSE_PATH}" \
      up -d --no-build --pull never --wait --wait-timeout 180 gateway || true
    if [[ "$(docker inspect "${CONTAINER}" --format '{{.Image}}' 2>/dev/null || true)" == "${OLD_IMAGE_ID}" ]] \
      && [[ "$(docker inspect "${CONTAINER}" --format '{{.State.Health.Status}}' 2>/dev/null || true)" == 'healthy' ]]; then
      echo '===PRIVATE_PROMOTION_ROLLBACK_OK===' >&2
    else
      echo '===PRIVATE_PROMOTION_ROLLBACK_INCOMPLETE===' >&2
    fi
  fi
  exit "${exit_code}"
}

trap rollback ERR INT TERM

[[ -f "${COMPOSE_PATH}" ]] || die 'compose-missing'
[[ -f "${ENV_PATH}" ]] || die 'env-missing'
[[ "$(stat -c '%a' "${ENV_PATH}")" == '600' ]] || die 'env-mode'
[[ ! -e "${BACKUP_PATH}" ]] || die 'rollback-backup-already-exists'
grep -qx "MEDIA_GATEWAY_IMAGE=${OLD_IMAGE}" "${ENV_PATH}" || die 'unexpected-current-image-config'
grep -qx 'NORVA_EDGE_CALLBACK_BASE=http://127.0.0.1:9' "${ENV_PATH}" || die 'callback-not-private'
[[ "$(docker inspect "${CONTAINER}" --format '{{.Config.Image}}')" == "${OLD_IMAGE}" ]] || die 'current-image-tag-drift'
[[ "$(docker inspect "${CONTAINER}" --format '{{.Image}}')" == "${OLD_IMAGE_ID}" ]] || die 'current-image-id-drift'
[[ "$(docker inspect "${CONTAINER}" --format '{{.State.Health.Status}}')" == 'healthy' ]] || die 'current-container-unhealthy'
[[ "$(docker inspect "${CONTAINER}" --format '{{.RestartCount}}')" == '0' ]] || die 'current-container-restarted'
[[ "$(docker inspect "${CONTAINER}" --format '{{.State.OOMKilled}}')" == 'false' ]] || die 'current-container-oom'
assert_idle_health >/dev/null || die 'current-container-not-idle'

[[ "$(docker image inspect "${NEW_IMAGE}" --format '{{.Id}}')" == "${NEW_IMAGE_ID}" ]] || die 'candidate-image-id-drift'
[[ "$(docker image inspect "${NEW_IMAGE}" --format '{{index .Config.Labels "norva.bundle.sha256"}}')" == "${NEW_BUNDLE_SHA256}" ]] \
  || die 'candidate-bundle-drift'
docker compose --env-file "${ENV_PATH}" -f "${COMPOSE_PATH}" config -q || die 'current-compose-invalid'

install -m 0600 "${ENV_PATH}" "${BACKUP_PATH}"
PROMOTION_STARTED=1
sed -i "s#^MEDIA_GATEWAY_IMAGE=${OLD_IMAGE}\$#MEDIA_GATEWAY_IMAGE=${NEW_IMAGE}#" "${ENV_PATH}"
chmod 0600 "${ENV_PATH}"
grep -qx "MEDIA_GATEWAY_IMAGE=${NEW_IMAGE}" "${ENV_PATH}" || die 'candidate-image-config-write'
grep -qx 'NORVA_EDGE_CALLBACK_BASE=http://127.0.0.1:9' "${ENV_PATH}" || die 'callback-drift-after-write'
docker compose --env-file "${ENV_PATH}" -f "${COMPOSE_PATH}" config -q || die 'candidate-compose-invalid'

docker compose --env-file "${ENV_PATH}" -f "${COMPOSE_PATH}" \
  up -d --no-build --pull never --wait --wait-timeout 180 gateway

[[ "$(docker inspect "${CONTAINER}" --format '{{.Config.Image}}')" == "${NEW_IMAGE}" ]] || die 'promoted-image-tag-mismatch'
[[ "$(docker inspect "${CONTAINER}" --format '{{.Image}}')" == "${NEW_IMAGE_ID}" ]] || die 'promoted-image-id-mismatch'
[[ "$(docker inspect "${CONTAINER}" --format '{{.State.Health.Status}}')" == 'healthy' ]] || die 'promoted-container-unhealthy'
[[ "$(docker inspect "${CONTAINER}" --format '{{.RestartCount}}')" == '0' ]] || die 'promoted-container-restarted'
[[ "$(docker inspect "${CONTAINER}" --format '{{.State.OOMKilled}}')" == 'false' ]] || die 'promoted-container-oom'
docker inspect "${CONTAINER}" --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -qx 'NORVA_EDGE_CALLBACK_BASE=http://127.0.0.1:9' || die 'promoted-callback-not-private'
assert_idle_health

PROMOTION_STARTED=0
trap - ERR INT TERM

echo '===PRIVATE_PROMOTION_OK==='
docker inspect "${CONTAINER}" --format \
  'image={{.Config.Image}} image_id={{.Image}} status={{.State.Status}} health={{.State.Health.Status}} restarts={{.RestartCount}} oom={{.State.OOMKilled}}'
printf 'ROLLBACK_ENV=%s\n' "${BACKUP_PATH}"
