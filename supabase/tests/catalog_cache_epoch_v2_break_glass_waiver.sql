begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select extensions.plan(21);

create temporary table cache_epoch_waiver_ctx(
  key text primary key,
  bigint_value bigint,
  timestamp_value timestamptz
) on commit drop;
grant select on cache_epoch_waiver_ctx to service_role;

insert into cache_epoch_waiver_ctx(key,bigint_value)
select 'rollout_revision',revision
from public.cloud_provider_access_rollout where singleton;
insert into cache_epoch_waiver_ctx(key,bigint_value)
select 'global_before',global_epoch
from public.cloud_global_catalog_visibility_epoch where singleton;
insert into cache_epoch_waiver_ctx(key,timestamp_value)
select 'installed_at',installed_at
from public.cloud_catalog_cache_epoch_v2_rollout where singleton;

select extensions.has_table(
  'public','cloud_catalog_cache_epoch_v2_waivers',
  'break-glass waiver evidence table exists'
);
select extensions.has_function(
  'public','norva_waive_catalog_cache_epoch_v2_observation',
  array['text','text','bigint','text','text','text','text'],
  'break-glass waiver RPC has the exact bounded signature'
);
select extensions.ok(
  not has_table_privilege('anon','public.cloud_catalog_cache_epoch_v2_waivers','SELECT')
  and not has_table_privilege('authenticated','public.cloud_catalog_cache_epoch_v2_waivers','SELECT')
  and not has_table_privilege('service_role','public.cloud_catalog_cache_epoch_v2_waivers','SELECT'),
  'no API role can read waiver evidence directly'
);
select extensions.ok(
  not has_function_privilege(
    'anon',
    'public.norva_waive_catalog_cache_epoch_v2_observation(text,text,bigint,text,text,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.norva_waive_catalog_cache_epoch_v2_observation(text,text,bigint,text,text,text,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.norva_waive_catalog_cache_epoch_v2_observation(text,text,bigint,text,text,text,text)',
    'EXECUTE'
  ),
  'only service_role receives execute privilege on the waiver RPC'
);

set local role service_role;
select extensions.throws_ok(
  $sql$select public.norva_complete_catalog_cache_epoch_v2_rollout(
    'catalog-cache-epoch-v2',
    '23c0fa2cdaf09c08d9de4378d1a82f0f631ce71d6f955a0bdbb2c786b8ff98d3'
  )$sql$,
  '55000',
  'catalog cache epoch v2 observation window is incomplete',
  'normal completion remains database-blocked before seven days'
);
select extensions.throws_ok(
  $sql$select public.norva_waive_catalog_cache_epoch_v2_observation(
    'catalog-cache-epoch-v2',
    '23c0fa2cdaf09c08d9de4378d1a82f0f631ce71d6f955a0bdbb2c786b8ff98d3',
    (select bigint_value from cache_epoch_waiver_ctx where key='rollout_revision'),
    'NORVA-CACHE-EPOCH-V2-WAIVER-TEST-20260825',
    'Owner accepts the shortened incompatible-cache observation window for this disposable proof.',
    'pgTAP-break-glass',
    'WRONG_CONFIRMATION'
  )$sql$,
  '22023',
  'invalid catalog cache epoch v2 waiver request',
  'waiver rejects a missing exact confirmation contract'
);
select extensions.throws_ok(
  $sql$select public.norva_waive_catalog_cache_epoch_v2_observation(
    'catalog-cache-epoch-v2',
    '23c0fa2cdaf09c08d9de4378d1a82f0f631ce71d6f955a0bdbb2c786b8ff98d3',
    (select bigint_value + 1 from cache_epoch_waiver_ctx where key='rollout_revision'),
    'NORVA-CACHE-EPOCH-V2-WAIVER-TEST-20260825',
    'Owner accepts the shortened incompatible-cache observation window for this disposable proof.',
    'pgTAP-break-glass',
    'WAIVE_CACHE_EPOCH_V2_OBSERVATION_FOR_AD_LAUNCH'
  )$sql$,
  '40001',
  'stale rollout revision',
  'waiver rejects a stale rollout CAS revision'
);

select extensions.is(
  public.norva_waive_catalog_cache_epoch_v2_observation(
    'catalog-cache-epoch-v2',
    '23c0fa2cdaf09c08d9de4378d1a82f0f631ce71d6f955a0bdbb2c786b8ff98d3',
    (select bigint_value from cache_epoch_waiver_ctx where key='rollout_revision'),
    'NORVA-CACHE-EPOCH-V2-WAIVER-TEST-20260825',
    'Owner accepts the shortened incompatible-cache observation window for this disposable proof.',
    'pgTAP-break-glass',
    'WAIVE_CACHE_EPOCH_V2_OBSERVATION_FOR_AD_LAUNCH'
  )->>'phase',
  'COMPLETE',
  'exact break-glass waiver completes cache epoch v2'
);
reset role;

