begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

do $deployment_role$
begin
  if current_user <> 'supabase_admin'
     or not coalesce((
       select role.rolsuper
       from pg_roles role
       where role.rolname = current_user
     ), false) then
    raise exception 'provider access material observation restart requires supabase_admin'
      using errcode = '42501';
  end if;
end
$deployment_role$;

select pg_advisory_xact_lock(hashtextextended(
  'norva:provider-access-rollout-material-observation-restart:v1',
  0
));

alter table public.cloud_provider_access_rollout_observations
  add column restart_reason text,
  add constraint cloud_provider_access_rollout_observation_restart_reason_ck
    check (
      restart_reason is null
      or length(btrim(restart_reason)) between 12 and 1000
    );

create or replace function public.norva_restart_provider_access_rollout_observation_after_change(
  p_predecessor_observation_id uuid,
  p_expected_revision bigint,
  p_reason text,
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
  v_started_at timestamptz;
  v_not_before timestamptz;
  v_snapshot jsonb;
begin
  perform public.norva_provider_access_service_role_required();
  if p_predecessor_observation_id is null
     or p_expected_revision is null
     or length(btrim(coalesce(p_reason, ''))) not between 12 and 1000
     or length(btrim(coalesce(p_actor, ''))) not between 3 and 200 then
    raise exception 'invalid material observation restart request'
      using errcode = '22023';
  end if;

  -- Serialize every observation mutation behind the rollout singleton first.
  -- This lock order matches start/complete/promotion and makes a concurrent
  -- retry observe the winner's committed predecessor state.
  select * into strict v_rollout
  from public.cloud_provider_access_rollout
  where singleton
  for update;

  if v_rollout.revision <> p_expected_revision then
    raise exception 'stale rollout revision'
      using errcode = 'PT409', detail = 'reason=stale';
  end if;
  if v_rollout.stage = 'off' then
    raise exception 'rollout observation requires an active cohort'
      using errcode = '55000', detail = 'reason=rollout_off';
  end if;

  select * into v_predecessor
  from public.cloud_provider_access_rollout_observations
  where id = p_predecessor_observation_id
  for update;

  if v_predecessor.id is null
     or v_predecessor.state <> 'collecting'
     or v_predecessor.threshold_contract <> 'provider-access-rollout-observation:v2'
     or v_predecessor.rollout_revision <> v_rollout.revision
     or v_predecessor.stage <> v_rollout.stage then
    raise exception 'stale rollout observation predecessor'
      using errcode = 'PT409', detail = 'reason=stale_observation';
  end if;

  -- Take the time boundary only after both durable rows are locked. Time spent
  -- waiting for a concurrent transaction can never shorten the new window.
  v_started_at := clock_timestamp();
  v_window_seconds := public.norva_provider_access_rollout_observation_window_seconds(
    v_rollout.stage
  );
  if v_window_seconds is null then
    raise exception 'rollout observation stage has no window'
      using errcode = '55000', detail = 'reason=observation_window_missing';
  end if;
  v_not_before := v_started_at + (v_window_seconds * interval '1 second');
  if v_not_before < v_started_at + make_interval(secs => v_window_seconds) then
    raise exception 'rollout observation window calculation is inconsistent'
      using errcode = '55000', detail = 'reason=observation_window_invalid';
  end if;
  v_snapshot := public.norva_provider_access_rollout_observation_metrics_v2(
    v_started_at
  );
  if coalesce((v_snapshot #>> '{p0,active}')::boolean, false) then
    raise exception 'provider access rollout blocked by staging visibility violation'
      using errcode = 'P0001',
            detail = 'code=STAGING_VISIBILITY_VIOLATION;severity=P0';
  end if;

  update public.cloud_provider_access_rollout_observations
  set state = 'stale',
      decision_reasons = '["MATERIAL_CHANGE_RESTART"]'::jsonb,
      updated_at = v_started_at
  where id = v_predecessor.id
    and state = 'collecting'
    and threshold_contract = 'provider-access-rollout-observation:v2'
    and rollout_revision = v_rollout.revision
    and stage = v_rollout.stage;
  if not found then
    raise exception 'stale rollout observation predecessor'
      using errcode = 'PT409', detail = 'reason=stale_observation';
  end if;

  insert into public.cloud_provider_access_rollout_observations(
    rollout_revision,
    stage,
    threshold_contract,
    minimum_window_seconds,
    started_at,
    activity_started_at,
    not_before,
    baseline_snapshot,
    started_by,
    supersedes_observation_id,
    restart_reason
  ) values (
    v_rollout.revision,
    v_rollout.stage,
    'provider-access-rollout-observation:v2',
    v_window_seconds,
    v_started_at,
    v_started_at,
    v_not_before,
    v_snapshot,
    btrim(p_actor),
    v_predecessor.id,
    btrim(p_reason)
  ) returning * into v_observation;

  return jsonb_build_object(
    'observationId', v_observation.id,
    'supersedesObservationId', v_predecessor.id,
    'predecessorState', 'stale',
    'rolloutRevision', v_observation.rollout_revision,
    'stage', v_observation.stage,
    'state', v_observation.state,
    'startedAt', v_observation.started_at,
    'activityStartedAt', v_observation.activity_started_at,
    'notBefore', v_observation.not_before,
    'minimumWindowSeconds', v_observation.minimum_window_seconds,
    'thresholdContract', v_observation.threshold_contract,
    'restartReason', v_observation.restart_reason,
    'baselineSnapshot', v_observation.baseline_snapshot
  );
end
$function$;

revoke all on function
  public.norva_restart_provider_access_rollout_observation_after_change(
    uuid,bigint,text,text
  )
  from public, anon, authenticated, service_role;
grant execute on function
  public.norva_restart_provider_access_rollout_observation_after_change(
    uuid,bigint,text,text
  )
  to service_role;

comment on column public.cloud_provider_access_rollout_observations.restart_reason is
  'Operator-supplied durable reason for replacing a collecting v2 observation after a material production change.';
comment on function public.norva_restart_provider_access_rollout_observation_after_change(uuid,bigint,text,text) is
  'Atomically stales one collecting v2 predecessor and starts one full fresh v2 window and activity boundary after a material change; concurrent losers receive PT409.';

notify pgrst, 'reload schema';
commit;
