#!/usr/bin/env bash
set -euo pipefail

IMAGE="${1:-norva-media-gateway:vaapi-4149dc82e3d5}"
ROOT="${2:-/tmp/norva-multi-audio-hls-benchmark}"
FIXTURE="${ROOT}/twelve-audio-tracks.mkv"

mkdir -p "${ROOT}"

if [[ ! -s "${FIXTURE}" ]]; then
  docker run --rm \
    -v "${ROOT}:/bench" \
    --entrypoint ffmpeg \
    "${IMAGE}" \
    -hide_banner -loglevel error -nostdin -y \
    -f lavfi -i "testsrc2=size=1280x720:rate=25:duration=60" \
    -f lavfi -i "sine=frequency=220:sample_rate=48000:duration=60" \
    -f lavfi -i "sine=frequency=260:sample_rate=48000:duration=60" \
    -f lavfi -i "sine=frequency=300:sample_rate=48000:duration=60" \
    -f lavfi -i "sine=frequency=340:sample_rate=48000:duration=60" \
    -f lavfi -i "sine=frequency=380:sample_rate=48000:duration=60" \
    -f lavfi -i "sine=frequency=420:sample_rate=48000:duration=60" \
    -f lavfi -i "sine=frequency=460:sample_rate=48000:duration=60" \
    -f lavfi -i "sine=frequency=500:sample_rate=48000:duration=60" \
    -f lavfi -i "sine=frequency=540:sample_rate=48000:duration=60" \
    -f lavfi -i "sine=frequency=580:sample_rate=48000:duration=60" \
    -f lavfi -i "sine=frequency=620:sample_rate=48000:duration=60" \
    -f lavfi -i "sine=frequency=660:sample_rate=48000:duration=60" \
    -map 0:v:0 \
    -map 1:a:0 -map 2:a:0 -map 3:a:0 -map 4:a:0 \
    -map 5:a:0 -map 6:a:0 -map 7:a:0 -map 8:a:0 \
    -map 9:a:0 -map 10:a:0 -map 11:a:0 -map 12:a:0 \
    -c:v mpeg4 -q:v 8 -g 50 \
    -c:a pcm_s16le \
    /bench/twelve-audio-tracks.mkv
fi

run_case() {
  local count="$1"
  local iteration="$2"
  local out="${ROOT}/out-${count}-${iteration}"
  local log="${ROOT}/ffmpeg-${count}-${iteration}.log"
  local -a maps=()
  local var_map=""
  local i

  rm -rf "${out}"
  mkdir -p "${out}"

  for ((i = 0; i < count; i += 1)); do
    maps+=( -map "0:a:${i}" )
    var_map+="a:${i},agroup:audio,language:und,default:$([[ ${i} -eq 0 ]] && echo yes || echo no),name:audio_${i} "
  done
  var_map+="v:0,agroup:audio,name:video"

  local start_ms
  start_ms="$(date +%s%3N)"
  /usr/bin/time -f "TIME elapsed=%e user=%U sys=%S rss_kb=%M" \
  docker run --rm --cpus=6 --memory=10g \
    -v "${ROOT}:/bench" \
    --entrypoint ffmpeg \
    "${IMAGE}" \
      -hide_banner -loglevel warning -nostdin -y \
      -i /bench/twelve-audio-tracks.mkv \
      -map 0:v:0 "${maps[@]}" \
      -c:v copy \
      -af "aresample=48000:async=1:first_pts=0" \
      -c:a aac -profile:a aac_low -ar 48000 -ac 2 -b:a 160k \
      -fps_mode passthrough \
      -f hls -hls_time 2 -hls_list_size 0 -hls_playlist_type event \
      -hls_segment_type mpegts \
      -hls_flags independent_segments+temp_file \
      -hls_segment_filename "/bench/out-${count}-${iteration}/%v-%05d.ts" \
      -master_pl_name playlist.m3u8 \
      -var_stream_map "${var_map}" \
      "/bench/out-${count}-${iteration}/%v.m3u8" \
      >"${log}" 2>&1 &
  local pid=$!

  local ready_ms=""
  while kill -0 "${pid}" 2>/dev/null; do
    local playlists segments
    playlists="$(find "${out}" -maxdepth 1 -name '*.m3u8' -type f | wc -l)"
    segments="$(find "${out}" -maxdepth 1 -name '*-00000.ts' -type f | wc -l)"
    if [[ -s "${out}/playlist.m3u8" && "${playlists}" -ge $((count + 2)) && "${segments}" -ge $((count + 1)) ]]; then
      ready_ms="$(( $(date +%s%3N) - start_ms ))"
      break
    fi
    sleep 0.05
  done

  wait "${pid}"
  local total_ms="$(( $(date +%s%3N) - start_ms ))"
  if [[ -z "${ready_ms}" ]]; then
    ready_ms="not-observed"
  fi
  printf 'AUDIO_HLS count=%s iteration=%s first_ready_ms=%s total_ms=%s\n' \
    "${count}" "${iteration}" "${ready_ms}" "${total_ms}"
  grep -E '^(TIME|bench:)' "${log}" || true
}

for count in 8 12; do
  for iteration in 1 2 3; do
    run_case "${count}" "${iteration}"
  done
done
