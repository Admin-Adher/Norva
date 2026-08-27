begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select extensions.plan(15);

select extensions.has_table(
  'public','cloud_provider_access_rollout_observations',
  'durable rollout observations are installed'
);
select extensions.has_function(
  'public','norva_start_provider_access_rollout_observation',array['bigint','text'],
  'observation start RPC is installed'
);
select extensions.has_function(
  'public','norva_complete_provider_access_rollout_observation',
  array['uuid','bigint','text','text','text'],
  'observation completion RPC is installed'
);
select extensions.has_function(
  'public','norva_restart_provider_access_rollout_observation_after_change',
  array['uuid','bigint','text','text'],
  'material-change observation restart RPC is installed'
);
select extensions.has_column(
  'public','cloud_provider_access_rollout_observations','restart_reason',
  'material restart reason is durable'
);
select extensions.has_trigger(
  'public','cloud_provider_access_rollout',
  'cloud_provider_access_rollout_00_observation_guard',
  'rollout table has the observation promotion guard'
);
select extensions.ok(
  has_table_privilege('service_role','public.cloud_provider_access_rollout','SELECT')
  and not has_table_privilege('service_role','public.cloud_provider_access_rollout','INSERT')
  and not has_table_privilege('service_role','public.cloud_provider_access_rollout','UPDATE')
  and not has_table_privilege('service_role','public.cloud_provider_access_rollout','DELETE'),
  'service role can inspect but cannot mutate the rollout table directly'
);
select extensions.ok(
  has_table_privilege('service_role','public.cloud_provider_access_rollout_observations','SELECT')
  and not has_table_privilege('service_role','public.cloud_provider_access_rollout_observations','INSERT')
  and not has_table_privilege('service_role','public.cloud_provider_access_rollout_observations','UPDATE')
  and not has_table_privilege('service_role','public.cloud_provider_access_rollout_observations','DELETE'),
  'service role can inspect but cannot forge observation evidence'
);
select extensions.ok(
  has_function_privilege(
    'service_role',
    'public.norva_restart_provider_access_rollout_observation_after_change(uuid,bigint,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.norva_restart_provider_access_rollout_observation_after_change(uuid,bigint,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.norva_restart_provider_access_rollout_observation_after_change(uuid,bigint,text,text)',
    'EXECUTE'
  ),
  'only service role may restart an observation after a material change'
);
select extensions.is(
  (select stage from public.cloud_provider_access_rollout where singleton),
  'off','production clone remains OFF before the canary'
);
select extensions.is(
  (select count(*)::integer from public.cloud_provider_access_rollout_observations),
  0,'observation installation creates no synthetic proof row'
);

set local role service_role;
select extensions.throws_ok(
  $$select public.norva_start_provider_access_rollout_observation(
    (select revision from public.cloud_provider_access_rollout where singleton),
    'clone-observation-proof'
  )$$,
  '55000','rollout observation requires an active cohort',
  'OFF refuses observation collection'
);
select extensions.throws_ok(
  $$update public.cloud_provider_access_rollout
    set updated_at=clock_timestamp() where singleton$$,
  '42501','permission denied for table cloud_provider_access_rollout',
  'direct service-role rollout mutation is denied'
);
reset role;

select extensions.ok(
  position('notification.state = ''delivered''' in pg_get_functiondef(
    'public.norva_provider_access_analytics_dashboard(integer)'::regprocedure
  )) > 0
  and position('notification.state = ''completed''' in pg_get_functiondef(
    'public.norva_provider_access_analytics_dashboard(integer)'::regprocedure
  )) = 0,
  'production analytics use the delivered notification state'
);

set local role service_role;
select public.norva_configure_provider_access_rollout_gates(
  (select revision from public.cloud_provider_access_rollout where singleton),
  'legal-policy:observation-install-proof',
  'ops-proof:observation-install-proof',
  'clone-observation-proof'
)
where exists (
  select 1 from public.cloud_provider_access_rollout
  where singleton
    and (legal_policy_reference is null or operational_reference is null)
);
reset role;

update public.cloud_catalog_cache_epoch_v2_rollout
set installed_at=installed_at-interval '8 days'
where singleton and phase='installed';
set local role service_role;
select public.norva_complete_catalog_cache_epoch_v2_rollout(
  'catalog-cache-epoch-v2',
  '23c0fa2cdaf09c08d9de4378d1a82f0f631ce71d6f955a0bdbb2c786b8ff98d3'
);
select public.norva_register_active_catalog_refresh_worker(
  'phase16-observation-install-smoke',
  'credential-transition-worker-v3-active-catalog-refresh',
  'active-catalog-refresh-checkpoint-prune-v1'
);
select public.norva_set_provider_access_rollout_stage(
  (select revision from public.cloud_provider_access_rollout where singleton),
  'internal','Clone-only internal observation gate smoke.','clone-observation-proof'
);
select extensions.throws_ok(
  $$select public.norva_set_provider_access_rollout_stage(
    (select revision from public.cloud_provider_access_rollout where singleton),
    '1_percent','Missing observation must prevent this promotion.','clone-observation-proof'
  )$$,
  '55000','rollout stage lacks an accepted observation',
  'internal promotion is blocked until a durable observation is accepted'
);
reset role;

select * from extensions.finish();
rollback;
