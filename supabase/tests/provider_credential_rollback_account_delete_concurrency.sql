\set ON_ERROR_STOP on
\if :{?race_mode}
\else
  \echo 'race_mode is required: rollback_wins or deletion_wins'
  \quit
\endif

-- This test consumes the committed post-swap fixture produced by
-- provider_credential_transition.sql with
-- -v phase3_prepare_rollback_concurrency_fixture=1.  The post-switch job is
-- genuinely leased and B is active at generation N+1; no modern row is seeded
-- directly by this harness.
begin;
set local statement_timeout = '60s';
set local lock_timeout = '2s';

drop trigger if exists norva_test_phase3_rollback_delete_source_pause
  on public.cloud_sources;
drop trigger if exists norva_test_phase3_rollback_delete_prepare_pause
  on public.cloud_provider_account_delete_preparations;
drop function if exists public.norva_test_phase3_rollback_delete_pause();
drop function if exists public.norva_test_phase3_rollback_delete_restore();
drop function if exists public.norva_test_phase3_rollback_delete_begin();

create function public.norva_test_phase3_rollback_delete_pause()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_key text := current_setting('norva.test_phase3_race_pause',true);
  v_mode text := current_setting('norva.test_phase3_race_mode',true);
  v_old jsonb := case when tg_op='INSERT' then '{}'::jsonb else to_jsonb(old) end;
  v_new jsonb := case when tg_op='DELETE' then '{}'::jsonb else to_jsonb(new) end;
begin
  if v_key ~ '^[0-9]{1,18}$'
     and ((v_mode = 'rollback_wins'
           and tg_table_name = 'cloud_sources'
           and tg_op = 'UPDATE'
           and v_new->>'config_ciphertext'
                 is distinct from v_old->>'config_ciphertext')
       or (v_mode = 'deletion_wins'
           and tg_table_name = 'cloud_provider_account_delete_preparations'
           and tg_op = 'INSERT')) then
    perform pg_catalog.pg_advisory_xact_lock(v_key::bigint);
  end if;
  return new;
end
$function$;

create trigger norva_test_phase3_rollback_delete_source_pause
before update of config_ciphertext on public.cloud_sources
for each row execute function public.norva_test_phase3_rollback_delete_pause();

create trigger norva_test_phase3_rollback_delete_prepare_pause
before insert on public.cloud_provider_account_delete_preparations
for each row execute function public.norva_test_phase3_rollback_delete_pause();

create function public.norva_test_phase3_rollback_delete_restore()
returns jsonb
language plpgsql
set search_path = ''
as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_job public.cloud_source_credential_transition_jobs%rowtype;
  v_lifecycle public.cloud_source_lifecycle%rowtype;
  v_head public.cloud_source_catalog_heads%rowtype;
  v_result jsonb;
  v_detail text;
  v_message text;
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  select transition.* into strict v_transition
  from public.cloud_source_transitions transition
  where transition.idempotency_key='phase3-create-2';
  select job.* into strict v_job
  from public.cloud_source_credential_transition_jobs job
  where job.transition_id=v_transition.id
    and job.job_kind='post_switch_verify'
    and job.state='processing';
  select lifecycle.* into strict v_lifecycle
  from public.cloud_source_lifecycle lifecycle
  where lifecycle.source_id=v_transition.old_source_id
    and lifecycle.user_id=v_transition.user_id;
  select head.* into strict v_head
  from public.cloud_source_catalog_heads head
  where head.source_id=v_transition.old_source_id
    and head.user_id=v_transition.user_id;
  begin
    v_result := public.norva_restore_previous_credential_config(
      v_transition.id,v_transition.user_id,v_job.id,v_job.lease_owner,
      v_job.lease_sequence,v_transition.revision,v_lifecycle.config_revision,
      v_head.head_revision,'candidate_catalog_unhealthy'
    );
    return jsonb_build_object('sqlstate','00000','result',v_result);
  exception when others then
    get stacked diagnostics v_detail=pg_exception_detail,
      v_message=message_text;
    return jsonb_build_object(
      'sqlstate',sqlstate,'message',coalesce(v_message,''),
      'detail',coalesce(v_detail,'')
    );
  end;
