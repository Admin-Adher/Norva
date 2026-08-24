\set ON_ERROR_STOP on

-- The crash matrix intentionally leaves a durable rollback continuation for
-- the fixed provider_credential_transition.sql proof account.  Resume its
-- removal through the same bounded production account-deletion workflow that
-- a real account uses; never hide residue with a test-only cascade.
do $cleanup$
declare
  v_user constant uuid := '93000000-0000-4000-8000-000000000001';
  v_begin jsonb;
  v_stop jsonb;
  v_claim jsonb;
  v_run jsonb;
  v_account jsonb;
  v_final_key uuid;
  v_loops integer;
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  if not exists (select 1 from auth.users where id=v_user) then
    return;
  end if;

  v_begin := public.norva_begin_provider_account_deletion_prepare(v_user);
  if v_begin->>'state'='dead' then
    raise exception 'crash fixture deletion preparation is dead';
  end if;
  v_stop := public.norva_claim_provider_transport_stop_action(
    v_user,'phase123-crash-cleanup',60
  );
  if v_stop->>'state'='dead' then
    raise exception 'crash fixture transport stop is dead';
  end if;
  if v_stop->>'state'<>'completed' then
    v_stop := public.norva_settle_provider_transport_stop_action(
      v_user,'phase123-crash-cleanup',
      (v_stop->>'leaseSequence')::integer,(v_stop->>'revision')::bigint,
      'completed',repeat('c',64),null,0
    );
  end if;

  v_claim := public.norva_claim_provider_account_deletion_prepare(
    v_user,'phase123-crash-cleanup',120
  );
  if not (v_claim->>'ready')::boolean then
    for v_loops in 1..96 loop
      v_run := public.norva_run_provider_account_deletion_prepare_batch(
        v_user,'phase123-crash-cleanup',
        (v_claim->>'leaseSequence')::integer,
        (v_claim->>'revision')::bigint,100
      );
      exit when (v_run->>'ready')::boolean;
      if (v_run->>'waitingForDrain')::boolean then
        raise exception 'crash fixture cleanup still has a live provider lease';
      end if;
      v_claim := v_run;
    end loop;
    if not coalesce((v_run->>'ready')::boolean,false) then
      raise exception 'crash fixture deletion preparation did not converge';
    end if;
  end if;

  v_account := public.norva_begin_account_deletion_workflow(v_user);
  v_account := public.norva_advance_account_deletion_workflow(
    v_user,(v_account->>'revision')::bigint,500
  );
  loop
    v_account := public.norva_purge_account_deletion_paywall_batch(
      v_user,(v_account->>'revision')::bigint,500
    );
    exit when (v_account->>'complete')::boolean;
  end loop;
  v_account := public.norva_advance_account_deletion_workflow(
    v_user,(v_account->>'revision')::bigint,500
  );
  v_account := public.norva_advance_account_deletion_workflow(
    v_user,(v_account->>'revision')::bigint,500
  );
  loop
    v_account := public.norva_purge_account_deletion_product_batch(
      v_user,(v_account->>'revision')::bigint,500
    );
    exit when (v_account->>'readyToFinalize')::boolean;
  end loop;

  select claim.finalization_key into strict v_final_key
  from public.norva_claim_account_deletion_finalizations(1,120) claim
  where claim.user_id=v_user;
  delete from auth.users where id=v_user;
  perform public.norva_complete_account_deletion_finalization(v_final_key);
  delete from public.cloud_account_deletion_finalizations
  where finalization_key=v_final_key;
end
$cleanup$;

-- provider_credential_transition.sql enables this flag inside the committed
-- crash-fixture branch.  Restore the rehearsal's fail-closed global posture.
update public.admin_feature_flags
set enabled=false,updated_at=clock_timestamp(),
    updated_by='phase123-proof-crash-fixture-cleanup'
where key='provider_credential_transition_v1_enabled' and enabled;

do $postcondition$
begin
  if exists (
       select 1 from auth.users
       where id='93000000-0000-4000-8000-000000000001'
     )
     or exists (
       select 1 from public.cloud_source_transitions
       where user_id='93000000-0000-4000-8000-000000000001'
     )
     or exists (
       select 1 from public.cloud_source_credential_transition_jobs
       where user_id='93000000-0000-4000-8000-000000000001'
     )
     or exists (
       select 1 from public.admin_feature_flags
       where key='provider_credential_transition_v1_enabled' and enabled
     ) then
    raise exception 'crash fixture cleanup left durable account residue';
  end if;
end
$postcondition$;
