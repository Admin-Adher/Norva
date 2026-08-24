begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

select extensions.plan(29);

create temporary table cache_epoch_v2_ctx(
  key text primary key,
  value bigint not null
) on commit drop;
grant select on cache_epoch_v2_ctx to authenticated;

select extensions.is(
  (select count(*)::integer from public.cloud_global_catalog_visibility_epoch),
  1,
  'global cache epoch has exactly one authority row'
);
select extensions.is(
  (select phase from public.cloud_catalog_cache_epoch_v2_rollout where singleton),
  'installed',
  'cache epoch rollout installs without completing itself'
);
select extensions.ok(
  not exists(select 1 from public.admin_feature_flags where key like 'provider_%_enabled' and enabled),
  'installation leaves every Provider Access flag OFF'
);
select extensions.ok(
  not has_table_privilege('authenticated','public.cloud_global_catalog_visibility_epoch','SELECT')
  and not has_table_privilege('service_role','public.cloud_global_catalog_visibility_epoch','SELECT')
  and not has_table_privilege('authenticated','public.cloud_catalog_cache_epoch_v2_rollout','SELECT')
  and not has_table_privilege('service_role','public.cloud_catalog_cache_epoch_v2_rollout','SELECT'),
  'epoch authorities are reachable only through their bounded RPCs'
);

insert into cache_epoch_v2_ctx(key,value)
select 'global_start',global_epoch from public.cloud_global_catalog_visibility_epoch where singleton;

insert into auth.users(
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) values
  ('94000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','cache-epoch-v2-a@invalid.test','',now(),'{}','{}',now(),now()),
  ('94000000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','cache-epoch-v2-b@invalid.test','',now(),'{}','{}',now(),now()),
  ('94000000-0000-4000-8000-000000000003','00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','cache-epoch-v2-c@invalid.test','',now(),'{}','{}',now(),now());

