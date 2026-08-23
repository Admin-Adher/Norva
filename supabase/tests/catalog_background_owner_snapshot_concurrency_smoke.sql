\set ON_ERROR_STOP on
\timing on
set statement_timeout = '60s';
set lock_timeout = '2s';

-- Test-only dblink matrix for the owner-snapshot publication frontier.
-- For each payload/membership operation (variant INSERT, title UPDATE,
-- variant DELETE), writer_first completes the statement before the baseline
-- source-map exists but keeps its transaction uncommitted after the production
-- sync trigger.  The begin/build transaction must wait on the user epoch, then
-- either consume the committed state or reject a stale epoch and succeed on an
-- exact retry.
-- activation_first publishes an already-READY version while the writer waits
-- on that same epoch; after publication the writer must patch the ACTIVE row.

do $prerequisite$
begin
  if to_regprocedure('dblink_connect(text,text)') is null then
    raise exception 'owner snapshot concurrency smoke requires dblink'
      using errcode = '55000';
  end if;
end
$prerequisite$;

-- An interrupted prior run may have committed random fixtures before a later
-- assertion stopped psql.  Re-enter the production bounded protocol for only
-- this harness's exact email namespace so the file is rerunnable.
do $stale_fixture_cleanup$
declare
  v_user uuid;
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
      '^owner-snapshot-(insert|update|delete)-(writer_first|activation_first)-[0-9a-f-]+@invalid[.]test$'
    order by account.id
  loop
    perform public.norva_begin_provider_account_deletion_prepare(v_user);
    v_stop := public.norva_claim_provider_transport_stop_action(
      v_user,'owner-snapshot-race-preflight',60
    );
    v_stop := public.norva_settle_provider_transport_stop_action(
      v_user,'owner-snapshot-race-preflight',
      (v_stop->>'leaseSequence')::integer,(v_stop->>'revision')::bigint,
      'completed',repeat('f',64),null,0
    );
    v_claim := public.norva_claim_provider_account_deletion_prepare(
      v_user,'owner-snapshot-race-preflight',120
    );
    v_loops := 0;
    loop
      v_loops := v_loops + 1;
      if v_loops > 96 then
        raise exception 'stale owner race cleanup did not converge for %',v_user;
      end if;
      v_run := public.norva_run_provider_account_deletion_prepare_batch(
        v_user,'owner-snapshot-race-preflight',
        (v_claim->>'leaseSequence')::integer,
        (v_claim->>'revision')::bigint,100
      );
      exit when (v_run->>'ready')::boolean;
      if (v_run->>'waitingForDrain')::boolean then
        raise exception 'stale owner race cleanup remained in drain for %',
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
    delete from auth.users where id=v_user;
    perform public.norva_complete_account_deletion_finalization(v_final_key);
    delete from public.cloud_account_deletion_finalizations
    where finalization_key=v_final_key;
  end loop;
end
$stale_fixture_cleanup$;

create temporary table catalog_background_owner_snapshot_race_fixtures(
  scenario text primary key,
  operation text not null check (operation in ('insert','update','delete')),
  ordering text not null check (
    ordering in ('writer_first','activation_first')
  ),
  user_id uuid not null unique,
  source_id uuid not null unique,
  title_id uuid not null unique,
  variant_id uuid not null unique,
  generation_id uuid,
  initial_visibility_epoch bigint,
  snapshot_id uuid,
  snapshot_revision bigint,
  snapshot_build_epoch bigint,
  expected_title text not null,
  email text not null unique
) on commit preserve rows;

insert into catalog_background_owner_snapshot_race_fixtures(
  scenario,operation,ordering,user_id,source_id,title_id,variant_id,
  expected_title,email
)
select
  fixture.operation || '_' || fixture.ordering,
  fixture.operation,fixture.ordering,
  pg_catalog.gen_random_uuid(),pg_catalog.gen_random_uuid(),
  pg_catalog.gen_random_uuid(),pg_catalog.gen_random_uuid(),
  case when fixture.operation = 'update'
    then 'Owner snapshot concurrent V2'
    else 'Owner snapshot concurrent V1'
  end,
  'owner-snapshot-' || fixture.operation || '-' || fixture.ordering || '-'
    || pg_catalog.gen_random_uuid()::text || '@invalid.test'
from (values
  ('insert','writer_first'),('insert','activation_first'),
  ('update','writer_first'),('update','activation_first'),
  ('delete','writer_first'),('delete','activation_first')
) as fixture(operation,ordering);

