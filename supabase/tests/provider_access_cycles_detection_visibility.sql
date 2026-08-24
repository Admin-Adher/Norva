begin;
set local lock_timeout = '3s';
set local statement_timeout = '45s';
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select extensions.plan(37);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '98500000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  'provider-access-cycle-985@invalid.test', '', now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
);

insert into public.cloud_sources (
  id, user_id, source_type, display_name, config_ciphertext, config_hint,
  sync_status, catalog_version
) values (
  '98500000-0000-4000-8000-000000000101',
  '98500000-0000-4000-8000-000000000001', 'xtream', 'Provider access 985',
  'fixture-ciphertext', '{"serverHost":"provider-985.invalid"}'::jsonb,
  'ready', 7
);

insert into public.cloud_media_items (
  id, user_id, source_id, item_type, external_id, title, dedup_key,
  is_dedup_primary, metadata, rating_num, generation_id,
  write_head_revision, write_config_revision,
  write_source_visibility_epoch, write_user_visibility_epoch
) select
  '98500000-0000-4000-8000-000000000201',
  source.user_id, source.id, 'movie', 'provider-access-retained',
  'Provider Access Retained', 'provider-access:985', true, '{}'::jsonb, 8,
  head.active_generation_id, head.head_revision, lifecycle.config_revision,
  lifecycle.visibility_epoch, epoch.visibility_epoch
from public.cloud_sources source
join public.cloud_source_lifecycle lifecycle
  on lifecycle.source_id = source.id and lifecycle.user_id = source.user_id
join public.cloud_source_catalog_heads head
  on head.source_id = source.id and head.user_id = source.user_id
join public.cloud_user_catalog_visibility_epochs epoch
  on epoch.user_id = source.user_id
where source.id = '98500000-0000-4000-8000-000000000101';

-- Satisfy all immutable rollout gates only inside this rolled-back acceptance
-- transaction. No public capability remains enabled after the harness.
update public.cloud_provider_access_foundation_rollout
set phase = 'complete', completed_at = coalesce(completed_at, clock_timestamp()), updated_at = clock_timestamp()
where singleton;
update public.cloud_source_provider_account_affinity_rollout
set phase = 'complete', completed_at = coalesce(completed_at, clock_timestamp()), updated_at = clock_timestamp()
where singleton;
alter table public.provider_account_activity validate constraint provider_account_activity_opaque_key_ck;
set local role service_role;
select public.norva_complete_catalog_cache_epoch_v2_rollout(
  'catalog-cache-epoch-v2',
  '23c0fa2cdaf09c08d9de4378d1a82f0f631ce71d6f955a0bdbb2c786b8ff98d3'
);
reset role;
update public.admin_feature_flags set enabled = true
where key in (
  'provider_access_v1_enabled',
  'provider_access_auto_detection_v1_enabled',
  'provider_access_visibility_v1_enabled'
);

