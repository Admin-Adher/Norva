begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select extensions.no_plan();

create function pg_temp.phase3_sqlstate(p_sql text)
returns text
language plpgsql
as $function$
begin
  execute p_sql;
  return '00000';
exception when others then
  return sqlstate;
end
$function$;

select extensions.ok(
  public.norva_catalog_generation_flags_all_off(),
  'all six rollout flags are OFF after expand'
);
select extensions.ok(
  not pg_catalog.has_function_privilege(
    'service_role',
    'public.norva_claim_source_direct_fallback_lease(uuid,uuid,text,integer)',
    'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'service_role',
    'public.norva_claim_source_direct_fallback_lease(uuid,uuid,text,integer,text,bigint,text)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'service_role',
    'public.norva_create_credential_transition(uuid,uuid,text,text,bigint,text,jsonb,text)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'service_role',
    'public.norva_bind_credential_transition_account_affinity(uuid,uuid,text,bigint)',
    'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'service_role',
    'public.norva_create_credential_transition(uuid,uuid,text,text,bigint,text,jsonb,text,text)',
    'EXECUTE'
  ),
  'only snapshot-fenced claim and atomic transition create are service executable'
);
select extensions.ok(
  not pg_catalog.has_table_privilege(
    'service_role', 'public.cloud_source_direct_fallback_leases', 'SELECT'
  )
  and not pg_catalog.has_table_privilege(
    'service_role', 'public.cloud_source_provider_account_affinities', 'SELECT'
  ),
  'lease and opaque affinity ledgers are not exposed through service tables'
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('94000000-0000-4000-8000-000000000001',
   '00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','lease-a@invalid.test','',now(),'{}','{}',now(),now()),
  ('94000000-0000-4000-8000-000000000002',
   '00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','lease-b@invalid.test','',now(),'{}','{}',now(),now());

insert into public.cloud_sources (
  id,user_id,source_type,display_name,config_ciphertext,config_hint,
  sync_status,catalog_version,enabled
) values
  ('94000000-0000-4000-8000-000000000101',
   '94000000-0000-4000-8000-000000000001','xtream','Account A','cipher-a',
   '{"serverHost":"Panel-A.EXAMPLE:8080","username":"alpha"}','ready',1,true),
  ('94000000-0000-4000-8000-000000000102',
   '94000000-0000-4000-8000-000000000001','xtream','Account B','cipher-b',
   '{"serverHost":"panel-b.example","username":"beta"}','ready',1,true),
  ('94000000-0000-4000-8000-000000000103',
   '94000000-0000-4000-8000-000000000001','xtream','Missing affinity','cipher-missing',
   '{}'::jsonb,'ready',1,true),
  ('94000000-0000-4000-8000-000000000104',
   '94000000-0000-4000-8000-000000000001','m3u','Playlist','cipher-m3u',
   '{"playlistHost":"playlist.example"}','ready',1,true),
  ('94000000-0000-4000-8000-000000000201',
   '94000000-0000-4000-8000-000000000002','xtream','Shared account A','cipher-a2',
   '{"serverHost":"panel-a.example:8080","username":"alpha"}','ready',1,true),
  ('94000000-0000-4000-8000-000000000202',
   '94000000-0000-4000-8000-000000000002','xtream','Account D','cipher-d',
   '{"serverHost":"panel-d.example","username":"delta"}','ready',1,true);

select extensions.is(
  (select affinity_hash
   from public.cloud_source_provider_account_affinities
   where source_id = '94000000-0000-4000-8000-000000000101'),
  encode(extensions.digest('panel-a.example:8080/alpha','sha256'),'hex'),
  'future Xtream insert derives the same canonical host-with-port affinity as Edge'
);
select extensions.is(
  (select count(*)::integer
   from public.cloud_source_provider_account_affinities
   where source_id in (
     '94000000-0000-4000-8000-000000000103',
     '94000000-0000-4000-8000-000000000104'
   )),
  0,
  'missing-hint Xtream and M3U inserts never invent an affinity'
);
select extensions.is(
  (select affinity_hash
   from public.cloud_source_provider_account_affinities
   where source_id = '94000000-0000-4000-8000-000000000201'),
  (select affinity_hash
   from public.cloud_source_provider_account_affinities
   where source_id = '94000000-0000-4000-8000-000000000101'),
  'same opaque provider account is stable across users and sources'
);
select extensions.is(
  pg_temp.phase3_sqlstate($sql$
    insert into public.cloud_source_provider_account_affinities(
      source_id,user_id,affinity_hash
    ) values (
      '94000000-0000-4000-8000-000000000103',
      '94000000-0000-4000-8000-000000000002',repeat('e',64)
    )
  $sql$),
  '23503',
  'composite affinity owner FK rejects a cross-tenant source/user pair'
);

create temporary table phase3_lease_ctx (
  key text primary key,
  value jsonb not null
);
grant all on phase3_lease_ctx to service_role;

set local role service_role;
select extensions.is(
  pg_temp.phase3_sqlstate($sql$
    select public.norva_claim_source_direct_fallback_lease(
      '94000000-0000-4000-8000-000000000101',
      '94000000-0000-4000-8000-000000000001','unsafe-old',30)
  $sql$),
  '42501',
  'the four-argument ABA claim cannot be called by service_role'
);
select extensions.is(
  pg_temp.phase3_sqlstate($sql$
    select public.norva_create_credential_transition(
      '94000000-0000-4000-8000-000000000001',
      '94000000-0000-4000-8000-000000000101','old-two-step',repeat('0',64),
      0,'cipher-old-candidate',
      '{"sourceType":"xtream","serverHost":"old.invalid","hasPassword":true}',
      'old-caller')
  $sql$),
  '42501',
  'rolling old eight-argument create fails closed before it can strand a transition'
);
reset role;
select extensions.is(
  (select count(*)::integer from public.cloud_source_transitions
   where idempotency_key='old-two-step'),
  0,
  'rejected old caller leaves zero transition row'
);
set local role service_role;
select extensions.is(
  pg_temp.phase3_sqlstate($sql$
    select public.norva_claim_source_direct_fallback_lease(
      '94000000-0000-4000-8000-000000000103',
      '94000000-0000-4000-8000-000000000001','missing',30,
      repeat('a',64),0,repeat('b',64))
  $sql$),
  '55000',
  'direct fallback fails closed when affinity is missing'
);
select extensions.is(
  pg_temp.phase3_sqlstate(format($sql$
    select public.norva_claim_source_direct_fallback_lease(
      '94000000-0000-4000-8000-000000000101',
      '94000000-0000-4000-8000-000000000001','stale-affinity',30,
      %L,0,%L)
  $sql$, repeat('f',64),
    encode(extensions.digest('cipher-a','sha256'),'hex'))),
  '40001',
  'stale account affinity rejects the claim before provider fetch'
);
select extensions.is(
  pg_temp.phase3_sqlstate(format($sql$
    select public.norva_claim_source_direct_fallback_lease(
      '94000000-0000-4000-8000-000000000101',
      '94000000-0000-4000-8000-000000000001','stale-revision',30,
      %L,99,%L)
  $sql$,
    encode(extensions.digest('panel-a.example:8080/alpha','sha256'),'hex'),
    encode(extensions.digest('cipher-a','sha256'),'hex'))),
  '40001',
  'same-account password ABA is fenced by config revision'
);
select extensions.is(
  pg_temp.phase3_sqlstate(format($sql$
    select public.norva_claim_source_direct_fallback_lease(
      '94000000-0000-4000-8000-000000000101',
      '94000000-0000-4000-8000-000000000001','stale-cipher',30,
      %L,0,%L)
  $sql$,
    encode(extensions.digest('panel-a.example:8080/alpha','sha256'),'hex'),
    encode(extensions.digest('not-cipher-a','sha256'),'hex'))),
  '40001',
  'cross-table stale ciphertext snapshot is fenced even at the same revision input'
);
select extensions.is(
  pg_temp.phase3_sqlstate(format($sql$
    select public.norva_claim_source_direct_fallback_lease(
      '94000000-0000-4000-8000-000000000101',
      '94000000-0000-4000-8000-000000000001','ttl-low',4,%L,0,%L)
  $sql$,encode(extensions.digest('panel-a.example:8080/alpha','sha256'),'hex'),
    encode(extensions.digest('cipher-a','sha256'),'hex'))),
  '22023',
  'fallback lease TTL below five seconds is rejected'
);
select extensions.is(
  pg_temp.phase3_sqlstate(format($sql$
    select public.norva_claim_source_direct_fallback_lease(
      '94000000-0000-4000-8000-000000000101',
      '94000000-0000-4000-8000-000000000001','ttl-high',121,%L,0,%L)
  $sql$,encode(extensions.digest('panel-a.example:8080/alpha','sha256'),'hex'),
    encode(extensions.digest('cipher-a','sha256'),'hex'))),
  '22023',
  'fallback lease TTL above 120 seconds is rejected'
);
select extensions.is(
  pg_temp.phase3_sqlstate(format($sql$
    select public.norva_claim_source_direct_fallback_lease(
      '94000000-0000-4000-8000-000000000101',
      '94000000-0000-4000-8000-000000000001','',30,%L,0,%L)
  $sql$,encode(extensions.digest('panel-a.example:8080/alpha','sha256'),'hex'),
    encode(extensions.digest('cipher-a','sha256'),'hex'))),
  '22023',
  'empty fallback lease owner is rejected'
);
select extensions.is(
  pg_temp.phase3_sqlstate(format($sql$
    select public.norva_claim_source_direct_fallback_lease(
      '94000000-0000-4000-8000-000000000101',
      '94000000-0000-4000-8000-000000000001',%L,30,%L,0,%L)
  $sql$,repeat('o',161),
    encode(extensions.digest('panel-a.example:8080/alpha','sha256'),'hex'),
    encode(extensions.digest('cipher-a','sha256'),'hex'))),
  '22023',
  'oversized fallback lease owner is rejected'
);

insert into phase3_lease_ctx(key,value)
select 'claim-a', public.norva_claim_source_direct_fallback_lease(
  '94000000-0000-4000-8000-000000000101',
  '94000000-0000-4000-8000-000000000001','lease-a',30,
  encode(extensions.digest('panel-a.example:8080/alpha','sha256'),'hex'),
  0,encode(extensions.digest('cipher-a','sha256'),'hex')
);
select extensions.ok(
  (select value->>'claimed' = 'true'
      and value->>'leaseOwner' = 'lease-a'
      and value ? 'leaseToken'
      and not (value ?| array['affinityHash','configRevision','configCiphertextHash'])
   from phase3_lease_ctx where key='claim-a'),
  'claim succeeds without returning account or config proof material'
);
select extensions.is(
  pg_temp.phase3_sqlstate(format($sql$
    select public.norva_claim_source_direct_fallback_lease(
      '94000000-0000-4000-8000-000000000201',
      '94000000-0000-4000-8000-000000000002','shared-busy',30,
      %L,0,%L)
  $sql$,
    encode(extensions.digest('panel-a.example:8080/alpha','sha256'),'hex'),
    encode(extensions.digest('cipher-a2','sha256'),'hex'))),
  '55P03',
  'a lease is exclusive across users that share one provider account'
);
select extensions.is(
  public.norva_release_source_direct_fallback_lease(
    '94000000-0000-4000-8000-000000000101',
    '94000000-0000-4000-8000-000000000001',gen_random_uuid()
  ),
  false,
  'wrong release token cannot clear the lease'
);
select extensions.is(
  public.norva_release_source_direct_fallback_lease(
    '94000000-0000-4000-8000-000000000101',
    '94000000-0000-4000-8000-000000000001',
    (select (value->>'leaseToken')::uuid from phase3_lease_ctx where key='claim-a')
  ),
  true,
  'exact release token clears the lease'
);

insert into phase3_lease_ctx(key,value)
select 'expiring', public.norva_claim_source_direct_fallback_lease(
  '94000000-0000-4000-8000-000000000101',
  '94000000-0000-4000-8000-000000000001','expiring',5,
  encode(extensions.digest('panel-a.example:8080/alpha','sha256'),'hex'),
  0,encode(extensions.digest('cipher-a','sha256'),'hex')
);
reset role;
update public.cloud_source_direct_fallback_leases
set lease_until = clock_timestamp() - interval '1 second';
set local role service_role;
insert into phase3_lease_ctx(key,value)
select 'after-expiry', public.norva_claim_source_direct_fallback_lease(
  '94000000-0000-4000-8000-000000000101',
  '94000000-0000-4000-8000-000000000001','after-expiry',5,
  encode(extensions.digest('panel-a.example:8080/alpha','sha256'),'hex'),
  0,encode(extensions.digest('cipher-a','sha256'),'hex')
);
select extensions.is(
  (select value->>'leaseOwner' from phase3_lease_ctx where key='after-expiry'),
  'after-expiry',
  'expired lease is reclaimable without a privileged cleanup scan'
);
select public.norva_release_source_direct_fallback_lease(
  '94000000-0000-4000-8000-000000000101',
  '94000000-0000-4000-8000-000000000001',
  (select (value->>'leaseToken')::uuid from phase3_lease_ctx where key='after-expiry')
);
reset role;

select extensions.is(
  pg_temp.phase3_sqlstate($sql$
    update public.cloud_sources set config_ciphertext='raw-b'
    where id='94000000-0000-4000-8000-000000000101'
  $sql$),
  '55000',
  'raw ciphertext UPDATE is rejected outside a prelocked credential transition'
);
select extensions.is(
  pg_temp.phase3_sqlstate($sql$
    update public.cloud_sources set source_type='m3u'
    where id='94000000-0000-4000-8000-000000000101'
  $sql$),
  '55000',
  'raw source-type UPDATE is always rejected by the account fence'
);
select extensions.ok(
  (select config_ciphertext='cipher-a' and source_type='xtream'
   from public.cloud_sources
   where id='94000000-0000-4000-8000-000000000101')
  and (select config_revision=0 from public.cloud_source_lifecycle
       where source_id='94000000-0000-4000-8000-000000000101'),
  'rejected raw writes change neither ciphertext, type, nor revision'
);

select extensions.is(
  pg_temp.phase3_sqlstate($sql$
    insert into public.cloud_source_transitions(
      user_id,transition_kind,old_source_id,state,idempotency_key,
      candidate_secret_ref,expected_source_revision,request_fingerprint
    ) values (
      '94000000-0000-4000-8000-000000000001','credential',
      '94000000-0000-4000-8000-000000000103','validating','raw-missing',
      'secret:raw-missing',0,repeat('1',64)
    )
  $sql$),
  '55000',
  'raw transition INSERT fails closed when old account affinity is missing'
);

-- Test-only activation marker: the destructive contract routine is never
-- invoked.  This transaction rolls the marker and flag back.
update public.cloud_catalog_generation_rollout
set phase='contracted', discovery_complete=true,
    backfill_started_at=clock_timestamp(),
    backfill_completed_at=clock_timestamp(),
    constraints_validated_at=clock_timestamp(),
    contracted_at=clock_timestamp()
where singleton;
update public.admin_feature_flags set enabled=true
where key='provider_credential_transition_v1_enabled';

set local role service_role;
insert into phase3_lease_ctx(key,value)
select 'candidate-b-lease', public.norva_claim_source_direct_fallback_lease(
  '94000000-0000-4000-8000-000000000102',
  '94000000-0000-4000-8000-000000000001','candidate-b-lease',30,
  encode(extensions.digest('panel-b.example/beta','sha256'),'hex'),
  0,encode(extensions.digest('cipher-b','sha256'),'hex')
);
select extensions.is(
  pg_temp.phase3_sqlstate($sql$
    select public.norva_create_credential_transition(
      '94000000-0000-4000-8000-000000000001',
      '94000000-0000-4000-8000-000000000101','candidate-lease-blocked',repeat('8',64),
      0,'cipher-candidate',
      '{"sourceType":"xtream","serverHost":"panel-b.example","hasPassword":true}',
      'lease-test',
      encode(extensions.digest('panel-b.example/beta','sha256'),'hex'))
  $sql$),
  '55P03',
  'active lease on candidate B blocks atomic A to B creation'
);
select public.norva_release_source_direct_fallback_lease(
  '94000000-0000-4000-8000-000000000102',
  '94000000-0000-4000-8000-000000000001',
  (select (value->>'leaseToken')::uuid
   from phase3_lease_ctx where key='candidate-b-lease')
);
reset role;
select extensions.is(
  (select count(*)::integer
   from public.cloud_source_transitions
   where idempotency_key='candidate-lease-blocked'),
  0,
  'candidate lease conflict leaves zero transition/job orphan'
);
set local role service_role;
insert into phase3_lease_ctx(key,value)
select 'lease-d', public.norva_claim_source_direct_fallback_lease(
  '94000000-0000-4000-8000-000000000202',
  '94000000-0000-4000-8000-000000000002','lease-d',30,
  encode(extensions.digest('panel-d.example/delta','sha256'),'hex'),
  0,encode(extensions.digest('cipher-d','sha256'),'hex')
);
select extensions.is(
  pg_temp.phase3_sqlstate($sql$
    select public.norva_create_credential_transition(
      '94000000-0000-4000-8000-000000000002',
      '94000000-0000-4000-8000-000000000202','lease-blocked',repeat('2',64),
      0,'cipher-e','{"sourceType":"xtream","serverHost":"candidate-e.invalid","hasPassword":true}',
      'lease-test',repeat('e',64))
  $sql$),
  '55P03',
  'active direct lease blocks atomic transition creation on the old account'
);
reset role;
select extensions.is(
  pg_temp.phase3_sqlstate($sql$
    insert into public.cloud_source_transitions(
      user_id,transition_kind,old_source_id,state,idempotency_key,
      candidate_secret_ref,expected_source_revision,request_fingerprint
    ) values (
      '94000000-0000-4000-8000-000000000002','credential',
      '94000000-0000-4000-8000-000000000202','validating','raw-lease',
      'secret:raw-lease',0,repeat('3',64)
    )
  $sql$),
  '55P03',
  'raw transition INSERT cannot bypass an active direct lease'
);
set local role service_role;
select public.norva_release_source_direct_fallback_lease(
  '94000000-0000-4000-8000-000000000202',
  '94000000-0000-4000-8000-000000000002',
  (select (value->>'leaseToken')::uuid from phase3_lease_ctx where key='lease-d')
);
select extensions.is(
  pg_temp.phase3_sqlstate($sql$
    select public.norva_create_credential_transition(
      '94000000-0000-4000-8000-000000000001',
      '94000000-0000-4000-8000-000000000103','missing-create',repeat('4',64),
      0,'cipher-z','{"sourceType":"xtream","serverHost":"candidate-z.invalid","hasPassword":true}',
      'lease-test',repeat('f',64))
  $sql$),
  '55000',
  'atomic create fails closed when the old affinity is missing and leaves no job'
);
select extensions.is(
  (select count(*)::integer from public.cloud_source_transitions
   where idempotency_key='missing-create'),
  0,
  'failed atomic create leaves no stranded transition'
);

insert into phase3_lease_ctx(key,value)
select 'transition-a-b', public.norva_create_credential_transition(
  '94000000-0000-4000-8000-000000000001',
  '94000000-0000-4000-8000-000000000101','atomic-a-b',repeat('5',64),
  0,'cipher-candidate',
  '{"sourceType":"xtream","serverHost":"panel-b.example","hasPassword":true}',
  'lease-test',
  encode(extensions.digest('panel-b.example/beta','sha256'),'hex')
);
reset role;
select extensions.ok(
  (select value->>'state'='VALIDATING' and value ? 'transitionId'
   from phase3_lease_ctx where key='transition-a-b')
  and exists (
    select 1 from public.cloud_source_transition_secrets secret
    where secret.transition_id=(select (value->>'transitionId')::uuid
                                from phase3_lease_ctx where key='transition-a-b')
      and secret.candidate_account_affinity_hash is not null
      and secret.previous_account_affinity_hash is not null
  ),
  'atomic create publishes transition and candidate/previous account hashes together'
);
set local role service_role;
select extensions.is(
  pg_temp.phase3_sqlstate(format($sql$
    select public.norva_claim_source_direct_fallback_lease(
      '94000000-0000-4000-8000-000000000201',
      '94000000-0000-4000-8000-000000000002','old-cross-user',30,%L,0,%L)
  $sql$,
    encode(extensions.digest('panel-a.example:8080/alpha','sha256'),'hex'),
    encode(extensions.digest('cipher-a2','sha256'),'hex'))),
  '55P03',
  'nonterminal old/previous account blocks direct claim cross-user'
);
select extensions.is(
  pg_temp.phase3_sqlstate(format($sql$
    select public.norva_claim_source_direct_fallback_lease(
      '94000000-0000-4000-8000-000000000102',
      '94000000-0000-4000-8000-000000000001','candidate-account',30,%L,0,%L)
  $sql$,
    encode(extensions.digest('panel-b.example/beta','sha256'),'hex'),
    encode(extensions.digest('cipher-b','sha256'),'hex'))),
  '55P03',
  'nonterminal candidate account blocks direct claim before swap'
);
select extensions.is(
  pg_temp.phase3_sqlstate(format($sql$
    select public.norva_create_credential_transition(
      '94000000-0000-4000-8000-000000000002',
      '94000000-0000-4000-8000-000000000201','old-account-conflict',repeat('9',64),
      0,'cipher-d-candidate',
      '{"sourceType":"xtream","serverHost":"panel-d.example","hasPassword":true}',
      'lease-test',%L)
  $sql$,encode(extensions.digest('panel-d.example/delta','sha256'),'hex'))),
  '55P03',
  'a second transition whose old account is T1 old A is rejected cross-user'
);
select extensions.is(
  pg_temp.phase3_sqlstate(format($sql$
    select public.norva_create_credential_transition(
      '94000000-0000-4000-8000-000000000002',
      '94000000-0000-4000-8000-000000000202','candidate-conflict',repeat('6',64),
      0,'cipher-other',
      '{"sourceType":"xtream","serverHost":"panel-b.example","hasPassword":true}',
      'lease-test',%L)
  $sql$,
    encode(extensions.digest('panel-b.example/beta','sha256'),'hex'))),
  '55P03',
  'candidate-account transition exclusivity is global across users'
);
reset role;
select extensions.is(
  (select count(*)::integer from public.cloud_source_transitions
   where idempotency_key in ('old-account-conflict','candidate-conflict')),
  0,
  'old/candidate account conflicts roll atomic creates back without orphans'
);
set local role service_role;

insert into phase3_lease_ctx(key,value)
select 'failed-a-b', public.norva_fail_credential_transition_validation(
  (select (value->>'transitionId')::uuid from phase3_lease_ctx where key='transition-a-b'),
  '94000000-0000-4000-8000-000000000001',
  0,
  'catalog_changed_during_staging','lease-test','fail-a-b',repeat('7',64)
);
reset role;
select extensions.ok(
  (select value->>'state'='FAILED' and value->>'failureCode'='catalog_changed_during_staging'
   from phase3_lease_ctx where key='failed-a-b')
  and not exists (
    select 1 from public.cloud_source_credential_transition_jobs job
    where job.transition_id=(select (value->>'transitionId')::uuid
                             from phase3_lease_ctx where key='transition-a-b')
      and job.state in ('pending','processing')
  )
  and exists (
    select 1 from public.cloud_source_transition_secrets secret
    where secret.transition_id=(select (value->>'transitionId')::uuid
                                from phase3_lease_ctx where key='transition-a-b')
      and secret.cleared_at is not null
      and secret.candidate_config_ciphertext is null
      and secret.previous_config_ciphertext is null
  ),
  'catalog drift is terminal FAILED with jobs dead and secrets cleared'
);
set local role service_role;
select extensions.is(
  public.norva_fail_credential_transition_validation(
    (select (value->>'transitionId')::uuid from phase3_lease_ctx where key='transition-a-b'),
    '94000000-0000-4000-8000-000000000001',0,
    'catalog_changed_during_staging','lease-test','fail-a-b',repeat('7',64)
  )->>'transitionId',
  (select value->>'transitionId' from phase3_lease_ctx where key='transition-a-b'),
  'terminal catalog-drift failure replays idempotently'
);

insert into phase3_lease_ctx(key,value)
select 'post-terminal-lease', public.norva_claim_source_direct_fallback_lease(
  '94000000-0000-4000-8000-000000000201',
  '94000000-0000-4000-8000-000000000002','post-terminal',30,
  encode(extensions.digest('panel-a.example:8080/alpha','sha256'),'hex'),
  0,encode(extensions.digest('cipher-a2','sha256'),'hex')
);
select extensions.is(
  public.norva_create_credential_transition(
    '94000000-0000-4000-8000-000000000001',
    '94000000-0000-4000-8000-000000000101','atomic-a-b',repeat('5',64),
    0,'cipher-candidate',
    '{"sourceType":"xtream","serverHost":"panel-b.example","hasPassword":true}',
    'lease-test',
    encode(extensions.digest('panel-b.example/beta','sha256'),'hex')
  )->>'transitionId',
  (select value->>'transitionId' from phase3_lease_ctx where key='transition-a-b'),
  'terminal atomic-create replay is stable even if a later fallback lease is active'
);
select public.norva_release_source_direct_fallback_lease(
  '94000000-0000-4000-8000-000000000201',
  '94000000-0000-4000-8000-000000000002',
  (select (value->>'leaseToken')::uuid
   from phase3_lease_ctx where key='post-terminal-lease')
);
reset role;

update public.admin_feature_flags set enabled=false
where key='provider_credential_transition_v1_enabled';
select extensions.ok(
  public.norva_catalog_generation_flags_all_off(),
  'lease and transition proofs leave all six production flags OFF'
);

select * from extensions.finish();
rollback;
