\set ON_ERROR_STOP on
-- The scheduler claim is only an efficiency lease.  This proves the revision
-- it publishes is the authorization for the following durable RPC: an older
-- scheduler cannot advance or purge after a later claim.
begin;
set local "request.jwt.claim.role" = 'service_role';

insert into auth.users(
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) values (
  'd0000000-0000-0000-0000-000000000092',
  '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  'account-delete-workflow-claim-092@invalid.test','not-used',clock_timestamp(),
  '{}'::jsonb,'{}'::jsonb,clock_timestamp(),clock_timestamp()
);
insert into public.cloud_account_deletion_workflows(user_id,state,revision)
values ('d0000000-0000-0000-0000-000000000092','purging_product',0);

do $claim$
declare
  v_claim record;
  v_reclaim record;
  v_result jsonb;
  v_stale boolean := false;
begin
  select * into strict v_claim
  from public.norva_claim_account_deletion_workflows(1)
  where user_id='d0000000-0000-0000-0000-000000000092';
  if v_claim.revision <> 1 or v_claim.state <> 'purging_product' then
    raise exception 'workflow claim did not publish the expected revision';
  end if;
  begin
    perform public.norva_advance_account_deletion_workflow(
      'd0000000-0000-0000-0000-000000000092',0,25
    );
  exception when sqlstate '40001' then v_stale := true;
  end;
  if not v_stale then
    raise exception 'obsolete scheduler revision advanced the workflow';
  end if;
  -- Model a crash immediately after A's claim. B may reclaim the durable row,
  -- but A's delayed RPC must then be rejected rather than repair/replay.
  select * into strict v_reclaim
  from public.norva_claim_account_deletion_workflows(1)
  where user_id='d0000000-0000-0000-0000-000000000092';
  if v_reclaim.revision <> v_claim.revision + 1 then
    raise exception 'recovery claim did not monotonically bump revision';
  end if;
  v_stale := false;
  begin
    perform public.norva_advance_account_deletion_workflow(
      'd0000000-0000-0000-0000-000000000092',v_claim.revision,25
    );
  exception when sqlstate '40001' then v_stale := true;
  end;
  if not v_stale then
    raise exception 'crashed scheduler revived after recovery claim';
  end if;
  v_result := public.norva_advance_account_deletion_workflow(
    'd0000000-0000-0000-0000-000000000092',v_reclaim.revision,25
  );
  if v_result->>'nextAction' <> 'purge_product'
     or (v_result->>'revision')::bigint <> v_reclaim.revision then
    raise exception 'recovery scheduler did not retain its bounded product step';
  end if;
end
$claim$;

rollback;
