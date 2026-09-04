#!/usr/bin/env bash
# Retire old, inactive deployment worktrees without touching live bind mounts,
# mounted paths, dirty Git trees, protected markers, or the newest rollbacks.
set -Eeuo pipefail

MODE=dry-run
while (($#)); do
  case "$1" in
    --dry-run) MODE=dry-run; shift ;;
    --apply) MODE=apply; shift ;;
    -h|--help)
      echo "Usage: deployment-gc.sh [--dry-run|--apply]"; exit 0 ;;
    *) echo "Usage: deployment-gc.sh [--dry-run|--apply]" >&2; exit 64 ;;
  esac
done

LOCK_FILE="${DEPLOYMENT_GC_LOCK_FILE:-/run/lock/norva-deployment-gc.lock}"
ALLOWED_BASE="${DEPLOYMENT_GC_ALLOWED_BASE:-/home/adrien}"
ROOTS="${DEPLOYMENT_GC_ROOTS:-/home/adrien/norva-deployments /home/adrien/norva-media-deployments /home/adrien/norva-candidates}"
DEPLOYMENT_TTL_HOURS="${DEPLOYMENT_GC_DEPLOYMENT_TTL_HOURS:-168}"
CANDIDATE_TTL_HOURS="${DEPLOYMENT_GC_CANDIDATE_TTL_HOURS:-72}"
KEEP_NEWEST="${DEPLOYMENT_GC_KEEP_NEWEST_PER_ROOT:-2}"
PROTECTED_NAME_REGEX="${DEPLOYMENT_GC_PROTECTED_NAME_REGEX:-(^|[-_.])(backup|backups|evidence|proof)([-_.]|$)}"

case "$DEPLOYMENT_TTL_HOURS:$CANDIDATE_TTL_HOURS:$KEEP_NEWEST" in
  *[!0-9:]*|:*|*:) echo "DEPLOYMENT_GC_REFUSED: numeric settings are invalid" >&2; exit 64 ;;
esac

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }

ALLOWED_BASE_REAL="$(realpath -e "$ALLOWED_BASE")"
[ "$ALLOWED_BASE_REAL" != / ] \
  || { echo "DEPLOYMENT_GC_REFUSED: allowed base cannot be /" >&2; exit 65; }

[ ! -L "$LOCK_FILE" ] || { echo "DEPLOYMENT_GC_REFUSED: lock file is a symlink" >&2; exit 65; }
(umask 000; : >>"$LOCK_FILE")
chmod 0666 "$LOCK_FILE" 2>/dev/null || true
exec 9>>"$LOCK_FILE"
flock -n 9 || { echo "DEPLOYMENT_GC_SKIPPED: another run owns $LOCK_FILE"; exit 0; }

declare -a ACTIVE_SOURCES=()
while IFS= read -r container; do
  [ -n "$container" ] || continue
  while IFS= read -r source; do
    [ -n "$source" ] && ACTIVE_SOURCES+=("$(realpath -m "$source")")
  done < <(docker inspect -f '{{range .Mounts}}{{if eq .Type "bind"}}{{println .Source}}{{end}}{{end}}' "$container")
done < <(docker ps -aq)

declare -a MOUNT_TARGETS=()
while IFS= read -r target; do
  [ -n "$target" ] && MOUNT_TARGETS+=("$(realpath -m "$target")")
done < <(findmnt -rn -o TARGET 2>/dev/null || true)

contains_protected_path() {
  local candidate="$1" path
  for path in "${ACTIVE_SOURCES[@]}" "${MOUNT_TARGETS[@]}"; do
    case "$path" in "$candidate"|"$candidate"/*) return 0 ;; esac
  done
  return 1
}

remove_candidate() {
  local candidate="$1"
  if [ -f "$candidate/.git" ]; then
    if ! git -C "$candidate" worktree remove "$candidate"; then
      log "SKIP worktree-remove-failed $candidate"
      return 0
    fi
  else
    rm -rf --one-file-system -- "$candidate"
  fi
}

NOW_EPOCH="$(date -u +%s)"
REMOVED_COUNT=0
REMOVED_BYTES=0

for root in $ROOTS; do
  [ -d "$root" ] || { log "SKIP missing root $root"; continue; }
  [ ! -L "$root" ] || { echo "DEPLOYMENT_GC_REFUSED: root is a symlink: $root" >&2; exit 65; }
  root_real="$(realpath -e "$root")"
  case "$root_real" in "$ALLOWED_BASE_REAL"/norva-*) ;; *)
    echo "DEPLOYMENT_GC_REFUSED: root outside approved Norva paths: $root_real" >&2; exit 65 ;;
  esac

  ttl="$DEPLOYMENT_TTL_HOURS"
  case "$root_real" in */norva-candidates) ttl="$CANDIDATE_TTL_HOURS" ;; esac

  mapfile -d '' entries < <(find "$root_real" -mindepth 1 -maxdepth 1 -type d -printf '%T@|%p\0' | sort -z -t '|' -k1,1nr)
  index=0
  for entry in "${entries[@]}"; do
    candidate="${entry#*|}"
    mtime="${entry%%|*}"; mtime="${mtime%.*}"
    index=$((index + 1))
    age_hours=$(( (NOW_EPOCH - mtime) / 3600 ))

    if [ "$index" -le "$KEEP_NEWEST" ]; then
      log "KEEP newest $candidate ($index/$KEEP_NEWEST)"
      continue
    fi
    [ "$age_hours" -ge "$ttl" ] || { log "KEEP recent $candidate age=${age_hours}h"; continue; }
    if grep -Eiq "$PROTECTED_NAME_REGEX" <<<"$(basename "$candidate")"; then
      log "KEEP protected-name $candidate"
      continue
    fi
    [ ! -e "$candidate/.norva-retain" ] || { log "KEEP protected-marker $candidate"; continue; }
    if contains_protected_path "$candidate"; then
      log "KEEP active-or-mounted $candidate"
      continue
    fi
    if git -C "$candidate" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
       && [ -n "$(git -C "$candidate" status --porcelain --untracked-files=normal)" ]; then
      log "KEEP dirty-worktree $candidate"
      continue
    fi

    bytes="$(du -sb "$candidate" | awk '{print $1}')"
    if [ "$MODE" = dry-run ]; then
      log "DRY_RUN remove $candidate age=${age_hours}h bytes=$bytes"
    else
      remove_candidate "$candidate"
      if [ -e "$candidate" ]; then
        log "SKIP still-present $candidate"
        continue
      fi
      log "REMOVED $candidate age=${age_hours}h bytes=$bytes"
      REMOVED_COUNT=$((REMOVED_COUNT + 1))
      REMOVED_BYTES=$((REMOVED_BYTES + bytes))
    fi
  done
done

log "DEPLOYMENT_GC_OK mode=$MODE removed=$REMOVED_COUNT bytes=$REMOVED_BYTES"