begin;
set local statement_timeout = '60s';
set local lock_timeout = '2s';
set local "request.jwt.claim.role" = 'service_role';

insert into auth.users (
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
)
select fixture.user_id,
  '00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated',fixture.email,'',now(),
  '{}'::jsonb,'{}'::jsonb,now(),now()
from catalog_background_owner_snapshot_race_fixtures fixture;

insert into public.cloud_sources (
  id,user_id,source_type,display_name,config_ciphertext,config_hint,
  sync_status,catalog_version,enabled,last_synced_at
)
select fixture.source_id,fixture.user_id,'xtream',
  'Owner snapshot ' || fixture.scenario,
  'cipher-owner-snapshot-' || fixture.scenario,'{}'::jsonb,
  'ready',1,true,now()
from catalog_background_owner_snapshot_race_fixtures fixture;

update catalog_background_owner_snapshot_race_fixtures fixture
set generation_id = head.active_generation_id
from public.cloud_source_catalog_heads head
where head.user_id = fixture.user_id and head.source_id = fixture.source_id;

do $fixture_generation_assert$
begin
  if exists (
    select 1 from catalog_background_owner_snapshot_race_fixtures fixture
    where fixture.generation_id is null
  ) then
    raise exception 'owner snapshot race source bootstrap is incomplete';
  end if;
end
$fixture_generation_assert$;

insert into public.cloud_titles (
  id,user_id,item_type,identity_key,identity_source,provider_tmdb_id,
  match_status,title,metadata,search_match_attempted_at,updated_at
)
select fixture.title_id,fixture.user_id,'movie',
  'owner-race:' || fixture.title_id::text,'normalized',null,
  'unmatched','Owner snapshot concurrent V1',
  jsonb_build_object('version','v1'),null,clock_timestamp()
from catalog_background_owner_snapshot_race_fixtures fixture;

insert into public.cloud_title_variants (
  id,user_id,title_id,source_id,item_type,external_id,raw_title,generation_id,
  write_head_revision,write_config_revision,
  write_source_visibility_epoch,write_user_visibility_epoch
)
select fixture.variant_id,fixture.user_id,fixture.title_id,fixture.source_id,
  'movie','owner-race-' || fixture.title_id::text,
  'Owner snapshot concurrent V1',fixture.generation_id,
  head.head_revision,lifecycle.config_revision,lifecycle.visibility_epoch,
  epoch.visibility_epoch
from catalog_background_owner_snapshot_race_fixtures fixture
join public.cloud_source_catalog_heads head
  on head.source_id=fixture.source_id and head.user_id=fixture.user_id
join public.cloud_source_lifecycle lifecycle
  on lifecycle.source_id=fixture.source_id and lifecycle.user_id=fixture.user_id
join public.cloud_user_catalog_visibility_epochs epoch
  on epoch.user_id=fixture.user_id
where fixture.operation <> 'insert';

insert into public.cloud_user_catalog_visibility_epochs(
  user_id,visibility_epoch,updated_at
)
select fixture.user_id,1,now()
from catalog_background_owner_snapshot_race_fixtures fixture
on conflict (user_id) do nothing;

update catalog_background_owner_snapshot_race_fixtures fixture
set initial_visibility_epoch = epoch.visibility_epoch
from public.cloud_user_catalog_visibility_epochs epoch
where epoch.user_id = fixture.user_id;

-- Build activation_first fixtures to READY only.  Publication is deliberately
-- deferred to the dblink transaction; a non-empty last page and activation
-- must never share one transaction because they acquire title and epoch locks
-- in opposite phases of the protocol.
do $ready_fixtures$
declare
  v_fixture catalog_background_owner_snapshot_race_fixtures%rowtype;
  v_begin jsonb;
  v_build jsonb;
begin
  for v_fixture in
    select * from catalog_background_owner_snapshot_race_fixtures
    where ordering = 'activation_first' order by scenario
  loop
    v_begin := public.norva_begin_catalog_background_owner_snapshot(
      v_fixture.user_id,null,'baseline',null,null,null,
      v_fixture.initial_visibility_epoch
    );
    v_build := public.norva_build_catalog_background_owner_snapshot_slice(
      (v_begin->>'snapshotId')::uuid,v_fixture.user_id,
      (v_begin->>'revision')::bigint,
      (v_begin->>'visibilityEpoch')::bigint,100
    );
    if not (v_build->>'complete')::boolean
       or v_build->>'state' <> 'ready' then
      raise exception 'owner race READY fixture did not finish: %',v_build;
    end if;
    update catalog_background_owner_snapshot_race_fixtures fixture
    set snapshot_id = (v_begin->>'snapshotId')::uuid,
        snapshot_revision = (v_build->>'revision')::bigint,
        snapshot_build_epoch = (v_begin->>'visibilityEpoch')::bigint
    where fixture.scenario = v_fixture.scenario;
  end loop;
