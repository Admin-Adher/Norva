#!/usr/bin/env bash
set -euo pipefail

readonly DB_CONTAINER="${DB_CONTAINER:-norva-db}"
readonly ACTION="${1:-preflight}"
readonly CONTRACT='catalog-cache-epoch-v2'
readonly MANIFEST_SHA256='23c0fa2cdaf09c08d9de4378d1a82f0f631ce71d6f955a0bdbb2c786b8ff98d3'
readonly CONFIRMATION='WAIVE_CACHE_EPOCH_V2_OBSERVATION_FOR_AD_LAUNCH'

if [[ "$DB_CONTAINER" != 'norva-db' ]]; then
  echo "refusing unexpected production database container: $DB_CONTAINER" >&2
  exit 64
fi
if [[ "$ACTION" != 'preflight' && "$ACTION" != 'waive-and-complete' ]]; then
  echo 'usage: run_catalog_cache_epoch_v2_break_glass_waiver.sh [preflight|waive-and-complete]' >&2
  exit 64
fi

psql_admin() {
  docker exec -i "$DB_CONTAINER" psql -X -U supabase_admin -d postgres \
    -v ON_ERROR_STOP=1 "$@"
}

valid_text() {
  local value="$1"
  local minimum="$2"
  local maximum="$3"
  [[ ${#value} -ge $minimum && ${#value} -le $maximum \
     && "$value" != *$'\n'* && "$value" != *$'\r'* ]]
}

state() {
  psql_admin -AtF '|' <<'SQL'
select concat_ws('|',
  clock_timestamp()::text,
  cache.phase,
  cache.installed_at::text,
  (cache.installed_at + interval '7 days')::text,
  (clock_timestamp() < cache.installed_at + interval '7 days')::text,
  coalesce(cache.completed_at::text,'NULL'),
  cohort.stage,
  cohort.revision::text,
  cohort.cohort_basis_points::text,
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
  (public.norva_assert_provider_access_rollout_safe()->>'safe'),
  (select count(*) from cron.job where jobname in (
    'norva-provider-access-notifications','norva-provider-access-checks'
  ))::text,
  (select count(*) from public.cloud_catalog_cache_epoch_v2_waivers)::text,
  coalesce((select approval_reference from public.cloud_catalog_cache_epoch_v2_waivers),'NULL'),
  (select global_epoch from public.cloud_global_catalog_visibility_epoch where singleton)::text
)
from public.cloud_catalog_cache_epoch_v2_rollout cache
cross join public.cloud_provider_access_rollout cohort
where cache.singleton and cohort.singleton;
SQL
}

print_state() {
  local snapshot="$1"
  local now phase installed_at normal_not_before window_incomplete completed_at stage revision basis_points
  local flag_count enabled_flags p0_safe provider_crons waiver_count approval_reference global_epoch
  IFS='|' read -r now phase installed_at normal_not_before window_incomplete completed_at stage revision basis_points \
    flag_count enabled_flags p0_safe provider_crons waiver_count approval_reference global_epoch <<<"$snapshot"
  printf 'checked_at=%s\nphase=%s\ninstalled_at=%s\nnormal_not_before=%s\ncompleted_at=%s\n' \
    "$now" "$phase" "$installed_at" "$normal_not_before" "$completed_at"
  printf 'observation_window_incomplete=%s\n' "$window_incomplete"
  printf 'rollout_stage=%s\nrollout_revision=%s\ncohort_basis_points=%s\n' \
    "$stage" "$revision" "$basis_points"
  printf 'provider_flags=%s\nenabled_flags=%s\np0_safe=%s\nprovider_crons=%s\n' \
    "$flag_count" "$enabled_flags" "$p0_safe" "$provider_crons"
  printf 'waiver_count=%s\nwaiver_approval_reference=%s\nglobal_epoch=%s\n' \
    "$waiver_count" "$approval_reference" "$global_epoch"
}

readonly BEFORE="$(state)"
print_state "$BEFORE"
IFS='|' read -r NOW PHASE INSTALLED_AT NORMAL_NOT_BEFORE WINDOW_INCOMPLETE COMPLETED_AT STAGE REVISION \
  BASIS_POINTS FLAG_COUNT ENABLED_FLAGS P0_SAFE PROVIDER_CRONS WAIVER_COUNT \
  CURRENT_APPROVAL_REFERENCE GLOBAL_EPOCH <<<"$BEFORE"

if [[ "$PHASE" == 'complete' ]]; then
  if [[ "$WAIVER_COUNT" == '1' ]]; then
    echo 'status=ALREADY_COMPLETED_BY_BREAK_GLASS_WAIVER'
    exit 0
  fi
  echo 'status=REFUSED_ALREADY_COMPLETED_WITHOUT_WAIVER' >&2
  exit 70
fi
if [[ "$PHASE" != 'installed' || "$STAGE" != 'off' || "$BASIS_POINTS" != '0' \
   || "$FLAG_COUNT" != '9' || "$ENABLED_FLAGS" != '0' || "$P0_SAFE" != 'true' \
   || "$PROVIDER_CRONS" != '0' || "$WAIVER_COUNT" != '0' ]]; then
  echo 'status=REFUSED_UNSAFE_BREAK_GLASS_STATE' >&2
  exit 70
fi
if [[ "$WINDOW_INCOMPLETE" != 'true' ]]; then
  echo 'status=REFUSED_WAIVER_NO_LONGER_NEEDED_USE_NORMAL_COMPLETION' >&2
  exit 70
fi
if [[ "$ACTION" == 'preflight' ]]; then
  echo 'status=READY_FOR_EXPLICIT_BREAK_GLASS_WAIVER'
  exit 0
fi

: "${EXPECTED_ROLLOUT_REVISION:?EXPECTED_ROLLOUT_REVISION is required}"
: "${WAIVER_APPROVAL_REFERENCE:?WAIVER_APPROVAL_REFERENCE is required}"
: "${WAIVER_RISK_REASON:?WAIVER_RISK_REASON is required}"
: "${WAIVER_ACTOR:?WAIVER_ACTOR is required}"
if [[ ! "$EXPECTED_ROLLOUT_REVISION" =~ ^[1-9][0-9]*$ ]] \
   || [[ ! "$WAIVER_APPROVAL_REFERENCE" =~ ^[A-Za-z0-9][A-Za-z0-9._:/-]{11,119}$ ]] \
   || ! valid_text "$WAIVER_RISK_REASON" 40 1000 \
   || ! valid_text "$WAIVER_ACTOR" 3 200; then
  echo 'status=REFUSED_INVALID_WAIVER_TEXT' >&2
  exit 64
fi
if [[ "$EXPECTED_ROLLOUT_REVISION" != "$REVISION" ]]; then
  echo 'status=REFUSED_STALE_ROLLOUT_REVISION' >&2
  exit 70
fi
if [[ "${CONFIRM_CACHE_EPOCH_WAIVER:-}" != "$CONFIRMATION" ]]; then
  echo 'status=REFUSED_MISSING_EXPLICIT_WAIVER_CONFIRMATION' >&2
  exit 64
fi

psql_admin \
  -v contract="$CONTRACT" \
  -v manifest="$MANIFEST_SHA256" \
  -v expected_revision="$EXPECTED_ROLLOUT_REVISION" \
  -v approval_reference="$WAIVER_APPROVAL_REFERENCE" \
  -v risk_reason="$WAIVER_RISK_REASON" \
  -v actor="$WAIVER_ACTOR" \
  -v confirmation="$CONFIRMATION" <<'SQL'
begin;
set local role service_role;
select public.norva_waive_catalog_cache_epoch_v2_observation(
  :'contract', :'manifest', :'expected_revision'::bigint,
  :'approval_reference', :'risk_reason', :'actor', :'confirmation'
);
commit;
SQL

readonly AFTER="$(state)"
print_state "$AFTER"
echo 'status=COMPLETED_BY_EXPLICIT_BREAK_GLASS_WAIVER'
