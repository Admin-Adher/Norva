#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly CONTAINER='norva-media-gateway'
readonly EXPECTED_IMAGE='norva-media-gateway:vaapi-53705bd7e404'
readonly EXPECTED_IMAGE_ID='sha256:7d4cd36a567785471be857d4b4464755a36b734dab430eb8f6675b51cd8bf3af'
readonly EXPECTED_BUNDLE_SHA256='53705bd7e404f5a1805c4ff3ab75cd2ef81f3f38ac843d7135c4e2f3856d2c11'
readonly SAMPLES=10
readonly INTERVAL_SECONDS=30

die() {
  printf 'PRIVATE_VAAPI_SOAK_FAILED:%s\n' "$1" >&2
  exit 1
}

assert_container() {
  [[ "$(docker inspect "${CONTAINER}" --format '{{.Config.Image}}')" == "${EXPECTED_IMAGE}" ]] \
    || die 'image-tag-drift'
  [[ "$(docker inspect "${CONTAINER}" --format '{{.Image}}')" == "${EXPECTED_IMAGE_ID}" ]] \
    || die 'image-id-drift'
  [[ "$(docker image inspect "${EXPECTED_IMAGE}" --format '{{index .Config.Labels "norva.bundle.sha256"}}')" == "${EXPECTED_BUNDLE_SHA256}" ]] \
    || die 'bundle-label-drift'
  [[ "$(docker inspect "${CONTAINER}" --format '{{.State.Status}}')" == 'running' ]] \
    || die 'container-not-running'
  [[ "$(docker inspect "${CONTAINER}" --format '{{.State.Health.Status}}')" == 'healthy' ]] \
    || die 'container-not-healthy'
  [[ "$(docker inspect "${CONTAINER}" --format '{{.RestartCount}}')" == '0' ]] \
    || die 'container-restarted'
  [[ "$(docker inspect "${CONTAINER}" --format '{{.State.OOMKilled}}')" == 'false' ]] \
    || die 'container-oom'
  docker inspect "${CONTAINER}" --format '{{range .Config.Env}}{{println .}}{{end}}' \
    | grep -qx 'NORVA_EDGE_CALLBACK_BASE=http://127.0.0.1:9' \
    || die 'private-callback-drift'
}

assert_idle_health() {
  docker exec "${CONTAINER}" node -e '
    fetch("http://127.0.0.1:8080/health")
      .then(async (response) => {
        const health = await response.json();
        const valid = response.ok && health.ok === true
          && health.activeSessions === 0
          && health.totalSessions === 0
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
          && health.mkvCompleteHlsCache?.enabled === true
          && health.mkvCompleteHlsCache?.coordinationMode === "local"
          && health.mkvCompleteHlsCache?.singleInstanceAttested === true;
        if (!valid) process.exit(1);
        console.log(JSON.stringify({
          time: health.time,
          activeSessions: health.activeSessions,
          activeEncoders: health.videoEncoderCapacity.active,
          activePumps: health.vodInputPump.active,
          rawPumps: health.rawPumpCount,
          startupLocks: health.viewerSessionStartupLockCount,
          cacheHits: health.mkvCompleteHlsCache.stats?.hits ?? 0,
          cacheMisses: health.mkvCompleteHlsCache.stats?.misses ?? 0,
          cacheCorruptions: health.mkvCompleteHlsCache.stats?.corruptions ?? 0,
        }));
      })
      .catch(() => process.exit(1));
  ' || die 'health-not-idle'
}

echo '===PRIVATE_VAAPI_SOAK_START==='
assert_container

for sample in $(seq 1 "${SAMPLES}"); do
  printf 'sample=%s/%s at=%s\n' "${sample}" "${SAMPLES}" "$(date -Is)"
  assert_container
  assert_idle_health
  docker stats --no-stream --format \
    'name={{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}} pids={{.PIDs}}' \
    "${CONTAINER}" norva-db
  uptime
  if [[ "${sample}" -lt "${SAMPLES}" ]]; then
    sleep "${INTERVAL_SECONDS}"
  fi
done

echo '===PRIVATE_VAAPI_SOAK_FINAL_STATE==='
assert_container
assert_idle_health
du -sh /srv/norva-media/output /srv/norva-media/cache
df -h /srv/norva-media/cache
echo '===PRIVATE_VAAPI_SOAK_OK==='
