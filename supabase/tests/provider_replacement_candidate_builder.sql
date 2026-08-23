begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select extensions.plan(12);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '93000000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  'replacement-builder@example.invalid', '', now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
);

insert into public.cloud_sources (
  id, user_id, source_type, display_name, config_ciphertext, config_hint,
  sync_status, catalog_version
) values
  ('93000000-0000-4000-8000-000000000101',
   '93000000-0000-4000-8000-000000000001', 'xtream', 'A', 'cipher-a',
   '{"serverHost":"a.builder.invalid","username":"builder-a"}'::jsonb, 'ready', 1),
  ('93000000-0000-4000-8000-000000000102',
   '93000000-0000-4000-8000-000000000001', 'xtream', 'B', 'cipher-b',
   '{"serverHost":"b.builder.invalid","username":"builder-b"}'::jsonb, 'ready', 1);

-- A has historical data before the online generation contract. B remains
-- empty until it is hidden/staged, which is the only legal starting point.
insert into public.cloud_media_items (
  id, user_id, source_id, item_type, external_id, title, dedup_key,
  is_dedup_primary, metadata, rating_num
) values (
  '93000000-0000-4000-8000-000000000401',
  '93000000-0000-4000-8000-000000000001',
  '93000000-0000-4000-8000-000000000101', 'movie', 'a-history', 'A history',
  'tmdb:930001', true, '{"providerTmdbId":"930001"}'::jsonb, 8
);

set local role service_role;
select public.norva_backfill_provider_access_foundation(100);
select public.norva_backfill_provider_access_foundation(100);
update public.cloud_source_lifecycle
set lifecycle_state = 'staging', catalog_visibility = 'hidden',
    replacement_root_id = '93000000-0000-4000-8000-000000000101',
    replaces_source_id = '93000000-0000-4000-8000-000000000101'
where source_id = '93000000-0000-4000-8000-000000000102';
select public.norva_backfill_source_provider_account_affinities(100);
select public.norva_backfill_source_provider_account_affinities(100);
select public.norva_discover_catalog_generation_backfill_sources(100);
do $backfill$
declare v_result jsonb;
begin
  for v_iteration in 1..64 loop
    v_result := public.norva_backfill_catalog_generation_batch('replacement-builder-test',500,120);
    exit when not coalesce((v_result ->> 'claimed')::boolean,false);
  end loop;
  if exists (select 1 from public.cloud_catalog_generation_backfill_sources where state <> 'complete') then
    raise exception 'generation backfill did not converge';
  end if;
end
$backfill$;
select public.norva_discover_catalog_generation_backfill_sources(100);
set local statement_timeout = '30s';
do $validate$
declare v_result jsonb;
begin
  for v_iteration in 1..32 loop
    v_result := public.norva_validate_catalog_generation_constraints(2);
    exit when (v_result ->> 'remaining')::integer = 0;
  end loop;
  if (v_result ->> 'remaining')::integer <> 0 then
    raise exception 'generation constraints were not validated';
  end if;
end
$validate$;
select public.norva_contract_catalog_generation_rollout('catalog-generation-writer-v2-live-clear-batch');
reset role;
alter table public.provider_account_activity validate constraint provider_account_activity_opaque_key_ck;
set local role service_role;
select public.norva_register_active_catalog_refresh_worker(
  'replacement-builder-test', 'credential-transition-worker-v3-active-catalog-refresh',
  'active-catalog-refresh-checkpoint-prune-v1'
);
reset role;
update public.admin_feature_flags set enabled = true where key = 'provider_replacement_v1_enabled';
set local role service_role;

insert into public.cloud_source_transitions (
  id, user_id, transition_kind, old_source_id, candidate_source_id,
  identity_decision, decision_origin, idempotency_key
) values (
  '93000000-0000-4000-8000-000000000601',
  '93000000-0000-4000-8000-000000000001', 'replacement',
  '93000000-0000-4000-8000-000000000101',
  '93000000-0000-4000-8000-000000000102', 'different_catalog',
  'automatic', 'replacement-builder-test'
);

