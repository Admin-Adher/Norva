begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- v1 omitted the canonical create event provider_access_cycle_started. Keep v1
-- evidence immutable, but require v2 for every future rollout promotion.
alter table public.cloud_provider_access_rollout_observations
  drop constraint cloud_provider_access_rollout_observat_threshold_contract_check;
alter table public.cloud_provider_access_rollout_observations
  add constraint cloud_provider_access_rollout_observat_threshold_contract_check
  check (threshold_contract in (
    'provider-access-rollout-observation:v1',
    'provider-access-rollout-observation:v2'
  ));

alter table public.cloud_provider_access_rollout_observations
  add column activity_started_at timestamptz,
  add column supersedes_observation_id uuid;

update public.cloud_provider_access_rollout_observations
set activity_started_at = started_at
where activity_started_at is null;

alter table public.cloud_provider_access_rollout_observations
  alter column activity_started_at set not null,
  add constraint cloud_provider_access_rollout_observation_activity_window_ck
    check (activity_started_at <= started_at),
  add constraint cloud_provider_access_rollout_observation_fresh_window_ck
    check (
      not_before >= started_at + make_interval(secs => minimum_window_seconds)
    ),
  add constraint cloud_provider_access_rollout_observation_supersedes_fk
    foreign key (supersedes_observation_id)
    references public.cloud_provider_access_rollout_observations(id),
  add constraint cloud_provider_access_rollout_observation_supersedes_self_ck
    check (supersedes_observation_id is null or supersedes_observation_id <> id),
  add constraint cloud_provider_access_rollout_observation_supersedes_uidx
    unique (supersedes_observation_id);

