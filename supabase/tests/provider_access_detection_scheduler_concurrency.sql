\set ON_ERROR_STOP on

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '98600000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  'provider-access-scheduler-986@invalid.test', '', now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
);
insert into public.cloud_sources (
  id, user_id, source_type, display_name, config_ciphertext, config_hint,
  sync_status, catalog_version
) values (
  '98600000-0000-4000-8000-000000000101',
  '98600000-0000-4000-8000-000000000001', 'xtream', 'Scheduler 986',
  'fixture-ciphertext', '{"serverHost":"scheduler-986.invalid"}'::jsonb,
  'ready', 1
);
update public.cloud_provider_access_foundation_rollout
set phase='complete', completed_at=coalesce(completed_at,now()), updated_at=now() where singleton;
update public.cloud_source_provider_account_affinity_rollout
set phase='complete', completed_at=coalesce(completed_at,now()), updated_at=now() where singleton;
alter table public.provider_account_activity validate constraint provider_account_activity_opaque_key_ck;
update public.cloud_catalog_cache_epoch_v2_rollout
set installed_at=installed_at-interval '8 days'
where singleton and phase='installed';
set role service_role;
select public.norva_complete_catalog_cache_epoch_v2_rollout(
  'catalog-cache-epoch-v2',
  '23c0fa2cdaf09c08d9de4378d1a82f0f631ce71d6f955a0bdbb2c786b8ff98d3'
);
reset role;
update public.admin_feature_flags set enabled=true
where key in ('provider_access_v1_enabled','provider_access_auto_detection_v1_enabled','provider_access_visibility_v1_enabled');
update public.cloud_source_provider_access
set provider_access_last_checked_at=now()
where source_id<>'98600000-0000-4000-8000-000000000101';
set role service_role;
select public.norva_schedule_provider_access_checks(100, '2026-08-24T13:00:00Z');
reset role;

begin;
set local lock_timeout='3s';
set local statement_timeout='30s';
create extension if not exists pgtap with schema extensions;
select extensions.plan(22);
create temporary table scheduler_986_claims(
  worker text not null,
  job_id uuid,
  user_id uuid,
  source_id uuid,
  expected_access_revision bigint,
  lease_sequence bigint,
  attempt_count integer
) on commit drop;
grant all on scheduler_986_claims to service_role;

set local role service_role;
select extensions.is(
  (select count(*)::integer from public.cloud_provider_access_check_jobs
   where source_id='98600000-0000-4000-8000-000000000101' and state='queued'),
  1,
  'due scheduler creates one durable Provider Access job'
);
select extensions.is(
  public.norva_schedule_provider_access_checks(100, '2026-08-24T13:00:00Z')->>'scheduled',
  '0',
  'scheduler replay cannot create a second open job for the source'
);
reset role;

select public.dblink_connect('provider_access_claim_a',format('dbname=%I user=%I',current_database(),current_user));
select public.dblink_connect('provider_access_claim_b',format('dbname=%I user=%I',current_database(),current_user));
select public.dblink_exec('provider_access_claim_a','set role service_role');
select public.dblink_exec('provider_access_claim_b','set role service_role');
select extensions.is(
  public.dblink_send_query('provider_access_claim_a',
    $$select * from public.norva_claim_provider_access_check_jobs('scheduler-986-a',1,180)$$),
  1,
  'first PostgreSQL session starts the claim race'
);
select extensions.is(
  public.dblink_send_query('provider_access_claim_b',
    $$select * from public.norva_claim_provider_access_check_jobs('scheduler-986-b',1,180)$$),
  1,
  'second PostgreSQL session starts the claim race'
);
insert into scheduler_986_claims
select 'scheduler-986-a', result.*
from public.dblink_get_result('provider_access_claim_a') as result(
  job_id uuid,user_id uuid,source_id uuid,expected_access_revision bigint,lease_sequence bigint,attempt_count integer
);
insert into scheduler_986_claims
select 'scheduler-986-b', result.*
from public.dblink_get_result('provider_access_claim_b') as result(
  job_id uuid,user_id uuid,source_id uuid,expected_access_revision bigint,lease_sequence bigint,attempt_count integer
);
select public.dblink_disconnect('provider_access_claim_a');
select public.dblink_disconnect('provider_access_claim_b');
select extensions.is(
  (select count(*)::integer from scheduler_986_claims),
  1,
  'exactly one real PostgreSQL session wins the durable claim'
);
select extensions.is(
  (select count(*)::integer from public.cloud_provider_access_check_jobs where state='leased'),
  1,
  'claim race leaves one and only one leased job'
);

