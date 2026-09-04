#!/usr/bin/env bash
# Bound BuildKit growth and retire only explicitly scoped, unused media images.
set -Eeuo pipefail

MODE=dry-run
while (($#)); do
  case "$1" in
    --dry-run) MODE=dry-run; shift ;;
    --apply) MODE=apply; shift ;;
    -h|--help)
      echo "Usage: docker-gc.sh [--dry-run|--apply]"; exit 0 ;;
    *) echo "Usage: docker-gc.sh [--dry-run|--apply]" >&2; exit 64 ;;
  esac
done

LOCK_FILE="${DOCKER_GC_LOCK_FILE:-/run/lock/norva-docker-gc.lock}"
MAX_CACHE_SPACE="${DOCKER_GC_MAX_CACHE_SPACE:-12GB}"
RESERVED_CACHE_SPACE="${DOCKER_GC_RESERVED_CACHE_SPACE:-8GB}"
MIN_FREE_SPACE="${DOCKER_GC_MIN_FREE_SPACE:-120GB}"
MEDIA_IMAGE_MIN_AGE_HOURS="${DOCKER_GC_MEDIA_IMAGE_MIN_AGE_HOURS:-48}"
WHISPER_IMAGE_MIN_AGE_HOURS="${DOCKER_GC_WHISPER_IMAGE_MIN_AGE_HOURS:-168}"
ROLLBACK_IMAGES_PER_FAMILY="${DOCKER_GC_ROLLBACK_IMAGES_PER_FAMILY:-2}"
CACHE_PRUNE_MAX_PASSES="${DOCKER_GC_CACHE_PRUNE_MAX_PASSES:-6}"

case "$MEDIA_IMAGE_MIN_AGE_HOURS:$WHISPER_IMAGE_MIN_AGE_HOURS:$ROLLBACK_IMAGES_PER_FAMILY:$CACHE_PRUNE_MAX_PASSES" in
  *[!0-9:]*|:*|*:) echo "DOCKER_GC_REFUSED: numeric settings are invalid" >&2; exit 64 ;;
esac

[ ! -L "$LOCK_FILE" ] || { echo "DOCKER_GC_REFUSED: lock file is a symlink" >&2; exit 65; }
(umask 000; : >>"$LOCK_FILE")
chmod 0666 "$LOCK_FILE" 2>/dev/null || true
exec 9>>"$LOCK_FILE"
flock -n 9 || { echo "DOCKER_GC_SKIPPED: another run owns $LOCK_FILE"; exit 0; }

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }

metric_to_bytes() {
  local value="${1/B/}"
  numfmt --from=si "$value"
}

build_cache_bytes() {
  local value
  value="$(docker system df --format '{{.Type}}|{{.Size}}' | awk -F '|' '$1=="Build Cache"{print $2}')"
  metric_to_bytes "${value:-0B}"
}

free_bytes() {
  df --output=avail -B1 / | tail -1 | tr -d ' '
}

enforce_cache_budget() {
  local pass before after max_bytes
  max_bytes="$(metric_to_bytes "$MAX_CACHE_SPACE")"
  for ((pass=1; pass<=CACHE_PRUNE_MAX_PASSES; pass++)); do
    before="$(build_cache_bytes)"
    [ "$before" -gt "$max_bytes" ] || return 0
    docker buildx prune --all --force \
      --max-used-space "$MAX_CACHE_SPACE" \
      --reserved-space "$RESERVED_CACHE_SPACE"
    after="$(build_cache_bytes)"
    log "build cache budget pass $pass/$CACHE_PRUNE_MAX_PASSES: before=$before after=$after max=$max_bytes"
    [ "$after" -lt "$before" ] || { log "build cache budget made no progress"; return 0; }
  done
}

log "docker usage before"
docker system df

if [ "$MODE" = dry-run ]; then
  log "DRY_RUN build cache budget max=$MAX_CACHE_SPACE reserved=$RESERVED_CACHE_SPACE"
  log "DRY_RUN emergency free-space target=$MIN_FREE_SPACE (separate pass, only when needed)"
  docker buildx du | tail -n 6 || true
else
  # A single policy carrying both --max-used-space and --min-free-space can be
  # a no-op while the filesystem is above the free-space target. Enforce the
  # cache budget first, then run the emergency free-space policy only when the
  # host is actually below its reserve.
  enforce_cache_budget

  if [ "$(free_bytes)" -lt "$(metric_to_bytes "$MIN_FREE_SPACE")" ]; then
    log "free space below $MIN_FREE_SPACE; running the separate emergency policy"
    docker buildx prune --all --force \
      --min-free-space "$MIN_FREE_SPACE" \
      --reserved-space "$RESERVED_CACHE_SPACE"
  fi
