#!/usr/bin/env bash
# =============================================================================
# 01-dump-prod.sh — dump the managed Supabase project (globals + schema + data)
# =============================================================================
# Reads MANAGED_DB_URL from ops/hetzner/.env. Writes to ./dump/ (gitignored).
# Run this INSIDE a maintenance window with imports FROZEN (pause the sources or
# disable the sync crons on the managed side) so the snapshot is consistent.
#
# What this captures:  roles + role GUCs (globals), full schema, all data.
# What it does NOT capture (recreated by 03-recreate-cron-guc.sql):
#   - vault secrets (encrypted at rest; re-injected from your secret store)
#   - pg_cron jobs (URLs point at the managed project; rewritten + recreated)
#
# Requires: pg_dump / pg_dumpall v17 (managed prod is PostgreSQL 17). A pg_dump
# OLDER than the server refuses to dump; if the box's client is < 17, run this
# through the same image instead, e.g.:
#   docker run --rm -e MANAGED_DB_URL --network host -v "$PWD/dump:/dump" \
#     supabase/postgres:17.6.1.136 bash -c 'pg_dumpall --dbname="$MANAGED_DB_URL" ...'
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$HERE/.env}"
OUT="${OUT:-$HERE/dump}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found. Copy .env.hetzner.example to .env and fill it." >&2
  exit 1
fi

# Fail loudly if the local pg_dump is older than the PG17 server — an older
# client silently omits objects / errors mid-dump.
DUMP_MAJOR="$(pg_dump --version 2>/dev/null | grep -oE '[0-9]+' | head -1 || echo 0)"
if [[ "${DUMP_MAJOR:-0}" -lt 17 ]]; then
  echo "ERROR: pg_dump major is ${DUMP_MAJOR:-unknown}, but managed prod is PG17." >&2
  echo "       Install postgresql-client-17 or run the dump via the" >&2
  echo "       supabase/postgres:17.6.1.136 image (see header)." >&2
  exit 1
fi
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

: "${MANAGED_DB_URL:?Set MANAGED_DB_URL in $ENV_FILE (Supabase > Project Settings > Database)}"

mkdir -p "$OUT"
echo ">> Dumping from managed project into $OUT"

# 1) Globals: roles + role-level GUCs (anon/authenticated statement_timeout, etc.)
#    --no-role-passwords: cloud role passwords aren't exfiltratable; we set new
#    passwords in the self-host stack. We keep the ROLE definitions + their SET GUCs.
echo "   [1/3] globals (roles + role GUCs)"
pg_dumpall --dbname="$MANAGED_DB_URL" --globals-only --no-role-passwords \
  > "$OUT/00-globals.sql"

# 2) Schema only (tables, RLS policies, functions, triggers, views, indexes).
#    Exclude Supabase-managed internal schemas that the self-host stack recreates
#    itself (auth/storage/realtime/vault/cron are provided by the images/extensions).
echo "   [2/3] schema (public + app schemas)"
pg_dump --dbname="$MANAGED_DB_URL" --schema-only --no-owner --no-privileges \
  --schema='public' \
  --file="$OUT/01-schema.sql"

# 3) Data only for public schema (the catalogue, users' cloud_* rows, etc.).
#    --disable-triggers so FK/trigger order doesn't block the restore.
echo "   [3/3] data (public schema)"
pg_dump --dbname="$MANAGED_DB_URL" --data-only --no-owner --no-privileges \
  --schema='public' --disable-triggers \
  --file="$OUT/02-data.sql"

# 4) Reference exports — current cron jobs + extensions.
#    ref-cron-jobs.sql is REPLAYABLE: `format('%L')` quoting survives multi-line
#    commands (the naive -At TSV export does NOT — cron commands span lines, which
#    produced a corrupt 286-line file for 49 jobs during the 2026-07-11 cutover).
#    Rewrite the functions host before replaying, e.g.:
#      sed 's#https://<ref>.supabase.co/functions/v1#https://api.norva.tv/functions/v1#g'
#    then pipe into psql on the target. Jobs are created ACTIVE by cron.schedule —
#    stage them with `update cron.job set active=false;` if the flip isn't now.
echo "   [ref] exporting cron jobs (replayable SQL) + extension list"
psql "$MANAGED_DB_URL" -At \
  -c "select format('select cron.schedule(%L,%L,%L);', jobname, schedule, command)
      from cron.job where jobname is not null and jobname<>'' order by jobid" \
  > "$OUT/ref-cron-jobs.sql" || echo "   (warn: could not read cron.job — export manually)"
psql "$MANAGED_DB_URL" -At \
  -c "select extname||' '||extversion from pg_extension order by extname" \
  > "$OUT/ref-extensions.txt" || true

echo ">> Done. Files:"
ls -lh "$OUT"
echo
echo "NEXT: run 02-restore-hetzner.sh to load these into the self-host stack."
echo "REMINDER: vault secrets + cron URLs are handled by 03-recreate-cron-guc.sql."
