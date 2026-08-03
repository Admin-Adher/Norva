#!/usr/bin/env bash
# =============================================================================
# backup-nightly.sh — nightly LOGICAL backup of the self-host DB → R2
# =============================================================================
# Dumps everything a from-scratch rebuild needs (lessons from the 2026-07-11
# cutover): globals, public + affiliate_private schema/data, AUTH data
# (accounts!), STORAGE data,
# replayable cron statements, extension list. Tars, optionally age-encrypts,
# uploads to R2, verifies the remote size, then prunes old objects.
# Read-only against the DB. Run by norva-backup-nightly.timer as root.
# Restore procedure: backup/RESTORE.md §1.
# =============================================================================
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/lib.sh"

BACKUP_ENCRYPTION_REQUIRED="${BACKUP_ENCRYPTION_REQUIRED:-false}"
case "$BACKUP_ENCRYPTION_REQUIRED" in
  true|false) ;;
  *)
    echo "ERROR: BACKUP_ENCRYPTION_REQUIRED must be true or false" >&2
    exit 1
    ;;
esac
if [[ "$BACKUP_ENCRYPTION_REQUIRED" == "true" && -z "${BACKUP_AGE_RECIPIENT:-}" ]]; then
  echo "ERROR: BACKUP_AGE_RECIPIENT is required for this backup" >&2
  exit 1
fi
if [[ -n "${BACKUP_AGE_RECIPIENT:-}" ]] && ! command -v age >/dev/null 2>&1; then
  echo "ERROR: age is required when BACKUP_AGE_RECIPIENT is configured" >&2
  exit 1
fi

umask 077
STAMP="$(date -u +%Y%m%d-%H%M%S)"
BASENAME="norva-selfhost-${STAMP}"
BACKUP_ROOT="${BACKUP_STAGE_DIR:-/var/lib/norva/backups}"
mkdir -p "$BACKUP_ROOT"
STAGE="$(mktemp -d "${BACKUP_ROOT%/}/nightly-work.${STAMP}.XXXXXX")"
UPLOAD_VERIFIED=false
ARCHIVE=""
cleanup() {
  local status=$?
  trap - EXIT
  if [[ "$UPLOAD_VERIFIED" == "true" ]]; then
    rm -rf "$STAGE"
  elif [[ -n "$ARCHIVE" && -f "$ARCHIVE" ]]; then
    chmod -R go-rwx "$STAGE" 2>/dev/null || true
    log "ERROR: R2 upload was not verified; local backup retained at $STAGE"
  else
    rm -rf "$STAGE"
  fi
  exit "$status"
}
trap cleanup EXIT
mkdir -p "$STAGE/$BASENAME"
OUT="$STAGE/$BASENAME"
H=127.0.0.1; U=supabase_admin; D=postgres

log "[1/5] logical dumps (globals, public, affiliate_private, auth, storage)"
pgtool pg_dumpall -h $H -U $U --globals-only --no-role-passwords > "$OUT/00-globals.sql"
pgtool pg_dump -h $H -U $U -d $D --schema-only --no-owner \
  --schema=public --schema=affiliate_private > "$OUT/01-schema.sql"
if ! grep -Eq '^(GRANT|REVOKE) ' "$OUT/01-schema.sql"; then
  log "ERROR: schema dump contains no ACL statements"
  exit 1
fi
pgtool pg_dump -h $H -U $U -d $D --data-only --no-owner --no-privileges \
  --schema=public --schema=affiliate_private --disable-triggers > "$OUT/02-data.sql"
pgtool pg_dump -h $H -U $U -d $D --data-only --no-owner --no-privileges \
  --schema=auth --disable-triggers > "$OUT/03-auth-data.sql"
pgtool pg_dump -h $H -U $U -d $D --data-only --no-owner --no-privileges \
  --schema=storage --disable-triggers > "$OUT/04-storage-data.sql"

