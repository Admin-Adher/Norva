#!/usr/bin/env bash
# Shared helpers for the self-host backup scripts. Sourced, not executed.
# Loads /etc/norva-backup.env + the stack .env, and configures rclone for R2
# entirely through environment variables (no rclone.conf on disk).

set -euo pipefail

ENV_FILE="${NORVA_BACKUP_ENV:-/etc/norva-backup.env}"
[ -f "$ENV_FILE" ] || { echo "ERROR: $ENV_FILE missing — copy norva-backup.env.example there." >&2; exit 1; }
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

: "${R2_ACCOUNT_ID:?}"; : "${R2_ACCESS_KEY_ID:?}"; : "${R2_SECRET_ACCESS_KEY:?}"; : "${R2_BUCKET:?}"
: "${NORVA_OPS_DIR:?}"; : "${PG_IMAGE:?}"
DB_CONTAINER="${DB_CONTAINER:-norva-db}"

# Postgres superuser password from the stack .env (root can read it).
POSTGRES_PASSWORD="$(grep -E '^POSTGRES_PASSWORD=' "$NORVA_OPS_DIR/.env" | head -1 | cut -d= -f2-)"
[ -n "$POSTGRES_PASSWORD" ] || { echo "ERROR: POSTGRES_PASSWORD not found in $NORVA_OPS_DIR/.env" >&2; exit 1; }

# rclone remote "r2" via env — nothing persisted.
export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
export RCLONE_CONFIG_R2_ACL=private
export RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true

# Run a client tool from the pinned supabase/postgres image against the local db.
# Usage: pgtool pg_dump --schema-only ...   |   pgtool psql -Atc "..."
pgtool() {
  docker run --rm -i --network host -e PGPASSWORD="$POSTGRES_PASSWORD" "$PG_IMAGE" \
    "$@"
}

log() { echo "[$(date -u +%FT%TZ)] $*"; }
