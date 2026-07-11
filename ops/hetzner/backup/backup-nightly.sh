#!/usr/bin/env bash
# =============================================================================
# backup-nightly.sh — nightly LOGICAL backup of the self-host DB → R2
# =============================================================================
# Dumps everything a from-scratch rebuild needs (lessons from the 2026-07-11
# cutover): globals, public schema+data, AUTH data (accounts!), STORAGE data,
# replayable cron statements, extension list. Tars, uploads to R2, prunes old.
# Read-only against the DB. Run by norva-backup-nightly.timer as root.
# Restore procedure: backup/RESTORE.md §1.
# =============================================================================
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/lib.sh"

STAMP="$(date -u +%Y%m%d-%H%M%S)"
BASENAME="norva-selfhost-${STAMP}"
STAGE="${BACKUP_STAGE_DIR:-/var/lib/norva/backups}/nightly-work"
rm -rf "$STAGE"; mkdir -p "$STAGE/$BASENAME"
trap 'rm -rf "$STAGE"' EXIT
OUT="$STAGE/$BASENAME"
H=127.0.0.1; U=supabase_admin; D=postgres

log "[1/5] logical dumps (globals, public, auth, storage)"
pgtool pg_dumpall -h $H -U $U --globals-only --no-role-passwords > "$OUT/00-globals.sql"
pgtool pg_dump -h $H -U $U -d $D --schema-only --no-owner --no-privileges \
  --schema=public > "$OUT/01-schema.sql"
pgtool pg_dump -h $H -U $U -d $D --data-only --no-owner --no-privileges \
  --schema=public --disable-triggers > "$OUT/02-data.sql"
pgtool pg_dump -h $H -U $U -d $D --data-only --no-owner --no-privileges \
  --schema=auth --disable-triggers > "$OUT/03-auth-data.sql"
pgtool pg_dump -h $H -U $U -d $D --data-only --no-owner --no-privileges \
  --schema=storage --disable-triggers > "$OUT/04-storage-data.sql"

log "[2/5] reference exports (crons as replayable SQL, extensions)"
pgtool psql -h $H -U $U -d $D -At \
  -c "select format('select cron.schedule(%L,%L,%L);', jobname, schedule, command)
      from cron.job where jobname is not null and jobname<>'' order by jobid" \
  > "$OUT/ref-cron-jobs.sql" || true
pgtool psql -h $H -U $U -d $D -At \
  -c "select jobname||' active='||active from cron.job order by jobid" \
  > "$OUT/ref-cron-active.txt" || true
pgtool psql -h $H -U $U -d $D -At \
  -c "select extname||' '||extversion from pg_extension order by extname" \
  > "$OUT/ref-extensions.txt" || true

log "[3/5] manifest + checksums"
{
  echo "created_utc=$(date -u +%FT%TZ)"
  echo "stamp=$STAMP"
  echo "server_version=$(pgtool psql -h $H -U $U -d $D -Atc 'show server_version')"
  echo "cloud_media_items=$(pgtool psql -h $H -U $U -d $D -Atc 'select count(*) from public.cloud_media_items')"
  echo "auth_users=$(pgtool psql -h $H -U $U -d $D -Atc 'select count(*) from auth.users')"
} > "$OUT/MANIFEST.txt"
( cd "$OUT" && sha256sum ./* > SHA256SUMS )

log "[4/5] compress + upload"
ARCHIVE="$STAGE/${BASENAME}.tar.gz"
tar -C "$STAGE" -czf "$ARCHIVE" "$BASENAME"
SIZE="$(du -h "$ARCHIVE" | cut -f1)"
rclone copyto "$ARCHIVE" "r2:${R2_BUCKET}/${R2_PREFIX_DUMPS%/}/${BASENAME}.tar.gz" --retries 4
log "uploaded ${BASENAME}.tar.gz ($SIZE)"

log "[5/5] retention: keep ${KEEP_DUMPS_DAYS:-14} days of nightly dumps"
rclone delete "r2:${R2_BUCKET}/${R2_PREFIX_DUMPS%/}/" --min-age "${KEEP_DUMPS_DAYS:-14}d" --retries 4 || true

log "nightly backup done."
