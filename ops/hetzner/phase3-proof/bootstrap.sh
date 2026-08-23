#!/usr/bin/env bash
set -euo pipefail

readonly HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly ROOT='/var/lib/norva-phase3-proof'
readonly COMPOSE="$HERE/docker-compose.yml"
readonly ENV_FILE="$HERE/.env"
readonly REQUIRED_MIGRATIONS=(
  20260823120000_provider_credential_transition_v1.sql
  20260823174000_provider_direct_fallback_source_lease.sql
  20260823182780_provider_transition_account_delete_schema.sql
  20260823182800_active_catalog_refresh_worker_v3_gate.sql
)

die() { printf 'phase3-proof bootstrap: %s\n' "$*" >&2; exit 1; }
random() { openssl rand -base64 48 | tr -d '\n'; }
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
jwt() {
  local role="$1" header payload signature
  header='{"alg":"HS256","typ":"JWT"}'
  payload="{\"role\":\"${role}\",\"iss\":\"phase3-proof\",\"iat\":$(date +%s),\"exp\":$(( $(date +%s) + 86400 ))}"
  header="$(printf %s "$header" | b64url)"
  payload="$(printf %s "$payload" | b64url)"
  signature="$(printf %s "${header}.${payload}" | openssl dgst -binary -sha256 -hmac "$JWT_SECRET" | b64url)"
  printf '%s.%s.%s' "$header" "$payload" "$signature"
}

[[ "$(id -un)" == 'adrien' ]] || die 'must run as adrien'
cd -- "$HERE"
command -v openssl >/dev/null || die 'openssl is required to generate proof-only secrets'
for migration in "${REQUIRED_MIGRATIONS[@]}"; do
  [[ -f "$HERE/../../../supabase/migrations/$migration" ]] || die "checkout lacks required Phase 3 migration: $migration"
done

if [[ ! -f "$ENV_FILE" ]]; then
  umask 077
  JWT_SECRET="$(random)"
  export JWT_SECRET
  cat > "$ENV_FILE" <<EOF
PHASE3_PROOF_ENV=1
POSTGRES_PASSWORD=$(random)
JWT_SECRET=$JWT_SECRET
ANON_KEY=$(jwt anon)
SERVICE_ROLE_KEY=$(jwt service_role)
REALTIME_DB_ENC_KEY=$(random)
SECRET_KEY_BASE=$(random)
FAKE_GATEWAY_TOKEN=$(random)
PROOF_CRON_SECRET=$(random)
PROOF_BACKFILL_TOKEN=$(random)
EOF
  chmod 600 "$ENV_FILE"
fi

"$HERE/preflight.sh"
install -d -m 700 "$ROOT/db" "$ROOT/wal-archive"
docker compose --project-name norva-phase3-proof --env-file "$ENV_FILE" -f "$COMPOSE" up -d

for _ in $(seq 1 60); do
  if docker compose --project-name norva-phase3-proof --env-file "$ENV_FILE" -f "$COMPOSE" exec -T db pg_isready -U postgres -h localhost >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
docker compose --project-name norva-phase3-proof --env-file "$ENV_FILE" -f "$COMPOSE" exec -T db pg_isready -U postgres -h localhost >/dev/null || die 'database did not become ready'

docker compose --project-name norva-phase3-proof --env-file "$ENV_FILE" -f "$COMPOSE" exec -T \
  -e PGPASSWORD="$(sed -n 's/^POSTGRES_PASSWORD=//p' "$ENV_FILE")" db \
  psql -v ON_ERROR_STOP=1 -h localhost -U supabase_auth_admin -d postgres \
    -f '/workspace/ops/hetzner/phase3-proof/auth-compat.sql' \
  || die 'proof Auth compatibility bootstrap failed'

docker compose --project-name norva-phase3-proof --env-file "$ENV_FILE" -f "$COMPOSE" exec -T db \
  psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
    -f '/workspace/ops/hetzner/phase3-proof/storage-compat.sql' \
  || die 'proof Storage compatibility bootstrap failed'

# Do not feed the migration list through the loop's stdin: docker compose exec
# can inherit and consume that descriptor, silently stopping after the first file.
mapfile -t migrations < <(find "$HERE/../../../supabase/migrations" -maxdepth 1 -type f -name '*.sql' -printf '%f\n' | LC_ALL=C sort)
(( ${#migrations[@]} > 0 )) || die 'no migrations found in the isolated checkout'

for migration in "${migrations[@]}"; do
  docker compose --project-name norva-phase3-proof --env-file "$ENV_FILE" -f "$COMPOSE" exec -T db \
    psql -v ON_ERROR_STOP=1 -U postgres -d postgres -f "/workspace/supabase/migrations/${migration}" \
    || die "migration failed: ${migration}"
done

printf 'phase3-proof bootstrap PASS: synthetic database migrated; no production dump was used\n'
