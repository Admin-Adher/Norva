#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly DB_CONTAINER='norva-db'
readonly GATEWAY_CONTAINER='norva-media-gateway'
readonly GATEWAY_ID='a7250ec1-171b-4bcf-ad7d-41bac56130ec'
readonly EXPECTED_GATEWAY_VERSION='105'
readonly OBSERVE_SECONDS='120'

die() {
  printf 'LIVE_VAAPI_WEB_CANARY_RESUME_FAIL:%s\n' "$1" >&2
  exit 1
}

db_scalar() {
  docker exec "${DB_CONTAINER}" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -Atq -c "$1"
}

db_row() {
  docker exec "${DB_CONTAINER}" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -Atq -F '|' -c "$1"
}

gateway_session_row() {
  local session_id="$1"
  docker exec -i -e SESSION_ID="${session_id}" "${GATEWAY_CONTAINER}" node <<'NODE'
const id = String(process.env.SESSION_ID || '');
const token = String(process.env.GATEWAY_TOKEN || '');
if (!/^[0-9a-f-]{36}$/i.test(id) || !token) process.exit(2);
fetch(`http://127.0.0.1:8080/sessions/${encodeURIComponent(id)}`, {
  headers: { Authorization: `Bearer ${token}` },
})
  .then(async (response) => {
    if (response.status === 404) process.exit(4);
    if (!response.ok) process.exit(3);
    const s = await response.json();
    const p = s.startupPolicy || {};
    const t = s.startupTimings || {};
    const fields = [
      s.status,
      s.mode,
      s.videoMode,
      s.audioMode,
      p.protocol,
      p.eligible,
      p.pipeline,
      p.targetBufferSeconds,
      p.minimumEncodeRateX,
      p.observedEncodeRateX,
      p.reason,
      t.totalMs,
      t.ffmpegReadyMs,
      t.playlistBufferSeconds,
      t.videoEncoder,
      t.completeHlsCacheHit === true,
      t.providerGetCount,
      t.ffmpegSpawnCount,
    ].map((value) => value == null ? '' : String(value).replaceAll('|', ''));
    process.stdout.write(fields.join('|'));
  })
  .catch(() => process.exit(3));
NODE
}

gateway_health_summary() {
  docker exec -i "${GATEWAY_CONTAINER}" node <<'NODE'
fetch('http://127.0.0.1:8080/health')
  .then(async (response) => {
    const h = await response.json();
    if (!response.ok || h.ok !== true || h.version !== 105) process.exit(1);
    process.stdout.write(JSON.stringify({
      version: h.version,
      activeSessions: h.activeSessions,
      activeEncoders: h.videoEncoderCapacity?.active,
      activePumps: h.vodInputPump?.active,
      rawPumps: h.rawPumpCount,
      startupLocks: h.viewerSessionStartupLockCount,
      encoder: h.videoEncoder?.backend,
    }));
  })
  .catch(() => process.exit(1));
NODE
}

[[ "$(docker inspect "${GATEWAY_CONTAINER}" --format '{{.State.Health.Status}}')" == 'healthy' ]] \
  || die 'gateway-unhealthy'
[[ "$(docker inspect "${GATEWAY_CONTAINER}" --format '{{.RestartCount}}')" == '0' ]] \
  || die 'gateway-restarted'
[[ "$(docker inspect "${GATEWAY_CONTAINER}" --format '{{.State.OOMKilled}}')" == 'false' ]] \
  || die 'gateway-oom'

canary_hash="$(db_scalar "select value from public.cloud_runtime_config where key='NORVA_MEDIA_GATEWAY_CANARY_USER_HASHES';")"
[[ "${canary_hash}" =~ ^[0-9a-f]{64}$ ]] || die 'canary-user-hash'

