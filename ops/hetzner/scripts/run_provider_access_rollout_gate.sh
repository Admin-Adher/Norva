#!/usr/bin/env bash
set -euo pipefail

readonly DB_CONTAINER="${DB_CONTAINER:-norva-db}"
readonly ACTION="${1:-preflight}"

if [[ "$DB_CONTAINER" != 'norva-db' ]]; then
  echo "refusing unexpected production database container: $DB_CONTAINER" >&2
  exit 64
fi
case "$ACTION" in
  preflight|configure-gates|set-internal-user|set-stage|set-channels) ;;
  *)
    echo 'usage: run_provider_access_rollout_gate.sh [preflight|configure-gates|set-internal-user|set-stage|set-channels]' >&2
    exit 64
    ;;
esac

psql_admin() {
  docker exec -i "$DB_CONTAINER" psql -X -U supabase_admin -d postgres \
    -v ON_ERROR_STOP=1 "$@"
}

no_line_breaks() {
  [[ "$1" != *$'\n'* && "$1" != *$'\r'* ]]
}

valid_text() {
  local value="$1"
  local minimum="$2"
  local maximum="$3"
  [[ ${#value} -ge $minimum && ${#value} -le $maximum ]] && no_line_breaks "$value"
}

state() {
  psql_admin -AtF '|' <<'SQL'
select
  rollout.revision,
  rollout.stage,
  rollout.cohort_basis_points,
  coalesce(rollout.legal_policy_reference,'NULL'),
  coalesce(rollout.operational_reference,'NULL'),
  cache.phase,
  coalesce(policy.revision::text,'UNCONFIGURED'),
  coalesce(policy.policy_reference,'NULL'),
  (select count(*) from public.cloud_provider_access_rollout_internal_users),
  (select count(*) from public.admin_feature_flags where enabled and key in (
    'provider_access_v1_enabled','provider_access_auto_detection_v1_enabled',
    'provider_access_notifications_v1_enabled','provider_access_email_v1_enabled',
    'provider_access_push_v1_enabled','provider_access_in_app_v1_enabled',
    'provider_access_visibility_v1_enabled','provider_credential_transition_v1_enabled',
    'provider_replacement_v1_enabled'
  )),
  coalesce((select string_agg(key,',' order by key) from public.admin_feature_flags
    where enabled and key in (
      'provider_access_auto_detection_v1_enabled','provider_access_email_v1_enabled',
      'provider_access_push_v1_enabled'
    )),'NONE'),
  (public.norva_assert_provider_access_rollout_safe()->>'safe')
from public.cloud_provider_access_rollout rollout
cross join public.cloud_catalog_cache_epoch_v2_rollout cache
left join public.legal_billing_archive_retention_policy policy
  on policy.record_kind='billing_ledger'
where rollout.singleton and cache.singleton;
SQL
}

print_state() {
  local snapshot="$1"
  local revision stage basis_points legal_gate operational_gate cache_phase
  local legal_policy_revision legal_policy_reference internal_users enabled_flags
  local external_channels p0_safe
  IFS='|' read -r revision stage basis_points legal_gate operational_gate cache_phase \
    legal_policy_revision legal_policy_reference internal_users enabled_flags \
    external_channels p0_safe <<<"$snapshot"
  printf 'rollout_revision=%s\nrollout_stage=%s\ncohort_basis_points=%s\n' \
    "$revision" "$stage" "$basis_points"
  printf 'legal_gate_reference=%s\noperational_gate_reference=%s\n' \
    "$legal_gate" "$operational_gate"
  printf 'cache_phase=%s\nlegal_policy_revision=%s\nlegal_policy_reference=%s\n' \
    "$cache_phase" "$legal_policy_revision" "$legal_policy_reference"
  printf 'internal_users=%s\nenabled_flags=%s\nexternal_channels=%s\np0_safe=%s\n' \
    "$internal_users" "$enabled_flags" "$external_channels" "$p0_safe"
}

readonly BEFORE="$(state)"
print_state "$BEFORE"
if [[ "$ACTION" == 'preflight' ]]; then
  echo 'status=READ_ONLY_PREFLIGHT'
  exit 0
fi

IFS='|' read -r CURRENT_REVISION CURRENT_STAGE _ CURRENT_LEGAL_GATE _ \
  CACHE_PHASE LEGAL_POLICY_REVISION CURRENT_POLICY_REFERENCE _ _ _ P0_SAFE <<<"$BEFORE"

if [[ "$P0_SAFE" != 'true' ]]; then
  echo 'status=REFUSED_P0_UNSAFE' >&2
  exit 70
fi

case "$ACTION" in
  configure-gates)
    : "${EXPECTED_ROLLOUT_REVISION:?EXPECTED_ROLLOUT_REVISION is required}"
    : "${LEGAL_POLICY_REFERENCE:?LEGAL_POLICY_REFERENCE is required}"
    : "${OPERATIONAL_REFERENCE:?OPERATIONAL_REFERENCE is required}"
    : "${ROLLOUT_ACTOR:?ROLLOUT_ACTOR is required}"
    [[ "$EXPECTED_ROLLOUT_REVISION" =~ ^[0-9]+$ ]]
    valid_text "$LEGAL_POLICY_REFERENCE" 12 500
    valid_text "$OPERATIONAL_REFERENCE" 12 500
    valid_text "$ROLLOUT_ACTOR" 3 200
    if [[ "$LEGAL_POLICY_REVISION" == 'UNCONFIGURED' || "$CURRENT_POLICY_REFERENCE" == 'NULL' ]]; then
      echo 'status=REFUSED_LEGAL_POLICY_UNCONFIGURED' >&2
      exit 70
    fi
    if [[ "$LEGAL_POLICY_REFERENCE" != "$CURRENT_POLICY_REFERENCE" ]]; then
      echo 'status=REFUSED_LEGAL_POLICY_REFERENCE_MISMATCH' >&2
      exit 70
    fi
    if [[ "${CONFIRM_ROLLOUT_GATES:-}" != 'CONFIGURE_PROVIDER_ACCESS_ROLLOUT_GATES' ]]; then
      echo 'status=REFUSED_MISSING_EXPLICIT_GATE_CONFIRMATION' >&2
      exit 64
    fi
    psql_admin -v expected_revision="$EXPECTED_ROLLOUT_REVISION" \
      -v legal_reference="$LEGAL_POLICY_REFERENCE" \
      -v operational_reference="$OPERATIONAL_REFERENCE" \
      -v actor="$ROLLOUT_ACTOR" <<'SQL'
begin;
set local role service_role;
select public.norva_configure_provider_access_rollout_gates(
  :'expected_revision'::bigint,:'legal_reference',:'operational_reference',:'actor'
);
commit;
SQL
    ;;
  set-internal-user)
    : "${INTERNAL_USER_ID:?INTERNAL_USER_ID is required}"
    : "${INTERNAL_USER_ENABLED:?INTERNAL_USER_ENABLED is required}"
    : "${INTERNAL_USER_REASON:?INTERNAL_USER_REASON is required}"
    : "${ROLLOUT_ACTOR:?ROLLOUT_ACTOR is required}"
    [[ "$INTERNAL_USER_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]
    [[ "$INTERNAL_USER_ENABLED" == 'true' || "$INTERNAL_USER_ENABLED" == 'false' ]]
    valid_text "$INTERNAL_USER_REASON" 8 500
    valid_text "$ROLLOUT_ACTOR" 3 200
    if [[ "${CONFIRM_INTERNAL_USER:-}" != 'SET_PROVIDER_ACCESS_INTERNAL_USER' ]]; then
      echo 'status=REFUSED_MISSING_EXPLICIT_INTERNAL_USER_CONFIRMATION' >&2
      exit 64
    fi
    psql_admin -v user_id="$INTERNAL_USER_ID" -v enabled="$INTERNAL_USER_ENABLED" \
      -v reason="$INTERNAL_USER_REASON" -v actor="$ROLLOUT_ACTOR" <<'SQL'
begin;
set local role service_role;
select public.norva_set_provider_access_rollout_internal_user(
  :'user_id'::uuid,:'enabled'::boolean,:'reason',:'actor'
);
commit;
SQL
    ;;
  set-stage)
    : "${EXPECTED_ROLLOUT_REVISION:?EXPECTED_ROLLOUT_REVISION is required}"
    : "${ROLLOUT_STAGE:?ROLLOUT_STAGE is required}"
    : "${ROLLOUT_APPROVAL_NOTE:?ROLLOUT_APPROVAL_NOTE is required}"
    : "${ROLLOUT_ACTOR:?ROLLOUT_ACTOR is required}"
    [[ "$EXPECTED_ROLLOUT_REVISION" =~ ^[0-9]+$ ]]
    [[ "$ROLLOUT_STAGE" =~ ^(off|internal|1_percent|5_percent|20_percent|50_percent|100_percent)$ ]]
    valid_text "$ROLLOUT_APPROVAL_NOTE" 12 1000
    valid_text "$ROLLOUT_ACTOR" 3 200
    if [[ "$ROLLOUT_STAGE" != 'off' && "$CACHE_PHASE" != 'complete' ]]; then
      echo 'status=REFUSED_CACHE_EPOCH_INCOMPLETE' >&2
      exit 70
    fi
    if [[ "${CONFIRM_ROLLOUT_STAGE:-}" != "SET_PROVIDER_ACCESS_STAGE_${ROLLOUT_STAGE}" ]]; then
      echo 'status=REFUSED_MISSING_EXPLICIT_STAGE_CONFIRMATION' >&2
      exit 64
    fi
    psql_admin -v expected_revision="$EXPECTED_ROLLOUT_REVISION" \
      -v stage="$ROLLOUT_STAGE" -v note="$ROLLOUT_APPROVAL_NOTE" \
      -v actor="$ROLLOUT_ACTOR" <<'SQL'
begin;
set local role service_role;
select public.norva_set_provider_access_rollout_stage(
  :'expected_revision'::bigint,:'stage',:'note',:'actor'
);
commit;
SQL
    ;;
  set-channels)
    : "${EXPECTED_ROLLOUT_REVISION:?EXPECTED_ROLLOUT_REVISION is required}"
    : "${AUTO_DETECTION_ENABLED:?AUTO_DETECTION_ENABLED is required}"
    : "${EMAIL_ENABLED:?EMAIL_ENABLED is required}"
    : "${PUSH_ENABLED:?PUSH_ENABLED is required}"
    : "${CHANNEL_READINESS_REFERENCE:?CHANNEL_READINESS_REFERENCE is required}"
    : "${ROLLOUT_ACTOR:?ROLLOUT_ACTOR is required}"
    [[ "$EXPECTED_ROLLOUT_REVISION" =~ ^[0-9]+$ ]]
    for value in "$AUTO_DETECTION_ENABLED" "$EMAIL_ENABLED" "$PUSH_ENABLED"; do
      [[ "$value" == 'true' || "$value" == 'false' ]]
    done
    valid_text "$CHANNEL_READINESS_REFERENCE" 12 1000
    valid_text "$ROLLOUT_ACTOR" 3 200
    if [[ "$CACHE_PHASE" != 'complete' || "$CURRENT_STAGE" == 'off' ]]; then
      echo 'status=REFUSED_NO_ACTIVE_CACHE_SAFE_COHORT' >&2
      exit 70
    fi
    if [[ "${CONFIRM_ROLLOUT_CHANNELS:-}" != 'SET_PROVIDER_ACCESS_EXTERNAL_CHANNELS' ]]; then
      echo 'status=REFUSED_MISSING_EXPLICIT_CHANNEL_CONFIRMATION' >&2
      exit 64
    fi
    psql_admin -v expected_revision="$EXPECTED_ROLLOUT_REVISION" \
      -v auto_detection="$AUTO_DETECTION_ENABLED" -v email="$EMAIL_ENABLED" \
      -v push="$PUSH_ENABLED" -v readiness="$CHANNEL_READINESS_REFERENCE" \
      -v actor="$ROLLOUT_ACTOR" <<'SQL'
begin;
set local role service_role;
select public.norva_set_provider_access_rollout_channels(
  :'expected_revision'::bigint,:'auto_detection'::boolean,:'email'::boolean,
  :'push'::boolean,:'readiness',:'actor'
);
commit;
SQL
    ;;
esac

readonly AFTER="$(state)"
print_state "$AFTER"
echo 'status=COMPLETED'
