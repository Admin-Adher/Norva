#!/usr/bin/env bash
# =============================================================================
# 02-restore-hetzner.sh — restore the dump into the self-host Postgres
# =============================================================================
# Loads ./dump/{00-globals,01-schema,02-data}.sql into the local stack's db.
# Run AFTER `docker compose up -d` and after Postgres is healthy.
#
# Order matters: extensions -> globals(roles) -> schema -> data.
# Idempotency: intended for a FRESH db. If re-running, recreate the db first.
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$HERE/.env}"
DUMP="${DUMP:-$HERE/dump}"

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a
: "${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in $ENV_FILE}"

# Target the local stack's Postgres (bound to 127.0.0.1:5432 by the compose).
TARGET="postgresql://postgres:${POSTGRES_PASSWORD}@127.0.0.1:5432/${POSTGRES_DB:-postgres}"
export PGPASSWORD="$POSTGRES_PASSWORD"

for f in 00-globals 01-schema 02-data; do
  [[ -f "$DUMP/$f.sql" ]] || { echo "ERROR: $DUMP/$f.sql missing — run 01-dump-prod.sh first" >&2; exit 1; }
done

echo ">> 0) Ensure required extensions exist (idempotent)"
psql "$TARGET" -v ON_ERROR_STOP=1 <<'SQL'
create extension if not exists "uuid-ossp";
create extension if not exists pgcrypto;
create extension if not exists pg_trgm;
create extension if not exists unaccent;
create extension if not exists http;
create extension if not exists pgstattuple;
create extension if not exists pg_stat_statements;
create extension if not exists pg_net;
create extension if not exists pg_cron;
create extension if not exists supabase_vault;
SQL

echo ">> 1) globals (roles + role GUCs). Non-fatal if some roles already exist."
psql "$TARGET" -f "$DUMP/00-globals.sql" || echo "   (some globals pre-existed — OK)"

echo ">> 2) schema (public)"
psql "$TARGET" -v ON_ERROR_STOP=1 -f "$DUMP/01-schema.sql"

echo ">> 3) data (public) — this is the big one (~5 GB); grab a coffee"
psql "$TARGET" -v ON_ERROR_STOP=1 -f "$DUMP/02-data.sql"

echo ">> 4) ANALYZE so the planner has fresh stats before traffic"
psql "$TARGET" -c "vacuum analyze;"

echo ">> Restore complete."
echo "NEXT: psql \"$TARGET\" -f scripts/03-recreate-cron-guc.sql  (GUCs, vault, crons)"
