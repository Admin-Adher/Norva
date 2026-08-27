#!/usr/bin/env bash
set -euo pipefail

readonly DB_CONTAINER="${DB_CONTAINER:-norva-db}"
readonly ACTION="${1:-preflight}"

if [[ "$DB_CONTAINER" != 'norva-db' ]]; then
  echo "refusing unexpected production database container: $DB_CONTAINER" >&2
  exit 64
fi
case "$ACTION" in
  preflight|observation-status|configure-gates|set-internal-user|set-stage|start-observation|restart-observation-v2|restart-observation-after-change|complete-observation|set-channels|enqueue-push-readiness-smoke|install-notification-cron|install-detection-cron|remove-provider-crons) ;;
  *)
    echo 'usage: run_provider_access_rollout_gate.sh [preflight|observation-status|configure-gates|set-internal-user|set-stage|start-observation|restart-observation-v2|restart-observation-after-change|complete-observation|set-channels|enqueue-push-readiness-smoke|install-notification-cron|install-detection-cron|remove-provider-crons]' >&2
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
  (public.norva_assert_provider_access_rollout_safe()->>'safe'),
  coalesce((select string_agg(jobname,',' order by jobname) from cron.job
    where jobname in (
      'norva-provider-access-notifications','norva-provider-access-checks'
    )),'NONE')
  ,public.norva_active_catalog_refresh_contract_ready()
  ,exists (
    select 1 from cron.job
    where jobname='norva-active-catalog-refresh-worker'
      and active
      and schedule='* * * * *'
      and command like '%/norva-provider-access/internal/worker/drain%'
  )
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
  local external_channels p0_safe provider_crons active_refresh_ready worker_cron_ready
  IFS='|' read -r revision stage basis_points legal_gate operational_gate cache_phase \
    legal_policy_revision legal_policy_reference internal_users enabled_flags \
    external_channels p0_safe provider_crons active_refresh_ready worker_cron_ready <<<"$snapshot"
  printf 'rollout_revision=%s\nrollout_stage=%s\ncohort_basis_points=%s\n' \
    "$revision" "$stage" "$basis_points"
  printf 'legal_gate_reference=%s\noperational_gate_reference=%s\n' \
    "$legal_gate" "$operational_gate"
  printf 'cache_phase=%s\nlegal_policy_revision=%s\nlegal_policy_reference=%s\n' \
    "$cache_phase" "$legal_policy_revision" "$legal_policy_reference"
  printf 'internal_users=%s\nenabled_flags=%s\nexternal_channels=%s\np0_safe=%s\nprovider_crons=%s\n' \
    "$internal_users" "$enabled_flags" "$external_channels" "$p0_safe" "$provider_crons"
  printf 'active_refresh_ready=%s\nactive_refresh_worker_cron_ready=%s\n' \
    "$active_refresh_ready" "$worker_cron_ready"
}

observation_state() {
  psql_admin -AtF '|' <<'SQL'
select coalesce((
  select concat_ws('|',
    observation.id::text,
    observation.rollout_revision::text,
    observation.stage,
    observation.state,
    observation.started_at::text,
    observation.activity_started_at::text,
    observation.not_before::text,
    coalesce(observation.completed_at::text,'NULL'),
    observation.threshold_contract,
    observation.decision_reasons::text,
    coalesce(observation.supersedes_observation_id::text,'NULL'),
    coalesce(observation.evidence_reference,'NULL')
  )
  from public.cloud_provider_access_rollout_observations observation
  order by observation.created_at desc, observation.id desc
  limit 1
),'NONE');
SQL
}

print_observation_state() {
  local snapshot="$1"
  if [[ "$snapshot" == 'NONE' ]]; then
    echo 'observation=NONE'
    return
  fi
  local id revision stage status started_at activity_started_at not_before completed_at
  local contract reasons supersedes evidence
  IFS='|' read -r id revision stage status started_at activity_started_at not_before completed_at \
    contract reasons supersedes evidence <<<"$snapshot"
  printf 'observation_id=%s\nobservation_revision=%s\nobservation_stage=%s\nobservation_state=%s\n' \
    "$id" "$revision" "$stage" "$status"
  printf 'observation_started_at=%s\nobservation_activity_started_at=%s\nobservation_not_before=%s\nobservation_completed_at=%s\n' \
    "$started_at" "$activity_started_at" "$not_before" "$completed_at"
  printf 'observation_contract=%s\nobservation_reasons=%s\nobservation_supersedes=%s\nobservation_evidence=%s\n' \
    "$contract" "$reasons" "$supersedes" "$evidence"
}

