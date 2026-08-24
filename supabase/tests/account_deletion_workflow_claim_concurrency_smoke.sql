\set ON_ERROR_STOP on
-- Two independent PostgreSQL sessions contend for one scheduler claim.  The
-- loser sees an empty SKIP LOCKED result; it never receives authority to run
-- a workflow step.  Fixture teardown uses the guarded production finalizer.
begin;
set local "request.jwt.claim.role" = 'service_role';
do $stale_fixture_cleanup$
declare v_workflow record; v_final record; v_steps integer := 0; v_result jsonb;
begin
  select * into v_workflow from public.cloud_account_deletion_workflows
  where user_id='d0000000-0000-0000-0000-000000000093' for update;
  if not found then return; end if;
  while v_workflow.state='purging_product' loop
    v_steps := v_steps + 1;
    if v_steps > 80 then raise exception 'interrupted workflow claim fixture did not converge'; end if;
    v_result := public.norva_purge_account_deletion_product_batch(
      v_workflow.user_id,v_workflow.revision,500
    );
    select * into v_workflow from public.cloud_account_deletion_workflows
    where user_id='d0000000-0000-0000-0000-000000000093' for update;
  end loop;
  select * into v_workflow from public.cloud_account_deletion_workflows
  where user_id='d0000000-0000-0000-0000-000000000093' for update;
  if v_workflow.state <> 'ready_to_finalize' then
    raise exception 'interrupted workflow claim fixture is not recoverable: %',v_workflow.state;
  end if;
  select * into strict v_final from public.norva_claim_account_deletion_finalizations(1,120)
  where user_id=v_workflow.user_id;
  delete from auth.users where id=v_workflow.user_id;
  perform public.norva_complete_account_deletion_finalization(v_final.finalization_key);
  delete from public.cloud_account_deletion_finalizations
  where finalization_key=v_final.finalization_key;
end
$stale_fixture_cleanup$;
insert into auth.users(
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) values (
  'd0000000-0000-0000-0000-000000000093',
  '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  'account-delete-workflow-race-093@invalid.test','not-used',clock_timestamp(),
  '{}'::jsonb,'{}'::jsonb,clock_timestamp(),clock_timestamp()
);
insert into public.cloud_account_deletion_workflows(user_id,state,revision)
values ('d0000000-0000-0000-0000-000000000093','purging_product',0);
insert into public.cloud_provider_account_delete_preparations(
  user_id,state,phase,deletion_epoch,ready_at
) values ('d0000000-0000-0000-0000-000000000093','ready','ready',1,clock_timestamp());
insert into public.cloud_provider_transport_stop_actions(
  user_id,deletion_epoch,state,completed_at,transport_stop_receipt_hash
) values ('d0000000-0000-0000-0000-000000000093',1,'completed',clock_timestamp(),repeat('d',64));
commit;

do $race$
declare
  v_a record;
  v_b record;
  v_connection text;
begin
  perform dblink_connect('norva_workflow_claim_a',format(
    'host=127.0.0.1 port=%s dbname=%s user=%s connect_timeout=2',
    current_setting('port'),current_database(),current_user));
  perform dblink_connect('norva_workflow_claim_b',format(
    'host=127.0.0.1 port=%s dbname=%s user=%s connect_timeout=2',
    current_setting('port'),current_database(),current_user));
  perform dblink_exec('norva_workflow_claim_a','begin');
  perform dblink_exec('norva_workflow_claim_a',
    'set local "request.jwt.claim.role"=''service_role''');
  perform dblink_exec('norva_workflow_claim_b',
    'set "request.jwt.claim.role"=''service_role''');
  perform dblink_send_query('norva_workflow_claim_a',
    'select * from public.norva_claim_account_deletion_workflows(1) where user_id=''d0000000-0000-0000-0000-000000000093''');
  select * into v_a from dblink_get_result('norva_workflow_claim_a')
    as t(user_id uuid,state text,revision bigint);
  perform 1 from dblink_get_result('norva_workflow_claim_a')
    as t(user_id uuid,state text,revision bigint);
  if v_a.user_id is null or v_a.revision <> 1 then
    raise exception 'first scheduler did not claim expected workflow revision';
  end if;
  -- A remains uncommitted, retaining the row lock. B must not wait and then
  -- claim a second revision; SKIP LOCKED makes it an explicit no-op.
  perform dblink_send_query('norva_workflow_claim_b',
    'select * from public.norva_claim_account_deletion_workflows(1) where user_id=''d0000000-0000-0000-0000-000000000093''');
  select * into v_b from dblink_get_result('norva_workflow_claim_b')
    as t(user_id uuid,state text,revision bigint);
  perform 1 from dblink_get_result('norva_workflow_claim_b')
    as t(user_id uuid,state text,revision bigint);
  if v_b.user_id is not null then
    raise exception 'second scheduler claimed a locked workflow';
  end if;
  perform dblink_exec('norva_workflow_claim_a','commit');
  perform dblink_disconnect('norva_workflow_claim_a');
  perform dblink_disconnect('norva_workflow_claim_b');
exception when others then
  foreach v_connection in array coalesce(dblink_get_connections(),array[]::text[]) loop
    if v_connection in ('norva_workflow_claim_a','norva_workflow_claim_b') then
      begin perform dblink_exec(v_connection,'rollback'); exception when others then null; end;
      begin perform dblink_disconnect(v_connection); exception when others then null; end;
    end if;
  end loop;
  raise;
end
$race$;

begin;
set local "request.jwt.claim.role" = 'service_role';
do $cleanup$
declare v_ready jsonb; v_claim record; v_steps integer := 0;
begin
  loop
    v_steps := v_steps + 1;
    if v_steps > 80 then raise exception 'race fixture cleanup did not converge'; end if;
    v_ready := public.norva_purge_account_deletion_product_batch(
      'd0000000-0000-0000-0000-000000000093',
      (select revision from public.cloud_account_deletion_workflows
       where user_id='d0000000-0000-0000-0000-000000000093'),25
    );
    exit when (v_ready->>'readyToFinalize')::boolean;
  end loop;
  if v_ready->>'state' <> 'ready_to_finalize' then
    raise exception 'race fixture did not reach guarded finalization';
  end if;
  select * into strict v_claim
  from public.norva_claim_account_deletion_finalizations(1,120)
  where user_id='d0000000-0000-0000-0000-000000000093';
  delete from auth.users where id='d0000000-0000-0000-0000-000000000093';
  perform public.norva_complete_account_deletion_finalization(v_claim.finalization_key);
  delete from public.cloud_account_deletion_finalizations
  where finalization_key=v_claim.finalization_key;
end
$cleanup$;
commit;
