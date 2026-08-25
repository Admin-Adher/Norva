#!/usr/bin/env bash
set -euo pipefail

readonly DB_CONTAINER="${DB_CONTAINER:-norva-db}"
readonly ACTION="${1:-preflight}"

if [[ "$DB_CONTAINER" != 'norva-db' ]]; then
  echo "refusing unexpected production database container: $DB_CONTAINER" >&2
  exit 64
fi
if [[ "$ACTION" != 'preflight' && "$ACTION" != 'configure-policy' && "$ACTION" != 'set-reader' ]]; then
  echo 'usage: run_provider_access_legal_policy_gate.sh [preflight|configure-policy|set-reader]' >&2
  exit 64
fi

psql_admin() {
  docker exec -i "$DB_CONTAINER" psql -X -U supabase_admin -d postgres \
    -v ON_ERROR_STOP=1 "$@"
}

state() {
  psql_admin -AtF '|' <<'SQL'
select
  coalesce((select revision::text from public.legal_billing_archive_retention_policy where record_kind='billing_ledger'),'UNCONFIGURED'),
  coalesce((select retention_years::text from public.legal_billing_archive_retention_policy where record_kind='billing_ledger'),'NULL'),
  coalesce((select fiscal_year_end_month::text||'-'||fiscal_year_end_day::text from public.legal_billing_archive_retention_policy where record_kind='billing_ledger'),'NULL'),
  (select count(*) from public.legal_billing_archive_access_grants where enabled),
  (select count(*) from public.legal_billing_archive),
  cohort.stage,
  cohort.revision,
  cache.phase,
  (select count(*) from public.admin_feature_flags where enabled and key in (
    'provider_access_v1_enabled','provider_access_auto_detection_v1_enabled',
    'provider_access_notifications_v1_enabled','provider_access_email_v1_enabled',
    'provider_access_push_v1_enabled','provider_access_in_app_v1_enabled',
    'provider_access_visibility_v1_enabled','provider_credential_transition_v1_enabled',
    'provider_replacement_v1_enabled'
  )),
  (select count(*) from unnest(array['anon','authenticated','service_role']) api_role,
    unnest(array['legal_billing_archive_retention_policy','legal_billing_archive',
      'legal_billing_archive_policy_events','legal_billing_archive_access_grants',
      'legal_billing_archive_access_grant_events','legal_billing_archive_access_events']) relation_name,
    unnest(array['select','insert','update','delete','truncate','references','trigger']) privilege_name
    where has_table_privilege(api_role,format('public.%I',relation_name),privilege_name))
from public.cloud_provider_access_rollout cohort
cross join public.cloud_catalog_cache_epoch_v2_rollout cache
where cohort.singleton and cache.singleton;
SQL
}

print_state() {
  local snapshot="$1"
  local policy_revision retention_years fiscal_close enabled_readers archive_rows
  local rollout_stage rollout_revision cache_phase enabled_flags direct_privileges
  IFS='|' read -r policy_revision retention_years fiscal_close enabled_readers archive_rows \
    rollout_stage rollout_revision cache_phase enabled_flags direct_privileges <<<"$snapshot"
  printf 'policy_revision=%s\nretention_years=%s\nfiscal_close=%s\n' \
    "$policy_revision" "$retention_years" "$fiscal_close"
  printf 'enabled_readers=%s\narchive_rows=%s\n' "$enabled_readers" "$archive_rows"
  printf 'rollout_stage=%s\nrollout_revision=%s\ncache_phase=%s\n' \
    "$rollout_stage" "$rollout_revision" "$cache_phase"
  printf 'enabled_flags=%s\ndirect_archive_privileges=%s\n' "$enabled_flags" "$direct_privileges"
  if [[ "$rollout_stage" != 'off' || "$enabled_flags" != '0' || "$direct_privileges" != '0' ]]; then
    echo 'status=REFUSED_UNSAFE_PRODUCTION_STATE' >&2
    exit 70
  fi
}

readonly BEFORE="$(state)"
print_state "$BEFORE"
if [[ "$ACTION" == 'preflight' ]]; then
  echo 'status=READ_ONLY_PREFLIGHT'
  exit 0
fi

no_line_breaks() {
  [[ "$1" != *$'\n'* && "$1" != *$'\r'* ]]
}