fi

declare -A used_ids=()
declare -A seen_ids=()
while IFS= read -r container; do
  [ -n "$container" ] || continue
  image_id="$(docker inspect -f '{{.Image}}' "$container")"
  used_ids["$image_id"]=1
done < <(docker ps -aq)

prune_family() {
  local pattern="$1" min_age_hours="$2" kept=0
  local created_epoch image_id tag protected age_hours
  while IFS='|' read -r created_epoch image_id tag; do
    [ -n "$image_id" ] || continue
    [ -z "${seen_ids[$image_id]:-}" ] || continue
    seen_ids["$image_id"]=1
    if [ -n "${used_ids[$image_id]:-}" ]; then
      log "KEEP active image $tag"
      continue
    fi
    protected="$(docker image inspect -f '{{index .Config.Labels "norva.retention"}}' "$image_id" 2>/dev/null || true)"
    if [ "$protected" = protected ]; then
      log "KEEP protected image $tag"
      continue
    fi
    if [ "$kept" -lt "$ROLLBACK_IMAGES_PER_FAMILY" ]; then
      kept=$((kept+1))
      log "KEEP rollback image $tag ($kept/$ROLLBACK_IMAGES_PER_FAMILY)"
      continue
    fi
    age_hours=$(( ($(date -u +%s)-created_epoch) / 3600 ))
    if [ "$age_hours" -lt "$min_age_hours" ]; then
      log "KEEP recent image $tag age=${age_hours}h"
      continue
    fi
    if [ "$MODE" = dry-run ]; then
      log "DRY_RUN remove unused image $tag age=${age_hours}h"
    else
      docker image rm "$image_id"
      log "REMOVED unused image $tag age=${age_hours}h"
    fi
  done < <(
    docker image ls --format '{{.Repository}}:{{.Tag}}|{{.ID}}' |
      while IFS='|' read -r tag short_id; do
        case "$tag" in $pattern) ;; *) continue ;; esac
        [ "$tag" != '<none>:<none>' ] || continue
        docker image inspect -f '{{.Created}}|{{.Id}}' "$short_id" |
          while IFS='|' read -r created image_id; do
            printf '%s|%s|%s\n' "$(date -d "$created" +%s)" "$image_id" "$tag"
          done
      done | sort -t '|' -k1,1nr
  )
}

prune_family 'norva-media-gateway:vaapi-*' "$MEDIA_IMAGE_MIN_AGE_HOURS"
seen_ids=()
prune_family 'norva-whisper-bench:*' "$WHISPER_IMAGE_MIN_AGE_HOURS"

# Dangling layers older than the shorter media grace are never rollback targets.
if [ "$MODE" = dry-run ]; then
  log "DRY_RUN dangling image prune until=${MEDIA_IMAGE_MIN_AGE_HOURS}h"
else
  docker image prune --force --filter "until=${MEDIA_IMAGE_MIN_AGE_HOURS}h"
fi

# Removing image references can make another layer of BuildKit records
# reclaimable. Iterate the bounded budget policy again after image cleanup.
[ "$MODE" = dry-run ] || enforce_cache_budget

log "docker usage after"
docker system df

CACHE_BYTES_AFTER="$(build_cache_bytes)"
MAX_CACHE_BYTES="$(metric_to_bytes "$MAX_CACHE_SPACE")"
CACHE_AFTER_GB="$(awk -v b="$CACHE_BYTES_AFTER" 'BEGIN{printf "%.2f", b/1000000000}')"
if [ "$CACHE_BYTES_AFTER" -gt "$MAX_CACHE_BYTES" ]; then
  if [ "$MODE" = dry-run ]; then
    log "DRY_RUN post-check would fail: cache=${CACHE_AFTER_GB}GB max=$MAX_CACHE_SPACE"
  else
    echo "DOCKER_GC_LIMIT_NOT_MET: cache=${CACHE_AFTER_GB}GB max=$MAX_CACHE_SPACE" >&2
    exit 1
  fi
else
  log "build cache post-check OK: cache=${CACHE_AFTER_GB}GB max=$MAX_CACHE_SPACE"
fi
log "DOCKER_GC_OK mode=$MODE"
