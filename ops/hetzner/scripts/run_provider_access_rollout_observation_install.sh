#!/usr/bin/env bash
set -Eeuo pipefail

readonly WORKSPACE="${WORKSPACE:-}"
readonly EXPECTED_COMMIT="${EXPECTED_COMMIT:-}"
readonly REPORT_DIR="${REPORT_DIR:-}"
readonly DB_CONTAINER="${DB_CONTAINER:-norva-db}"
readonly OBSERVATION_MIGRATION='20260825012308_provider_access_rollout_observation_gate_v1.sql'
readonly ANALYTICS_MIGRATION='20260825012611_provider_access_analytics_delivered_state_fix_v1.sql'

fail() {
  printf 'PROVIDER_ACCESS_OBSERVATION_INSTALL_FAIL %s\n' "$*" >&2
  exit 1
}

test -n "$WORKSPACE" || fail 'WORKSPACE is required'
test -n "$EXPECTED_COMMIT" || fail 'EXPECTED_COMMIT is required'
test -n "$REPORT_DIR" || fail 'REPORT_DIR is required'
case "$WORKSPACE" in
  /home/adrien/norva-deployments/provider-observation-*) ;;
  *) fail 'unexpected workspace' ;;
esac
case "$REPORT_DIR" in
  /var/lib/norva-phase3-proof/provider-observation-production-*) ;;
  *) fail 'unexpected report directory' ;;
esac
test "$DB_CONTAINER" = 'norva-db' || fail 'unexpected database container'
test -d "$REPORT_DIR" || fail 'report directory is missing'
test ! -e "$REPORT_DIR/INSTALL_COMPLETE" || fail 'install already completed'
test "${CONFIRM_PROVIDER_ACCESS_OBSERVATION_INSTALL:-}" = \
  'INSTALL_PROVIDER_ACCESS_OBSERVATION_GATE_DORMANT' \
  || fail 'explicit dormant-install confirmation is missing'

exec 9>"$REPORT_DIR/install.lock"
flock -n 9 || fail 'another observation install owns the lock'
exec > >(tee -a "$REPORT_DIR/install.log") 2>&1

test "$(git -C "$WORKSPACE" rev-parse HEAD)" = "$EXPECTED_COMMIT" \
  || fail 'workspace commit mismatch'
test -z "$(git -C "$WORKSPACE" status --porcelain --untracked-files=all)" \
  || fail 'workspace is dirty'
git -C "$WORKSPACE" cat-file -e "${EXPECTED_COMMIT}^{commit}"
test "$(docker inspect -f '{{.State.Running}}' "$DB_CONTAINER")" = true \
  || fail 'database is not running'
test "$(docker inspect -f '{{.Config.Image}}' "$DB_CONTAINER")" = 'supabase/postgres:17.6.1.136' \
  || fail 'database image mismatch'
test "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Source}}{{end}}{{end}}' "$DB_CONTAINER")" = '/var/lib/norva/db' \
  || fail 'database mount mismatch'

for migration in "$OBSERVATION_MIGRATION" "$ANALYTICS_MIGRATION"; do
  test -f "$WORKSPACE/supabase/migrations/$migration" \
    || fail "missing migration $migration"
done
test -f "$WORKSPACE/ops/hetzner/scripts/run_provider_access_rollout_gate.sh" \
  || fail 'rollout operator gate is missing'

psql_admin() {
  docker exec -i "$DB_CONTAINER" psql -X -U supabase_admin -d postgres \
    -v ON_ERROR_STOP=1 "$@"
}

capture_state() {
  psql_admin -AtF $'\t' <<'SQL'
select 'rollout',stage,revision,cohort_basis_points
from public.cloud_provider_access_rollout where singleton;
select 'cache',phase,completed_at is not null
from public.cloud_catalog_cache_epoch_v2_rollout where singleton;
select 'flags',count(*),count(*) filter(where enabled)
from public.admin_feature_flags where key in (
  'provider_access_v1_enabled','provider_access_auto_detection_v1_enabled',
  'provider_access_notifications_v1_enabled','provider_access_email_v1_enabled',
  'provider_access_push_v1_enabled','provider_access_in_app_v1_enabled',
  'provider_access_visibility_v1_enabled','provider_credential_transition_v1_enabled',
  'provider_replacement_v1_enabled'
);
select 'internal_users',count(*)
from public.cloud_provider_access_rollout_internal_users;
select 'provider_crons',count(*)
from cron.job where jobname in (
  'norva-provider-access-notifications','norva-provider-access-checks'
);
select 'p0_safe',(public.norva_assert_provider_access_rollout_safe()->>'safe')::boolean;
select 'notification_cron_v1',
  to_regprocedure('public.norva_install_provider_access_notification_cron()') is not null;
select 'observation_gate_v1',
  to_regprocedure('public.norva_start_provider_access_rollout_observation(bigint,text)') is not null;
select 'legal_reference',coalesce(legal_policy_reference,'NULL')
from public.cloud_provider_access_rollout where singleton;
select 'operational_reference',coalesce(operational_reference,'NULL')
from public.cloud_provider_access_rollout where singleton;
SQL
}

