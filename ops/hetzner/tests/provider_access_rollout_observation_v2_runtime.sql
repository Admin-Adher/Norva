\set ON_ERROR_STOP on
begin;

select user_id as test_user_id, id as test_source_id
from public.cloud_sources
order by created_at, id
limit 1
\gset

update public.cloud_provider_access_rollout
set revision = revision + 1,
    stage = 'internal',
    cohort_basis_points = 0,
    updated_at = clock_timestamp()
where singleton
returning revision as test_revision
\gset

select set_config('norva.test.rollout_revision', :'test_revision', true);

insert into public.cloud_provider_access_rollout_internal_users(
  user_id, reason, added_by
) values (
  :'test_user_id'::uuid, 'observation v2 isolated runtime proof', 'codex-runtime-proof'
)
on conflict (user_id) do nothing;

insert into public.cloud_source_lifecycle_events(
  user_id, source_id, event_kind, idempotency_key, payload, actor, occurred_at
) values (
  :'test_user_id'::uuid,
  :'test_source_id'::uuid,
  'provider_access_cycle_started',
  'observation-v2-runtime:' || gen_random_uuid()::text,
  '{"proof":"observation-v2-runtime"}'::jsonb,
  'codex-runtime-proof',
  clock_timestamp() - interval '5 minutes'
);

insert into public.cloud_provider_access_rollout_observations(
  rollout_revision, stage, threshold_contract, minimum_window_seconds,
  started_at, activity_started_at, not_before, baseline_snapshot, started_by
) select
  :'test_revision'::bigint,
  'internal',
  'provider-access-rollout-observation:v1',
  3600,
  anchor.started_at,
  anchor.started_at,
  anchor.started_at + interval '1 hour',
  public.norva_provider_access_rollout_observation_metrics(
    anchor.started_at
  ),
  'codex-runtime-proof'
from (select clock_timestamp() - interval '10 minutes' as started_at) anchor
returning id as predecessor_id
\gset

select set_config('norva.test.predecessor_id', :'predecessor_id', true);

do $proof$
declare
  v_v1 jsonb;
  v_v2 jsonb;
begin
  v_v1 := public.norva_provider_access_rollout_observation_metrics(
    clock_timestamp() - interval '10 minutes'
  );
  v_v2 := public.norva_provider_access_rollout_observation_metrics_v2(
    clock_timestamp() - interval '10 minutes'
  );
  if (v_v1 ->> 'qualifyingActivity')::bigint <> 0 then
    raise exception 'v1 unexpectedly counted the canonical start event: %', v_v1;
  end if;
  if (v_v2 ->> 'qualifyingActivity')::bigint <> 1
     or (v_v2 ->> 'accessCycleStarted')::bigint <> 1
     or (v_v2 ->> 'schemaVersion')::integer <> 2 then
    raise exception 'v2 failed to count the canonical start event exactly once: %', v_v2;
  end if;
end
$proof$;

set local role service_role;
select
  (result ->> 'observationId') as observation_id,
  (result ->> 'notBefore') as observation_not_before
from public.norva_restart_provider_access_rollout_observation_v2(
  :'predecessor_id'::uuid,
  :'test_revision'::bigint,
  'codex-runtime-proof'
) result
\gset
reset role;

select set_config('norva.test.observation_id', :'observation_id', true);

do $proof$
declare
  v_predecessor public.cloud_provider_access_rollout_observations%rowtype;
  v_successor public.cloud_provider_access_rollout_observations%rowtype;
begin
  select * into strict v_predecessor
  from public.cloud_provider_access_rollout_observations
  where id = current_setting('norva.test.predecessor_id')::uuid;
  select * into strict v_successor
  from public.cloud_provider_access_rollout_observations
  where id = current_setting('norva.test.observation_id')::uuid;

  if v_predecessor.state <> 'stale'
     or v_predecessor.decision_reasons <> '["THRESHOLD_CONTRACT_SUPERSEDED"]'::jsonb then
    raise exception 'v1 predecessor evidence was not preserved as stale';
  end if;
  if v_successor.threshold_contract <> 'provider-access-rollout-observation:v2'
     or v_successor.supersedes_observation_id <> v_predecessor.id
     or v_successor.activity_started_at <> v_predecessor.activity_started_at
     or v_successor.not_before < v_successor.started_at + interval '1 hour'
     or (v_successor.baseline_snapshot ->> 'qualifyingActivity')::bigint <> 1 then
    raise exception 'v2 successor did not preserve activity while starting a fresh window';
  end if;
end
$proof$;

set local role service_role;
do $proof$
declare
  v_detail text;
begin
  perform public.norva_complete_provider_access_rollout_observation(
    current_setting('norva.test.observation_id')::uuid,
    current_setting('norva.test.rollout_revision')::bigint,
    'runtime-proof-before-window',
    'must refuse before the fresh v2 window completes',
    'codex-runtime-proof'
  );
  raise exception 'v2 completion unexpectedly succeeded before not_before';
exception
  when sqlstate '55000' then
    get stacked diagnostics v_detail = pg_exception_detail;
    if position('reason=observation_window' in coalesce(v_detail, '')) = 0 then
      raise;
    end if;
end
$proof$;
reset role;

do $proof$
declare
  v_detail text;
begin
  update public.cloud_provider_access_rollout
  set stage = '1_percent', revision = revision + 1, updated_at = clock_timestamp()
  where singleton;
  raise exception 'promotion unexpectedly accepted a collecting v2 observation';
exception
  when sqlstate '55000' then
    get stacked diagnostics v_detail = pg_exception_detail;
    if position('reason=observation_missing' in coalesce(v_detail, '')) = 0 then
      raise;
    end if;
end
$proof$;

select 'provider_access_rollout_observation_v2_runtime' as proof, 'PASS' as result;
rollback;
