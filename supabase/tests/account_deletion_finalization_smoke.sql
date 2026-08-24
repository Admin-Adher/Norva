\set ON_ERROR_STOP on
begin;
set local "request.jwt.claim.role" = 'service_role';
insert into auth.users (
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) values (
  'd0000000-0000-0000-0000-000000000090','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','finalize-delete-090@invalid.test','not-used',clock_timestamp(),
  '{}'::jsonb,'{}'::jsonb,clock_timestamp(),clock_timestamp()
);
insert into public.cloud_account_deletion_workflows(user_id,state,revision) values
  ('d0000000-0000-0000-0000-000000000090','purging_product',0);
insert into public.cloud_provider_account_delete_preparations(
  user_id,state,phase,deletion_epoch,ready_at
) values ('d0000000-0000-0000-0000-000000000090','ready','ready',1,clock_timestamp());
insert into public.cloud_provider_transport_stop_actions(
  user_id,deletion_epoch,state,completed_at,transport_stop_receipt_hash
) values ('d0000000-0000-0000-0000-000000000090',1,'completed',clock_timestamp(),repeat('b',64));

do $finalize$
declare v_revision bigint; v_state text; v_steps integer := 0; v_key uuid;
begin
  loop
    select revision,state into v_revision,v_state
    from public.cloud_account_deletion_workflows
    where user_id='d0000000-0000-0000-0000-000000000090';
    exit when v_state='ready_to_finalize';
    perform public.norva_purge_account_deletion_product_batch(
      'd0000000-0000-0000-0000-000000000090',v_revision,25
    );
    v_steps:=v_steps+1;
    if v_steps>80 then raise exception 'finalization fixture did not reach ready'; end if;
  end loop;
  select claim.finalization_key into v_key
  from public.norva_claim_account_deletion_finalizations(1,120) claim
  where claim.user_id='d0000000-0000-0000-0000-000000000090';
  if v_key is null then raise exception 'finalization claim missing'; end if;
  delete from auth.users where id='d0000000-0000-0000-0000-000000000090';
  if not public.norva_complete_account_deletion_finalization(v_key) then
    raise exception 'finalization completion acknowledgement failed';
  end if;
  if exists (select 1 from auth.users where id='d0000000-0000-0000-0000-000000000090')
     or exists (select 1 from public.cloud_account_deletion_workflows where user_id='d0000000-0000-0000-0000-000000000090')
     or not exists (select 1 from public.cloud_account_deletion_finalizations
                    where finalization_key=v_key and state='completed' and completed_at is not null) then
    raise exception 'account deletion finalization contract failed';
  end if;
end
$finalize$;
rollback;
