begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select extensions.no_plan();

select extensions.is(
  (select enabled from public.admin_feature_flags
   where key = 'provider_credential_transition_v1_enabled'),
  false,
  'credential transitions ship OFF'
);

select extensions.ok(
  not has_table_privilege('service_role', 'public.cloud_source_transition_secrets', 'SELECT')
  and not has_table_privilege('authenticated', 'public.cloud_source_transition_secrets', 'SELECT')
  and not has_table_privilege('anon', 'public.cloud_source_transition_secrets', 'SELECT'),
  'ciphertext storage has no direct Data API or service table access'
);

select extensions.is(
  (select count(*)::integer from pg_policy
   where polrelid = 'public.cloud_source_transition_secrets'::regclass),
  0,
  'secret storage has RLS and no public policy'
);

select extensions.ok(
  has_function_privilege('service_role',
    'public.norva_create_credential_transition(uuid,uuid,text,text,bigint,text,jsonb,text,text)', 'EXECUTE')
  and not has_function_privilege('authenticated',
    'public.norva_create_credential_transition(uuid,uuid,text,text,bigint,text,jsonb,text,text)', 'EXECUTE')
  and not has_function_privilege('anon',
    'public.norva_create_credential_transition(uuid,uuid,text,text,bigint,text,jsonb,text,text)', 'EXECUTE')
  and not has_function_privilege('service_role',
    'public.norva_create_credential_transition(uuid,uuid,text,text,bigint,text,jsonb,text)', 'EXECUTE')
  and not has_function_privilege('service_role',
    'public.norva_bind_credential_transition_account_affinity(uuid,uuid,text,bigint)', 'EXECUTE'),
  'only atomic credential creation is service-role executable'
);

select extensions.ok(
  to_regprocedure('public.norva_mark_credential_parent_action_complete(uuid,uuid,uuid,uuid,text,integer,text,text,bigint)') is not null
  and to_regprocedure('public.norva_copy_credential_generation_episode_state(uuid,uuid,uuid,uuid,text,integer,bigint,integer)') is not null
  and to_regprocedure('public.norva_seal_credential_catalog_generation(uuid,uuid,uuid,uuid,text,integer,bigint,bigint)') is not null,
  'resumable build exposes parent-action, lazy-series-copy and atomic seal RPCs'
);

select extensions.ok(
  has_function_privilege('service_role',
    'public.norva_promote_credential_generation_titles_batch(uuid,uuid,integer)', 'EXECUTE')
  and not has_function_privilege('authenticated',
    'public.norva_promote_credential_generation_titles_batch(uuid,uuid,integer)', 'EXECUTE')
  and not has_function_privilege('anon',
    'public.norva_promote_credential_generation_titles_batch(uuid,uuid,integer)', 'EXECUTE')
  and not has_function_privilege('service_role',
    'public.cloud_titles_mirror_to_catalog()', 'EXECUTE'),
  'candidate title isolation internals are private and promotion is service-only'
);

select extensions.ok(
  position('update public.cloud_titles' in lower(
    pg_get_functiondef('public.norva_promote_credential_generation_titles_batch(uuid,uuid,integer)'::regprocedure))) = 0
  and position('insert into public.catalog_titles' in lower(
    pg_get_functiondef('public.norva_promote_credential_generation_titles_batch(uuid,uuid,integer)'::regprocedure))) > 0,
  'terminal promotion publishes the durable projection without mutating shared title shells'
);

select extensions.ok(
  position('build_candidate_generation' in pg_get_constraintdef(
    (select oid from pg_constraint where conrelid =
      'public.cloud_source_credential_transition_jobs'::regclass
      and contype = 'c' and pg_get_constraintdef(oid) like '%job_kind%')
  )) > 0
  and position('post_switch_verify' in pg_get_constraintdef(
    (select oid from pg_constraint where conrelid =
      'public.cloud_source_credential_transition_jobs'::regclass
      and contype = 'c' and pg_get_constraintdef(oid) like '%job_kind%')
  )) > 0,
  'durable jobs use the isolated validation/build/verify sequence'
);

select extensions.ok(
  position('cloud_source_catalog_generation_inventory_actions' in
    pg_get_functiondef('public.norva_seal_credential_catalog_generation(uuid,uuid,uuid,uuid,text,integer,bigint,bigint)'::regprocedure)) > 0
  and position('<> 3' in
    pg_get_functiondef('public.norva_seal_credential_catalog_generation(uuid,uuid,uuid,uuid,text,integer,bigint,bigint)'::regprocedure)) > 0
  and position('cloud_source_catalog_generation_category_lists' in
    pg_get_functiondef('public.norva_seal_credential_catalog_generation(uuid,uuid,uuid,uuid,text,integer,bigint,bigint)'::regprocedure)) > 0,
  'seal requires three exhaustive parent inventories and three category listings'
);

select extensions.ok(
  position('state=''pending''' in
    pg_get_functiondef('public.norva_seal_credential_catalog_generation(uuid,uuid,uuid,uuid,text,integer,bigint,bigint)'::regprocedure)) > 0,
  'seal leaves a reclaimable build job for crash-safe identity assessment'
);

select extensions.ok(
  to_regprocedure('public.norva_checkpoint_credential_generation_job(uuid,uuid,text,integer,bigint,jsonb,integer)') is not null
  and position('make_interval(secs => p_retry_after_seconds)' in
    pg_get_functiondef('public.norva_checkpoint_credential_generation_job(uuid,uuid,text,integer,bigint,jsonb,integer)'::regprocedure)) > 0
  and position('failureAttemptCount' in
    pg_get_functiondef('public.norva_checkpoint_credential_generation_job(uuid,uuid,text,integer,bigint,jsonb,integer)'::regprocedure)) > 0,
  'checkpoint can defer a gateway-pending claim without consuming a failure attempt'
);

select extensions.ok(
  not public.norva_credential_job_progress_safe(
    '{"action":"complete","version":1,"typeIndex":6,"categoryOrdinal":0,"itemOffset":0,"categoryPageCursor":"","categoriesDone":true,"itemCursor":"","processedCategories":0,"processedItems":0}'::jsonb
  ),
  'progress state machine rejects forged complete action at typeIndex 6'
);

select extensions.ok(
  public.norva_credential_candidate_hint_safe(
    '{"sourceType":"xtream","serverHost":"provider.invalid:8443","hasPassword":true}'::jsonb
  )
  and not public.norva_credential_candidate_hint_safe(
    '{"sourceType":"xtream","serverHost":"provider.invalid:0","hasPassword":true}'::jsonb
  )
  and not public.norva_credential_candidate_hint_safe(
    '{"sourceType":"xtream","serverHost":"provider.invalid:65536","hasPassword":true}'::jsonb
  )
  and not public.norva_credential_candidate_hint_safe(
    '{"sourceType":"xtream","serverHost":"https://provider.invalid/path","hasPassword":true}'::jsonb
  ),
  'candidate host accepts one bounded port and rejects URL or invalid port forms'
);

select extensions.ok(
  position('strong_identity_distinct' in
    pg_get_functiondef('public.norva_record_credential_identity_assessment(uuid,uuid,text,integer,integer,integer,numeric,jsonb,text)'::regprocedure)) > 0
  and position('norva_credential_strong_identity_signals' in
    pg_get_functiondef('public.norva_record_credential_identity_assessment(uuid,uuid,text,integer,integer,integer,numeric,jsonb,text)'::regprocedure)) > 0,
  'identity decisions verify canonical strong signals inside the database'
);

select extensions.ok(
  position('strong_identity_sample' in lower(
    pg_get_functiondef('public.norva_seal_credential_catalog_generation(uuid,uuid,uuid,uuid,text,integer,bigint,bigint)'::regprocedure))) > 0
  and position('octet_length(page.external_id) <= 128' in lower(
    pg_get_functiondef('public.norva_seal_credential_catalog_generation(uuid,uuid,uuid,uuid,text,integer,bigint,bigint)'::regprocedure))) > 0
  and position('limit 256' in lower(
    pg_get_functiondef('public.norva_seal_credential_catalog_generation(uuid,uuid,uuid,uuid,text,integer,bigint,bigint)'::regprocedure))) > 0,
  'resumable seal maintains a bounded raw strong-identity sample'
);

select extensions.ok(
  position('norva-catalog-content-manifest-v2' in
    pg_get_functiondef('public.norva_catalog_manifest_progress_result(uuid)'::regprocedure)) > 0
  and position('row_hashes as materialized' in lower(
    pg_get_functiondef('public.norva_seal_credential_catalog_generation(uuid,uuid,uuid,uuid,text,integer,bigint,bigint)'::regprocedure))) > 0
  and position('bit_xor' in lower(
    pg_get_functiondef('public.norva_seal_credential_catalog_generation(uuid,uuid,uuid,uuid,text,integer,bigint,bigint)'::regprocedure))) > 0
  and position('table:cloud_title_variants:' in
    pg_get_functiondef('public.norva_compute_catalog_generation_manifest(uuid)'::regprocedure)) = 0
  and position('table:cloud_live_logical_channels:' in
    pg_get_functiondef('public.norva_compute_catalog_generation_manifest(uuid)'::regprocedure)) = 0
  and position('hashtextextended' in
    pg_get_functiondef('public.norva_compute_catalog_generation_manifest(uuid)'::regprocedure)) = 0,
  'resumable content identity hashes raw provider inventory while readiness counts stay separate'
);

select extensions.ok(
  (select count(*) = 6 from information_schema.columns
   where table_schema = 'public'
     and table_name in ('cloud_media_items','cloud_title_variants',
       'cloud_live_logical_channels','cloud_live_variants',
       'catalog_series_episode_memberships','catalog_series_inventory_state')
     and column_name = 'generation_id'),
  'all six physical catalogue tables are generation scoped'
);

