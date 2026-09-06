#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
readonly READINESS_SQL="$REPO_ROOT/ops/hetzner/tests/behavioral_lifecycle_pre_activation_readiness.sql"
readonly MIGRATION_SQL="$REPO_ROOT/supabase/migrations/20260903180000_behavioral_lifecycle_engine_v1.sql"
readonly HARDENING_MIGRATION_SQL="$REPO_ROOT/supabase/migrations/20260904090000_behavioral_lifecycle_import_readiness_append_only.sql"
readonly CONDITIONAL_EMAIL_MIGRATION_SQL="$REPO_ROOT/supabase/migrations/20260906125303_no_source_conditional_email_postal.sql"
readonly EXPECTED_MIGRATION_SHA256='718b1e629b08489b30b56cdf9da563f728f000679f4705153f4e2adc38c963b9'
readonly EXPECTED_HARDENING_MIGRATION_SHA256='da7f946456dd7bf2af3c9dfc502136669bab3305cb7ccfe8fdb07a711b04403b'
readonly EXPECTED_CONDITIONAL_EMAIL_MIGRATION_SHA256='97909019e85a8352ed05563b97d043d3c35c9e21af38e058abc420c640fe7cf5'

[[ -f "$READINESS_SQL" ]] || {
  echo 'behavioral lifecycle readiness SQL is missing' >&2
  exit 66
}
[[ -f "$MIGRATION_SQL" ]] || {
  echo 'behavioral lifecycle migration is missing' >&2
  exit 66
}
[[ -f "$HARDENING_MIGRATION_SQL" ]] || {
  echo 'behavioral lifecycle hardening migration is missing' >&2
  exit 66
}
[[ -f "$CONDITIONAL_EMAIL_MIGRATION_SQL" ]] || {
  echo 'behavioral lifecycle conditional email migration is missing' >&2
  exit 66
}

readonly ACTUAL_MIGRATION_SHA256="$(tr -d '\r' < "$MIGRATION_SQL" | sha256sum | awk '{print $1}')"
if [[ "$ACTUAL_MIGRATION_SHA256" != "$EXPECTED_MIGRATION_SHA256" ]]; then
  echo 'behavioral lifecycle migration digest does not match the reviewed readiness gate' >&2
  exit 70
fi
readonly ACTUAL_HARDENING_MIGRATION_SHA256="$(tr -d '\r' < "$HARDENING_MIGRATION_SQL" | sha256sum | awk '{print $1}')"
if [[ "$ACTUAL_HARDENING_MIGRATION_SHA256" != "$EXPECTED_HARDENING_MIGRATION_SHA256" ]]; then
  echo 'behavioral lifecycle hardening migration digest does not match the reviewed readiness gate' >&2
  exit 70
fi
readonly ACTUAL_CONDITIONAL_EMAIL_MIGRATION_SHA256="$(tr -d '\r' < "$CONDITIONAL_EMAIL_MIGRATION_SQL" | sha256sum | awk '{print $1}')"
if [[ "$ACTUAL_CONDITIONAL_EMAIL_MIGRATION_SHA256" != "$EXPECTED_CONDITIONAL_EMAIL_MIGRATION_SHA256" ]]; then
  echo 'behavioral lifecycle conditional email migration digest does not match the reviewed readiness gate' >&2
  exit 70
fi

run_direct() {
  PGOPTIONS="${PGOPTIONS:+$PGOPTIONS }-c default_transaction_read_only=on" \
    psql -X -v ON_ERROR_STOP=1 -f "$READINESS_SQL"
}

run_container() {
  local container="${DB_CONTAINER:-norva-db}"
  local user="${DB_USER:-supabase_admin}"
  local database="${DB_NAME:-postgres}"
  command -v docker >/dev/null 2>&1 || {
    echo 'docker is required when PGDATABASE is not set' >&2
    exit 69
  }
  docker inspect "$container" >/dev/null 2>&1 || {
    echo 'configured database container is unavailable' >&2
    exit 69
  }
  docker exec -e PGOPTIONS='-c default_transaction_read_only=on' -i "$container" \
    psql -X -U "$user" -d "$database" -v ON_ERROR_STOP=1 < "$READINESS_SQL"
}

echo '>> Behavioral lifecycle pre-activation gate (read-only)'
if [[ -n "${PGDATABASE:-}" ]]; then
  run_direct
else
  run_container
fi