end
$ready_fixtures$;
commit;

create temporary table catalog_background_owner_snapshot_race_results(
  scenario text primary key,
  operation text not null,
  ordering text not null,
  first_build_sqlstate text,
  retried boolean not null default false,
  writer_wait_observed boolean not null,
  builder_wait_observed boolean not null,
  active_snapshot_id uuid not null,
  final_visibility_epoch bigint not null,
  returned_titles integer not null,
  owner_present boolean not null,
  owner_title text
) on commit preserve rows;

set "request.jwt.claim.role" = 'service_role';

do $snapshot_races$
declare
  v_fixture catalog_background_owner_snapshot_race_fixtures%rowtype;
  v_writer_pid integer;
  v_builder_pid integer;
  v_waited integer;
  v_writer_sql text;
  v_writer_result jsonb;
  v_builder_result jsonb;
  v_activate_result jsonb;
  v_current_epoch bigint;
  v_snapshot_id uuid;
  v_snapshot_revision bigint;
  v_snapshot_epoch bigint;
  v_page jsonb;
  v_present boolean;
  v_owner_title text;
  v_first_sqlstate text;
  v_retried boolean;
  v_connection text;
begin
  perform dblink_connect(
    'norva_owner_writer',pg_catalog.format(
      'host=127.0.0.1 port=%s dbname=%s user=%s connect_timeout=2 options=''-c statement_timeout=15000''',
      current_setting('port'),current_database(),current_user
    )
  );
  perform dblink_connect(
    'norva_owner_builder',pg_catalog.format(
      'host=127.0.0.1 port=%s dbname=%s user=%s connect_timeout=2 options=''-c statement_timeout=15000''',
      current_setting('port'),current_database(),current_user
    )
  );
  select remote.pid into strict v_writer_pid
  from dblink('norva_owner_writer','select pg_backend_pid()')
    as remote(pid integer);
  select remote.pid into strict v_builder_pid
  from dblink('norva_owner_builder','select pg_backend_pid()')
    as remote(pid integer);

  for v_fixture in
    select * from catalog_background_owner_snapshot_race_fixtures
    order by operation,ordering
  loop
    v_retried := false;
    v_first_sqlstate := null;
    v_snapshot_id := v_fixture.snapshot_id;
    v_snapshot_revision := v_fixture.snapshot_revision;
    v_snapshot_epoch := v_fixture.snapshot_build_epoch;
    if v_fixture.operation = 'update' then
      v_writer_sql := pg_catalog.format(
        $$update public.cloud_titles
          set title='Owner snapshot concurrent V2',
              metadata=jsonb_build_object('version','v2'),
              updated_at=clock_timestamp()
          where id=%L::uuid and user_id=%L::uuid
          returning jsonb_build_object('sqlstate','00000','rows',1)$$,
        v_fixture.title_id,v_fixture.user_id
      );
    elsif v_fixture.operation = 'insert' then
      v_writer_sql := pg_catalog.format(
        $$insert into public.cloud_title_variants(
            id,user_id,title_id,source_id,item_type,external_id,raw_title,
            generation_id,write_head_revision,write_config_revision,
            write_source_visibility_epoch,write_user_visibility_epoch
          ) select %L::uuid,%L::uuid,%L::uuid,%L::uuid,'movie',%L,
            'Owner snapshot concurrent V1',%L::uuid,
            head.head_revision,lifecycle.config_revision,lifecycle.visibility_epoch,
            epoch.visibility_epoch
          from public.cloud_source_catalog_heads head
          join public.cloud_source_lifecycle lifecycle
            on lifecycle.source_id=head.source_id and lifecycle.user_id=head.user_id
          join public.cloud_user_catalog_visibility_epochs epoch
            on epoch.user_id=head.user_id
          where head.source_id=%L::uuid and head.user_id=%L::uuid
          returning jsonb_build_object('sqlstate','00000','rows',1)$$,
        v_fixture.variant_id,v_fixture.user_id,v_fixture.title_id,
        v_fixture.source_id,'owner-race-' || v_fixture.title_id::text,
        v_fixture.generation_id,v_fixture.source_id,v_fixture.user_id
      );
    else
      v_writer_sql := pg_catalog.format(
        $$with proof as materialized (
            select set_config(
              'norva.catalog_delete_proof',
              jsonb_build_object(
                'headRevision',head.head_revision,
                'configRevision',lifecycle.config_revision,
                'sourceVisibilityEpoch',lifecycle.visibility_epoch,
                'userVisibilityEpoch',epoch.visibility_epoch
              )::text,true
            )
            from public.cloud_source_catalog_heads head
            join public.cloud_source_lifecycle lifecycle
              on lifecycle.source_id=head.source_id and lifecycle.user_id=head.user_id
            join public.cloud_user_catalog_visibility_epochs epoch
              on epoch.user_id=head.user_id
            where head.source_id=%L::uuid and head.user_id=%L::uuid
          ), deleted as (
            delete from public.cloud_title_variants variant
            using proof
            where variant.id=%L::uuid and variant.user_id=%L::uuid
            returning variant.id
          ) select jsonb_build_object('sqlstate','00000','rows',count(*)) from deleted$$,
        v_fixture.source_id,v_fixture.user_id,v_fixture.variant_id,v_fixture.user_id
      );
    end if;

    if v_fixture.ordering = 'writer_first' then
      -- Complete the production payload/membership statement but leave its
      -- transaction uncommitted.  Its sync trigger has already observed that
      -- no source-map exists and still owns the epoch.  The later begin call
      -- must visibly wait, closing the historical pre-map lost-update window.
      perform dblink_exec('norva_owner_writer','begin');
      select remote.payload into strict v_writer_result
      from dblink('norva_owner_writer',v_writer_sql)
        as remote(payload jsonb);

      perform dblink_exec('norva_owner_builder','begin');
      perform dblink_exec(
        'norva_owner_builder',$sql$
          create function public.norva_test_owner_begin_build(
            p_user_id uuid,p_expected_epoch bigint
          ) returns jsonb language plpgsql set search_path = '' as $body$
          declare
            v_begin jsonb;
            v_build jsonb;
            v_detail text;
          begin
            perform set_config('request.jwt.claim.role','service_role',true);
            begin
              v_begin := public.norva_begin_catalog_background_owner_snapshot(
                p_user_id,null,'baseline',null,null,null,p_expected_epoch
              );
              v_build := public.norva_build_catalog_background_owner_snapshot_slice(
                (v_begin->>'snapshotId')::uuid,p_user_id,
                (v_begin->>'revision')::bigint,
                (v_begin->>'visibilityEpoch')::bigint,100
              );
              return jsonb_build_object(
                'sqlstate','00000','begin',v_begin,'build',v_build
              );
            exception when others then
              get stacked diagnostics v_detail = pg_exception_detail;
              return jsonb_build_object(
                'sqlstate',sqlstate,'detail',coalesce(v_detail,'')
              );
            end;
          end
          $body$
        $sql$
      );
      perform dblink_send_query(
        'norva_owner_builder',pg_catalog.format(
          'select public.norva_test_owner_begin_build(%L::uuid,%s)',
          v_fixture.user_id,v_fixture.initial_visibility_epoch
        )
      );
      v_waited := 0;
      while v_waited < 300 and not exists (
        select 1 from pg_catalog.pg_stat_activity activity
        where activity.pid = v_builder_pid
          and activity.wait_event_type = 'Lock'
      ) loop
        perform pg_catalog.pg_sleep(0.01); v_waited := v_waited + 1;
      end loop;
      if v_waited >= 300
         or dblink_is_busy('norva_owner_builder') <> 1 then
        raise exception 'begin/build did not serialize behind writer: %',
          v_fixture.scenario;
      end if;
      perform dblink_exec('norva_owner_writer','commit');

      select remote.payload into strict v_builder_result
      from dblink_get_result('norva_owner_builder')
        as remote(payload jsonb);
      perform count(*) from dblink_get_result('norva_owner_builder')
        as remote(payload jsonb);
      v_first_sqlstate := v_builder_result->>'sqlstate';
      perform dblink_exec(
        'norva_owner_builder','drop function public.norva_test_owner_begin_build(uuid,bigint)'
      );
      perform dblink_exec('norva_owner_builder','commit');

      if v_first_sqlstate = '40001' then
        v_retried := true;
        select epoch.visibility_epoch into strict v_current_epoch
        from public.cloud_user_catalog_visibility_epochs epoch
        where epoch.user_id = v_fixture.user_id;
        perform dblink_exec('norva_owner_builder','begin');
        perform dblink_exec(
          'norva_owner_builder',$sql$
            create function public.norva_test_owner_begin_build(
              p_user_id uuid,p_expected_epoch bigint
            ) returns jsonb language plpgsql set search_path = '' as $body$
            declare v_begin jsonb; v_build jsonb; v_detail text;
            begin
              perform set_config('request.jwt.claim.role','service_role',true);
              begin
                v_begin := public.norva_begin_catalog_background_owner_snapshot(
                  p_user_id,null,'baseline',null,null,null,p_expected_epoch
                );
                v_build := public.norva_build_catalog_background_owner_snapshot_slice(
                  (v_begin->>'snapshotId')::uuid,p_user_id,
                  (v_begin->>'revision')::bigint,
                  (v_begin->>'visibilityEpoch')::bigint,100
                );
                return jsonb_build_object(
                  'sqlstate','00000','begin',v_begin,'build',v_build
                );
              exception when others then
                get stacked diagnostics v_detail = pg_exception_detail;
                return jsonb_build_object(
                  'sqlstate',sqlstate,'detail',coalesce(v_detail,'')
                );
              end;
            end
            $body$
          $sql$
        );
        select remote.payload into strict v_builder_result
        from dblink(
          'norva_owner_builder',pg_catalog.format(
            'select public.norva_test_owner_begin_build(%L::uuid,%s)',
            v_fixture.user_id,v_current_epoch
          )
        ) as remote(payload jsonb);
        perform dblink_exec(
          'norva_owner_builder','drop function public.norva_test_owner_begin_build(uuid,bigint)'
        );
        perform dblink_exec('norva_owner_builder','commit');
      end if;
      if v_builder_result->>'sqlstate' <> '00000'
         or not (v_builder_result#>>'{build,complete}')::boolean
         or v_builder_result#>>'{build,state}' <> 'ready' then
        raise exception 'serialized begin/build failed for %: %',
          v_fixture.scenario,v_builder_result;
      end if;
      v_snapshot_id := (v_builder_result#>>'{begin,snapshotId}')::uuid;
      v_snapshot_revision := (v_builder_result#>>'{build,revision}')::bigint;
      v_snapshot_epoch :=
        (v_builder_result#>>'{begin,visibilityEpoch}')::bigint;

      -- Publish in the next remote transaction, matching the workflow RPC.
      perform dblink_exec('norva_owner_builder','begin');
      perform dblink_exec(
        'norva_owner_builder',
        'set local "request.jwt.claim.role" = ''service_role'''
      );
      select remote.payload into strict v_activate_result
      from dblink(
        'norva_owner_builder',pg_catalog.format(
          'select public.norva_activate_catalog_background_owner_baseline(%L::uuid,%L::uuid,%s,%s)',
          v_snapshot_id,v_fixture.user_id,
          v_snapshot_revision,v_snapshot_epoch
        )
      ) as remote(payload jsonb);
      perform dblink_exec('norva_owner_builder','commit');
    else
      -- READY publication returns inside an explicit transaction but remains
      -- uncommitted, retaining pointer+epoch+snapshot locks.  This is a real
      -- overlap without test DDL on the pointer table: the writer statement
      -- starts, mutates its catalog tuple and waits in the production sync
      -- path until publication commits.
      perform dblink_exec('norva_owner_builder','begin');
      perform dblink_exec(
        'norva_owner_builder',
        'set local "request.jwt.claim.role" = ''service_role'''
      );
      select remote.payload into strict v_activate_result
      from dblink(
        'norva_owner_builder',pg_catalog.format(
          'select public.norva_activate_catalog_background_owner_baseline(%L::uuid,%L::uuid,%s,%s)',
          v_snapshot_id,v_fixture.user_id,
          v_snapshot_revision,v_snapshot_epoch
        )
      ) as remote(payload jsonb);
      perform dblink_exec('norva_owner_writer','begin');
      perform dblink_send_query('norva_owner_writer',v_writer_sql);
      v_waited := 0;
      while v_waited < 300 and not exists (
        select 1 from pg_catalog.pg_stat_activity activity
        where activity.pid = v_writer_pid
          and activity.wait_event_type = 'Lock'
      ) loop
        perform pg_catalog.pg_sleep(0.01); v_waited := v_waited + 1;
      end loop;
      if v_waited >= 300
         or dblink_is_busy('norva_owner_writer') <> 1 then
        raise exception 'writer did not serialize behind activation: %',
          v_fixture.scenario;
      end if;
      perform dblink_exec('norva_owner_builder','commit');
      select remote.payload into strict v_writer_result
      from dblink_get_result('norva_owner_writer')
        as remote(payload jsonb);
      perform count(*) from dblink_get_result('norva_owner_writer')
        as remote(payload jsonb);
      perform dblink_exec('norva_owner_writer','commit');
      v_first_sqlstate := '00000';
    end if;

    if v_writer_result->>'sqlstate' <> '00000'
       or (v_writer_result->>'rows')::integer <> 1
       or v_activate_result->>'state' <> 'active'
       or (v_activate_result->>'snapshotId')::uuid <> v_snapshot_id then
      raise exception 'owner race operation/publication failed for %: writer %, activation %',
        v_fixture.scenario,v_writer_result,v_activate_result;
    end if;
    select epoch.visibility_epoch into strict v_current_epoch
    from public.cloud_user_catalog_visibility_epochs epoch
    where epoch.user_id = v_fixture.user_id;
    v_page := public.norva_select_catalog_title_background_page_v4(
      'search_pending',10,clock_timestamp(),null,v_fixture.user_id
    );
    select coalesce(owner_row.is_present,false),owner_row.title
      into v_present,v_owner_title
    from public.cloud_catalog_background_owner_snapshot_rows owner_row
    where owner_row.snapshot_id = v_snapshot_id
      and owner_row.title_id = v_fixture.title_id;
    if not found then
      v_present := false; v_owner_title := null;
    end if;
    if v_fixture.operation in ('insert','update') then
      if not v_present
         or v_owner_title is distinct from v_fixture.expected_title
         or (v_page->>'returnedTitles')::integer <> 1
         or v_page#>>'{items,0,id}' <> v_fixture.title_id::text then
        raise exception 'owner race lost present payload for %: page %, title %, present %',
          v_fixture.scenario,v_page,v_owner_title,v_present;
      end if;
    else
      if v_present or (v_page->>'returnedTitles')::integer <> 0 then
        raise exception 'owner race resurrected deleted membership for %: page %, present %',
          v_fixture.scenario,v_page,v_present;
      end if;
    end if;
    if not exists (
      select 1
      from public.cloud_catalog_background_owner_pointers pointer
      join public.cloud_catalog_background_owner_snapshots snapshot
        on snapshot.id = pointer.active_snapshot_id
      join public.cloud_catalog_background_owner_topology_revisions topology
        on topology.user_id = pointer.user_id
      where pointer.user_id = v_fixture.user_id
        and pointer.active_snapshot_id = v_snapshot_id
        and snapshot.state = 'active'
        and snapshot.topology_revision = topology.revision
    ) then
      raise exception 'owner race left a non-current pointer for %',
        v_fixture.scenario;
    end if;
    insert into catalog_background_owner_snapshot_race_results(
      scenario,operation,ordering,first_build_sqlstate,retried,
      writer_wait_observed,builder_wait_observed,
      active_snapshot_id,final_visibility_epoch,returned_titles,
      owner_present,owner_title
    ) values (
      v_fixture.scenario,v_fixture.operation,v_fixture.ordering,
      v_first_sqlstate,v_retried,
      v_fixture.ordering = 'activation_first',
      v_fixture.ordering = 'writer_first',
      v_snapshot_id,v_current_epoch,
      (v_page->>'returnedTitles')::integer,v_present,v_owner_title
    );
  end loop;
  perform dblink_disconnect('norva_owner_writer');
  perform dblink_disconnect('norva_owner_builder');
exception when others then
  foreach v_connection in array coalesce(
    dblink_get_connections(),array[]::text[]
  ) loop
    if v_connection in ('norva_owner_writer','norva_owner_builder') then
      begin
        if dblink_is_busy(v_connection) = 1 then
          perform dblink_cancel_query(v_connection);
        end if;
      exception when others then null;
      end;
      begin perform dblink_exec(v_connection,'rollback');
      exception when others then null;
      end;
      begin perform dblink_disconnect(v_connection);
      exception when others then null;
      end;
    end if;
  end loop;
  raise;
end
$snapshot_races$;

do $matrix_assert$
begin
  if (select count(*) from catalog_background_owner_snapshot_race_results) <> 6
     or exists (
       select 1 from catalog_background_owner_snapshot_race_results result
       where result.first_build_sqlstate not in ('00000','40001')
          or (result.ordering = 'writer_first'
            and not result.builder_wait_observed)
          or (result.ordering = 'activation_first'
            and not result.writer_wait_observed)
          or (result.operation in ('insert','update') and (
            not result.owner_present or result.returned_titles <> 1
          ))
          or (result.operation = 'delete' and (
            result.owner_present or result.returned_titles <> 0
          ))
     ) then
    raise exception 'owner snapshot I/U/D concurrency matrix is incomplete';
  end if;
end
$matrix_assert$;

-- Normal cleanup uses the same bounded provider-subgraph preparation as the
-- account-delete concurrency fixture.  No owner snapshot row is removed by a
-- test-only bypass.
begin;
set local statement_timeout = '2min';
set local lock_timeout = '2s';
set local "request.jwt.claim.role" = 'service_role';
do $cleanup$
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
  for v_user in
    select fixture.user_id
    from catalog_background_owner_snapshot_race_fixtures fixture
    order by fixture.scenario
  loop
    v_begin := public.norva_begin_provider_account_deletion_prepare(v_user);
    v_stop := public.norva_claim_provider_transport_stop_action(
      v_user,'owner-snapshot-race-cleanup',60
    );
    v_stop := public.norva_settle_provider_transport_stop_action(
      v_user,'owner-snapshot-race-cleanup',
      (v_stop->>'leaseSequence')::integer,(v_stop->>'revision')::bigint,
      'completed',repeat('e',64),null,0
    );
    v_claim := public.norva_claim_provider_account_deletion_prepare(
      v_user,'owner-snapshot-race-cleanup',120
    );
    v_loops := 0;
    loop
      v_loops := v_loops + 1;
      if v_loops > 96 then
        raise exception 'owner snapshot race cleanup did not converge for %',
          v_user;
      end if;
      v_run := public.norva_run_provider_account_deletion_prepare_batch(
        v_user,'owner-snapshot-race-cleanup',
        (v_claim->>'leaseSequence')::integer,
        (v_claim->>'revision')::bigint,100
      );
      exit when (v_run->>'ready')::boolean;
      if (v_run->>'waitingForDrain')::boolean then
        raise exception 'owner snapshot race cleanup remained in drain for %',
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
    delete from auth.users where id=v_user;
    perform public.norva_complete_account_deletion_finalization(v_final_key);
    delete from public.cloud_account_deletion_finalizations
    where finalization_key=v_final_key;
  end loop;
end
$cleanup$;

do $cleanup_assert$
begin
  if exists (
       select 1 from auth.users account
       join catalog_background_owner_snapshot_race_fixtures fixture
         on fixture.user_id = account.id
     ) or exists (
       select 1 from public.cloud_catalog_background_owner_snapshots snapshot
       join catalog_background_owner_snapshot_race_fixtures fixture
         on fixture.user_id = snapshot.user_id
     ) then
    raise exception 'owner snapshot concurrency fixture cleanup drifted';
  end if;
end
$cleanup_assert$;
commit;

table catalog_background_owner_snapshot_race_results order by scenario;

do $connection_assert$
begin
  if exists (
    select 1
    from unnest(coalesce(
      dblink_get_connections(),array[]::text[]
    )) connection_name
    where connection_name like 'norva_owner_%'
  ) then
    raise exception 'owner snapshot smoke leaked a dblink connection';
  end if;
  if exists (
    select 1 from pg_catalog.pg_proc procedure_state
    join pg_catalog.pg_namespace namespace_state
      on namespace_state.oid = procedure_state.pronamespace
    where namespace_state.nspname = 'public'
      and procedure_state.proname like 'norva_test_owner_%'
  ) or exists (
    select 1 from pg_catalog.pg_trigger trigger_state
    where not trigger_state.tgisinternal
      and trigger_state.tgname like '%test_owner_%'
  ) then
    raise exception 'owner snapshot smoke left a test helper behind';
  end if;
end
$connection_assert$;

reset statement_timeout;
reset lock_timeout;
