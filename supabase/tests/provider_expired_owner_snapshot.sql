-- No network calls; all synthetic users, membership and data are rolled back.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';
set local "request.jwt.claim.role" = 'service_role';
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select extensions.no_plan();
update public.admin_feature_flags set enabled=true
where key in ('provider_access_v1_enabled','provider_access_visibility_v1_enabled') and not enabled;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values('98620000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','expired-owner@invalid.test','',now(),'{}','{}',now(),now());
insert into public.cloud_provider_access_rollout_internal_users(user_id,reason,added_by)
values('98620000-0000-4000-8000-000000000001','Rolled-back expired source assertion','test:expired-owner');
insert into public.cloud_sources(id,user_id,source_type,display_name,config_ciphertext,config_hint,sync_status,catalog_version,enabled)
values('98620000-0000-4000-8000-000000000101','98620000-0000-4000-8000-000000000001',
  'xtream','Expired owner fixture','fixture-ciphertext','{"serverHost":"expired.invalid"}','ready',1,true);
create temporary table expired_owner_context as
select source_id,user_id,active_generation_id as generation_id,
  '98620000-0000-4000-8000-000000000201'::uuid as snapshot_id
from public.cloud_source_catalog_heads where source_id='98620000-0000-4000-8000-000000000101';
insert into public.cloud_catalog_background_owner_snapshots(id,user_id,snapshot_kind,state,
  build_visibility_epoch,applied_visibility_epoch,completed_at,activated_at)
select snapshot_id,user_id,'baseline','active',1,1,now(),now() from expired_owner_context;
create function pg_temp.matches() returns boolean language sql as $$
  select public.norva_catalog_background_owner_source_map_matches(snapshot_id,user_id,source_id,generation_id)
  from expired_owner_context
$$;
select extensions.ok(not pg_temp.matches(),'a visible source cannot be missing from its snapshot');
insert into public.cloud_catalog_background_owner_snapshot_sources(snapshot_id,user_id,source_id,generation_id)
select snapshot_id,user_id,source_id,generation_id from expired_owner_context;
select extensions.ok(pg_temp.matches(),'visible source requires the exact generation map');
select extensions.ok(not public.norva_catalog_background_owner_source_map_matches(snapshot_id,
  gen_random_uuid(),source_id,generation_id),'another owner cannot reuse a map') from expired_owner_context;
select extensions.ok(not public.norva_catalog_background_owner_source_map_matches(snapshot_id,
  user_id,source_id,gen_random_uuid()),'another generation cannot reuse a map') from expired_owner_context;
select extensions.ok(not public.norva_catalog_background_owner_source_map_matches(gen_random_uuid(),
  user_id,source_id,generation_id),'a missing snapshot cannot certify a map') from expired_owner_context;
update public.cloud_source_provider_access set provider_access_status='expired_confirmed',
  provider_access_hidden_at=now(),provider_access_restored_at=null
where source_id='98620000-0000-4000-8000-000000000101';
select extensions.ok(not public.norva_source_catalog_visible_internal(source_id,user_id),
  'confirmed expiration still hides the source') from expired_owner_context;
select extensions.ok(not pg_temp.matches(),'an expired source must not remain in the effective map');
delete from public.cloud_catalog_background_owner_snapshot_sources
where snapshot_id='98620000-0000-4000-8000-000000000201';
select extensions.ok(pg_temp.matches(),'exact absence is valid for an expired provider');
update public.cloud_source_provider_access set provider_access_status='access_unavailable_confirmed'
where source_id='98620000-0000-4000-8000-000000000101';
select extensions.ok(pg_temp.matches(),'confirmed unavailable access supports rotation while hidden');
update public.cloud_source_provider_access set provider_access_status='restoring'
where source_id='98620000-0000-4000-8000-000000000101';
select extensions.ok(pg_temp.matches(),'a restoring source stays absent until a successful check');
update public.cloud_source_provider_access set provider_access_restored_at=now()+interval '1 second'
where source_id='98620000-0000-4000-8000-000000000101';
select extensions.ok(not pg_temp.matches(),'a restored source needs a fresh visible map');
update public.cloud_source_provider_access set provider_access_status='expired_confirmed',provider_access_restored_at=null
where source_id='98620000-0000-4000-8000-000000000101';
update public.cloud_sources set enabled=false where id='98620000-0000-4000-8000-000000000101';
select extensions.ok(not pg_temp.matches(),'disabled sources cannot use the expired-access exception');
update public.cloud_sources set enabled=true,deleted_at=now() where id='98620000-0000-4000-8000-000000000101';
select extensions.ok(not pg_temp.matches(),'deleted sources cannot use the expired-access exception');
select extensions.ok(not has_function_privilege('authenticated',
  'public.norva_catalog_background_owner_source_map_matches(uuid,uuid,uuid,uuid)','execute'),
  'ordinary clients cannot inspect private snapshot maps');
select extensions.ok(not has_function_privilege('anon',
  'public.norva_catalog_background_owner_source_map_matches(uuid,uuid,uuid,uuid)','execute'),
  'anonymous clients cannot inspect private snapshot maps');
select * from extensions.finish();
rollback;
