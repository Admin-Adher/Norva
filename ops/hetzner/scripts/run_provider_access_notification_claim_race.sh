#!/usr/bin/env bash
set -euo pipefail

DB_CONTAINER="${DB_CONTAINER:-}"
case "$DB_CONTAINER" in
  norva-phase3-proof-*-db) ;;
  *) echo "refusing non-proof database container: ${DB_CONTAINER:-unset}" >&2; exit 64 ;;
esac

readonly USER_ID='98700000-0000-4000-8000-000000000001'
readonly SOURCE_ID='98700000-0000-4000-8000-000000000101'
readonly CYCLE_ID='98700000-0000-4000-8000-000000000201'
readonly WORK_DIR="$(mktemp -d /tmp/norva-provider-notify-race.XXXXXX)"

psql_admin() {
  docker exec -i "$DB_CONTAINER" psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 "$@"
}

cleanup() {
  psql_admin >/dev/null <<SQL
begin;
delete from public.cloud_provider_access_notifications where user_id = '$USER_ID';
delete from public.cloud_source_lifecycle_events where user_id = '$USER_ID';
update public.cloud_source_provider_access
set provider_access_reminders_enabled = false
where user_id = '$USER_ID' and source_id = '$SOURCE_ID';
update public.admin_feature_flags set enabled = false
where key in (
  'provider_access_notifications_v1_enabled',
  'provider_access_email_v1_enabled',
  'provider_access_push_v1_enabled',
  'provider_access_in_app_v1_enabled'
);
commit;
SQL
  rm -rf -- "$WORK_DIR"
}
trap cleanup EXIT

psql_admin <<SQL
begin;
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '$USER_ID', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'notify-race-987@invalid.test', '', now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
) on conflict (id) do nothing;
insert into public.cloud_sources (
  id, user_id, source_type, display_name, config_ciphertext, config_hint,
  sync_status, catalog_version
) values (
  '$SOURCE_ID', '$USER_ID', 'xtream', 'Notification race 987',
  'fixture-ciphertext', '{"serverHost":"race.invalid"}'::jsonb, 'ready', 1
) on conflict (id) do nothing;
insert into public.cloud_source_access_cycles (
  id, user_id, source_id, started_on, expires_on, origin, status,
  idempotency_key, request_fingerprint
) values (
  '$CYCLE_ID', '$USER_ID', '$SOURCE_ID', current_date, current_date,
  'user_entered', 'active', 'notify-race-cycle-987', repeat('7', 64)
) on conflict (id) do update
set started_on = excluded.started_on, expires_on = excluded.expires_on,
    status = 'active', updated_at = now();
delete from public.cloud_provider_access_notifications where user_id = '$USER_ID';
update public.cloud_source_provider_access
set provider_access_reminders_enabled = true
where user_id = '$USER_ID' and source_id = '$SOURCE_ID';
update public.admin_feature_flags set enabled = true
where key in (
  'provider_access_notifications_v1_enabled',
  'provider_access_email_v1_enabled'
);
select public.norva_enqueue_provider_access_notification_set(
  '$USER_ID', '$SOURCE_ID', '$CYCLE_ID', 'expiry_today', now() - interval '1 minute'
);
commit;
SQL

claim_sql() {
  local worker="$1"
  local hold_seconds="$2"
  cat <<SQL
begin;
set local request.jwt.claims = '{"role":"service_role"}';
set local role service_role;
select count(*) from public.norva_claim_provider_access_notifications(
  'email', '$worker', 1, 90, 12
);
select pg_sleep($hold_seconds);
commit;
SQL
}

claim_sql 'notify-race-a' 3 | psql_admin -Atq >"$WORK_DIR/a.out" &
readonly PID_A=$!
sleep 0.5
claim_sql 'notify-race-b' 0 | psql_admin -Atq >"$WORK_DIR/b.out" &
readonly PID_B=$!
wait "$PID_A"
wait "$PID_B"

readonly A_COUNT="$(grep -E '^[01]$' "$WORK_DIR/a.out" | head -n1)"
readonly B_COUNT="$(grep -E '^[01]$' "$WORK_DIR/b.out" | head -n1)"
if [[ -z "$A_COUNT" || -z "$B_COUNT" || $((A_COUNT + B_COUNT)) -ne 1 ]]; then
  echo "FAIL claim race: A=${A_COUNT:-missing} B=${B_COUNT:-missing}" >&2
  exit 1
fi

readonly STATE="$(psql_admin -Atq <<SQL
select state || ':' || lease_owner || ':' || lease_sequence
from public.cloud_provider_access_notifications
where access_cycle_id = '$CYCLE_ID' and event_kind = 'expiry_today' and channel = 'email';
SQL
)"
if [[ "$STATE" != processing:*:1 ]]; then
  echo "FAIL unexpected winner state: $STATE" >&2
  exit 1
fi

printf 'PASS provider access notification claim race\n'
printf 'session_a_claimed=%s\n' "$A_COUNT"
printf 'session_b_claimed=%s\n' "$B_COUNT"
printf 'winner_state=%s\n' "$STATE"
