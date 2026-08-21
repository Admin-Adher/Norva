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
REMOTE_DIR="r2:${R2_BUCKET}/${R2_PREFIX_BASE%/}/base-$STAMP"
# Streaming skips the local staging copy: pg_basebackup writes the tar to stdout
# and rclone pipes it straight to R2. That removes the ~2x-the-database free-disk
# requirement, which is what caps this box (BACKUPS.md). The cost is that a
# stream cannot be retried — a network blip loses the run and the next daily one
# recovers it. Opt-in until a restore drill has validated a streamed artifact.
STREAM="${BASEBACKUP_STREAM:-false}"
if [[ ! "$STREAM" =~ ^(true|false)$ ]]; then
  echo "ERROR: BASEBACKUP_STREAM must be true or false." >&2
  exit 1
fi
if [[ "$STREAM" == "false" ]]; then
  STAGE="${BACKUP_STAGE_DIR:-/var/lib/norva/backups}"
  mkdir -p "$STAGE"
  OUTDIR="$STAGE/base-$STAMP"
  mkdir -p "$OUTDIR"
  trap 'rm -rf "$OUTDIR"' EXIT
fi

# Self-heal the replication pg_hba rule. The supabase image keeps pg_hba at
# /etc/postgresql/pg_hba.conf (inside the container, NOT PGDATA), so it is reset
# whenever the db container is recreated (a compose config change, an image bump).
# Ensure the rule exists + reload before every base backup — idempotent.
log "[0/3] ensure replication pg_hba rule (self-heal after container recreation)"
HBA="$(pgtool psql -h 127.0.0.1 -U supabase_admin -d postgres -Atc 'show hba_file;')"
docker exec -u root "$DB_CONTAINER" bash -lc \
  "grep -q norva-basebackup '$HBA' 2>/dev/null || printf 'host\treplication\tall\t172.16.0.0/12\tscram-sha-256\t# norva-basebackup\n' >> '$HBA'"
pgtool psql -h 127.0.0.1 -U supabase_admin -d postgres -Atc 'select pg_reload_conf();' >/dev/null

if [[ "$STREAM" == "true" ]]; then
  log "[1/3+2/3] pg_basebackup streamed straight to R2 (no local staging)"
  # -D - requires -Ft and forbids -X stream (that needs a second output file).
  # -X fetch folds the WAL needed for self-consistency into the same tar.
  set +e
  PGPASSWORD="$POSTGRES_PASSWORD" \
    docker run --rm --network host -e PGPASSWORD "$PG_IMAGE" \
    pg_basebackup -h 127.0.0.1 -U supabase_admin -D - -Ft -z -X fetch \
      --checkpoint=fast --label="norva-base-$STAMP" \
    | rclone rcat "$REMOTE_DIR/base.tar.gz" --retries 4
  RC=("${PIPESTATUS[@]}")
  set -e
  if [[ "${RC[0]}" -ne 0 || "${RC[1]}" -ne 0 ]]; then
    log "ERROR: stream failed (pg_basebackup=${RC[0]} rclone=${RC[1]}) - purging the partial object"
    rclone purge "$REMOTE_DIR" --retries 2 || true
    exit 1
  fi
  # A stream that dies mid-flight still leaves a well-formed but TRUNCATED object
  # and rcat reports success. Size is the only cheap guard available here;
  # correctness only ever comes from the restore drill (RESTORE.md).
  SIZE_BYTES="$(rclone size "$REMOTE_DIR" --json | grep -o '"bytes":[0-9]*' | cut -d: -f2)"
  MIN_BYTES="${BASEBACKUP_MIN_BYTES:-104857600}"
  if [[ "${SIZE_BYTES:-0}" -lt "$MIN_BYTES" ]]; then
    log "ERROR: uploaded base is ${SIZE_BYTES:-0} bytes, under the ${MIN_BYTES} floor - purging"
    rclone purge "$REMOTE_DIR" --retries 2 || true
    exit 1
  fi
  log "uploaded base-$STAMP ($(numfmt --to=iec "$SIZE_BYTES" 2>/dev/null || echo "${SIZE_BYTES}B"))"
else
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
fi

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