select extensions.ok(
  (select approval_reference='NORVA-CACHE-EPOCH-V2-WAIVER-TEST-20260825'
          and actor='pgTAP-break-glass'
          and confirmation_contract='WAIVE_CACHE_EPOCH_V2_OBSERVATION_FOR_AD_LAUNCH'
   from public.cloud_catalog_cache_epoch_v2_waivers where singleton),
  'waiver stores the exact approval, actor and confirmation'
);
select extensions.is(
  (select installed_at from public.cloud_catalog_cache_epoch_v2_waivers where singleton),
  (select timestamp_value from cache_epoch_waiver_ctx where key='installed_at'),
  'waiver preserves the real installed_at value without backdating'
);
select extensions.is(
  (select normal_not_before from public.cloud_catalog_cache_epoch_v2_waivers where singleton),
  (select timestamp_value + interval '7 days' from cache_epoch_waiver_ctx where key='installed_at'),
  'waiver persists the original seven-day deadline exactly'
);
select extensions.is(
  (select global_epoch from public.cloud_global_catalog_visibility_epoch where singleton),
  (select bigint_value + 1 from cache_epoch_waiver_ctx where key='global_before'),
  'first waiver completion bumps the global cache epoch exactly once'
);
select extensions.ok(
  (select global_epoch_after=global_epoch_before+1 and waived_at<normal_not_before
   from public.cloud_catalog_cache_epoch_v2_waivers where singleton),
  'waiver evidence binds the exact monotone bump and truthful early timestamp'
);

insert into cache_epoch_waiver_ctx(key,bigint_value)
select 'global_after',global_epoch
from public.cloud_global_catalog_visibility_epoch where singleton;
set local role service_role;
select extensions.is(
  public.norva_waive_catalog_cache_epoch_v2_observation(
    'catalog-cache-epoch-v2',
    '23c0fa2cdaf09c08d9de4378d1a82f0f631ce71d6f955a0bdbb2c786b8ff98d3',
    (select bigint_value from cache_epoch_waiver_ctx where key='rollout_revision'),
    'NORVA-CACHE-EPOCH-V2-WAIVER-TEST-20260825',
    'Owner accepts the shortened incompatible-cache observation window for this disposable proof.',
    'pgTAP-break-glass',
    'WAIVE_CACHE_EPOCH_V2_OBSERVATION_FOR_AD_LAUNCH'
  )->>'idempotentReplay',
  'true',
  'exact waiver replay is idempotent'
);
reset role;
select extensions.is(
  (select global_epoch from public.cloud_global_catalog_visibility_epoch where singleton),
  (select bigint_value from cache_epoch_waiver_ctx where key='global_after'),
  'idempotent waiver replay does not bump the global epoch again'
);

set local role service_role;
select extensions.throws_ok(
  $sql$select public.norva_waive_catalog_cache_epoch_v2_observation(
    'catalog-cache-epoch-v2',
    '23c0fa2cdaf09c08d9de4378d1a82f0f631ce71d6f955a0bdbb2c786b8ff98d3',
    (select bigint_value from cache_epoch_waiver_ctx where key='rollout_revision'),
    'NORVA-CACHE-EPOCH-V2-DIFFERENT-20260825',
    'Owner accepts the shortened incompatible-cache observation window for this disposable proof.',
    'pgTAP-break-glass',
    'WAIVE_CACHE_EPOCH_V2_OBSERVATION_FOR_AD_LAUNCH'
  )$sql$,
  '55000',
  'cache epoch v2 already completed outside this waiver',
  'changed waiver replay is rejected as a completion conflict'
);
reset role;

select extensions.throws_ok(
  $sql$update public.cloud_catalog_cache_epoch_v2_waivers set actor=actor where singleton$sql$,
  '55000',
  'catalog cache epoch v2 waiver evidence is immutable',
  'waiver evidence cannot be updated'
);
select extensions.throws_ok(
  $sql$delete from public.cloud_catalog_cache_epoch_v2_waivers where singleton$sql$,
  '55000',
  'catalog cache epoch v2 waiver evidence is immutable',
  'waiver evidence cannot be deleted'
);
select extensions.ok(
  not exists(select 1 from public.admin_feature_flags where key like 'provider_%_enabled' and enabled),
  'break-glass completion leaves every Provider Access flag OFF'
);
select extensions.ok(
  (select phase='complete'
          and manifest_sha256='23c0fa2cdaf09c08d9de4378d1a82f0f631ce71d6f955a0bdbb2c786b8ff98d3'
          and completed_at is not null
   from public.cloud_catalog_cache_epoch_v2_rollout where singleton),
  'rollout stores the exact immutable manifest and completion timestamp'
);
select extensions.is(
  (select count(*)::integer from public.cloud_catalog_cache_epoch_v2_waivers),
  1,
  'exactly one immutable waiver authority row exists'
);

select extensions.finish();
rollback;