select extensions.ok(
  (select count(*) = 24 from information_schema.columns
   where table_schema = 'public'
     and table_name in ('cloud_media_items','cloud_title_variants',
       'cloud_live_logical_channels','cloud_live_variants',
       'catalog_series_episode_memberships','catalog_series_inventory_state')
     and column_name in ('write_head_revision','write_config_revision',
       'write_source_visibility_epoch','write_user_visibility_epoch')),
  'all six tables carry the four transient ABA write fences'
);

select extensions.ok(
  position('title variant media item crosses catalog generation' in
    pg_get_functiondef('public.norva_catalog_generation_write_guard()'::regprocedure)) > 0
  and position('live variant logical channel crosses catalog generation' in
    pg_get_functiondef('public.norva_catalog_generation_write_guard()'::regprocedure)) > 0
  and position('series parent variant crosses catalog generation' in
    pg_get_functiondef('public.norva_catalog_generation_write_guard()'::regprocedure)) > 0,
  'write guard proves all UUID parent links stay inside one source generation'
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '93000000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'phase3-fixture@invalid.test', '', now(),
  '{}'::jsonb, '{}'::jsonb, now(), now()
);

insert into public.cloud_sources (
  id, user_id, source_type, display_name, config_ciphertext,
  config_hint, sync_status, catalog_version, enabled, last_synced_at
) values (
  '93000000-0000-4000-8000-000000000101',
  '93000000-0000-4000-8000-000000000001',
  'xtream', 'Phase 3 isolated fixture', 'ciphertext-a', '{}'::jsonb,
  'ready', 1, true, null
), (
  '93000000-0000-4000-8000-000000000102',
  '93000000-0000-4000-8000-000000000001',
  'xtream', 'Phase 3 A to B fixture', 'ciphertext-a2', '{}'::jsonb,
  'ready', 1, true, now()
);

insert into public.cloud_source_provider_account_affinities(source_id,user_id,affinity_hash)
values
  ('93000000-0000-4000-8000-000000000101','93000000-0000-4000-8000-000000000001',repeat('a',64)),
  ('93000000-0000-4000-8000-000000000102','93000000-0000-4000-8000-000000000001',repeat('b',64));

select extensions.ok(
  exists (select 1 from public.cloud_source_catalog_heads
    where source_id = '93000000-0000-4000-8000-000000000101'),
  'new sources receive a genesis generation and head'
);

