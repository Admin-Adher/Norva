\set ON_ERROR_STOP on

-- This test consumes the committed IMPORTING fixture produced by
-- provider_credential_transition.sql with
-- -v phase3_prepare_pre_ready_crash_fixture=1.  It terminates real PostgreSQL
-- backends while production RPCs are inside their critical transactions, then
-- resumes exclusively from durable database state.
begin;
set local statement_timeout = '90s';
set local lock_timeout = '2s';

drop trigger if exists norva_test_phase3_transaction_crash_transition_pause
  on public.cloud_source_transitions;
drop trigger if exists norva_test_phase3_transaction_crash_source_pause
  on public.cloud_sources;
drop function if exists public.norva_test_phase3_transaction_crash_pause();
drop function if exists public.norva_test_phase3_crash_build_ready();
drop function if exists public.norva_test_phase3_crash_swap();
drop function if exists public.norva_test_phase3_crash_claim_post();
drop function if exists public.norva_test_phase3_crash_rollback();

create function public.norva_test_phase3_transaction_crash_pause()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_key text := current_setting('norva.test_phase3_crash_pause',true);
  v_phase text := current_setting('norva.test_phase3_crash_phase',true);
  v_old jsonb := case when tg_op='INSERT' then '{}'::jsonb else to_jsonb(old) end;
  v_new jsonb := case when tg_op='DELETE' then '{}'::jsonb else to_jsonb(new) end;
begin
  if v_key ~ '^[0-9]{1,18}$'
     and ((v_phase='ready'
           and tg_table_name='cloud_source_transitions'
           and v_new->>'state'='ready_to_switch')
       or (v_phase in ('swap','rollback')
           and tg_table_name='cloud_sources'
           and v_new->>'config_ciphertext'
                 is distinct from v_old->>'config_ciphertext')) then
    perform pg_catalog.pg_advisory_xact_lock(v_key::bigint);
  end if;
  return new;
end
$function$;

create trigger norva_test_phase3_transaction_crash_transition_pause
before update of state on public.cloud_source_transitions
for each row execute function public.norva_test_phase3_transaction_crash_pause();

create trigger norva_test_phase3_transaction_crash_source_pause
before update of config_ciphertext on public.cloud_sources
for each row execute function public.norva_test_phase3_transaction_crash_pause();

create function public.norva_test_phase3_crash_build_ready()
returns jsonb
language plpgsql
set search_path = ''
as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_claim record;
  v_step jsonb;
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  select transition.* into strict v_transition
  from public.cloud_source_transitions transition
  where transition.idempotency_key='phase3-create-2';

  select claim.* into strict v_claim
  from public.norva_claim_catalog_background_owner_build_jobs(
    'phase3-crash-owner-baseline',10,120
  ) claim
  where claim.job_kind='baseline'
    and claim.user_id=v_transition.user_id;
  for v_iteration in 1..6 loop
    v_step:=public.norva_run_catalog_background_owner_build_job_slice(
      v_claim.job_id,'phase3-crash-owner-baseline',v_claim.lease_sequence,
      v_claim.checkpoint_revision,100
    );
    v_claim.checkpoint_revision:=(v_step->>'checkpointRevision')::bigint;
    exit when coalesce((v_step->>'complete')::boolean,false);
  end loop;
  if not coalesce((v_step->>'complete')::boolean,false) then
    raise exception 'crash-matrix owner baseline did not complete';
  end if;

  select claim.* into strict v_claim
  from public.norva_claim_catalog_background_owner_build_jobs(
    'phase3-crash-owner-candidate',10,120
  ) claim
  where claim.job_kind='candidate'
    and claim.transition_id=v_transition.id;
  for v_iteration in 1..6 loop
    v_step:=public.norva_run_catalog_background_owner_build_job_slice(
      v_claim.job_id,'phase3-crash-owner-candidate',v_claim.lease_sequence,
      v_claim.checkpoint_revision,100
    );
    v_claim.checkpoint_revision:=(v_step->>'checkpointRevision')::bigint;
    exit when coalesce((v_step->>'complete')::boolean,false);
  end loop;
  if not coalesce((v_step->>'complete')::boolean,false) then
    raise exception 'crash-matrix owner candidate did not complete';
  end if;
  return public.norva_credential_transition_result(
    v_transition.id,v_transition.user_id
  );
