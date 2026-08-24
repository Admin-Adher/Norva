\set ON_ERROR_STOP on

-- Consumes the committed READY_TO_SWITCH fixture produced by
-- provider_replacement_candidate_builder.sql after replacing the synthetic
-- 930... prefix with 940... and passing
--   -v phase4_prepare_ready_fixture=1
-- The matrix terminates real PostgreSQL backends at transaction boundaries.

begin;
set local statement_timeout='90s';
set local lock_timeout='2s';

drop trigger if exists norva_test_phase4_crash_transition_pause
  on public.cloud_source_transitions;
drop trigger if exists norva_test_phase4_crash_source_pause
  on public.cloud_sources;
drop trigger if exists norva_test_phase4_crash_lifecycle_pause
  on public.cloud_source_lifecycle;
drop trigger if exists norva_test_phase4_crash_media_pause
  on public.cloud_media_items;
drop function if exists public.norva_test_phase4_crash_pause();
drop function if exists public.norva_test_phase4_crash_promote();
drop function if exists public.norva_test_phase4_crash_cancel();
drop function if exists public.norva_test_phase4_crash_rollback();
drop function if exists public.norva_test_phase4_crash_cleanup();
drop function if exists public.norva_test_phase4_remote_json(text,text);
drop function if exists public.norva_test_phase4_remote_exec(text,text);
drop function if exists public.norva_test_phase4_kill_before_commit(text,text,text,bigint);
drop function if exists public.norva_test_phase4_kill_after_commit(text,text);
drop function if exists public.norva_test_phase4_kill_after_commit(text,text,bigint);

create function public.norva_test_phase4_crash_pause()
returns trigger
language plpgsql
set search_path=''
as $function$
declare
  v_key text:=current_setting('norva.test_phase4_crash_key',true);
  v_phase text:=current_setting('norva.test_phase4_crash_phase',true);
  v_old jsonb:=case when tg_op='INSERT' then '{}'::jsonb else to_jsonb(old) end;
  v_new jsonb:=case when tg_op='DELETE' then '{}'::jsonb else to_jsonb(new) end;
begin
  if v_key~'^[0-9]{1,18}$' and (
    (v_phase='cancel' and tg_table_name='cloud_source_transitions'
      and v_old->>'id'='94000000-0000-4000-8000-000000000601'
      and v_new->>'state'='cancelled')
    or (v_phase='promote' and tg_table_name='cloud_source_transitions'
      and v_old->>'id'='94000000-0000-4000-8000-000000000601'
      and v_new->>'state'='completed')
    or (v_phase='rollback' and tg_table_name='cloud_source_transitions'
      and v_new->>'reversal_of_transition_id'=
        '94000000-0000-4000-8000-000000000601'
      and v_new->>'state'='committing')
    or (v_phase='cleanup_prepare' and tg_table_name='cloud_sources'
      and v_old->>'id'='94000000-0000-4000-8000-000000000102'
      and nullif(v_old->>'deleted_at','') is null
      and nullif(v_new->>'deleted_at','') is not null)
    or (v_phase='reaper' and tg_table_name='cloud_sources'
      and v_old->>'id'='94000000-0000-4000-8000-000000000102'
      and coalesce((v_old->>'provider_deletion_pending')::boolean,false)=false
       and coalesce((v_new->>'provider_deletion_pending')::boolean,false)=true)
    or (v_phase='reaper' and tg_table_name='cloud_media_items'
      and tg_op='DELETE'
      and v_old->>'source_id'='94000000-0000-4000-8000-000000000102')
    or (v_phase='cleanup_final' and tg_table_name='cloud_source_lifecycle'
      and v_old->>'source_id'='94000000-0000-4000-8000-000000000102'
      and v_old->>'lifecycle_state'='purge_pending'
      and v_new->>'lifecycle_state'='purged')
  ) then
    perform pg_catalog.pg_advisory_xact_lock(v_key::bigint);
  end if;
  return case when tg_op='DELETE' then old else new end;
end
$function$;

