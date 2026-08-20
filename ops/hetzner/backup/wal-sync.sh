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

# Upload new segments (copy keeps local; prune below is upload-verified).
# --no-traverse: we add a handful of files to a prefix holding thousands, so
# checking those names beats listing the whole destination every 5 minutes.
rclone copy "$SRC" "$DST" --transfers 8 --retries 4 --min-age 5s --no-traverse

# Prune local segments older than KEEP_LOCAL_WAL_MINUTES only if present on R2.
# This keeps local disk bounded without deleting WAL that failed to upload.
CUTOFF_MINUTES="${KEEP_LOCAL_WAL_MINUTES:-60}"
find "$SRC" -maxdepth 1 -type f -mmin +"$CUTOFF_MINUTES" -printf '%f\n' | while read -r f; do
  # One lsf, not two: a non-empty result already proves the object exists.
  if [ -n "$(rclone lsf "$DST/$f" 2>/dev/null)" ]; then
    rm -f "$SRC/$f"
  fi
done

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
