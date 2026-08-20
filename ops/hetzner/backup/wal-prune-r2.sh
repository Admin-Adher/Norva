#!/usr/bin/env bash
# =============================================================================
# wal-prune-r2.sh — prune old WAL segments from R2 according to KEEP_WAL_DAYS
# =============================================================================
# Split out of wal-sync.sh: retention needs to run once a day, not every 5
# minutes. Run by norva-wal-prune-r2.timer (02:20 UTC).
#
# KEEP_WAL_DAYS must always cover the oldest base backup you still intend to
# restore from — i.e. >= KEEP_BASE_COUNT days when the base timer is daily.
# Under-sizing it silently makes the oldest base backup unreplayable.
#
# --use-server-modtime: without it rclone HEADs every object to read its own
# X-Amz-Meta-Mtime, which is ~8k class-B operations per run. The S3
# LastModified is the upload time, and WAL is shipped within seconds of being
# archived, so the two are equivalent here.
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/lib.sh"

DST="r2:${R2_BUCKET}/${R2_PREFIX_WAL%/}"

log "pruning R2 WAL older than ${KEEP_WAL_DAYS:-3} days from $DST"
rclone delete "$DST" --min-age "${KEEP_WAL_DAYS:-3}d" --use-server-modtime --retries 4
log "R2 WAL prune done."