create trigger norva_test_phase4_crash_transition_pause
before update of state on public.cloud_source_transitions
for each row execute function public.norva_test_phase4_crash_pause();
create trigger norva_test_phase4_crash_source_pause
before update of deleted_at,provider_deletion_pending on public.cloud_sources
for each row execute function public.norva_test_phase4_crash_pause();
create trigger norva_test_phase4_crash_lifecycle_pause
  before update of lifecycle_state on public.cloud_source_lifecycle
  for each row execute function public.norva_test_phase4_crash_pause();
create trigger norva_test_phase4_crash_media_pause
  before delete on public.cloud_media_items
  for each row execute function public.norva_test_phase4_crash_pause();

create function public.norva_test_phase4_crash_promote()
returns jsonb language plpgsql set search_path='' as $function$
declare v_transition public.cloud_source_transitions%rowtype;
  v_head public.cloud_source_catalog_heads%rowtype;
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  select * into strict v_transition from public.cloud_source_transitions
  where id='94000000-0000-4000-8000-000000000601';
  select * into strict v_head from public.cloud_source_catalog_heads
  where source_id=v_transition.candidate_source_id and user_id=v_transition.user_id;
  return public.norva_promote_source_replacement_v3(
    v_transition.id,v_transition.user_id,'phase4-crash-promote',
    v_transition.expected_source_revision,
    coalesce(v_transition.promotion_expected_transition_revision,v_transition.revision),
    case when v_transition.state='completed'
      then v_head.head_revision-1 else v_head.head_revision end
  );
end $function$;

create function public.norva_test_phase4_crash_cancel()
returns jsonb language plpgsql set search_path='' as $function$
declare v_transition public.cloud_source_transitions%rowtype;
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  select * into strict v_transition from public.cloud_source_transitions
  where id='94000000-0000-4000-8000-000000000601';
  return public.norva_cancel_source_replacement(
    v_transition.id,v_transition.user_id,'phase4-crash-worker',
    v_transition.revision,'phase4-crash-cancel',repeat('c',64)
  );
end $function$;

create function public.norva_test_phase4_crash_rollback()
returns jsonb language plpgsql set search_path='' as $function$
declare v_transition public.cloud_source_transitions%rowtype;
  v_active public.cloud_source_lifecycle%rowtype;
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  select * into strict v_transition from public.cloud_source_transitions
  where id='94000000-0000-4000-8000-000000000601';
  select * into strict v_active from public.cloud_source_lifecycle
  where source_id=v_transition.candidate_source_id and user_id=v_transition.user_id;
  return public.norva_rollback_source_replacement(
    v_transition.id,v_transition.user_id,'phase4-crash-worker',
    'phase4-crash-rollback',repeat('d',64),v_transition.revision,
    v_active.config_revision
  );
end $function$;

create function public.norva_test_phase4_crash_cleanup()
returns jsonb language plpgsql set search_path='' as $function$
declare v_reverse_id uuid; v_result jsonb;
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  select reversal.id into strict v_reverse_id
  from public.cloud_source_transitions reversal
  where reversal.reversal_of_transition_id=
    '94000000-0000-4000-8000-000000000601'
    and reversal.state='completed';
  update public.cloud_source_replacement_cleanup_jobs job
  set available_at=case when job.transition_id=v_reverse_id
    then clock_timestamp() else clock_timestamp()+interval '1 hour' end
  where job.state='pending';
  v_result:=public.norva_run_replacement_cleanup_batch('phase4-crash-worker',200);
  -- The disposable proof database intentionally contains historical residue.
  -- Make this source the oldest eligible tombstone so the bounded reaper's
  -- LIMIT cannot select an unrelated fixture ahead of the crash target.
  update public.cloud_sources source
  set deleted_at='2000-01-01 00:00:00+00'::timestamptz
  where source.id='94000000-0000-4000-8000-000000000102'
    and source.deleted_at is not null
    and not source.provider_deletion_pending;
  return v_result;
end $function$;