select extensions.is(
  (public.norva_compute_catalog_generation_manifest(
    (select active_generation_id from public.cloud_source_catalog_heads
     where source_id = '93000000-0000-4000-8000-000000000101')
  ) #>> '{identityEvidence,complete}')::boolean,
  false,
  'genesis identity is incomplete without an actually completed sync timestamp'
);

insert into public.cloud_media_items (
  id, user_id, source_id, item_type, external_id, title,
  dedup_key, is_dedup_primary, metadata
) values (
  '93000000-0000-4000-8000-000000000401',
  '93000000-0000-4000-8000-000000000001',
  '93000000-0000-4000-8000-000000000101',
  'movie', 'legacy-off', 'Legacy flag-off writer', 'legacy-off', true, '{}'::jsonb
);
update public.cloud_media_items set title = 'Legacy update still works'
where id = '93000000-0000-4000-8000-000000000401';
delete from public.cloud_media_items
where id = '93000000-0000-4000-8000-000000000401';

insert into public.cloud_media_items (
  id, user_id, source_id, item_type, external_id, title,
  dedup_key, is_dedup_primary, metadata
)
select gen_random_uuid(), '93000000-0000-4000-8000-000000000001',
  '93000000-0000-4000-8000-000000000102', 'movie',
  'shared-' || lpad(n::text, 3, '0'), 'Old A ' || n,
  'shared-' || lpad(n::text, 3, '0'), true, '{}'::jsonb
from generate_series(1,32) n;

insert into public.cloud_titles (
  id,user_id,item_type,identity_key,identity_source,title,metadata
) values (
  '93000000-0000-4000-8000-000000000701',
  '93000000-0000-4000-8000-000000000001','movie','normalized:phase3-cross-generation',
  'normalized','Phase 3 no-mix fixture','{}'::jsonb
);

insert into public.catalog_titles (
  item_type,provider_tmdb_id,title,poster_url,metadata,enriched_at,updated_at
) values (
  'movie','987654321','Phase 3 active title A',null,'{}'::jsonb,now(),now()
)
on conflict (item_type,provider_tmdb_id) do update set
  title=excluded.title, poster_url=null, metadata='{}'::jsonb,
  enriched_at=excluded.enriched_at, updated_at=excluded.updated_at;

insert into public.cloud_media_items (
  id,user_id,source_id,item_type,external_id,title,dedup_key,
  is_dedup_primary,metadata
) values (
  '93000000-0000-4000-8000-000000000402',
  '93000000-0000-4000-8000-000000000001',
  '93000000-0000-4000-8000-000000000101',
  'movie','active-normal','Active normal projector','active-normal',true,'{}'::jsonb
);
insert into public.cloud_titles (
  id,user_id,item_type,identity_key,identity_source,provider_tmdb_id,
  title,metadata
) values (
  '93000000-0000-4000-8000-000000000702',
  '93000000-0000-4000-8000-000000000001','movie',
  'provider:phase3-active-normal','provider_tmdb','987654322',
  'Active normal projector','{"active":"A"}'::jsonb
);
insert into public.cloud_title_variants (
  id,user_id,title_id,source_id,media_item_id,item_type,external_id,raw_title
) values (
  '93000000-0000-4000-8000-000000000703',
  '93000000-0000-4000-8000-000000000001',
  '93000000-0000-4000-8000-000000000702',
  '93000000-0000-4000-8000-000000000101',
  '93000000-0000-4000-8000-000000000402',
  'movie','active-normal','Active normal projector'
);
select extensions.ok(
  not exists (select 1 from public.catalog_titles
    where item_type='movie' and provider_tmdb_id='987654322')
  and coalesce((select metadata='{"active":"A"}'::jsonb
       from public.cloud_titles
       where id='93000000-0000-4000-8000-000000000702'),false),
  'ordinary active variant metadata remains source-local after global mirror retirement'
);

update public.cloud_sources set enabled = false
where id = '93000000-0000-4000-8000-000000000101';

select extensions.pass('representative insert/update/delete remains compatible while flag is OFF');

create temporary table phase3_ctx (key text primary key, value jsonb);
grant all on phase3_ctx to service_role;

set local role service_role;
select extensions.throws_ok(
  $sql$select public.norva_create_credential_transition(
    '93000000-0000-4000-8000-000000000001',
    '93000000-0000-4000-8000-000000000101',
    'create-off', repeat('a',64), 0, 'ciphertext-b', '{"sourceType":"xtream","serverHost":"candidate.invalid","hasPassword":true}', 'phase3-test',repeat('d',64))$sql$,
  '55000', 'provider credential transition feature is disabled',
  'creation fails closed while flag is OFF'
);
reset role;

-- This state-machine fixture exercises post-activation behavior without
-- invoking the destructive contract routine.  Production activation is gated
-- by the online-rollout pgTAP; the transaction-local marker is rolled back.
update public.cloud_provider_access_foundation_rollout
set phase = 'complete',
    started_at = coalesce(started_at, clock_timestamp()),
    completed_at = clock_timestamp(),
    updated_at = clock_timestamp()
where singleton;
update public.cloud_source_provider_account_affinity_rollout
set phase = 'complete',
    started_at = coalesce(started_at, clock_timestamp()),
    completed_at = clock_timestamp(),
    updated_at = clock_timestamp()
where singleton;
update public.cloud_catalog_generation_rollout
set phase = 'contracted',
    discovery_complete = true,
    backfill_started_at = clock_timestamp(),
    backfill_completed_at = clock_timestamp(),
  constraints_validated_at = clock_timestamp(),
  contracted_at = clock_timestamp()
where singleton;

set local role service_role;
select extensions.ok(
  (public.norva_register_active_catalog_refresh_worker(
    'phase3-proof-synthetic-worker',
    'credential-transition-worker-v3-active-catalog-refresh',
    'active-catalog-refresh-checkpoint-prune-v1'
  ) ->> 'ready')::boolean,
  'the synthetic proof worker registers the exact active-refresh contract'
);
reset role;
select extensions.ok(public.norva_active_catalog_refresh_contract_ready(),
  'the registered synthetic worker makes the exact refresh contract ready');

alter table public.provider_account_activity
  validate constraint provider_account_activity_opaque_key_ck;
select extensions.ok(
  exists (
    select 1 from pg_catalog.pg_constraint constraint_state
    where constraint_state.conrelid = 'public.provider_account_activity'::regclass
      and constraint_state.conname = 'provider_account_activity_opaque_key_ck'
      and constraint_state.convalidated
  ),
  'the proof validates the opaque provider-affinity backfill constraint'
);

update public.admin_feature_flags set enabled = true
where key = 'provider_credential_transition_v1_enabled';

set local role service_role;
insert into phase3_ctx values ('create', public.norva_create_credential_transition(
  '93000000-0000-4000-8000-000000000001',
  '93000000-0000-4000-8000-000000000101',
  'phase3-create-1', repeat('b',64), 0, 'ciphertext-b', '{"sourceType":"xtream","serverHost":"candidate.invalid","hasPassword":true}', 'phase3-test',repeat('d',64)
));

select extensions.is((select value ->> 'state' from phase3_ctx where key='create'),
  'VALIDATING', 'disabled but nondeleted active Xtream source is eligible');

select extensions.is(
  public.norva_create_credential_transition(
    '93000000-0000-4000-8000-000000000001',
    '93000000-0000-4000-8000-000000000101',
    'phase3-create-1', repeat('b',64), 0, 'ciphertext-b', '{"sourceType":"xtream","serverHost":"candidate.invalid","hasPassword":true}', 'phase3-test',repeat('d',64)
  ) ->> 'transitionId',
  (select value ->> 'transitionId' from phase3_ctx where key='create'),
  'exact create replay is idempotent'
);

select extensions.throws_ok(
  $sql$select public.norva_create_credential_transition(
    '93000000-0000-4000-8000-000000000001',
    '93000000-0000-4000-8000-000000000101',
    'phase3-create-1', repeat('c',64), 0, 'ciphertext-c', '{"sourceType":"xtream","serverHost":"candidate.invalid","hasPassword":true}', 'phase3-test',repeat('d',64))$sql$,
  '22023', 'idempotency key reused with different request',
  'same key with a different fingerprint is rejected'
);

select extensions.is(
  (select config_ciphertext from public.cloud_sources
   where id='93000000-0000-4000-8000-000000000101'),
  'ciphertext-a',
  'candidate creation never changes active config'
);

reset role;
select extensions.is(
  (select count(*)::integer from public.cloud_source_credential_transition_jobs
   where transition_id=(select (value->>'transitionId')::uuid from phase3_ctx where key='create')
     and job_kind='validate_candidate' and state='pending'
     and available_at<>'infinity'::timestamptz),
  1,
  'atomic creation binds affinity and makes validation claimable in one transaction'
);
set local role service_role;

select extensions.ok(
  public.norva_get_credential_transition(
    (select (value->>'transitionId')::uuid from phase3_ctx where key='create'),
    '93000000-0000-4000-8000-000000000001'
  ) ?& array['transitionId','sourceId','state','revision']
  and not (public.norva_get_credential_transition(
    (select (value->>'transitionId')::uuid from phase3_ctx where key='create'),
    '93000000-0000-4000-8000-000000000001'
  ) ?| array['candidateSecretRef','previousSecretRef','requestFingerprint','configCiphertext']),
  'transition getter is sanitized'
);

insert into phase3_ctx
select 'claim', to_jsonb(claim)
from public.norva_claim_credential_transition_jobs('phase3-worker',1,60) claim;

select extensions.throws_ok(
  format($sql$select public.norva_mark_credential_candidate_validated(
    %L,%L,%L,'wrong-worker',%s,%s,0)$sql$,
    (select value->>'transitionId' from phase3_ctx where key='create'),
    '93000000-0000-4000-8000-000000000001',
    (select value->>'job_id' from phase3_ctx where key='claim'),
    (select value->>'lease_sequence' from phase3_ctx where key='claim'),
    (select value->>'transition_revision' from phase3_ctx where key='claim')
  ),
  '40001', 'candidate validation lease CAS failed',
  'validation completion rejects the wrong lease owner'
);

select public.norva_mark_credential_candidate_validated(
  (select (value->>'transitionId')::uuid from phase3_ctx where key='create'),
  '93000000-0000-4000-8000-000000000001',
  (select (value->>'job_id')::uuid from phase3_ctx where key='claim'),
  'phase3-worker',
  (select (value->>'lease_sequence')::integer from phase3_ctx where key='claim'),
  (select (value->>'transition_revision')::bigint from phase3_ctx where key='claim'),
  0
);

insert into phase3_ctx values ('cancel', public.norva_cancel_credential_transition(
  (select (value->>'transitionId')::uuid from phase3_ctx where key='create'),
  '93000000-0000-4000-8000-000000000001', 'phase3-test',
  (select revision from public.cloud_source_transitions where id=
    (select (value->>'transitionId')::uuid from phase3_ctx where key='create')),
  'phase3-cancel-1', repeat('d',64)
));

select extensions.is((select value->>'state' from phase3_ctx where key='cancel'),
  'CANCELLED', 'manual cancellation is terminal');

reset role;
select extensions.is(
  (select count(*)::integer from public.cloud_source_credential_transition_jobs
   where transition_id=(select (value->>'transitionId')::uuid from phase3_ctx where key='create')
     and state in ('pending','processing')),
  0,
  'cancel terminalizes every claimable job and rejects stale leases'
);
set local role service_role;

select extensions.is(
  public.norva_cancel_credential_transition(
    (select (value->>'transitionId')::uuid from phase3_ctx where key='create'),
    '93000000-0000-4000-8000-000000000001', 'phase3-test', 999,
    'phase3-cancel-1', repeat('d',64)
  ) ->> 'state',
  'CANCELLED',
  'cancel replay returns the stable original result'
);

insert into phase3_ctx values ('create2', public.norva_create_credential_transition(
  '93000000-0000-4000-8000-000000000001',
  '93000000-0000-4000-8000-000000000102',
  'phase3-create-2', repeat('e',64), 0, 'ciphertext-b2', '{"sourceType":"xtream","serverHost":"candidate-b.invalid","hasPassword":true}', 'phase3-test',repeat('c',64)
));
insert into phase3_ctx
select 'validate2', to_jsonb(claim)
from public.norva_claim_credential_transition_jobs('phase3-validation-2',1,120) claim;
select public.norva_mark_credential_candidate_validated(
  (select (value->>'transitionId')::uuid from phase3_ctx where key='create2'),
  '93000000-0000-4000-8000-000000000001',
  (select (value->>'job_id')::uuid from phase3_ctx where key='validate2'),
  'phase3-validation-2',
  (select (value->>'lease_sequence')::integer from phase3_ctx where key='validate2'),
  (select (value->>'transition_revision')::bigint from phase3_ctx where key='validate2'), 0
);
insert into phase3_ctx
select 'build2', to_jsonb(claim)
from public.norva_claim_credential_transition_jobs('phase3-build-2',1,120) claim;
insert into phase3_ctx values ('allocate2', public.norva_allocate_credential_catalog_generation(
  (select (value->>'transitionId')::uuid from phase3_ctx where key='create2'),
  '93000000-0000-4000-8000-000000000001',
  (select (value->>'job_id')::uuid from phase3_ctx where key='build2'),
  'phase3-build-2',
  (select (value->>'lease_sequence')::integer from phase3_ctx where key='build2'),
  (select (value->>'transition_revision')::bigint from phase3_ctx where key='build2')
));

select extensions.is(
  (public.norva_ensure_credential_generation_titles(
    (select (value->>'transitionId')::uuid from phase3_ctx where key='create2'),
    '93000000-0000-4000-8000-000000000001',
    (select (value->>'generationId')::uuid from phase3_ctx where key='allocate2'),
    (select (value->>'job_id')::uuid from phase3_ctx where key='build2'),
    'phase3-build-2',
    (select (value->>'lease_sequence')::integer from phase3_ctx where key='build2'),
    '[{"item_type":"movie","identity_key":"provider:phase3-candidate-title","identity_source":"provider_tmdb","provider_tmdb_id":"987654321","title":"Phase 3 candidate title B","poster_url":"https://candidate.invalid/b.jpg","metadata":{"candidate":"B"}}]'::jsonb
  ) ->> 'insertedTitles')::integer,
  1,
  'bounded candidate title projector inserts one generation-owned title'
);
reset role;
select extensions.ok(
  (select title='Phase 3 active title A'
          and poster_url is null
          and metadata='{}'::jsonb
   from public.catalog_titles
   where item_type='movie' and provider_tmdb_id='987654321')
  and (select title='Phase 3 candidate title B'
          and poster_url='https://candidate.invalid/b.jpg'
          and metadata='{"candidate":"B"}'::jsonb
       from public.cloud_titles
       where user_id='93000000-0000-4000-8000-000000000001'
         and item_type='movie'
         and identity_key='provider:phase3-candidate-title'),
  'BUILDING candidate title neither mutates the active global overlay nor self-thins'
);
set local role service_role;

select extensions.throws_ok(
  format($sql$insert into public.cloud_title_variants (
    user_id,title_id,source_id,media_item_id,item_type,external_id,raw_title,
    generation_id,ingest_job_id,ingest_attempt,ingest_lease_owner
  ) values (%L,%L,%L,(select id from public.cloud_media_items
    where source_id=%L and generation_id=(select active_generation_id
      from public.cloud_source_catalog_heads where source_id=%L) limit 1),
    'movie','cross-generation','Cross generation',%L,%L,%s,'phase3-build-2')$sql$,
    '93000000-0000-4000-8000-000000000001',
    '93000000-0000-4000-8000-000000000701',
    '93000000-0000-4000-8000-000000000102',
    '93000000-0000-4000-8000-000000000102',
    '93000000-0000-4000-8000-000000000102',
    (select value->>'generationId' from phase3_ctx where key='allocate2'),
    (select value->>'job_id' from phase3_ctx where key='build2'),
    (select value->>'lease_sequence' from phase3_ctx where key='build2')
  ),
  '23514','title variant media item crosses catalog generation',
  'candidate rows cannot link to an active-generation parent UUID'
);

select extensions.throws_ok(
  format($sql$select public.norva_seal_credential_catalog_generation(
    %L,%L,%L,%L,'phase3-build-2',%s,%s,%s)$sql$,
    (select value->>'transitionId' from phase3_ctx where key='create2'),
    '93000000-0000-4000-8000-000000000001',
    (select value->>'generationId' from phase3_ctx where key='allocate2'),
    (select value->>'job_id' from phase3_ctx where key='build2'),
    (select value->>'lease_sequence' from phase3_ctx where key='build2'),
    (select value->>'transitionRevision' from phase3_ctx where key='allocate2'),
    (select public.norva_get_credential_catalog_generation(
      (select (value->>'transitionId')::uuid from phase3_ctx where key='create2'),
      '93000000-0000-4000-8000-000000000001')->>'generationRevision')
  ),
  '55000', 'candidate generation completeness ledger is incomplete',
  'premature seal is rejected before exhaustive ledgers'
);

-- This harness runs against the fully expanded isolated schema.  The online
-- migration suite separately proves the historical constraint replacement;
-- here, require its final condition so a rerun never restores legacy DDL.
select extensions.ok(
  not exists (
    select 1 from pg_catalog.pg_constraint constraint_state
    where constraint_state.conrelid='public.cloud_media_items'::regclass
      and constraint_state.conname='cloud_media_items_source_id_item_type_external_id_key'
  ),
  'online metadata contract has retired the legacy source/item uniqueness'
);

-- The remainder exercises the already-contracted state machine.  A fresh
-- historical reconstruction owns the legacy-constraint assertion; this test
-- must remain rerunnable after the online contract has been installed.
reset role;
alter table public.cloud_media_items
  drop constraint if exists cloud_media_items_source_id_item_type_external_id_key;
set local role service_role;

insert into phase3_ctx values ('revisionBeforeBulk2',
  jsonb_build_object('revision',(
    public.norva_get_credential_catalog_generation(
      (select (value->>'transitionId')::uuid from phase3_ctx where key='create2'),
      '93000000-0000-4000-8000-000000000001'
    )->>'generationRevision'
  )::bigint)
);

insert into public.cloud_media_items (
  id, user_id, source_id, item_type, external_id, title, dedup_key,
  is_dedup_primary, metadata, generation_id,
  ingest_job_id, ingest_attempt, ingest_lease_owner
)
select gen_random_uuid(), '93000000-0000-4000-8000-000000000001',
  '93000000-0000-4000-8000-000000000102', 'movie',
  'shared-' || lpad(n::text,3,'0'), 'Candidate B ' || n,
  'shared-' || lpad(n::text,3,'0'), true, '{}'::jsonb,
  (select (value->>'generationId')::uuid from phase3_ctx where key='allocate2'),
  (select (value->>'job_id')::uuid from phase3_ctx where key='build2'),
  (select (value->>'lease_sequence')::integer from phase3_ctx where key='build2'),
  'phase3-build-2'
from generate_series(1,32) n;

select extensions.is(
  (public.norva_get_credential_catalog_generation(
    (select (value->>'transitionId')::uuid from phase3_ctx where key='create2'),
    '93000000-0000-4000-8000-000000000001')->>'generationRevision')::bigint,
  (select (value->>'revision')::bigint + 1
   from phase3_ctx where key='revisionBeforeBulk2'),
  'one 32-row ingest statement advances generation revision only once'
);

insert into phase3_ctx values ('manifestBeforeVariant2',
  public.norva_preview_credential_catalog_manifest(
    (select (value->>'transitionId')::uuid from phase3_ctx where key='create2'),
    '93000000-0000-4000-8000-000000000001',
    (select (value->>'generationId')::uuid from phase3_ctx where key='allocate2'),
    (select (value->>'job_id')::uuid from phase3_ctx where key='build2'),
    'phase3-build-2',
    (select (value->>'lease_sequence')::integer from phase3_ctx where key='build2')
  )
);

insert into public.cloud_title_variants (
  user_id,title_id,source_id,media_item_id,item_type,external_id,raw_title,
  generation_id,ingest_job_id,ingest_attempt,ingest_lease_owner
)
select
  '93000000-0000-4000-8000-000000000001', title.id,
  '93000000-0000-4000-8000-000000000102', item.id,
  'movie','shared-001','Candidate B title',
  (select (value->>'generationId')::uuid from phase3_ctx where key='allocate2'),
  (select (value->>'job_id')::uuid from phase3_ctx where key='build2'),
  (select (value->>'lease_sequence')::integer from phase3_ctx where key='build2'),
  'phase3-build-2'
from public.cloud_titles title
join public.cloud_media_items item
  on item.source_id='93000000-0000-4000-8000-000000000102'
 and item.generation_id=(select (value->>'generationId')::uuid from phase3_ctx where key='allocate2')
 and item.item_type='movie' and item.external_id='shared-001'
where title.user_id='93000000-0000-4000-8000-000000000001'
  and title.item_type='movie'
  and title.identity_key='provider:phase3-candidate-title';

insert into phase3_ctx values ('manifestAfterVariant2',
  public.norva_preview_credential_catalog_manifest(
    (select (value->>'transitionId')::uuid from phase3_ctx where key='create2'),
    '93000000-0000-4000-8000-000000000001',
    (select (value->>'generationId')::uuid from phase3_ctx where key='allocate2'),
    (select (value->>'job_id')::uuid from phase3_ctx where key='build2'),
    'phase3-build-2',
    (select (value->>'lease_sequence')::integer from phase3_ctx where key='build2')
  )
);
select extensions.is(
  (select value->>'checksum' from phase3_ctx where key='manifestBeforeVariant2')
    ,
  (select value->>'checksum' from phase3_ctx where key='manifestAfterVariant2'),
  'parser-derived title materialisation does not change raw provider identity'
);
update public.cloud_media_items
set subtitle='TMDB hydrated subtitle',
    metadata='{"staged":true,"tmdb":{"overview":"enriched"}}'::jsonb,
    playback_hint='{"container":"mkv"}'::jsonb,
    added_at=999999,
    rating_num=9.9,
    release_year=2042
where source_id='93000000-0000-4000-8000-000000000102'
  and generation_id=(select (value->>'generationId')::uuid from phase3_ctx where key='allocate2')
  and item_type='movie' and external_id='shared-001';
update public.cloud_title_variants
set language='fr', quality='uhd', resolution='3840x2160',
    container_extension='mkv', metadata='{"staged":true}'::jsonb,
    playback_hint='{"probe":"local"}'::jsonb
where source_id='93000000-0000-4000-8000-000000000102'
  and generation_id=(select (value->>'generationId')::uuid from phase3_ctx where key='allocate2')
  and item_type='movie' and external_id='shared-001';
insert into phase3_ctx values ('manifestAfterEnrichment2',
  public.norva_preview_credential_catalog_manifest(
    (select (value->>'transitionId')::uuid from phase3_ctx where key='create2'),
    '93000000-0000-4000-8000-000000000001',
    (select (value->>'generationId')::uuid from phase3_ctx where key='allocate2'),
    (select (value->>'job_id')::uuid from phase3_ctx where key='build2'),
    'phase3-build-2',
    (select (value->>'lease_sequence')::integer from phase3_ctx where key='build2')
  )
);
select extensions.is(
  (select value->>'checksum' from phase3_ctx where key='manifestAfterEnrichment2'),
  (select value->>'checksum' from phase3_ctx where key='manifestAfterVariant2'),
  'staged, enriched, probed and self-healed local fields do not change logical content identity'
);
reset role;
select extensions.ok(
  (select title='Phase 3 active title A'
          and poster_url is null
          and metadata='{}'::jsonb
   from public.catalog_titles
   where item_type='movie' and provider_tmdb_id='987654321')
  and (select metadata='{"candidate":"B"}'::jsonb
       from public.cloud_titles
       where user_id='93000000-0000-4000-8000-000000000001'
         and item_type='movie'
         and identity_key='provider:phase3-candidate-title')
  and (select metadata='{}'::jsonb
          and catalog_metadata='{"candidate":"B"}'::jsonb
       from public.cloud_source_catalog_generation_candidate_titles
       where generation_id=(select (value->>'generationId')::uuid
                            from phase3_ctx where key='allocate2')
         and item_type='movie'
         and identity_key='provider:phase3-candidate-title'),
  'candidate variant rollup remains head-aware and cannot re-enter the global mirror'
);
update public.cloud_media_items
set metadata = metadata || '{"providerTmdbId":"987654321"}'::jsonb
where source_id='93000000-0000-4000-8000-000000000102'
  and generation_id=(select (value->>'generationId')::uuid from phase3_ctx where key='allocate2')
  and item_type='movie' and external_id='shared-001';
set local role authenticated;
select set_config('request.jwt.claim.sub','93000000-0000-4000-8000-000000000001',true);
select extensions.throws_ok(
  $sql$select count(*) from public.cloud_title_variants
        where external_id='shared-001' and raw_title='Candidate B title'$sql$,
  '42501', 'permission denied for table cloud_title_variants',
  'authenticated cannot read the physical variant table at all'
);
select extensions.throws_ok(
  $sql$select count(*) from public.cloud_titles
        where identity_key='provider:phase3-candidate-title'$sql$,
  '42501', 'permission denied for table cloud_titles',
  'authenticated cannot read the physical title shell table at all'
);
reset role;
set local role service_role;

select extensions.is(
  (select count(*)::integer from public.cloud_catalog_visible_media_items
   where source_id='93000000-0000-4000-8000-000000000102'),
  32,
  'BUILDING candidate rows remain hidden behind the active A head'
);

select public.norva_mark_credential_category_list_complete(
  (select (value->>'transitionId')::uuid from phase3_ctx where key='create2'),
  '93000000-0000-4000-8000-000000000001',
  (select (value->>'generationId')::uuid from phase3_ctx where key='allocate2'),
  (select (value->>'job_id')::uuid from phase3_ctx where key='build2'),
  'phase3-build-2',(select (value->>'lease_sequence')::integer from phase3_ctx where key='build2'),'live',0
);
select public.norva_mark_credential_category_list_complete(
  (select (value->>'transitionId')::uuid from phase3_ctx where key='create2'),
  '93000000-0000-4000-8000-000000000001',
  (select (value->>'generationId')::uuid from phase3_ctx where key='allocate2'),
  (select (value->>'job_id')::uuid from phase3_ctx where key='build2'),
  'phase3-build-2',(select (value->>'lease_sequence')::integer from phase3_ctx where key='build2'),'vod',0
);
select public.norva_mark_credential_category_list_complete(
  (select (value->>'transitionId')::uuid from phase3_ctx where key='create2'),
  '93000000-0000-4000-8000-000000000001',
  (select (value->>'generationId')::uuid from phase3_ctx where key='allocate2'),
  (select (value->>'job_id')::uuid from phase3_ctx where key='build2'),
  'phase3-build-2',(select (value->>'lease_sequence')::integer from phase3_ctx where key='build2'),'series',0
);
select public.norva_mark_credential_parent_action_complete(
  (select (value->>'transitionId')::uuid from phase3_ctx where key='create2'),
  '93000000-0000-4000-8000-000000000001',(select (value->>'generationId')::uuid from phase3_ctx where key='allocate2'),
  (select (value->>'job_id')::uuid from phase3_ctx where key='build2'),'phase3-build-2',
  (select (value->>'lease_sequence')::integer from phase3_ctx where key='build2'),'live','get_live_streams',0
);
select public.norva_mark_credential_parent_action_complete(
  (select (value->>'transitionId')::uuid from phase3_ctx where key='create2'),
  '93000000-0000-4000-8000-000000000001',(select (value->>'generationId')::uuid from phase3_ctx where key='allocate2'),
  (select (value->>'job_id')::uuid from phase3_ctx where key='build2'),'phase3-build-2',
  (select (value->>'lease_sequence')::integer from phase3_ctx where key='build2'),'vod','get_vod_streams',32
);
select public.norva_mark_credential_parent_action_complete(
  (select (value->>'transitionId')::uuid from phase3_ctx where key='create2'),
  '93000000-0000-4000-8000-000000000001',(select (value->>'generationId')::uuid from phase3_ctx where key='allocate2'),
  (select (value->>'job_id')::uuid from phase3_ctx where key='build2'),'phase3-build-2',
  (select (value->>'lease_sequence')::integer from phase3_ctx where key='build2'),'series','get_series',0
);
insert into phase3_ctx values ('copy2', public.norva_copy_credential_generation_episode_state(
  (select (value->>'transitionId')::uuid from phase3_ctx where key='create2'),
  '93000000-0000-4000-8000-000000000001',(select (value->>'generationId')::uuid from phase3_ctx where key='allocate2'),
  (select (value->>'job_id')::uuid from phase3_ctx where key='build2'),'phase3-build-2',
  (select (value->>'lease_sequence')::integer from phase3_ctx where key='build2'),0,200
));
select extensions.is((select (value->>'complete')::boolean from phase3_ctx where key='copy2'),true,
  'empty lazy-series cache clone completes under the leased build');

select public.norva_checkpoint_credential_generation_job(
  (select (value->>'job_id')::uuid from phase3_ctx where key='build2'),
  '93000000-0000-4000-8000-000000000001','phase3-build-2',
  (select (value->>'lease_sequence')::integer from phase3_ctx where key='build2'),0,
  '{"action":"complete","version":1,"typeIndex":7,"categoryOrdinal":0,"itemOffset":32,"categoryPageCursor":"","categoriesDone":true,"itemCursor":"","processedCategories":0,"processedItems":32}'::jsonb
);
insert into phase3_ctx
select 'sealclaim2', to_jsonb(claim)
from public.norva_claim_credential_transition_jobs('phase3-seal-2',1,120) claim;
insert into phase3_ctx values ('sealFirstSlice2',
  public.norva_seal_credential_catalog_generation(
    (select (value->>'transitionId')::uuid from phase3_ctx where key='create2'),
    '93000000-0000-4000-8000-000000000001',
    (select (value->>'generationId')::uuid from phase3_ctx where key='allocate2'),
    (select (value->>'job_id')::uuid from phase3_ctx where key='sealclaim2'),
    'phase3-seal-2',
    (select (value->>'lease_sequence')::integer from phase3_ctx where key='sealclaim2'),
    (select (value->>'transition_revision')::bigint from phase3_ctx where key='sealclaim2'),
    (select (public.norva_get_credential_catalog_generation(
      (select (value->>'transitionId')::uuid from phase3_ctx where key='create2'),
      '93000000-0000-4000-8000-000000000001')->>'generationRevision')::bigint)
  )
);
select extensions.ok(
  (select value->>'complete'='false'
          and value->>'leaseRetained'='true'
   from phase3_ctx where key='sealFirstSlice2'),
  'manifest seal is resumable and retains the build lease after one slice'
);

-- Simulate a worker crash after the first physical slice.  A new worker must
-- reclaim the same durable job and continue the already-fenced snapshots.
reset role;
update public.cloud_source_credential_transition_jobs job
set lease_until = clock_timestamp() - interval '1 second'
where job.id=(select (value->>'job_id')::uuid from phase3_ctx where key='sealclaim2');
set local role service_role;
insert into phase3_ctx
select 'sealReclaim2', to_jsonb(claim)
from public.norva_claim_credential_transition_jobs('phase3-seal-reclaim-2',1,120) claim;
select extensions.ok(
  (select value->>'job_id' from phase3_ctx where key='sealReclaim2') =
    (select value->>'job_id' from phase3_ctx where key='sealclaim2')
  and (select (value->>'lease_sequence')::integer from phase3_ctx where key='sealReclaim2') >
    (select (value->>'lease_sequence')::integer from phase3_ctx where key='sealclaim2'),
  'expired mid-seal lease is reclaimed on the same job with a new fence token'
);

do $seal_loop$
declare
  v_result jsonb := '{}'::jsonb;
  v_iteration integer;
begin
  for v_iteration in 1..32 loop
    v_result := public.norva_seal_credential_catalog_generation(
      (select (value->>'transitionId')::uuid from phase3_ctx where key='create2'),
      '93000000-0000-4000-8000-000000000001',
      (select (value->>'generationId')::uuid from phase3_ctx where key='allocate2'),
      (select (value->>'job_id')::uuid from phase3_ctx where key='sealReclaim2'),
      'phase3-seal-reclaim-2',
      (select (value->>'lease_sequence')::integer from phase3_ctx where key='sealReclaim2'),
      (select (value->>'transition_revision')::bigint from phase3_ctx where key='sealReclaim2'),
      (select (public.norva_get_credential_catalog_generation(
        (select (value->>'transitionId')::uuid from phase3_ctx where key='create2'),
        '93000000-0000-4000-8000-000000000001')->>'generationRevision')::bigint)
    );
    exit when coalesce((v_result->>'complete')::boolean,false);
  end loop;
  if not coalesce((v_result->>'complete')::boolean,false) then
    raise exception 'manifest seal did not complete within 32 bounded slices';
  end if;
  insert into phase3_ctx values ('seal2',v_result);
end
$seal_loop$;
insert into phase3_ctx
select 'identityclaim2', to_jsonb(claim)
from public.norva_claim_credential_transition_jobs('phase3-identity-2',1,120) claim;
select extensions.is(
  (select value->>'job_id' from phase3_ctx where key='identityclaim2'),
  (select value->>'job_id' from phase3_ctx where key='sealReclaim2'),
  'crash after seal reclaims the same READY build job for assessment'
);
select extensions.is(
  public.norva_get_credential_catalog_generation(
    (select (value->>'transitionId')::uuid from phase3_ctx where key='create2'),
    '93000000-0000-4000-8000-000000000001')->>'generationState',
  'READY','sealed candidate is READY while A remains the active head'
);
select extensions.throws_ok(
  $sql$select public.norva_record_credential_identity_assessment(
    (select (value->>'transitionId')::uuid from phase3_ctx where key='create2'),
    '93000000-0000-4000-8000-000000000001',
    'xtream-type-streamid-sha256-bottom256-jaccard-manifest-v2',
    32,32,32,1.00000,
    '{"sample_complete":true,"strong_identity_distinct":false,"canonical_identity_match":false,"content_manifest_checksum_match":false,"decision_reason_code":"manifest_mismatch"}'::jsonb,
    'same_catalog'
  )$sql$,
  '22023', 'identity assessment does not match sealed generation evidence',
  'identical provider-local stream ids cannot auto-match catalogs with different manifests'
);
select public.norva_record_credential_identity_assessment(
  (select (value->>'transitionId')::uuid from phase3_ctx where key='create2'),
  '93000000-0000-4000-8000-000000000001',
  'xtream-type-streamid-sha256-bottom256-jaccard-manifest-v2',
  32,32,32,1.00000,
  '{"sample_complete":true,"strong_identity_distinct":false,"canonical_identity_match":false,"content_manifest_checksum_match":false,"decision_reason_code":"manifest_mismatch"}'::jsonb,
  'ambiguous'
);
select extensions.is(
  (select identity_decision from public.cloud_source_transitions
   where id=(select (value->>'transitionId')::uuid from phase3_ctx where key='create2')),
  'ambiguous',
  'typed overlap without an equal independent content manifest stays ambiguous'
);
select public.norva_decide_ambiguous_credential_transition(
  (select (value->>'transitionId')::uuid from phase3_ctx where key='create2'),
  '93000000-0000-4000-8000-000000000001',
  'KEEP_AS_SAME_CATALOG','phase3-test',
  (select revision from public.cloud_source_transitions
   where id=(select (value->>'transitionId')::uuid from phase3_ctx where key='create2')),
  'phase3-manifest-mismatch-manual-keep',repeat('e',64)
);
select public.norva_mark_credential_transition_ready(
  (select (value->>'transitionId')::uuid from phase3_ctx where key='create2'),
  '93000000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000901',
   (select revision from public.cloud_source_transitions where id=(select (value->>'transitionId')::uuid from phase3_ctx where key='create2'))
);

-- The transaction-crash matrix starts from the durable IMPORTING state where
-- owner proof is still pending.  Its independent backend is then terminated
-- exactly while the owner workflow attempts READY_TO_SWITCH.
\if :{?phase3_prepare_pre_ready_crash_fixture}
commit;
\quit
\endif

do $owner_transition$
declare
  v_claim record;
  v_step jsonb;
begin
  select claim.* into strict v_claim
  from public.norva_claim_catalog_background_owner_build_jobs(
    'phase3-owner-baseline-2',10,120
  ) claim
  where claim.job_kind = 'baseline'
    and claim.user_id = '93000000-0000-4000-8000-000000000001';
  for v_iteration in 1..6 loop
    v_step := public.norva_run_catalog_background_owner_build_job_slice(
      v_claim.job_id,'phase3-owner-baseline-2',v_claim.lease_sequence,
      v_claim.checkpoint_revision,100
    );
    v_claim.checkpoint_revision := (v_step->>'checkpointRevision')::bigint;
    exit when coalesce((v_step->>'complete')::boolean,false);
  end loop;
  -- baseline_current is deliberately owner-only.  A successful candidate
  -- claim below is the public service-role proof that the baseline pointer
  -- was certified; do not widen the test role merely to inspect its helper.
  if not coalesce((v_step->>'complete')::boolean,false) then
    raise exception 'owner baseline workflow did not certify A';
  end if;

  select claim.* into strict v_claim
  from public.norva_claim_catalog_background_owner_build_jobs(
    'phase3-owner-candidate-2',10,120
  ) claim
  where claim.job_kind = 'candidate'
    and claim.transition_id = (
      select (value->>'transitionId')::uuid from phase3_ctx where key='create2'
    );
  for v_iteration in 1..6 loop
    v_step := public.norva_run_catalog_background_owner_build_job_slice(
      v_claim.job_id,'phase3-owner-candidate-2',v_claim.lease_sequence,
      v_claim.checkpoint_revision,100
    );
    v_claim.checkpoint_revision := (v_step->>'checkpointRevision')::bigint;
    exit when coalesce((v_step->>'complete')::boolean,false);
  end loop;
  if not coalesce((v_step->>'complete')::boolean,false)
     or (select state from public.cloud_source_transitions
         where id=v_claim.transition_id) <> 'ready_to_switch' then
    raise exception 'owner candidate workflow did not certify READY_TO_SWITCH';
  end if;
end
$owner_transition$;
-- The formal-concurrency harness needs this exact, production-built state to
-- be visible to independent PostgreSQL sessions.  It is opt-in and only used
-- on a disposable proof database.  Keep the already-claimed identity worker
-- alive so cancel_wins can also prove that a pre-cancel worker wakes stale.
-- The ordinary pgTAP path remains one rollback-only transaction.
\if :{?phase3_prepare_concurrency_fixture}
commit;
\quit
\endif
select public.norva_settle_credential_transition_job(
  (select (value->>'job_id')::uuid from phase3_ctx where key='identityclaim2'),'phase3-identity-2',
  (select (value->>'lease_sequence')::integer from phase3_ctx where key='identityclaim2'),'completed',null,1
);
insert into phase3_ctx values ('preswap2', public.norva_get_catalog_write_snapshot(
  '93000000-0000-4000-8000-000000000102','93000000-0000-4000-8000-000000000001'
));
insert into phase3_ctx values ('swap2', public.norva_begin_credential_swap(
  (select (value->>'transitionId')::uuid from phase3_ctx where key='create2'),
  '93000000-0000-4000-8000-000000000001',(select (value->>'generationId')::uuid from phase3_ctx where key='allocate2'),
  (select (public.norva_get_credential_catalog_generation((select (value->>'transitionId')::uuid from phase3_ctx where key='create2'),
    '93000000-0000-4000-8000-000000000001')->>'generationRevision')::bigint),
  (select revision from public.cloud_source_transitions where id=(select (value->>'transitionId')::uuid from phase3_ctx where key='create2')),
  (select (value->>'configRevision')::bigint from phase3_ctx where key='preswap2'),
  (select (value->>'headRevision')::bigint from phase3_ctx where key='preswap2'),
  'phase3-swap-2',repeat('f',64)
));
select extensions.is((select config_ciphertext from public.cloud_sources where id='93000000-0000-4000-8000-000000000102'),
  'ciphertext-b2','atomic switch applies B config');
select extensions.is(
  public.norva_get_source_catalog_head('93000000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000102')->>'activeGenerationId',
  (select value->>'generationId' from phase3_ctx where key='allocate2'),
  'atomic switch exposes only candidate generation B');
reset role;
select extensions.ok(
  (select title='Phase 3 active title A'
          and poster_url is null
          and metadata='{}'::jsonb
   from public.catalog_titles
   where item_type='movie' and provider_tmdb_id='987654321')
  and (select metadata='{"candidate":"B"}'::jsonb
       from public.cloud_titles
       where user_id='93000000-0000-4000-8000-000000000001'
         and item_type='movie'
         and identity_key='provider:phase3-candidate-title'),
  'COMMITTING head B is ineligible for global publish and leaves its shell unchanged'
);
set local role service_role;
select extensions.throws_ok(
  format($sql$select public.norva_promote_credential_generation_titles_batch(
    %L,%L,10)$sql$,
    (select value->>'generationId' from phase3_ctx where key='allocate2'),
    '93000000-0000-4000-8000-000000000001'
  ),
  '40001','credential generation title promotion CAS failed',
  'COMMITTING remains compensable and cannot publish candidate title metadata'
);
select public.provider_account_touch_by_source(
  '93000000-0000-4000-8000-000000000102','playback'
);
reset role;
select extensions.ok(
  exists(select 1 from public.provider_account_activity
    where account_key=repeat('c',64) and kind='playback')
  and not ((select config_hint from public.cloud_sources
    where id='93000000-0000-4000-8000-000000000102') ? 'username'),
  'post-swap activity uses opaque affinity without a public username hint'
);
set local role service_role;
insert into phase3_ctx
select 'postclaim2', to_jsonb(claim)
from public.norva_claim_credential_transition_jobs(
  'phase3-post-2',1,120,
  'credential-transition-worker-v3-active-catalog-refresh'
) claim;
do $post_switch_refresh_proof$
declare
  v_user_id uuid := '93000000-0000-4000-8000-000000000001';
  v_source_id uuid := '93000000-0000-4000-8000-000000000102';
  v_generation_id uuid := (select (value->>'generationId')::uuid from phase3_ctx where key='allocate2');
  v_job_id uuid := (select (value->>'job_id')::uuid from phase3_ctx where key='postclaim2');
  v_lease_sequence integer := (select (value->>'lease_sequence')::integer from phase3_ctx where key='postclaim2');
  v_worker text := 'phase3-post-2';
  v_head_revision bigint;
  v_config_revision bigint;
  v_source_epoch bigint;
  v_user_epoch bigint;
  v_catalog_version bigint;
  v_run jsonb;
  v_run_id uuid;
  v_checkpoint_revision bigint;
  v_result jsonb;
  v_progress jsonb;
  v_action text;
  v_kind text;
  v_items jsonb;
  v_titles jsonb;
  v_variants jsonb;
  v_title_result jsonb;
  v_confirmations jsonb;
  v_item_count bigint;
  v_digest text;
begin
  select head.head_revision,lifecycle.config_revision,lifecycle.visibility_epoch,
    epoch.visibility_epoch
  into v_head_revision,v_config_revision,v_source_epoch,v_user_epoch
  from public.cloud_source_catalog_heads head
  join public.cloud_source_lifecycle lifecycle
    on lifecycle.source_id=head.source_id and lifecycle.user_id=head.user_id
  join public.cloud_user_catalog_visibility_epochs epoch on epoch.user_id=head.user_id
  where head.source_id=v_source_id and head.user_id=v_user_id;
  select public.norva_begin_active_catalog_title_projection_refresh(
    v_source_id,v_user_id,v_generation_id,v_job_id,v_worker,v_lease_sequence,
    v_head_revision,v_config_revision,v_source_epoch,v_user_epoch
  ) into v_run;
  v_run_id := (v_run->>'refreshRunId')::uuid;
  v_catalog_version := (v_run->>'generationRevision')::bigint;
  v_checkpoint_revision := (v_run->>'checkpointRevision')::bigint;


  -- The synthetic provider fixture has no categories.  Each empty response is
  -- nevertheless recorded through the same fenced RPC as production.
  foreach v_kind in array array['live','vod','series'] loop
    v_action := v_kind || '_categories';
    v_digest := case v_kind when 'live' then repeat('a',64)
      when 'vod' then repeat('b',64) else repeat('c',64) end;
    v_progress := jsonb_build_object('version',1,'catalogVersion',v_catalog_version,
      'action',v_action,'actionComplete',false,'cursor','','spoolToken','proof_'||v_action,
      'contentSha256',v_digest,'processedCategories',0,'processedItems',0,
      'observedItems',0,'categoryCount',0);
    select public.norva_checkpoint_active_catalog_title_refresh(
      v_source_id,v_user_id,v_generation_id,v_run_id,v_job_id,v_worker,v_lease_sequence,
      v_checkpoint_revision,v_head_revision,v_config_revision,v_source_epoch,v_user_epoch,
      v_progress,false,0
    ) into v_result;
    v_checkpoint_revision := (v_result->>'checkpointRevision')::bigint;
    select public.norva_upsert_active_catalog_refresh_categories(
      v_source_id,v_user_id,v_generation_id,v_run_id,v_job_id,v_worker,v_lease_sequence,
      v_head_revision,v_config_revision,v_source_epoch,v_user_epoch,v_kind,'[]'::jsonb
    ) into v_result;
    v_user_epoch := coalesce((v_result->>'visibilityEpoch')::bigint,v_user_epoch);
    v_action := v_kind || '_categories';
    v_digest := case v_kind when 'live' then repeat('a',64)
      when 'vod' then repeat('b',64) else repeat('c',64) end;
    v_progress := jsonb_build_object('version',1,'catalogVersion',v_catalog_version,
      'action',v_action,'actionComplete',true,'cursor','','spoolToken','proof_'||v_action,
      'contentSha256',v_digest,'processedCategories',0,'processedItems',0,
      'observedItems',0,'categoryCount',0);
    select public.norva_checkpoint_active_catalog_title_refresh(
      v_source_id,v_user_id,v_generation_id,v_run_id,v_job_id,v_worker,v_lease_sequence,
      v_checkpoint_revision,v_head_revision,v_config_revision,v_source_epoch,v_user_epoch,
      v_progress,false,0
    ) into v_result;
    v_checkpoint_revision := (v_result->>'checkpointRevision')::bigint;
    v_action := case v_kind when 'live' then 'vod_categories'
      when 'vod' then 'series_categories' else 'live_streams' end;
    v_progress := jsonb_build_object('version',1,'catalogVersion',v_catalog_version,
      'action',v_action,'actionComplete',false,'cursor','','spoolToken','',
      'contentSha256','','processedCategories',0,'processedItems',0,
      'observedItems',0,'categoryCount',0);
    select public.norva_checkpoint_active_catalog_title_refresh(
      v_source_id,v_user_id,v_generation_id,v_run_id,v_job_id,v_worker,v_lease_sequence,
      v_checkpoint_revision,v_head_revision,v_config_revision,v_source_epoch,v_user_epoch,
      v_progress,false,0
    ) into v_result;
    v_checkpoint_revision := (v_result->>'checkpointRevision')::bigint;
  end loop;

  foreach v_kind in array array['live','vod','series'] loop
    select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'item_type',item.item_type,'external_id',item.external_id,'title',item.title,
      'subtitle',item.subtitle,'poster_url',item.poster_url,'backdrop_url',item.backdrop_url,
      'metadata',item.metadata,'playback_hint',item.playback_hint,'available',item.available,
      'added_at',item.added_at,'rating_num',item.rating_num,'release_year',item.release_year,
      'dedup_key',item.dedup_key,'is_dedup_primary',item.is_dedup_primary
    )) order by item.external_id),'[]'::jsonb),count(*)
    into v_items,v_item_count
    from public.cloud_media_items item
    where item.user_id=v_user_id and item.source_id=v_source_id
      and item.generation_id=v_generation_id
      and item.item_type=case v_kind when 'vod' then 'movie' else v_kind end;
    v_action := case v_kind when 'live' then 'live_streams'
      when 'vod' then 'vod_streams' else 'series_streams' end;
    v_digest := case v_kind when 'live' then repeat('a',64)
      when 'vod' then repeat('b',64) else repeat('c',64) end;
    v_progress := jsonb_build_object('version',1,'catalogVersion',v_catalog_version,
      'action',v_action,'actionComplete',false,'cursor','','spoolToken','proof_'||v_action,
      'contentSha256',v_digest,'processedCategories',0,'processedItems',0,
      'observedItems',0,'categoryCount',0);
    select public.norva_checkpoint_active_catalog_title_refresh(
      v_source_id,v_user_id,v_generation_id,v_run_id,v_job_id,v_worker,v_lease_sequence,
      v_checkpoint_revision,v_head_revision,v_config_revision,v_source_epoch,v_user_epoch,
      v_progress,false,0
    ) into v_result;
    v_checkpoint_revision := (v_result->>'checkpointRevision')::bigint;
    select public.norva_upsert_active_catalog_media_items(
        v_source_id,v_user_id,v_generation_id,v_run_id,v_job_id,v_worker,v_lease_sequence,
        v_head_revision,v_config_revision,v_source_epoch,v_user_epoch,v_catalog_version,v_items
    ) into v_result;
    v_user_epoch := (v_result->>'visibilityEpoch')::bigint;
    if v_item_count > 0 and v_kind in ('vod','series') then
      with active_items as (
        select item.*,
          case when nullif(item.metadata->>'providerTmdbId','') is not null
            then 'tmdb:' || (item.metadata->>'providerTmdbId')
            else 'norm:' || lower(regexp_replace(item.title,'[^a-zA-Z0-9]+','-','g')) end as identity_key,
          case when nullif(item.metadata->>'providerTmdbId','') is not null
            then 'provider_tmdb' else 'normalized' end as identity_source,
          case when nullif(item.metadata->>'providerTmdbId','') is not null
            then 'provider_unverified' else 'unmatched' end as match_status
        from public.cloud_media_items item
        where item.generation_id=v_generation_id and item.user_id=v_user_id
          and item.source_id=v_source_id and item.catalog_version=v_catalog_version
          and item.projection_refresh_run_id=v_run_id
          and item.item_type=case v_kind when 'vod' then 'movie' else 'series' end
      ) select coalesce(jsonb_agg(jsonb_build_object(
        'user_id',v_user_id,'item_type',item.item_type,
        'identity_key',item.identity_key,'identity_source',item.identity_source,
        'provider_tmdb_id',nullif(item.metadata->>'providerTmdbId',''),
        'match_status',item.match_status,'title',item.title,
        'original_title',item.title,'release_year',item.release_year,
        'poster_url',item.poster_url,'backdrop_url',item.backdrop_url,
        'metadata',item.metadata || jsonb_build_object(
          'identityKey',item.identity_key,'identitySource',item.identity_source,
          'projectionVersion',3
        ),'synced_at',now(),'version_languages','[]'::jsonb
      ) order by item.external_id),'[]'::jsonb)
      into v_titles
      from active_items item;
      select public.norva_upsert_active_catalog_title_payloads(
        v_source_id,v_user_id,v_generation_id,v_run_id,v_job_id,v_worker,v_lease_sequence,
        v_head_revision,v_config_revision,v_source_epoch,v_user_epoch,v_titles
      ) into v_title_result;
      v_user_epoch := (v_title_result->>'visibilityEpoch')::bigint;
      with title_result as (
        select value->>'identityKey' as identity_key,value->>'titleId' as title_id
        from jsonb_array_elements(v_title_result->'titles')
      ) select coalesce(jsonb_agg(jsonb_build_object(
        'title_id',title_result.title_id,'media_item_id',item.id,
        'item_type',item.item_type,'external_id',item.external_id,
        'raw_title',item.title,'playback_hint',item.playback_hint,
        'codec_profile','{}'::jsonb,'compatibility_tier','unknown',
        'playback_cost_score',500,'metadata',item.metadata
      ) order by item.external_id),'[]'::jsonb)
      into v_variants
      from public.cloud_media_items item
      join title_result
        on title_result.identity_key=case
          when nullif(item.metadata->>'providerTmdbId','') is not null
            then 'tmdb:' || (item.metadata->>'providerTmdbId')
          else 'norm:' || lower(regexp_replace(item.title,'[^a-zA-Z0-9]+','-','g')) end
      where item.generation_id=v_generation_id and item.user_id=v_user_id
        and item.source_id=v_source_id and item.catalog_version=v_catalog_version
        and item.projection_refresh_run_id=v_run_id
        and item.item_type=case v_kind when 'vod' then 'movie' else 'series' end;
      select public.norva_upsert_active_catalog_title_variants(
        v_source_id,v_user_id,v_generation_id,v_run_id,v_job_id,v_worker,v_lease_sequence,
        v_head_revision,v_config_revision,v_source_epoch,v_user_epoch,v_catalog_version,v_variants
      ) into v_result;
      v_user_epoch := (v_result->>'visibilityEpoch')::bigint;
      select coalesce(jsonb_agg(jsonb_build_object(
        'itemType',value->>'itemType','identityKey',value->>'identityKey',
        'titleId',value->>'titleId','payloadUpdatedAt',value->>'payloadUpdatedAt'
      )),'[]'::jsonb)
      into v_confirmations from jsonb_array_elements(v_title_result->'titles');
      perform public.norva_confirm_active_catalog_title_projection_batch(
        v_source_id,v_user_id,v_generation_id,v_run_id,v_job_id,v_worker,v_lease_sequence,
        v_head_revision,v_config_revision,v_source_epoch,v_user_epoch,
        v_confirmations
      );
    end if;
    v_action := case v_kind when 'live' then 'live_streams'
      when 'vod' then 'vod_streams' else 'series_streams' end;
    v_digest := case v_kind when 'live' then repeat('a',64)
      when 'vod' then repeat('b',64) else repeat('c',64) end;
    v_progress := jsonb_build_object('version',1,'catalogVersion',v_catalog_version,
      'action',v_action,'actionComplete',true,'cursor','','spoolToken','proof_'||v_action,
      'contentSha256',v_digest,'processedCategories',0,'processedItems',v_item_count,
      'observedItems',v_item_count,'categoryCount',0);
    select public.norva_checkpoint_active_catalog_title_refresh(
      v_source_id,v_user_id,v_generation_id,v_run_id,v_job_id,v_worker,v_lease_sequence,
      v_checkpoint_revision,v_head_revision,v_config_revision,v_source_epoch,v_user_epoch,
      v_progress,false,0
    ) into v_result;
    v_checkpoint_revision := (v_result->>'checkpointRevision')::bigint;
    select public.norva_prune_active_catalog_refresh_action_batch(
      v_source_id,v_user_id,v_generation_id,v_run_id,v_job_id,v_worker,v_lease_sequence,
      v_checkpoint_revision,v_head_revision,v_config_revision,v_source_epoch,v_user_epoch,
      v_kind,v_catalog_version,200
    ) into v_result;
    v_user_epoch := (v_result->>'visibilityEpoch')::bigint;
    v_action := case v_kind when 'live' then 'vod_streams'
      when 'vod' then 'series_streams' else 'complete' end;
    v_progress := jsonb_build_object('version',1,'catalogVersion',v_catalog_version,
      'action',v_action,'actionComplete',case when v_action='complete' then true else false end,
      'cursor','','spoolToken','',
      'contentSha256',case when v_action='complete' then v_digest else '' end,
      'processedCategories',0,
      'processedItems',0,'observedItems',0,'categoryCount',0);
    select public.norva_checkpoint_active_catalog_title_refresh(
      v_source_id,v_user_id,v_generation_id,v_run_id,v_job_id,v_worker,v_lease_sequence,
      v_checkpoint_revision,v_head_revision,v_config_revision,v_source_epoch,v_user_epoch,
      v_progress,false,0
    ) into v_result;
    v_checkpoint_revision := (v_result->>'checkpointRevision')::bigint;
  end loop;
  perform public.norva_reconcile_active_catalog_title_projection_batch(
    v_source_id,v_user_id,v_generation_id,v_run_id,v_job_id,v_worker,v_lease_sequence,
    v_head_revision,v_config_revision,v_source_epoch,v_user_epoch,200
  );
  perform public.norva_mark_active_catalog_title_projection_refreshed(
    v_source_id,v_user_id,v_generation_id,v_run_id,v_job_id,v_worker,v_lease_sequence,
    v_head_revision,v_config_revision,v_source_epoch,v_user_epoch
  );
  insert into phase3_ctx values ('refresh2',jsonb_build_object('refreshRunId',v_run_id));
