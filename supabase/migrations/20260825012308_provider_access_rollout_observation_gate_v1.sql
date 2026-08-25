begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- A cohort may only grow after the exact current rollout revision has survived
-- a durable observation window. Channel changes increment the rollout revision,
-- which deliberately invalidates any proof collected before that change.
create table public.cloud_provider_access_rollout_observations (
  id uuid primary key default gen_random_uuid(),
  rollout_revision bigint not null check (rollout_revision > 0),
  stage text not null check (stage in (
    'internal','1_percent','5_percent','20_percent','50_percent','100_percent'
  )),
  state text not null default 'collecting' check (state in (
    'collecting','accepted','rejected','stale'
  )),
  threshold_contract text not null
    check (threshold_contract = 'provider-access-rollout-observation:v1'),
  minimum_window_seconds integer not null
    check (minimum_window_seconds between 60 and 604800),
  started_at timestamptz not null default clock_timestamp(),
  not_before timestamptz not null,
  completed_at timestamptz,
  baseline_snapshot jsonb not null check (jsonb_typeof(baseline_snapshot) = 'object'),
  final_snapshot jsonb check (
    final_snapshot is null or jsonb_typeof(final_snapshot) = 'object'
  ),
  decision_reasons jsonb not null default '[]'::jsonb check (
    jsonb_typeof(decision_reasons) = 'array'
  ),
  evidence_reference text check (
    evidence_reference is null
    or length(btrim(evidence_reference)) between 12 and 1000
  ),
  approval_note text check (
    approval_note is null or length(btrim(approval_note)) between 12 and 1000
  ),
  started_by text not null check (length(btrim(started_by)) between 3 and 200),
  completed_by text check (
    completed_by is null or length(btrim(completed_by)) between 3 and 200
  ),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint cloud_provider_access_rollout_observation_completion_ck check (
    (state in ('collecting','stale') and completed_at is null)
    or (state in ('accepted','rejected') and completed_at is not null)
  ),
  constraint cloud_provider_access_rollout_observation_decision_ck check (
    (state in ('collecting','stale') and final_snapshot is null
      and evidence_reference is null and approval_note is null and completed_by is null)
    or (state in ('accepted','rejected') and final_snapshot is not null
      and evidence_reference is not null and approval_note is not null and completed_by is not null)
  )
);

create unique index cloud_provider_access_rollout_observations_collecting_uidx
  on public.cloud_provider_access_rollout_observations (rollout_revision)
  where state = 'collecting';
create unique index cloud_provider_access_rollout_observations_accepted_uidx
  on public.cloud_provider_access_rollout_observations (rollout_revision)
  where state = 'accepted';
create index cloud_provider_access_rollout_observations_stage_started_idx
  on public.cloud_provider_access_rollout_observations (stage, started_at desc);

alter table public.cloud_provider_access_rollout_observations enable row level security;
revoke all on table public.cloud_provider_access_rollout_observations
  from public, anon, authenticated, service_role;
grant select on table public.cloud_provider_access_rollout_observations
  to service_role;

-- SECURITY DEFINER RPCs own every mutation. Keeping direct service-role DML
-- here would let a caller bypass revision CAS, ordered stage transitions,
-- observation evidence or the append-only audit records.
revoke insert, update, delete on table
  public.cloud_provider_access_rollout,
  public.cloud_provider_access_rollout_internal_users,
  public.cloud_provider_access_rollout_events,
  public.cloud_provider_access_rollout_channel_events
  from service_role;
grant select on table
  public.cloud_provider_access_rollout,
  public.cloud_provider_access_rollout_internal_users,
  public.cloud_provider_access_rollout_events,
  public.cloud_provider_access_rollout_channel_events
  to service_role;

create or replace function public.norva_provider_access_rollout_observation_window_seconds(
  p_stage text
) returns integer
language sql
immutable
security invoker
set search_path = ''
as $function$
  select case p_stage
    when 'internal' then 3600
    when '1_percent' then 21600
    when '5_percent' then 43200
    when '20_percent' then 86400
    when '50_percent' then 172800
    when '100_percent' then 259200
    else null
  end;
$function$;

