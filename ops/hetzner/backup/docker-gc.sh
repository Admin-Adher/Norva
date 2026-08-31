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
IMAGE_MIN_AGE_HOURS="${DOCKER_GC_IMAGE_MIN_AGE_HOURS:-168}"
ROLLBACK_IMAGES_PER_FAMILY="${DOCKER_GC_ROLLBACK_IMAGES_PER_FAMILY:-2}"

case "$IMAGE_MIN_AGE_HOURS:$ROLLBACK_IMAGES_PER_FAMILY" in
  *[!0-9:]*|:*|*:) echo "DOCKER_GC_REFUSED: numeric settings are invalid" >&2; exit 64 ;;
esac

[ ! -L "$LOCK_FILE" ] || { echo "DOCKER_GC_REFUSED: lock file is a symlink" >&2; exit 65; }
(umask 000; : >>"$LOCK_FILE")
chmod 0666 "$LOCK_FILE" 2>/dev/null || true
exec 9>>"$LOCK_FILE"
flock -n 9 || { echo "DOCKER_GC_SKIPPED: another run owns $LOCK_FILE"; exit 0; }

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }

log "docker usage before"
docker system df

if [ "$MODE" = dry-run ]; then
  log "DRY_RUN build cache policy max=$MAX_CACHE_SPACE reserved=$RESERVED_CACHE_SPACE min-free=$MIN_FREE_SPACE"
  docker buildx du | tail -n 6 || true
else
  docker buildx prune --all --force \
    --max-used-space "$MAX_CACHE_SPACE" \
    --reserved-space "$RESERVED_CACHE_SPACE" \
    --min-free-space "$MIN_FREE_SPACE"
fi

declare -A used_ids=()
declare -A seen_ids=()
while IFS= read -r container; do
  [ -n "$container" ] || continue
  image_id="$(docker inspect -f '{{.Image}}' "$container")"
  used_ids["$image_id"]=1
done < <(docker ps -aq)

prune_family() {
  local pattern="$1" kept=0
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
    if [ "$age_hours" -lt "$IMAGE_MIN_AGE_HOURS" ]; then
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

prune_family 'norva-media-gateway:vaapi-*'
seen_ids=()
prune_family 'norva-whisper-bench:*'

# Dangling layers older than the same grace period are never rollback targets.
if [ "$MODE" = dry-run ]; then
  log "DRY_RUN dangling image prune until=${IMAGE_MIN_AGE_HOURS}h"
else
  docker image prune --force --filter "until=${IMAGE_MIN_AGE_HOURS}h"
fi

log "docker usage after"
docker system df
log "DOCKER_GC_OK mode=$MODE"
