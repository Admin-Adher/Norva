\set ON_ERROR_STOP on
\timing on
set statement_timeout = '30s';
set lock_timeout = '2s';

-- Test-only, two-session lock-order proof.  The committed aab trigger pauses
-- immediately after the production aaa guard has acquired auth KEY SHARE.
-- No production migration or Edge path depends on these helper objects; they
-- are dropped after the two races and every worker transaction is explicit.

do $prerequisite$
begin
  if to_regprocedure('extensions.dblink_connect(text,text)') is null then
    raise exception 'provider account-delete concurrency smoke requires dblink'
      using errcode = '55000';
  end if;
end
$prerequisite$;

-- Recover fixtures left by an interrupted earlier invocation.  The scope is
-- the exact eight scenario email shapes owned by this file; every account is
-- resumed through the production stop-action and bounded deletion protocol.
do $stale_fixture_cleanup$
declare
  v_user uuid;
  v_begin jsonb;
  v_stop jsonb;
  v_claim jsonb;
  v_run jsonb;
  v_account jsonb;
  v_final_key uuid;
  v_loops integer;
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  for v_user in
    select account.id
    from auth.users account
    where account.email ~
      '^(guard_first|begin_first|permit_first|permit_begin_first|transition_first|reaper_first|reaper_fault|reclaim_dead)-[0-9a-f-]+@invalid[.]test$'
    order by account.id
  loop
    v_begin := public.norva_begin_provider_account_deletion_prepare(v_user);
    if v_begin->>'state' = 'dead' then
      raise exception 'stale provider race preparation is terminal for %',v_user
        using errcode = '55000';
    end if;
    v_stop := public.norva_claim_provider_transport_stop_action(
      v_user,'account-delete-race-preflight',60
    );
    if v_stop->>'state' = 'dead' then
      raise exception 'stale provider race stop action is terminal for %',v_user
        using errcode = '55000';
    end if;
    if v_stop->>'state' <> 'completed' then
      v_stop := public.norva_settle_provider_transport_stop_action(
        v_user,'account-delete-race-preflight',
        (v_stop->>'leaseSequence')::integer,(v_stop->>'revision')::bigint,
        'completed',repeat('c',64),null,0
      );
    end if;
    v_claim := public.norva_claim_provider_account_deletion_prepare(
      v_user,'account-delete-race-preflight',120
    );
    if (v_claim->>'ready')::boolean then
      delete from auth.users where id = v_user;
      continue;
    end if;
    v_loops := 0;
    loop
      v_loops := v_loops + 1;
      if v_loops > 96 then
        raise exception 'stale provider race cleanup did not converge for %',
          v_user;
      end if;
      v_run := public.norva_run_provider_account_deletion_prepare_batch(
        v_user,'account-delete-race-preflight',
        (v_claim->>'leaseSequence')::integer,
        (v_claim->>'revision')::bigint,100
      );
      exit when (v_run->>'ready')::boolean;
      if (v_run->>'waitingForDrain')::boolean then
        raise exception 'stale provider race cleanup remained in drain for %',
          v_user;
      end if;
      v_claim := v_run;
    end loop;
    v_account := public.norva_begin_account_deletion_workflow(v_user);
    v_account := public.norva_advance_account_deletion_workflow(
      v_user,(v_account->>'revision')::bigint,500
    );
    loop
      v_account := public.norva_purge_account_deletion_paywall_batch(
        v_user,(v_account->>'revision')::bigint,500
      );
      exit when (v_account->>'complete')::boolean;
    end loop;
    v_account := public.norva_advance_account_deletion_workflow(
      v_user,(v_account->>'revision')::bigint,500
    );
    v_account := public.norva_advance_account_deletion_workflow(
      v_user,(v_account->>'revision')::bigint,500
    );
    loop
      v_account := public.norva_purge_account_deletion_product_batch(
        v_user,(v_account->>'revision')::bigint,500
      );
      exit when (v_account->>'readyToFinalize')::boolean;
    end loop;
    select claim.finalization_key into strict v_final_key
    from public.norva_claim_account_deletion_finalizations(1,120) claim
    where claim.user_id=v_user;
    delete from auth.users where id = v_user;
    perform public.norva_complete_account_deletion_finalization(v_final_key);
    delete from public.cloud_account_deletion_finalizations where finalization_key=v_final_key;
  end loop;
end
$stale_fixture_cleanup$;

-- Every run owns fresh fixture identifiers.  An interrupted psql process can
-- therefore leave no identifier collision for the next run; its dblink
-- backends are terminated by libpq and roll back any open remote transaction.
create temporary table provider_account_delete_race_fixtures(
  scenario text primary key,
  user_id uuid not null unique,
  source_id uuid not null unique,
  title_id uuid not null unique,
  authority_token uuid not null unique,
  affinity_hash text not null unique check (affinity_hash ~ '^[0-9a-f]{64}$'),
  email text not null unique
) on commit preserve rows;
insert into provider_account_delete_race_fixtures(
  scenario,user_id,source_id,title_id,authority_token,affinity_hash,email
)
select fixture.scenario,
       pg_catalog.gen_random_uuid(),
       pg_catalog.gen_random_uuid(),
       pg_catalog.gen_random_uuid(),
       pg_catalog.gen_random_uuid(),
       repeat(replace(pg_catalog.gen_random_uuid()::text,'-',''),2),
       fixture.scenario || '-' || pg_catalog.gen_random_uuid()::text
         || '@invalid.test'
from (values
  ('guard_first'),('begin_first'),
  ('permit_first'),('permit_begin_first'),
  ('transition_first'),('reaper_first'),('reaper_fault'),('reclaim_dead')
) as fixture(scenario);

begin;
set local lock_timeout = '2s';
set local statement_timeout = '60s';
set local "request.jwt.claim.role" = 'service_role';

drop trigger if exists trg_aab_provider_account_delete_test_pause
  on public.cloud_titles;
drop trigger if exists trg_zzz_provider_account_delete_test_permit_pause
  on public.cloud_provider_call_permits;
drop function if exists public.norva_test_account_delete_pause_guard();
drop function if exists public.norva_test_account_delete_permit_pause_guard();
drop function if exists public.norva_test_account_delete_insert_title(uuid,uuid);
drop function if exists public.norva_test_account_delete_acquire_permit(
  uuid,uuid,uuid,text
);
drop function if exists public.norva_test_account_delete_create_transition(
  uuid,uuid,uuid
);
drop function if exists public.norva_test_account_delete_tombstone_reap(uuid);
drop function if exists public.norva_test_account_delete_insert_transition(
  uuid,uuid,uuid
);
drop function if exists public.norva_test_account_delete_run_batch(
  uuid,text,integer,bigint
);
drop function if exists public.norva_test_account_delete_checkpoint(
  uuid,text,integer,bigint
);
drop function if exists public.norva_test_account_delete_settle_failure(
  uuid,text,integer,bigint
);
drop function if exists public.norva_test_account_delete_claim(uuid,text);

create function public.norva_test_account_delete_pause_guard()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_key text := current_setting('norva.test_account_delete_pause',true);
begin
  if v_key is not null and v_key ~ '^[0-9]{1,18}$' then
    perform pg_catalog.pg_advisory_xact_lock(v_key::bigint);
  end if;
  return new;
end
$function$;

create function public.norva_test_account_delete_permit_pause_guard()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_key text := current_setting('norva.test_account_delete_permit_pause',true);
begin
  if v_key is not null and v_key ~ '^[0-9]{1,18}$' then
    perform pg_catalog.pg_advisory_xact_lock(v_key::bigint);
  end if;
  return new;
end
$function$;

create function public.norva_test_account_delete_insert_title(
  p_user_id uuid,
  p_title_id uuid
) returns text
language plpgsql
set search_path = ''
as $function$
declare
  v_detail text;
begin
  begin
    insert into public.cloud_titles(
      id,user_id,item_type,identity_key,identity_source,title
    ) values (
      p_title_id,p_user_id,'movie','delete-race-' || p_title_id::text,
      'normalized','Account delete race'
    );
    return '00000';
  exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    return sqlstate || '|' || coalesce(v_detail,'');
  end;
end
$function$;

create function public.norva_test_account_delete_acquire_permit(
  p_user_id uuid,
  p_source_id uuid,
  p_fallback_token uuid,
  p_owner text
) returns jsonb
language plpgsql
set search_path = ''
as $function$
declare
  v_payload jsonb;
  v_detail text;