log "[2/5] reference exports (crons as replayable SQL, extensions)"
pgtool psql -h $H -U $U -d $D -At \
  -c "with replay as (
        select
          jobid,
          format(
            'select cron.schedule(%L,%L,%L); update cron.job set active=%s where jobname=%L;',
            jobname, schedule, command, active::text, jobname
          ) as statement
        from cron.job
        where jobname is not null and jobname<>''
        union all
        select
          9223372036854775807::bigint,
          'update cron.job set active=false where jobname=''norva-partners-revolut-api'';'
      )
      select statement from replay order by jobid" \
  > "$OUT/ref-cron-jobs.sql" || true
pgtool psql -h $H -U $U -d $D -At \
  -c "select jobname||' active='||active from cron.job order by jobid" \
  > "$OUT/ref-cron-active.txt" || true
pgtool psql -h $H -U $U -d $D -At \
  -c "select extname||' '||extversion from pg_extension order by extname" \
  > "$OUT/ref-extensions.txt" || true

log "[3/5] manifest + checksums"
AFFILIATE_ACCOUNTS_COUNT="$(
  pgtool psql -h "$H" -U "$U" -d "$D" -Atc \
    "select case when to_regclass('affiliate_private.affiliate_accounts') is null then -1 else (select count(*) from affiliate_private.affiliate_accounts) end"
)"
{
  echo "created_utc=$(date -u +%FT%TZ)"
  echo "stamp=$STAMP"
  echo "server_version=$(pgtool psql -h $H -U $U -d $D -Atc 'show server_version')"
  echo "cloud_media_items=$(pgtool psql -h $H -U $U -d $D -Atc 'select count(*) from public.cloud_media_items')"
  echo "auth_users=$(pgtool psql -h $H -U $U -d $D -Atc 'select count(*) from auth.users')"
  echo "affiliate_accounts=$AFFILIATE_ACCOUNTS_COUNT"
  echo "schema_acl_statements=$(grep -Ec '^(GRANT|REVOKE) ' "$OUT/01-schema.sql")"
} > "$OUT/MANIFEST.txt"
( cd "$OUT" && sha256sum ./* > SHA256SUMS )

log "[4/5] compress + upload"
ARCHIVE="$STAGE/${BASENAME}.tar.gz"
tar -C "$STAGE" -czf "$ARCHIVE" "$BASENAME"
UPLOAD="$ARCHIVE"
if [[ -n "${BACKUP_AGE_RECIPIENT:-}" ]]; then
  log "encrypting archive with age"
  age --recipient "$BACKUP_AGE_RECIPIENT" --output "${ARCHIVE}.age" "$ARCHIVE"
  UPLOAD="${ARCHIVE}.age"
elif [[ "$BACKUP_ENCRYPTION_REQUIRED" == "false" ]]; then
  log "WARNING: uploading legacy plaintext archive because encryption is not required"
fi

REMOTE="r2:${R2_BUCKET}/${R2_PREFIX_DUMPS%/}/$(basename "$UPLOAD")"
SIZE="$(du -h "$UPLOAD" | cut -f1)"
LOCAL_BYTES="$(wc -c < "$UPLOAD" | tr -d '[:space:]')"
rclone copyto "$UPLOAD" "$REMOTE" --retries 4
REMOTE_BYTES="$(rclone lsl "$REMOTE" --retries 4 | awk 'NR == 1 { print $1 }')"
if [[ ! "$REMOTE_BYTES" =~ ^[0-9]+$ || "$REMOTE_BYTES" != "$LOCAL_BYTES" ]]; then
  log "ERROR: R2 verification failed for $(basename "$UPLOAD") (local=$LOCAL_BYTES remote=${REMOTE_BYTES:-missing})"
  exit 1
fi
UPLOAD_VERIFIED=true

# Keep the plaintext until the encrypted R2 object has been verified. The EXIT
# trap removes the remaining staging directory only after this point.
if [[ "$UPLOAD" != "$ARCHIVE" ]]; then
  rm -f "$ARCHIVE"
fi
log "uploaded and verified $(basename "$UPLOAD") ($SIZE)"

log "[5/5] retention: keep ${KEEP_DUMPS_DAYS:-14} days of nightly dumps"
rclone delete "r2:${R2_BUCKET}/${R2_PREFIX_DUMPS%/}/" --min-age "${KEEP_DUMPS_DAYS:-14}d" --retries 4 || true

log "nightly backup done."
