\set ON_ERROR_STOP on

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '98900000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  'auto-refresh-fair-989@invalid.test', '', now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
);

set role service_role;
insert into public.cloud_sources (
  id, user_id, source_type, display_name, config_ciphertext, config_hint,
  sync_status, catalog_version, auto_refresh_next_at, auto_refresh_state
) values
  (
    '98900000-0000-4000-8000-000000000101',
    '98900000-0000-4000-8000-000000000001', 'xtream', 'Legacy locked',
    'cipher-legacy', '{"serverHost":"legacy-989.invalid"}'::jsonb,
    'ready', 1, now() - interval '5 hours', jsonb_build_object('lockedAt', now())
  ),
  (
    '98900000-0000-4000-8000-000000000102',
    '98900000-0000-4000-8000-000000000001', 'xtream', 'Not entitled',
    'cipher-not-entitled', '{"serverHost":"not-entitled-989.invalid"}'::jsonb,
    'ready', 1, now() + interval '1 day', '{}'::jsonb
  ),
  (
    '98900000-0000-4000-8000-000000000103',
    '98900000-0000-4000-8000-000000000001', 'xtream', 'Action required',
    'cipher-action', '{"serverHost":"action-989.invalid"}'::jsonb,
    'ready', 1, now() + interval '1 day', '{}'::jsonb
  ),
  (
    '98900000-0000-4000-8000-000000000104',
    '98900000-0000-4000-8000-000000000001', 'xtream', 'Concurrent claim',
    'cipher-concurrent', '{"serverHost":"concurrent-989.invalid"}'::jsonb,
    'ready', 1, now() - interval '6 hours', '{}'::jsonb
  );
reset role;

begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
do $dblink_schema$
begin
  if exists (
    select 1
    from pg_extension extension
    join pg_namespace namespace on namespace.oid = extension.extnamespace
    where extension.extname = 'dblink'
      and namespace.nspname <> 'extensions'
  ) then
    execute 'alter extension dblink set schema extensions';
  end if;
end
$dblink_schema$;
grant usage on schema extensions to authenticated, service_role;
select extensions.plan(28);

-- Exercise the scheduler guards independently from RLS. This helper exists
-- only inside the rolled-back test transaction. Its definer may reach the row,
-- while the trigger still sees the caller's authenticated JWT and must refuse
-- server-owned scheduler fields.
create function public.norva_test_auto_refresh_owner_write(p_action text)
returns integer
language plpgsql
security definer
set search_path = ''
as $test_function$
declare v_updated integer;
begin
  if p_action = 'lease' then
    update public.cloud_sources
    set auto_refresh_lease_sequence = 999
    where id = '98900000-0000-4000-8000-000000000104';
  elsif p_action = 'ready' then
    update public.cloud_sources
    set sync_status = 'ready'
    where id = '98900000-0000-4000-8000-000000000103';
  else
    raise exception 'invalid test action';
  end if;
  get diagnostics v_updated = row_count;
  return v_updated;
end
$test_function$;
revoke all on function public.norva_test_auto_refresh_owner_write(text)
  from public, anon, service_role;
grant execute on function public.norva_test_auto_refresh_owner_write(text)
  to authenticated;

create temporary table auto_refresh_989_claims (
  worker text not null,
  source_id uuid,
  user_id uuid,
  source_type text,
  lease_sequence bigint,
  auto_refresh_state jsonb
) on commit drop;
grant all on auto_refresh_989_claims to service_role;

select extensions.ok(
  not has_function_privilege(
    'authenticated',
    'public.norva_claim_cloud_auto_refresh_sources(text,integer,integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.norva_settle_cloud_auto_refresh_source(uuid,uuid,text,bigint,text,timestamptz,integer,text)',
    'EXECUTE'
  ),
  'claim and settlement authority are not exposed to authenticated users'
);

-- Two real PostgreSQL sessions race for the only claimable row. The fresh
-- legacy JSON lock is deliberately older in sort order but remains fenced.
select extensions.dblink_connect('auto_refresh_989_a', format('dbname=%I user=%I', current_database(), current_user));
select extensions.dblink_connect('auto_refresh_989_b', format('dbname=%I user=%I', current_database(), current_user));
select extensions.dblink_exec('auto_refresh_989_a', 'set role service_role');
select extensions.dblink_exec('auto_refresh_989_b', 'set role service_role');
select extensions.is(
  extensions.dblink_send_query(
    'auto_refresh_989_a',
    $$select * from public.norva_claim_cloud_auto_refresh_sources('auto-refresh-989-a',1,720)$$
  ),
  1,
  'first PostgreSQL session starts the auto-refresh claim race'
);
select extensions.is(
  extensions.dblink_send_query(
    'auto_refresh_989_b',
    $$select * from public.norva_claim_cloud_auto_refresh_sources('auto-refresh-989-b',1,720)$$
  ),
  1,
  'second PostgreSQL session starts the auto-refresh claim race'
);
insert into auto_refresh_989_claims
select 'auto-refresh-989-a', result.*
from extensions.dblink_get_result('auto_refresh_989_a') as result(
  source_id uuid, user_id uuid, source_type text, lease_sequence bigint, auto_refresh_state jsonb
);
insert into auto_refresh_989_claims
select 'auto-refresh-989-b', result.*
from extensions.dblink_get_result('auto_refresh_989_b') as result(
  source_id uuid, user_id uuid, source_type text, lease_sequence bigint, auto_refresh_state jsonb
);
select extensions.dblink_disconnect('auto_refresh_989_a');
select extensions.dblink_disconnect('auto_refresh_989_b');