end
$function$;

create function public.norva_test_phase3_rollback_delete_begin()
returns jsonb
language plpgsql
set search_path = ''
as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_result jsonb;
  v_config_revision bigint;
  v_active_generation_id uuid;
  v_detail text;
  v_message text;
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  select transition.* into strict v_transition
  from public.cloud_source_transitions transition
  where transition.idempotency_key='phase3-create-2';
  begin
    v_result := public.norva_begin_provider_account_deletion_prepare(
      v_transition.user_id
    );
    select lifecycle.config_revision,head.active_generation_id
      into strict v_config_revision,v_active_generation_id
    from public.cloud_source_lifecycle lifecycle
    join public.cloud_source_catalog_heads head
      on head.source_id=lifecycle.source_id and head.user_id=lifecycle.user_id
    where lifecycle.source_id=v_transition.old_source_id
      and lifecycle.user_id=v_transition.user_id;
    return jsonb_build_object(
      'sqlstate','00000','result',v_result,
      'observedConfigRevision',v_config_revision,
      'observedActiveGenerationId',v_active_generation_id
    );
  exception when others then
    get stacked diagnostics v_detail=pg_exception_detail,
      v_message=message_text;
    return jsonb_build_object(
      'sqlstate',sqlstate,'message',coalesce(v_message,''),
      'detail',coalesce(v_detail,'')
    );
  end;
end
$function$;

revoke all on function public.norva_test_phase3_rollback_delete_pause(),
  public.norva_test_phase3_rollback_delete_restore(),
  public.norva_test_phase3_rollback_delete_begin()
from public,anon,authenticated,service_role;
commit;

select set_config('norva.test_phase3_requested_mode', :'race_mode', false);
do $race$
declare
  v_mode text := current_setting('norva.test_phase3_requested_mode');
  v_pause_key bigint := 32810003;
  v_first text;
  v_second text;
  v_first_call text;
  v_second_call text;
  v_first_pid integer;
  v_second_pid integer;
  v_first_result jsonb;
  v_second_result jsonb;
  v_transition_before public.cloud_source_transitions%rowtype;
  v_transition_after public.cloud_source_transitions%rowtype;
  v_candidate_before public.cloud_source_catalog_generations%rowtype;
  v_candidate_after public.cloud_source_catalog_generations%rowtype;
  v_previous_before public.cloud_source_catalog_generations%rowtype;
  v_previous_after public.cloud_source_catalog_generations%rowtype;
  v_secret_before public.cloud_source_transition_secrets%rowtype;
  v_secret_after public.cloud_source_transition_secrets%rowtype;
  v_post_job_before public.cloud_source_credential_transition_jobs%rowtype;
  v_post_job_after public.cloud_source_credential_transition_jobs%rowtype;
  v_source_config_before text;
  v_source_config_after text;
  v_config_revision_before bigint;
  v_config_revision_after bigint;
  v_head_revision_before bigint;
  v_head_revision_after bigint;
  v_active_generation_before uuid;
  v_active_generation_after uuid;
  v_source_epoch_before bigint;
  v_user_epoch_before bigint;
  v_permits_before bigint;
  v_permits_after bigint;
  v_rollback_jobs bigint;
  v_waited integer := 0;
  v_connection text;
  v_n_plus_1_stale boolean := false;