capture_state >"$REPORT_DIR/preinstall-state.tsv"
grep -qx $'rollout\toff\t2\t0' "$REPORT_DIR/preinstall-state.tsv" \
  || fail 'rollout is not the approved OFF revision 2 boundary'
grep -qx $'cache\tinstalled\tf' "$REPORT_DIR/preinstall-state.tsv" \
  || fail 'cache epoch is not at the expected pre-completion boundary'
grep -qx $'flags\t9\t0' "$REPORT_DIR/preinstall-state.tsv" \
  || fail 'Provider Access flags are not all OFF'
grep -qx $'internal_users\t1' "$REPORT_DIR/preinstall-state.tsv" \
  || fail 'internal canary allowlist is not exactly one user'
grep -qx $'provider_crons\t0' "$REPORT_DIR/preinstall-state.tsv" \
  || fail 'Provider Access cron already exists'
grep -qx $'p0_safe\tt' "$REPORT_DIR/preinstall-state.tsv" \
  || fail 'production is not P0-safe'
grep -qx $'notification_cron_v1\tt' "$REPORT_DIR/preinstall-state.tsv" \
  || fail 'notification cron v1 boundary is missing'
grep -qx $'observation_gate_v1\tf' "$REPORT_DIR/preinstall-state.tsv" \
  || fail 'observation gate is already installed or boundary is ambiguous'
grep -Eq $'^legal_reference\t.{12,}$' "$REPORT_DIR/preinstall-state.tsv" \
  || fail 'legal rollout reference is missing'
grep -Eq $'^operational_reference\t.{12,}$' "$REPORT_DIR/preinstall-state.tsv" \
  || fail 'operational rollout reference is missing'

umask 077
docker exec "$DB_CONTAINER" pg_dump -U supabase_admin -d postgres \
  -Fc --schema-only >"$REPORT_DIR/preinstall-schema.dump"
docker exec "$DB_CONTAINER" pg_dump -U supabase_admin -d postgres \
  -Fc --data-only \
  -t public.cloud_provider_access_rollout \
  -t public.cloud_provider_access_rollout_internal_users \
  -t public.cloud_provider_access_rollout_events \
  -t public.cloud_provider_access_rollout_channel_events \
  -t public.admin_feature_flags \
  -t public.cloud_catalog_cache_epoch_v2_rollout \
  >"$REPORT_DIR/preinstall-control-data.dump"
chmod 600 "$REPORT_DIR/preinstall-schema.dump" "$REPORT_DIR/preinstall-control-data.dump"
test -s "$REPORT_DIR/preinstall-schema.dump" || fail 'schema backup is empty'
test -s "$REPORT_DIR/preinstall-control-data.dump" || fail 'control-data backup is empty'
sha256sum "$REPORT_DIR/preinstall-schema.dump" \
  "$REPORT_DIR/preinstall-control-data.dump" \
  "$REPORT_DIR/preinstall-state.tsv" >"$REPORT_DIR/preinstall-artifacts.sha256"

for migration in "$OBSERVATION_MIGRATION" "$ANALYTICS_MIGRATION"; do
  printf 'APPLY %s %s\n' "$(date -u +%FT%TZ)" "$migration"
  docker exec -i "$DB_CONTAINER" psql -X -U supabase_admin -d postgres \
    -v ON_ERROR_STOP=1 <"$WORKSPACE/supabase/migrations/$migration"
done

capture_state >"$REPORT_DIR/postinstall-state.tsv"
diff -u \
  <(grep -v '^observation_gate_v1' "$REPORT_DIR/preinstall-state.tsv") \
  <(grep -v '^observation_gate_v1' "$REPORT_DIR/postinstall-state.tsv") \
  >"$REPORT_DIR/control-state.diff" \
  || fail 'installation changed rollout, cache, flag, cron or approval state'
grep -qx $'observation_gate_v1\tt' "$REPORT_DIR/postinstall-state.tsv" \
  || fail 'observation gate is missing after installation'

