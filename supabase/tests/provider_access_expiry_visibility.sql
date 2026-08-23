begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select extensions.plan(4);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '94000000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  'provider-access-expiry@example.invalid', '', now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
);
insert into public.cloud_sources (
  id, user_id, source_type, display_name, config_ciphertext, config_hint,
  sync_status, catalog_version
) values (
  '94000000-0000-4000-8000-000000000101',
  '94000000-0000-4000-8000-000000000001', 'xtream', 'Expiry source', 'cipher',
  '{"serverHost":"expiry.example.invalid","username":"expiry-fixture"}'::jsonb,
  'ready', 1
);

set local role service_role;
select public.norva_backfill_provider_access_foundation(100);
select public.norva_backfill_provider_access_foundation(100);
select public.norva_backfill_source_provider_account_affinities(100);
select public.norva_backfill_source_provider_account_affinities(100);
select public.norva_discover_catalog_generation_backfill_sources(100);
do $generation_backfill$
declare v_result jsonb;
begin
  for v_iteration in 1..64 loop
    v_result := public.norva_backfill_catalog_generation_batch('provider-access-expiry-test',500,120);
    exit when not coalesce((v_result ->> 'claimed')::boolean,false);
  end loop;
  if exists (select 1 from public.cloud_catalog_generation_backfill_sources where state <> 'complete') then
    raise exception 'catalog generation backfill did not converge';
  end if;
end
$generation_backfill$;
select public.norva_discover_catalog_generation_backfill_sources(100);
set local statement_timeout = '30s';
do $generation_validate$
declare v_result jsonb;
begin
  for v_iteration in 1..32 loop
    v_result := public.norva_validate_catalog_generation_constraints(2);
    exit when (v_result ->> 'remaining')::integer = 0;
  end loop;
  if (v_result ->> 'remaining')::integer <> 0 then
    raise exception 'catalog generation constraints were not validated';
  end if;
end
$generation_validate$;
select public.norva_contract_catalog_generation_rollout(
  'catalog-generation-writer-v2-live-clear-batch'
);
reset role;
alter table public.provider_account_activity
  validate constraint provider_account_activity_opaque_key_ck;
set local role service_role;
select public.norva_register_active_catalog_refresh_worker(
  'provider-access-expiry-test', 'credential-transition-worker-v3-active-catalog-refresh',
  'active-catalog-refresh-checkpoint-prune-v1'
);
reset role;
update public.cloud_source_provider_access
set provider_access_status = 'expired_confirmed', provider_access_hidden_at = now()
where source_id = '94000000-0000-4000-8000-000000000101';
set local role service_role;
select extensions.is(
  public.norva_source_catalog_visible(
    '94000000-0000-4000-8000-000000000101',
    '94000000-0000-4000-8000-000000000001'
  ), true, 'confirmed expiry does not hide a source while access flags are OFF'
);
reset role;
update public.admin_feature_flags set enabled = true
where key in ('provider_access_v1_enabled','provider_access_visibility_v1_enabled');
set local role service_role;
select extensions.is(
  public.norva_source_catalog_visible(
    '94000000-0000-4000-8000-000000000101',
    '94000000-0000-4000-8000-000000000001'
  ), false, 'confirmed expiry hides the source only after controlled flag enablement'
);
reset role;
update public.cloud_source_provider_access
set provider_access_status = 'restoring', provider_access_hidden_at = now(),
    provider_access_restored_at = null
where source_id = '94000000-0000-4000-8000-000000000101';
set local role service_role;
select extensions.is(
  public.norva_source_catalog_visible(
    '94000000-0000-4000-8000-000000000101',
    '94000000-0000-4000-8000-000000000001'
  ), false, 'RESTORING remains hidden until a restoration proof is persisted'
);
reset role;
update public.cloud_source_provider_access
set provider_access_status = 'active', provider_access_hidden_at = null,
    provider_access_restored_at = now()
where source_id = '94000000-0000-4000-8000-000000000101';
set local role service_role;
select extensions.is(
  public.norva_source_catalog_visible(
    '94000000-0000-4000-8000-000000000101',
    '94000000-0000-4000-8000-000000000001'
  ), true, 'a restored active source returns to the visible catalogue'
);

select * from extensions.finish();
rollback;