create or replace function public.norva_provider_access_rollout_observation_metrics(
  p_started_at timestamptz
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_p0_count bigint;
  v_replacements_started bigint;
  v_replacements_completed bigint;
  v_replacements_failed bigint;
  v_credential_swaps_completed bigint;
  v_credential_rollbacks bigint;
  v_notifications_delivered bigint;
  v_notifications_dead_letter bigint;
  v_access_updates bigint;
  v_qualifying_activity bigint;
  v_replacement_failure_rate numeric;
  v_credential_rollback_rate numeric;
  v_notification_dead_letter_rate numeric;
begin
  if p_started_at is null or p_started_at > clock_timestamp() then
    raise exception 'invalid rollout observation start'
      using errcode = '22023';
  end if;

  select count(*) into v_p0_count
  from (
    select lifecycle.source_id
    from public.cloud_source_lifecycle lifecycle
    where lifecycle.lifecycle_state = 'staging'
      and lifecycle.catalog_visibility <> 'hidden'
    union
    select transition.candidate_source_id
    from public.cloud_source_transitions transition
    join public.cloud_source_lifecycle lifecycle
      on lifecycle.source_id = transition.candidate_source_id
     and lifecycle.user_id = transition.user_id
    where transition.transition_kind = 'replacement'
      and transition.state not in ('completed','failed','cancelled')
      and lifecycle.catalog_visibility <> 'hidden'
  ) violation;

  select
    count(*) filter (where transition.transition_kind = 'replacement'),
    count(*) filter (
      where transition.transition_kind = 'replacement'
        and transition.state = 'completed'
    ),
    count(*) filter (
      where transition.transition_kind = 'replacement'
        and transition.state = 'failed'
    )
  into v_replacements_started, v_replacements_completed, v_replacements_failed
  from public.cloud_source_transitions transition
  where transition.started_at >= p_started_at
    and public.norva_provider_access_rollout_eligible_internal(transition.user_id);

  select
    count(*) filter (where event.event_kind = 'credential_transition_completed'),
    count(*) filter (where event.event_kind = 'credential_compensation_completed'),
    count(*) filter (where event.event_kind in (
      'provider_access_cycle_created',
      'provider_access_cycle_updated',
      'provider_access_cycle_extended'
    ))
  into v_credential_swaps_completed, v_credential_rollbacks, v_access_updates
  from public.cloud_source_lifecycle_events event
  where event.occurred_at >= p_started_at
    and public.norva_provider_access_rollout_eligible_internal(event.user_id);

  select
    count(*) filter (
      where notification.channel in ('email','push')
        and notification.state = 'delivered'
    ),
    count(*) filter (
      where notification.channel in ('email','push')
        and notification.state = 'dead_letter'
    )
  into v_notifications_delivered, v_notifications_dead_letter
  from public.cloud_provider_access_notifications notification
  where notification.created_at >= p_started_at
    and public.norva_provider_access_rollout_eligible_internal(notification.user_id);

  v_replacement_failure_rate := case
    when v_replacements_started = 0 then 0
    else v_replacements_failed::numeric / v_replacements_started::numeric
  end;
  v_credential_rollback_rate := case
    when v_credential_swaps_completed = 0 then
      case when v_credential_rollbacks = 0 then 0 else 1 end
    else v_credential_rollbacks::numeric / v_credential_swaps_completed::numeric
  end;
  v_notification_dead_letter_rate := case
    when v_notifications_delivered + v_notifications_dead_letter = 0 then 0
    else v_notifications_dead_letter::numeric
      / (v_notifications_delivered + v_notifications_dead_letter)::numeric
  end;
  v_qualifying_activity := v_access_updates
    + v_credential_swaps_completed
    + v_replacements_completed
    + v_notifications_delivered;

  return jsonb_build_object(
    'schemaVersion', 1,
    'generatedAt', clock_timestamp(),
    'startedAt', p_started_at,
    'p0', jsonb_build_object(
      'stagingVisibilityViolation', v_p0_count,
      'active', v_p0_count > 0
    ),
    'replacement', jsonb_build_object(
      'started', v_replacements_started,
      'completed', v_replacements_completed,
      'failed', v_replacements_failed,
      'failureRate', v_replacement_failure_rate
    ),
    'credentials', jsonb_build_object(
      'completed', v_credential_swaps_completed,
      'rolledBack', v_credential_rollbacks,
      'rollbackRate', v_credential_rollback_rate
    ),
    'notifications', jsonb_build_object(
      'delivered', v_notifications_delivered,
      'deadLetter', v_notifications_dead_letter,
      'deadLetterRate', v_notification_dead_letter_rate
    ),
    'accessUpdates', v_access_updates,
    'qualifyingActivity', v_qualifying_activity,
    'thresholds', jsonb_build_object(
      'minimumQualifyingActivity', 1,
      'maximumReplacementFailureRate', 0.02,
      'maximumCredentialRollbackRate', 0.05,
      'maximumNotificationDeadLetterRate', 0.01,
      'maximumStagingVisibilityViolation', 0
    )
  );
end
$function$;

create or replace function public.norva_start_provider_access_rollout_observation(
  p_expected_revision bigint,
  p_actor text
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_rollout public.cloud_provider_access_rollout%rowtype;
  v_window_seconds integer;
  v_started_at timestamptz := clock_timestamp();
  v_snapshot jsonb;
  v_observation public.cloud_provider_access_rollout_observations%rowtype;
begin
  perform public.norva_provider_access_service_role_required();
  if p_expected_revision is null
     or length(btrim(coalesce(p_actor,''))) not between 3 and 200 then
    raise exception 'invalid rollout observation request' using errcode = '22023';
  end if;

  select * into strict v_rollout
  from public.cloud_provider_access_rollout
  where singleton
  for update;
  if v_rollout.revision <> p_expected_revision then
    raise exception 'stale rollout revision'
      using errcode = '40001', detail = 'reason=stale';
  end if;
  if v_rollout.stage = 'off' then
    raise exception 'rollout observation requires an active cohort'
      using errcode = '55000', detail = 'reason=rollout_off';
  end if;
  if exists (
    select 1
    from public.cloud_provider_access_rollout_observations observation
    where observation.rollout_revision = v_rollout.revision
      and observation.state = 'collecting'
  ) then
    raise exception 'rollout observation already collecting'
      using errcode = '40001', detail = 'reason=observation_exists';
  end if;

  v_window_seconds := public.norva_provider_access_rollout_observation_window_seconds(
    v_rollout.stage
  );
  v_snapshot := public.norva_provider_access_rollout_observation_metrics(v_started_at);
  if coalesce((v_snapshot #>> '{p0,active}')::boolean, false) then
    raise exception 'provider access rollout blocked by staging visibility violation'
      using errcode = 'P0001', detail = 'code=STAGING_VISIBILITY_VIOLATION;severity=P0';
  end if;

  insert into public.cloud_provider_access_rollout_observations(
    rollout_revision, stage, threshold_contract, minimum_window_seconds,
    started_at, not_before, baseline_snapshot, started_by
  ) values (
    v_rollout.revision, v_rollout.stage,
    'provider-access-rollout-observation:v1', v_window_seconds,
    v_started_at, v_started_at + make_interval(secs => v_window_seconds),
    v_snapshot, btrim(p_actor)
  ) returning * into v_observation;

  return jsonb_build_object(
    'observationId', v_observation.id,
    'rolloutRevision', v_observation.rollout_revision,
    'stage', v_observation.stage,
    'state', v_observation.state,
    'startedAt', v_observation.started_at,
    'notBefore', v_observation.not_before,
    'minimumWindowSeconds', v_observation.minimum_window_seconds,
    'thresholdContract', v_observation.threshold_contract
  );
end
$function$;

create or replace function public.norva_complete_provider_access_rollout_observation(
  p_observation_id uuid,
  p_expected_revision bigint,
  p_evidence_reference text,
  p_approval_note text,
  p_actor text
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_rollout public.cloud_provider_access_rollout%rowtype;
  v_observation public.cloud_provider_access_rollout_observations%rowtype;
  v_snapshot jsonb;
  v_reasons text[] := array[]::text[];
  v_accepted boolean;
begin
  perform public.norva_provider_access_service_role_required();
  if p_observation_id is null or p_expected_revision is null
     or length(btrim(coalesce(p_evidence_reference,''))) not between 12 and 1000
     or length(btrim(coalesce(p_approval_note,''))) not between 12 and 1000
     or length(btrim(coalesce(p_actor,''))) not between 3 and 200 then
    raise exception 'invalid rollout observation decision' using errcode = '22023';
  end if;

  select * into strict v_rollout
  from public.cloud_provider_access_rollout
  where singleton
  for update;
  if v_rollout.revision <> p_expected_revision then
    raise exception 'stale rollout revision'
      using errcode = '40001', detail = 'reason=stale';
  end if;

  select * into strict v_observation
  from public.cloud_provider_access_rollout_observations
  where id = p_observation_id
  for update;
  if v_observation.state <> 'collecting'
     or v_observation.rollout_revision <> v_rollout.revision
     or v_observation.stage <> v_rollout.stage then
    raise exception 'stale rollout observation'
      using errcode = '40001', detail = 'reason=stale_observation';
  end if;
  if clock_timestamp() < v_observation.not_before then
    raise exception 'rollout observation window is incomplete'
      using errcode = '55000',
            detail = 'reason=observation_window;not_before=' || v_observation.not_before::text;
  end if;

  v_snapshot := public.norva_provider_access_rollout_observation_metrics(
    v_observation.started_at
  );
  if coalesce((v_snapshot #>> '{p0,stagingVisibilityViolation}')::bigint, 0) > 0 then
    v_reasons := array_append(v_reasons, 'STAGING_VISIBILITY_VIOLATION');
  end if;
  if coalesce((v_snapshot ->> 'qualifyingActivity')::bigint, 0) < 1 then
    v_reasons := array_append(v_reasons, 'INSUFFICIENT_QUALIFYING_ACTIVITY');
  end if;
  if coalesce((v_snapshot #>> '{replacement,failureRate}')::numeric, 0) > 0.02 then
    v_reasons := array_append(v_reasons, 'REPLACEMENT_FAILURE_RATE_EXCEEDED');
  end if;
  if coalesce((v_snapshot #>> '{credentials,rollbackRate}')::numeric, 0) > 0.05 then
    v_reasons := array_append(v_reasons, 'CREDENTIAL_ROLLBACK_RATE_EXCEEDED');
  end if;
  if coalesce((v_snapshot #>> '{notifications,deadLetterRate}')::numeric, 0) > 0.01 then
    v_reasons := array_append(v_reasons, 'NOTIFICATION_DEAD_LETTER_RATE_EXCEEDED');
  end if;
  v_accepted := cardinality(v_reasons) = 0;

  update public.cloud_provider_access_rollout_observations
  set state = case when v_accepted then 'accepted' else 'rejected' end,
      completed_at = clock_timestamp(),
      final_snapshot = v_snapshot,
      decision_reasons = to_jsonb(v_reasons),
      evidence_reference = btrim(p_evidence_reference),
      approval_note = btrim(p_approval_note),
      completed_by = btrim(p_actor),
      updated_at = clock_timestamp()
  where id = v_observation.id;

  return jsonb_build_object(
    'observationId', v_observation.id,
    'rolloutRevision', v_observation.rollout_revision,
    'stage', v_observation.stage,
    'state', case when v_accepted then 'accepted' else 'rejected' end,
    'accepted', v_accepted,
    'decisionReasons', to_jsonb(v_reasons),
    'snapshot', v_snapshot
  );
end
$function$;

create or replace function public.norva_provider_access_rollout_observation_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_old_rank integer;
  v_new_rank integer;
begin
  if new.revision <> old.revision then
    update public.cloud_provider_access_rollout_observations
    set state = 'stale', updated_at = clock_timestamp()
    where rollout_revision = old.revision and state = 'collecting';
  end if;

  v_old_rank := array_position(
    array['off','internal','1_percent','5_percent','20_percent','50_percent','100_percent'],
    old.stage
  );
  v_new_rank := array_position(
    array['off','internal','1_percent','5_percent','20_percent','50_percent','100_percent'],
    new.stage
  );
  if v_new_rank > v_old_rank and old.stage <> 'off' and not exists (
    select 1
    from public.cloud_provider_access_rollout_observations observation
    where observation.rollout_revision = old.revision
      and observation.stage = old.stage
      and observation.state = 'accepted'
  ) then
    raise exception 'rollout stage lacks an accepted observation'
      using errcode = '55000', detail = 'reason=observation_missing';
  end if;
  return new;
end
$function$;

create trigger cloud_provider_access_rollout_00_observation_guard
before update on public.cloud_provider_access_rollout
for each row execute function public.norva_provider_access_rollout_observation_guard();

revoke all on function
  public.norva_provider_access_rollout_observation_window_seconds(text),
  public.norva_provider_access_rollout_observation_metrics(timestamptz),
  public.norva_start_provider_access_rollout_observation(bigint,text),
  public.norva_complete_provider_access_rollout_observation(uuid,bigint,text,text,text),
  public.norva_provider_access_rollout_observation_guard()
  from public, anon, authenticated, service_role;
grant execute on function
  public.norva_start_provider_access_rollout_observation(bigint,text),
  public.norva_complete_provider_access_rollout_observation(uuid,bigint,text,text,text)
  to service_role;

comment on table public.cloud_provider_access_rollout_observations is
  'Durable Phase 16 observation decisions bound to one exact rollout revision and cohort stage.';
comment on function public.norva_complete_provider_access_rollout_observation(uuid,bigint,text,text,text) is
  'Accepts a rollout observation only after its time gate, real qualifying activity, zero P0 and versioned failure-rate thresholds.';

commit;