end
$post_switch_refresh_proof$;
savepoint phase3_happy_completion_probe;
select public.norva_complete_credential_transition(
  (select (value->>'transitionId')::uuid from phase3_ctx where key='create2'),
  '93000000-0000-4000-8000-000000000001',
  (select (value->>'job_id')::uuid from phase3_ctx where key='postclaim2'),
  'phase3-post-2',(select (value->>'lease_sequence')::integer from phase3_ctx where key='postclaim2'),
  (select revision from public.cloud_source_transitions where id=(select (value->>'transitionId')::uuid from phase3_ctx where key='create2')),
  1,(select (value->>'refreshRunId')::uuid from phase3_ctx where key='refresh2')
);
select extensions.ok(
  public.norva_get_credential_transition(
    (select (value->>'transitionId')::uuid from phase3_ctx where key='create2'),
    '93000000-0000-4000-8000-000000000001')->>'state'='COMPLETED'
  and (select config_ciphertext from public.cloud_sources where id='93000000-0000-4000-8000-000000000102')='ciphertext-b2'
  and public.norva_get_source_catalog_head(
    '93000000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000102')->>'activeGenerationId'
      =(select value->>'generationId' from phase3_ctx where key='allocate2'),
  'healthy post-switch verification completes with B config and B head stable'
);
do $post_switch_promotion$
declare v_result jsonb;
begin
  loop
    select public.norva_promote_credential_generation_titles_batch(
      (select (value->>'generationId')::uuid from phase3_ctx where key='allocate2'),
      '93000000-0000-4000-8000-000000000001',10
    ) into v_result;
    insert into phase3_ctx values ('promote2',v_result)
    on conflict (key) do update set value=excluded.value;
    exit when (v_result->>'complete')::boolean;
  end loop;
