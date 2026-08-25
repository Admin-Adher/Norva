#!/usr/bin/env bash
set -euo pipefail

readonly DB_CONTAINER="${DB_CONTAINER:-}"
case "$DB_CONTAINER" in
  norva-phase3-proof-*-db) ;;
  *) echo "refusing non-proof database container: ${DB_CONTAINER:-unset}" >&2; exit 64 ;;
esac

readonly USER_ID='98620000-0000-4000-8000-000000000001'
readonly SOURCE_ID='98620000-0000-4000-8000-000000000101'
readonly WORK_DIR="$(mktemp -d /tmp/norva-provider-observation-race.XXXXXX)"

psql_admin() {
  docker exec -i "$DB_CONTAINER" psql -X -U supabase_admin -d postgres \
    -v ON_ERROR_STOP=1 "$@"
}

cleanup() {
  psql_admin >/dev/null <<SQL
begin;
update public.admin_feature_flags
set enabled=false,updated_at=clock_timestamp(),updated_by='observation-race-cleanup'
where key in (
  'provider_access_v1_enabled','provider_access_auto_detection_v1_enabled',
  'provider_access_notifications_v1_enabled','provider_access_email_v1_enabled',
  'provider_access_push_v1_enabled','provider_access_in_app_v1_enabled',
  'provider_access_visibility_v1_enabled','provider_credential_transition_v1_enabled',
  'provider_replacement_v1_enabled'
);
update public.cloud_provider_access_rollout
set revision=1,stage='off',cohort_basis_points=0,
    legal_policy_reference=null,legal_policy_approved_at=null,
    operational_reference=null,operational_approved_at=null,
    last_approval_note=null,updated_at=clock_timestamp(),updated_by='observation-race-cleanup'
where singleton;
delete from public.cloud_provider_access_rollout_channel_events;
delete from public.cloud_provider_access_rollout_events;
delete from public.cloud_provider_access_rollout_observations;
delete from public.cloud_provider_access_rollout_internal_users where user_id='$USER_ID';
set local session_replication_role=replica;
delete from public.cloud_source_lifecycle_events where user_id='$USER_ID';
delete from public.cloud_source_provider_access where source_id='$SOURCE_ID' and user_id='$USER_ID';
delete from public.cloud_source_lifecycle where source_id='$SOURCE_ID' and user_id='$USER_ID';
delete from public.cloud_sources where id='$SOURCE_ID' and user_id='$USER_ID';
delete from public.cloud_user_catalog_visibility_epochs where user_id='$USER_ID';
delete from auth.users where id='$USER_ID';
set local session_replication_role=origin;
commit;
SQL
  rm -rf -- "$WORK_DIR"
}
trap cleanup EXIT

psql_admin <<SQL
begin;
insert into auth.users(
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) values (
  '$USER_ID','00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  'rollout-observation-race@invalid.test','',now(),'{}','{}',now(),now()
) on conflict (id) do nothing;
insert into public.cloud_sources(
  id,user_id,source_type,display_name,config_ciphertext,config_hint,sync_status,catalog_version
) values (
  '$SOURCE_ID','$USER_ID','xtream','Observation race','fixture','{}','ready',1
) on conflict (id) do nothing;
update public.cloud_provider_access_foundation_rollout
set phase='complete',completed_at=coalesce(completed_at,now()),updated_at=now()
where singleton;
update public.cloud_source_provider_account_affinity_rollout
set phase='complete',completed_at=coalesce(completed_at,now()),updated_at=now()
where singleton;
alter table public.provider_account_activity
  validate constraint provider_account_activity_opaque_key_ck;
update public.cloud_catalog_cache_epoch_v2_rollout
set installed_at=installed_at-interval '8 days'
where singleton and phase='installed';
set local role service_role;
select public.norva_complete_catalog_cache_epoch_v2_rollout(
  'catalog-cache-epoch-v2',
  '23c0fa2cdaf09c08d9de4378d1a82f0f631ce71d6f955a0bdbb2c786b8ff98d3'
);
select public.norva_configure_provider_access_rollout_gates(
  1,'legal-policy:observation-race','ops-proof:observation-race','observation-race-service'
);
select public.norva_set_provider_access_rollout_internal_user(
  '$USER_ID',true,'rollout observation race member','observation-race-service'
);
select public.norva_register_active_catalog_refresh_worker(
  'phase16-observation-race-worker',
  'credential-transition-worker-v3-active-catalog-refresh',
  'active-catalog-refresh-checkpoint-prune-v1'
);
select public.norva_set_provider_access_rollout_stage(
  2,'internal','Observation race enters the internal cohort.','observation-race-service'
);
commit;
SQL

start_sql() {
  local actor="$1"
  cat <<SQL
begin;
set local role service_role;
select public.norva_start_provider_access_rollout_observation(3,'$actor');
commit;
SQL
}

set +e
start_sql 'observation-start-race-a' | psql_admin -Atq >"$WORK_DIR/start-a.out" 2>"$WORK_DIR/start-a.err" &
readonly START_PID_A=$!
start_sql 'observation-start-race-b' | psql_admin -Atq >"$WORK_DIR/start-b.out" 2>"$WORK_DIR/start-b.err" &
readonly START_PID_B=$!
wait "$START_PID_A"; readonly START_EXIT_A=$?
wait "$START_PID_B"; readonly START_EXIT_B=$?
set -e