do $builder$
declare v_claim record; v_allocation jsonb;
begin
  perform public.norva_begin_replacement_catalog_import(
    '93000000-0000-4000-8000-000000000601',
    '93000000-0000-4000-8000-000000000001', 0
  );
  select * into v_claim from public.norva_claim_replacement_catalog_build_jobs(
    'replacement-builder-test-worker', 1, 120
  );
  if not found then raise exception 'replacement builder did not claim its job'; end if;
  v_allocation := public.norva_allocate_replacement_catalog_generation(
    v_claim.transition_id, v_claim.user_id, v_claim.job_id,
    'replacement-builder-test-worker', v_claim.lease_sequence, v_claim.transition_revision
  );
  insert into public.cloud_media_items (
    id,user_id,source_id,item_type,external_id,title,dedup_key,is_dedup_primary,metadata,rating_num,
    generation_id,ingest_job_id,ingest_attempt,ingest_lease_owner
  ) values (
    '93000000-0000-4000-8000-000000000403', v_claim.user_id, v_claim.source_id,
    'movie','b-fenced','B fenced','tmdb:930003',true,'{}'::jsonb,9,
    (v_allocation ->> 'generationId')::uuid, v_claim.job_id,
    v_claim.lease_sequence, 'replacement-builder-test-worker'
  );
end
$builder$;

select extensions.is(
  (select state from public.cloud_source_transitions where id = '93000000-0000-4000-8000-000000000601'),
  'importing', 'replacement allocation reaches durable IMPORTING'
);
select extensions.is(
  (select source_id from public.cloud_source_catalog_generations
    where transition_id = '93000000-0000-4000-8000-000000000601'),
  '93000000-0000-4000-8000-000000000102'::uuid,
  'replacement generation belongs to hidden source B, never A'
);
select extensions.throws_ok(
  $sql$
    insert into public.cloud_media_items (
      id,user_id,source_id,item_type,external_id,title,dedup_key,is_dedup_primary,metadata,rating_num
    ) values (
      '93000000-0000-4000-8000-000000000402',
      '93000000-0000-4000-8000-000000000001',
      '93000000-0000-4000-8000-000000000102','movie','b-raw','raw','tmdb:930002',true,'{}'::jsonb,1
    )
  $sql$, '22004', 'explicit catalog generation is required',
  'staging B rejects an unfenced raw catalogue write'
);
reset role;
select extensions.is(
  (select count(*)::integer from public.cloud_media_items
   where id = '93000000-0000-4000-8000-000000000403'),
  1, 'B accepts the candidate write only with its current durable lease fence'
);
select extensions.is(
  (select source_id from public.cloud_source_credential_transition_jobs
   where transition_id = '93000000-0000-4000-8000-000000000601'),
  '93000000-0000-4000-8000-000000000102'::uuid,
  'the durable build job itself is bound to B'
);

-- A compact sealed fixture lets this test exercise the actual atomic A -> B
-- cutover without pretending that an unfenced staging write is enough.  The
-- exhaustive build/seal protocol itself is covered by provider_credential_transition.
reset role;
update public.cloud_source_catalog_generations
set state = 'ready', manifest_checksum = repeat('b',64),
    gateway_complete_at = now(), ready_at = now()