-- Keep every successful mutation outside the matrix DO transaction.  Several
-- production RPCs acquire transaction-scoped account locks; executing a replay
-- locally would retain that lock until the entire matrix ends and could make a
-- later crash worker wait before reaching the boundary under test.
create function public.norva_test_phase4_remote_json(
  p_connection text,p_sql text
) returns jsonb language plpgsql set search_path='' as $function$
declare v_result jsonb;
begin
  perform public.dblink_connect(p_connection,format(
    'host=127.0.0.1 port=%s dbname=%s user=%s connect_timeout=2 options=''-c statement_timeout=60000''',
    current_setting('port'),current_database(),current_user));
  perform public.dblink_exec(p_connection,
    'set "request.jwt.claim.role"=''service_role''');
  select result into strict v_result
  from public.dblink(p_connection,p_sql) as response(result jsonb);
  perform public.dblink_disconnect(p_connection);
  return v_result;
exception when others then
  if coalesce(public.dblink_get_connections(),array[]::text[]) @> array[p_connection] then
    begin perform public.dblink_disconnect(p_connection); exception when others then null; end;
  end if;
  raise;
end $function$;

create function public.norva_test_phase4_remote_exec(
  p_connection text,p_sql text
) returns void language plpgsql set search_path='' as $function$
begin
  perform public.dblink_connect(p_connection,format(
    'host=127.0.0.1 port=%s dbname=%s user=%s connect_timeout=2 options=''-c statement_timeout=60000''',
    current_setting('port'),current_database(),current_user));
  perform public.dblink_exec(p_connection,
    'set "request.jwt.claim.role"=''service_role''');
  perform public.dblink_exec(p_connection,p_sql);
  perform public.dblink_disconnect(p_connection);
exception when others then
  if coalesce(public.dblink_get_connections(),array[]::text[]) @> array[p_connection] then
    begin perform public.dblink_disconnect(p_connection); exception when others then null; end;
  end if;
  raise;
end $function$;

create function public.norva_test_phase4_kill_before_commit(
  p_connection text,p_sql text,p_phase text,p_key bigint
) returns void language plpgsql set search_path='' as $function$
declare v_pid integer; v_waited integer:=0; v_terminated boolean;
  v_remote_finished boolean:=false; v_remote_status text;
begin
  perform public.dblink_connect(p_connection,format(
    'host=127.0.0.1 port=%s dbname=%s user=%s connect_timeout=2 options=''-c statement_timeout=30000''',
    current_setting('port'),current_database(),current_user));
  select pid into strict v_pid
  from public.dblink(p_connection,'select pg_backend_pid()') as t(pid integer);
  perform public.dblink_exec(p_connection,'begin');
  perform public.dblink_exec(p_connection,format(
    'set local "request.jwt.claim.role"=''service_role''; '
    ||'set local norva.test_phase4_crash_phase=%L; '
    ||'set local norva.test_phase4_crash_key=%L',p_phase,p_key::text));
  perform pg_catalog.pg_advisory_lock(p_key);
  perform public.dblink_send_query(p_connection,p_sql);
  while v_waited<3000 and not exists(
    select 1 from pg_catalog.pg_locks waiting
    where waiting.pid=v_pid and waiting.locktype='advisory'
      and not waiting.granted and waiting.classid=0
      and waiting.objid::bigint=p_key
  ) loop
    if public.dblink_is_busy(p_connection)=0 then
      v_remote_finished:=true;
      exit;
    end if;
    perform pg_catalog.pg_stat_clear_snapshot();
    perform pg_catalog.pg_sleep(0.01); v_waited:=v_waited+1;
  end loop;
  if v_remote_finished then
    v_remote_status:=public.dblink_error_message(p_connection);
    raise exception 'phase4 crash boundary % was not reached before remote completion: %',
      p_phase,v_remote_status;
  end if;
  if v_waited>=3000 then
    raise exception 'phase4 crash boundary % was not reached',p_phase;
  end if;
  select pg_catalog.pg_terminate_backend(v_pid) into v_terminated;
  perform pg_catalog.pg_advisory_unlock(p_key);
  if not v_terminated then raise exception 'phase4 backend was not terminated'; end if;
  for v_waited in 1..300 loop
    exit when not exists(select 1 from pg_catalog.pg_stat_activity where pid=v_pid);
    perform pg_catalog.pg_sleep(0.01);
  end loop;
  begin perform public.dblink_disconnect(p_connection); exception when others then null; end;