create or replace function public.norva_provider_access_rollout_observation_metrics_v2(
  p_activity_started_at timestamptz
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_snapshot jsonb;
  v_access_started bigint;
  v_access_updates bigint;
  v_qualifying_activity bigint;
begin
  v_snapshot := public.norva_provider_access_rollout_observation_metrics(
    p_activity_started_at
  );

  select count(*) into v_access_started
  from public.cloud_source_lifecycle_events event
  where event.event_kind = 'provider_access_cycle_started'
    and event.occurred_at >= p_activity_started_at
    and public.norva_provider_access_rollout_eligible_internal(event.user_id);

  v_access_updates := coalesce((v_snapshot ->> 'accessUpdates')::bigint, 0)
    + v_access_started;
  v_qualifying_activity := coalesce(
    (v_snapshot ->> 'qualifyingActivity')::bigint,
    0
  ) + v_access_started;

  v_snapshot := jsonb_set(v_snapshot, '{schemaVersion}', '2'::jsonb, true);
  v_snapshot := jsonb_set(
    v_snapshot,
    '{activityStartedAt}',
    to_jsonb(p_activity_started_at),
    true
  );
  v_snapshot := jsonb_set(
    v_snapshot,
    '{accessCycleStarted}',
    to_jsonb(v_access_started),
    true
  );
  v_snapshot := jsonb_set(
    v_snapshot,
    '{accessUpdates}',
    to_jsonb(v_access_updates),
    true
  );
  v_snapshot := jsonb_set(
    v_snapshot,
    '{qualifyingActivity}',
    to_jsonb(v_qualifying_activity),
    true
  );
  v_snapshot := jsonb_set(
    v_snapshot,
    '{countedAccessEventKinds}',
    to_jsonb(array[
      'provider_access_cycle_started',
      'provider_access_cycle_created',
      'provider_access_cycle_updated',
      'provider_access_cycle_extended'
    ]::text[]),
    true
  );
  return v_snapshot;
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
    select 1 from public.cloud_provider_access_rollout_observations observation
    where observation.rollout_revision = v_rollout.revision
      and observation.state = 'collecting'
  ) then
    raise exception 'rollout observation already collecting'
      using errcode = '40001', detail = 'reason=observation_exists';
  end if;

  v_window_seconds := public.norva_provider_access_rollout_observation_window_seconds(
    v_rollout.stage
  );
  v_snapshot := public.norva_provider_access_rollout_observation_metrics_v2(v_started_at);
  if coalesce((v_snapshot #>> '{p0,active}')::boolean, false) then
    raise exception 'provider access rollout blocked by staging visibility violation'
      using errcode = 'P0001', detail = 'code=STAGING_VISIBILITY_VIOLATION;severity=P0';
  end if;

  insert into public.cloud_provider_access_rollout_observations(
    rollout_revision, stage, threshold_contract, minimum_window_seconds,
    started_at, activity_started_at, not_before, baseline_snapshot, started_by
  ) values (
    v_rollout.revision, v_rollout.stage,
    'provider-access-rollout-observation:v2', v_window_seconds,
    v_started_at, v_started_at,
    v_started_at + make_interval(secs => v_window_seconds),
    v_snapshot, btrim(p_actor)
  ) returning * into v_observation;

  return jsonb_build_object(
    'observationId', v_observation.id,
    'rolloutRevision', v_observation.rollout_revision,
    'stage', v_observation.stage,
    'state', v_observation.state,
    'startedAt', v_observation.started_at,
    'activityStartedAt', v_observation.activity_started_at,
    'notBefore', v_observation.not_before,
    'minimumWindowSeconds', v_observation.minimum_window_seconds,
    'thresholdContract', v_observation.threshold_contract
  );
end
$function$;

create or replace function public.norva_restart_provider_access_rollout_observation_v2(
  p_predecessor_observation_id uuid,
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
  v_predecessor public.cloud_provider_access_rollout_observations%rowtype;
  v_observation public.cloud_provider_access_rollout_observations%rowtype;
  v_window_seconds integer;
  v_started_at timestamptz := clock_timestamp();
  v_snapshot jsonb;
begin
  perform public.norva_provider_access_service_role_required();
  if p_predecessor_observation_id is null or p_expected_revision is null
     or length(btrim(coalesce(p_actor,''))) not between 3 and 200 then
    raise exception 'invalid rollout observation restart' using errcode = '22023';
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

  select * into strict v_predecessor
  from public.cloud_provider_access_rollout_observations
  where id = p_predecessor_observation_id
  for update;
  if v_predecessor.state <> 'collecting'
     or v_predecessor.threshold_contract <> 'provider-access-rollout-observation:v1'
     or v_predecessor.rollout_revision <> v_rollout.revision
     or v_predecessor.stage <> v_rollout.stage then
    raise exception 'stale rollout observation predecessor'
      using errcode = '40001', detail = 'reason=stale_observation';
  end if;

  v_window_seconds := public.norva_provider_access_rollout_observation_window_seconds(
    v_rollout.stage
  );
  v_snapshot := public.norva_provider_access_rollout_observation_metrics_v2(
    v_predecessor.activity_started_at
  );
  if coalesce((v_snapshot #>> '{p0,active}')::boolean, false) then
    raise exception 'provider access rollout blocked by staging visibility violation'
      using errcode = 'P0001', detail = 'code=STAGING_VISIBILITY_VIOLATION;severity=P0';
  end if;

  update public.cloud_provider_access_rollout_observations
  set state = 'stale',
      decision_reasons = '["THRESHOLD_CONTRACT_SUPERSEDED"]'::jsonb,
      updated_at = clock_timestamp()
  where id = v_predecessor.id and state = 'collecting';
  if not found then
    raise exception 'stale rollout observation predecessor'
      using errcode = '40001', detail = 'reason=stale_observation';
  end if;

  insert into public.cloud_provider_access_rollout_observations(
    rollout_revision, stage, threshold_contract, minimum_window_seconds,
    started_at, activity_started_at, not_before, baseline_snapshot, started_by,
    supersedes_observation_id
  ) values (
    v_rollout.revision, v_rollout.stage,
    'provider-access-rollout-observation:v2', v_window_seconds,
    v_started_at, v_predecessor.activity_started_at,
    v_started_at + make_interval(secs => v_window_seconds),
    v_snapshot, btrim(p_actor), v_predecessor.id
  ) returning * into v_observation;

  return jsonb_build_object(
    'observationId', v_observation.id,
    'supersedesObservationId', v_predecessor.id,
    'rolloutRevision', v_observation.rollout_revision,
    'stage', v_observation.stage,
    'state', v_observation.state,
    'startedAt', v_observation.started_at,
    'activityStartedAt', v_observation.activity_started_at,
    'notBefore', v_observation.not_before,
    'minimumWindowSeconds', v_observation.minimum_window_seconds,
    'thresholdContract', v_observation.threshold_contract,
    'baselineSnapshot', v_observation.baseline_snapshot
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
  if v_observation.threshold_contract <> 'provider-access-rollout-observation:v2' then
    raise exception 'rollout observation threshold contract is superseded'
      using errcode = '55000', detail = 'reason=threshold_contract_superseded';
  end if;
  if clock_timestamp() < v_observation.not_before then
    raise exception 'rollout observation window is incomplete'
      using errcode = '55000',
            detail = 'reason=observation_window;not_before=' || v_observation.not_before::text;
  end if;

  v_snapshot := public.norva_provider_access_rollout_observation_metrics_v2(
    v_observation.activity_started_at
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
      completed_at = clock_timestamp(), final_snapshot = v_snapshot,
      decision_reasons = to_jsonb(v_reasons),
      evidence_reference = btrim(p_evidence_reference),
      approval_note = btrim(p_approval_note), completed_by = btrim(p_actor),
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

-- Only a v2 decision may authorize a future cohort promotion. Historical v1
-- rows remain queryable, but cannot satisfy a current promotion gate.
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
      and observation.threshold_contract = 'provider-access-rollout-observation:v2'
  ) then
    raise exception 'rollout stage lacks an accepted observation'
      using errcode = '55000', detail = 'reason=observation_missing';
  end if;
  return new;
end
$function$;

revoke all on function
  public.norva_provider_access_rollout_observation_metrics_v2(timestamptz),
  public.norva_restart_provider_access_rollout_observation_v2(uuid,bigint,text)
  from public, anon, authenticated, service_role;
grant execute on function
  public.norva_restart_provider_access_rollout_observation_v2(uuid,bigint,text)
  to service_role;

comment on column public.cloud_provider_access_rollout_observations.activity_started_at is
  'Inclusive metrics boundary. A v2 restart may retain a predecessor boundary while started_at begins a fresh full observation window.';
comment on column public.cloud_provider_access_rollout_observations.supersedes_observation_id is
  'Immutable link to a superseded collecting observation; predecessor evidence is never rewritten.';
comment on function public.norva_provider_access_rollout_observation_metrics_v2(timestamptz) is
  'Version 2 metrics count the canonical provider_access_cycle_started event in addition to legacy access-cycle events.';
comment on function public.norva_restart_provider_access_rollout_observation_v2(uuid,bigint,text) is
  'Atomically stales one collecting v1 observation and starts a distinct v2 observation with a fresh full time window and continuous activity boundary.';

commit;