session_row="$(db_row "select coalesce(g.external_session_id,''),g.playback_session_id::text,g.status,g.mode,floor(extract(epoch from g.created_at)*1000)::bigint from public.cloud_gateway_sessions g where g.gateway_id='${GATEWAY_ID}'::uuid and encode(digest(g.user_id::text,'sha256'),'hex')='${canary_hash}' and g.created_at >= now() - interval '20 minutes' order by g.created_at desc limit 1;")"
[[ -n "${session_row}" ]] || die 'no-recent-canary-session'
IFS='|' read -r gateway_session_id playback_session_id db_status db_mode session_created_ms <<<"${session_row}"
[[ "${gateway_session_id}" =~ ^[0-9a-f-]{36}$ \
    && "${playback_session_id}" =~ ^[0-9a-f-]{36}$ \
    && "${session_created_ms}" =~ ^[0-9]{13}$ ]] || die 'invalid-session-row'

gateway_row="$(gateway_session_row "${gateway_session_id}" 2>/dev/null || true)"
gateway_snapshot='absent-after-cleanup'
gateway_ready_log="$(docker logs --since 25m "${GATEWAY_CONTAINER}" 2>&1 \
  | grep -F "[media-gateway] session ${gateway_session_id} ready " \
  | tail -n 1 \
  | sed 's/^.* ready //' || true)"
if [[ -n "${gateway_row}" ]]; then
  gateway_snapshot='live'
fi

printf '===LIVE_VAAPI_WEB_CANARY_RESUME_ATTACHED===\n'
printf 'database=status-%s mode-%s gateway=%s\n' "${db_status}" "${db_mode}" "${gateway_snapshot}"
if [[ -n "${gateway_ready_log}" ]]; then
  printf 'gateway_ready_log=%s\n' "${gateway_ready_log}"
fi

if [[ -n "${gateway_row}" ]]; then
  IFS='|' read -r \
    gateway_status gateway_mode video_mode audio_mode policy_protocol policy_eligible policy_pipeline \
    target_buffer_seconds minimum_rate_x observed_rate_x policy_reason gateway_total_ms ffmpeg_ready_ms \
    playlist_buffer_seconds video_encoder complete_cache_hit provider_get_count ffmpeg_spawn_count \
    <<<"${gateway_row}"
  printf 'startup=protocol-%s eligible-%s reason-%s pipeline-%s video-%s audio-%s totalMs-%s targetBuffer-%s encoder-%s\n' \
    "${policy_protocol}" "${policy_eligible}" "${policy_reason}" "${policy_pipeline}" \
    "${video_mode}" "${audio_mode}" "${gateway_total_ms}" "${target_buffer_seconds}" "${video_encoder}"

  [[ "${gateway_status}" == 'ready' ]] || die "gateway-session-status-${gateway_status:-missing}"
  [[ "${policy_protocol}" == '2' && "${policy_eligible}" == 'true' ]] \
    || die 'startup-policy-not-eligible-v2'
  [[ "${target_buffer_seconds}" == '6' ]] || die "startup-target-${target_buffer_seconds:-missing}"
  [[ "${gateway_total_ms}" =~ ^[0-9]+$ && "${gateway_total_ms}" -lt 10000 ]] \
    || die 'gateway-startup-over-10s'
  case "${policy_reason}" in
    vaapi-transcode-ready)
      [[ "${video_mode}" == 'encode' && "${video_encoder}" == 'vaapi' ]] || die 'vaapi-graph-mismatch'
      awk -v rate="${observed_rate_x}" -v minimum="${minimum_rate_x}" \
        'BEGIN { exit !(rate + 0 >= minimum + 0 && minimum + 0 >= 2) }' \
        || die 'vaapi-rate-below-policy'
      ;;
    mkv-h264-copy-ready)
      [[ "${video_mode}" == 'copy' ]] || die 'copy-graph-mismatch'
      ;;
    complete-hls-cache-hit)
      [[ "${video_mode}" == 'copy' && "${complete_cache_hit}" == 'true' \
          && "${provider_get_count}" == '0' && "${ffmpeg_spawn_count}" == '0' ]] \
        || die 'cache-hit-graph-mismatch'
      ;;
    *) die "startup-policy-reason-${policy_reason:-missing}" ;;
  esac
fi

