\set ON_ERROR_STOP on
\if :{?race_mode}
\else
  \echo 'race_mode is required'
  \quit
\endif
\if :{?fixture_transition_id}
\else
  \echo 'fixture_transition_id is required'
  \quit
\endif

-- Consumes one committed READY_TO_SWITCH fixture produced by
-- provider_replacement_candidate_builder.sql with
-- -v phase4_prepare_ready_fixture=1. Each race order requires a new fixture.
begin;
set local statement_timeout='60s';
set local lock_timeout='2s';

drop trigger if exists norva_test_phase4_race_transition_pause
  on public.cloud_source_transitions;
drop trigger if exists norva_test_phase4_race_delete_pause
  on public.cloud_provider_account_delete_preparations;
drop function if exists public.norva_test_phase4_race_pause();
drop function if exists public.norva_test_phase4_race_action(text);

create function public.norva_test_phase4_race_pause()
returns trigger language plpgsql set search_path='' as $function$
declare
  v_key text:=current_setting('norva.test_phase4_race_pause',true);
  v_mode text:=current_setting('norva.test_phase4_race_mode',true);
  v_transition_id text:=current_setting(
    'norva.test_phase4_fixture_transition_id',true);
  v_user_id text:=current_setting('norva.test_phase4_fixture_user_id',true);
  v_new jsonb:=to_jsonb(new);
begin
  if v_key~'^[0-9]{1,18}$' and (
    (v_mode in ('promotion_cancel_promotion','promotion_delete_promotion')
      and tg_table_name='cloud_source_transitions'
      and v_new->>'id'=v_transition_id and v_new->>'state'='completed')
    or (v_mode='promotion_cancel_cancel'
      and tg_table_name='cloud_source_transitions'
      and v_new->>'id'=v_transition_id and v_new->>'state'='cancelled')
    or (v_mode='rollback_delete_rollback'
      and tg_table_name='cloud_source_transitions'
      and v_new->>'reversal_of_transition_id'=v_transition_id
      and v_new->>'state'='committing')
    or (v_mode in ('promotion_delete_deletion','rollback_delete_deletion')
      and tg_table_name='cloud_provider_account_delete_preparations'
      and tg_op='INSERT' and v_new->>'user_id'=v_user_id)
  ) then
    perform pg_catalog.pg_advisory_xact_lock(v_key::bigint);
  end if;
  return new;
end $function$;

create trigger norva_test_phase4_race_transition_pause
before update of state on public.cloud_source_transitions
for each row execute function public.norva_test_phase4_race_pause();
create trigger norva_test_phase4_race_delete_pause
before insert on public.cloud_provider_account_delete_preparations
for each row execute function public.norva_test_phase4_race_pause();

create function public.norva_test_phase4_race_action(p_action text)
returns jsonb language plpgsql set search_path='' as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_active public.cloud_source_lifecycle%rowtype;
  v_head public.cloud_source_catalog_heads%rowtype;
  v_result jsonb;
  v_visible_source_id uuid;
  v_detail text;
  v_message text;
  v_mode text:=current_setting('norva.test_phase4_race_mode');
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  select transition.* into strict v_transition
  from public.cloud_source_transitions transition
  where transition.id=current_setting(
    'norva.test_phase4_fixture_transition_id')::uuid;
  begin
    if p_action='promote' then
      select head.* into strict v_head
      from public.cloud_source_catalog_heads head
      where head.source_id=v_transition.candidate_source_id
        and head.user_id=v_transition.user_id;
      v_result:=public.norva_promote_source_replacement_v3(
        v_transition.id,v_transition.user_id,
        'phase4-race-promote-'||v_mode,
        v_transition.expected_source_revision,
        coalesce(v_transition.promotion_expected_transition_revision,
          v_transition.revision),
        case when v_transition.state='completed'
          then v_head.head_revision-1 else v_head.head_revision end
      );
    elsif p_action='cancel' then
      v_result:=public.norva_cancel_source_replacement(
        v_transition.id,v_transition.user_id,'phase4-race-worker',
        v_transition.revision,'phase4-race-cancel-'||v_mode,repeat('c',64));
    elsif p_action='rollback' then
      select lifecycle.* into strict v_active
      from public.cloud_source_lifecycle lifecycle
      where lifecycle.source_id=v_transition.candidate_source_id
        and lifecycle.user_id=v_transition.user_id;
      v_result:=public.norva_rollback_source_replacement(
        v_transition.id,v_transition.user_id,'phase4-race-worker',
        'phase4-race-rollback-'||v_mode,repeat('d',64),
        v_transition.revision,v_active.config_revision);
    elsif p_action='delete' then
      v_result:=public.norva_begin_provider_account_deletion_prepare(
        v_transition.user_id);
      select lifecycle.source_id into v_visible_source_id
      from public.cloud_source_lifecycle lifecycle
      where lifecycle.user_id=v_transition.user_id
        and lifecycle.lifecycle_state='active'
        and lifecycle.catalog_visibility='visible';
      v_result:=v_result||jsonb_build_object(
        'observedVisibleSourceId',v_visible_source_id);
    else
      raise exception 'unsupported phase4 race action: %',p_action
        using errcode='22023';
    end if;
    return jsonb_build_object('sqlstate','00000','result',v_result);
  exception when others then
    get stacked diagnostics v_detail=pg_exception_detail,
      v_message=message_text;
    return jsonb_build_object('sqlstate',sqlstate,
      'message',coalesce(v_message,''),'detail',coalesce(v_detail,''));
  end;
