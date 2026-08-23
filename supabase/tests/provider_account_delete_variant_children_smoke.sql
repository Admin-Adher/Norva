\set ON_ERROR_STOP on
\timing on

-- A parent LIMIT is not a bound when a variant owns a large child history.
-- These two rollback-only fixtures put 100k rows behind one variant, run the
-- real account-delete payload phase with a one-row budget, and prove that the
-- parent survives while exactly one child row is removed.

begin;
set local lock_timeout = '2s';
set local statement_timeout = '5min';
set local "request.jwt.claim.role" = 'service_role';

insert into auth.users (
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) values (
  '94620000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','account-delete-audio-bound@invalid.test','',now(),
  '{}'::jsonb,'{}'::jsonb,now(),now()
);
insert into public.cloud_sources (
  id,user_id,source_type,display_name,config_ciphertext,config_hint,
  sync_status,catalog_version,enabled,last_synced_at
) values (
  '94620000-0000-4000-8000-000000000101',
  '94620000-0000-4000-8000-000000000001',
  'xtream','Audio child bound','cipher-audio-bound','{}'::jsonb,
  'ready',1,true,now()
);

do $audio_bound$
declare
  v_user constant uuid := '94620000-0000-4000-8000-000000000001';
  v_source constant uuid := '94620000-0000-4000-8000-000000000101';
  v_title constant uuid := '94620000-0000-4000-8000-000000000701';
  v_variant constant uuid := '94620000-0000-4000-8000-000000000801';
  v_generation uuid;
  v_prepare jsonb;
  v_claim jsonb;
  v_run jsonb;
begin
  select head.active_generation_id into strict v_generation
  from public.cloud_source_catalog_heads head
  where head.user_id = v_user and head.source_id = v_source;
  insert into public.cloud_titles(
    id,user_id,item_type,identity_key,identity_source,title
  ) values (v_title,v_user,'movie','audio-child-bound','normalized','Audio child bound');
  insert into public.cloud_title_variants(
    id,user_id,title_id,source_id,item_type,external_id,raw_title,generation_id
  ) values (
    v_variant,v_user,v_title,v_source,'movie','audio-child-bound',
    'Audio child bound',v_generation
  );
  insert into public.catalog_file_audio_validation_jobs(
    id,requested_by,source_id,variant_id,identity_key,external_id,
    expected_audio_indices,profile_fingerprint,profile_snapshot,
    profile_probed_at,file_size_bytes,cached_audio_tracks
  )
  select md5('account-delete-audio-child-' || series.ordinality::text)::uuid,
    v_user,v_source,v_variant,
    'audio-child-' || series.ordinality::text,
    'audio-child-' || series.ordinality::text,
    array[1],repeat('a',64),'{}'::jsonb,now(),1,'[]'::jsonb
  from generate_series(1,100000) with ordinality series;
  if (select count(*) from public.catalog_file_audio_validation_jobs
      where variant_id = v_variant) <> 100000 then
    raise exception 'audio child scale fixture is incomplete';
  end if;

  v_prepare := public.norva_begin_provider_account_deletion_prepare(v_user);
  v_claim := public.norva_claim_provider_account_deletion_prepare(
    v_user,'audio-child-bound',300
  );
  update public.cloud_provider_account_delete_preparations
  set phase = 'payload'
  where user_id = v_user;
  v_run := public.norva_run_provider_account_deletion_prepare_batch(
    v_user,'audio-child-bound',(v_claim->>'leaseSequence')::integer,
    (v_claim->>'revision')::bigint,1
  );
  if (select count(*) from public.catalog_file_audio_validation_jobs
      where variant_id = v_variant) <> 99999
     or not exists (
       select 1 from public.cloud_title_variants where id = v_variant
     )
     or (v_run->>'deletedRows')::bigint <> 1 then
    raise exception 'audio child deletion was not bounded to exactly one row';
  end if;
end
$audio_bound$;
rollback;

-- The legacy source reaper has a fixed 5k budget.  Seed a pre-generation
-- legacy shape (the constraints are removed only inside this rollback-only
-- fixture) and prove that 100k probe children cannot disappear through one
-- parent cascade: one call removes exactly 5k and leaves the variant present.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '5min';
set local "request.jwt.claim.role" = 'service_role';

insert into auth.users (
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) values (
  '94640000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','source-reaper-child-bound@invalid.test','',now(),
  '{}'::jsonb,'{}'::jsonb,now(),now()
);
insert into public.cloud_sources (
  id,user_id,source_type,display_name,config_ciphertext,config_hint,
  sync_status,catalog_version,enabled,last_synced_at
) values (
  '94640000-0000-4000-8000-000000000101',
  '94640000-0000-4000-8000-000000000001',
  'xtream','Source reaper child bound','cipher-reaper-bound','{}'::jsonb,
  'ready',1,true,now()
);

do $reaper_fixture$
declare
  v_user constant uuid := '94640000-0000-4000-8000-000000000001';
  v_source constant uuid := '94640000-0000-4000-8000-000000000101';
  v_identity constant uuid := '94640000-0000-4000-8000-000000000201';
  v_title constant uuid := '94640000-0000-4000-8000-000000000701';
  v_variant constant uuid := '94640000-0000-4000-8000-000000000801';
  v_generation uuid;