begin
  if v_mode not in ('rollback_wins','deletion_wins') then
    raise exception 'unsupported race_mode: %',v_mode using errcode='22023';
  end if;
  select transition.* into strict v_transition_before
  from public.cloud_source_transitions transition
  where transition.idempotency_key='phase3-create-2';
  if v_transition_before.state <> 'committing' then
    raise exception 'fixture is not COMMITTING: %',v_transition_before.state;
  end if;
  select generation.* into strict v_candidate_before
  from public.cloud_source_catalog_generations generation
  where generation.id=v_transition_before.candidate_catalog_generation_id;
  select generation.* into strict v_previous_before
  from public.cloud_source_catalog_generations generation
  where generation.id=v_transition_before.previous_catalog_generation_id;
  if v_candidate_before.state <> 'active' or v_previous_before.state <> 'retained' then
    raise exception 'fixture generations are not post-swap: candidate=% previous=%',
      v_candidate_before.state,v_previous_before.state;
  end if;
  select secret.* into strict v_secret_before
  from public.cloud_source_transition_secrets secret
  where secret.transition_id=v_transition_before.id;
  select job.* into strict v_post_job_before
  from public.cloud_source_credential_transition_jobs job
  where job.transition_id=v_transition_before.id
    and job.job_kind='post_switch_verify' and job.state='processing';
  select source.config_ciphertext,lifecycle.config_revision,
         lifecycle.visibility_epoch,epoch.visibility_epoch,
         head.head_revision,head.active_generation_id
    into strict v_source_config_before,v_config_revision_before,
      v_source_epoch_before,v_user_epoch_before,
      v_head_revision_before,v_active_generation_before
  from public.cloud_sources source
  join public.cloud_source_lifecycle lifecycle
    on lifecycle.source_id=source.id and lifecycle.user_id=source.user_id
  join public.cloud_source_catalog_heads head
    on head.source_id=source.id and head.user_id=source.user_id
  join public.cloud_user_catalog_visibility_epochs epoch
    on epoch.user_id=source.user_id
  where source.id=v_transition_before.old_source_id
    and source.user_id=v_transition_before.user_id;
  select count(*) into v_permits_before
  from public.cloud_provider_call_permits permit
  where permit.user_id=v_transition_before.user_id;

  v_first := case when v_mode='rollback_wins'
    then 'phase3_rollback_delete_restore' else 'phase3_rollback_delete_delete' end;
  v_second := case when v_mode='rollback_wins'
    then 'phase3_rollback_delete_delete' else 'phase3_rollback_delete_restore' end;
  v_first_call := case when v_mode='rollback_wins'
    then 'select public.norva_test_phase3_rollback_delete_restore()'
    else 'select public.norva_test_phase3_rollback_delete_begin()' end;
  v_second_call := case when v_mode='rollback_wins'
    then 'select public.norva_test_phase3_rollback_delete_begin()'
    else 'select public.norva_test_phase3_rollback_delete_restore()' end;

  perform dblink_connect(v_first,format(
    'host=127.0.0.1 port=%s dbname=%s user=%s connect_timeout=2 options=''-c statement_timeout=15000''',
    current_setting('port'),current_database(),current_user));
  perform dblink_connect(v_second,format(
    'host=127.0.0.1 port=%s dbname=%s user=%s connect_timeout=2 options=''-c statement_timeout=15000''',
    current_setting('port'),current_database(),current_user));
  select pid into strict v_first_pid
  from dblink(v_first,'select pg_backend_pid()') as t(pid integer);
  select pid into strict v_second_pid
  from dblink(v_second,'select pg_backend_pid()') as t(pid integer);
  perform dblink_exec(v_first,'begin');
  perform dblink_exec(v_first,format(
    'set local "request.jwt.claim.role"=''service_role''; set local norva.test_phase3_race_mode=%L; set local norva.test_phase3_race_pause=%L',
    v_mode,v_pause_key::text));
  perform dblink_exec(v_second,'begin');
  perform dblink_exec(v_second,format(
    'set local "request.jwt.claim.role"=''service_role''; set local norva.test_phase3_race_mode=%L',
    v_mode));

  perform pg_catalog.pg_advisory_lock(v_pause_key);
  perform dblink_send_query(v_first,v_first_call);
  while v_waited < 300 and not exists (
    select 1 from pg_catalog.pg_stat_activity activity
    where activity.pid=v_first_pid and activity.wait_event_type='Lock'
  ) loop
    perform pg_catalog.pg_sleep(0.01); v_waited:=v_waited+1;
  end loop;
  if v_waited >= 300 or dblink_is_busy(v_first) <> 1 then
    raise exception 'first competitor did not reach deterministic advisory pause';
  end if;
  perform dblink_send_query(v_second,v_second_call);
  v_waited:=0;
  while v_waited < 300 and not exists (
    select 1 from pg_catalog.pg_stat_activity activity
    where activity.pid=v_second_pid and activity.wait_event_type='Lock'
  ) loop
    perform pg_catalog.pg_sleep(0.01); v_waited:=v_waited+1;
  end loop;
  if v_waited >= 300 or dblink_is_busy(v_second) <> 1 then
    raise exception 'second competitor did not serialize behind auth.users';
  end if;
  perform pg_catalog.pg_advisory_unlock(v_pause_key);
  select payload into strict v_first_result
  from dblink_get_result(v_first) as t(payload jsonb);
  perform count(*) from dblink_get_result(v_first) as t(payload jsonb);
  perform dblink_exec(v_first,'commit');
  select payload into strict v_second_result
  from dblink_get_result(v_second) as t(payload jsonb);
  perform count(*) from dblink_get_result(v_second) as t(payload jsonb);
  perform dblink_exec(v_second,'commit');

  select transition.* into strict v_transition_after
  from public.cloud_source_transitions transition
  where transition.id=v_transition_before.id;
  select generation.* into strict v_candidate_after
  from public.cloud_source_catalog_generations generation
  where generation.id=v_candidate_before.id;
  select generation.* into strict v_previous_after
  from public.cloud_source_catalog_generations generation
  where generation.id=v_previous_before.id;
  select secret.* into strict v_secret_after
  from public.cloud_source_transition_secrets secret
  where secret.transition_id=v_transition_before.id;
  select job.* into strict v_post_job_after
  from public.cloud_source_credential_transition_jobs job
  where job.id=v_post_job_before.id;
  select source.config_ciphertext,lifecycle.config_revision,
         head.head_revision,head.active_generation_id
    into strict v_source_config_after,v_config_revision_after,
      v_head_revision_after,v_active_generation_after
  from public.cloud_sources source
  join public.cloud_source_lifecycle lifecycle
    on lifecycle.source_id=source.id and lifecycle.user_id=source.user_id
  join public.cloud_source_catalog_heads head
    on head.source_id=source.id and head.user_id=source.user_id
  where source.id=v_transition_before.old_source_id
    and source.user_id=v_transition_before.user_id;
  select count(*) into v_permits_after
  from public.cloud_provider_call_permits permit
  where permit.user_id=v_transition_before.user_id;
  select count(*) into v_rollback_jobs
  from public.cloud_source_credential_transition_jobs job
  where job.transition_id=v_transition_before.id
    and job.job_kind='rollback_refresh';

  if not exists (
    select 1 from public.cloud_provider_account_delete_preparations preparation
    where preparation.user_id=v_transition_before.user_id
      and preparation.state='pending' and preparation.phase='drain'
  ) then
    raise exception 'deletion preparation was not durably published';
  end if;
  if v_permits_after <> v_permits_before then
    raise exception 'race unexpectedly changed provider permits: before=% after=%',
      v_permits_before,v_permits_after;
  end if;

  if v_mode='rollback_wins' then
    begin
      perform set_config('request.jwt.claim.role','service_role',true);
      update public.cloud_media_items item
      set title=item.title,
          write_head_revision=v_head_revision_before,
          write_config_revision=v_config_revision_before,
          write_source_visibility_epoch=v_source_epoch_before,
          write_user_visibility_epoch=v_user_epoch_before
      where item.source_id=v_transition_before.old_source_id
        and item.generation_id=v_candidate_before.id
        and item.external_id='shared-001';
      raise exception 'N+1 writer unexpectedly committed after rollback';
    exception when sqlstate '40001' then
      v_n_plus_1_stale:=true;
    end;
    if v_first_result->>'sqlstate' <> '00000'
       or v_second_result->>'sqlstate' <> '00000'
       or v_transition_after.state <> 'committing'
       or v_config_revision_after <> v_config_revision_before+1
       or v_head_revision_after <> v_head_revision_before+1
       or v_active_generation_after <> v_previous_before.id
       or v_candidate_after.state <> 'retained'
       or v_previous_after.state <> 'active'
       or v_source_config_after is not distinct from v_source_config_before
       or v_secret_after.compensation_started_at is null
       or v_secret_after.previous_config_restored_at is null
       or v_post_job_after.state <> 'dead'
       or v_rollback_jobs <> 1
       or (v_second_result->>'observedConfigRevision')::bigint
            <> v_config_revision_after
       or (v_second_result->>'observedActiveGenerationId')::uuid
            <> v_active_generation_after
       or not v_n_plus_1_stale then
      raise exception 'rollback/delete race invariant failed: first=% second=% state=% config=%->% head=%->% active=% candidate=% previous=% post_job=% rollback_jobs=% stale=%',
        v_first_result,v_second_result,v_transition_after.state,
        v_config_revision_before,v_config_revision_after,
        v_head_revision_before,v_head_revision_after,v_active_generation_after,
        v_candidate_after.state,v_previous_after.state,v_post_job_after.state,
        v_rollback_jobs,v_n_plus_1_stale;
    end if;
  else
    if v_first_result->>'sqlstate' <> '00000'
       or v_second_result->>'sqlstate' <> '40001'
       or v_transition_after.state <> v_transition_before.state
       or v_config_revision_after <> v_config_revision_before
       or v_head_revision_after <> v_head_revision_before
       or v_active_generation_after <> v_active_generation_before
       or v_candidate_after.state <> v_candidate_before.state
       or v_previous_after.state <> v_previous_before.state
       or v_source_config_after is distinct from v_source_config_before
       or v_secret_after.compensation_started_at is not null
       or v_secret_after.previous_config_restored_at is not null
       or v_post_job_after.state <> v_post_job_before.state
       or v_rollback_jobs <> 0 then
      raise exception 'delete/rollback race invariant failed: first=% second=% state=% config=%->% head=%->% active=% candidate=% previous=% post_job=% rollback_jobs=%',
        v_first_result,v_second_result,v_transition_after.state,
        v_config_revision_before,v_config_revision_after,
        v_head_revision_before,v_head_revision_after,v_active_generation_after,
        v_candidate_after.state,v_previous_after.state,v_post_job_after.state,
        v_rollback_jobs;
    end if;
  end if;
  raise notice 'PHASE3_ROLLBACK_DELETE_RACE_PASS mode=% first=% second=% state=% config=%->% head=%->% active=% permits=% post_job=% rollback_jobs=% n_plus_1_stale=%',
    v_mode,v_first_result,v_second_result,v_transition_after.state,
    v_config_revision_before,v_config_revision_after,
    v_head_revision_before,v_head_revision_after,v_active_generation_after,
    v_permits_after,v_post_job_after.state,v_rollback_jobs,v_n_plus_1_stale;
exception when others then
  perform pg_catalog.pg_advisory_unlock_all();
  foreach v_connection in array array[
    'phase3_rollback_delete_restore','phase3_rollback_delete_delete'
  ] loop
    if dblink_get_connections() @> array[v_connection] then
      begin perform dblink_disconnect(v_connection);
      exception when others then null;
      end;
    end if;
  end loop;
  raise;
end
$race$;

begin;
drop trigger if exists norva_test_phase3_rollback_delete_source_pause
  on public.cloud_sources;
drop trigger if exists norva_test_phase3_rollback_delete_prepare_pause
  on public.cloud_provider_account_delete_preparations;
drop function if exists public.norva_test_phase3_rollback_delete_pause();
drop function if exists public.norva_test_phase3_rollback_delete_restore();
drop function if exists public.norva_test_phase3_rollback_delete_begin();
commit;
