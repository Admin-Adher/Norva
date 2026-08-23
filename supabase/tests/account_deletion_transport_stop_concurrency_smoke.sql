\set ON_ERROR_STOP on
-- Real PostgreSQL-session proof for the external gateway fence.  The fixture
-- is deliberately tiny; the broader begin→drain→purge→finalize flow is
-- covered by the account-deletion smokes. This file proves that only the
-- current claim may reach the gateway boundary.
begin;
set local "request.jwt.claim.role" = 'service_role';
do $setup$
begin
  if to_regclass('public.cloud_source_provider_account_affinities') is null then
    raise exception 'transport-stop smoke requires the Phase 3 affinity migration'
      using errcode = '55000';
  end if;
  delete from public.cloud_provider_transport_stop_actions
  where user_id='d0000000-0000-0000-0000-000000000094';
  delete from public.cloud_provider_account_delete_preparations
  where user_id='d0000000-0000-0000-0000-000000000094';
  delete from public.cloud_account_deletion_workflows
  where user_id='d0000000-0000-0000-0000-000000000094';
  delete from auth.users where id='d0000000-0000-0000-0000-000000000094';
  insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
    raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  values ('d0000000-0000-0000-0000-000000000094',
    '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
    'account-delete-transport-race-094@invalid.test','not-used',clock_timestamp(),
    '{}'::jsonb,'{}'::jsonb,clock_timestamp(),clock_timestamp());
  insert into public.cloud_account_deletion_workflows(user_id,state,revision)
  values ('d0000000-0000-0000-0000-000000000094','draining',0);
  insert into public.cloud_provider_account_delete_preparations(user_id,state,phase,deletion_epoch)
  values ('d0000000-0000-0000-0000-000000000094','pending','drain',7);
  insert into public.cloud_provider_transport_stop_actions(user_id,deletion_epoch,state)
  values ('d0000000-0000-0000-0000-000000000094',7,'pending');
end
$setup$;
commit;

do $two_sessions$
declare
  v_claim jsonb;
  v_valid jsonb;
  v_stale boolean := false;
  v_connection text;
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  perform extensions.dblink_connect('norva_transport_a',format(
    'host=127.0.0.1 port=%s dbname=%s user=%s connect_timeout=2',
    current_setting('port'),current_database(),current_user));
  perform extensions.dblink_connect('norva_transport_b',format(
    'host=127.0.0.1 port=%s dbname=%s user=%s connect_timeout=2',
    current_setting('port'),current_database(),current_user));
  perform extensions.dblink_exec('norva_transport_a','set "request.jwt.claim.role"=''service_role''');
  perform extensions.dblink_exec('norva_transport_b','set "request.jwt.claim.role"=''service_role''');
  select remote.payload into strict v_claim from extensions.dblink(
    'norva_transport_a',$sql$
      select public.norva_claim_account_deletion_transport_stop(
        'd0000000-0000-0000-0000-000000000094'::uuid,'transport-race-a',120)
    $sql$
  ) as remote(payload jsonb);
  if v_claim->>'state' <> 'processing' then
    raise exception 'transport claim A did not acquire processing state';
  end if;
  begin
    perform * from extensions.dblink('norva_transport_b',$sql$
      select public.norva_claim_account_deletion_transport_stop(
        'd0000000-0000-0000-0000-000000000094'::uuid,'transport-race-b',120)
    $sql$) as remote(payload jsonb);
  exception when sqlstate '40001' then v_stale := true;
  end;
  if not v_stale then
    raise exception 'transport claim B was not rejected as STALE';
  end if;
  select public.norva_revalidate_account_deletion_transport_stop(
    'd0000000-0000-0000-0000-000000000094','transport-race-a',
    (v_claim->>'deletionEpoch')::bigint,(v_claim->>'leaseSequence')::integer,
    (v_claim->>'revision')::bigint
  ) into v_valid;
  if v_valid->>'state' <> 'processing' then
    raise exception 'current transport claim did not revalidate';
  end if;
  update public.cloud_account_deletion_workflows
  set state='purging_analytics',revision=revision+1,updated_at=clock_timestamp()
  where user_id='d0000000-0000-0000-0000-000000000094';
  v_stale := false;
  begin
    perform public.norva_revalidate_account_deletion_transport_stop(
      'd0000000-0000-0000-0000-000000000094','transport-race-a',
      (v_claim->>'deletionEpoch')::bigint,(v_claim->>'leaseSequence')::integer,
      (v_claim->>'revision')::bigint
    );
  exception when sqlstate '40001' then v_stale := true;
  end;
  if not v_stale then
    raise exception 'transport worker survived a workflow fence bump';
  end if;
  perform extensions.dblink_disconnect('norva_transport_a');
  perform extensions.dblink_disconnect('norva_transport_b');
exception when others then
  foreach v_connection in array coalesce(extensions.dblink_get_connections(),array[]::text[]) loop
    if v_connection in ('norva_transport_a','norva_transport_b') then
      begin perform extensions.dblink_disconnect(v_connection); exception when others then null; end;
    end if;
  end loop;
  raise;
end
$two_sessions$;

-- Fixture teardown intentionally bypasses the Auth trigger only after all
-- assertions. It is test hygiene, not a production deletion path.
begin;
set local session_replication_role = replica;
delete from auth.users where id='d0000000-0000-0000-0000-000000000094';
set local session_replication_role = origin;
delete from public.cloud_account_deletion_workflows where user_id='d0000000-0000-0000-0000-000000000094';
commit;
