#!/usr/bin/env bash
set -euo pipefail
readonly HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly COMPOSE="$HERE/docker-compose.yml"
readonly ENV_FILE="$HERE/.env"
readonly TESTS=(
  provider_credential_transition.sql
  catalog_background_owner_snapshot_concurrency_smoke.sql
  provider_account_delete_concurrency_smoke.sql
  account_deletion_transport_stop_concurrency_smoke.sql
  account_deletion_legal_billing_retention_smoke.sql
)

cd -- "$HERE"
[[ -f "$ENV_FILE" ]] || { printf 'run bootstrap.sh first\n' >&2; exit 1; }
PHASE3_PROOF_ALLOW_EXISTS=1 "$HERE/preflight.sh"
for test_file in "${TESTS[@]}"; do
  [[ -f "$HERE/../../../supabase/tests/$test_file" ]] || {
    printf 'phase3-proof proof refused: missing test %s\n' "$test_file" >&2; exit 1;
  }
done
for test_file in "${TESTS[@]}"; do
  docker compose --project-name norva-phase3-proof --env-file "$ENV_FILE" -f "$COMPOSE" exec -T db \
    psql -v ON_ERROR_STOP=1 -U postgres -d postgres -f "/workspace/supabase/tests/${test_file}"
done
printf 'phase3-proof SQL proof PASS\n'