select extensions.is(
  (select count(*)::integer from auto_refresh_989_claims),
  1,
  'exactly one session wins when only one source is claimable'
);
select extensions.is(
  (select source_id from auto_refresh_989_claims),
  '98900000-0000-4000-8000-000000000104'::uuid,
  'the fresh legacy lock is skipped and the next due source wins'
);
select extensions.is(
  (select lease_sequence from auto_refresh_989_claims),
  1::bigint,
  'the first durable claim starts lease sequence one'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '98900000-0000-4000-8000-000000000001',
    'role', 'authenticated'
  )::text,
  true
);
create temporary table auto_refresh_989_auth_result (
  sqlstate text,
  message text
) on commit drop;
grant insert, select on auto_refresh_989_auth_result to authenticated;
set session authorization authenticator;
set local role authenticated;
do $owner_tamper$
begin
  begin
    perform public.norva_test_auto_refresh_owner_write('lease');
    insert into auto_refresh_989_auth_result values (null, null);
  exception when others then
    insert into auto_refresh_989_auth_result values (sqlstate, sqlerrm);
  end;
end
$owner_tamper$;
reset role;
reset session authorization;
select set_config('request.jwt.claims', '{}'::text, true);
select extensions.ok(
  (select sqlstate = '42501'
     and message = 'cloud auto refresh scheduler state is server managed'
   from auto_refresh_989_auth_result),
  'a source owner cannot forge the scheduler lease generation'
);

set local role service_role;
select extensions.is(
  public.norva_settle_cloud_auto_refresh_source(
    '98900000-0000-4000-8000-000000000104',
    '98900000-0000-4000-8000-000000000001',
    (select worker from auto_refresh_989_claims),
    1, 'success', now(), null, null
  ) ->> 'outcome',
  'success',
  'the winning concurrent worker settles through its exact lease'
);
reset role;

-- Make two more sources due. The first is settled non-entitled and the very
-- next claim must advance to the second source during the same bounded scan.
set local role service_role;
update public.cloud_sources
set auto_refresh_next_at = case id
  when '98900000-0000-4000-8000-000000000102'::uuid then now() - interval '4 hours'
  else now() - interval '3 hours'
end
where id in (
  '98900000-0000-4000-8000-000000000102',
  '98900000-0000-4000-8000-000000000103'
);
truncate auto_refresh_989_claims;
insert into auto_refresh_989_claims
select 'auto-refresh-989-local', result.*
from public.norva_claim_cloud_auto_refresh_sources('auto-refresh-989-local',1,720) result;
select extensions.is(
  (select source_id from auto_refresh_989_claims),
  '98900000-0000-4000-8000-000000000102'::uuid,
  'oldest claimable source is selected deterministically'
);
select extensions.is(
  public.norva_settle_cloud_auto_refresh_source(
    '98900000-0000-4000-8000-000000000102',
    '98900000-0000-4000-8000-000000000001',
    'auto-refresh-989-local', 1, 'not_entitled', now(), null, null
  ) ->> 'outcome',
  'not_entitled',
  'non-entitled source is durably rescheduled without consuming future ticks'
);
truncate auto_refresh_989_claims;
insert into auto_refresh_989_claims
select 'auto-refresh-989-local', result.*
from public.norva_claim_cloud_auto_refresh_sources('auto-refresh-989-local',1,720) result;
select extensions.is(
  (select source_id from auto_refresh_989_claims),
  '98900000-0000-4000-8000-000000000103'::uuid,
  'claim advances fairly to the next due source'
);

select extensions.is(
  public.norva_settle_cloud_auto_refresh_source(
    '98900000-0000-4000-8000-000000000103',
    '98900000-0000-4000-8000-000000000001',
    'auto-refresh-989-local', 1, 'action_required', now(), 404, 'not_found'
  ) ->> 'terminalFailureCount',
  '1',
  'first 404 records one action-required observation'
);
select extensions.ok(
  (select (auto_refresh_state ->> 'actionRequired')::boolean
   from public.cloud_sources where id = '98900000-0000-4000-8000-000000000103'),
  'first 404 is immediately visible as a user-action state'
);
select extensions.ok(
  not (select (auto_refresh_state ->> 'suspended')::boolean
       from public.cloud_sources where id = '98900000-0000-4000-8000-000000000103'),
  'first 404 leaves one delayed confirmation probe'
);
reset role;
update public.cloud_sources
set sync_status = 'error'
where id = '98900000-0000-4000-8000-000000000103';
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '98900000-0000-4000-8000-000000000001',
    'role', 'authenticated'
  )::text,
  true
);
set session authorization authenticator;
set local role authenticated;
select public.norva_test_auto_refresh_owner_write('ready');
reset role;
reset session authorization;
select set_config('request.jwt.claims', '{}'::text, true);
select extensions.ok(
  (select (auto_refresh_state ->> 'actionRequired')::boolean
   from public.cloud_sources where id = '98900000-0000-4000-8000-000000000103'),
  'a client-forged ready status cannot erase server action-required evidence'
);
set local role service_role;
select extensions.ok(
  public.norva_source_catalog_visible(
    '98900000-0000-4000-8000-000000000103',
    '98900000-0000-4000-8000-000000000001'
  ),
  'a 404 observation alone does not hide an existing catalogue'
);
select extensions.is(
  (select provider_access_status from public.cloud_source_provider_access
   where source_id = '98900000-0000-4000-8000-000000000103'),
  'unknown',
  'scheduler evidence does not assert Provider Access expiry'
);

