#!/usr/bin/env bash
# =============================================================================
# backup-to-r2.sh — offsite logical backup of the managed Supabase DB → Cloudflare R2
# =============================================================================
# Produces the SAME logical snapshot as ops/hetzner/scripts/01-dump-prod.sh
# (globals + public schema + public data + reference exports), bundles it into a
# single compressed (optionally age-encrypted) archive, and uploads it to an R2
# bucket via the S3-compatible API.
#
# WHY this exists / double benefit:
#   1. Offsite insurance TODAY — independent of Supabase's own backups and of the
#      Hetzner box. If the Supabase account is lost, this archive is a full logical
#      restore point in your own storage.
#   2. It IS the migration dump — the archive unpacks to 00-globals.sql /
#      01-schema.sql / 02-data.sql, exactly what 02-restore-hetzner.sh consumes.
#      Running this on a schedule means the Hetzner cutover dump is already
#      automated and proven the day the box arrives.
#
# SAFETY: read-only. pg_dump / pg_dumpall only. Never writes to the source DB.
#
# ---- Required env -----------------------------------------------------------
#   SUPABASE_DB_URL        Postgres URI. USE THE SESSION POOLER (port 5432,
#                          ...pooler.supabase.com) — it is IPv4-reachable (CI
#                          runners are IPv4-only) and supports pg_dump. The direct
#                          5432 host is often IPv6-only. (MANAGED_DB_URL also read
#                          as a fallback, for parity with the ops/hetzner scripts.)
#   R2_ACCOUNT_ID          Cloudflare account id (the R2 S3 endpoint host prefix).
#   R2_ACCESS_KEY_ID       R2 API token's Access Key ID.
#   R2_SECRET_ACCESS_KEY   R2 API token's Secret Access Key.
#   R2_BUCKET              Target bucket name (e.g. norva-db-backups).
# ---- Optional env -----------------------------------------------------------
#   R2_PREFIX              Key prefix inside the bucket (default: db).
#   BACKUP_AGE_RECIPIENT   age public key (age1...). If set, the archive is
#                          encrypted with age before upload (belt-and-suspenders
#                          on top of R2's private-bucket access control).
#   BACKUP_STAMP           Override the timestamp used in the object key (for
#                          reproducible runs / tests). Default: UTC now.
#   PG_DUMP / PG_DUMPALL   Override the binaries (e.g. /usr/lib/postgresql/17/bin).
#   AWS_CLI                Override the aws binary path.
#
# Requires: pg_dump/pg_dumpall v17 (match the server, 17.6), tar, gzip, sha256sum,
#           aws-cli v2, and (if BACKUP_AGE_RECIPIENT set) age.
# =============================================================================
set -euo pipefail

PG_DUMP="${PG_DUMP:-pg_dump}"
PG_DUMPALL="${PG_DUMPALL:-pg_dumpall}"
AWS_CLI="${AWS_CLI:-aws}"

DB_URL="${SUPABASE_DB_URL:-${MANAGED_DB_URL:-}}"
: "${DB_URL:?Set SUPABASE_DB_URL (session pooler URI) — see header}"
: "${R2_ACCOUNT_ID:?Set R2_ACCOUNT_ID}"
: "${R2_ACCESS_KEY_ID:?Set R2_ACCESS_KEY_ID}"
: "${R2_SECRET_ACCESS_KEY:?Set R2_SECRET_ACCESS_KEY}"
: "${R2_BUCKET:?Set R2_BUCKET}"
R2_PREFIX="${R2_PREFIX:-db}"

STAMP="${BACKUP_STAMP:-$(date -u +%Y%m%d-%H%M%S)}"
BASENAME="norva-db-${STAMP}"
WORK="$(mktemp -d)"
STAGE="$WORK/$BASENAME"
mkdir -p "$STAGE"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

echo ">> [1/5] Dumping managed DB (globals + schema + data) — read-only"
# Globals: role definitions + role-level GUCs (statement_timeout, etc.).
# --no-role-passwords: managed role passwords aren't exfiltratable; the self-host
# stack sets its own. We keep the ROLE definitions + their SET GUCs.
"$PG_DUMPALL" --dbname="$DB_URL" --globals-only --no-role-passwords \
  > "$STAGE/00-globals.sql"