begin
  begin
    v_payload := public.norva_acquire_provider_call_permit(
      p_user_id,p_source_id,0,0,p_owner,
      1000,1024,30,'direct_fallback','direct_fallback',
      null,null,null,null,null,p_fallback_token,null
    );
    return jsonb_build_object('sqlstate','00000','payload',v_payload);
  exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    return jsonb_build_object(
      'sqlstate',sqlstate,'detail',coalesce(v_detail,'')
    );
  end;
end
$function$;

create function public.norva_test_account_delete_create_transition(
  p_user_id uuid,
  p_source_id uuid,
  p_idempotency_id uuid
) returns text
language plpgsql
set search_path = ''
as $function$
declare
  v_detail text;
  v_payload jsonb;
  v_revision bigint;
begin
  begin
    select lifecycle.config_revision into strict v_revision
    from public.cloud_source_lifecycle lifecycle
    where lifecycle.user_id = p_user_id and lifecycle.source_id = p_source_id;
    v_payload := public.norva_create_credential_transition(
      p_user_id,p_source_id,
      'delete-reaper-race-' || p_idempotency_id::text,
      repeat('b',64),v_revision,'cipher-delete-reaper-candidate',
      jsonb_build_object(
        'sourceType','xtream','serverHost','candidate.invalid',
        'hasPassword',true
      ),'account-delete-concurrency-smoke'
    );
    return '00000|' || coalesce(v_payload->>'transitionId','');
  exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    return sqlstate || '|' || coalesce(v_detail,'');
  end;
end
$function$;

create function public.norva_test_account_delete_tombstone_reap(
  p_source_id uuid
) returns jsonb
language plpgsql
set search_path = ''
as $function$
declare
  v_pending boolean;
begin
  update public.cloud_sources source
  set deleted_at = '2000-01-01 00:00:00+00'::timestamptz,
      enabled = false
  where source.id = p_source_id;
  call public.reap_deleted_sources();
  select source.provider_deletion_pending into strict v_pending
  from public.cloud_sources source where source.id = p_source_id;
  return jsonb_build_object('sourceDeletionPending',v_pending);
end
$function$;

create function public.norva_test_account_delete_run_batch(
  p_user_id uuid,
  p_worker text,
  p_lease_sequence integer,
  p_revision bigint
) returns jsonb
language plpgsql
set search_path = ''
as $function$
declare
  v_payload jsonb;
  v_detail text;
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  begin
    v_payload := public.norva_run_provider_account_deletion_prepare_batch(
      p_user_id,p_worker,p_lease_sequence,p_revision,1
    );
    return jsonb_build_object('sqlstate','00000','payload',v_payload);
  exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    return jsonb_build_object(
      'sqlstate',sqlstate,'detail',coalesce(v_detail,'')
    );
  end;
end
$function$;

create function public.norva_test_account_delete_checkpoint(
  p_user_id uuid,
  p_worker text,
  p_lease_sequence integer,
  p_revision bigint
) returns jsonb
language plpgsql
set search_path = ''
as $function$
declare
  v_payload jsonb;
  v_detail text;
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  begin
    v_payload := public.norva_checkpoint_provider_account_deletion_prepare(
      p_user_id,p_worker,p_lease_sequence,p_revision,0
    );
    return jsonb_build_object('sqlstate','00000','payload',v_payload);
  exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    return jsonb_build_object(
      'sqlstate',sqlstate,'detail',coalesce(v_detail,'')
    );
  end;
end
$function$;

create function public.norva_test_account_delete_settle_failure(
  p_user_id uuid,
  p_worker text,
  p_lease_sequence integer,
  p_revision bigint
) returns jsonb
language plpgsql
set search_path = ''
as $function$
declare
  v_payload jsonb;
  v_detail text;
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  begin
    v_payload :=
      public.norva_settle_provider_account_deletion_prepare_failure(
        p_user_id,p_worker,p_lease_sequence,p_revision,
        'stale_worker_probe',true,0
      );
    return jsonb_build_object('sqlstate','00000','payload',v_payload);
  exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    return jsonb_build_object(
      'sqlstate',sqlstate,'detail',coalesce(v_detail,'')
    );
  end;
end
$function$;

create function public.norva_test_account_delete_claim(
  p_user_id uuid,
  p_worker text
) returns jsonb
language plpgsql
set search_path = ''
as $function$
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  return public.norva_claim_provider_account_deletion_prepare(
    p_user_id,p_worker,30
  );
end
$function$;

create trigger trg_aab_provider_account_delete_test_pause
before insert on public.cloud_titles
for each row execute function public.norva_test_account_delete_pause_guard();
create trigger trg_zzz_provider_account_delete_test_permit_pause
after insert on public.cloud_provider_call_permits
for each row execute function
  public.norva_test_account_delete_permit_pause_guard();

-- These helpers deliberately exercise service contracts from owner-owned
-- dblink sessions.  Keep them unavailable to application roles if the harness
-- is interrupted after this setup transaction commits.
revoke all on function
  public.norva_test_account_delete_pause_guard(),
  public.norva_test_account_delete_permit_pause_guard(),
  public.norva_test_account_delete_insert_title(uuid,uuid),
  public.norva_test_account_delete_acquire_permit(uuid,uuid,uuid,text),
  public.norva_test_account_delete_create_transition(uuid,uuid,uuid),
  public.norva_test_account_delete_tombstone_reap(uuid),
  public.norva_test_account_delete_run_batch(uuid,text,integer,bigint),
  public.norva_test_account_delete_checkpoint(uuid,text,integer,bigint),
  public.norva_test_account_delete_settle_failure(uuid,text,integer,bigint),
  public.norva_test_account_delete_claim(uuid,text)
from public,anon,authenticated,service_role;

insert into auth.users (
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) select
  fixture.user_id,'00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated',fixture.email,'',now(),
  '{}'::jsonb,'{}'::jsonb,now(),now()
from provider_account_delete_race_fixtures fixture;
insert into public.cloud_sources (
  id,user_id,source_type,display_name,config_ciphertext,config_hint,
  sync_status,catalog_version,enabled,last_synced_at
) select
  fixture.source_id,fixture.user_id,
  'xtream','Delete race ' || fixture.scenario,
  'cipher-delete-race-' || fixture.scenario,'{}'::jsonb,
  'ready',1,true,now()
from provider_account_delete_race_fixtures fixture;
insert into public.cloud_source_direct_fallback_leases(
  affinity_hash,source_id,user_id,lease_token,lease_owner,lease_until
)
select fixture.affinity_hash,fixture.source_id,fixture.user_id,
       fixture.authority_token,'account-delete-race-permit',
       clock_timestamp() + interval '5 minutes'
from provider_account_delete_race_fixtures fixture
where fixture.scenario in ('permit_first','permit_begin_first');
do $reaper_fixture_generations$
declare
  v_fixture record;
  v_generation uuid;
begin
  perform set_config('session_replication_role','replica',true);
  for v_fixture in
    select fixture.user_id,fixture.source_id
    from provider_account_delete_race_fixtures fixture
    where fixture.scenario in ('transition_first','reaper_first','reaper_fault')
  loop
    select head.active_generation_id into v_generation
    from public.cloud_source_catalog_heads head
    where head.user_id = v_fixture.user_id
      and head.source_id = v_fixture.source_id;
    delete from public.cloud_source_catalog_heads head
    where head.user_id = v_fixture.user_id
      and head.source_id = v_fixture.source_id;
    if v_generation is not null then
      delete from public.cloud_source_catalog_generations generation
      where generation.id = v_generation;
    end if;
  end loop;
  perform set_config('session_replication_role','origin',true);
end
$reaper_fixture_generations$;
commit;

create temporary table provider_account_delete_race_results(
  scenario text primary key,
  write_result text,
  begin_result jsonb
) on commit preserve rows;
create temporary table provider_account_delete_race_pids(
  connection_name text primary key,
  backend_pid integer not null
) on commit preserve rows;
create temporary table provider_account_delete_extended_results(
  scenario text primary key,
  result jsonb not null
) on commit preserve rows;