end
$post_switch_promotion$;
reset role;
select extensions.ok(
  (select (value->>'processedTitlesTotal')::integer=32
          and (value->>'complete')::boolean
   from phase3_ctx where key='promote2')
  and (select title='Candidate B 1'
          and metadata->>'providerTmdbId'='987654321'
       from public.catalog_titles
       where item_type='movie' and provider_tmdb_id='987654321')
  and (select metadata='{"candidate":"B"}'::jsonb
       from public.cloud_titles
       where user_id='93000000-0000-4000-8000-000000000001'
         and item_type='movie'
         and identity_key='provider:phase3-candidate-title')
  and (select post_switch_refreshed
       from public.cloud_source_catalog_generation_candidate_titles
       where generation_id=(select (value->>'generationId')::uuid
                            from phase3_ctx where key='allocate2')
          and item_type='movie'
          and identity_key='tmdb:987654321'),
  'terminal success publishes B globally without mutating its durable projection shell'
);
set local role service_role;
rollback to savepoint phase3_happy_completion_probe;
release savepoint phase3_happy_completion_probe;
reset role;
select extensions.ok(
  (select title='Phase 3 active title A'
          and poster_url is null
          and metadata='{}'::jsonb
   from public.catalog_titles
   where item_type='movie' and provider_tmdb_id='987654321')
  and (select metadata='{"candidate":"B"}'::jsonb
       from public.cloud_titles
       where user_id='93000000-0000-4000-8000-000000000001'
         and item_type='movie'
         and identity_key='provider:phase3-candidate-title'),
  'rolled-back terminal probe leaves A overlay and candidate metadata byte-stable'
);