exception when others then
  perform pg_catalog.pg_advisory_unlock(p_key);
  if coalesce(public.dblink_get_connections(),array[]::text[]) @> array[p_connection] then
    begin perform public.dblink_disconnect(p_connection); exception when others then null; end;
  end if;
  raise;
end $function$;

create function public.norva_test_phase4_kill_after_commit(
  p_connection text,p_sql text,p_key bigint
) returns void language plpgsql set search_path='' as $function$
declare v_pid integer; v_waited integer:=0; v_terminated boolean;
begin
  perform public.dblink_connect(p_connection,format(
    'host=127.0.0.1 port=%s dbname=%s user=%s connect_timeout=2 options=''-c statement_timeout=60000''',
    current_setting('port'),current_database(),current_user));
  select pid into strict v_pid
  from public.dblink(p_connection,'select pg_backend_pid()') as t(pid integer);
  perform pg_catalog.pg_advisory_lock(p_key);
  perform public.dblink_send_query(
    p_connection,p_sql||format('; select pg_advisory_lock(%s)',p_key)
  );
  while v_waited<3000 and not exists(
    select 1 from pg_catalog.pg_locks waiting
    where waiting.pid=v_pid and waiting.locktype='advisory'
      and not waiting.granted and waiting.classid=0
      and waiting.objid::bigint=p_key
  ) loop
    perform pg_catalog.pg_stat_clear_snapshot();
    perform pg_catalog.pg_sleep(0.01); v_waited:=v_waited+1;
  end loop;
  if v_waited>=3000 then
    perform pg_catalog.pg_advisory_unlock(p_key);
    raise exception 'phase4 post-commit barrier was not reached';
  end if;
  select pg_catalog.pg_terminate_backend(v_pid) into v_terminated;
  perform pg_catalog.pg_advisory_unlock(p_key);
  if not v_terminated then raise exception 'phase4 post-commit backend was not terminated'; end if;
  for v_waited in 1..300 loop
    exit when not exists(select 1 from pg_catalog.pg_stat_activity where pid=v_pid);
    perform pg_catalog.pg_sleep(0.01);
  end loop;
  begin perform public.dblink_disconnect(p_connection); exception when others then null; end;
exception when others then
  perform pg_catalog.pg_advisory_unlock(p_key);
  if coalesce(public.dblink_get_connections(),array[]::text[]) @> array[p_connection] then
    begin perform public.dblink_disconnect(p_connection); exception when others then null; end;
  end if;
  raise;
end $function$;

revoke all on function public.norva_test_phase4_crash_pause(),
 public.norva_test_phase4_crash_promote(),
 public.norva_test_phase4_crash_cancel(),
 public.norva_test_phase4_crash_rollback(),
 public.norva_test_phase4_crash_cleanup(),
 public.norva_test_phase4_remote_json(text,text),
 public.norva_test_phase4_remote_exec(text,text),
 public.norva_test_phase4_kill_before_commit(text,text,text,bigint),
 public.norva_test_phase4_kill_after_commit(text,text,bigint)
from public,anon,authenticated,service_role;
commit;

do $matrix$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_lifecycle_a public.cloud_source_lifecycle%rowtype;
  v_lifecycle_b public.cloud_source_lifecycle%rowtype;
  v_source_b public.cloud_sources%rowtype;
  v_head_b public.cloud_source_catalog_heads%rowtype;
  v_result jsonb;
  v_reverse_id uuid;
  v_connection text;
