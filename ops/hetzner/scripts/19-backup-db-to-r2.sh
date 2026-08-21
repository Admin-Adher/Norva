#!/usr/bin/env bash
# Dump the local Hetzner Postgres and upload an age-encrypted archive to R2.
# Intended for cron / GitHub SSH. Never prints secret values.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
ENV_FILE="$ROOT/ops/hetzner/.env"
: "${R2_ACCOUNT_ID:?Set R2_ACCOUNT_ID}"
: "${R2_ACCESS_KEY_ID:?Set R2_ACCESS_KEY_ID}"
: "${R2_SECRET_ACCESS_KEY:?Set R2_SECRET_ACCESS_KEY}"
: "${R2_BUCKET:?Set R2_BUCKET}"
: "${BACKUP_AGE_RECIPIENT:?Set BACKUP_AGE_RECIPIENT}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: missing $ENV_FILE" >&2
  exit 1
fi
POSTGRES_PASSWORD="$(grep -E '^POSTGRES_PASSWORD=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD missing from hetzner .env}"

mkdir -p /tmp/norva-pg-bin
cat > /tmp/norva-pg-bin/pg_dump << 'EOF'
#!/bin/bash
exec docker exec -i norva-db pg_dump "$@"
EOF
cat > /tmp/norva-pg-bin/pg_dumpall << 'EOF'
#!/bin/bash
exec docker exec -i norva-db pg_dumpall "$@"
EOF
cat > /tmp/norva-pg-bin/psql << 'EOF'
#!/bin/bash
exec docker exec -i norva-db psql "$@"
EOF
chmod +x /tmp/norva-pg-bin/pg_dump /tmp/norva-pg-bin/pg_dumpall /tmp/norva-pg-bin/psql

cat > /tmp/openssl-tls12.cnf << 'EOF'
openssl_conf = default_conf
[default_conf]
ssl_conf = ssl_sect
[ssl_sect]
system_default = system_default_sect
[system_default_sect]
MinProtocol = TLSv1.2
MaxProtocol = TLSv1.2
EOF

export PATH="/tmp/norva-pg-bin:/usr/local/bin:$PATH"
export OPENSSL_CONF=/tmp/openssl-tls12.cnf
export PG_DUMP=/tmp/norva-pg-bin/pg_dump
export PG_DUMPALL=/tmp/norva-pg-bin/pg_dumpall
export SUPABASE_DB_URL="postgresql://postgres:${POSTGRES_PASSWORD}@127.0.0.1:5432/postgres"
export BACKUP_ENCRYPTION_REQUIRED=true
export R2_PREFIX="${R2_PREFIX:-db}"
export AWS_EC2_METADATA_DISABLED=true

cd "$ROOT"
bash ops/backup/backup-to-r2.sh
