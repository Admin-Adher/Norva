#!/usr/bin/env bash
# Six-hour storage-only watchdog usable without root credentials. The full
# capacity-check service remains authoritative for WAL, DB and backup health.
set -Eeuo pipefail

DISK_WARN_PCT="${CAPACITY_DISK_WARN_PCT:-70}"
PROOF_WARN_GIB="${CAPACITY_PROOF_WARN_GIB:-25}"
BUILD_CACHE_WARN_GIB="${CAPACITY_BUILD_CACHE_WARN_GIB:-20}"
IMAGE_RECLAIMABLE_WARN_GIB="${CAPACITY_IMAGE_RECLAIMABLE_WARN_GIB:-15}"
PROOF_ROOT="${PROOF_GC_ROOT:-/var/lib/norva-phase3-proof}"
NORVA_OPS_DIR="${NORVA_OPS_DIR:-/home/adrien/norva/ops/hetzner}"
CLEANUP_IMAGE="${PROOF_GC_IMAGE:-supabase/postgres:17.6.1.136}"

[ "$PROOF_ROOT" = /var/lib/norva-phase3-proof ] \
  || { echo "STORAGE_WATCH_REFUSED: unexpected proof root" >&2; exit 65; }

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }

metric_to_bytes() {
  local value="${1/B/}"
  numfmt --from=si "$value"
}

proof_bytes() {
  if docker inspect norva-netdata >/dev/null 2>&1 \
     && [ "$(docker inspect -f '{{.State.Running}}' norva-netdata)" = true ]; then
    docker exec norva-netdata du -sb /host/root/var/lib/norva-phase3-proof 2>/dev/null | awk '{print $1}'
    return
  fi
  docker run --rm --entrypoint /bin/sh -v "$PROOF_ROOT:/proof-root:ro" \
    "$CLEANUP_IMAGE" -c 'du -sb /proof-root | cut -f1'
}

telegram() {
  local sender_dir
  sender_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  printf '%s' "$1" | python3 "$sender_dir/telegram-send.py" "$NORVA_OPS_DIR/.env" "${TELEGRAM_RECEIPT_DIR:-/var/lib/norva}/storage-watch.sh.telegram.json" \
    || log "WARN Telegram infrastructure delivery failed; receipt retained for retry"
}

USE_PCT="$(df --output=pcent / | tail -1 | tr -dc '0-9')"
AVAIL_BYTES="$(df --output=avail -B1 / | tail -1 | tr -d ' ')"
AVAIL_GIB="$(awk -v b="$AVAIL_BYTES" 'BEGIN{printf "%.1f", b/1073741824}')"
PROOF_BYTES="$(proof_bytes)"
PROOF_GIB="$(awk -v b="$PROOF_BYTES" 'BEGIN{printf "%.1f", b/1073741824}')"
DOCKER_DF="$(docker system df --format '{{.Type}}|{{.Size}}|{{.Reclaimable}}')"
BUILD_CACHE_HUMAN="$(awk -F '|' '$1=="Build Cache"{print $2}' <<<"$DOCKER_DF")"
IMAGE_RECLAIMABLE_HUMAN="$(awk -F '|' '$1=="Images"{split($3,a," "); print a[1]}' <<<"$DOCKER_DF")"
BUILD_CACHE_BYTES="$(metric_to_bytes "${BUILD_CACHE_HUMAN:-0B}")"
IMAGE_RECLAIMABLE_BYTES="$(metric_to_bytes "${IMAGE_RECLAIMABLE_HUMAN:-0B}")"
BUILD_CACHE_GIB="$(awk -v b="$BUILD_CACHE_BYTES" 'BEGIN{printf "%.1f", b/1073741824}')"
IMAGE_RECLAIMABLE_GIB="$(awk -v b="$IMAGE_RECLAIMABLE_BYTES" 'BEGIN{printf "%.1f", b/1073741824}')"

log "disk ${USE_PCT}% · ${AVAIL_GIB} GiB free · proof ${PROOF_GIB} GiB · build cache ${BUILD_CACHE_GIB} GiB · reclaimable images ${IMAGE_RECLAIMABLE_GIB} GiB"

ALERTS=()
[ "$USE_PCT" -le "$DISK_WARN_PCT" ] \
  || ALERTS+=("Disque a ${USE_PCT}% (seuil ${DISK_WARN_PCT}%), ${AVAIL_GIB} GiB libres.")
[ "$PROOF_BYTES" -le $((PROOF_WARN_GIB * 1073741824)) ] \
  || ALERTS+=("Preuves jetables a ${PROOF_GIB} GiB (seuil ${PROOF_WARN_GIB}).")
[ "$BUILD_CACHE_BYTES" -le $((BUILD_CACHE_WARN_GIB * 1073741824)) ] \
  || ALERTS+=("Cache BuildKit a ${BUILD_CACHE_GIB} GiB (seuil ${BUILD_CACHE_WARN_GIB}).")
[ "$IMAGE_RECLAIMABLE_BYTES" -le $((IMAGE_RECLAIMABLE_WARN_GIB * 1073741824)) ] \
  || ALERTS+=("Images recuperables a ${IMAGE_RECLAIMABLE_GIB} GiB (seuil ${IMAGE_RECLAIMABLE_WARN_GIB}).")

if [ "${#ALERTS[@]}" -eq 0 ]; then
  log "STORAGE_WATCH_OK"
  exit 0
fi

message="[norva-db] storage-watch"
for alert in "${ALERTS[@]}"; do message="$message"$'\n'"- $alert"; done
telegram "$message"
printf '%s\n' "$message" >&2
exit 1
