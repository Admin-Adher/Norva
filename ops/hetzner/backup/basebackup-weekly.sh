#!/usr/bin/env bash
# =============================================================================
# basebackup-weekly.sh — weekly PHYSICAL base backup → R2 (PITR anchor)
# =============================================================================
# pg_basebackup in tar+gzip format, streamed to a local staging file, then
# uploaded to R2. Combined with the WAL archive this enables point-in-time
# recovery: restore base, replay WAL to any moment. Requires a replication-
# capable role (supabase_admin is superuser+replication in the supabase image)
# and a pg_hba replication entry — verified at install time (BACKUPS.md §setup).
# Run by norva-basebackup.timer. Restore: backup/RESTORE.md §2.
# =============================================================================
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Preserve only these explicit, non-secret one-shot operator overrides. The
# sourced backup environment remains authoritative for credentials and paths.
KEEP_BASE_COUNT_OVERRIDE="${KEEP_BASE_COUNT-}"
SKIP_BASE_RETENTION_OVERRIDE="${NORVA_SKIP_BASE_RETENTION-}"
# shellcheck disable=SC1091
source "$HERE/lib.sh"

if [[ -n "$KEEP_BASE_COUNT_OVERRIDE" ]]; then
  KEEP_BASE_COUNT="$KEEP_BASE_COUNT_OVERRIDE"
fi
if [[ -n "$SKIP_BASE_RETENTION_OVERRIDE" ]]; then
  NORVA_SKIP_BASE_RETENTION="$SKIP_BASE_RETENTION_OVERRIDE"
fi
if [[ ! "${KEEP_BASE_COUNT:-3}" =~ ^[1-9][0-9]{0,2}$ ]]; then
  echo "ERROR: KEEP_BASE_COUNT must be an integer from 1 to 999." >&2
  exit 1
fi
if [[ ! "${NORVA_SKIP_BASE_RETENTION:-false}" =~ ^(true|false)$ ]]; then
  echo "ERROR: NORVA_SKIP_BASE_RETENTION must be true or false." >&2
  exit 1
fi

STAMP="$(date -u +%Y%m%d-%H%M%S)"
STAGE="${BACKUP_STAGE_DIR:-/var/lib/norva/backups}"
mkdir -p "$STAGE"
OUTDIR="$STAGE/base-$STAMP"
mkdir -p "$OUTDIR"
trap 'rm -rf "$OUTDIR"' EXIT

# Self-heal the replication pg_hba rule. The supabase image keeps pg_hba at
# /etc/postgresql/pg_hba.conf (inside the container, NOT PGDATA), so it is reset
# whenever the db container is recreated (a compose config change, an image bump).
# Ensure the rule exists + reload before every base backup — idempotent.
log "[0/3] ensure replication pg_hba rule (self-heal after container recreation)"
HBA="$(pgtool psql -h 127.0.0.1 -U supabase_admin -d postgres -Atc 'show hba_file;')"
docker exec -u root "$DB_CONTAINER" bash -lc \
  "grep -q norva-basebackup '$HBA' 2>/dev/null || printf 'host\treplication\tall\t172.16.0.0/12\tscram-sha-256\t# norva-basebackup\n' >> '$HBA'"
pgtool psql -h 127.0.0.1 -U supabase_admin -d postgres -Atc 'select pg_reload_conf();' >/dev/null

log "[1/3] pg_basebackup (tar+gzip, WAL fetched → standalone-restorable)"
# -Ft: tar per tablespace (base.tar.gz [+ pg_wal.tar.gz with -X fetch is folded in])
# -X fetch: include the WAL needed to make THIS backup consistent on its own;
#           PITR beyond backup-end uses the R2 WAL archive.
PGPASSWORD="$POSTGRES_PASSWORD" \
  docker run --rm --network host -e PGPASSWORD \
  -v "$OUTDIR:/out" "$PG_IMAGE" \
  pg_basebackup -h 127.0.0.1 -U supabase_admin -D /out -Ft -z -X fetch \
    --checkpoint=fast --label="norva-weekly-$STAMP"

log "[2/3] upload to R2"
for f in "$OUTDIR"/*; do
  rclone copyto "$f" "r2:${R2_BUCKET}/${R2_PREFIX_BASE%/}/base-$STAMP/$(basename "$f")" --retries 4
done
log "uploaded base-$STAMP ($(du -sh "$OUTDIR" | cut -f1))"

if [[ "${NORVA_SKIP_BASE_RETENTION:-false}" == "true" ]]; then
  log "[3/3] retention skipped by explicit one-shot operator control"
else
  log "[3/3] retention: keep last ${KEEP_BASE_COUNT:-3} base backups"
  rclone lsf "r2:${R2_BUCKET}/${R2_PREFIX_BASE%/}/" --dirs-only 2>/dev/null \
    | sort | head -n -"${KEEP_BASE_COUNT:-3}" | while read -r d; do
      log "pruning old base backup: $d"
      if ! rclone purge "r2:${R2_BUCKET}/${R2_PREFIX_BASE%/}/${d%/}" --retries 4; then
        log "WARNING: retention could not prune $d; backup creation remains valid"
      fi
    done
fi

log "weekly base backup done."