begin
  select head.active_generation_id into strict v_generation
  from public.cloud_source_catalog_heads head
  where head.user_id = v_user and head.source_id = v_source;
  insert into public.provider_identities(id,display_name)
  values (v_identity,'Source reaper child bound');
  insert into public.cloud_titles(
    id,user_id,item_type,identity_key,identity_source,title
  ) values (
    v_title,v_user,'series','source-reaper-child-bound','normalized',
    'Source reaper child bound'
  );
  insert into public.cloud_title_variants(
    id,user_id,title_id,source_id,item_type,external_id,raw_title,generation_id
  ) values (
    v_variant,v_user,v_title,v_source,'series','source-reaper-child-bound',
    'Source reaper child bound',v_generation
  );
  insert into public.catalog_episode_probe_state(
    provider_identity_id,variant_id,episode_id,attempts,failure_class,
    last_transport,next_retry_at,last_attempted_at,last_failed_at
  )
  select v_identity,v_variant,'reaper-episode-' || series.ordinality::text,
    1,'transient','provider',now(),now(),now()
  from generate_series(1,100000) with ordinality series;

  -- Emulate an actual pre-Phase-3 source whose payload predates mandatory
  -- generation ownership.  DDL and replica mode are transaction-local here.
  alter table public.cloud_title_variants
    drop constraint cloud_title_variants_generation_required_ck;
  alter table public.cloud_title_variants
    drop constraint cloud_title_variants_generation_fk;
  perform set_config('session_replication_role','replica',true);
  update public.cloud_title_variants set generation_id = null
  where id = v_variant;
  delete from public.cloud_source_catalog_heads where source_id = v_source;
  delete from public.cloud_source_catalog_generations where id = v_generation;
  perform set_config('session_replication_role','origin',true);
  update public.cloud_sources
  set deleted_at = now(),enabled = false where id = v_source;
end
$reaper_fixture$;

call public.reap_deleted_sources();
do $reaper_assert$
begin
  if (select count(*) from public.catalog_episode_probe_state
      where variant_id = '94640000-0000-4000-8000-000000000801') <> 95000
     or not exists (
       select 1 from public.cloud_title_variants
       where id = '94640000-0000-4000-8000-000000000801'
     ) then
    raise exception 'source reaper child deletion exceeded its 5k budget';
  end if;
end
$reaper_assert$;
rollback;

begin;
set local lock_timeout = '2s';
set local statement_timeout = '5min';
set local "request.jwt.claim.role" = 'service_role';

insert into auth.users (
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) values (
  '94630000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','account-delete-probe-bound@invalid.test','',now(),
  '{}'::jsonb,'{}'::jsonb,now(),now()
);
insert into public.cloud_sources (
  id,user_id,source_type,display_name,config_ciphertext,config_hint,
  sync_status,catalog_version,enabled,last_synced_at
) values (
  '94630000-0000-4000-8000-000000000101',
  '94630000-0000-4000-8000-000000000001',
  'xtream','Probe child bound','cipher-probe-bound','{}'::jsonb,
  'ready',1,true,now()
);

do $probe_bound$
declare
  v_user constant uuid := '94630000-0000-4000-8000-000000000001';
  v_source constant uuid := '94630000-0000-4000-8000-000000000101';
  v_identity constant uuid := '94630000-0000-4000-8000-000000000201';
  v_title constant uuid := '94630000-0000-4000-8000-000000000701';
  v_variant constant uuid := '94630000-0000-4000-8000-000000000801';
  v_generation uuid;
  v_prepare jsonb;
  v_claim jsonb;
  v_run jsonb;
begin
  select head.active_generation_id into strict v_generation
  from public.cloud_source_catalog_heads head
  where head.user_id = v_user and head.source_id = v_source;
  insert into public.provider_identities(id,display_name)
  values (v_identity,'Probe child bound');
  insert into public.cloud_titles(
    id,user_id,item_type,identity_key,identity_source,title
  ) values (v_title,v_user,'series','probe-child-bound','normalized','Probe child bound');
  insert into public.cloud_title_variants(
    id,user_id,title_id,source_id,item_type,external_id,raw_title,generation_id
  ) values (
    v_variant,v_user,v_title,v_source,'series','probe-child-bound',
    'Probe child bound',v_generation
  );
  insert into public.catalog_episode_probe_state(
    provider_identity_id,variant_id,episode_id,attempts,failure_class,
    last_transport,next_retry_at,last_attempted_at,last_failed_at
  )
  select v_identity,v_variant,'episode-' || series.ordinality::text,1,
    'transient','provider',now(),now(),now()
  from generate_series(1,100000) with ordinality series;
  if (select count(*) from public.catalog_episode_probe_state
      where variant_id = v_variant) <> 100000 then
    raise exception 'probe child scale fixture is incomplete';
  end if;

  v_prepare := public.norva_begin_provider_account_deletion_prepare(v_user);
  v_claim := public.norva_claim_provider_account_deletion_prepare(
    v_user,'probe-child-bound',300
  );
  update public.cloud_provider_account_delete_preparations
  set phase = 'payload'
  where user_id = v_user;
  v_run := public.norva_run_provider_account_deletion_prepare_batch(
    v_user,'probe-child-bound',(v_claim->>'leaseSequence')::integer,
    (v_claim->>'revision')::bigint,1
  );
  if (select count(*) from public.catalog_episode_probe_state
      where variant_id = v_variant) <> 99999
     or not exists (
       select 1 from public.cloud_title_variants where id = v_variant
     )
     or (v_run->>'deletedRows')::bigint <> 1 then
    raise exception 'probe child deletion was not bounded to exactly one row';
  end if;
end
$probe_bound$;
rollback;