begin
  select * into strict v_transition from public.cloud_source_transitions
  where id='94000000-0000-4000-8000-000000000601';
  if v_transition.state<>'ready_to_switch' then
    raise exception 'phase4 crash fixture is not READY_TO_SWITCH: %',v_transition.state;
  end if;

  -- 1. Cancel killed before COMMIT leaves the promotable fixture untouched.
  perform public.norva_test_phase4_kill_before_commit(
    'phase4_crash_cancel','select public.norva_test_phase4_crash_cancel()',
    'cancel',42840101);
  select * into strict v_transition from public.cloud_source_transitions
  where id='94000000-0000-4000-8000-000000000601';
  select * into strict v_source_b from public.cloud_sources
  where id=v_transition.candidate_source_id;
  if v_transition.state<>'ready_to_switch' or v_source_b.deleted_at is not null
     or exists(select 1 from public.cloud_source_lifecycle_events event
       where event.transition_id=v_transition.id
         and event.idempotency_key='phase4-crash-cancel') then
    raise exception 'cancel crash leaked partial state';
  end if;
  raise notice 'PHASE4_CRASH_BOUNDARY_PASS boundary=cancel_before_commit state=%',v_transition.state;

  -- 2. Promotion killed after its terminal transition update but before COMMIT
  -- rolls back visibility, head, cleanup job and transition together.
  select * into strict v_head_b from public.cloud_source_catalog_heads
  where source_id=v_transition.candidate_source_id and user_id=v_transition.user_id;
  perform public.norva_test_phase4_kill_before_commit(
    'phase4_crash_promote','select public.norva_test_phase4_crash_promote()',
    'promote',42840102);
  select * into strict v_transition from public.cloud_source_transitions
  where id='94000000-0000-4000-8000-000000000601';
  select * into strict v_lifecycle_a from public.cloud_source_lifecycle
  where source_id=v_transition.old_source_id and user_id=v_transition.user_id;
  select * into strict v_lifecycle_b from public.cloud_source_lifecycle
  where source_id=v_transition.candidate_source_id and user_id=v_transition.user_id;
  if v_transition.state<>'ready_to_switch'
     or v_lifecycle_a.catalog_visibility<>'visible'
     or v_lifecycle_b.catalog_visibility<>'hidden'
     or exists(select 1 from public.cloud_source_replacement_cleanup_jobs job
       where job.transition_id=v_transition.id) then
    raise exception 'promotion crash leaked partial state';
  end if;
  raise notice 'PHASE4_CRASH_BOUNDARY_PASS boundary=promotion_before_commit state=% visible=A',v_transition.state;

  -- 3. Commit promotion, then kill the backend before its caller can settle.
  -- Exact replay must reconstruct the already committed result.
  perform public.norva_test_phase4_kill_after_commit(
    'phase4_crash_promote_ack',
    'begin; select public.norva_test_phase4_crash_promote(); commit',42840107);
  select * into strict v_transition from public.cloud_source_transitions
  where id='94000000-0000-4000-8000-000000000601';
  v_result:=public.norva_test_phase4_remote_json(
    'phase4_crash_promote_replay','select public.norva_test_phase4_crash_promote()');
  select * into strict v_lifecycle_a from public.cloud_source_lifecycle
  where source_id=v_transition.old_source_id and user_id=v_transition.user_id;
  select * into strict v_lifecycle_b from public.cloud_source_lifecycle
  where source_id=v_transition.candidate_source_id and user_id=v_transition.user_id;
  if v_transition.state<>'completed' or coalesce((v_result->>'replayed')::boolean,false)=false
     or v_lifecycle_a.catalog_visibility<>'hidden'
     or v_lifecycle_b.catalog_visibility<>'visible'
     or (select count(*) from public.cloud_source_replacement_cleanup_jobs job
       where job.transition_id=v_transition.id)<>1 then
    raise exception 'promotion post-commit recovery did not converge: %',v_result;
  end if;
  raise notice 'PHASE4_CRASH_BOUNDARY_PASS boundary=promotion_after_commit state=% replayed=true visible=B',v_transition.state;

  -- 4. Rollback killed while its compensating transition is COMMITTING leaves
  -- no reversal and cannot expose A+B.
  perform public.norva_test_phase4_kill_before_commit(
    'phase4_crash_rollback','select public.norva_test_phase4_crash_rollback()',
    'rollback',42840103);
  if exists(select 1 from public.cloud_source_transitions reversal
       where reversal.reversal_of_transition_id=v_transition.id)
     or (select count(*) from public.cloud_source_lifecycle lifecycle
       where lifecycle.user_id=v_transition.user_id
         and lifecycle.lifecycle_state='active'
         and lifecycle.catalog_visibility='visible')<>1
     or not exists(select 1 from public.cloud_source_lifecycle lifecycle
       where lifecycle.source_id=v_transition.candidate_source_id
         and lifecycle.lifecycle_state='active'
         and lifecycle.catalog_visibility='visible') then
    raise exception 'rollback crash leaked partial state';
  end if;
  raise notice 'PHASE4_CRASH_BOUNDARY_PASS boundary=rollback_before_commit reversals=0 visible=B';

  -- 5. Commit rollback, lose the response, then exact replay returns the one
  -- durable compensating transition.
  perform public.norva_test_phase4_kill_after_commit(
    'phase4_crash_rollback_ack',
    'begin; select public.norva_test_phase4_crash_rollback(); commit',42840108);
  v_result:=public.norva_test_phase4_remote_json(
    'phase4_crash_rollback_replay','select public.norva_test_phase4_crash_rollback()');
  select reversal.id into strict v_reverse_id
  from public.cloud_source_transitions reversal
  where reversal.reversal_of_transition_id=v_transition.id;
  if coalesce((v_result->>'replayed')::boolean,false)=false
     or (v_result->>'rollbackTransitionId')::uuid<>v_reverse_id
     or (select count(*) from public.cloud_source_transitions reversal
       where reversal.reversal_of_transition_id=v_transition.id)<>1
     or not exists(select 1 from public.cloud_source_lifecycle lifecycle
       where lifecycle.source_id=v_transition.old_source_id
         and lifecycle.lifecycle_state='active'
         and lifecycle.catalog_visibility='visible') then
    raise exception 'rollback post-commit recovery did not converge: %',v_result;
  end if;
  raise notice 'PHASE4_CRASH_BOUNDARY_PASS boundary=rollback_after_commit reversals=1 replayed=true visible=A';

  -- 6. Cleanup preparation killed before COMMIT leaves B unsanitized. A
  -- committed preparation with a lost acknowledgement remains resumable.
  perform public.norva_test_phase4_kill_before_commit(
    'phase4_crash_cleanup_prepare','select public.norva_test_phase4_crash_cleanup()',
    'cleanup_prepare',42840104);
  select * into strict v_source_b from public.cloud_sources
  where id=v_transition.candidate_source_id;
  if v_source_b.deleted_at is not null then
    raise exception 'cleanup preparation crash leaked source tombstone';
  end if;
  perform public.norva_test_phase4_kill_after_commit(
    'phase4_crash_cleanup_prepare_ack',
    'begin; select public.norva_test_phase4_crash_cleanup(); commit',42840109);
  select * into strict v_source_b from public.cloud_sources
  where id=v_transition.candidate_source_id;
  select * into strict v_lifecycle_b from public.cloud_source_lifecycle
  where source_id=v_transition.candidate_source_id and user_id=v_transition.user_id;
  if v_source_b.deleted_at is null or v_source_b.provider_deletion_pending
     or v_lifecycle_b.lifecycle_state<>'purge_pending' then
    raise exception 'cleanup preparation post-commit recovery is not resumable';
  end if;
  raise notice 'PHASE4_CRASH_BOUNDARY_PASS boundary=cleanup_prepare_after_commit lifecycle=% provider_pending=false',v_lifecycle_b.lifecycle_state;

