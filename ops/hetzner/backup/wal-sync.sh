#!/usr/bin/env bash
# =============================================================================
# wal-sync.sh — ship archived WAL segments to R2 (every 5 min) + prune local
# =============================================================================
# Postgres archives finished WAL segments into WAL_ARCHIVE_DIR (see the db
# service's archive_command). This copies anything new to R2, prunes local
# copies that are old AND uploaded, applies R2 WAL retention, and screams if
# the archive dir is backing up (archiving stall ⇒ pg_wal grows ⇒ disk risk).
# Run by norva-wal-sync.timer. PITR restore: backup/RESTORE.md §2.
# =============================================================================
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/lib.sh"

SRC="${WAL_ARCHIVE_DIR:-/var/lib/norva/wal-archive}"
DST="r2:${R2_BUCKET}/${R2_PREFIX_WAL%/}"
[ -d "$SRC" ] || { echo "ERROR: $SRC missing"; exit 1; }

# Upload new segments (copy keeps local; prune below is upload-verified).
rclone copy "$SRC" "$DST" --transfers 8 --retries 4 --min-age 5s

# Prune local segments older than KEEP_LOCAL_WAL_DAYS *only if present on R2*.
CUTOFF_DAYS="${KEEP_LOCAL_WAL_DAYS:-3}"
find "$SRC" -maxdepth 1 -type f -mtime +"$CUTOFF_DAYS" -printf '%f\n' | while read -r f; do
  if rclone lsf "$DST/$f" >/dev/null 2>&1 && [ -n "$(rclone lsf "$DST/$f" 2>/dev/null)" ]; then
    rm -f "$SRC/$f"
  fi
done

# R2 retention — must always cover the oldest kept base backup.
rclone delete "$DST" --min-age "${KEEP_WAL_DAYS:-35}d" --retries 4 || true

# Health check: too many local files = uploads or archiving stalling.
COUNT=$(find "$SRC" -maxdepth 1 -type f | wc -l)
if [ "$COUNT" -gt 500 ]; then
  echo "WARNING: $COUNT files in $SRC — WAL shipping is falling behind!" >&2
  exit 1   # non-zero so systemd marks the unit failed (visible in monitoring)
fi