create function pg_temp.apply_provider_access_detection_985(
  p_user_id uuid,
  p_source_id uuid,
  p_expected_revision bigint,
  p_detection jsonb,
  p_checked_at timestamptz,
  p_idempotency_key text,
  p_actor text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job_id uuid;
  v_worker text := 'provider-access-proof-985:' || gen_random_uuid()::text;
  v_claim record;
begin
  insert into public.cloud_provider_access_check_jobs(
    user_id, source_id, state, next_attempt_at, idempotency_key
  ) values (
    p_user_id, p_source_id, 'queued', now() - interval '1 minute',
    'proof-985:' || p_idempotency_key
  ) returning id into v_job_id;
  select * into strict v_claim
  from public.norva_claim_provider_access_check_jobs(v_worker, 1, 180);
  if v_claim.job_id is distinct from v_job_id
     or v_claim.expected_access_revision is distinct from p_expected_revision then
    raise exception 'proof helper claimed a different Provider Access authority';
  end if;
  return public.norva_apply_claimed_provider_access_detection(
    v_claim.job_id, v_worker, v_claim.lease_sequence,
    p_detection, p_checked_at, null
  );
end
$function$;
grant execute on function pg_temp.apply_provider_access_detection_985(uuid,uuid,bigint,jsonb,timestamptz,text,text)
  to service_role;

set local role service_role;
select extensions.is(
  public.norva_get_provider_access(
    '98500000-0000-4000-8000-000000000001',
    '98500000-0000-4000-8000-000000000101'
  )->>'status',
  'unknown',
  'new source starts with an explicit UNKNOWN Provider Access snapshot'
);
select extensions.is(
  public.norva_get_provider_access(
    '98500000-0000-4000-8000-000000000001',
    '98500000-0000-4000-8000-000000000101'
  )->'cycles',
  '[]'::jsonb,
  'new source starts without manufactured access history'
);

select public.norva_create_provider_access_cycle(
  '98500000-0000-4000-8000-000000000001',
  '98500000-0000-4000-8000-000000000101',
  current_date, current_date + 30, 1, 'month', true,
  'cycle-985-first', repeat('a', 64), 'test:phase6'
);
select extensions.is(
  (select count(*)::integer from public.cloud_source_access_cycles
   where source_id = '98500000-0000-4000-8000-000000000101' and status = 'active'),
  1,
  'creating a period produces exactly one active cycle'
);
select extensions.is(
  (select provider_access_status from public.cloud_source_provider_access
   where source_id = '98500000-0000-4000-8000-000000000101'),
  'active',
  'future user-entered period updates the snapshot to ACTIVE'
);
select extensions.is(
  (select provider_access_expiry_source from public.cloud_source_provider_access
   where source_id = '98500000-0000-4000-8000-000000000101'),
  'user_entered',
  'manual period records its semantic expiry source'
);
select extensions.ok(
  (select provider_access_manual_override and provider_access_reminders_enabled
   from public.cloud_source_provider_access
   where source_id = '98500000-0000-4000-8000-000000000101'),
  'manual override and cycle reminders are durable'
);
select extensions.is(
  (select sync_status || ':' || catalog_version::text from public.cloud_sources
   where id = '98500000-0000-4000-8000-000000000101'),
  'ready:7',
  'creating an access cycle does not trigger or mutate catalogue sync'
);

select extensions.is(
  public.norva_create_provider_access_cycle(
    '98500000-0000-4000-8000-000000000001',
    '98500000-0000-4000-8000-000000000101',
    current_date, current_date + 30, 1, 'month', true,
    'cycle-985-first', repeat('a', 64), 'test:phase6'
  )->>'replayed',
  'true',
  'exact cycle creation replay is idempotent'
);
select extensions.is(
  (select count(*)::integer from public.cloud_source_access_cycles
   where source_id = '98500000-0000-4000-8000-000000000101'),
  1,
  'idempotent replay creates no duplicate history row'
);
select extensions.throws_ok(
  $sql$select public.norva_create_provider_access_cycle(
    '98500000-0000-4000-8000-000000000001',
    '98500000-0000-4000-8000-000000000101',
    current_date, current_date + 365, 1, 'year', true,
    'cycle-985-first', repeat('b', 64), 'test:phase6'
  )$sql$,
  '22023',
  'provider access idempotency key reused',
  'same idempotency key cannot represent a different period'
);

select public.norva_create_provider_access_cycle(
  '98500000-0000-4000-8000-000000000001',
  '98500000-0000-4000-8000-000000000101',
  current_date + 31, current_date + 396, 1, 'year', true,
  'cycle-985-second', repeat('c', 64), 'test:phase6'
);
select extensions.is(
  (select count(*)::integer from public.cloud_source_access_cycles
   where source_id = '98500000-0000-4000-8000-000000000101' and status = 'active'),
  1,
  'a new purchase keeps the one-active-cycle invariant'
);
select extensions.is(
  (select count(*)::integer from public.cloud_source_access_cycles
   where source_id = '98500000-0000-4000-8000-000000000101' and status = 'superseded'),
  1,
  'a new purchase supersedes rather than rewrites previous history'
);
select extensions.ok(
  (select superseded_at is not null from public.cloud_source_access_cycles
   where source_id = '98500000-0000-4000-8000-000000000101' and status = 'superseded'),
  'supersession has a durable timestamp'
);

select extensions.throws_ok(
  format(
    'select public.norva_update_provider_access_cycle(%L,%L,%L,%s,current_date-2,current_date-1,1,%L,false,%L,%L,%L)',
    '98500000-0000-4000-8000-000000000001',
    '98500000-0000-4000-8000-000000000101',
    (select id from public.cloud_source_access_cycles where source_id='98500000-0000-4000-8000-000000000101' and status='active'),
    (select revision - 1 from public.cloud_source_provider_access where source_id='98500000-0000-4000-8000-000000000101'),
    'day','update-985-stale',repeat('d',64),'test:phase6'
  ),
  '40001',
  'provider access revision CAS failed',
  'stale date editor cannot overwrite a newer Provider Access snapshot'
);

select public.norva_update_provider_access_cycle(
  '98500000-0000-4000-8000-000000000001',
  '98500000-0000-4000-8000-000000000101',
  (select id from public.cloud_source_access_cycles where source_id='98500000-0000-4000-8000-000000000101' and status='active'),
  (select revision from public.cloud_source_provider_access where source_id='98500000-0000-4000-8000-000000000101'),
  current_date - 31, current_date - 1, 30, 'day', false,
  'update-985-past', repeat('e',64), 'test:phase6'
);
select extensions.is(
  (select provider_access_status from public.cloud_source_provider_access
   where source_id='98500000-0000-4000-8000-000000000101'),
  'expected_expired',
  'past user-entered date becomes EXPECTED_EXPIRED rather than confirmed expiry'
);
select extensions.ok(
  public.norva_source_catalog_visible(
    '98500000-0000-4000-8000-000000000101',
    '98500000-0000-4000-8000-000000000001'
  ),
  'EXPECTED_EXPIRED remains visible'
);
select extensions.is(
  (select sync_status || ':' || catalog_version::text from public.cloud_sources
   where id='98500000-0000-4000-8000-000000000101'),
  'ready:7',
  'editing a date never schedules or mutates catalogue sync'
);

select pg_temp.apply_provider_access_detection_985(
  '98500000-0000-4000-8000-000000000001',
  '98500000-0000-4000-8000-000000000101',
  (select revision from public.cloud_source_provider_access where source_id='98500000-0000-4000-8000-000000000101'),
  jsonb_build_object(
    'detectionVersion',1,'status','check_failed_temporary',
    'reasonCode','PROVIDER_RESPONSE_INCONSISTENT','expiresOn',current_date-1,
    'hideEligible',false,'restorationConfirmed',false,
    'contradictions',jsonb_build_array('ACTIVE_WITH_PAST_EXPIRY')
  ), now(), 'detection-985-contradiction', 'test:phase7'
);
select extensions.is(
  (select provider_access_status from public.cloud_source_provider_access
   where source_id='98500000-0000-4000-8000-000000000101'),
  'check_failed_temporary',
  'contradictory Xtream evidence becomes CHECK_FAILED_TEMPORARY'
);
select extensions.is(
  (select provider_access_last_contradiction_count from public.cloud_source_provider_access
   where source_id='98500000-0000-4000-8000-000000000101'),
  1,
  'contradiction count is persisted without raw provider payload'
);
select extensions.ok(
  public.norva_source_catalog_visible(
    '98500000-0000-4000-8000-000000000101',
    '98500000-0000-4000-8000-000000000001'
  ),
  'contradictory provider evidence never hides the catalogue'
);

create temporary table provider_access_epoch_985(value bigint not null) on commit drop;
insert into provider_access_epoch_985
select public.norva_user_catalog_visibility_epoch('98500000-0000-4000-8000-000000000001');
select pg_temp.apply_provider_access_detection_985(
  '98500000-0000-4000-8000-000000000001',
  '98500000-0000-4000-8000-000000000101',
  (select revision from public.cloud_source_provider_access where source_id='98500000-0000-4000-8000-000000000101'),
  jsonb_build_object(
    'detectionVersion',1,'status','expired_confirmed',
    'reasonCode','PROVIDER_CONFIRMED_EXPIRED','expiresOn',current_date-1,
    'hideEligible',true,'restorationConfirmed',false,'contradictions','[]'::jsonb
  ), now(), 'detection-985-expired', 'test:phase7'
);
select extensions.is(
  (select provider_access_status from public.cloud_source_provider_access
   where source_id='98500000-0000-4000-8000-000000000101'),
  'expired_confirmed',
  'coherent provider expiry becomes EXPIRED_CONFIRMED'
);
select extensions.ok(
  (select provider_access_hidden_at is not null from public.cloud_source_provider_access
   where source_id='98500000-0000-4000-8000-000000000101'),
  'confirmed provider expiry atomically records the hide fence'
);
select extensions.ok(
  not public.norva_source_catalog_visible(
    '98500000-0000-4000-8000-000000000101',
    '98500000-0000-4000-8000-000000000001'
  ),
  'confirmed provider expiry hides the catalogue'
);
select extensions.ok(
  public.norva_user_catalog_visibility_epoch('98500000-0000-4000-8000-000000000001')
    > (select value from provider_access_epoch_985),
  'hide transition invalidates the owner cache epoch'
);
select extensions.is(
  (select count(*)::integer from public.cloud_media_items
   where id='98500000-0000-4000-8000-000000000201'),
  1,
  'hide retains catalogue rows instead of deleting them'
);

select pg_temp.apply_provider_access_detection_985(
  '98500000-0000-4000-8000-000000000001',
  '98500000-0000-4000-8000-000000000101',
  (select revision from public.cloud_source_provider_access where source_id='98500000-0000-4000-8000-000000000101'),
  jsonb_build_object(
    'detectionVersion',1,'status','check_failed_temporary',
    'reasonCode','PROVIDER_CHECK_TIMEOUT','expiresOn',null,
    'hideEligible',false,'restorationConfirmed',false,'contradictions','[]'::jsonb
  ), now(), 'detection-985-timeout', 'test:phase7'
);
select extensions.is(
  (select provider_access_status from public.cloud_source_provider_access
   where source_id='98500000-0000-4000-8000-000000000101'),
  'expired_confirmed',
  'temporary failure cannot erase a prior confirmed hidden authority'
);
select extensions.ok(
  not public.norva_source_catalog_visible(
    '98500000-0000-4000-8000-000000000101',
    '98500000-0000-4000-8000-000000000001'
  ),
  'timeout after confirmed expiry does not manufacture restoration'
);

select public.norva_update_provider_access_cycle(
  '98500000-0000-4000-8000-000000000001',
  '98500000-0000-4000-8000-000000000101',
  (select id from public.cloud_source_access_cycles where source_id='98500000-0000-4000-8000-000000000101' and status='active'),
  (select revision from public.cloud_source_provider_access where source_id='98500000-0000-4000-8000-000000000101'),
  current_date, current_date+365, 1, 'year', true,
  'update-985-restore-pending', repeat('f',64), 'test:phase6'
);
select extensions.is(
  (select provider_access_status from public.cloud_source_provider_access
   where source_id='98500000-0000-4000-8000-000000000101'),
  'restoring',
  'future manual date puts a hidden source into RESTORING'
);
select extensions.ok(
  not public.norva_source_catalog_visible(
    '98500000-0000-4000-8000-000000000101',
    '98500000-0000-4000-8000-000000000001'
  ),
  'RESTORING remains hidden without provider proof'
);

truncate provider_access_epoch_985;
insert into provider_access_epoch_985
select public.norva_user_catalog_visibility_epoch('98500000-0000-4000-8000-000000000001');
select pg_temp.apply_provider_access_detection_985(
  '98500000-0000-4000-8000-000000000001',
  '98500000-0000-4000-8000-000000000101',
  (select revision from public.cloud_source_provider_access where source_id='98500000-0000-4000-8000-000000000101'),
  jsonb_build_object(
    'detectionVersion',1,'status','active',
    'reasonCode','PROVIDER_CONFIRMED_ACTIVE','expiresOn',current_date+365,
    'hideEligible',false,'restorationConfirmed',true,'contradictions','[]'::jsonb
  ), now(), 'detection-985-restored', 'test:phase7'
);
select extensions.is(
  (select provider_access_status from public.cloud_source_provider_access
   where source_id='98500000-0000-4000-8000-000000000101'),
  'active',
  'coherent provider proof restores ACTIVE state'
);
select extensions.ok(
  (select provider_access_hidden_at is null and provider_access_restored_at is not null
   from public.cloud_source_provider_access
   where source_id='98500000-0000-4000-8000-000000000101'),
  'restoration atomically clears the hide fence and stores proof time'
);
select extensions.ok(
  public.norva_source_catalog_visible(
    '98500000-0000-4000-8000-000000000101',
    '98500000-0000-4000-8000-000000000001'
  ),
  'restored source is visible again'
);
select extensions.ok(
  public.norva_user_catalog_visibility_epoch('98500000-0000-4000-8000-000000000001')
    > (select value from provider_access_epoch_985),
  'restore transition invalidates the owner cache epoch'
);
select extensions.is(
  (select count(*)::integer from public.cloud_media_items
   where id='98500000-0000-4000-8000-000000000201'),
  1,
  'restoration reuses the retained catalogue without rebuild'
);
select extensions.is(
  (select count(*)::integer from public.cloud_source_access_cycles
   where source_id='98500000-0000-4000-8000-000000000101' and status='active'),
  1,
  'provider detection also preserves one active cycle maximum'
);
select extensions.is(
  (select count(*)::integer from public.cloud_source_lifecycle_events
   where source_id='98500000-0000-4000-8000-000000000101'
     and event_kind in ('provider_access_hidden','provider_access_restored')),
  2,
  'hide and restoration are both durable lifecycle events'
);
select extensions.ok(
  not exists (
    select 1 from public.cloud_source_lifecycle_events event
    where event.source_id='98500000-0000-4000-8000-000000000101'
      and event.payload::text ~* '(auth|active_cons|max_connections|user_info|exp_date)'
  ),
  'durable events contain decisions only, never raw Xtream account payloads'
);

select * from extensions.finish();
rollback;