-- All remote work lives in one exception-safe block.  On any failed wait,
-- assertion setup, or remote statement, both sessions are cancelled and
-- disconnected; disconnect rolls back an open remote transaction.
do $races$
declare
  v_guard_user uuid;
  v_guard_title uuid;
  v_begin_user uuid;
  v_begin_title uuid;
  v_writer_pid integer;
  v_begin_pid integer;
  v_waited integer;
  v_write_result text;
  v_begin_result jsonb;
  v_connection text;
begin
  select user_id,title_id into strict v_guard_user,v_guard_title
  from provider_account_delete_race_fixtures where scenario = 'guard_first';
  select user_id,title_id into strict v_begin_user,v_begin_title
  from provider_account_delete_race_fixtures where scenario = 'begin_first';

  perform extensions.dblink_connect(
    'norva_adk_writer',
    pg_catalog.format(
      'host=127.0.0.1 port=%s dbname=%s user=%s connect_timeout=2 options=''-c statement_timeout=15000''',
      current_setting('port'),current_database(),current_user
    )
  );
  perform extensions.dblink_connect(
    'norva_adk_begin',
    pg_catalog.format(
      'host=127.0.0.1 port=%s dbname=%s user=%s connect_timeout=2 options=''-c statement_timeout=15000''',
      current_setting('port'),current_database(),current_user
    )
  );
  select remote.pid into strict v_writer_pid
  from extensions.dblink('norva_adk_writer','select pg_backend_pid()')
    as remote(pid integer);
  select remote.pid into strict v_begin_pid
  from extensions.dblink('norva_adk_begin','select pg_backend_pid()')
    as remote(pid integer);
  insert into provider_account_delete_race_pids values
    ('writer',v_writer_pid),('begin',v_begin_pid);

  -- Race A: the catalog writer passes aaa, owns auth KEY SHARE, then pauses
  -- in aab.  begin_prepare waits account-first.  The writer is rolled back,
  -- so begin wins without a deadlock or an unobserved late catalog row.
  perform pg_catalog.pg_advisory_lock(82783001::bigint);
  perform extensions.dblink_exec('norva_adk_writer','begin');
  perform extensions.dblink_exec(
    'norva_adk_writer','set local statement_timeout = ''15s'''
  );
  perform extensions.dblink_exec(
    'norva_adk_writer',
    'set local "request.jwt.claim.role" = ''service_role'''
  );
  perform extensions.dblink_exec(
    'norva_adk_writer',
    'set local "norva.test_account_delete_pause" = ''82783001'''
  );
  perform extensions.dblink_send_query(
    'norva_adk_writer',
    pg_catalog.format(
      'select public.norva_test_account_delete_insert_title(%L::uuid,%L::uuid)',
      v_guard_user,v_guard_title
    )
  );
  v_waited := 0;
  while v_waited < 200 and not exists (
    select 1 from pg_catalog.pg_stat_activity activity
    where activity.pid = v_writer_pid and activity.wait_event_type = 'Lock'
  ) loop
    perform pg_catalog.pg_sleep(0.01); v_waited := v_waited + 1;
  end loop;
  if v_waited >= 200 then
    raise exception 'writer did not reach the post-guard advisory pause';
  end if;

  perform extensions.dblink_exec('norva_adk_begin','begin');
  perform extensions.dblink_exec(
    'norva_adk_begin','set local statement_timeout = ''15s'''
  );
  perform extensions.dblink_exec(
    'norva_adk_begin',
    'set local "request.jwt.claim.role" = ''service_role'''
  );
  perform extensions.dblink_send_query(
    'norva_adk_begin',
    pg_catalog.format(
      'select public.norva_begin_provider_account_deletion_prepare(%L::uuid)',
      v_guard_user
    )
  );
  v_waited := 0;
  while v_waited < 200 and not exists (
    select 1 from pg_catalog.pg_stat_activity activity
    where activity.pid = v_begin_pid and activity.wait_event_type = 'Lock'
  ) loop
    perform pg_catalog.pg_sleep(0.01); v_waited := v_waited + 1;
  end loop;
  if v_waited >= 200
     or extensions.dblink_is_busy('norva_adk_writer') <> 1
     or extensions.dblink_is_busy('norva_adk_begin') <> 1 then
    raise exception 'begin_prepare did not serialize behind the guarded writer';
  end if;
  perform pg_catalog.pg_advisory_unlock(82783001::bigint);

  select remote.result into strict v_write_result
  from extensions.dblink_get_result('norva_adk_writer')
    as remote(result text);
  -- libpq async mode has a terminal empty result that must be consumed.
  perform count(*) from extensions.dblink_get_result('norva_adk_writer')
    as remote(result text);
  perform extensions.dblink_exec('norva_adk_writer','rollback');
  select remote.payload into strict v_begin_result
  from extensions.dblink_get_result('norva_adk_begin')
    as remote(payload jsonb);
  perform count(*) from extensions.dblink_get_result('norva_adk_begin')
    as remote(payload jsonb);
  perform extensions.dblink_exec('norva_adk_begin','commit');
  insert into provider_account_delete_race_results
    (scenario,write_result,begin_result)
  values ('guard_first',v_write_result,v_begin_result);

  -- Race B: begin_prepare owns auth UPDATE first.  The direct-DML guard uses
  -- NOWAIT and maps 55P03 to the retryable contract SQLSTATE 40001.
  perform extensions.dblink_exec('norva_adk_begin','begin');
  perform extensions.dblink_exec(
    'norva_adk_begin','set local statement_timeout = ''15s'''
  );
  perform extensions.dblink_exec(
    'norva_adk_begin',
    'set local "request.jwt.claim.role" = ''service_role'''
  );
  select remote.payload into strict v_begin_result
  from extensions.dblink(
    'norva_adk_begin',
    pg_catalog.format(
      'select public.norva_begin_provider_account_deletion_prepare(%L::uuid)',
      v_begin_user
    )
  ) as remote(payload jsonb);

  perform extensions.dblink_exec('norva_adk_writer','begin');
  perform extensions.dblink_exec(
    'norva_adk_writer','set local statement_timeout = ''15s'''
  );
  perform extensions.dblink_exec(
    'norva_adk_writer',
    'set local "request.jwt.claim.role" = ''service_role'''
  );
  select remote.result into strict v_write_result
  from extensions.dblink(
    'norva_adk_writer',
    pg_catalog.format(
      'select public.norva_test_account_delete_insert_title(%L::uuid,%L::uuid)',
      v_begin_user,v_begin_title
    )
  ) as remote(result text);
  perform extensions.dblink_exec('norva_adk_writer','rollback');
  perform extensions.dblink_exec('norva_adk_begin','commit');
  insert into provider_account_delete_race_results
    (scenario,write_result,begin_result)
  values ('begin_first',v_write_result,v_begin_result);

  perform extensions.dblink_disconnect('norva_adk_writer');
  perform extensions.dblink_disconnect('norva_adk_begin');
exception when others then
  -- Session advisory locks survive transaction abort, so release it first.
  perform pg_catalog.pg_advisory_unlock(82783001::bigint);
  foreach v_connection in array coalesce(
    extensions.dblink_get_connections(),array[]::text[]
  ) loop
    if v_connection in ('norva_adk_writer','norva_adk_begin') then
      begin
        if extensions.dblink_is_busy(v_connection) = 1 then
          perform extensions.dblink_cancel_query(v_connection);
        end if;
      exception when others then null;
      end;
      begin
        perform extensions.dblink_disconnect(v_connection);
      exception when others then null;
      end;
    end if;
  end loop;
  raise;
end
$races$;

do $race_assertions$
declare
  v_guard provider_account_delete_race_results%rowtype;
  v_begin provider_account_delete_race_results%rowtype;
begin
  select * into strict v_guard from provider_account_delete_race_results
  where scenario = 'guard_first';
  select * into strict v_begin from provider_account_delete_race_results
  where scenario = 'begin_first';
  if v_guard.write_result <> '00000'
     or v_guard.begin_result->>'state' <> 'pending'
     or v_guard.begin_result->>'phase' <> 'drain'
     or (v_guard.begin_result->>'revision')::bigint <> 0
     or exists (
       select 1 from public.cloud_titles title_row
       join provider_account_delete_race_fixtures fixture
         on fixture.title_id = title_row.id
       where fixture.scenario = 'guard_first'
     ) then
    raise exception 'guard-first race invariant failed: %',row_to_json(v_guard);
  end if;
  if split_part(v_begin.write_result,'|',1) <> '40001'
     or split_part(v_begin.write_result,'|',2) <>
       'reason=provider_account_fence_busy'
     or v_begin.begin_result->>'state' <> 'pending'
     or v_begin.begin_result->>'phase' <> 'drain'
     or exists (
       select 1 from public.cloud_titles title_row
       join provider_account_delete_race_fixtures fixture
         on fixture.title_id = title_row.id
       where fixture.scenario = 'begin_first'
     ) then
    raise exception 'begin-first race invariant failed: %',row_to_json(v_begin);
  end if;
