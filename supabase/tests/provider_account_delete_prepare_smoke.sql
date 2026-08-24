\set ON_ERROR_STOP on

-- This DB unit is deliberately not rolling-deployable before the matching
-- account-delete adapter.  A legacy direct auth delete must fail before any
-- cascade, leaving both account and source intact.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '60s';
set local "request.jwt.claim.role" = 'service_role';
insert into auth.users (
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) values (
  '94600000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','account-delete-held@invalid.test','',now(),
  '{}'::jsonb,'{}'::jsonb,now(),now()
);
insert into public.cloud_sources (
  id,user_id,source_type,display_name,config_ciphertext,config_hint,
  sync_status,catalog_version,enabled,last_synced_at
) values (
  '94600000-0000-4000-8000-000000000101',
  '94600000-0000-4000-8000-000000000001',
  'xtream','Held delete smoke','cipher-held-delete','{}'::jsonb,
  'ready',1,true,now()
);
do $held_delete$
begin
  begin
    delete from auth.users
    where id = '94600000-0000-4000-8000-000000000001';
    raise exception 'direct auth deletion unexpectedly bypassed preparation';
  exception when sqlstate '55000' then
    null;
  end;
  if not exists (
       select 1 from auth.users
       where id = '94600000-0000-4000-8000-000000000001'
     ) or not exists (
       select 1 from public.cloud_sources
       where id = '94600000-0000-4000-8000-000000000101'
     ) then
    raise exception 'fail-closed auth deletion mutated durable account state';
  end if;
end
$held_delete$;
rollback;

begin;
set local lock_timeout = '2s';
set local statement_timeout = '60s';
set local "request.jwt.claim.role" = 'service_role';

insert into auth.users (
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) values (
  '94610000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','account-delete-smoke@invalid.test','',now(),
  '{}'::jsonb,'{}'::jsonb,now(),now()
);

insert into public.cloud_sources (
  id,user_id,source_type,display_name,config_ciphertext,config_hint,
  sync_status,catalog_version,enabled,last_synced_at
) values (
  '94610000-0000-4000-8000-000000000101',
  '94610000-0000-4000-8000-000000000001',
  'xtream','Account delete smoke','cipher-smoke','{}'::jsonb,
  'ready',1,true,now()
);

do $smoke$
declare
  v_user constant uuid := '94610000-0000-4000-8000-000000000001';
  v_source constant uuid := '94610000-0000-4000-8000-000000000101';
  v_fallback_token uuid := '94610000-0000-4000-8000-000000000201';
  v_crash_token uuid := '94610000-0000-4000-8000-000000000202';
  v_epoch bigint;
  v_begin jsonb;
  v_build jsonb;
  v_activate jsonb;
  v_permit jsonb;
  v_permit_token uuid;
  v_stop jsonb;
  v_preparation jsonb;
  v_run jsonb;
  v_iterations integer := 0;
  v_workflow_revision bigint;
  v_workflow_state text;
  v_finalization_key uuid;