end $function$;

revoke all on function public.norva_test_phase4_race_pause(),
  public.norva_test_phase4_race_action(text)
from public,anon,authenticated,service_role;
commit;

select set_config('norva.test_phase4_requested_mode',:'race_mode',false);
select set_config('norva.test_phase4_fixture_transition_id',
  :'fixture_transition_id',false);

do $race$
declare
  v_mode text:=current_setting('norva.test_phase4_requested_mode');
  v_transition_id uuid:=current_setting(
    'norva.test_phase4_fixture_transition_id')::uuid;
  v_transition public.cloud_source_transitions%rowtype;
  v_first_action text;
  v_second_action text;
  v_first text;
  v_second text;
  v_first_pid integer;
  v_second_pid integer;
  v_first_result jsonb;
  v_second_result jsonb;
  v_pause_key bigint:=42840201;
  v_waited integer:=0;
  v_visible_count bigint;
  v_visible_source_id uuid;
  v_reversals bigint;
  v_delete_preparations bigint;
  v_expected_state text;
  v_expected_visible uuid;
  v_expected_second_sqlstate text;
  v_expected_reversals bigint:=0;
  v_connection text;
begin
  if v_mode not in (
    'promotion_cancel_promotion','promotion_cancel_cancel',
    'promotion_delete_promotion','promotion_delete_deletion',
    'rollback_delete_rollback','rollback_delete_deletion'
  ) then
    raise exception 'unsupported race_mode: %',v_mode using errcode='22023';
  end if;
  select transition.* into strict v_transition
  from public.cloud_source_transitions transition
  where transition.id=v_transition_id;
  if v_transition.state<>'ready_to_switch' then
    raise exception 'fixture is not READY_TO_SWITCH: %',v_transition.state;
  end if;

  -- Rollback/deletion races start from the same durably promoted B-visible
  -- state. Prepare it in an autonomous backend so no account lock leaks into
  -- either competitor transaction.
  if v_mode like 'rollback_delete_%' then
    perform public.dblink_connect('phase4_race_prepare',format(
      'host=127.0.0.1 port=%s dbname=%s user=%s connect_timeout=2',
      current_setting('port'),current_database(),current_user));
    perform public.dblink_exec('phase4_race_prepare',format(
      'set "request.jwt.claim.role"=''service_role''; '
      ||'set norva.test_phase4_race_mode=%L; '
      ||'set norva.test_phase4_fixture_transition_id=%L',
      v_mode,v_transition_id::text));
    select payload into strict v_first_result
    from public.dblink('phase4_race_prepare',
      'select public.norva_test_phase4_race_action(''promote'')')
      as response(payload jsonb);
    perform public.dblink_disconnect('phase4_race_prepare');
    if v_first_result->>'sqlstate'<>'00000' then
      raise exception 'rollback race promotion setup failed: %',v_first_result;
    end if;
    select transition.* into strict v_transition
    from public.cloud_source_transitions transition
    where transition.id=v_transition_id;
  end if;

  v_first_action:=case
    when v_mode in ('promotion_cancel_promotion','promotion_delete_promotion')
      then 'promote'
    when v_mode='promotion_cancel_cancel' then 'cancel'
    when v_mode='rollback_delete_rollback' then 'rollback'
    else 'delete' end;
  v_second_action:=case
    when v_mode='promotion_cancel_promotion' then 'cancel'
    when v_mode='promotion_cancel_cancel' then 'promote'
    when v_mode='promotion_delete_promotion' then 'delete'
    when v_mode='promotion_delete_deletion' then 'promote'
    when v_mode='rollback_delete_rollback' then 'delete'
    else 'rollback' end;
  v_first:='phase4_race_first';
  v_second:='phase4_race_second';

  perform public.dblink_connect(v_first,format(
    'host=127.0.0.1 port=%s dbname=%s user=%s connect_timeout=2 options=''-c statement_timeout=15000''',
    current_setting('port'),current_database(),current_user));
  perform public.dblink_connect(v_second,format(
    'host=127.0.0.1 port=%s dbname=%s user=%s connect_timeout=2 options=''-c statement_timeout=15000''',
    current_setting('port'),current_database(),current_user));
  select pid into strict v_first_pid
  from public.dblink(v_first,'select pg_backend_pid()') as t(pid integer);
  select pid into strict v_second_pid
  from public.dblink(v_second,'select pg_backend_pid()') as t(pid integer);
  perform public.dblink_exec(v_first,'begin');
  perform public.dblink_exec(v_second,'begin');
  perform public.dblink_exec(v_first,format(
    'set local "request.jwt.claim.role"=''service_role''; '
    ||'set local norva.test_phase4_race_mode=%L; '
    ||'set local norva.test_phase4_fixture_transition_id=%L; '
    ||'set local norva.test_phase4_fixture_user_id=%L; '
    ||'set local norva.test_phase4_race_pause=%L',
    v_mode,v_transition_id::text,v_transition.user_id::text,v_pause_key::text));
  perform public.dblink_exec(v_second,format(
    'set local "request.jwt.claim.role"=''service_role''; '
    ||'set local norva.test_phase4_race_mode=%L; '
    ||'set local norva.test_phase4_fixture_transition_id=%L; '
    ||'set local norva.test_phase4_fixture_user_id=%L',
    v_mode,v_transition_id::text,v_transition.user_id::text));

  perform pg_catalog.pg_advisory_lock(v_pause_key);
  perform public.dblink_send_query(v_first,format(
    'select public.norva_test_phase4_race_action(%L)',v_first_action));
  while v_waited<1000 and not exists(
    select 1 from pg_catalog.pg_locks waiting
    where waiting.pid=v_first_pid and waiting.locktype='advisory'
      and not waiting.granted and waiting.classid=0
      and waiting.objid::bigint=v_pause_key
  ) loop
    perform pg_catalog.pg_sleep(0.01); v_waited:=v_waited+1;
  end loop;
  if v_waited>=1000 or public.dblink_is_busy(v_first)<>1 then
    raise exception 'first competitor did not reach the deterministic pause';
  end if;

  perform public.dblink_send_query(v_second,format(
    'select public.norva_test_phase4_race_action(%L)',v_second_action));
  v_waited:=0;
  while v_waited<1000 and not exists(
    select 1 from pg_catalog.pg_locks waiting
    where waiting.pid=v_second_pid and not waiting.granted
      and not (waiting.locktype='advisory' and waiting.classid=0
        and waiting.objid::bigint=v_pause_key)
  ) loop
    perform pg_catalog.pg_sleep(0.01); v_waited:=v_waited+1;
  end loop;
  if v_waited>=1000 or public.dblink_is_busy(v_second)<>1 then
    raise exception 'second competitor did not serialize behind account fence';
  end if;

  perform pg_catalog.pg_advisory_unlock(v_pause_key);
  select payload into strict v_first_result
  from public.dblink_get_result(v_first) as t(payload jsonb);
  perform count(*) from public.dblink_get_result(v_first) as t(payload jsonb);
  perform public.dblink_exec(v_first,'commit');
  select payload into strict v_second_result
  from public.dblink_get_result(v_second) as t(payload jsonb);
  perform count(*) from public.dblink_get_result(v_second) as t(payload jsonb);
  perform public.dblink_exec(v_second,'commit');
  perform public.dblink_disconnect(v_first);
  perform public.dblink_disconnect(v_second);

  select transition.* into strict v_transition
  from public.cloud_source_transitions transition
  where transition.id=v_transition_id;
  select count(*),min(lifecycle.source_id::text)::uuid
    into v_visible_count,v_visible_source_id
  from public.cloud_source_lifecycle lifecycle
  where lifecycle.user_id=v_transition.user_id
    and lifecycle.lifecycle_state='active'
    and lifecycle.catalog_visibility='visible';
  select count(*) into v_reversals
  from public.cloud_source_transitions reversal
  where reversal.reversal_of_transition_id=v_transition.id;
  select count(*) into v_delete_preparations
  from public.cloud_provider_account_delete_preparations preparation
  where preparation.user_id=v_transition.user_id
    and preparation.state='pending';

  v_expected_state:=case
    when v_mode='promotion_cancel_cancel' then 'cancelled'
    when v_mode='promotion_delete_deletion' then 'ready_to_switch'
    else 'completed' end;
  v_expected_visible:=case
    when v_mode in ('promotion_cancel_cancel','promotion_delete_deletion',
      'rollback_delete_rollback') then v_transition.old_source_id
    else v_transition.candidate_source_id end;
  v_expected_second_sqlstate:=case
    when v_mode in ('promotion_delete_promotion','rollback_delete_rollback')
      then '00000' else '40001' end;
  if v_mode='rollback_delete_rollback' then v_expected_reversals:=1; end if;

  if v_first_result->>'sqlstate'<>'00000'
     or v_second_result->>'sqlstate'<>v_expected_second_sqlstate
     or v_transition.state<>v_expected_state
     or v_visible_count<>1 or v_visible_source_id<>v_expected_visible
     or v_reversals<>v_expected_reversals
     or (v_mode in ('promotion_delete_promotion','promotion_delete_deletion',
          'rollback_delete_rollback','rollback_delete_deletion')
        and v_delete_preparations<>1)
     or (v_mode in ('promotion_cancel_promotion','promotion_cancel_cancel')
        and v_delete_preparations<>0) then
    raise exception 'phase4 race invariant failed mode=% first=% second=% state=% visible=% count=% reversals=% deletions=%',
      v_mode,v_first_result,v_second_result,v_transition.state,
      v_visible_source_id,v_visible_count,v_reversals,v_delete_preparations;
  end if;
  if v_expected_second_sqlstate='00000'
     and (v_second_result->'result'->>'observedVisibleSourceId')::uuid
       <>v_expected_visible then
    raise exception 'deletion did not observe committed winner visibility: %',
      v_second_result;
  end if;
  raise notice 'PHASE4_REPLACEMENT_RACE_PASS mode=% first=% second=% state=% visible=% reversals=% deletion_preparations=%',
    v_mode,v_first_result,v_second_result,v_transition.state,
    v_visible_source_id,v_reversals,v_delete_preparations;
exception when others then
  perform pg_catalog.pg_advisory_unlock_all();
  foreach v_connection in array array[
    'phase4_race_prepare','phase4_race_first','phase4_race_second'
  ] loop
    if coalesce(public.dblink_get_connections(),array[]::text[]) @> array[v_connection] then
      begin perform public.dblink_disconnect(v_connection);
      exception when others then null; end;
    end if;
  end loop;
  raise;
end
$race$;

begin;
drop trigger if exists norva_test_phase4_race_transition_pause
  on public.cloud_source_transitions;
drop trigger if exists norva_test_phase4_race_delete_pause
  on public.cloud_provider_account_delete_preparations;
drop function if exists public.norva_test_phase4_race_pause();
drop function if exists public.norva_test_phase4_race_action(text);
commit;
