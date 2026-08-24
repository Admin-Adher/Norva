#!/usr/bin/env bash
set -euo pipefail

readonly DB_CONTAINER="${DB_CONTAINER:-norva-db}"
readonly ACTION="${1:-preflight}"
readonly CONTRACT='catalog-cache-epoch-v2'
readonly MANIFEST_SHA256='23c0fa2cdaf09c08d9de4378d1a82f0f631ce71d6f955a0bdbb2c786b8ff98d3'

if [[ "$DB_CONTAINER" != 'norva-db' ]]; then
  echo "refusing unexpected production database container: $DB_CONTAINER" >&2
  exit 64
fi
if [[ "$ACTION" != 'preflight' && "$ACTION" != 'complete-cache' ]]; then
  echo 'usage: run_provider_access_production_activation_gate.sh [preflight|complete-cache]' >&2
  exit 64
fi

psql_admin() {
  docker exec -i "$DB_CONTAINER" psql -X -U supabase_admin -d postgres \
    -v ON_ERROR_STOP=1 "$@"
}

readonly STATE="$(psql_admin -Atq <<'SQL'
select rollout.phase || '|' ||
  extract(epoch from clock_timestamp())::bigint || '|' ||
  extract(epoch from rollout.installed_at + interval '7 days')::bigint || '|' ||
  rollout.installed_at::text || '|' ||
  (rollout.installed_at + interval '7 days')::text || '|' ||
  coalesce(rollout.completed_at::text,'NULL') || '|' ||
  cohort.stage || '|' || cohort.revision || '|' ||
  (select count(*) from public.admin_feature_flags where enabled and key in (
    'provider_access_v1_enabled','provider_access_auto_detection_v1_enabled',
    'provider_access_notifications_v1_enabled','provider_access_email_v1_enabled',
    'provider_access_push_v1_enabled','provider_access_in_app_v1_enabled',
    'provider_access_visibility_v1_enabled','provider_credential_transition_v1_enabled',
    'provider_replacement_v1_enabled'
  )) || '|' ||
  (public.norva_assert_provider_access_rollout_safe()->>'safe')
from public.cloud_catalog_cache_epoch_v2_rollout rollout
cross join public.cloud_provider_access_rollout cohort
where rollout.singleton and cohort.singleton;
SQL
)"

IFS='|' read -r PHASE NOW_EPOCH NOT_BEFORE_EPOCH INSTALLED_AT NOT_BEFORE \
  COMPLETED_AT STAGE REVISION ENABLED_FLAGS P0_SAFE <<<"$STATE"

printf 'phase=%s\ninstalled_at=%s\nnot_before=%s\ncompleted_at=%s\n' \
  "$PHASE" "$INSTALLED_AT" "$NOT_BEFORE" "$COMPLETED_AT"
printf 'rollout_stage=%s\nrollout_revision=%s\nenabled_flags=%s\np0_safe=%s\n' \
  "$STAGE" "$REVISION" "$ENABLED_FLAGS" "$P0_SAFE"

if [[ "$STAGE" != 'off' || "$ENABLED_FLAGS" != '0' || "$P0_SAFE" != 'true' ]]; then
  echo 'status=REFUSED_UNSAFE_PRODUCTION_STATE' >&2
  exit 70
fi
if [[ "$PHASE" == 'complete' ]]; then
  echo 'status=ALREADY_COMPLETE'
  exit 0
fi
if [[ "$PHASE" != 'installed' ]]; then
  echo "status=REFUSED_UNKNOWN_CACHE_PHASE:$PHASE" >&2
  exit 70
fi
if (( NOW_EPOCH < NOT_BEFORE_EPOCH )); then
  echo 'status=WAIT_OBSERVATION_WINDOW'
  exit 75
fi
if [[ "$ACTION" == 'preflight' ]]; then
  echo 'status=READY_FOR_EXPLICIT_CACHE_COMPLETION'
  exit 0
fi

if [[ "${CONFIRM_PRODUCTION_ACTIVATION:-}" != 'COMPLETE_CACHE_EPOCH_V2_AFTER_7D' ]]; then
  echo 'status=REFUSED_MISSING_EXPLICIT_CONFIRMATION' >&2
  exit 64
fi

psql_admin <<SQL
begin;
set local role service_role;
select public.norva_complete_catalog_cache_epoch_v2_rollout(
  '$CONTRACT','$MANIFEST_SHA256'
);
commit;
SQL

readonly FINAL="$(psql_admin -Atq <<'SQL'
select phase || '|' || manifest_sha256 || '|' || completed_at::text
from public.cloud_catalog_cache_epoch_v2_rollout where singleton;
SQL
)"
printf 'status=COMPLETED\nfinal=%s\n' "$FINAL"