-- Crash after provider I/O but before the apply RPC: the lease expires and a
-- new worker receives a strictly newer lease sequence.
reset role;
update public.cloud_provider_access_check_jobs
set lease_expires_at=now()-interval '1 second'
where id=(select job_id from scheduler_986_claims);
set local role service_role;
insert into scheduler_986_claims
select 'scheduler-986-reclaimer', result.*
from public.norva_claim_provider_access_check_jobs('scheduler-986-reclaimer',1,180) result;
select extensions.is(
  (select max(lease_sequence)::bigint from scheduler_986_claims),
  2::bigint,
  'reclaim after crash advances the monotone lease sequence'
);
select extensions.throws_ok(
  format($sql$select public.norva_apply_claimed_provider_access_detection(
    %L,%L,%s,%L::jsonb,now(),null
  )$sql$,
    (select job_id from scheduler_986_claims where worker in ('scheduler-986-a','scheduler-986-b')),
    (select worker from scheduler_986_claims where worker in ('scheduler-986-a','scheduler-986-b')),
    1,
    '{"detectionVersion":1,"status":"active","reasonCode":"PROVIDER_CONFIRMED_ACTIVE","expiresOn":"2026-12-31","hideEligible":false,"restorationConfirmed":true,"contradictions":[]}'
  ),
  'PT409',
  'Provider Access check lease is stale',
  'worker that wakes after reclaim cannot commit its stale observation'
);
select extensions.is(
  public.norva_apply_claimed_provider_access_detection(
    (select job_id from scheduler_986_claims where worker='scheduler-986-reclaimer'),
    'scheduler-986-reclaimer',2,
    '{"detectionVersion":1,"status":"active","reasonCode":"PROVIDER_CONFIRMED_ACTIVE","expiresOn":"2026-12-31","hideEligible":false,"restorationConfirmed":true,"contradictions":[]}'::jsonb,
    now(),null
  )->>'jobState',
  'COMPLETED',
  'reclaimer commits observation and terminal job state atomically'
);
select extensions.is(
  (select provider_access_status from public.cloud_source_provider_access
   where source_id='98600000-0000-4000-8000-000000000101'),
  'active',
  'winning claimed observation updates the Provider Access snapshot'
);
select extensions.is(
  (select count(*)::integer from public.cloud_provider_access_check_jobs where state='completed'),
  1,
  'successful detection leaves one explicit terminal job'
);

