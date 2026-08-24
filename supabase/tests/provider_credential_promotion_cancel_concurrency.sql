\set ON_ERROR_STOP on
\if :{?race_mode}
\else
  \echo 'race_mode is required: promotion_wins or cancel_wins'
  \quit
\endif

-- This test consumes the committed fixture produced by
-- provider_credential_transition.sql with
-- -v phase3_prepare_concurrency_fixture=1.  It intentionally uses dblink
-- sessions rather than two calls in one SQL transaction.
begin;
set local statement_timeout = '60s';
set local lock_timeout = '2s';

drop trigger if exists norva_test_phase3_promotion_cancel_pause
  on public.cloud_source_transitions;
drop function if exists public.norva_test_phase3_promotion_cancel_pause();
drop function if exists public.norva_test_phase3_race_swap();
drop function if exists public.norva_test_phase3_race_cancel();

create function public.norva_test_phase3_promotion_cancel_pause()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_key text := current_setting('norva.test_phase3_race_pause',true);
begin
  if new.id = '93000000-0000-4000-8000-000000000000'::uuid then
    raise exception 'unreachable fixture id';
  end if;
  if v_key ~ '^[0-9]{1,18}$'
     and ((current_setting('norva.test_phase3_race_mode',true) = 'promotion_wins'
           and new.state = 'committing')
       or (current_setting('norva.test_phase3_race_mode',true) = 'cancel_wins'
           and new.state = 'cancelled')) then
    perform pg_catalog.pg_advisory_xact_lock(v_key::bigint);
  end if;
  return new;
end
$function$;

create trigger norva_test_phase3_promotion_cancel_pause
before update of state on public.cloud_source_transitions
for each row execute function public.norva_test_phase3_promotion_cancel_pause();

create function public.norva_test_phase3_race_swap()
returns jsonb
language plpgsql
set search_path = ''
as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_generation public.cloud_source_catalog_generations%rowtype;
  v_snapshot jsonb;
  v_result jsonb;
  v_detail text;
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  select transition.* into v_transition
  from public.cloud_source_transitions transition
  where transition.id = '93000000-0000-4000-8000-000000000000'::uuid;
  -- The fixture id is selected below from the durable unique test key.  This
  -- branch is replaced by the lookup before any RPC is invoked.
  if not found then
    select transition.* into strict v_transition
    from public.cloud_source_transitions transition
    where transition.idempotency_key = 'phase3-create-2';
  end if;
  select generation.* into strict v_generation
  from public.cloud_source_catalog_generations generation
  where generation.id = v_transition.candidate_catalog_generation_id;
  v_snapshot := public.norva_get_catalog_write_snapshot(
    v_transition.old_source_id,v_transition.user_id
  );
  begin
    v_result := public.norva_begin_credential_swap(
      v_transition.id,v_transition.user_id,v_generation.id,v_generation.revision,
      v_transition.revision,(v_snapshot->>'configRevision')::bigint,
      (v_snapshot->>'headRevision')::bigint,
      'phase3-promotion-cancel-swap-' || current_setting('norva.test_phase3_race_mode'),
      repeat('a',64)
    );
    return jsonb_build_object('sqlstate','00000','result',v_result);
  exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    return jsonb_build_object('sqlstate',sqlstate,'detail',coalesce(v_detail,''));
  end;
end
$function$;

create function public.norva_test_phase3_race_cancel()
returns jsonb
language plpgsql
set search_path = ''
as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_result jsonb;
  v_detail text;
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  select transition.* into strict v_transition
  from public.cloud_source_transitions transition
  where transition.idempotency_key = 'phase3-create-2';
  begin
    v_result := public.norva_cancel_credential_transition(
      v_transition.id,v_transition.user_id,'phase3-concurrency-test',
      v_transition.revision,
      'phase3-promotion-cancel-cancel-' || current_setting('norva.test_phase3_race_mode'),
      repeat('b',64)
    );
    return jsonb_build_object('sqlstate','00000','result',v_result);
  exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    return jsonb_build_object('sqlstate',sqlstate,'detail',coalesce(v_detail,''));
  end;
end
$function$;

revoke all on function public.norva_test_phase3_promotion_cancel_pause(),
  public.norva_test_phase3_race_swap(),public.norva_test_phase3_race_cancel()
from public,anon,authenticated,service_role;
commit;

select set_config('norva.test_phase3_requested_mode', :'race_mode', false);
do $race$
declare
  v_mode text := current_setting('norva.test_phase3_requested_mode');
  v_pause_key bigint := 32810001;
  v_first text;
  v_second text;
  v_first_call text;
  v_second_call text;
  v_first_pid integer;
  v_second_pid integer;
  v_first_result jsonb;
  v_second_result jsonb;
  v_transition public.cloud_source_transitions%rowtype;
  v_stale_job public.cloud_source_credential_transition_jobs%rowtype;
  v_stale_worker_rejected boolean := false;
  v_waited integer := 0;
  v_connection text;