readonly BEFORE="$(state)"
print_state "$BEFORE"
if [[ "$ACTION" == 'preflight' ]]; then
  echo 'status=READ_ONLY_PREFLIGHT'
  exit 0
fi
if [[ "$ACTION" == 'observation-status' ]]; then
  print_observation_state "$(observation_state)"
  echo 'status=READ_ONLY_OBSERVATION_STATUS'
  exit 0
fi

IFS='|' read -r CURRENT_REVISION CURRENT_STAGE _ CURRENT_LEGAL_GATE _ \
  CACHE_PHASE LEGAL_POLICY_REVISION CURRENT_POLICY_REFERENCE _ _ _ P0_SAFE _ \
  ACTIVE_REFRESH_READY ACTIVE_REFRESH_WORKER_CRON_READY <<<"$BEFORE"

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
    if [[ "$ROLLOUT_STAGE" != 'off' && "$ACTIVE_REFRESH_READY" != 't' ]]; then
      echo 'status=REFUSED_ACTIVE_REFRESH_WORKER_NOT_READY' >&2
      exit 70
    fi
    if [[ "$ROLLOUT_STAGE" != 'off' && "$ACTIVE_REFRESH_WORKER_CRON_READY" != 't' ]]; then
      echo 'status=REFUSED_ACTIVE_REFRESH_WORKER_CRON_NOT_READY' >&2
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
  start-observation)
    : "${EXPECTED_ROLLOUT_REVISION:?EXPECTED_ROLLOUT_REVISION is required}"
    : "${ROLLOUT_ACTOR:?ROLLOUT_ACTOR is required}"
    [[ "$EXPECTED_ROLLOUT_REVISION" =~ ^[0-9]+$ ]]
    valid_text "$ROLLOUT_ACTOR" 3 200
    if [[ "${CONFIRM_ROLLOUT_OBSERVATION:-}" != 'START_PROVIDER_ACCESS_ROLLOUT_OBSERVATION' ]]; then
      echo 'status=REFUSED_MISSING_EXPLICIT_OBSERVATION_CONFIRMATION' >&2
      exit 64
    fi
    psql_admin -v expected_revision="$EXPECTED_ROLLOUT_REVISION" \
      -v actor="$ROLLOUT_ACTOR" <<'SQL'
