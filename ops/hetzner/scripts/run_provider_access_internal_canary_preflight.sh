#!/usr/bin/env bash
set -euo pipefail

readonly DB_CONTAINER="${DB_CONTAINER:-norva-db}"

if [[ "$DB_CONTAINER" != 'norva-db' ]]; then
  echo "refusing unexpected production database container: $DB_CONTAINER" >&2
  exit 64
fi

psql_admin() {
  docker exec -i "$DB_CONTAINER" psql -X -U supabase_admin -d postgres \
    -v ON_ERROR_STOP=1 "$@"
}

readonly SNAPSHOT="$(psql_admin -AtF '|' <<'SQL'
select concat_ws('|',
  clock_timestamp()::text,
  cache.phase,
  (cache.completed_at is not null)::text,
  rollout.stage,
  rollout.revision::text,
  rollout.cohort_basis_points::text,
  (select count(*) from public.admin_feature_flags where key in (
    'provider_access_v1_enabled','provider_access_auto_detection_v1_enabled',
    'provider_access_notifications_v1_enabled','provider_access_email_v1_enabled',
    'provider_access_push_v1_enabled','provider_access_in_app_v1_enabled',
    'provider_access_visibility_v1_enabled','provider_credential_transition_v1_enabled',
    'provider_replacement_v1_enabled'
  ))::text,
  (select count(*) from public.admin_feature_flags where enabled and key in (
    'provider_access_v1_enabled','provider_access_auto_detection_v1_enabled',
    'provider_access_notifications_v1_enabled','provider_access_email_v1_enabled',
    'provider_access_push_v1_enabled','provider_access_in_app_v1_enabled',
    'provider_access_visibility_v1_enabled','provider_credential_transition_v1_enabled',
    'provider_replacement_v1_enabled'
  ))::text,
  (select count(*) from public.cloud_provider_access_rollout_internal_users)::text,
  (select count(*) from public.cloud_sources source
    where source.user_id in (
      select user_id from public.cloud_provider_access_rollout_internal_users
    ) and source.source_type='xtream' and source.enabled
      and source.deleted_at is null)::text,
  (select count(*) from public.cloud_sources source
    where source.user_id in (
      select user_id from public.cloud_provider_access_rollout_internal_users
    ) and source.source_type='xtream' and source.enabled
      and source.deleted_at is null and source.sync_status='ready'
      and source.sync_error is null
      and public.norva_source_catalog_visible_internal(source.id,source.user_id))::text,
  public.norva_active_catalog_refresh_contract_ready()::text,
  exists (
    select 1 from cron.job
    where jobname='norva-active-catalog-refresh-worker' and active
      and schedule='* * * * *'
      and command like '%/norva-provider-access/internal/worker/drain%'
  )::text,
  coalesce((select extract(epoch from clock_timestamp()-registered_at)::bigint::text
    from public.cloud_catalog_active_refresh_worker_capability where singleton),'NULL'),
  (public.norva_assert_provider_access_rollout_safe()->>'safe'),
  (policy.revision is not null and policy.policy_reference is not null)::text,
  (rollout.legal_policy_approved_at is not null
    and rollout.operational_approved_at is not null
    and rollout.legal_policy_reference=policy.policy_reference
    and nullif(btrim(rollout.operational_reference),'') is not null)::text,
  (select count(*) from public.cloud_source_credential_transition_jobs
    where state not in ('completed','dead'))::text,
  (select count(*) from public.cloud_source_transitions
    where state not in ('completed','failed','cancelled'))::text,
  (select count(*) from cron.job where jobname in (
    'norva-provider-access-notifications','norva-provider-access-checks'
  ))::text
)
from public.cloud_catalog_cache_epoch_v2_rollout cache
cross join public.cloud_provider_access_rollout rollout
left join public.legal_billing_archive_retention_policy policy
  on policy.record_kind='billing_ledger'
where cache.singleton and rollout.singleton;
SQL
)"

IFS='|' read -r NOW CACHE_PHASE CACHE_COMPLETED ROLLOUT_STAGE ROLLOUT_REVISION \
  COHORT_BASIS_POINTS FLAG_COUNT ENABLED_FLAGS INTERNAL_USERS ACTIVE_SOURCES \
  READY_SOURCES ACTIVE_REFRESH_READY WORKER_CRON_READY HEARTBEAT_AGE_SECONDS \
  P0_SAFE LEGAL_POLICY_CONFIGURED APPROVALS_MATCH NONTERMINAL_JOBS \
  ACTIVE_TRANSITIONS PROVIDER_NETWORK_CRONS <<<"$SNAPSHOT"

printf 'checked_at=%s\ncache_phase=%s\ncache_completed=%s\n' \
  "$NOW" "$CACHE_PHASE" "$CACHE_COMPLETED"
printf 'rollout_stage=%s\nrollout_revision=%s\ncohort_basis_points=%s\n' \
  "$ROLLOUT_STAGE" "$ROLLOUT_REVISION" "$COHORT_BASIS_POINTS"
printf 'provider_flags=%s\nenabled_flags=%s\ninternal_users=%s\n' \
  "$FLAG_COUNT" "$ENABLED_FLAGS" "$INTERNAL_USERS"
printf 'active_internal_xtream_sources=%s\nready_internal_xtream_sources=%s\n' \
  "$ACTIVE_SOURCES" "$READY_SOURCES"
printf 'active_refresh_ready=%s\nactive_refresh_worker_cron_ready=%s\nheartbeat_age_seconds=%s\n' \
  "$ACTIVE_REFRESH_READY" "$WORKER_CRON_READY" "$HEARTBEAT_AGE_SECONDS"
printf 'p0_safe=%s\nlegal_policy_configured=%s\napprovals_match=%s\n' \
  "$P0_SAFE" "$LEGAL_POLICY_CONFIGURED" "$APPROVALS_MATCH"
printf 'nonterminal_jobs=%s\nactive_transitions=%s\nprovider_network_crons=%s\n' \
  "$NONTERMINAL_JOBS" "$ACTIVE_TRANSITIONS" "$PROVIDER_NETWORK_CRONS"

if [[ "$CACHE_PHASE" != 'complete' || "$CACHE_COMPLETED" != 'true' ]]; then
  echo 'status=WAIT_CACHE_EPOCH_V2'
  exit 75
fi
if [[ "$ROLLOUT_STAGE" != 'off' || "$ROLLOUT_REVISION" != '2' \
   || "$COHORT_BASIS_POINTS" != '0' || "$FLAG_COUNT" != '9' \
   || "$ENABLED_FLAGS" != '0' || "$INTERNAL_USERS" != '1' \
   || "$ACTIVE_SOURCES" != '1' || "$READY_SOURCES" != '1' \
   || "$ACTIVE_REFRESH_READY" != 'true' || "$WORKER_CRON_READY" != 'true' \
   || "$HEARTBEAT_AGE_SECONDS" == 'NULL' || "$HEARTBEAT_AGE_SECONDS" -gt 120 \
   || "$P0_SAFE" != 'true' || "$LEGAL_POLICY_CONFIGURED" != 'true' \
   || "$APPROVALS_MATCH" != 'true' || "$NONTERMINAL_JOBS" != '0' \
   || "$ACTIVE_TRANSITIONS" != '0' || "$PROVIDER_NETWORK_CRONS" != '0' ]]; then
  echo 'status=REFUSED_INTERNAL_CANARY_PREFLIGHT' >&2
  exit 70
fi

echo 'status=READY_FOR_EXPLICIT_INTERNAL_CANARY'