first_frame_row=''
error_row=''
deadline=$((SECONDS + OBSERVE_SECONDS))
while (( SECONDS < deadline )); do
  error_row="$(db_row "select event_type,coalesce(error_code,'') from public.cloud_playback_events e where encode(digest(e.user_id::text,'sha256'),'hex')='${canary_hash}' and e.created_at >= to_timestamp(${session_created_ms}/1000.0) and e.event_type in ('playback_error','gateway_error') order by e.created_at asc limit 1;")"
  [[ -z "${error_row}" ]] || die "playback-error-${error_row//|/-}"
  first_frame_row="$(db_row "select e.time_to_first_frame_ms::text,coalesce(e.playback_mode,''),coalesce(e.metadata->>'frameEvidence',''),coalesce(e.metadata->>'currentSrcType',''),coalesce(e.metadata->>'readyState',''),coalesce(e.metadata->>'presentedFrames',''),coalesce(e.metadata->>'mediaTime','') from public.cloud_playback_events e where encode(digest(e.user_id::text,'sha256'),'hex')='${canary_hash}' and e.created_at >= to_timestamp(${session_created_ms}/1000.0) and e.event_type='first_frame' and (e.playback_session_id='${playback_session_id}'::uuid or e.playback_session_id is null) order by e.created_at asc limit 1;")"
  [[ -n "${first_frame_row}" ]] && break
  sleep 1
done

if [[ -z "${first_frame_row}" ]]; then
  health="$(gateway_health_summary || true)"
  printf 'LIVE_VAAPI_WEB_CANARY_RESUME_DIAGNOSTIC no_first_frame=1 gateway=%s\n' "${health:-unavailable}" >&2
  die 'first-frame-timeout'
fi

IFS='|' read -r ttff_ms event_playback_mode frame_evidence current_src_type ready_state presented_frames media_time <<<"${first_frame_row}"
[[ "${ttff_ms}" =~ ^[0-9]+$ && "${ttff_ms}" -gt 0 && "${ttff_ms}" -lt 10000 ]] \
  || die "web-ttff-${ttff_ms:-missing}"
[[ "${frame_evidence}" == 'video-frame-callback' ]] || die "frame-evidence-${frame_evidence:-missing}"
[[ "${current_src_type}" == 'gateway' ]] || die "current-src-${current_src_type:-missing}"
[[ "${ready_state}" =~ ^[0-9]+$ && "${ready_state}" -ge 2 ]] || die "ready-state-${ready_state:-missing}"
[[ "${presented_frames}" =~ ^[0-9]+$ && "${presented_frames}" -ge 1 ]] || die "presented-frames-${presented_frames:-missing}"
[[ "${media_time}" =~ ^-?[0-9]+([.][0-9]+)?$ ]] || die 'media-time-missing'

if [[ "${gateway_snapshot}" == 'live' ]]; then
  printf 'NORVA_LIVE_WEB_FIRST_FRAME_OK {"ttffMs":%s,"gatewayStartupMs":%s,"gatewayPolicy":"%s","pipeline":"%s","videoMode":"%s","audioMode":"%s","targetBufferSeconds":%s,"observedRateX":%s,"frameEvidence":"%s","readyState":%s,"presentedFrames":%s}\n' \
    "${ttff_ms}" "${gateway_total_ms}" "${policy_reason}" "${policy_pipeline}" "${video_mode}" "${audio_mode}" \
    "${target_buffer_seconds}" "${observed_rate_x:-0}" "${frame_evidence}" "${ready_state}" "${presented_frames}"
else
  printf 'NORVA_LIVE_WEB_FIRST_FRAME_PERSISTED_OK {"ttffMs":%s,"gatewaySnapshot":"%s","frameEvidence":"%s","currentSrcType":"%s","readyState":%s,"presentedFrames":%s}\n' \
    "${ttff_ms}" "${gateway_snapshot}" "${frame_evidence}" "${current_src_type}" "${ready_state}" "${presented_frames}"
fi
echo 'La session est deja nettoyee. Envoie la sortie du terminal sans relancer Play.'