-- Formal rollback/deletion concurrency tests need the production-built state
-- after the N -> N+1 swap, with the post-switch verification job still leased,
-- but before compensation mutates any durable row.  The default pgTAP run does
-- not set this variable and continues to the rollback assertions below.
\if :{?phase3_prepare_rollback_concurrency_fixture}
commit;
\quit
\endif

set local role service_role;
select public.norva_restore_previous_credential_config(
  (select (value->>'transitionId')::uuid from phase3_ctx where key='create2'),
  '93000000-0000-4000-8000-000000000001',(select (value->>'job_id')::uuid from phase3_ctx where key='postclaim2'),
  'phase3-post-2',(select (value->>'lease_sequence')::integer from phase3_ctx where key='postclaim2'),
  (select revision from public.cloud_source_transitions where id=(select (value->>'transitionId')::uuid from phase3_ctx where key='create2')),
  1,1,'candidate_catalog_unhealthy'
);
select extensions.is((select config_ciphertext from public.cloud_sources where id='93000000-0000-4000-8000-000000000102'),
  'ciphertext-a2','compensation restores A config before terminal failure');
select public.provider_account_touch_by_source(
  '93000000-0000-4000-8000-000000000102','rollback'
);
reset role;
select extensions.ok(
  exists(select 1 from public.provider_account_activity
    where account_key=repeat('b',64) and kind='rollback'),
  'rollback restores the previous opaque provider account affinity'
);
set local role service_role;
select extensions.throws_ok(
  format($sql$update public.cloud_media_items set title=title,
    write_head_revision=%s,write_config_revision=%s,
    write_source_visibility_epoch=%s,write_user_visibility_epoch=%s
    where source_id=%L and external_id='shared-001' and generation_id=%L$sql$,
    (select value->>'headRevision' from phase3_ctx where key='preswap2'),
    (select value->>'configRevision' from phase3_ctx where key='preswap2'),
    (select value->>'sourceVisibilityEpoch' from phase3_ctx where key='preswap2'),
    (select value->>'userVisibilityEpoch' from phase3_ctx where key='preswap2'),
    '93000000-0000-4000-8000-000000000102',
    (select value->>'generationId' from phase3_ctx where key='preswap2')
  ),
  '40001','active catalog write proof is stale or missing',
  'pre-cutover writer is rejected after A to B to A ABA rollback'
);
insert into phase3_ctx
select 'rollbackclaim2', to_jsonb(claim)
from public.norva_claim_credential_transition_jobs('phase3-rollback-2',1,120) claim;
select public.norva_finish_credential_compensation(
  (select (value->>'transitionId')::uuid from phase3_ctx where key='create2'),
  '93000000-0000-4000-8000-000000000001',(select (value->>'job_id')::uuid from phase3_ctx where key='rollbackclaim2'),
  'phase3-rollback-2',(select (value->>'lease_sequence')::integer from phase3_ctx where key='rollbackclaim2'),
  (select revision from public.cloud_source_transitions where id=(select (value->>'transitionId')::uuid from phase3_ctx where key='create2')),
  2,'93000000-0000-4000-8000-000000000902'
);
select extensions.is(public.norva_get_credential_transition(
  (select (value->>'transitionId')::uuid from phase3_ctx where key='create2'),
  '93000000-0000-4000-8000-000000000001')->>'state','FAILED',
  'rollback becomes FAILED only after leased old-generation health proof');