if [[ $(( (START_EXIT_A == 0) + (START_EXIT_B == 0) )) -ne 1 ]]; then
  echo "FAIL observation start race exits: A=$START_EXIT_A B=$START_EXIT_B" >&2
  exit 1
fi
if ! grep -q 'rollout observation already collecting' "$WORK_DIR/start-a.err" "$WORK_DIR/start-b.err"; then
  echo 'FAIL observation start loser did not report a stale collecting observation' >&2
  exit 1
fi

readonly OBSERVATION_ID="$(psql_admin -Atq <<SQL
select id from public.cloud_provider_access_rollout_observations
where rollout_revision=3 and state='collecting';
SQL
)"
psql_admin <<SQL
begin;
update public.cloud_provider_access_rollout_observations
set not_before=clock_timestamp()-interval '1 second'
where id='$OBSERVATION_ID';
insert into public.cloud_source_lifecycle_events(
  user_id,source_id,event_kind,idempotency_key,payload,actor,occurred_at
) values (
  '$USER_ID','$SOURCE_ID','provider_access_cycle_updated',
  'observation-race-qualifying-activity','{}','observation-race-service',clock_timestamp()
);
commit;
SQL

complete_sql() {
  local actor="$1"
  cat <<SQL
begin;
set local role service_role;
select public.norva_complete_provider_access_rollout_observation(
  '$OBSERVATION_ID',3,'proof:observation-race-green',
  'Concurrent completion must produce exactly one accepted observation.','$actor'
);
commit;
SQL
}

set +e
complete_sql 'observation-complete-race-a' | psql_admin -Atq >"$WORK_DIR/complete-a.out" 2>"$WORK_DIR/complete-a.err" &
readonly COMPLETE_PID_A=$!
complete_sql 'observation-complete-race-b' | psql_admin -Atq >"$WORK_DIR/complete-b.out" 2>"$WORK_DIR/complete-b.err" &
readonly COMPLETE_PID_B=$!
wait "$COMPLETE_PID_A"; readonly COMPLETE_EXIT_A=$?
wait "$COMPLETE_PID_B"; readonly COMPLETE_EXIT_B=$?
set -e

if [[ $(( (COMPLETE_EXIT_A == 0) + (COMPLETE_EXIT_B == 0) )) -ne 1 ]]; then
  echo "FAIL observation completion race exits: A=$COMPLETE_EXIT_A B=$COMPLETE_EXIT_B" >&2
  exit 1
fi
if ! grep -q 'stale rollout observation' "$WORK_DIR/complete-a.err" "$WORK_DIR/complete-b.err"; then
  echo 'FAIL observation completion loser did not report STALE' >&2
  exit 1
fi

promote_sql() {
  local actor="$1"
  cat <<SQL
begin;
set local role service_role;
select public.norva_set_provider_access_rollout_stage(
  3,'1_percent','Accepted observation authorizes this one promotion.','$actor'
);
commit;
SQL
}

set +e
promote_sql 'observation-promotion-race-a' | psql_admin -Atq >"$WORK_DIR/promote-a.out" 2>"$WORK_DIR/promote-a.err" &
readonly PROMOTE_PID_A=$!
promote_sql 'observation-promotion-race-b' | psql_admin -Atq >"$WORK_DIR/promote-b.out" 2>"$WORK_DIR/promote-b.err" &
readonly PROMOTE_PID_B=$!
wait "$PROMOTE_PID_A"; readonly PROMOTE_EXIT_A=$?
wait "$PROMOTE_PID_B"; readonly PROMOTE_EXIT_B=$?
set -e

if [[ $(( (PROMOTE_EXIT_A == 0) + (PROMOTE_EXIT_B == 0) )) -ne 1 ]]; then
  echo "FAIL observation promotion race exits: A=$PROMOTE_EXIT_A B=$PROMOTE_EXIT_B" >&2
  exit 1
fi
if ! grep -q 'stale rollout revision' "$WORK_DIR/promote-a.err" "$WORK_DIR/promote-b.err"; then
  echo 'FAIL observation promotion loser did not report STALE' >&2
  exit 1
fi

readonly FINAL="$(psql_admin -Atq <<SQL
select rollout.stage || ':' || rollout.revision || ':' ||
  (select count(*) from public.cloud_provider_access_rollout_observations where state='accepted') || ':' ||
  (select count(*) from public.cloud_provider_access_rollout_events where stage='1_percent')
from public.cloud_provider_access_rollout rollout where singleton;
SQL
)"
if [[ "$FINAL" != '1_percent:4:1:1' ]]; then
  echo "FAIL unexpected observation race final state: $FINAL" >&2
  exit 1
fi

printf 'PASS provider access rollout observation race\n'
printf 'start_a_exit=%s\nstart_b_exit=%s\n' "$START_EXIT_A" "$START_EXIT_B"
printf 'complete_a_exit=%s\ncomplete_b_exit=%s\n' "$COMPLETE_EXIT_A" "$COMPLETE_EXIT_B"
printf 'promote_a_exit=%s\npromote_b_exit=%s\n' "$PROMOTE_EXIT_A" "$PROMOTE_EXIT_B"
printf 'final_state=%s\n' "$FINAL"