end
$function$;

create function public.norva_test_phase3_crash_swap()
returns jsonb
language plpgsql
set search_path = ''
as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_generation public.cloud_source_catalog_generations%rowtype;
  v_snapshot jsonb;
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  select transition.* into strict v_transition
  from public.cloud_source_transitions transition
  where transition.idempotency_key='phase3-create-2';
  select generation.* into strict v_generation
  from public.cloud_source_catalog_generations generation
  where generation.id=v_transition.candidate_catalog_generation_id;
  v_snapshot:=public.norva_get_catalog_write_snapshot(
    v_transition.old_source_id,v_transition.user_id
  );
  return public.norva_begin_credential_swap(
    v_transition.id,v_transition.user_id,v_generation.id,v_generation.revision,
    v_transition.revision,(v_snapshot->>'configRevision')::bigint,
    (v_snapshot->>'headRevision')::bigint,
    'phase3-transaction-crash-swap',repeat('d',64)
  );
end
$function$;

create function public.norva_test_phase3_crash_claim_post()
returns jsonb
language plpgsql
set search_path = ''
as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_claim record;
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  select transition.* into strict v_transition
  from public.cloud_source_transitions transition
  where transition.idempotency_key='phase3-create-2';
  select claim.* into strict v_claim
  from public.norva_claim_credential_transition_jobs(
    'phase3-transaction-crash-post',10,120,
    'credential-transition-worker-v3-active-catalog-refresh'
  ) claim
  where claim.transition_id=v_transition.id
    and claim.job_kind='post_switch_verify';
  return to_jsonb(v_claim);
end
$function$;

create function public.norva_test_phase3_crash_rollback()
returns jsonb
language plpgsql
set search_path = ''
as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_job public.cloud_source_credential_transition_jobs%rowtype;
  v_lifecycle public.cloud_source_lifecycle%rowtype;
  v_head public.cloud_source_catalog_heads%rowtype;
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  select transition.* into strict v_transition
  from public.cloud_source_transitions transition
  where transition.idempotency_key='phase3-create-2';
  select job.* into strict v_job
  from public.cloud_source_credential_transition_jobs job
  where job.transition_id=v_transition.id
    and job.job_kind='post_switch_verify' and job.state='processing';
  select lifecycle.* into strict v_lifecycle
  from public.cloud_source_lifecycle lifecycle
  where lifecycle.source_id=v_transition.old_source_id
    and lifecycle.user_id=v_transition.user_id;
  select head.* into strict v_head
  from public.cloud_source_catalog_heads head
  where head.source_id=v_transition.old_source_id
    and head.user_id=v_transition.user_id;
  return public.norva_restore_previous_credential_config(
    v_transition.id,v_transition.user_id,v_job.id,v_job.lease_owner,
    v_job.lease_sequence,v_transition.revision,v_lifecycle.config_revision,
    v_head.head_revision,'candidate_catalog_unhealthy'
  );
end
$function$;

revoke all on function public.norva_test_phase3_transaction_crash_pause(),
  public.norva_test_phase3_crash_build_ready(),
  public.norva_test_phase3_crash_swap(),
  public.norva_test_phase3_crash_claim_post(),
  public.norva_test_phase3_crash_rollback()
from public,anon,authenticated,service_role;
commit;

do $matrix$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_candidate public.cloud_source_catalog_generations%rowtype;
  v_previous public.cloud_source_catalog_generations%rowtype;
  v_secret public.cloud_source_transition_secrets%rowtype;
  v_post_job public.cloud_source_credential_transition_jobs%rowtype;
  v_result jsonb;
  v_source_config text;
  v_config_revision bigint;
  v_head_revision bigint;
  v_active_generation uuid;
  v_before_config text;
  v_before_config_revision bigint;
  v_before_head_revision bigint;
  v_before_active_generation uuid;
  v_pid integer;
  v_waited integer;
  v_key bigint;
  v_terminated boolean;
  v_connection text;
  v_n_plus_1_stale boolean:=false;