reset role;

select extensions.throws_ok(
  format('update public.cloud_source_transitions set state=''validating'' where id=%L',
    (select value->>'transitionId' from phase3_ctx where key='create')),
  '23514', 'terminal transition is immutable',
  'terminal credential transition cannot reopen'
);

select extensions.ok(
  position('active_generation_id' in
    pg_get_functiondef('public.norva_begin_credential_swap(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text,text)'::regprocedure)) > 0
  and position('post_switch_verify' in
    pg_get_functiondef('public.norva_begin_credential_swap(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text,text)'::regprocedure)) > 0,
  'begin swap performs the O(1) head flip and queues post-switch verification'
);

select extensions.ok(
  position('active_generation_id' in
    pg_get_functiondef('public.norva_restore_previous_credential_config(uuid,uuid,uuid,text,integer,bigint,bigint,bigint,text)'::regprocedure)) > 0
  and position('rollback_refresh' in
    pg_get_functiondef('public.norva_restore_previous_credential_config(uuid,uuid,uuid,text,integer,bigint,bigint,bigint,text)'::regprocedure)) > 0,
  'rollback restores head/config before durable old-generation verification'
);

update public.admin_feature_flags set enabled = false
where key = 'provider_credential_transition_v1_enabled';

select extensions.is(
  (select enabled from public.admin_feature_flags
   where key = 'provider_credential_transition_v1_enabled'),
  false,
  'credential transition flag is OFF at test end'
);

select * from extensions.finish();
rollback;