end
$race_assertions$;

-- Race B1/B2: a provider permit and begin_prepare serialize on auth.users.
-- Permit-first is revalidated and released after deletion becomes durable;
-- begin-first makes the permit wait, then fail with the durable deletion fence.
do $permit_races$
declare
  v_first provider_account_delete_race_fixtures%rowtype;
  v_second provider_account_delete_race_fixtures%rowtype;
  v_permit_pid integer;
  v_begin_pid integer;
  v_waited integer;
  v_permit_result jsonb;
  v_begin_result jsonb;
  v_connection text;
begin
  select * into strict v_first from provider_account_delete_race_fixtures
  where scenario = 'permit_first';
  select * into strict v_second from provider_account_delete_race_fixtures
  where scenario = 'permit_begin_first';
  perform extensions.dblink_connect(
    'norva_adk_permit',pg_catalog.format(
      'host=127.0.0.1 port=%s dbname=%s user=%s connect_timeout=2 options=''-c statement_timeout=15000''',
      current_setting('port'),current_database(),current_user
    )
  );
  perform extensions.dblink_connect(
    'norva_adk_permit_begin',pg_catalog.format(
      'host=127.0.0.1 port=%s dbname=%s user=%s connect_timeout=2 options=''-c statement_timeout=15000''',
      current_setting('port'),current_database(),current_user
    )
  );
  select remote.pid into strict v_permit_pid
  from extensions.dblink('norva_adk_permit','select pg_backend_pid()')
    as remote(pid integer);
  select remote.pid into strict v_begin_pid
  from extensions.dblink('norva_adk_permit_begin','select pg_backend_pid()')
    as remote(pid integer);

  perform pg_catalog.pg_advisory_lock(82783002::bigint);
  perform extensions.dblink_exec('norva_adk_permit','begin');
  perform extensions.dblink_exec(
    'norva_adk_permit','set local statement_timeout = ''15s'''
  );
  perform extensions.dblink_exec(
    'norva_adk_permit',
    'set local "request.jwt.claim.role" = ''service_role'''
  );
  perform extensions.dblink_exec(
    'norva_adk_permit',
    'set local "norva.test_account_delete_permit_pause" = ''82783002'''
  );
  perform extensions.dblink_send_query(
    'norva_adk_permit',pg_catalog.format(
      'select public.norva_test_account_delete_acquire_permit(%L::uuid,%L::uuid,%L::uuid,%L)',
      v_first.user_id,v_first.source_id,v_first.authority_token,
      'account-delete-race-permit-first'
    )
  );
  v_waited := 0;
  while v_waited < 200 and not exists (
    select 1 from pg_catalog.pg_stat_activity activity
    where activity.pid = v_permit_pid and activity.wait_event_type = 'Lock'
  ) loop
    perform pg_catalog.pg_sleep(0.01); v_waited := v_waited + 1;
  end loop;
  if v_waited >= 200 then
    raise exception 'permit did not reach its post-insert advisory pause';
  end if;

  perform extensions.dblink_exec('norva_adk_permit_begin','begin');
  perform extensions.dblink_exec(
    'norva_adk_permit_begin','set local statement_timeout = ''15s'''
  );
  perform extensions.dblink_exec(
    'norva_adk_permit_begin',
    'set local "request.jwt.claim.role" = ''service_role'''
  );
  perform extensions.dblink_send_query(
    'norva_adk_permit_begin',pg_catalog.format(
      'select public.norva_begin_provider_account_deletion_prepare(%L::uuid)',
      v_first.user_id
    )
  );
  v_waited := 0;
  while v_waited < 200 and not exists (
    select 1 from pg_catalog.pg_stat_activity activity
    where activity.pid = v_begin_pid and activity.wait_event_type = 'Lock'
  ) loop
    perform pg_catalog.pg_sleep(0.01); v_waited := v_waited + 1;
  end loop;
  if v_waited >= 200
     or extensions.dblink_is_busy('norva_adk_permit') <> 1
     or extensions.dblink_is_busy('norva_adk_permit_begin') <> 1 then
    raise exception 'begin_prepare did not wait behind the active permit';
  end if;
  perform pg_catalog.pg_advisory_unlock(82783002::bigint);
  select remote.payload into strict v_permit_result
  from extensions.dblink_get_result('norva_adk_permit')
    as remote(payload jsonb);
  perform count(*) from extensions.dblink_get_result('norva_adk_permit')
    as remote(payload jsonb);
  perform extensions.dblink_exec('norva_adk_permit','commit');
  select remote.payload into strict v_begin_result
  from extensions.dblink_get_result('norva_adk_permit_begin')
    as remote(payload jsonb);
  perform count(*)
  from extensions.dblink_get_result('norva_adk_permit_begin')
    as remote(payload jsonb);
  perform extensions.dblink_exec('norva_adk_permit_begin','commit');
  insert into provider_account_delete_extended_results values (
    'permit_first',jsonb_build_object(
      'permitEnvelope',v_permit_result,'begin',v_begin_result
    )
  );

  -- Begin owns auth UPDATE.  Permit acquisition blocks (it is not NOWAIT),
  -- then observes the committed preparation and returns the contract 40001.
  perform extensions.dblink_exec('norva_adk_permit_begin','begin');
  perform extensions.dblink_exec(
    'norva_adk_permit_begin','set local statement_timeout = ''15s'''
  );
  perform extensions.dblink_exec(
    'norva_adk_permit_begin',
    'set local "request.jwt.claim.role" = ''service_role'''
  );
  select remote.payload into strict v_begin_result
  from extensions.dblink(
    'norva_adk_permit_begin',pg_catalog.format(
      'select public.norva_begin_provider_account_deletion_prepare(%L::uuid)',
      v_second.user_id
    )
  ) as remote(payload jsonb);
  perform extensions.dblink_exec('norva_adk_permit','begin');
  perform extensions.dblink_exec(
    'norva_adk_permit','set local statement_timeout = ''15s'''
  );
  perform extensions.dblink_exec(
    'norva_adk_permit',
    'set local "request.jwt.claim.role" = ''service_role'''
  );
  perform extensions.dblink_send_query(
    'norva_adk_permit',pg_catalog.format(
      'select public.norva_test_account_delete_acquire_permit(%L::uuid,%L::uuid,%L::uuid,%L)',
      v_second.user_id,v_second.source_id,v_second.authority_token,
      'account-delete-race-begin-first'
    )
  );
  v_waited := 0;
  while v_waited < 200 and not exists (
    select 1 from pg_catalog.pg_stat_activity activity
    where activity.pid = v_permit_pid and activity.wait_event_type = 'Lock'
  ) loop
    perform pg_catalog.pg_sleep(0.01); v_waited := v_waited + 1;
  end loop;
  if v_waited >= 200 or extensions.dblink_is_busy('norva_adk_permit') <> 1 then
    raise exception 'permit did not serialize behind begin_prepare';
  end if;
  perform extensions.dblink_exec('norva_adk_permit_begin','commit');
  select remote.payload into strict v_permit_result
  from extensions.dblink_get_result('norva_adk_permit')
    as remote(payload jsonb);
  perform count(*) from extensions.dblink_get_result('norva_adk_permit')
    as remote(payload jsonb);
  perform extensions.dblink_exec('norva_adk_permit','commit');
  insert into provider_account_delete_extended_results values (
    'permit_begin_first',jsonb_build_object(
      'permitEnvelope',v_permit_result,'begin',v_begin_result
    )
  );
  perform extensions.dblink_disconnect('norva_adk_permit');
  perform extensions.dblink_disconnect('norva_adk_permit_begin');