-- End the cutover transaction before exercising the reaper.  The production
-- reaper deliberately uses FOR UPDATE SKIP LOCKED; retaining any fixture row
-- lock in this proof transaction would make a healthy reaper skip the target.
exception when others then
  perform pg_catalog.pg_advisory_unlock_all();
  foreach v_connection in array array[
    'phase4_crash_cancel','phase4_crash_promote','phase4_crash_promote_ack',
    'phase4_crash_promote_replay','phase4_crash_rollback',
    'phase4_crash_rollback_ack','phase4_crash_rollback_replay',
    'phase4_crash_cleanup_prepare','phase4_crash_cleanup_prepare_ack'
  ] loop
    if coalesce(public.dblink_get_connections(),array[]::text[]) @> array[v_connection] then
      begin perform public.dblink_disconnect(v_connection); exception when others then null; end;
    end if;
  end loop;
  raise;
end
$matrix$;

-- Synchronize with the backend that was terminated after cleanup COMMIT.  The
-- reaper is intentionally SKIP LOCKED, so prove the tombstone is unlocked
-- before asking a new process to claim it.
begin;
select source.id from public.cloud_sources source
where source.id='94000000-0000-4000-8000-000000000102'
for update;
commit;

do $reaper_claim$
declare v_attempt integer; v_claimed boolean:=false; v_message text;
begin
  for v_attempt in 1..60 loop
    begin
      perform public.norva_test_phase4_kill_before_commit(
        'phase4_crash_reaper','call public.reap_deleted_sources()',
        'reaper',42840105);
      v_claimed:=true;
      exit;
    exception when others then
      get stacked diagnostics v_message=message_text;
      if v_message not like
        'phase4 crash boundary reaper was not reached before remote completion: OK%' then
        raise;
      end if;
    end;
    perform pg_catalog.pg_sleep(0.25);
  end loop;
  if not v_claimed then
    raise exception 'phase4 reaper singleton could not be claimed after 60 attempts';
  end if;