select set_config(
  'request.jwt.claims',
  '{"sub":"94000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
select set_config('request.jwt.claim.sub','94000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claim.role','authenticated',true);
set local role authenticated;

select extensions.is(
  public.norva_catalog_cache_epoch_v2('94000000-0000-4000-8000-000000000001')->>'cacheEpoch',
  'v2.'||(select value from cache_epoch_v2_ctx where key='global_start')::text||'.1',
  'an authenticated owner receives the exact composite baseline token'
);
select extensions.is(
  public.norva_catalog_cache_epoch_v2('94000000-0000-4000-8000-000000000002'),
  null::jsonb,
  'an authenticated account cannot resolve another owner token'
);
select extensions.throws_ok(
  $sql$select * from public.cloud_global_catalog_visibility_epoch$sql$,
  '42501',
  'permission denied for table cloud_global_catalog_visibility_epoch',
  'authenticated callers cannot read the global authority table'
);
reset role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claim.role','service_role',true);

insert into cache_epoch_v2_ctx(key,value)
values (
  'user_before_rollback',
  public.norva_user_catalog_visibility_epoch('94000000-0000-4000-8000-000000000003')
);
savepoint before_rolled_back_account_bump;
select public.norva_bump_user_catalog_visibility_epoch('94000000-0000-4000-8000-000000000003');
rollback to savepoint before_rolled_back_account_bump;
select extensions.is(
  public.norva_user_catalog_visibility_epoch('94000000-0000-4000-8000-000000000003'),
  (select value from cache_epoch_v2_ctx where key='user_before_rollback'),
  'a rolled-back account visibility mutation leaves its epoch unchanged'
);
select extensions.is(
  (select global_epoch from public.cloud_global_catalog_visibility_epoch where singleton),
  (select value from cache_epoch_v2_ctx where key='global_start'),
  'a rolled-back account mutation leaves the global epoch unchanged'
);

select public.norva_bump_user_catalog_visibility_epoch('94000000-0000-4000-8000-000000000003');
select extensions.is(
  public.norva_user_catalog_visibility_epoch('94000000-0000-4000-8000-000000000003'),
  (select value+1 from cache_epoch_v2_ctx where key='user_before_rollback'),
  'an account visibility mutation advances only its numeric write fence'
);
select extensions.is(
  (select global_epoch from public.cloud_global_catalog_visibility_epoch where singleton),
  (select value from cache_epoch_v2_ctx where key='global_start'),
  'an account mutation does not serialize or invalidate other accounts'
);

select public.dblink_connect(
  'cache_epoch_global_a',
  format('dbname=%I user=%I',current_database(),current_user)
);
select public.dblink_connect(
  'cache_epoch_global_b',
  format('dbname=%I user=%I',current_database(),current_user)
);
select extensions.is(
  public.dblink_send_query(
    'cache_epoch_global_a',
    'with bumped as materialized (select public.norva_bump_global_catalog_visibility_epoch() epoch), paused as materialized (select pg_sleep(0.5)) select epoch from bumped,paused'
  ),
  1,
  'first real PostgreSQL session starts a global bump'
);
select extensions.is(
  public.dblink_send_query(
    'cache_epoch_global_b',
    'select public.norva_bump_global_catalog_visibility_epoch()'
  ),
  1,
  'second real PostgreSQL session starts a concurrent global bump'
);
insert into cache_epoch_v2_ctx(key,value)
select 'global_a',epoch from public.dblink_get_result('cache_epoch_global_a') as result(epoch bigint);
insert into cache_epoch_v2_ctx(key,value)
select 'global_b',epoch from public.dblink_get_result('cache_epoch_global_b') as result(epoch bigint);
select public.dblink_disconnect('cache_epoch_global_a');
select public.dblink_disconnect('cache_epoch_global_b');
select extensions.ok(
  (select abs(a.value-b.value)=1
   from cache_epoch_v2_ctx a cross join cache_epoch_v2_ctx b
   where a.key='global_a' and b.key='global_b'),
  'concurrent global bumps publish distinct consecutive generations'
);
select extensions.is(
  (select global_epoch from public.cloud_global_catalog_visibility_epoch where singleton),
  (select max(value) from cache_epoch_v2_ctx where key in ('global_a','global_b')),
  'the durable global authority equals the winning concurrent generation'
);

-- Satisfy unrelated earlier rollout gates inside this rolled-back acceptance
-- transaction so the next failure is provably owned by cache epoch v2.
update public.cloud_provider_access_foundation_rollout
set phase='complete',completed_at=coalesce(completed_at,clock_timestamp()),updated_at=clock_timestamp()
where singleton;
update public.cloud_source_provider_account_affinity_rollout
set phase='complete',completed_at=coalesce(completed_at,clock_timestamp()),updated_at=clock_timestamp()
where singleton;
alter table public.provider_account_activity
  validate constraint provider_account_activity_opaque_key_ck;

select extensions.throws_ok(
  $sql$update public.admin_feature_flags set enabled=true where key='provider_access_visibility_v1_enabled'$sql$,
  '55000',
  'provider access visibility flags require global cache epoch v2',
  'visibility activation remains fail-closed before rollout completion'
);
set local role service_role;
select extensions.throws_ok(
  $sql$select public.norva_complete_catalog_cache_epoch_v2_rollout('catalog-cache-epoch-v2',repeat('0',64))$sql$,
  '22023',
  'catalog cache epoch v2 manifest mismatch',
  'rollout completion rejects a different manifest'
);
reset role;

insert into cache_epoch_v2_ctx(key,value)
select 'before_complete',global_epoch from public.cloud_global_catalog_visibility_epoch where singleton;
set local role service_role;
select extensions.is(
  public.norva_complete_catalog_cache_epoch_v2_rollout(
    'catalog-cache-epoch-v2',
    '23c0fa2cdaf09c08d9de4378d1a82f0f631ce71d6f955a0bdbb2c786b8ff98d3'
  )->>'phase',
  'COMPLETE',
  'the exact immutable manifest completes the rollout'
);
reset role;
select extensions.is(
  (select global_epoch from public.cloud_global_catalog_visibility_epoch where singleton),
  (select value+1 from cache_epoch_v2_ctx where key='before_complete'),
  'first rollout completion advances the global cache epoch once'
);
insert into cache_epoch_v2_ctx(key,value)
select 'after_complete',global_epoch from public.cloud_global_catalog_visibility_epoch where singleton;
set local role service_role;
select extensions.is(
  public.norva_complete_catalog_cache_epoch_v2_rollout(
    'catalog-cache-epoch-v2',
    '23c0fa2cdaf09c08d9de4378d1a82f0f631ce71d6f955a0bdbb2c786b8ff98d3'
  )->>'phase',
  'COMPLETE',
  'exact rollout completion replay is idempotent'
);
reset role;
select extensions.is(
  (select global_epoch from public.cloud_global_catalog_visibility_epoch where singleton),
  (select value from cache_epoch_v2_ctx where key='after_complete'),
  'idempotent completion replay does not bump the epoch again'
);

select extensions.lives_ok(
  $sql$update public.admin_feature_flags set enabled=true where key='provider_access_visibility_v1_enabled'$sql$,
  'visibility may turn ON only after every earlier gate and epoch v2 are complete'
);
select extensions.is(
  (select global_epoch from public.cloud_global_catalog_visibility_epoch where singleton),
  (select value+1 from cache_epoch_v2_ctx where key='after_complete'),
  'visibility ON atomically invalidates every compatible cache'
);
insert into cache_epoch_v2_ctx(key,value)
select 'after_enable',global_epoch from public.cloud_global_catalog_visibility_epoch where singleton;
select extensions.lives_ok(
  $sql$update public.admin_feature_flags set enabled=false where key='provider_access_visibility_v1_enabled'$sql$,
  'visibility rollback to OFF remains available'
);
select extensions.is(
  (select global_epoch from public.cloud_global_catalog_visibility_epoch where singleton),
  (select value+1 from cache_epoch_v2_ctx where key='after_enable'),
  'visibility OFF also invalidates every compatible cache'
);
select extensions.ok(
  not exists(select 1 from public.admin_feature_flags where key like 'provider_%_enabled' and enabled),
  'the acceptance harness finishes with every Provider Access flag OFF'
);
select extensions.is(
  public.norva_catalog_cache_epoch_v2('94000000-0000-4000-8000-000000000003')->>'cacheEpoch',
  'v2.'||(select global_epoch from public.cloud_global_catalog_visibility_epoch where singleton)::text||'.'||
    public.norva_user_catalog_visibility_epoch('94000000-0000-4000-8000-000000000003')::text,
  'the RPC always composes the durable global and account authorities exactly'
);
select extensions.ok(
  (select phase='complete' and manifest_sha256='23c0fa2cdaf09c08d9de4378d1a82f0f631ce71d6f955a0bdbb2c786b8ff98d3'
   from public.cloud_catalog_cache_epoch_v2_rollout where singleton),
  'completion stores the exact manifest as durable activation evidence'
);
select extensions.ok(
  (select count(*)=1 and min(global_epoch)>=1 from public.cloud_global_catalog_visibility_epoch),
  'the final global authority remains singular and monotone'
);

select extensions.finish();
rollback;
