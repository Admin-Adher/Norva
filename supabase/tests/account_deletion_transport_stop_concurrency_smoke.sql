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
  -- A previous interrupted fixture is not a product deletion: bypass its
  -- terminal Auth guard only after the dependent test rows were removed.
  perform set_config('session_replication_role','replica',true);
  delete from auth.users where id='d0000000-0000-0000-0000-000000000094';
  perform set_config('session_replication_role','origin',true);
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

-- The durable reaper must remain in DRAINING while transport stop is pending:
-- it may schedule the provider action, but it cannot reach any purge state.
begin;
set local "request.jwt.claim.role" = 'service_role';
do $reaper_waits_for_transport$
declare v_advance jsonb; v_state text;
begin
  v_advance := public.norva_advance_account_deletion_workflow(
    'd0000000-0000-0000-0000-000000000094',0,50);
  select state into v_state from public.cloud_account_deletion_workflows
  where user_id='d0000000-0000-0000-0000-000000000094';
  if v_advance->>'state' <> 'draining' or v_advance->>'nextAction' <> 'provider_drain'
     or v_state <> 'draining' then
    raise exception 'reaper advanced while transport stop was unfinished';
  end if;
end
$reaper_waits_for_transport$;
commit;

do $two_sessions$
declare
  v_claim jsonb;
  v_valid jsonb;
  v_stale boolean := false;
  v_connection text;
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  perform public.dblink_connect('norva_transport_a',format(
    'host=127.0.0.1 port=%s dbname=%s user=%s connect_timeout=2',
    current_setting('port'),current_database(),current_user));
  perform public.dblink_connect('norva_transport_b',format(
    'host=127.0.0.1 port=%s dbname=%s user=%s connect_timeout=2',
    current_setting('port'),current_database(),current_user));
  perform public.dblink_exec('norva_transport_a','set "request.jwt.claim.role"=''service_role''');
  perform public.dblink_exec('norva_transport_b','set "request.jwt.claim.role"=''service_role''');
  select remote.payload into strict v_claim from public.dblink(
    'norva_transport_a',$sql$
      select public.norva_claim_account_deletion_transport_stop(
        'd0000000-0000-0000-0000-000000000094'::uuid,'transport-race-a',120)
    $sql$
  ) as remote(payload jsonb);
  if v_claim->>'state' <> 'processing' then
    raise exception 'transport claim A did not acquire processing state';
  end if;
  begin
    perform * from public.dblink('norva_transport_b',$sql$
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
  perform public.dblink_disconnect('norva_transport_a');
  perform public.dblink_disconnect('norva_transport_b');
exception when others then
  foreach v_connection in array array['norva_transport_a','norva_transport_b'] loop
    begin perform public.dblink_disconnect(v_connection); exception when others then null; end;
  end loop;
  raise;
end
$two_sessions$;

-- Crash after the first claim. Commit the expired lease as a separate durable
-- boundary before a second session attempts recovery; otherwise the test would
-- incorrectly retain a row lock that a real crashed worker cannot retain.
begin;
set local "request.jwt.claim.role" = 'service_role';
update public.cloud_account_deletion_workflows
set state='draining',revision=revision+1,updated_at=clock_timestamp()
where user_id='d0000000-0000-0000-0000-000000000094';
update public.cloud_provider_transport_stop_actions
set lease_until=clock_timestamp() - interval '1 second',updated_at=clock_timestamp()
where user_id='d0000000-0000-0000-0000-000000000094';
commit;

do $crash_reclaim$
declare v_reclaim jsonb; v_stale boolean := false; v_connection text;
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  perform public.dblink_connect('norva_transport_reclaim',format(
    'host=127.0.0.1 port=%s dbname=%s user=%s connect_timeout=2',
    current_setting('port'),current_database(),current_user));
  perform public.dblink_exec('norva_transport_reclaim','set "request.jwt.claim.role"=''service_role''');
  select remote.payload into strict v_reclaim from public.dblink(
    'norva_transport_reclaim',$sql$
      select public.norva_claim_account_deletion_transport_stop(
        'd0000000-0000-0000-0000-000000000094'::uuid,'transport-race-b',120)
    $sql$
  ) as remote(payload jsonb);
  if v_reclaim->>'state' <> 'processing'
     or (v_reclaim->>'leaseSequence')::integer <= 1
     or (v_reclaim->>'revision')::bigint <= 1 then
    raise exception 'transport crash reclaim did not bump its durable authority';
  end if;
  -- Old worker A cannot settle after B's durable reclaim.
  begin
    perform public.norva_settle_provider_transport_stop_action(
      'd0000000-0000-0000-0000-000000000094','transport-race-a',1,1,
      'completed',repeat('a',64),null,0
    );
  exception when sqlstate '40001' then v_stale := true;
  end;
  if not v_stale then raise exception 'expired worker A settled a transport stop'; end if;
  perform public.norva_revalidate_account_deletion_transport_stop(
    'd0000000-0000-0000-0000-000000000094','transport-race-b',
    (v_reclaim->>'deletionEpoch')::bigint,(v_reclaim->>'leaseSequence')::integer,
    (v_reclaim->>'revision')::bigint
  );
  perform public.norva_settle_provider_transport_stop_action(
    'd0000000-0000-0000-0000-000000000094','transport-race-b',
    (v_reclaim->>'leaseSequence')::integer,(v_reclaim->>'revision')::bigint,
    'completed',repeat('b',64),null,0
  );
  perform public.dblink_disconnect('norva_transport_reclaim');
exception when others then
  foreach v_connection in array array['norva_transport_reclaim'] loop
    begin perform public.dblink_disconnect(v_connection); exception when others then null; end;
  end loop;
  raise;
end
$crash_reclaim$;

-- Duplicate DELETE/begin calls are retries, not a second transport operation.
begin;
set local "request.jwt.claim.role" = 'service_role';
set local session_replication_role = replica;
delete from auth.users where id='d0000000-0000-0000-0000-000000000095';
set local session_replication_role = origin;
delete from public.cloud_account_deletion_workflows where user_id='d0000000-0000-0000-0000-000000000095';
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values ('d0000000-0000-0000-0000-000000000095',
  '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  'account-delete-repeat-095@invalid.test','not-used',clock_timestamp(),
  '{}'::jsonb,'{}'::jsonb,clock_timestamp(),clock_timestamp());
do $duplicate_begin$
declare v_first jsonb; v_second jsonb; v_preparations integer; v_actions integer; v_epoch bigint;
begin
  v_first := public.norva_begin_account_deletion_workflow('d0000000-0000-0000-0000-000000000095');
  v_second := public.norva_begin_account_deletion_workflow('d0000000-0000-0000-0000-000000000095');
  select count(*)::integer into v_preparations from public.cloud_provider_account_delete_preparations
  where user_id='d0000000-0000-0000-0000-000000000095';
  select count(*)::integer into v_actions from public.cloud_provider_transport_stop_actions
  where user_id='d0000000-0000-0000-0000-000000000095';
  select deletion_epoch into v_epoch from public.cloud_provider_account_delete_preparations
  where user_id='d0000000-0000-0000-0000-000000000095';
  if v_first->>'state' <> 'stopping' or v_second->>'state' <> 'stopping'
     or v_preparations <> 1 or v_actions <> 1 or v_epoch <> 1 then
    raise exception 'duplicate account deletion begin produced multiple stop operations';
  end if;
end
$duplicate_begin$;
set local session_replication_role = replica;
delete from auth.users where id='d0000000-0000-0000-0000-000000000095';
set local session_replication_role = origin;
delete from public.cloud_account_deletion_workflows where user_id='d0000000-0000-0000-0000-000000000095';
commit;

-- A source-affinity row may disappear after claim (for example during source
-- cleanup), but it must not erase the already-authorized gateway stop scope.
begin;
set local "request.jwt.claim.role" = 'service_role';
delete from public.cloud_provider_transport_stop_actions where user_id='d0000000-0000-0000-0000-000000000096';
delete from public.cloud_provider_account_delete_preparations where user_id='d0000000-0000-0000-0000-000000000096';
delete from public.cloud_source_provider_account_affinities where user_id='d0000000-0000-0000-0000-000000000096';
delete from public.cloud_account_deletion_workflows where user_id='d0000000-0000-0000-0000-000000000096';
set local session_replication_role = replica;
delete from public.cloud_source_lifecycle where source_id='d0000000-0000-0000-0000-000000000196';
delete from public.cloud_sources where id='d0000000-0000-0000-0000-000000000196';
delete from auth.users where id='d0000000-0000-0000-0000-000000000096';
set local session_replication_role = origin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values ('d0000000-0000-0000-0000-000000000096',
  '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  'account-delete-scope-096@invalid.test','not-used',clock_timestamp(),
  '{}'::jsonb,'{}'::jsonb,clock_timestamp(),clock_timestamp());
set local session_replication_role = replica;
insert into public.cloud_sources(
  id,user_id,source_type,display_name,config_hint
) values (
  'd0000000-0000-0000-0000-000000000196',
  'd0000000-0000-0000-0000-000000000096','custom','transport-scope-fixture','{}'::jsonb
);
set local session_replication_role = origin;
insert into public.cloud_source_provider_account_affinities(source_id,user_id,affinity_hash)
values ('d0000000-0000-0000-0000-000000000196','d0000000-0000-0000-0000-000000000096',repeat('e',64));
insert into public.cloud_account_deletion_workflows(user_id,state,revision)
values ('d0000000-0000-0000-0000-000000000096','draining',0);
insert into public.cloud_provider_account_delete_preparations(user_id,state,phase,deletion_epoch)
values ('d0000000-0000-0000-0000-000000000096','pending','drain',9);
insert into public.cloud_provider_transport_stop_actions(user_id,deletion_epoch,state)
values ('d0000000-0000-0000-0000-000000000096',9,'pending');
do $scope_snapshot$
declare v_claim jsonb; v_revalidated jsonb;
begin
  v_claim:=public.norva_claim_account_deletion_transport_stop(
    'd0000000-0000-0000-0000-000000000096','transport-scope',120);
  if v_claim->'affinityHashes' <> jsonb_build_array(repeat('e',64)) then
    raise exception 'claim did not persist immutable gateway scope';
  end if;
  delete from public.cloud_source_provider_account_affinities
  where user_id='d0000000-0000-0000-0000-000000000096';
  v_revalidated:=public.norva_revalidate_account_deletion_transport_stop(
    'd0000000-0000-0000-0000-000000000096','transport-scope',
    (v_claim->>'deletionEpoch')::bigint,(v_claim->>'leaseSequence')::integer,
    (v_claim->>'revision')::bigint);
  if v_revalidated->'affinityHashes' <> jsonb_build_array(repeat('e',64)) then
    raise exception 'source deletion erased claimed gateway scope';
  end if;
end
$scope_snapshot$;
delete from public.cloud_provider_transport_stop_actions where user_id='d0000000-0000-0000-0000-000000000096';
delete from public.cloud_provider_account_delete_preparations where user_id='d0000000-0000-0000-0000-000000000096';
delete from public.cloud_source_provider_account_affinities where user_id='d0000000-0000-0000-0000-000000000096';
delete from public.cloud_account_deletion_workflows where user_id='d0000000-0000-0000-0000-000000000096';
set local session_replication_role = replica;
delete from public.cloud_source_lifecycle where source_id='d0000000-0000-0000-0000-000000000196';
delete from public.cloud_sources where id='d0000000-0000-0000-0000-000000000196';
delete from auth.users where id='d0000000-0000-0000-0000-000000000096';
set local session_replication_role = origin;
commit;

-- Fixture teardown intentionally bypasses the Auth trigger only after all
-- assertions. It is test hygiene, not a production deletion path.
begin;
set local session_replication_role = replica;
delete from auth.users where id='d0000000-0000-0000-0000-000000000094';
set local session_replication_role = origin;
delete from public.cloud_account_deletion_workflows where user_id='d0000000-0000-0000-0000-000000000094';
commit;
