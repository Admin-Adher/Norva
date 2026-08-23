begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';
set local "request.jwt.claim.role" = 'service_role';

insert into auth.users (
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) values (
  '94600000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','owner-workflow-smoke@invalid.test','',now(),
  '{}'::jsonb,'{}'::jsonb,now(),now()
);

insert into public.cloud_sources (
  id,user_id,source_type,display_name,config_ciphertext,config_hint,
  sync_status,catalog_version,enabled,last_synced_at
) values (
  '94600000-0000-4000-8000-000000000101',
  '94600000-0000-4000-8000-000000000001',
  'xtream','Owner workflow A','cipher-a','{}'::jsonb,
  'ready',1,true,now()
);

do $smoke$
declare
  v_user constant uuid := '94600000-0000-4000-8000-000000000001';
  v_source constant uuid := '94600000-0000-4000-8000-000000000101';
  v_title constant uuid := '94600000-0000-4000-8000-000000000701';
  v_generation uuid;
  v_claim record;
  v_first jsonb;
  v_second jsonb;
  v_third jsonb;
  v_checkpoint jsonb;
begin
  select head.active_generation_id into strict v_generation
  from public.cloud_source_catalog_heads head
  where head.source_id = v_source and head.user_id = v_user;
  insert into public.cloud_titles (
    id,user_id,item_type,identity_key,identity_source,provider_tmdb_id,
    match_status,title,metadata
  ) values (
    v_title,v_user,'movie','provider_tmdb:946','provider_tmdb','946',
    'unmatched','Owner workflow title','{}'::jsonb
  );
  insert into public.cloud_title_variants (
    id,user_id,title_id,source_id,item_type,external_id,raw_title,generation_id
  ) values (
    '94600000-0000-4000-8000-000000000801',v_user,v_title,v_source,
    'movie','946','Owner workflow title',v_generation
  );

  perform public.norva_discover_catalog_background_owner_jobs(100);
  select claim.* into strict v_claim
  from public.norva_claim_catalog_background_owner_build_jobs(
    'owner-workflow-a',10,120
  ) claim
  where claim.user_id = v_user and claim.job_kind = 'baseline';
  v_first := public.norva_run_catalog_background_owner_build_job_slice(
    v_claim.job_id,'owner-workflow-a',v_claim.lease_sequence,
    v_claim.checkpoint_revision,100
  );
  v_second := public.norva_run_catalog_background_owner_build_job_slice(
    v_claim.job_id,'owner-workflow-a',v_claim.lease_sequence,
    (v_first ->> 'checkpointRevision')::bigint,100
  );
  if coalesce((v_second ->> 'complete')::boolean,false)
     or not coalesce((v_second ->> 'activationPending')::boolean,false) then
    raise exception 'owner baseline activated in its final build transaction';
  end if;
  v_third := public.norva_run_catalog_background_owner_build_job_slice(
    v_claim.job_id,'owner-workflow-a',v_claim.lease_sequence,
    (v_second ->> 'checkpointRevision')::bigint,100
  );
  if not (v_third ->> 'complete')::boolean
     or not public.norva_catalog_background_owner_baseline_current(v_user) then
    raise exception 'owner baseline workflow did not activate exact snapshot';
  end if;

  -- A topology change stales the active pointer.  The next job is begun by
  -- worker A, requeued without consuming the failure budget, then reclaimed
  -- by worker B.  A delayed A write must be a zero-mutation serialization
  -- failure and B must continue the same snapshot/checkpoint.
  insert into public.cloud_sources (
    id,user_id,source_type,display_name,config_ciphertext,config_hint,
    sync_status,catalog_version,enabled,last_synced_at
  ) values (
    '94600000-0000-4000-8000-000000000102',v_user,'xtream',
    'Owner workflow B','cipher-b','{}'::jsonb,'ready',1,true,now()
  );
  perform public.norva_discover_catalog_background_owner_jobs(100);
  select claim.* into strict v_claim
  from public.norva_claim_catalog_background_owner_build_jobs(
    'owner-workflow-old',10,120
  ) claim
  where claim.user_id = v_user and claim.job_kind = 'baseline';
  v_first := public.norva_run_catalog_background_owner_build_job_slice(
    v_claim.job_id,'owner-workflow-old',v_claim.lease_sequence,
    v_claim.checkpoint_revision,100
  );
  v_checkpoint := public.norva_checkpoint_catalog_background_owner_build_job(
    v_claim.job_id,'owner-workflow-old',v_claim.lease_sequence,
    (v_first ->> 'checkpointRevision')::bigint,0
  );
  select claim.* into strict v_claim
  from public.norva_claim_catalog_background_owner_build_jobs(
    'owner-workflow-new',10,120
  ) claim
  where claim.user_id = v_user and claim.job_kind = 'baseline';
  begin
    perform public.norva_run_catalog_background_owner_build_job_slice(
      v_claim.job_id,'owner-workflow-old',v_claim.lease_sequence - 1,
      (v_first ->> 'checkpointRevision')::bigint,100
    );
    raise exception 'stale owner workflow lease unexpectedly mutated';
  exception when serialization_failure then
    null;
  end;
  v_second := public.norva_run_catalog_background_owner_build_job_slice(
    v_claim.job_id,'owner-workflow-new',v_claim.lease_sequence,
    v_claim.checkpoint_revision,100
  );
  v_third := public.norva_run_catalog_background_owner_build_job_slice(
    v_claim.job_id,'owner-workflow-new',v_claim.lease_sequence,
    (v_second ->> 'checkpointRevision')::bigint,100
  );
  if not (v_third ->> 'complete')::boolean
     or not public.norva_catalog_background_owner_baseline_current(v_user)
     or (select job.failure_attempt_count
         from public.cloud_catalog_background_owner_build_jobs job
         where job.id = v_claim.job_id) <> 0 then
    raise exception 'owner workflow reclaim did not complete exactly';
  end if;

  update public.cloud_sources source
  set enabled = false,updated_at = now()
  where source.user_id = v_user;
  perform public.norva_discover_catalog_background_owner_jobs(100);
  select claim.* into strict v_claim
  from public.norva_claim_catalog_background_owner_build_jobs(
    'owner-workflow-empty',10,120
  ) claim
  where claim.user_id = v_user and claim.job_kind = 'baseline';
  v_first := public.norva_run_catalog_background_owner_build_job_slice(
    v_claim.job_id,'owner-workflow-empty',v_claim.lease_sequence,
    v_claim.checkpoint_revision,100
  );
  v_second := public.norva_run_catalog_background_owner_build_job_slice(
    v_claim.job_id,'owner-workflow-empty',v_claim.lease_sequence,
    (v_first ->> 'checkpointRevision')::bigint,100
  );
  v_third := public.norva_run_catalog_background_owner_build_job_slice(
    v_claim.job_id,'owner-workflow-empty',v_claim.lease_sequence,
    (v_second ->> 'checkpointRevision')::bigint,100
  );
  if not (v_third ->> 'complete')::boolean
     or not public.norva_catalog_background_owner_baseline_current(v_user)
     or exists (
       select 1
       from public.cloud_catalog_background_owner_pointers pointer
       join public.cloud_catalog_background_owner_snapshot_sources source_map
         on source_map.snapshot_id = pointer.active_snapshot_id
       where pointer.user_id = v_user
     ) then
    raise exception 'zero-source owner baseline did not converge exactly';
  end if;
end
$smoke$;

rollback;