begin;
set local role service_role;
select public.norva_start_provider_access_rollout_observation(
  :'expected_revision'::bigint,:'actor'
);
commit;
SQL
    ;;
  restart-observation-v2)
    : "${PREDECESSOR_OBSERVATION_ID:?PREDECESSOR_OBSERVATION_ID is required}"
    : "${EXPECTED_ROLLOUT_REVISION:?EXPECTED_ROLLOUT_REVISION is required}"
    : "${ROLLOUT_ACTOR:?ROLLOUT_ACTOR is required}"
    [[ "$PREDECESSOR_OBSERVATION_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]
    [[ "$EXPECTED_ROLLOUT_REVISION" =~ ^[0-9]+$ ]]
    valid_text "$ROLLOUT_ACTOR" 3 200
    if [[ "${CONFIRM_ROLLOUT_OBSERVATION:-}" != 'RESTART_PROVIDER_ACCESS_ROLLOUT_OBSERVATION_V2' ]]; then
      echo 'status=REFUSED_MISSING_EXPLICIT_OBSERVATION_RESTART_CONFIRMATION' >&2
      exit 64
    fi
    psql_admin -v predecessor_observation_id="$PREDECESSOR_OBSERVATION_ID" \
      -v expected_revision="$EXPECTED_ROLLOUT_REVISION" \
      -v actor="$ROLLOUT_ACTOR" <<'SQL'
begin;
set local role service_role;
select public.norva_restart_provider_access_rollout_observation_v2(
  :'predecessor_observation_id'::uuid,:'expected_revision'::bigint,:'actor'
);
commit;
SQL
    ;;
  restart-observation-after-change)
    : "${PREDECESSOR_OBSERVATION_ID:?PREDECESSOR_OBSERVATION_ID is required}"
    : "${EXPECTED_ROLLOUT_REVISION:?EXPECTED_ROLLOUT_REVISION is required}"
    : "${OBSERVATION_RESTART_REASON:?OBSERVATION_RESTART_REASON is required}"
    : "${ROLLOUT_ACTOR:?ROLLOUT_ACTOR is required}"
    [[ "$PREDECESSOR_OBSERVATION_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]
    [[ "$EXPECTED_ROLLOUT_REVISION" =~ ^[0-9]+$ ]]
    valid_text "$OBSERVATION_RESTART_REASON" 12 1000
    valid_text "$ROLLOUT_ACTOR" 3 200
    if [[ "${CONFIRM_ROLLOUT_OBSERVATION:-}" != 'RESTART_PROVIDER_ACCESS_ROLLOUT_OBSERVATION_AFTER_CHANGE' ]]; then
      echo 'status=REFUSED_MISSING_EXPLICIT_MATERIAL_OBSERVATION_RESTART_CONFIRMATION' >&2
      exit 64
    fi
    psql_admin -v predecessor_observation_id="$PREDECESSOR_OBSERVATION_ID" \
      -v expected_revision="$EXPECTED_ROLLOUT_REVISION" \
      -v reason="$OBSERVATION_RESTART_REASON" \
      -v actor="$ROLLOUT_ACTOR" <<'SQL'
begin;
set local role service_role;
select public.norva_restart_provider_access_rollout_observation_after_change(
  :'predecessor_observation_id'::uuid,
  :'expected_revision'::bigint,
  :'reason',
  :'actor'
);
commit;
SQL
    ;;
  complete-observation)
    : "${OBSERVATION_ID:?OBSERVATION_ID is required}"
    : "${EXPECTED_ROLLOUT_REVISION:?EXPECTED_ROLLOUT_REVISION is required}"
    : "${OBSERVATION_EVIDENCE_REFERENCE:?OBSERVATION_EVIDENCE_REFERENCE is required}"
    : "${ROLLOUT_APPROVAL_NOTE:?ROLLOUT_APPROVAL_NOTE is required}"
    : "${ROLLOUT_ACTOR:?ROLLOUT_ACTOR is required}"
    [[ "$OBSERVATION_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]
    [[ "$EXPECTED_ROLLOUT_REVISION" =~ ^[0-9]+$ ]]
    valid_text "$OBSERVATION_EVIDENCE_REFERENCE" 12 1000
    valid_text "$ROLLOUT_APPROVAL_NOTE" 12 1000
    valid_text "$ROLLOUT_ACTOR" 3 200
    if [[ "${CONFIRM_ROLLOUT_OBSERVATION:-}" != 'COMPLETE_PROVIDER_ACCESS_ROLLOUT_OBSERVATION' ]]; then
      echo 'status=REFUSED_MISSING_EXPLICIT_OBSERVATION_CONFIRMATION' >&2
      exit 64
    fi
    psql_admin -v observation_id="$OBSERVATION_ID" \
      -v expected_revision="$EXPECTED_ROLLOUT_REVISION" \
      -v evidence_reference="$OBSERVATION_EVIDENCE_REFERENCE" \
      -v approval_note="$ROLLOUT_APPROVAL_NOTE" \
      -v actor="$ROLLOUT_ACTOR" <<'SQL'
begin;
set local role service_role;
select public.norva_complete_provider_access_rollout_observation(
  :'observation_id'::uuid,:'expected_revision'::bigint,
  :'evidence_reference',:'approval_note',:'actor'
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
  enqueue-push-readiness-smoke)
    : "${INTERNAL_USER_ID:?INTERNAL_USER_ID is required}"
    : "${EXPECTED_ROLLOUT_REVISION:?EXPECTED_ROLLOUT_REVISION is required}"
    : "${CHANNEL_READINESS_REFERENCE:?CHANNEL_READINESS_REFERENCE is required}"
    : "${ROLLOUT_ACTOR:?ROLLOUT_ACTOR is required}"
    [[ "$INTERNAL_USER_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]
    [[ "$EXPECTED_ROLLOUT_REVISION" =~ ^[0-9]+$ ]]
    valid_text "$CHANNEL_READINESS_REFERENCE" 12 1000
    valid_text "$ROLLOUT_ACTOR" 3 200
    if [[ "$CACHE_PHASE" != 'complete' || "$CURRENT_STAGE" == 'off' ]]; then
      echo 'status=REFUSED_NO_ACTIVE_CACHE_SAFE_COHORT' >&2
      exit 70
    fi
    if [[ "$CURRENT_REVISION" != "$EXPECTED_ROLLOUT_REVISION" ]]; then
      echo 'status=REFUSED_STALE_ROLLOUT_REVISION' >&2
      exit 70
    fi
    if [[ "$CURRENT_STAGE" != 'internal' ]]; then
      echo 'status=REFUSED_PUSH_READINESS_SMOKE_OUTSIDE_INTERNAL' >&2
      exit 70
    fi
    if [[ "${CONFIRM_PUSH_READINESS_SMOKE:-}" != 'ENQUEUE_PROVIDER_ACCESS_PUSH_READINESS_SMOKE' ]]; then
      echo 'status=REFUSED_MISSING_EXPLICIT_PUSH_READINESS_SMOKE_CONFIRMATION' >&2
      exit 64
    fi
    psql_admin -v user_id="$INTERNAL_USER_ID" \
      -v expected_revision="$EXPECTED_ROLLOUT_REVISION" \
      -v readiness="$CHANNEL_READINESS_REFERENCE" \
      -v actor="$ROLLOUT_ACTOR" <<'SQL'
begin;
set local role service_role;
select public.norva_enqueue_provider_access_push_readiness_smoke(
  :'user_id'::uuid,:'expected_revision'::bigint,:'readiness',:'actor'
);
commit;
SQL
    ;;
  install-notification-cron)
    if [[ "$CACHE_PHASE" != 'complete' || "$CURRENT_STAGE" == 'off' ]]; then
      echo 'status=REFUSED_NO_ACTIVE_CACHE_SAFE_COHORT' >&2
      exit 70
    fi
    if [[ "${CONFIRM_PROVIDER_CRON:-}" != 'INSTALL_PROVIDER_ACCESS_NOTIFICATION_CRON' ]]; then
      echo 'status=REFUSED_MISSING_EXPLICIT_CRON_CONFIRMATION' >&2
      exit 64
    fi
    psql_admin <<'SQL'
begin;
set local role service_role;
select public.norva_install_provider_access_notification_cron();
commit;
SQL
    ;;
  install-detection-cron)
    if [[ "$CACHE_PHASE" != 'complete' || "$CURRENT_STAGE" == 'off' ]]; then
      echo 'status=REFUSED_NO_ACTIVE_CACHE_SAFE_COHORT' >&2
      exit 70
    fi
    if [[ "${CONFIRM_PROVIDER_CRON:-}" != 'INSTALL_PROVIDER_ACCESS_DETECTION_CRON' ]]; then
      echo 'status=REFUSED_MISSING_EXPLICIT_CRON_CONFIRMATION' >&2
      exit 64
    fi
    psql_admin <<'SQL'
begin;
set local role service_role;
select public.norva_install_provider_access_check_cron();
commit;
SQL
    ;;
  remove-provider-crons)
    if [[ "${CONFIRM_PROVIDER_CRON:-}" != 'REMOVE_PROVIDER_ACCESS_CRONS' ]]; then
      echo 'status=REFUSED_MISSING_EXPLICIT_CRON_CONFIRMATION' >&2
      exit 64
    fi
    psql_admin <<'SQL'
begin;
set local role service_role;
select public.norva_remove_provider_access_crons();
commit;
SQL
    ;;
esac

readonly AFTER="$(state)"
print_state "$AFTER"
if [[ "$ACTION" == 'start-observation' || "$ACTION" == 'restart-observation-v2' || "$ACTION" == 'restart-observation-after-change' || "$ACTION" == 'complete-observation' ]]; then
  print_observation_state "$(observation_state)"
fi
echo 'status=COMPLETED'
