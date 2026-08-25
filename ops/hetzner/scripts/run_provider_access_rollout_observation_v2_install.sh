#!/usr/bin/env bash
set -euo pipefail

readonly DB_CONTAINER="${DB_CONTAINER:-norva-db}"
readonly MIGRATION_PATH="${MIGRATION_PATH:?MIGRATION_PATH is required}"
readonly EXPECTED_MIGRATION_SHA256="${EXPECTED_MIGRATION_SHA256:?EXPECTED_MIGRATION_SHA256 is required}"
readonly EXPECTED_ROLLOUT_REVISION="${EXPECTED_ROLLOUT_REVISION:?EXPECTED_ROLLOUT_REVISION is required}"
readonly PREDECESSOR_OBSERVATION_ID="${PREDECESSOR_OBSERVATION_ID:?PREDECESSOR_OBSERVATION_ID is required}"
readonly PROOF_ROOT="${PROOF_ROOT:-/var/lib/norva-phase3-proof}"

if [[ "$DB_CONTAINER" != 'norva-db' ]]; then
  echo "refusing unexpected production database container: $DB_CONTAINER" >&2
  exit 64
fi
[[ "$EXPECTED_MIGRATION_SHA256" =~ ^[0-9a-f]{64}$ ]]
[[ "$EXPECTED_ROLLOUT_REVISION" =~ ^[0-9]+$ ]]
[[ "$PREDECESSOR_OBSERVATION_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]
[[ -f "$MIGRATION_PATH" ]]
if [[ "${CONFIRM_PROVIDER_ACCESS_OBSERVATION_V2_INSTALL:-}" != 'INSTALL_PROVIDER_ACCESS_OBSERVATION_V2' ]]; then
  echo 'status=REFUSED_MISSING_EXPLICIT_INSTALL_CONFIRMATION' >&2
  exit 64
fi

readonly ACTUAL_MIGRATION_SHA256="$(sha256sum "$MIGRATION_PATH" | awk '{print $1}')"
if [[ "$ACTUAL_MIGRATION_SHA256" != "$EXPECTED_MIGRATION_SHA256" ]]; then
  echo 'status=REFUSED_MIGRATION_HASH_MISMATCH' >&2
  exit 65
fi

readonly PROOF_DIR="$PROOF_ROOT/provider-observation-v2-${ACTUAL_MIGRATION_SHA256:0:12}"
install -d -m 700 "$PROOF_DIR"

psql_admin() {
  docker exec -i "$DB_CONTAINER" psql -X -U supabase_admin -d postgres \
    -v ON_ERROR_STOP=1 "$@"
}

psql_admin -AtF '|' \
  -v revision="$EXPECTED_ROLLOUT_REVISION" \
  -v predecessor="$PREDECESSOR_OBSERVATION_ID" >"$PROOF_DIR/preinstall-state.tsv" <<'SQL'
select 'rollout', revision, stage, cohort_basis_points
from public.cloud_provider_access_rollout
where singleton and revision = :'revision'::bigint;
select 'predecessor', id, state, threshold_contract,
  (public.norva_provider_access_rollout_observation_metrics(started_at)->>'qualifyingActivity')::bigint
from public.cloud_provider_access_rollout_observations
where id = :'predecessor'::uuid
  and rollout_revision = :'revision'::bigint
  and state = 'collecting'
  and threshold_contract = 'provider-access-rollout-observation:v1';
select 'v2_function_absent', to_regprocedure(
  'public.norva_provider_access_rollout_observation_metrics_v2(timestamp with time zone)'
) is null;
SQL

grep -q "^rollout|${EXPECTED_ROLLOUT_REVISION}|internal|0$" "$PROOF_DIR/preinstall-state.tsv"
grep -q "^predecessor|${PREDECESSOR_OBSERVATION_ID}|collecting|provider-access-rollout-observation:v1|0$" "$PROOF_DIR/preinstall-state.tsv"
grep -q '^v2_function_absent|t$' "$PROOF_DIR/preinstall-state.tsv"

docker exec -i "$DB_CONTAINER" pg_dump -U supabase_admin -d postgres \
  --schema-only --no-owner --no-privileges >"$PROOF_DIR/preinstall-schema.sql"
docker exec -i "$DB_CONTAINER" pg_dump -U supabase_admin -d postgres \
  --data-only --inserts --no-owner --no-privileges \
  -t public.cloud_provider_access_rollout \
  -t public.cloud_provider_access_rollout_observations \
  -t public.cloud_provider_access_rollout_internal_users \
  >"$PROOF_DIR/preinstall-control-data.sql"

psql_admin <"$MIGRATION_PATH" >"$PROOF_DIR/install.log" 2>&1

psql_admin -AtF '|' \
  -v revision="$EXPECTED_ROLLOUT_REVISION" \
  -v predecessor="$PREDECESSOR_OBSERVATION_ID" >"$PROOF_DIR/postinstall-state.tsv" <<'SQL'
select 'rollout', revision, stage, cohort_basis_points
from public.cloud_provider_access_rollout where singleton;
select 'predecessor', id, state, threshold_contract,
  activity_started_at = started_at,
  (public.norva_provider_access_rollout_observation_metrics(activity_started_at)->>'qualifyingActivity')::bigint,
  (public.norva_provider_access_rollout_observation_metrics_v2(activity_started_at)->>'qualifyingActivity')::bigint,
  (public.norva_provider_access_rollout_observation_metrics_v2(activity_started_at)->>'accessCycleStarted')::bigint
from public.cloud_provider_access_rollout_observations
where id = :'predecessor'::uuid;
select 'v2_function_present', to_regprocedure(
  'public.norva_provider_access_rollout_observation_metrics_v2(timestamp with time zone)'
) is not null;
select 'v2_restart_present', to_regprocedure(
  'public.norva_restart_provider_access_rollout_observation_v2(uuid,bigint,text)'
) is not null;
SQL

grep -q "^rollout|${EXPECTED_ROLLOUT_REVISION}|internal|0$" "$PROOF_DIR/postinstall-state.tsv"
grep -q "^predecessor|${PREDECESSOR_OBSERVATION_ID}|collecting|provider-access-rollout-observation:v1|t|0|1|1$" "$PROOF_DIR/postinstall-state.tsv"
grep -q '^v2_function_present|t$' "$PROOF_DIR/postinstall-state.tsv"
grep -q '^v2_restart_present|t$' "$PROOF_DIR/postinstall-state.tsv"

install -m 600 "$MIGRATION_PATH" "$PROOF_DIR/$(basename "$MIGRATION_PATH")"
sha256sum "$PROOF_DIR"/* >"$PROOF_DIR/SHA256SUMS"
printf 'proof_dir=%s\nmigration_sha256=%s\nstatus=INSTALLED_FAIL_CLOSED\n' \
  "$PROOF_DIR" "$ACTUAL_MIGRATION_SHA256"
