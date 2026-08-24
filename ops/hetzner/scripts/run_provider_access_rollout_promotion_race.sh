#!/usr/bin/env bash
set -euo pipefail

DB_CONTAINER="${DB_CONTAINER:-}"
case "$DB_CONTAINER" in
  norva-phase3-proof-*-db) ;;
  *) echo "refusing non-proof database container: ${DB_CONTAINER:-unset}" >&2; exit 64 ;;
esac

readonly USER_ID='98610000-0000-4000-8000-000000000001'
readonly WORK_DIR="$(mktemp -d /tmp/norva-provider-rollout-race.XXXXXX)"

psql_admin() {
  docker exec -i "$DB_CONTAINER" psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 "$@"
}

cleanup() {
  psql_admin >/dev/null <<SQL
begin;
update public.admin_feature_flags set enabled=false,updated_at=now(),updated_by='proof-cleanup'
where key in (
  'provider_access_v1_enabled','provider_access_auto_detection_v1_enabled',
  'provider_access_notifications_v1_enabled','provider_access_email_v1_enabled',
  'provider_access_push_v1_enabled','provider_access_in_app_v1_enabled',
  'provider_access_visibility_v1_enabled','provider_credential_transition_v1_enabled',
  'provider_replacement_v1_enabled'
);
delete from public.cloud_provider_access_rollout_events;
delete from public.cloud_provider_access_rollout_channel_events;
delete from public.cloud_provider_access_rollout_internal_users where user_id='$USER_ID';
update public.cloud_provider_access_rollout set
  revision=1,stage='off',cohort_basis_points=0,
  legal_policy_reference=null,legal_policy_approved_at=null,
  operational_reference=null,operational_approved_at=null,
  last_approval_note=null,updated_at=now(),updated_by='proof-cleanup'
where singleton;
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
  'rollout-race@invalid.test','',now(),'{}','{}',now(),now()
) on conflict (id) do nothing;
update public.cloud_provider_access_foundation_rollout
set phase='complete',completed_at=coalesce(completed_at,now()),updated_at=now() where singleton;
update public.cloud_source_provider_account_affinity_rollout
set phase='complete',completed_at=coalesce(completed_at,now()),updated_at=now() where singleton;
alter table public.provider_account_activity validate constraint provider_account_activity_opaque_key_ck;
update public.cloud_catalog_cache_epoch_v2_rollout
set installed_at=installed_at-interval '8 days'
where singleton and phase='installed';
set local role service_role;
select public.norva_complete_catalog_cache_epoch_v2_rollout(
  'catalog-cache-epoch-v2','23c0fa2cdaf09c08d9de4378d1a82f0f631ce71d6f955a0bdbb2c786b8ff98d3'
);
select public.norva_configure_provider_access_rollout_gates(
  1,'legal-policy:race-proof','ops-proof:race-proof','race-proof-service'
);
select public.norva_set_provider_access_rollout_internal_user(
  '$USER_ID',true,'rollout concurrency proof','race-proof-service'
);
select public.norva_register_active_catalog_refresh_worker(
  'phase16-race-worker','credential-transition-worker-v3-active-catalog-refresh',
  'active-catalog-refresh-checkpoint-prune-v1'
);
commit;
SQL

promote_sql() {
  local actor="$1"
  cat <<SQL
begin;
set local role service_role;
select public.norva_set_provider_access_rollout_stage(
  2,'internal','Concurrent promotion proof with one expected winner.','$actor'
);
commit;
SQL
}

set +e
promote_sql 'race-session-a' | psql_admin -Atq >"$WORK_DIR/a.out" 2>"$WORK_DIR/a.err" &
readonly PID_A=$!
promote_sql 'race-session-b' | psql_admin -Atq >"$WORK_DIR/b.out" 2>"$WORK_DIR/b.err" &
readonly PID_B=$!
wait "$PID_A"; readonly EXIT_A=$?
wait "$PID_B"; readonly EXIT_B=$?
set -e

if [[ $(( (EXIT_A == 0) + (EXIT_B == 0) )) -ne 1 ]]; then
  echo "FAIL rollout race exits: A=$EXIT_A B=$EXIT_B" >&2
  exit 1
fi
if ! grep -q 'stale rollout revision' "$WORK_DIR/a.err" "$WORK_DIR/b.err"; then
  echo 'FAIL losing session did not report stale rollout revision' >&2
  exit 1
fi

readonly FINAL="$(psql_admin -Atq <<SQL
select stage || ':' || revision || ':' ||
  (select count(*) from public.cloud_provider_access_rollout_events where stage='internal')
from public.cloud_provider_access_rollout where singleton;
SQL
)"
if [[ "$FINAL" != 'internal:3:1' ]]; then
  echo "FAIL unexpected final rollout state: $FINAL" >&2
  exit 1
fi

channel_sql() {
  local actor="$1"
  cat <<SQL
begin;
set local role service_role;
select public.norva_set_provider_access_rollout_channels(
  3,true,false,false,
  'channel-readiness:concurrent-auto-detection-proof',
  '$actor'
);
commit;
SQL
}

set +e
channel_sql 'channel-race-session-a' | psql_admin -Atq >"$WORK_DIR/channel-a.out" 2>"$WORK_DIR/channel-a.err" &
readonly CHANNEL_PID_A=$!
channel_sql 'channel-race-session-b' | psql_admin -Atq >"$WORK_DIR/channel-b.out" 2>"$WORK_DIR/channel-b.err" &
readonly CHANNEL_PID_B=$!
wait "$CHANNEL_PID_A"; readonly CHANNEL_EXIT_A=$?
wait "$CHANNEL_PID_B"; readonly CHANNEL_EXIT_B=$?
set -e

if [[ $(( (CHANNEL_EXIT_A == 0) + (CHANNEL_EXIT_B == 0) )) -ne 1 ]]; then
  echo "FAIL rollout channel race exits: A=$CHANNEL_EXIT_A B=$CHANNEL_EXIT_B" >&2
  exit 1
fi
if ! grep -q 'stale rollout revision' "$WORK_DIR/channel-a.err" "$WORK_DIR/channel-b.err"; then
  echo 'FAIL losing channel session did not report stale rollout revision' >&2
  exit 1
fi

readonly CHANNEL_FINAL="$(psql_admin -Atq <<SQL
select rollout.stage || ':' || rollout.revision || ':' ||
  (select count(*) from public.cloud_provider_access_rollout_channel_events) || ':' ||
  (select count(*) from public.admin_feature_flags
   where key='provider_access_auto_detection_v1_enabled' and enabled)
from public.cloud_provider_access_rollout rollout where singleton;
SQL
)"
if [[ "$CHANNEL_FINAL" != 'internal:4:1:1' ]]; then
  echo "FAIL unexpected final rollout channel state: $CHANNEL_FINAL" >&2
  exit 1
fi

printf 'PASS provider access rollout promotion race\n'
printf 'session_a_exit=%s\n' "$EXIT_A"
printf 'session_b_exit=%s\n' "$EXIT_B"
printf 'final_state=%s\n' "$FINAL"
printf 'channel_session_a_exit=%s\n' "$CHANNEL_EXIT_A"
printf 'channel_session_b_exit=%s\n' "$CHANNEL_EXIT_B"
printf 'channel_final_state=%s\n' "$CHANNEL_FINAL"
