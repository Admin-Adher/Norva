begin;

create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select extensions.plan(7);

insert into auth.users(
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) values (
  '93100000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  'replacement-failure@example.invalid','',now(),
  '{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,now(),now()
);
insert into public.cloud_sources(
  id,user_id,source_type,display_name,config_ciphertext,config_hint,sync_status
) values
('93100000-0000-4000-8000-000000000101',
 '93100000-0000-4000-8000-000000000001','xtream','failure-A','cipher-a',
 '{"serverHost":"a.failure.invalid","username":"failure-a"}'::jsonb,'ready'),
('93100000-0000-4000-8000-000000000102',
 '93100000-0000-4000-8000-000000000001','xtream','failure-B','cipher-b',
 '{"serverHost":"b.failure.invalid","username":"failure-b"}'::jsonb,'ready');

set local role service_role;
select public.norva_backfill_provider_access_foundation(100);
update public.cloud_source_lifecycle
set lifecycle_state='staging',catalog_visibility='hidden',
    replacement_root_id='93100000-0000-4000-8000-000000000101',
    replaces_source_id='93100000-0000-4000-8000-000000000101'
where source_id='93100000-0000-4000-8000-000000000102';
select public.norva_register_active_catalog_refresh_worker(
  'replacement-failure-test','credential-transition-worker-v3-active-catalog-refresh',
  'active-catalog-refresh-checkpoint-prune-v1'
);
reset role;
update public.admin_feature_flags
set enabled=true where key='provider_replacement_v1_enabled';
set local role service_role;
insert into public.cloud_source_transitions(
  id,user_id,transition_kind,old_source_id,candidate_source_id,
  identity_decision,decision_origin,idempotency_key
) values (
  '93100000-0000-4000-8000-000000000601',
  '93100000-0000-4000-8000-000000000001','replacement',
  '93100000-0000-4000-8000-000000000101',
  '93100000-0000-4000-8000-000000000102',
  'different_catalog','automatic','replacement-failure-fixture'
);
select public.norva_begin_replacement_catalog_import(
  '93100000-0000-4000-8000-000000000601',
  '93100000-0000-4000-8000-000000000001',0
);
create temp table replacement_failure_ctx(value jsonb) on commit drop;
insert into replacement_failure_ctx
select public.norva_fail_source_replacement(
  '93100000-0000-4000-8000-000000000601',
  '93100000-0000-4000-8000-000000000001','failure-test',
  (select revision from public.cloud_source_transitions
   where id='93100000-0000-4000-8000-000000000601'),
  'catalog_changed_during_staging','replacement-failure:test',repeat('f',64)
);
reset role;

select extensions.is((select value->>'state' from replacement_failure_ctx),'FAILED',
  'replacement failure RPC returns a terminal FAILED projection');
select extensions.ok((select state='failed' and failure_code='catalog_changed_during_staging'
  from public.cloud_source_transitions
  where id='93100000-0000-4000-8000-000000000601'),
  'replacement failure persists its bounded reason code');
select extensions.ok((select lifecycle_state='purge_pending' and catalog_visibility='hidden'
  from public.cloud_source_lifecycle
  where source_id='93100000-0000-4000-8000-000000000102')
  and (select deleted_at is not null and not enabled
       from public.cloud_sources
       where id='93100000-0000-4000-8000-000000000102'),
  'failed B is hidden and retired before cleanup');
select extensions.ok(not exists(
  select 1 from public.cloud_source_credential_transition_jobs
  where transition_id='93100000-0000-4000-8000-000000000601'
    and state in ('pending','processing')
), 'failed replacement leaves no live build job');
select extensions.ok((select state='pending'
  and source_id='93100000-0000-4000-8000-000000000102'
  from public.cloud_source_replacement_cleanup_jobs
  where transition_id='93100000-0000-4000-8000-000000000601'),
  'failed replacement schedules its candidate for bounded cleanup');
set local role service_role;
select extensions.is((public.norva_fail_source_replacement(
  '93100000-0000-4000-8000-000000000601',
  '93100000-0000-4000-8000-000000000001','failure-test',0,
  'catalog_changed_during_staging','replacement-failure:test',repeat('f',64)
)->>'replayed'),'true','exact failure replay is idempotent');
reset role;
select extensions.is((select count(*)::integer
  from public.cloud_source_lifecycle
  where user_id='93100000-0000-4000-8000-000000000001'
    and lifecycle_state='active' and catalog_visibility='visible'),1,
  'failed staging never changes the active A endpoint');

select * from extensions.finish();
rollback;