psql_admin -AtF $'\t' <<'SQL' >"$REPORT_DIR/postinstall-contract.tsv"
select 'observation_rows',count(*)
from public.cloud_provider_access_rollout_observations;
select 'service_rollout_write',
  has_table_privilege('service_role','public.cloud_provider_access_rollout','INSERT')
  or has_table_privilege('service_role','public.cloud_provider_access_rollout','UPDATE')
  or has_table_privilege('service_role','public.cloud_provider_access_rollout','DELETE');
select 'service_observation_write',
  has_table_privilege('service_role','public.cloud_provider_access_rollout_observations','INSERT')
  or has_table_privilege('service_role','public.cloud_provider_access_rollout_observations','UPDATE')
  or has_table_privilege('service_role','public.cloud_provider_access_rollout_observations','DELETE');
select 'service_observation_read',
  has_table_privilege('service_role','public.cloud_provider_access_rollout_observations','SELECT');
select 'browser_start_execute',
  has_function_privilege('anon','public.norva_start_provider_access_rollout_observation(bigint,text)','EXECUTE')
  or has_function_privilege('authenticated','public.norva_start_provider_access_rollout_observation(bigint,text)','EXECUTE');
select 'analytics_delivered',position(
  'notification.state = ''delivered''' in pg_get_functiondef(
    'public.norva_provider_access_analytics_dashboard(integer)'::regprocedure
  )
) > 0;
select 'analytics_legacy_completed',position(
  'notification.state = ''completed''' in pg_get_functiondef(
    'public.norva_provider_access_analytics_dashboard(integer)'::regprocedure
  )
) > 0;
SQL
grep -qx $'observation_rows\t0' "$REPORT_DIR/postinstall-contract.tsv" \
  || fail 'installation forged an observation row'
grep -qx $'service_rollout_write\tf' "$REPORT_DIR/postinstall-contract.tsv" \
  || fail 'service role retains direct rollout DML'
grep -qx $'service_observation_write\tf' "$REPORT_DIR/postinstall-contract.tsv" \
  || fail 'service role can forge observation evidence'
grep -qx $'service_observation_read\tt' "$REPORT_DIR/postinstall-contract.tsv" \
  || fail 'service role cannot inspect observation status'
grep -qx $'browser_start_execute\tf' "$REPORT_DIR/postinstall-contract.tsv" \
  || fail 'browser role can start an observation'
grep -qx $'analytics_delivered\tt' "$REPORT_DIR/postinstall-contract.tsv" \
  || fail 'analytics do not count delivered notifications'
grep -qx $'analytics_legacy_completed\tf' "$REPORT_DIR/postinstall-contract.tsv" \
  || fail 'analytics still query the impossible completed state'

set +e
psql_admin >"$REPORT_DIR/direct-service-dml-refusal.log" 2>&1 <<'SQL'
begin;
set local role service_role;
update public.cloud_provider_access_rollout
set updated_at=clock_timestamp()
where singleton;
rollback;
SQL
readonly DIRECT_DML_EXIT=$?
set -e
test "$DIRECT_DML_EXIT" -ne 0 || fail 'direct service-role DML unexpectedly succeeded'
grep -q 'permission denied for table cloud_provider_access_rollout' \
  "$REPORT_DIR/direct-service-dml-refusal.log" \
  || fail 'direct DML refusal was not the expected privilege fence'

DB_CONTAINER="$DB_CONTAINER" \
  "$WORKSPACE/ops/hetzner/scripts/run_provider_access_rollout_gate.sh" observation-status \
  >"$REPORT_DIR/observation-status.txt"
grep -qx 'observation=NONE' "$REPORT_DIR/observation-status.txt" \
  || fail 'production observation status is not empty after installation'

sha256sum "$REPORT_DIR"/*.tsv "$REPORT_DIR"/*.txt "$REPORT_DIR"/*.log \
  >"$REPORT_DIR/postinstall-artifacts.sha256"
{
  printf 'completed_utc=%s\n' "$(date -u +%FT%TZ)"
  printf 'commit=%s\n' "$EXPECTED_COMMIT"
  printf 'observation_migration=%s\n' "$OBSERVATION_MIGRATION"
  printf 'analytics_migration=%s\n' "$ANALYTICS_MIGRATION"
  printf 'status=INSTALLED_DORMANT\n'
} >"$REPORT_DIR/INSTALL_COMPLETE"
chmod 600 "$REPORT_DIR/INSTALL_COMPLETE"
printf 'PROVIDER_ACCESS_OBSERVATION_INSTALL_PASS commit=%s\n' "$EXPECTED_COMMIT"
