#!/usr/bin/env bash
# =============================================================================
# wal-sync.sh — ship archived WAL segments to R2 (every 5 min) + prune local
# =============================================================================
# Postgres archives finished WAL segments into WAL_ARCHIVE_DIR (see the db
# service's archive_command). This copies anything new to R2, prunes local
# copies that are old AND uploaded, and screams if the archive dir is backing
# up (archiving stall ⇒ pg_wal grows ⇒ disk risk).
#
# R2-side retention is NOT done here — it lives in norva-wal-prune-r2.timer
# (daily). Doing it on every 5-minute run cost a full listing of a ~8k-object
# prefix 288×/day for nothing; see wal-prune-r2.sh.
# Run by norva-wal-sync.timer. PITR restore: backup/RESTORE.md §2.
# =============================================================================
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/lib.sh"

SRC="${WAL_ARCHIVE_DIR:-/var/lib/norva/wal-archive}"
DST="r2:${R2_BUCKET}/${R2_PREFIX_WAL%/}"
[ -d "$SRC" ] || { echo "ERROR: $SRC missing"; exit 1; }

if ! acquire_wal_r2_lock "${WAL_R2_SYNC_LOCK_WAIT_SECONDS:-30}"; then
  echo "ERROR: another WAL R2 maintenance job still owns the shared lock" >&2
  exit 75
fi

# Upload new segments (copy keeps local; prune below is upload-verified).
# --no-traverse: we add a handful of files to a prefix holding thousands, so
# checking those names beats listing the whole destination every 5 minutes.
rclone copy "$SRC" "$DST" --transfers 8 --retries 4 --min-age 5s --no-traverse

# Prune local segments older than KEEP_LOCAL_WAL_MINUTES only if present on R2.
# Fetch the destination inventory ONCE, then intersect it locally with the old
# source files. The former per-segment remote lookup made one R2 request per
# local WAL and turned a 2k-file backlog into a multi-hour,
# multi-gigabyte oneshot. A failed/incomplete remote listing exits before any
# local deletion, so the safety property remains fail-closed.
CUTOFF_MINUTES="${KEEP_LOCAL_WAL_MINUTES:-60}"
REMOTE_LIST="$(mktemp "${TMPDIR:-/tmp}/norva-wal-remote.XXXXXX")"
LOCAL_OLD_LIST="$(mktemp "${TMPDIR:-/tmp}/norva-wal-local-old.XXXXXX")"
PRUNE_LIST="$(mktemp "${TMPDIR:-/tmp}/norva-wal-prune.XXXXXX")"
cleanup_lists() { rm -f -- "$REMOTE_LIST" "$LOCAL_OLD_LIST" "$PRUNE_LIST"; }
trap cleanup_lists EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

rclone lsf "$DST" --files-only --max-depth 1 > "$REMOTE_LIST"
LC_ALL=C sort -u "$REMOTE_LIST" -o "$REMOTE_LIST"
find "$SRC" -maxdepth 1 -type f -mmin +"$CUTOFF_MINUTES" -printf '%f\n' \
  | LC_ALL=C sort -u > "$LOCAL_OLD_LIST"
LC_ALL=C comm -12 "$LOCAL_OLD_LIST" "$REMOTE_LIST" > "$PRUNE_LIST"

PRUNED=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  rm -f -- "$SRC/$f"
  PRUNED=$((PRUNED + 1))
done < "$PRUNE_LIST"
log "verified one R2 inventory; pruned $PRUNED uploaded local WAL files"

# R2 retention is handled by norva-wal-prune-r2.timer.
# Keep this opt-in escape hatch for manual/debug use only.
if [ "${PRUNE_R2_WAL_ON_SYNC:-0}" = "1" ]; then
  rclone delete "$DST" --min-age "${KEEP_WAL_DAYS:-3}d" --use-server-modtime --retries 4 || true
fi

# Health check: old local files after verified prune indicate upload/prune lag.
COUNT=$(find "$SRC" -maxdepth 1 -type f | wc -l)
OLD_COUNT=$(find "$SRC" -maxdepth 1 -type f -mmin +"${KEEP_LOCAL_WAL_MINUTES:-60}" | wc -l)

if [ "$OLD_COUNT" -gt 100 ]; then
  echo "WARNING: $OLD_COUNT WAL files older than ${KEEP_LOCAL_WAL_MINUTES:-60} minutes remain in $SRC — WAL shipping may be falling behind!" >&2
  exit 1
fi

if [ "$COUNT" -gt 2000 ]; then
  echo "WARNING: $COUNT files in $SRC — unusually high WAL backlog!" >&2
  exit 1
fi