if [[ "$ACTION" == 'configure-policy' ]]; then
  : "${EXPECTED_POLICY_REVISION:?EXPECTED_POLICY_REVISION is required}"
  : "${LEGAL_BASIS:?LEGAL_BASIS is required}"
  : "${POLICY_REFERENCE:?POLICY_REFERENCE is required}"
  : "${RETENTION_YEARS:?RETENTION_YEARS is required}"
  : "${FISCAL_YEAR_END_MONTH:?FISCAL_YEAR_END_MONTH is required}"
  : "${FISCAL_YEAR_END_DAY:?FISCAL_YEAR_END_DAY is required}"
  : "${POLICY_ACTOR:?POLICY_ACTOR is required}"
  [[ "$EXPECTED_POLICY_REVISION" =~ ^[0-9]+$ ]]
  [[ "$RETENTION_YEARS" =~ ^[0-9]+$ && "$RETENTION_YEARS" -ge 1 && "$RETENTION_YEARS" -le 30 ]]
  [[ "$FISCAL_YEAR_END_MONTH" =~ ^[0-9]+$ && "$FISCAL_YEAR_END_MONTH" -ge 1 && "$FISCAL_YEAR_END_MONTH" -le 12 ]]
  [[ "$FISCAL_YEAR_END_DAY" =~ ^[0-9]+$ && "$FISCAL_YEAR_END_DAY" -ge 1 && "$FISCAL_YEAR_END_DAY" -le 31 ]]
  [[ ${#LEGAL_BASIS} -ge 3 && ${#LEGAL_BASIS} -le 1000 ]]
  [[ "$POLICY_REFERENCE" =~ ^[A-Za-z0-9][A-Za-z0-9._:/-]{11,119}$ ]]
  [[ ${#POLICY_ACTOR} -ge 3 && ${#POLICY_ACTOR} -le 200 ]]
  no_line_breaks "$LEGAL_BASIS" && no_line_breaks "$POLICY_REFERENCE" && no_line_breaks "$POLICY_ACTOR"
  if [[ "${CONFIRM_LEGAL_POLICY:-}" != 'CONFIGURE_LEGAL_BILLING_POLICY_V2' ]]; then
    echo 'status=REFUSED_MISSING_EXPLICIT_POLICY_CONFIRMATION' >&2
    exit 64
  fi

  psql_admin \
    -v expected_revision="$EXPECTED_POLICY_REVISION" \
    -v legal_basis="$LEGAL_BASIS" \
    -v policy_reference="$POLICY_REFERENCE" \
    -v retention_years="$RETENTION_YEARS" \
    -v fiscal_month="$FISCAL_YEAR_END_MONTH" \
    -v fiscal_day="$FISCAL_YEAR_END_DAY" \
    -v policy_actor="$POLICY_ACTOR" <<'SQL'
begin;
set local role service_role;
select public.norva_configure_legal_billing_archive_policy(
  :'expected_revision'::bigint,:'legal_basis',:'policy_reference',
  :'retention_years'::integer,:'fiscal_month'::integer,:'fiscal_day'::integer,
  :'policy_actor'
);
commit;
SQL
else
  : "${READER_USER_ID:?READER_USER_ID is required}"
  : "${EXPECTED_READER_REVISION:?EXPECTED_READER_REVISION is required}"
  : "${READER_ENABLED:?READER_ENABLED is required}"
  : "${READER_APPROVAL_REFERENCE:?READER_APPROVAL_REFERENCE is required}"
  : "${READER_ACTOR:?READER_ACTOR is required}"
  [[ "$READER_USER_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]
  [[ "$EXPECTED_READER_REVISION" =~ ^[0-9]+$ ]]
  [[ "$READER_ENABLED" == 'true' || "$READER_ENABLED" == 'false' ]]
  [[ "$READER_APPROVAL_REFERENCE" =~ ^[A-Za-z0-9][A-Za-z0-9._:/-]{11,119}$ ]]
  [[ ${#READER_ACTOR} -ge 3 && ${#READER_ACTOR} -le 200 ]]
  no_line_breaks "$READER_APPROVAL_REFERENCE" && no_line_breaks "$READER_ACTOR"
  if [[ "${CONFIRM_LEGAL_READER:-}" != 'SET_LEGAL_BILLING_ARCHIVE_READER' ]]; then
    echo 'status=REFUSED_MISSING_EXPLICIT_READER_CONFIRMATION' >&2
    exit 64
  fi

  psql_admin \
    -v reader_user_id="$READER_USER_ID" \
    -v expected_revision="$EXPECTED_READER_REVISION" \
    -v reader_enabled="$READER_ENABLED" \
    -v approval_reference="$READER_APPROVAL_REFERENCE" \
    -v reader_actor="$READER_ACTOR" <<'SQL'
begin;
set local role service_role;
select public.norva_set_legal_billing_archive_access_grant(
  :'reader_user_id'::uuid,:'expected_revision'::bigint,:'reader_enabled'::boolean,
  :'approval_reference',:'reader_actor'
);
commit;
SQL
fi

readonly AFTER="$(state)"
print_state "$AFTER"
echo 'status=COMPLETED'