begin
  if v_mode not in ('promotion_wins','cancel_wins') then
    raise exception 'unsupported race_mode: %',v_mode using errcode='22023';
  end if;
  select job.* into strict v_stale_job
  from public.cloud_source_credential_transition_jobs job
  join public.cloud_source_transitions transition
    on transition.id=job.transition_id
  where transition.idempotency_key='phase3-create-2'
    and job.state='processing' and job.lease_owner='phase3-identity-2';
  v_first := case when v_mode = 'promotion_wins' then 'phase3_race_swap' else 'phase3_race_cancel' end;
  v_second := case when v_mode = 'promotion_wins' then 'phase3_race_cancel' else 'phase3_race_swap' end;
  v_first_call := case when v_mode = 'promotion_wins'
    then 'select public.norva_test_phase3_race_swap()'
    else 'select public.norva_test_phase3_race_cancel()' end;
  v_second_call := case when v_mode = 'promotion_wins'
    then 'select public.norva_test_phase3_race_cancel()'
    else 'select public.norva_test_phase3_race_swap()' end;

  perform dblink_connect(v_first,format(
    'host=127.0.0.1 port=%s dbname=%s user=%s connect_timeout=2 options=''-c statement_timeout=15000''',
    current_setting('port'),current_database(),current_user));
  perform dblink_connect(v_second,format(
    'host=127.0.0.1 port=%s dbname=%s user=%s connect_timeout=2 options=''-c statement_timeout=15000''',
    current_setting('port'),current_database(),current_user));
  select pid into strict v_first_pid from dblink(v_first,'select pg_backend_pid()') as t(pid integer);
  select pid into strict v_second_pid from dblink(v_second,'select pg_backend_pid()') as t(pid integer);
  perform dblink_exec(v_first,'begin');
  perform dblink_exec(v_first,format('set local "request.jwt.claim.role"=''service_role''; set local norva.test_phase3_race_mode=%L; set local norva.test_phase3_race_pause=%L',v_mode,v_pause_key::text));
  perform dblink_exec(v_second,'begin');
  perform dblink_exec(v_second,format('set local "request.jwt.claim.role"=''service_role''; set local norva.test_phase3_race_mode=%L',v_mode));

  perform pg_catalog.pg_advisory_lock(v_pause_key);
  perform dblink_send_query(v_first,v_first_call);
  while v_waited < 300 and not exists (
    select 1 from pg_catalog.pg_stat_activity activity
    where activity.pid=v_first_pid and activity.wait_event_type='Lock'
  ) loop
    perform pg_catalog.pg_sleep(0.01); v_waited := v_waited + 1;
  end loop;
  if v_waited >= 300 or dblink_is_busy(v_first) <> 1 then
    raise exception 'first competitor did not reach deterministic advisory pause';
  end if;
  perform dblink_send_query(v_second,v_second_call);
  v_waited := 0;
  while v_waited < 300 and not exists (
    select 1 from pg_catalog.pg_stat_activity activity
    where activity.pid=v_second_pid and activity.wait_event_type='Lock'
  ) loop
    perform pg_catalog.pg_sleep(0.01); v_waited := v_waited + 1;
  end loop;
  if v_waited >= 300 or dblink_is_busy(v_second) <> 1 then
    raise exception 'second competitor did not serialize behind account lock';
  end if;
  perform pg_catalog.pg_advisory_unlock(v_pause_key);
  select payload into strict v_first_result from dblink_get_result(v_first) as t(payload jsonb);
  perform count(*) from dblink_get_result(v_first) as t(payload jsonb);
  perform dblink_exec(v_first,'commit');
  select payload into strict v_second_result from dblink_get_result(v_second) as t(payload jsonb);
  perform count(*) from dblink_get_result(v_second) as t(payload jsonb);
  perform dblink_exec(v_second,'commit');

  select transition.* into strict v_transition from public.cloud_source_transitions transition
  where transition.idempotency_key='phase3-create-2';
  if v_mode='promotion_wins' then
    if v_first_result->>'sqlstate' <> '00000' or v_second_result->>'sqlstate' <> '40001'
       or v_transition.state <> 'committing' then
      raise exception 'promotion/cancel race invariant failed: first=% second=% state=%',v_first_result,v_second_result,v_transition.state;
    end if;
  else
    if v_first_result->>'sqlstate' <> '00000' or v_second_result->>'sqlstate' <> '40001'
       or v_transition.state <> 'cancelled'
       or exists (select 1 from public.cloud_source_credential_transition_jobs job
                  where job.transition_id=v_transition.id and job.job_kind='post_switch_verify'
                    and job.state in ('pending','processing')) then
      raise exception 'cancel/promotion race invariant failed: first=% second=% state=%',v_first_result,v_second_result,v_transition.state;
    end if;
    begin
      perform set_config('request.jwt.claim.role','service_role',true);
      perform public.norva_settle_credential_transition_job(
        v_stale_job.id,'phase3-identity-2',
        v_stale_job.lease_sequence,'completed',null,1
      );
      raise exception 'pre-cancel worker unexpectedly settled after cancellation';
    exception when sqlstate '40001' then
      v_stale_worker_rejected := true;
    end;
    if not v_stale_worker_rejected then
      raise exception 'pre-cancel worker rejection was not observed';
    end if;
  end if;
  raise notice 'PHASE3_PROMOTION_CANCEL_RACE_PASS mode=% first=% second=% state=% stale_worker_rejected=%',
    v_mode,v_first_result,v_second_result,v_transition.state,v_stale_worker_rejected;
exception when others then
  perform pg_catalog.pg_advisory_unlock_all();
  foreach v_connection in array array['phase3_race_swap','phase3_race_cancel'] loop
    if dblink_get_connections() @> array[v_connection] then
      begin perform dblink_disconnect(v_connection); exception when others then null; end;
    end if;
  end loop;
  raise;
end
$race$;

begin;
drop trigger if exists norva_test_phase3_promotion_cancel_pause on public.cloud_source_transitions;
drop function if exists public.norva_test_phase3_promotion_cancel_pause();
drop function if exists public.norva_test_phase3_race_swap();
drop function if exists public.norva_test_phase3_race_cancel();
commit;