-- A later daily job records a temporary failure and becomes retryable without
-- hiding the source. The next lease can then converge to ACTIVE.
reset role;
update public.cloud_source_provider_access
set provider_access_last_checked_at='2026-08-23T00:00:00Z'
where source_id='98600000-0000-4000-8000-000000000101';
set local role service_role;
select extensions.is(
  public.norva_schedule_provider_access_checks(100,'2026-08-25T13:00:00Z')->>'scheduled',
  '1',
  'next UTC day can schedule the next due observation'
);
reset role;
update public.cloud_provider_access_check_jobs
set next_attempt_at=now()-interval '1 second'
where source_id='98600000-0000-4000-8000-000000000101' and state='queued';
set local role service_role;
truncate scheduler_986_claims;
insert into scheduler_986_claims
select 'scheduler-986-temp', result.*
from public.norva_claim_provider_access_check_jobs('scheduler-986-temp',1,180) result;
select extensions.is(
  public.norva_apply_claimed_provider_access_detection(
    (select job_id from scheduler_986_claims),'scheduler-986-temp',
    (select lease_sequence from scheduler_986_claims),
    '{"detectionVersion":1,"status":"check_failed_temporary","reasonCode":"PROVIDER_CHECK_TEMPORARY_FAILURE","expiresOn":null,"hideEligible":false,"restorationConfirmed":false,"contradictions":[]}'::jsonb,
    now(),60
  )->>'jobState',
  'RETRY',
  'temporary provider failure durably requeues the same job'
);
select extensions.is(
  (select state from public.cloud_provider_access_check_jobs
   where id=(select job_id from scheduler_986_claims)),
  'retry',
  'retry state has no live lease owner after settlement'
);
select extensions.ok(
  public.norva_source_catalog_visible(
    '98600000-0000-4000-8000-000000000101',
    '98600000-0000-4000-8000-000000000001'
  ),
  'temporary automatic check failure keeps the catalogue visible'
);
reset role;
update public.cloud_provider_access_check_jobs set next_attempt_at=now()-interval '1 second'
where id=(select job_id from scheduler_986_claims);
set local role service_role;
truncate scheduler_986_claims;
insert into scheduler_986_claims
select 'scheduler-986-retry', result.*
from public.norva_claim_provider_access_check_jobs('scheduler-986-retry',1,180) result;
select extensions.is(
  (select lease_sequence from scheduler_986_claims),
  2::bigint,
  'retry claim advances the lease fence again'
);
select extensions.is(
  public.norva_apply_claimed_provider_access_detection(
    (select job_id from scheduler_986_claims),'scheduler-986-retry',
    (select lease_sequence from scheduler_986_claims),
    '{"detectionVersion":1,"status":"active","reasonCode":"PROVIDER_CONFIRMED_ACTIVE","expiresOn":"2026-12-31","hideEligible":false,"restorationConfirmed":true,"contradictions":[]}'::jsonb,
    now(),null
  )->>'jobState',
  'COMPLETED',
  'retry continuation converges to an explicit terminal state'
);
select extensions.is(
  (select count(*)::integer from public.cloud_provider_access_check_jobs where state in ('queued','leased','retry')),
  0,
  'no open detection work remains after convergence'
);
create function pg_temp.provider_access_cron_absent_986() returns boolean
language plpgsql set search_path='' as $function$
declare v_absent boolean;
begin
  if to_regclass('cron.job') is null then return true; end if;
  execute 'select not exists(select 1 from cron.job where jobname=$1)'
    into v_absent using 'norva-provider-access-checks';
  return v_absent;
end
$function$;
select extensions.ok(
  pg_temp.provider_access_cron_absent_986(),
  'migration and proof never install the production cron implicitly'
);
select extensions.is(
  (select count(*)::integer from public.cloud_source_lifecycle_events
   where source_id='98600000-0000-4000-8000-000000000101'
     and payload::text ~* '(user_info|exp_date|active_cons|max_connections|auth)'),
  0,
  'scheduler persists decisions only and no raw Xtream payload'
);
select extensions.ok(
  not has_function_privilege('authenticated',
    'public.norva_claim_provider_access_check_jobs(text,integer,integer)','EXECUTE')
  and not has_function_privilege('authenticated',
    'public.norva_apply_claimed_provider_access_detection(uuid,text,bigint,jsonb,timestamptz,integer)','EXECUTE'),
  'scheduler claim and commit authority remain service-only'
);
select extensions.is(
  (select count(*)::integer from public.cloud_source_access_cycles
   where source_id='98600000-0000-4000-8000-000000000101' and status='active'),
  1,
  'automatic retries preserve one active provider-reported cycle'
);

select * from extensions.finish();
rollback;