end
$reaper_claim$;

do $cleanup_matrix$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_lifecycle_b public.cloud_source_lifecycle%rowtype;
  v_source_b public.cloud_sources%rowtype;
  v_result jsonb;
  v_reverse_id uuid;
  v_connection text;
begin
  select * into strict v_transition from public.cloud_source_transitions
  where id='94000000-0000-4000-8000-000000000601';
  select reversal.id into strict v_reverse_id
  from public.cloud_source_transitions reversal
  where reversal.reversal_of_transition_id=v_transition.id;

  -- 7. The autonomous statement above killed the bounded source reaper before
  -- its terminal tombstone update. All row deletes must have rolled back.
  select * into strict v_source_b from public.cloud_sources
  where id=v_transition.candidate_source_id;
  if v_source_b.provider_deletion_pending
     or not exists(select 1 from public.cloud_media_items item
       where item.source_id=v_transition.candidate_source_id) then
    raise exception 'source reaper crash leaked a partial drain';
  end if;
  perform public.norva_test_phase4_remote_exec(
    'phase4_crash_reaper_restart','call public.reap_deleted_sources()');
  select * into strict v_source_b from public.cloud_sources
  where id=v_transition.candidate_source_id;
  if not v_source_b.provider_deletion_pending
     or exists(select 1 from public.cloud_media_items item
       where item.source_id=v_transition.candidate_source_id) then
    raise exception 'source reaper restart did not converge';
  end if;
  raise notice 'PHASE4_CRASH_BOUNDARY_PASS boundary=reaper_restart provider_pending=true catalog_rows=0';

exception when others then
  perform pg_catalog.pg_advisory_unlock_all();
  foreach v_connection in array array[
    'phase4_crash_reaper','phase4_crash_reaper_restart'
  ] loop
    if coalesce(public.dblink_get_connections(),array[]::text[]) @> array[v_connection] then
      begin perform public.dblink_disconnect(v_connection); exception when others then null; end;
    end if;
  end loop;
  raise;
end
$cleanup_matrix$;

begin;
select source.id from public.cloud_sources source
where source.id='94000000-0000-4000-8000-000000000102'
for update;
commit;

select public.norva_test_phase4_kill_before_commit(
  'phase4_crash_cleanup_final','select public.norva_test_phase4_crash_cleanup()',
  'cleanup_final',42840106);

do $final_cleanup_matrix$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_lifecycle_b public.cloud_source_lifecycle%rowtype;
  v_source_b public.cloud_sources%rowtype;
  v_result jsonb;
  v_reverse_id uuid;
  v_connection text;
