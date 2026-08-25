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

insert into public.cloud_provider_access_rollout_internal_users(
  user_id, reason, added_by
) values (
  :'test_user_id'::uuid, 'observation v1 to v2 upgrade fixture', 'codex-upgrade-proof'
)
on conflict (user_id) do nothing;

set local role service_role;
select result ->> 'observationId' as predecessor_id
from public.norva_start_provider_access_rollout_observation(
  :'test_revision'::bigint,
  'codex-upgrade-proof'
) result
\gset
reset role;

insert into public.cloud_source_lifecycle_events(
  user_id, source_id, event_kind, idempotency_key, payload, actor, occurred_at
) values (
  :'test_user_id'::uuid,
  :'test_source_id'::uuid,
  'provider_access_cycle_started',
  'observation-v2-upgrade:' || gen_random_uuid()::text,
  '{"proof":"observation-v2-upgrade"}'::jsonb,
  'codex-upgrade-proof',
  clock_timestamp()
);

commit;

select :'predecessor_id' as predecessor_id, :'test_revision' as rollout_revision;