exception when others then
  perform pg_catalog.pg_advisory_unlock(82783002::bigint);
  foreach v_connection in array coalesce(
    extensions.dblink_get_connections(),array[]::text[]
  ) loop
    if v_connection in ('norva_adk_permit','norva_adk_permit_begin') then
      begin
        if extensions.dblink_is_busy(v_connection) = 1 then
          perform extensions.dblink_cancel_query(v_connection);
        end if;
      exception when others then null;
      end;
      begin perform extensions.dblink_disconnect(v_connection);
      exception when others then null;
      end;
    end if;
  end loop;
  raise;
end
$permit_races$;

do $permit_settle$
declare
  v_first provider_account_delete_race_fixtures%rowtype;
  v_second provider_account_delete_race_fixtures%rowtype;
  v_result jsonb;
  v_revalidate jsonb;
  v_release jsonb;
  v_fallback_released boolean;
  v_deleted integer;
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  select * into strict v_first from provider_account_delete_race_fixtures
  where scenario = 'permit_first';
  select * into strict v_second from provider_account_delete_race_fixtures
  where scenario = 'permit_begin_first';
  select result into strict v_result
  from provider_account_delete_extended_results where scenario = 'permit_first';
  v_revalidate := public.norva_revalidate_provider_call_permit(
    (v_result#>>'{permitEnvelope,payload,permitToken}')::uuid,
    'account-delete-race-permit-first'
  );
  v_release := public.norva_release_provider_call_permit(
    (v_result#>>'{permitEnvelope,payload,permitToken}')::uuid,
    'account-delete-race-permit-first'
  );
  delete from public.cloud_source_direct_fallback_leases lease
  where lease.source_id = v_first.source_id
    and lease.user_id = v_first.user_id
    and lease.lease_token = v_first.authority_token;
  get diagnostics v_deleted = row_count;
  v_fallback_released := v_deleted = 1;
  update provider_account_delete_extended_results
  set result = result || jsonb_build_object(
    'revalidate',v_revalidate,'release',v_release,
    'fallbackReleased',v_fallback_released
  ) where scenario = 'permit_first';
  delete from public.cloud_source_direct_fallback_leases lease
  where lease.source_id = v_second.source_id
    and lease.user_id = v_second.user_id
    and lease.lease_token = v_second.authority_token;
  get diagnostics v_deleted = row_count;
  v_fallback_released := v_deleted = 1;
  update provider_account_delete_extended_results
  set result = result || jsonb_build_object(
    'fallbackReleased',v_fallback_released
  ) where scenario = 'permit_begin_first';
end
$permit_settle$;

do $permit_assertions$
declare
  v_first jsonb;
  v_second jsonb;
begin
  select result into strict v_first
  from provider_account_delete_extended_results where scenario = 'permit_first';
  select result into strict v_second
  from provider_account_delete_extended_results
  where scenario = 'permit_begin_first';
  if v_first#>>'{permitEnvelope,sqlstate}' <> '00000'
     or (v_first#>>'{permitEnvelope,payload,permitted}')::boolean is not true
     or v_first#>>'{begin,state}' <> 'pending'
     or (v_first#>>'{revalidate,permitted}')::boolean is not false
     or v_first#>>'{revalidate,reason}' <> 'account_deletion_pending'
     or (v_first#>>'{release,released}')::boolean is not true
     or (v_first->>'fallbackReleased')::boolean is not true then
    raise exception 'permit-first race invariant failed: %',v_first;
  end if;
  if v_second#>>'{permitEnvelope,sqlstate}' <> '40001'
     or v_second#>>'{permitEnvelope,detail}' <> 'reason=account_deletion_pending'
     or v_second#>>'{begin,state}' <> 'pending'
     or (v_second->>'fallbackReleased')::boolean is not true then
    raise exception 'permit-begin-first race invariant failed: %',v_second;
  end if;
  if exists (
    select 1 from public.cloud_provider_call_permits permit
    join provider_account_delete_race_fixtures fixture
      on fixture.user_id = permit.user_id
    where fixture.scenario in ('permit_first','permit_begin_first')
  ) or exists (
    select 1 from public.cloud_source_direct_fallback_leases lease
    join provider_account_delete_race_fixtures fixture
      on fixture.authority_token = lease.lease_token
    where fixture.scenario in ('permit_first','permit_begin_first')
  ) then
    raise exception 'permit race left a capability behind';
  end if;
end
$permit_assertions$;

-- Race C is a real two-session overlap on the source tuple, not merely two
-- committed orders.  The transition-first transaction keeps its source lock
-- while a tombstone+reaper transaction waits.  In the inverse order the
-- reaper keeps the exact source row locked after setting deletion_pending and
-- the transition must wait, then lose its production CAS after commit.
do $reaper_transition_overlap$
declare
  v_first provider_account_delete_race_fixtures%rowtype;
  v_second provider_account_delete_race_fixtures%rowtype;
  v_fault provider_account_delete_race_fixtures%rowtype;
  v_transition_result text;
  v_reaper_result jsonb;
  v_transition_pid integer;
  v_reaper_pid integer;
  v_waited integer;
  v_fault_observed boolean := false;
  v_connection text;
begin
  select * into strict v_first from provider_account_delete_race_fixtures
  where scenario = 'transition_first';
  select * into strict v_second from provider_account_delete_race_fixtures
  where scenario = 'reaper_first';
  select * into strict v_fault from provider_account_delete_race_fixtures
  where scenario = 'reaper_fault';
  perform extensions.dblink_connect(
    'norva_adk_transition',pg_catalog.format(
      'host=127.0.0.1 port=%s dbname=%s user=%s connect_timeout=2 options=''-c statement_timeout=15000''',
      current_setting('port'),current_database(),current_user
    )
  );
  perform extensions.dblink_connect(
    'norva_adk_reaper',pg_catalog.format(
      'host=127.0.0.1 port=%s dbname=%s user=%s connect_timeout=2 options=''-c statement_timeout=15000''',
      current_setting('port'),current_database(),current_user
    )
  );
  select remote.pid into strict v_transition_pid
  from extensions.dblink('norva_adk_transition','select pg_backend_pid()')
    as remote(pid integer);
  select remote.pid into strict v_reaper_pid
  from extensions.dblink('norva_adk_reaper','select pg_backend_pid()')
    as remote(pid integer);

  -- Transition wins but remains uncommitted.  The competing tombstone UPDATE
  -- reaches the same source row and demonstrably waits before the reaper can
  -- select anything.
  perform extensions.dblink_exec('norva_adk_transition','begin');
  perform extensions.dblink_exec(
    'norva_adk_transition',
    'set local "request.jwt.claim.role" = ''service_role'''
  );
  perform extensions.dblink_exec(
    'norva_adk_transition','set local session_replication_role = ''replica'''
  );
  perform extensions.dblink_exec(
    'norva_adk_transition',
    $$update public.admin_feature_flags set enabled=true
      where key='provider_credential_transition_v1_enabled'$$
  );
  perform extensions.dblink_exec(
    'norva_adk_transition','set local session_replication_role = ''origin'''
  );
  select remote.result into strict v_transition_result
  from extensions.dblink(
    'norva_adk_transition',pg_catalog.format(
      'select public.norva_test_account_delete_create_transition(%L::uuid,%L::uuid,%L::uuid)',
      v_first.user_id,v_first.source_id,v_first.authority_token
    )
  ) as remote(result text);
  if split_part(v_transition_result,'|',1) <> '00000' then
    raise exception 'transition-first overlap fixture failed: %',
      v_transition_result;
  end if;
  perform extensions.dblink_exec('norva_adk_reaper','begin');
  perform extensions.dblink_send_query(
    'norva_adk_reaper',pg_catalog.format(
      'select public.norva_test_account_delete_tombstone_reap(%L::uuid)',
      v_first.source_id
    )
  );
  v_waited := 0;
  while v_waited < 200 and not exists (
    select 1 from pg_catalog.pg_stat_activity activity
    where activity.pid = v_reaper_pid and activity.wait_event_type = 'Lock'
  ) loop
    perform pg_catalog.pg_sleep(0.01); v_waited := v_waited + 1;
  end loop;
  if v_waited >= 200
     or extensions.dblink_is_busy('norva_adk_reaper') <> 1 then
    raise exception 'reaper did not overlap the uncommitted transition';
  end if;
  perform extensions.dblink_exec(
    'norva_adk_transition','set local session_replication_role = ''replica'''
  );
  perform extensions.dblink_exec(
    'norva_adk_transition',
    $$update public.admin_feature_flags set enabled=false
      where key='provider_credential_transition_v1_enabled'$$
  );
  perform extensions.dblink_exec('norva_adk_transition','commit');
  select remote.payload into strict v_reaper_result
  from extensions.dblink_get_result('norva_adk_reaper')
    as remote(payload jsonb);
  perform count(*) from extensions.dblink_get_result('norva_adk_reaper')
    as remote(payload jsonb);
  perform extensions.dblink_exec('norva_adk_reaper','commit');
  insert into provider_account_delete_extended_results values (
    'transition_first',jsonb_build_object(
      'overlapObserved',true,
      'transitionResult',v_transition_result,
      'sourceDeletionPending',
        (v_reaper_result->>'sourceDeletionPending')::boolean,
      'transitionCount',(
        select count(*) from public.cloud_source_transitions transition
        where transition.user_id = v_first.user_id
          and transition.old_source_id = v_first.source_id
          and transition.idempotency_key =
            'delete-reaper-race-' || v_first.authority_token::text
      )
    )
  );

  -- Reaper wins and returns while its transaction intentionally remains open,
  -- proving the later transition is blocked on the uncommitted source fence.
  perform extensions.dblink_exec('norva_adk_reaper','begin');
  select remote.payload into strict v_reaper_result
  from extensions.dblink(
    'norva_adk_reaper',pg_catalog.format(
      'select public.norva_test_account_delete_tombstone_reap(%L::uuid)',
      v_second.source_id
    )
  ) as remote(payload jsonb);
  perform extensions.dblink_exec('norva_adk_transition','begin');
  perform extensions.dblink_exec(
    'norva_adk_transition',
    'set local "request.jwt.claim.role" = ''service_role'''
  );
  perform extensions.dblink_exec(
    'norva_adk_transition','set local session_replication_role = ''replica'''
  );
  perform extensions.dblink_exec(
    'norva_adk_transition',
    $$update public.admin_feature_flags set enabled=true
      where key='provider_credential_transition_v1_enabled'$$
  );
  perform extensions.dblink_exec(
    'norva_adk_transition','set local session_replication_role = ''origin'''
  );
  perform extensions.dblink_send_query(
    'norva_adk_transition',pg_catalog.format(
      'select public.norva_test_account_delete_create_transition(%L::uuid,%L::uuid,%L::uuid)',
      v_second.user_id,v_second.source_id,v_second.authority_token
    )
  );
  v_waited := 0;
  while v_waited < 200 and not exists (
    select 1 from pg_catalog.pg_stat_activity activity
    where activity.pid = v_transition_pid and activity.wait_event_type = 'Lock'
  ) loop
    perform pg_catalog.pg_sleep(0.01); v_waited := v_waited + 1;
  end loop;
  if v_waited >= 200
     or extensions.dblink_is_busy('norva_adk_transition') <> 1 then
    raise exception 'transition did not overlap the uncommitted reaper fence';
  end if;
  perform extensions.dblink_exec('norva_adk_reaper','commit');
  select remote.result into strict v_transition_result
  from extensions.dblink_get_result('norva_adk_transition')
    as remote(result text);
  perform count(*) from extensions.dblink_get_result('norva_adk_transition')
    as remote(result text);
  perform extensions.dblink_exec(
    'norva_adk_transition','set local session_replication_role = ''replica'''
  );
  perform extensions.dblink_exec(
    'norva_adk_transition',
    $$update public.admin_feature_flags set enabled=false
      where key='provider_credential_transition_v1_enabled'$$
  );
  perform extensions.dblink_exec('norva_adk_transition','commit');
  insert into provider_account_delete_extended_results values (
    'reaper_first',jsonb_build_object(
      'overlapObserved',true,
      'sourceDeletionPending',
        (v_reaper_result->>'sourceDeletionPending')::boolean,
      'transitionResult',v_transition_result,
      'transitionCount',(
        select count(*) from public.cloud_source_transitions transition
        where transition.user_id = v_second.user_id
          and transition.old_source_id = v_second.source_id
          and transition.idempotency_key =
            'delete-reaper-race-' || v_second.authority_token::text
      )
    )
  );

  -- Fault injection: session A acquires the reaper singleton and then raises
  -- from the source fence UPDATE.  Rolling that transaction back must release
  -- the xact advisory key, allowing session B to fence the same fixture.
  perform extensions.dblink_exec('norva_adk_transition','begin');
  perform extensions.dblink_exec(
    'norva_adk_transition',$sql$
      create function public.norva_test_reaper_fault_guard()
      returns trigger language plpgsql set search_path = '' as $body$
      begin
        if new.id::text = current_setting('norva.test_reaper_fault_source',true)
           and new.provider_deletion_pending
           and not old.provider_deletion_pending then
          raise exception 'forced reaper rollback';
        end if;
        return new;
      end
      $body$
    $sql$
  );
  perform extensions.dblink_exec(
    'norva_adk_transition',$sql$
      create trigger trg_zzzz_test_reaper_fault
      before update on public.cloud_sources
      for each row execute function public.norva_test_reaper_fault_guard()
    $sql$
  );
  perform extensions.dblink_exec(
    'norva_adk_transition',pg_catalog.format(
      'set local "norva.test_reaper_fault_source" = %L',v_fault.source_id
    )
  );
  perform extensions.dblink_exec(
    'norva_adk_transition',pg_catalog.format(
      $$update public.cloud_sources
        set deleted_at='2000-01-01 00:00:00+00'::timestamptz,enabled=false
        where id=%L::uuid$$,v_fault.source_id
    )
  );
  begin
    perform extensions.dblink_exec(
      'norva_adk_transition','call public.reap_deleted_sources()'
    );
  exception when others then
    v_fault_observed := true;
  end;
  if not v_fault_observed then
    raise exception 'reaper fault injection unexpectedly completed';
  end if;
  perform extensions.dblink_exec('norva_adk_transition','rollback');
  perform extensions.dblink_exec('norva_adk_reaper','begin');
  select remote.payload into strict v_reaper_result
  from extensions.dblink(
    'norva_adk_reaper',pg_catalog.format(
      'select public.norva_test_account_delete_tombstone_reap(%L::uuid)',
      v_fault.source_id
    )
  ) as remote(payload jsonb);
  perform extensions.dblink_exec('norva_adk_reaper','commit');
  insert into provider_account_delete_extended_results values (
    'reaper_fault',jsonb_build_object(
      'faultObserved',v_fault_observed,
      'secondSessionAcquired',
        (v_reaper_result->>'sourceDeletionPending')::boolean
    )
  );
  perform extensions.dblink_disconnect('norva_adk_transition');
  perform extensions.dblink_disconnect('norva_adk_reaper');
exception when others then
  foreach v_connection in array coalesce(
    extensions.dblink_get_connections(),array[]::text[]
  ) loop
    if v_connection in ('norva_adk_transition','norva_adk_reaper') then
      begin
        if extensions.dblink_is_busy(v_connection) = 1 then
          perform extensions.dblink_cancel_query(v_connection);
        end if;
      exception when others then null;
      end;
      begin perform extensions.dblink_exec(v_connection,'rollback');
      exception when others then null;
      end;
      begin perform extensions.dblink_disconnect(v_connection);
      exception when others then null;
      end;
    end if;
  end loop;
  raise;
end
$reaper_transition_overlap$;

do $reaper_assertions$
declare
  v_first jsonb;
  v_second jsonb;
  v_fault jsonb;
begin
  select result into strict v_first
  from provider_account_delete_extended_results
  where scenario = 'transition_first';
  select result into strict v_second
  from provider_account_delete_extended_results
  where scenario = 'reaper_first';
  select result into strict v_fault
  from provider_account_delete_extended_results
  where scenario = 'reaper_fault';
  if (v_first->>'overlapObserved')::boolean is not true
     or split_part(v_first->>'transitionResult','|',1) <> '00000'
     or (v_first->>'sourceDeletionPending')::boolean is not false
     or (v_first->>'transitionCount')::integer <> 1 then
    raise exception 'transition-first reaper invariant failed: %',v_first;
  end if;
  if (v_second->>'overlapObserved')::boolean is not true
     or (v_second->>'sourceDeletionPending')::boolean is not true
     or split_part(v_second->>'transitionResult','|',1) <> '55000'
     or (v_second->>'transitionCount')::integer <> 0 then
    raise exception 'reaper-first transition invariant failed: %',v_second;
  end if;
  if (v_fault->>'faultObserved')::boolean is not true
     or (v_fault->>'secondSessionAcquired')::boolean is not true then
    raise exception 'reaper xact-lock rollback invariant failed: %',v_fault;
  end if;
end
$reaper_assertions$;

-- Race D: a reclaimed deletion lease makes every old worker CAS stale.  The
-- final expiry persists a dead envelope (it must not be rolled back by RAISE).
do $reclaim_begin$
declare
  v_fixture provider_account_delete_race_fixtures%rowtype;
  v_begin jsonb;
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  select * into strict v_fixture from provider_account_delete_race_fixtures
  where scenario = 'reclaim_dead';
  v_begin := public.norva_begin_provider_account_deletion_prepare(
    v_fixture.user_id
  );
  update public.cloud_provider_account_delete_preparations preparation
  set max_attempts = 3
  where preparation.user_id = v_fixture.user_id;
end
$reclaim_begin$;

do $reclaim_w1$
declare
  v_fixture provider_account_delete_race_fixtures%rowtype;
  v_w1 jsonb;
  v_connection text := pg_catalog.format(
    'host=127.0.0.1 port=%s dbname=%s user=%s connect_timeout=2 options=''-c statement_timeout=15000''',
    current_setting('port'),current_database(),current_user
  );
begin
  select * into strict v_fixture from provider_account_delete_race_fixtures
  where scenario = 'reclaim_dead';
  select remote.payload into strict v_w1
  from extensions.dblink(v_connection,pg_catalog.format(
    'select public.norva_test_account_delete_claim(%L::uuid,%L)',
    v_fixture.user_id,'account-delete-race-w1'
  )) as remote(payload jsonb);
  insert into provider_account_delete_extended_results values (
    'reclaim_dead',jsonb_build_object('w1',v_w1)
  );
end
$reclaim_w1$;

update public.cloud_provider_account_delete_preparations preparation
set lease_until = clock_timestamp() - interval '1 second'
from provider_account_delete_race_fixtures fixture
where fixture.scenario = 'reclaim_dead'
  and preparation.user_id = fixture.user_id;

do $reclaim_w2_and_stale_w1$
declare
  v_fixture provider_account_delete_race_fixtures%rowtype;
  v_result jsonb;
  v_w1 jsonb;
  v_w2 jsonb;
  v_stale jsonb;
  v_stale_checkpoint jsonb;
  v_stale_settle jsonb;
  v_connection text := pg_catalog.format(
    'host=127.0.0.1 port=%s dbname=%s user=%s connect_timeout=2 options=''-c statement_timeout=15000''',
    current_setting('port'),current_database(),current_user
  );
begin
  select * into strict v_fixture from provider_account_delete_race_fixtures
  where scenario = 'reclaim_dead';
  select result into strict v_result
  from provider_account_delete_extended_results where scenario = 'reclaim_dead';
  v_w1 := v_result->'w1';
  select remote.payload into strict v_w2
  from extensions.dblink(v_connection,pg_catalog.format(
    'select public.norva_test_account_delete_claim(%L::uuid,%L)',
    v_fixture.user_id,'account-delete-race-w2'
  )) as remote(payload jsonb);
  select remote.payload into strict v_stale
  from extensions.dblink(v_connection,pg_catalog.format(
    'select public.norva_test_account_delete_run_batch(%L::uuid,%L,%s,%s)',
    v_fixture.user_id,'account-delete-race-w1',
    (v_w1->>'leaseSequence')::integer,(v_w1->>'revision')::bigint
  )) as remote(payload jsonb);
  select remote.payload into strict v_stale_checkpoint
  from extensions.dblink(v_connection,pg_catalog.format(
    'select public.norva_test_account_delete_checkpoint(%L::uuid,%L,%s,%s)',
    v_fixture.user_id,'account-delete-race-w1',
    (v_w1->>'leaseSequence')::integer,(v_w1->>'revision')::bigint
  )) as remote(payload jsonb);
  select remote.payload into strict v_stale_settle
  from extensions.dblink(v_connection,pg_catalog.format(
    'select public.norva_test_account_delete_settle_failure(%L::uuid,%L,%s,%s)',
    v_fixture.user_id,'account-delete-race-w1',
    (v_w1->>'leaseSequence')::integer,(v_w1->>'revision')::bigint
  )) as remote(payload jsonb);
  update provider_account_delete_extended_results
  set result = result || jsonb_build_object(
    'w2',v_w2,'staleW1',v_stale,
    'staleCheckpointW1',v_stale_checkpoint,
    'staleSettleW1',v_stale_settle
  )
  where scenario = 'reclaim_dead';
end
$reclaim_w2_and_stale_w1$;

update public.cloud_provider_account_delete_preparations preparation
set lease_until = clock_timestamp() - interval '1 second'
from provider_account_delete_race_fixtures fixture
where fixture.scenario = 'reclaim_dead'
  and preparation.user_id = fixture.user_id;

do $reclaim_w3$
declare
  v_fixture provider_account_delete_race_fixtures%rowtype;
  v_w3 jsonb;
  v_connection text := pg_catalog.format(
    'host=127.0.0.1 port=%s dbname=%s user=%s connect_timeout=2 options=''-c statement_timeout=15000''',
    current_setting('port'),current_database(),current_user
  );
begin
  select * into strict v_fixture from provider_account_delete_race_fixtures
  where scenario = 'reclaim_dead';
  select remote.payload into strict v_w3
  from extensions.dblink(v_connection,pg_catalog.format(
    'select public.norva_test_account_delete_claim(%L::uuid,%L)',
    v_fixture.user_id,'account-delete-race-w3'
  )) as remote(payload jsonb);
  update provider_account_delete_extended_results
  set result = result || jsonb_build_object('w3',v_w3)
  where scenario = 'reclaim_dead';
end
$reclaim_w3$;

update public.cloud_provider_account_delete_preparations preparation
set lease_until = clock_timestamp() - interval '1 second'
from provider_account_delete_race_fixtures fixture
where fixture.scenario = 'reclaim_dead'
  and preparation.user_id = fixture.user_id;

do $reclaim_dead$
declare
  v_fixture provider_account_delete_race_fixtures%rowtype;
  v_dead jsonb;
  v_connection text := pg_catalog.format(
    'host=127.0.0.1 port=%s dbname=%s user=%s connect_timeout=2 options=''-c statement_timeout=15000''',
    current_setting('port'),current_database(),current_user
  );
begin
  select * into strict v_fixture from provider_account_delete_race_fixtures
  where scenario = 'reclaim_dead';
  select remote.payload into strict v_dead
  from extensions.dblink(v_connection,pg_catalog.format(
    'select public.norva_test_account_delete_claim(%L::uuid,%L)',
    v_fixture.user_id,'account-delete-race-w4'
  )) as remote(payload jsonb);
  update provider_account_delete_extended_results
  set result = result || jsonb_build_object('dead',v_dead)
  where scenario = 'reclaim_dead';
end
$reclaim_dead$;

do $reclaim_assertions_and_reset$
declare
  v_fixture provider_account_delete_race_fixtures%rowtype;
  v_result jsonb;
  v_durable jsonb;
begin
  select * into strict v_fixture from provider_account_delete_race_fixtures
  where scenario = 'reclaim_dead';
  select jsonb_build_object(
    'state',preparation.state,'phase',preparation.phase,
    'revision',preparation.revision,
    'failureAttemptCount',preparation.failure_attempt_count,
    'leaseOwner',preparation.lease_owner,
    'leaseUntil',preparation.lease_until,
    'lastErrorCode',preparation.last_error_code
  ) into strict v_durable
  from public.cloud_provider_account_delete_preparations preparation
  where preparation.user_id = v_fixture.user_id;
  update provider_account_delete_extended_results
  set result = result || jsonb_build_object('durable',v_durable)
  where scenario = 'reclaim_dead';
  select result into strict v_result
  from provider_account_delete_extended_results where scenario = 'reclaim_dead';
  if v_result#>>'{w1,state}' <> 'processing'
     or (v_result#>>'{w1,leaseSequence}')::integer <> 1
     or (v_result#>>'{w1,revision}')::bigint <> 1
     or v_result#>>'{w2,state}' <> 'processing'
     or (v_result#>>'{w2,leaseSequence}')::integer <> 2
     or (v_result#>>'{w2,revision}')::bigint <> 2
     or (v_result#>>'{w2,failureAttemptCount}')::integer <> 1
     or v_result#>>'{staleW1,sqlstate}' <> '40001'
     or v_result#>>'{staleCheckpointW1,sqlstate}' <> '40001'
     or v_result#>>'{staleSettleW1,sqlstate}' <> '40001'
     or v_result#>>'{w3,state}' <> 'processing'
     or (v_result#>>'{w3,leaseSequence}')::integer <> 3
     or (v_result#>>'{w3,revision}')::bigint <> 3
     or (v_result#>>'{w3,failureAttemptCount}')::integer <> 2
     or v_result#>>'{dead,state}' <> 'dead'
     or (v_result#>>'{dead,dead}')::boolean is not true
     or (v_result#>>'{dead,revision}')::bigint <> 4
     or (v_result#>>'{dead,failureAttemptCount}')::integer <> 3
     or v_result#>>'{durable,state}' <> 'dead'
     or (v_result#>>'{durable,revision}')::bigint <> 4
     or v_result#>>'{durable,lastErrorCode}' <> 'lease_expired'
     or (v_result#>>'{durable,failureAttemptCount}')::integer <> 3
     or v_result#>>'{durable,leaseOwner}' is not null
     or v_result#>>'{durable,leaseUntil}' is not null then
    raise exception 'stale reclaim/dead envelope invariant failed: %',v_result;
  end if;
  -- Test-only recovery lets the common cleanup exercise the real protocol;
  -- the captured result above remains the durable dead proof.
  update public.cloud_provider_account_delete_preparations preparation
  set state = 'pending',phase = 'drain',lease_owner = null,lease_until = null,
      available_at = now(),failure_attempt_count = 0,max_attempts = 25,
      last_error_code = null,revision = preparation.revision + 1,
      updated_at = now()
  where preparation.user_id = v_fixture.user_id
    and preparation.state = 'dead';
  if not found then
    raise exception 'stale reclaim test reset lost its exact dead row';
  end if;
end
$reclaim_assertions_and_reset$;

-- Complete the real bounded protocol so fixture cleanup itself exercises the
-- durable proof and never bypasses the production auth/source guards.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '2min';
set local "request.jwt.claim.role" = 'service_role';
do $cleanup$
declare
  v_user uuid;
  v_stop jsonb;
  v_begin jsonb;
  v_claim jsonb;
  v_run jsonb;
  v_account jsonb;
  v_final_key uuid;
  v_loops integer;
begin
  for v_user in
    select fixture.user_id
    from provider_account_delete_race_fixtures fixture
    order by fixture.scenario
  loop
    v_begin := public.norva_begin_provider_account_deletion_prepare(v_user);
    v_stop := public.norva_claim_provider_transport_stop_action(
      v_user,'account-delete-race-cleanup',60
    );
    v_stop := public.norva_settle_provider_transport_stop_action(
      v_user,'account-delete-race-cleanup',
      (v_stop->>'leaseSequence')::integer,(v_stop->>'revision')::bigint,
      'completed',repeat('d',64),null,0
    );
    v_claim := public.norva_claim_provider_account_deletion_prepare(
      v_user,'account-delete-race-cleanup',120
    );
    v_loops := 0;
    loop
      v_loops := v_loops + 1;
      if v_loops > 64 then
        raise exception 'race fixture cleanup did not converge for %',v_user;
      end if;
      v_run := public.norva_run_provider_account_deletion_prepare_batch(
        v_user,'account-delete-race-cleanup',
        (v_claim->>'leaseSequence')::integer,
        (v_claim->>'revision')::bigint,100
      );
      exit when (v_run->>'ready')::boolean;
      if (v_run->>'waitingForDrain')::boolean then
        raise exception 'race fixture cleanup remained in drain for %',v_user;
      end if;
      v_claim := v_run;
    end loop;
    v_account := public.norva_begin_account_deletion_workflow(v_user);
    v_account := public.norva_advance_account_deletion_workflow(v_user,(v_account->>'revision')::bigint,500);
    loop
      v_account := public.norva_purge_account_deletion_paywall_batch(v_user,(v_account->>'revision')::bigint,500);
      exit when (v_account->>'complete')::boolean;
    end loop;
    v_account := public.norva_advance_account_deletion_workflow(v_user,(v_account->>'revision')::bigint,500);
    v_account := public.norva_advance_account_deletion_workflow(v_user,(v_account->>'revision')::bigint,500);
    loop
      v_account := public.norva_purge_account_deletion_product_batch(v_user,(v_account->>'revision')::bigint,500);
      exit when (v_account->>'readyToFinalize')::boolean;
    end loop;
    select claim.finalization_key into strict v_final_key from public.norva_claim_account_deletion_finalizations(1,120) claim where claim.user_id=v_user;
    delete from auth.users where id = v_user;
    perform public.norva_complete_account_deletion_finalization(v_final_key);
    delete from public.cloud_account_deletion_finalizations where finalization_key=v_final_key;
  end loop;
end
$cleanup$;

drop trigger trg_aab_provider_account_delete_test_pause on public.cloud_titles;
drop trigger trg_zzz_provider_account_delete_test_permit_pause
  on public.cloud_provider_call_permits;
drop function public.norva_test_account_delete_pause_guard();
drop function public.norva_test_account_delete_permit_pause_guard();
drop function public.norva_test_account_delete_insert_title(uuid,uuid);
drop function public.norva_test_account_delete_acquire_permit(
  uuid,uuid,uuid,text
);
drop function public.norva_test_account_delete_create_transition(
  uuid,uuid,uuid
);
drop function public.norva_test_account_delete_tombstone_reap(uuid);
drop function public.norva_test_account_delete_run_batch(
  uuid,text,integer,bigint
);
drop function public.norva_test_account_delete_checkpoint(
  uuid,text,integer,bigint
);
drop function public.norva_test_account_delete_settle_failure(
  uuid,text,integer,bigint
);
drop function public.norva_test_account_delete_claim(uuid,text);

do $final_assert$
begin
  if exists (
       select 1 from auth.users account
       join provider_account_delete_race_fixtures fixture
         on fixture.user_id = account.id
     ) or exists (
       select 1 from public.cloud_titles title_row
       join provider_account_delete_race_fixtures fixture
         on fixture.title_id = title_row.id
     ) or exists (
       select 1
       from auth.users account
       where account.email ~
         '^(guard_first|begin_first|permit_first|permit_begin_first|transition_first|reaper_first|reaper_fault|reclaim_dead)-[0-9a-f-]+@invalid[.]test$'
     ) or exists (
       select 1
       from public.cloud_sources source
       where source.display_name ~
         '^Delete race (guard_first|begin_first|permit_first|permit_begin_first|transition_first|reaper_first|reaper_fault|reclaim_dead)$'
         and source.config_ciphertext ~ '^cipher-delete-race-'
     ) or exists (
       select 1
       from public.cloud_titles title_row
       where title_row.identity_key ~ '^delete-race-[0-9a-f-]+$'
     ) or exists (
       select 1
       from public.cloud_source_transitions transition
       where transition.idempotency_key ~
         '^delete-reaper-race-[0-9a-f-]+$'
     ) or exists (
       select 1
       from public.cloud_provider_call_permits permit
       where permit.permit_owner like 'account-delete-race-%'
     ) or exists (
       select 1
       from public.cloud_source_direct_fallback_leases lease
       where lease.lease_owner = 'account-delete-race-permit'
     ) then
    raise exception 'provider account-delete race fixture cleanup drifted';
  end if;
end
$final_assert$;
commit;

table provider_account_delete_race_results order by scenario;
table provider_account_delete_extended_results order by scenario;

do $connection_assert$
begin
  if exists (
    select 1
    from unnest(coalesce(
      extensions.dblink_get_connections(),array[]::text[]
    )) connection_name
    where connection_name like 'norva_adk_%'
  ) then
    raise exception 'provider account-delete smoke leaked a dblink connection';
  end if;
end
$connection_assert$;
reset statement_timeout;
reset lock_timeout;