begin
  select * into strict v_transition from public.cloud_source_transitions
  where id='94000000-0000-4000-8000-000000000601';
  select reversal.id into strict v_reverse_id
  from public.cloud_source_transitions reversal
  where reversal.reversal_of_transition_id=v_transition.id;

  -- 8. The autonomous statement above killed final sanitization before COMMIT.
  -- A new cleanup worker must converge from the durable purge-pending state.
  select * into strict v_source_b from public.cloud_sources
  where id=v_transition.candidate_source_id;
  select * into strict v_lifecycle_b from public.cloud_source_lifecycle
  where source_id=v_transition.candidate_source_id and user_id=v_transition.user_id;
  if v_source_b.config_ciphertext is null or v_lifecycle_b.lifecycle_state<>'purge_pending' then
    raise exception 'final cleanup crash leaked partial sanitization';
  end if;
  v_result:=public.norva_test_phase4_remote_json(
    'phase4_crash_cleanup_restart','select public.norva_test_phase4_crash_cleanup()');
  select * into strict v_source_b from public.cloud_sources
  where id=v_transition.candidate_source_id;
  select * into strict v_lifecycle_b from public.cloud_source_lifecycle
  where source_id=v_transition.candidate_source_id and user_id=v_transition.user_id;
  if coalesce((v_result->>'complete')::boolean,false)=false
     or v_source_b.config_ciphertext is not null
     or v_source_b.config_hint<>'{}'::jsonb
     or v_lifecycle_b.lifecycle_state<>'purged'
     or (select state from public.cloud_source_replacement_cleanup_jobs
       where transition_id=v_reverse_id)<>'completed' then
    raise exception 'final cleanup restart did not converge: %',v_result;
  end if;
  raise notice 'PHASE4_CRASH_BOUNDARY_PASS boundary=cleanup_final_restart lifecycle=purged credentials=cleared';
  raise notice 'PHASE4_REPLACEMENT_TRANSACTION_CRASH_MATRIX_PASS boundaries=8 visible_sources=1 reversals=1';
exception when others then
  perform pg_catalog.pg_advisory_unlock_all();
  foreach v_connection in array array[
    'phase4_crash_cancel','phase4_crash_promote','phase4_crash_promote_ack',
    'phase4_crash_promote_replay',
    'phase4_crash_rollback','phase4_crash_rollback_ack',
    'phase4_crash_rollback_replay',
    'phase4_crash_cleanup_prepare','phase4_crash_cleanup_prepare_ack',
    'phase4_crash_reaper','phase4_crash_reaper_restart',
    'phase4_crash_cleanup_final','phase4_crash_cleanup_restart'
  ] loop
    if coalesce(public.dblink_get_connections(),array[]::text[]) @> array[v_connection] then
      begin perform public.dblink_disconnect(v_connection); exception when others then null; end;
    end if;
  end loop;
  raise;
end
$final_cleanup_matrix$;

begin;
drop trigger if exists norva_test_phase4_crash_transition_pause
  on public.cloud_source_transitions;
drop trigger if exists norva_test_phase4_crash_source_pause
  on public.cloud_sources;
drop trigger if exists norva_test_phase4_crash_lifecycle_pause
  on public.cloud_source_lifecycle;
drop trigger if exists norva_test_phase4_crash_media_pause
  on public.cloud_media_items;
drop function if exists public.norva_test_phase4_crash_pause();
drop function if exists public.norva_test_phase4_crash_promote();
drop function if exists public.norva_test_phase4_crash_cancel();
drop function if exists public.norva_test_phase4_crash_rollback();
drop function if exists public.norva_test_phase4_crash_cleanup();
drop function if exists public.norva_test_phase4_remote_json(text,text);
drop function if exists public.norva_test_phase4_remote_exec(text,text);
drop function if exists public.norva_test_phase4_kill_before_commit(text,text,text,bigint);
drop function if exists public.norva_test_phase4_kill_after_commit(text,text);
drop function if exists public.norva_test_phase4_kill_after_commit(text,text,bigint);
commit;