reset role;
set local role service_role;
update public.cloud_sources
set auto_refresh_next_at = now() - interval '1 second'
where id = '98900000-0000-4000-8000-000000000103';
truncate auto_refresh_989_claims;
insert into auto_refresh_989_claims
select 'auto-refresh-989-second', result.*
from public.norva_claim_cloud_auto_refresh_sources('auto-refresh-989-second',1,720) result;
select extensions.is(
  (select lease_sequence from auto_refresh_989_claims),
  2::bigint,
  'the delayed confirmation probe advances the lease sequence'
);
select extensions.is(
  public.norva_settle_cloud_auto_refresh_source(
    '98900000-0000-4000-8000-000000000103',
    '98900000-0000-4000-8000-000000000001',
    'auto-refresh-989-second', 2, 'action_required', now(), 404, 'not_found'
  ) ->> 'terminalFailureCount',
  '2',
  'second matching 404 reaches the bounded suspension threshold'
);
select extensions.ok(
  (select (auto_refresh_state ->> 'suspended')::boolean
   from public.cloud_sources where id = '98900000-0000-4000-8000-000000000103'),
  'repeated terminal evidence suspends automatic provider pressure'
);
select extensions.is(
  (select count(*)::integer
   from public.norva_claim_cloud_auto_refresh_sources('auto-refresh-989-empty',1,720)),
  0,
  'suspended, future and freshly legacy-locked sources are all skipped'
);

reset role;
set local role service_role;
update public.cloud_sources
set sync_status = 'error'
where id = '98900000-0000-4000-8000-000000000103';
update public.cloud_sources
set sync_status = 'ready'
where id = '98900000-0000-4000-8000-000000000103';
select extensions.ok(
  (select auto_refresh_state ->> 'actionRequired' is null
     and auto_refresh_state ->> 'suspended' is null
     and auto_refresh_lease_sequence = 3
   from public.cloud_sources where id = '98900000-0000-4000-8000-000000000103'),
  'successful foreground recovery clears action state and invalidates every old lease'
);

select extensions.throws_ok(
  $$select public.norva_settle_cloud_auto_refresh_source(
    '98900000-0000-4000-8000-000000000103',
    '98900000-0000-4000-8000-000000000001',
    'auto-refresh-989-second', 2, 'success', now(), null, null
  )$$,
  '40001',
  'cloud auto refresh lease is stale',
  'worker from before foreground recovery cannot commit'
);
update public.cloud_sources
set auto_refresh_next_at = now() - interval '1 second'
where id = '98900000-0000-4000-8000-000000000103';
truncate auto_refresh_989_claims;
insert into auto_refresh_989_claims
select 'auto-refresh-989-recovered', result.*
from public.norva_claim_cloud_auto_refresh_sources('auto-refresh-989-recovered',1,720) result;
select extensions.is(
  (select lease_sequence from auto_refresh_989_claims),
  4::bigint,
  'recovered configuration receives a fresh monotone lease'
);
select extensions.is(
  public.norva_settle_cloud_auto_refresh_source(
    '98900000-0000-4000-8000-000000000103',
    '98900000-0000-4000-8000-000000000001',
    'auto-refresh-989-recovered', 4, 'success', now(), null, null
  ) ->> 'actionRequired',
  'false',
  'successful recovery converges to a clean non-action state'
);
select extensions.ok(
  (select auto_refresh_lease_owner is null and auto_refresh_lease_expires_at is null
   from public.cloud_sources where id = '98900000-0000-4000-8000-000000000103'),
  'terminal settlement releases the durable lease shape'
);
select extensions.ok(
  (select auto_refresh_next_at > now() + interval '5 hours 59 minutes'
   from public.cloud_sources where id = '98900000-0000-4000-8000-000000000103'),
  'successful recovery schedules the next six-hour cadence'
);
select extensions.throws_ok(
  $$select public.norva_settle_cloud_auto_refresh_source(
    '98900000-0000-4000-8000-000000000999',
    '98900000-0000-4000-8000-000000000001',
    'auto-refresh-989-missing', 1, 'success', now(), null, null
  )$$,
  '40001',
  'cloud auto refresh lease is stale',
  'a deleted or unknown source is reported as a stale lease without repair'
);

select * from extensions.finish();
rollback;
