\set ON_ERROR_STOP on
-- This harness uses two PostgreSQL backends.  Its fixture is finalized through
-- the same guarded path under test; no raw cascade cleanup is used.
begin;
set local "request.jwt.claim.role" = 'service_role';
insert into auth.users (
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) values (
  'd0000000-0000-0000-0000-000000000091','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','finalization-race-091@invalid.test','not-used',clock_timestamp(),
  '{}'::jsonb,'{}'::jsonb,clock_timestamp(),clock_timestamp()
);
insert into public.cloud_account_deletion_workflows(user_id,state,revision) values
  ('d0000000-0000-0000-0000-000000000091','purging_product',0);
insert into public.cloud_provider_account_delete_preparations(user_id,state,phase,deletion_epoch,ready_at)
values ('d0000000-0000-0000-0000-000000000091','ready','ready',1,clock_timestamp());
insert into public.cloud_provider_transport_stop_actions(
  user_id,deletion_epoch,state,completed_at,transport_stop_receipt_hash
) values ('d0000000-0000-0000-0000-000000000091',1,'completed',clock_timestamp(),repeat('c',64));
do $prepare$
declare v_revision bigint; v_state text; v_steps integer:=0;
begin
  loop
    select revision,state into v_revision,v_state from public.cloud_account_deletion_workflows
    where user_id='d0000000-0000-0000-0000-000000000091';
    exit when v_state='ready_to_finalize';
    perform public.norva_purge_account_deletion_product_batch(
      'd0000000-0000-0000-0000-000000000091',v_revision,25);
    v_steps:=v_steps+1; if v_steps>80 then raise exception 'fixture did not become ready'; end if;
  end loop;
end
$prepare$;
commit;

begin;
set local "request.jwt.claim.role" = 'service_role';
do $race$
declare v_a record; v_b record; v_key uuid; v_connection text;
begin
  perform dblink_connect('norva_final_a',format(
    'host=127.0.0.1 port=%s dbname=%s user=%s connect_timeout=2',current_setting('port'),current_database(),current_user));
  perform dblink_connect('norva_final_b',format(
    'host=127.0.0.1 port=%s dbname=%s user=%s connect_timeout=2',current_setting('port'),current_database(),current_user));
  perform dblink_exec('norva_final_a','set "request.jwt.claim.role"=''service_role''');
  perform dblink_exec('norva_final_b','set "request.jwt.claim.role"=''service_role''');
  perform dblink_send_query('norva_final_a',
    'select * from public.norva_claim_account_deletion_finalizations(1,120)');
  perform dblink_send_query('norva_final_b',
    'select * from public.norva_claim_account_deletion_finalizations(1,120)');
  select * into v_a from dblink_get_result('norva_final_a') as t(user_id uuid,finalization_key uuid);
  select * into v_b from dblink_get_result('norva_final_b') as t(user_id uuid,finalization_key uuid);
  if (v_a.finalization_key is null and v_b.finalization_key is null)
     or (v_a.finalization_key is not null and v_b.finalization_key is not null) then
    raise exception 'finalization race did not have exactly one winner';
  end if;
  v_key:=coalesce(v_a.finalization_key,v_b.finalization_key);
  delete from auth.users where id='d0000000-0000-0000-0000-000000000091';
  if not exists (select 1 from public.cloud_account_deletion_finalizations
                 where finalization_key=v_key and state='claimed') then
    raise exception 'crash fixture did not retain claimed tombstone';
  end if;
  perform dblink_disconnect('norva_final_a');
  perform dblink_disconnect('norva_final_b');
exception when others then
  foreach v_connection in array coalesce(dblink_get_connections(),array[]::text[]) loop
    if v_connection in ('norva_final_a','norva_final_b') then
      begin perform dblink_disconnect(v_connection); exception when others then null; end;
    end if;
  end loop;
  raise;
end
$race$;
commit;
begin;
set local "request.jwt.claim.role" = 'service_role';
select public.norva_reconcile_account_deletion_finalizations(25);
do $reconciled$
begin
  if exists (select 1 from public.cloud_account_deletion_finalizations
             where account_key=encode(extensions.digest('d0000000-0000-0000-0000-000000000091','sha256'),'hex')
               and state <> 'completed') then
    raise exception 'Auth-absent finalization tombstone did not converge';
  end if;
end
$reconciled$;
delete from public.cloud_account_deletion_finalizations
where account_key=encode(extensions.digest('d0000000-0000-0000-0000-000000000091','sha256'),'hex');
commit;