where transition_id = '93000000-0000-4000-8000-000000000601';
insert into public.cloud_source_identity_assessments (
  user_id,transition_id,algorithm_version,sample_size_old,sample_size_new,
  overlap_count,similarity_score,automatic_decision,final_decision,
  decision_origin,decided_at
) values (
  '93000000-0000-4000-8000-000000000001',
  '93000000-0000-4000-8000-000000000601','replacement-promotion-fixture-v1',
  32,32,0,0,'different_catalog','different_catalog','automatic',now()
);
set local role service_role;
select public.norva_mark_replacement_transition_ready(
  '93000000-0000-4000-8000-000000000601',
  '93000000-0000-4000-8000-000000000001',
  '93000000-0000-4000-8000-000000000701',
  (select revision from public.cloud_source_transitions
   where id = '93000000-0000-4000-8000-000000000601')
);
select extensions.throws_ok(
  format($sql$select public.norva_promote_source_replacement_v2(
    %L,%L,%L,%s,%s,%s
  )$sql$,
    '93000000-0000-4000-8000-000000000601',
    '93000000-0000-4000-8000-000000000001','replacement-promotion-v2-stale',
    (select expected_source_revision from public.cloud_source_transitions
     where id = '93000000-0000-4000-8000-000000000601'),
    (select revision from public.cloud_source_transitions
     where id = '93000000-0000-4000-8000-000000000601'),
    (select head_revision + 1 from public.cloud_source_catalog_heads
     where source_id = '93000000-0000-4000-8000-000000000102')
  ), '40001', 'replacement candidate head CAS failed',
  'stale candidate head loses before the atomic replacement cutover'
);
select public.norva_promote_source_replacement_v2(
  '93000000-0000-4000-8000-000000000601',
  '93000000-0000-4000-8000-000000000001','replacement-promotion-v2-fixture',
  (select expected_source_revision from public.cloud_source_transitions
   where id = '93000000-0000-4000-8000-000000000601'),
  (select revision from public.cloud_source_transitions
   where id = '93000000-0000-4000-8000-000000000601'),
  (select head_revision from public.cloud_source_catalog_heads
   where source_id = '93000000-0000-4000-8000-000000000102')
);
reset role;
select extensions.is(
  (select state from public.cloud_source_transitions
   where id = '93000000-0000-4000-8000-000000000601'),
  'completed', 'replacement v2 reaches terminal state through the atomic RPC'
);
select extensions.ok(
  (select lifecycle_state = 'replaced' and catalog_visibility = 'hidden'
   from public.cloud_source_lifecycle
   where source_id = '93000000-0000-4000-8000-000000000101')
  and (select lifecycle_state = 'active' and catalog_visibility = 'visible'
   from public.cloud_source_lifecycle
   where source_id = '93000000-0000-4000-8000-000000000102'),
  'promotion makes A hidden and B visible atomically'
);
select extensions.ok(
  (select head.active_generation_id = transition.candidate_catalog_generation_id
   from public.cloud_source_catalog_heads head
   join public.cloud_source_transitions transition
     on transition.candidate_source_id = head.source_id
   where transition.id = '93000000-0000-4000-8000-000000000601')
  and exists (
    select 1 from public.cloud_source_catalog_generations generation
    join public.cloud_source_transitions transition
      on transition.candidate_source_id = generation.source_id
    where transition.id = '93000000-0000-4000-8000-000000000601'
      and generation.id = transition.candidate_catalog_generation_id
      and generation.state = 'active'
  ), 'promotion makes the sealed B generation, not B genesis, its active head'
);
select extensions.is(
  (select state from public.cloud_source_catalog_generations
   where source_id = '93000000-0000-4000-8000-000000000102'
     and id <> (select candidate_catalog_generation_id
                from public.cloud_source_transitions
                where id = '93000000-0000-4000-8000-000000000601')),
  'retained', 'promotion retains B genesis instead of leaving two active generations'
);
set local role service_role;
select extensions.ok(
  (public.norva_promote_source_replacement_v2(
    '93000000-0000-4000-8000-000000000601',
    '93000000-0000-4000-8000-000000000001','replacement-promotion-v2-fixture',
    (select expected_source_revision from public.cloud_source_transitions
     where id = '93000000-0000-4000-8000-000000000601'),
    (select promotion_expected_transition_revision from public.cloud_source_transitions
     where id = '93000000-0000-4000-8000-000000000601'),
    (select head_revision - 1 from public.cloud_source_catalog_heads
     where source_id = '93000000-0000-4000-8000-000000000102')
  ) ->> 'candidateGenerationId') = (
    select candidate_catalog_generation_id::text from public.cloud_source_transitions
    where id = '93000000-0000-4000-8000-000000000601'
  ), 'exact promotion replay returns the same durable B head result'
);
select extensions.throws_ok(
  $sql$select public.norva_promote_source_replacement_v2(
    '93000000-0000-4000-8000-000000000601',
    '93000000-0000-4000-8000-000000000001','replacement-promotion-v2-fixture',
    0,3,1
  )$sql$, '40001', 'completed replacement candidate head replay CAS failed',
  'promotion replay rejects a mismatched candidate-head snapshot'
);
reset role;

select * from extensions.finish();
rollback;