# Schema of the app (public). Supabase-managed schemas (auth/storage/realtime/
# vault/cron) are provided by the self-host images/extensions on restore.
"$PG_DUMP" --dbname="$DB_URL" --schema-only --no-owner --no-privileges \
  --schema='public' --file="$STAGE/01-schema.sql"
# Data of public (catalogue + users' cloud_* rows). --disable-triggers so FK/
# trigger order doesn't block a restore.
"$PG_DUMP" --dbname="$DB_URL" --data-only --no-owner --no-privileges \
  --schema='public' --disable-triggers --file="$STAGE/02-data.sql"
# Reference exports (for transcription during migration — crons point at the
# managed project and get rewritten by 03-recreate-cron-guc.sql).
psql "$DB_URL" -At -F $'\t' \
  -c "select jobid, schedule, jobname, command from cron.job order by jobid" \
  > "$STAGE/ref-cron-jobs.tsv" 2>/dev/null || echo "   (warn: cron.job not readable)"
psql "$DB_URL" -At \
  -c "select extname||' '||extversion from pg_extension order by extname" \
  > "$STAGE/ref-extensions.txt" 2>/dev/null || true

echo ">> [2/5] Manifest + checksums"
{
  echo "created_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "stamp=$STAMP"
  echo "pg_dump_version=$("$PG_DUMP" --version 2>/dev/null | head -1)"
  echo "server_version=$(psql "$DB_URL" -At -c 'show server_version' 2>/dev/null || echo unknown)"
} > "$STAGE/MANIFEST.txt"
( cd "$STAGE" && sha256sum ./*.sql ./*.txt ./*.tsv 2>/dev/null > SHA256SUMS || true )

echo ">> [3/5] Compressing"
ARCHIVE="$WORK/${BASENAME}.tar.gz"
tar -C "$WORK" -czf "$ARCHIVE" "$BASENAME"
UPLOAD="$ARCHIVE"
CONTENT_TYPE="application/gzip"

if [[ -n "${BACKUP_AGE_RECIPIENT:-}" ]]; then
  echo ">> [3b] Encrypting with age (recipient ${BACKUP_AGE_RECIPIENT:0:12}…)"
  age -r "$BACKUP_AGE_RECIPIENT" -o "${ARCHIVE}.age" "$ARCHIVE"
  UPLOAD="${ARCHIVE}.age"
  CONTENT_TYPE="application/octet-stream"
fi

KEY="${R2_PREFIX%/}/$(basename "$UPLOAD")"
SIZE="$(du -h "$UPLOAD" | cut -f1)"

echo ">> [4/5] Uploading to r2://$R2_BUCKET/$KEY ($SIZE)"
export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="auto"
# R2's S3 API rejects the flexible checksums aws-cli v2.23+ adds by default
# ("x-amz-checksum-crc32 not implemented"). Only send/expect them when required.
export AWS_REQUEST_CHECKSUM_CALCULATION="when_required"
export AWS_RESPONSE_CHECKSUM_VALIDATION="when_required"
ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
n=0
until "$AWS_CLI" s3 cp "$UPLOAD" "s3://$R2_BUCKET/$KEY" \
      --endpoint-url "$ENDPOINT" --content-type "$CONTENT_TYPE" --only-show-errors; do
  n=$((n+1)); [[ $n -ge 4 ]] && { echo "ERROR: upload failed after retries" >&2; exit 1; }
  echo "   upload failed, retry $n in $((2**n))s"; sleep $((2**n))
done

echo ">> [5/5] Done."
echo "   object : s3://$R2_BUCKET/$KEY"
echo "   size   : $SIZE"
echo "   restore: aws s3 cp s3://$R2_BUCKET/$KEY . --endpoint-url $ENDPOINT"
[[ -n "${BACKUP_AGE_RECIPIENT:-}" ]] && echo "            age -d -i <key> <file>.age | tar -xz   (then psql < 00/01/02)"