begin
  select visibility_epoch into strict v_epoch
  from public.cloud_user_catalog_visibility_epochs where user_id = v_user;
  v_begin := public.norva_begin_catalog_background_owner_snapshot(
    v_user,null,'baseline',null,null,null,v_epoch
  );
  v_build := public.norva_build_catalog_background_owner_snapshot_slice(
    (v_begin->>'snapshotId')::uuid,v_user,
    (v_begin->>'revision')::bigint,
    (v_begin->>'visibilityEpoch')::bigint,100
  );
  if not (v_build->>'complete')::boolean then
    raise exception 'account-delete smoke owner build did not complete';
  end if;
  v_activate := public.norva_activate_catalog_background_owner_baseline(
    (v_begin->>'snapshotId')::uuid,v_user,
    (v_build->>'revision')::bigint,
    (v_begin->>'visibilityEpoch')::bigint
  );
  if not exists (
    select 1 from public.cloud_catalog_background_owner_pointers pointer
    where pointer.user_id = v_user
      and pointer.active_snapshot_id = (v_activate->>'snapshotId')::uuid
  ) then
    raise exception 'account-delete smoke active owner pointer is missing';
  end if;

  insert into public.cloud_source_direct_fallback_leases(
    affinity_hash,source_id,user_id,lease_token,lease_owner,lease_until
  ) values (
    repeat('a',64),v_source,v_user,v_fallback_token,'permit-smoke',
    clock_timestamp()+interval '2 minutes'
  );
  v_permit := public.norva_acquire_provider_call_permit(
    v_user,v_source,0,0,'permit-smoke',5000,1048576,40,
    'direct_fallback','direct_fallback',null,null,null,null,null,
    v_fallback_token,null
  );
  v_permit_token := (v_permit->>'permitToken')::uuid;
  if not (public.norva_revalidate_provider_call_permit(
    v_permit_token,'permit-smoke'
  )->>'permitted')::boolean then
    raise exception 'fresh provider permit was not revalidated';
  end if;
  if not (public.norva_release_provider_call_permit(
    v_permit_token,'permit-smoke'
  )->>'released')::boolean then
    raise exception 'provider permit release failed';
  end if;
  delete from public.cloud_source_direct_fallback_leases
  where lease_token = v_fallback_token;
  if exists (
    select 1 from public.cloud_provider_call_permits
    where permit_token = v_permit_token
  ) then
    raise exception 'released provider permit row was not garbage-collected';
  end if;

  -- Crash before release: expiry of the authority lease cascades the stale
  -- permit so the next direct-fallback claim cannot be poisoned by its FK.
  insert into public.cloud_source_direct_fallback_leases(
    affinity_hash,source_id,user_id,lease_token,lease_owner,lease_until
  ) values (
    repeat('b',64),v_source,v_user,v_crash_token,'crash-smoke',
    clock_timestamp()+interval '2 minutes'
  );
  v_permit := public.norva_acquire_provider_call_permit(
    v_user,v_source,0,0,'crash-smoke',5000,1048576,40,
    'direct_fallback','direct_fallback',null,null,null,null,null,
    v_crash_token,null
  );
  v_permit_token := (v_permit->>'permitToken')::uuid;
  delete from public.cloud_source_direct_fallback_leases
  where lease_token = v_crash_token;
  if exists (
    select 1 from public.cloud_provider_call_permits
    where permit_token = v_permit_token
  ) then
    raise exception 'crashed direct permit survived authority deletion';
  end if;

  v_preparation := public.norva_begin_provider_account_deletion_prepare(v_user);
  if v_preparation->>'phase' <> 'drain'
     or v_preparation->>'state' <> 'pending' then
    raise exception 'account-delete preparation did not start at durable drain';
  end if;
  v_stop := public.norva_claim_provider_transport_stop_action(
    v_user,'transport-stop-smoke',60
  );
  v_stop := public.norva_settle_provider_transport_stop_action(
    v_user,'transport-stop-smoke',(v_stop->>'leaseSequence')::integer,
    (v_stop->>'revision')::bigint,'completed',repeat('c',64),null,0
  );
  if not (v_stop->>'completed')::boolean then
    raise exception 'transport stop proof did not complete';
  end if;

  v_preparation := public.norva_claim_provider_account_deletion_prepare(
    v_user,'account-delete-smoke',300
  );
  loop
    v_iterations := v_iterations + 1;
    if v_iterations > 64 then
      raise exception 'account-delete preparation did not converge';
    end if;
    v_run := public.norva_run_provider_account_deletion_prepare_batch(
      v_user,'account-delete-smoke',
      (v_preparation->>'leaseSequence')::integer,
      (v_preparation->>'revision')::bigint,25
    );
    exit when (v_run->>'ready')::boolean;
    if (v_run->>'waitingForDrain')::boolean then
      raise exception 'account-delete preparation unexpectedly remained in drain';
    end if;
    v_preparation := v_run;
  end loop;
  if not public.norva_provider_account_delete_proof_ready(v_user)
     or exists (
       select 1 from public.cloud_catalog_background_owner_pointers
       where user_id = v_user
     ) then
    raise exception 'account-delete terminal proof or owner pointer cleanup failed';
  end if;

  insert into public.cloud_account_deletion_workflows(user_id,state,revision)
  values (v_user,'purging_product',0);
  v_iterations := 0;
  loop
    select workflow.revision,workflow.state
      into strict v_workflow_revision,v_workflow_state
    from public.cloud_account_deletion_workflows workflow
    where workflow.user_id=v_user;
    exit when v_workflow_state='ready_to_finalize';
    perform public.norva_purge_account_deletion_product_batch(
      v_user,v_workflow_revision,25
    );
    v_iterations := v_iterations + 1;
    if v_iterations > 80 then
      raise exception 'account-delete product purge did not reach finalization';
    end if;
  end loop;
  select claim.finalization_key into strict v_finalization_key
  from public.norva_claim_account_deletion_finalizations(1,120) claim
  where claim.user_id=v_user;
  delete from auth.users where id = v_user;
  if not public.norva_complete_account_deletion_finalization(v_finalization_key) then
    raise exception 'account-delete finalization acknowledgement failed';
  end if;
  if exists (select 1 from auth.users where id = v_user)
     or exists (
       select 1 from public.cloud_provider_account_delete_preparations
       where user_id = v_user
     ) or exists (
       select 1 from public.cloud_account_deletion_workflows
       where user_id = v_user
     ) or not exists (
       select 1 from public.cloud_account_deletion_finalizations
       where finalization_key=v_finalization_key
         and state='completed' and completed_at is not null
     ) then
    raise exception 'terminal auth deletion did not finish constant-size cleanup';
  end if;
end
$smoke$;

rollback;