begin
  select transition.* into strict v_transition
  from public.cloud_source_transitions transition
  where transition.idempotency_key='phase3-create-2';
  if v_transition.state<>'importing' then
    raise exception 'crash fixture is not IMPORTING: %',v_transition.state;
  end if;

  -- Crash 1: terminate the owner worker inside the READY_TO_SWITCH update.
  v_connection:='phase3_crash_ready'; v_key:=32810101;
  perform dblink_connect(v_connection,format(
    'host=127.0.0.1 port=%s dbname=%s user=%s connect_timeout=2 options=''-c statement_timeout=30000''',
    current_setting('port'),current_database(),current_user));
  select pid into strict v_pid
  from dblink(v_connection,'select pg_backend_pid()') as t(pid integer);
  perform dblink_exec(v_connection,'begin');
  perform dblink_exec(v_connection,format(
    'set local "request.jwt.claim.role"=''service_role''; set local norva.test_phase3_crash_phase=''ready''; set local norva.test_phase3_crash_pause=%L',v_key::text));
  perform pg_catalog.pg_advisory_lock(v_key);
  perform dblink_send_query(
    v_connection,'select public.norva_test_phase3_crash_build_ready()'
  );
  v_waited:=0;
  while v_waited<3000 and not exists (
    select 1 from pg_catalog.pg_stat_activity activity
    where activity.pid=v_pid and activity.wait_event_type='Lock'
  ) loop
    perform pg_catalog.pg_stat_clear_snapshot();
    perform pg_catalog.pg_sleep(0.01); v_waited:=v_waited+1;
  end loop;
  if v_waited>=3000 then
    raise exception 'READY worker did not reach crash boundary';
  end if;
  select pg_catalog.pg_terminate_backend(v_pid) into v_terminated;
  perform pg_catalog.pg_advisory_unlock(v_key);
  if not v_terminated then raise exception 'READY worker was not terminated'; end if;
  for v_waited in 1..300 loop
    exit when not exists(select 1 from pg_catalog.pg_stat_activity where pid=v_pid);
    perform pg_catalog.pg_sleep(0.01);
  end loop;
  begin perform dblink_disconnect(v_connection); exception when others then null; end;
  select transition.* into strict v_transition
  from public.cloud_source_transitions transition
  where transition.idempotency_key='phase3-create-2';
  if v_transition.state<>'importing' or v_transition.readiness_check_id is not null then
    raise exception 'READY crash leaked partial state: state=% owner=%',
      v_transition.state,v_transition.readiness_check_id;
  end if;
  raise notice 'PHASE3_CRASH_BOUNDARY_PASS boundary=ready_before_commit state=% owner_snapshot=%',
    v_transition.state,v_transition.readiness_check_id;

  perform dblink_connect(v_connection,format(
    'host=127.0.0.1 port=%s dbname=%s user=%s connect_timeout=2',
    current_setting('port'),current_database(),current_user));
  perform dblink_exec(v_connection,'begin');
  select payload into strict v_result
  from dblink(v_connection,'select public.norva_test_phase3_crash_build_ready()')
    as t(payload jsonb);
  perform dblink_exec(v_connection,'commit');
  perform dblink_disconnect(v_connection);
  select transition.* into strict v_transition
  from public.cloud_source_transitions transition
  where transition.idempotency_key='phase3-create-2';
  if v_transition.state<>'ready_to_switch'
     or v_transition.readiness_check_id is null then
    raise exception 'READY restart did not converge: %',v_result;
  end if;
  raise notice 'PHASE3_CRASH_BOUNDARY_PASS boundary=ready_after_restart state=% owner_snapshot=%',
    v_transition.state,v_transition.readiness_check_id;

  select source.config_ciphertext,lifecycle.config_revision,
         head.head_revision,head.active_generation_id
    into strict v_before_config,v_before_config_revision,
      v_before_head_revision,v_before_active_generation
  from public.cloud_sources source
  join public.cloud_source_lifecycle lifecycle
    on lifecycle.source_id=source.id and lifecycle.user_id=source.user_id
  join public.cloud_source_catalog_heads head
    on head.source_id=source.id and head.user_id=source.user_id
  where source.id=v_transition.old_source_id
    and source.user_id=v_transition.user_id;

  -- Crash 2: terminate swap before COMMIT.  Generation bump, head flip,
  -- continuation scheduling and action ledger must all roll back together.
  v_connection:='phase3_crash_swap'; v_key:=32810102;
  perform dblink_connect(v_connection,format(
    'host=127.0.0.1 port=%s dbname=%s user=%s connect_timeout=2 options=''-c statement_timeout=30000''',
    current_setting('port'),current_database(),current_user));
  select pid into strict v_pid
  from dblink(v_connection,'select pg_backend_pid()') as t(pid integer);
  perform dblink_exec(v_connection,'begin');
  perform dblink_exec(v_connection,format(
    'set local "request.jwt.claim.role"=''service_role''; set local norva.test_phase3_crash_phase=''swap''; set local norva.test_phase3_crash_pause=%L',v_key::text));
  perform pg_catalog.pg_advisory_lock(v_key);
  perform dblink_send_query(
    v_connection,'select public.norva_test_phase3_crash_swap()'
  );
  v_waited:=0;
  while v_waited<3000 and not exists (
    select 1 from pg_catalog.pg_stat_activity activity
    where activity.pid=v_pid and activity.wait_event_type='Lock'
  ) loop
    perform pg_catalog.pg_stat_clear_snapshot();
    perform pg_catalog.pg_sleep(0.01); v_waited:=v_waited+1;
  end loop;
  if v_waited>=3000 then raise exception 'swap worker did not reach crash boundary'; end if;
  select pg_catalog.pg_terminate_backend(v_pid) into v_terminated;
  perform pg_catalog.pg_advisory_unlock(v_key);
  if not v_terminated then raise exception 'swap worker was not terminated'; end if;
  for v_waited in 1..300 loop
    exit when not exists(select 1 from pg_catalog.pg_stat_activity where pid=v_pid);
    perform pg_catalog.pg_sleep(0.01);
  end loop;
  begin perform dblink_disconnect(v_connection); exception when others then null; end;
  select transition.* into strict v_transition
  from public.cloud_source_transitions transition
  where transition.idempotency_key='phase3-create-2';
  select source.config_ciphertext,lifecycle.config_revision,
         head.head_revision,head.active_generation_id
    into strict v_source_config,v_config_revision,v_head_revision,v_active_generation
  from public.cloud_sources source
  join public.cloud_source_lifecycle lifecycle
    on lifecycle.source_id=source.id and lifecycle.user_id=source.user_id
  join public.cloud_source_catalog_heads head
    on head.source_id=source.id and head.user_id=source.user_id
  where source.id=v_transition.old_source_id
    and source.user_id=v_transition.user_id;
  if v_transition.state<>'ready_to_switch'
     or v_source_config is distinct from v_before_config
     or v_config_revision<>v_before_config_revision
     or v_head_revision<>v_before_head_revision
     or v_active_generation<>v_before_active_generation
     or exists(select 1 from public.cloud_source_credential_transition_actions action
               where action.transition_id=v_transition.id
                 and action.action_kind='begin_swap')
     or exists(select 1 from public.cloud_source_credential_transition_jobs job
               where job.transition_id=v_transition.id
                 and job.job_kind='post_switch_verify') then
    raise exception 'swap crash leaked a partial commit';
  end if;
  raise notice 'PHASE3_CRASH_BOUNDARY_PASS boundary=swap_before_commit state=% config=% head=% active=% jobs=0 actions=0',
    v_transition.state,v_config_revision,v_head_revision,v_active_generation;

  perform dblink_connect(v_connection,format(
    'host=127.0.0.1 port=%s dbname=%s user=%s connect_timeout=2',
    current_setting('port'),current_database(),current_user));
  perform dblink_exec(v_connection,'begin');
  select payload into strict v_result
  from dblink(v_connection,'select public.norva_test_phase3_crash_swap()')
    as t(payload jsonb);
  perform dblink_exec(v_connection,'commit');
  perform dblink_disconnect(v_connection);
  select transition.* into strict v_transition
  from public.cloud_source_transitions transition
  where transition.idempotency_key='phase3-create-2';
  select source.config_ciphertext,lifecycle.config_revision,
         head.head_revision,head.active_generation_id
    into strict v_source_config,v_config_revision,v_head_revision,v_active_generation
  from public.cloud_sources source
  join public.cloud_source_lifecycle lifecycle
    on lifecycle.source_id=source.id and lifecycle.user_id=source.user_id
  join public.cloud_source_catalog_heads head
    on head.source_id=source.id and head.user_id=source.user_id
  where source.id=v_transition.old_source_id
    and source.user_id=v_transition.user_id;
  if v_transition.state<>'committing'
     or v_config_revision<>v_before_config_revision+1
     or v_head_revision<>v_before_head_revision+1
     or v_source_config is not distinct from v_before_config
     or (select count(*) from public.cloud_source_credential_transition_actions action
         where action.transition_id=v_transition.id
           and action.action_kind='begin_swap')<>1
     or (select count(*) from public.cloud_source_credential_transition_jobs job
         where job.transition_id=v_transition.id
           and job.job_kind='post_switch_verify')<>1 then
    raise exception 'swap restart did not converge atomically: %',v_result;
  end if;
  raise notice 'PHASE3_CRASH_BOUNDARY_PASS boundary=swap_after_restart state=% config=% head=% active=% jobs=1 actions=1',
    v_transition.state,v_config_revision,v_head_revision,v_active_generation;

  perform dblink_connect(v_connection,format(
    'host=127.0.0.1 port=%s dbname=%s user=%s connect_timeout=2',
    current_setting('port'),current_database(),current_user));
  perform dblink_exec(v_connection,'begin');
  select payload into strict v_result
  from dblink(v_connection,'select public.norva_test_phase3_crash_claim_post()')
    as t(payload jsonb);
  perform dblink_exec(v_connection,'commit');
  perform dblink_disconnect(v_connection);
  select job.* into strict v_post_job
  from public.cloud_source_credential_transition_jobs job
  where job.transition_id=v_transition.id
    and job.job_kind='post_switch_verify';
  if v_post_job.state<>'processing'
     or v_post_job.lease_owner<>'phase3-transaction-crash-post' then
    raise exception 'post-swap continuation was not reconstructible: %',v_result;
  end if;

  v_before_config:=v_source_config;
  v_before_config_revision:=v_config_revision;
  v_before_head_revision:=v_head_revision;
  v_before_active_generation:=v_active_generation;

  -- Crash 3: terminate rollback before COMMIT.  Restored credentials, N+2,
  -- head flip, dead N+1 job and rollback scheduling must be all-or-nothing.
  v_connection:='phase3_crash_rollback'; v_key:=32810103;
  perform dblink_connect(v_connection,format(
    'host=127.0.0.1 port=%s dbname=%s user=%s connect_timeout=2 options=''-c statement_timeout=30000''',
    current_setting('port'),current_database(),current_user));
  select pid into strict v_pid
  from dblink(v_connection,'select pg_backend_pid()') as t(pid integer);
  perform dblink_exec(v_connection,'begin');
  perform dblink_exec(v_connection,format(
    'set local "request.jwt.claim.role"=''service_role''; set local norva.test_phase3_crash_phase=''rollback''; set local norva.test_phase3_crash_pause=%L',v_key::text));
  perform pg_catalog.pg_advisory_lock(v_key);
  perform dblink_send_query(
    v_connection,'select public.norva_test_phase3_crash_rollback()'
  );
  v_waited:=0;
  while v_waited<3000 and not exists (
    select 1 from pg_catalog.pg_stat_activity activity
    where activity.pid=v_pid and activity.wait_event_type='Lock'
  ) loop
    perform pg_catalog.pg_stat_clear_snapshot();
    perform pg_catalog.pg_sleep(0.01); v_waited:=v_waited+1;
  end loop;
  if v_waited>=3000 then raise exception 'rollback worker did not reach crash boundary'; end if;
  select pg_catalog.pg_terminate_backend(v_pid) into v_terminated;
  perform pg_catalog.pg_advisory_unlock(v_key);
  if not v_terminated then raise exception 'rollback worker was not terminated'; end if;
  for v_waited in 1..300 loop
    exit when not exists(select 1 from pg_catalog.pg_stat_activity where pid=v_pid);
    perform pg_catalog.pg_sleep(0.01);
  end loop;
  begin perform dblink_disconnect(v_connection); exception when others then null; end;
  select transition.* into strict v_transition
  from public.cloud_source_transitions transition
  where transition.idempotency_key='phase3-create-2';
  select secret.* into strict v_secret
  from public.cloud_source_transition_secrets secret
  where secret.transition_id=v_transition.id;
  select source.config_ciphertext,lifecycle.config_revision,
         head.head_revision,head.active_generation_id
    into strict v_source_config,v_config_revision,v_head_revision,v_active_generation
  from public.cloud_sources source
  join public.cloud_source_lifecycle lifecycle
    on lifecycle.source_id=source.id and lifecycle.user_id=source.user_id
  join public.cloud_source_catalog_heads head
    on head.source_id=source.id and head.user_id=source.user_id
  where source.id=v_transition.old_source_id
    and source.user_id=v_transition.user_id;
  select job.* into strict v_post_job
  from public.cloud_source_credential_transition_jobs job
  where job.transition_id=v_transition.id
    and job.job_kind='post_switch_verify';
  if v_transition.state<>'committing'
     or v_source_config is distinct from v_before_config
     or v_config_revision<>v_before_config_revision
     or v_head_revision<>v_before_head_revision
     or v_active_generation<>v_before_active_generation
     or v_secret.compensation_started_at is not null
     or v_post_job.state<>'processing'
     or exists(select 1 from public.cloud_source_credential_transition_jobs job
               where job.transition_id=v_transition.id
                 and job.job_kind='rollback_refresh') then
    raise exception 'rollback crash leaked a partial commit';
  end if;
  raise notice 'PHASE3_CRASH_BOUNDARY_PASS boundary=rollback_before_commit state=% config=% head=% active=% post_job=% rollback_jobs=0',
    v_transition.state,v_config_revision,v_head_revision,v_active_generation,
    v_post_job.state;

  perform dblink_connect(v_connection,format(
    'host=127.0.0.1 port=%s dbname=%s user=%s connect_timeout=2',
    current_setting('port'),current_database(),current_user));
  perform dblink_exec(v_connection,'begin');
  select payload into strict v_result
  from dblink(v_connection,'select public.norva_test_phase3_crash_rollback()')
    as t(payload jsonb);
  perform dblink_exec(v_connection,'commit');
  perform dblink_disconnect(v_connection);

  select transition.* into strict v_transition
  from public.cloud_source_transitions transition
  where transition.idempotency_key='phase3-create-2';
  select candidate.* into strict v_candidate
  from public.cloud_source_catalog_generations candidate
  where candidate.id=v_transition.candidate_catalog_generation_id;
  select previous.* into strict v_previous
  from public.cloud_source_catalog_generations previous
  where previous.id=v_transition.previous_catalog_generation_id;
  select secret.* into strict v_secret
  from public.cloud_source_transition_secrets secret
  where secret.transition_id=v_transition.id;
  select source.config_ciphertext,lifecycle.config_revision,
         head.head_revision,head.active_generation_id
    into strict v_source_config,v_config_revision,v_head_revision,v_active_generation
  from public.cloud_sources source
  join public.cloud_source_lifecycle lifecycle
    on lifecycle.source_id=source.id and lifecycle.user_id=source.user_id
  join public.cloud_source_catalog_heads head
    on head.source_id=source.id and head.user_id=source.user_id
  where source.id=v_transition.old_source_id
    and source.user_id=v_transition.user_id;
  select job.* into strict v_post_job
  from public.cloud_source_credential_transition_jobs job
  where job.transition_id=v_transition.id
    and job.job_kind='post_switch_verify';
  if v_transition.state<>'committing'
     or v_config_revision<>v_before_config_revision+1
     or v_head_revision<>v_before_head_revision+1
     or v_active_generation<>v_previous.id
     or v_candidate.state<>'retained'
     or v_previous.state<>'active'
     or v_secret.compensation_started_at is null
     or v_secret.previous_config_restored_at is null
     or v_post_job.state<>'dead'
     or (select count(*) from public.cloud_source_credential_transition_jobs job
         where job.transition_id=v_transition.id
           and job.job_kind='rollback_refresh')<>1 then
    raise exception 'rollback restart did not converge atomically: %',v_result;
  end if;

  begin
    update public.cloud_media_items item
    set title=item.title,
        write_head_revision=v_before_head_revision,
        write_config_revision=v_before_config_revision,
        write_source_visibility_epoch=(
          select lifecycle.visibility_epoch
          from public.cloud_source_lifecycle lifecycle
          where lifecycle.source_id=v_transition.old_source_id
        )-1,
        write_user_visibility_epoch=(
          select epoch.visibility_epoch
          from public.cloud_user_catalog_visibility_epochs epoch
          where epoch.user_id=v_transition.user_id
        )-1
    where item.source_id=v_transition.old_source_id
      and item.generation_id=v_candidate.id
      and item.external_id='shared-001';
    raise exception 'N+1 write unexpectedly committed after N+2 rollback';
  exception
    when sqlstate 'PT409' then
      v_n_plus_1_stale:=true;
    when check_violation then
      if sqlerrm='candidate generation cannot carry an active write proof' then
        v_n_plus_1_stale:=true;
      else
        raise;
      end if;
  end;
  if not v_n_plus_1_stale then
    raise exception 'N+1 stale-writer rejection was not observed';
  end if;
  raise notice 'PHASE3_CRASH_BOUNDARY_PASS boundary=rollback_after_restart state=% config=% head=% active=% post_job=% rollback_jobs=1 n_plus_1_stale=%',
    v_transition.state,v_config_revision,v_head_revision,v_active_generation,
    v_post_job.state,v_n_plus_1_stale;
  raise notice 'PHASE3_TRANSACTION_CRASH_MATRIX_PASS boundaries=6 final_generation=% final_head_revision=%',
    v_config_revision,v_head_revision;
exception when others then
  perform pg_catalog.pg_advisory_unlock_all();
  foreach v_connection in array array[
    'phase3_crash_ready','phase3_crash_swap','phase3_crash_rollback'
  ] loop
    if dblink_get_connections() @> array[v_connection] then
      begin perform dblink_disconnect(v_connection);
      exception when others then null;
      end;
    end if;
  end loop;
  raise;
end
$matrix$;

begin;
drop trigger if exists norva_test_phase3_transaction_crash_transition_pause
  on public.cloud_source_transitions;
drop trigger if exists norva_test_phase3_transaction_crash_source_pause
  on public.cloud_sources;
drop function if exists public.norva_test_phase3_transaction_crash_pause();
drop function if exists public.norva_test_phase3_crash_build_ready();
drop function if exists public.norva_test_phase3_crash_swap();
drop function if exists public.norva_test_phase3_crash_claim_post();
drop function if exists public.norva_test_phase3_crash_rollback();
commit;
