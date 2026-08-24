begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select extensions.plan(30);
create temp table phase4_builder_ctx(key text primary key,value jsonb) on commit drop;
grant all on phase4_builder_ctx to service_role;

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

-- On a fresh rollout, A carries a historical pre-generation row so this test
-- still proves the online backfill.  On an already-contracted production clone
-- the same fixture must enter through the current active-generation write
-- fence; never weaken the guard merely to make a post-contraction smoke pass.
do $active_fixture$
begin
  if exists (
    select 1 from public.cloud_catalog_generation_rollout rollout
    where rollout.singleton and rollout.phase='contracted'
  ) then
    insert into public.cloud_media_items (
      id,user_id,source_id,item_type,external_id,title,dedup_key,
      is_dedup_primary,metadata,rating_num,generation_id,
      write_head_revision,write_config_revision,
      write_source_visibility_epoch,write_user_visibility_epoch
    )
    select
      '93000000-0000-4000-8000-000000000401',
      '93000000-0000-4000-8000-000000000001',
      '93000000-0000-4000-8000-000000000101','movie','a-history','A history',
      'tmdb:930001',true,'{"providerTmdbId":"930001"}'::jsonb,8,
      head.active_generation_id,head.head_revision,lifecycle.config_revision,
      lifecycle.visibility_epoch,epoch.visibility_epoch
    from public.cloud_source_catalog_heads head
    join public.cloud_source_lifecycle lifecycle
      on lifecycle.source_id=head.source_id and lifecycle.user_id=head.user_id
    join public.cloud_user_catalog_visibility_epochs epoch
      on epoch.user_id=head.user_id
    where head.source_id='93000000-0000-4000-8000-000000000101'
      and head.user_id='93000000-0000-4000-8000-000000000001';
  else
    insert into public.cloud_media_items (
      id,user_id,source_id,item_type,external_id,title,dedup_key,
      is_dedup_primary,metadata,rating_num
    ) values (
      '93000000-0000-4000-8000-000000000401',
      '93000000-0000-4000-8000-000000000001',
      '93000000-0000-4000-8000-000000000101','movie','a-history','A history',
      'tmdb:930001',true,'{"providerTmdbId":"930001"}'::jsonb,8
    );
  end if;
end
$active_fixture$;

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
select (phase <> 'contracted') as replacement_builder_needs_rollout
from public.cloud_catalog_generation_rollout where singleton
\gset
\if :replacement_builder_needs_rollout
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
\endif
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
\if :{?phase4_prepare_ready_fixture}
commit;
\quit
\endif
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
insert into phase4_builder_ctx values ('promotion',public.norva_promote_source_replacement_v3(
  '93000000-0000-4000-8000-000000000601',
  '93000000-0000-4000-8000-000000000001','replacement-promotion-v2-fixture',
  (select expected_source_revision from public.cloud_source_transitions
   where id = '93000000-0000-4000-8000-000000000601'),
  (select revision from public.cloud_source_transitions
   where id = '93000000-0000-4000-8000-000000000601'),
  (select head_revision from public.cloud_source_catalog_heads
   where source_id = '93000000-0000-4000-8000-000000000102')
));
reset role;
select extensions.is((select value->>'candidateSourceId' from phase4_builder_ctx where key='promotion'),
  '93000000-0000-4000-8000-000000000102',
  'promotion v3 returns the normalized durable replacement projection');
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
select extensions.ok((select purge_after=rollback_until and rollback_until>clock_timestamp()
  from public.cloud_source_lifecycle
  where source_id='93000000-0000-4000-8000-000000000101'),
  'promotion schedules A cleanup no earlier than the rollback deadline');
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

set local role service_role;
insert into phase4_builder_ctx values ('rollback',public.norva_rollback_source_replacement(
  '93000000-0000-4000-8000-000000000601',
  '93000000-0000-4000-8000-000000000001','user:replacement-rollback-test',
  'replacement-rollback-fixture',repeat('f',64),
  (select revision from public.cloud_source_transitions
    where id='93000000-0000-4000-8000-000000000601'),
  (select config_revision from public.cloud_source_lifecycle
    where source_id='93000000-0000-4000-8000-000000000102')
));
select extensions.is((select value->>'activeSourceId' from phase4_builder_ctx where key='rollback'),
  '93000000-0000-4000-8000-000000000101',
  'rollback restores A as the active source');
select extensions.is(
  public.norva_rollback_source_replacement(
    '93000000-0000-4000-8000-000000000601',
    '93000000-0000-4000-8000-000000000001','user:replacement-rollback-test',
    'replacement-rollback-fixture',repeat('f',64),
    (select revision from public.cloud_source_transitions
      where id='93000000-0000-4000-8000-000000000601'),
    1
  )->>'rollbackTransitionId',
  (select value->>'rollbackTransitionId' from phase4_builder_ctx where key='rollback'),
  'exact rollback replay returns the same compensating transition');
reset role;
select extensions.ok(
  (select lifecycle_state='active' and catalog_visibility='visible'
   from public.cloud_source_lifecycle
   where source_id='93000000-0000-4000-8000-000000000101')
  and (select lifecycle_state='replaced' and catalog_visibility='hidden'
   from public.cloud_source_lifecycle
   where source_id='93000000-0000-4000-8000-000000000102'),
  'rollback flips B hidden and A visible atomically');
select extensions.is((select count(*)::integer
  from public.cloud_catalog_visible_sources
  where user_id='93000000-0000-4000-8000-000000000001'),1,
  'rollback leaves exactly one commercially visible source');
select extensions.ok(exists(
  select 1 from public.cloud_source_transitions transition
  where transition.id=(select (value->>'rollbackTransitionId')::uuid
    from phase4_builder_ctx where key='rollback')
    and transition.reversal_of_transition_id='93000000-0000-4000-8000-000000000601'
    and transition.state='completed'),
  'rollback persists one terminal compensating transition linked to the original');
set local role service_role;
select extensions.is(public.norva_get_source_replacement(
    '93000000-0000-4000-8000-000000000601',
    '93000000-0000-4000-8000-000000000001')->>'rollbackTransitionId',
  (select value->>'rollbackTransitionId' from phase4_builder_ctx where key='rollback'),
  'replacement status exposes the durable completed rollback');
reset role;
select extensions.ok((select purge_after<=clock_timestamp()
  from public.cloud_source_lifecycle
  where source_id='93000000-0000-4000-8000-000000000102'),
  'rolled-back B becomes eligible for bounded cleanup');
select extensions.ok(
  (select state='completed' from public.cloud_source_transitions
   where id='93000000-0000-4000-8000-000000000601')
  and exists(
    select 1 from public.cloud_source_catalog_heads head
    join public.cloud_source_catalog_generations generation
      on generation.id=head.active_generation_id
    where head.source_id='93000000-0000-4000-8000-000000000101'
      and generation.state='active'),
  'rollback preserves the original audit record and A active catalog head');
set local role service_role;
select extensions.throws_ok(format($sql$select public.norva_rollback_source_replacement(
  %L,%L,%L,%L,%L,%s,%s)$sql$,
  '93000000-0000-4000-8000-000000000601',
  '93000000-0000-4000-8000-000000000001','user:replacement-rollback-test',
  'replacement-rollback-second',repeat('e',64),
  (select revision from public.cloud_source_transitions
    where id='93000000-0000-4000-8000-000000000601'),1),
  '40001','replacement rollback endpoints changed',
  'a second rollback cannot resurrect B after compensation');
reset role;

select extensions.ok(
  (select state='cancelled' from public.cloud_source_replacement_cleanup_jobs
   where transition_id='93000000-0000-4000-8000-000000000601')
  and (select state='pending' and source_id='93000000-0000-4000-8000-000000000102'
   from public.cloud_source_replacement_cleanup_jobs
   where transition_id=(select (value->>'rollbackTransitionId')::uuid
     from phase4_builder_ctx where key='rollback')),
  'rollback cancels A cleanup and schedules B cleanup');
-- The cleanup worker is a global oldest-due claimant. Keep this harness
-- deterministic even on an intentionally dirty proof database by deferring
-- unrelated pending fixtures inside this transaction only.
update public.cloud_source_replacement_cleanup_jobs
set available_at=clock_timestamp()+interval '1 hour'
where state='pending'
  and transition_id<>(select (value->>'rollbackTransitionId')::uuid
    from phase4_builder_ctx where key='rollback');
update public.cloud_source_replacement_cleanup_jobs
set available_at=clock_timestamp()
where transition_id=(select (value->>'rollbackTransitionId')::uuid
  from phase4_builder_ctx where key='rollback');
set local role service_role;
insert into phase4_builder_ctx values ('cleanupPrepare',
  public.norva_run_replacement_cleanup_batch('phase4-cleanup-test',200));
select extensions.is((select value->>'waitingForReaper'
    from phase4_builder_ctx where key='cleanupPrepare'),'true',
  'cleanup first soft-deletes B and waits for the bounded source reaper');
reset role;
select extensions.ok(
  (select lifecycle_state='purge_pending' and catalog_visibility='hidden'
   from public.cloud_source_lifecycle
   where source_id='93000000-0000-4000-8000-000000000102')
  and (select deleted_at is not null
       from public.cloud_sources
       where id='93000000-0000-4000-8000-000000000102'),
  'cleanup durably enters hidden PURGE_PENDING before the source reaper');
update public.cloud_source_replacement_cleanup_jobs
set available_at=clock_timestamp()
where transition_id=(select (value->>'rollbackTransitionId')::uuid
  from phase4_builder_ctx where key='rollback');
call public.reap_deleted_sources();
select extensions.ok((select provider_deletion_pending
  from public.cloud_sources
  where id='93000000-0000-4000-8000-000000000102'),
  'bounded source reaper drains B core rows and marks its tombstone');
set local role service_role;
insert into phase4_builder_ctx values ('cleanupFinal',
  public.norva_run_replacement_cleanup_batch('phase4-cleanup-test',200));
select extensions.is((select value->>'complete'
    from phase4_builder_ctx where key='cleanupFinal'),'true',
  'replacement cleanup converges to a terminal completed batch');
reset role;
select extensions.ok((select lifecycle.lifecycle_state='purged'
    and lifecycle.catalog_visibility='hidden'
    and source.config_ciphertext is null
    and source.config_hint='{}'::jsonb
    and source.deleted_at is not null and not source.enabled
  from public.cloud_sources source
  join public.cloud_source_lifecycle lifecycle on lifecycle.source_id=source.id
  where source.id='93000000-0000-4000-8000-000000000102'),
  'final cleanup irreversibly sanitizes B credentials and lifecycle');
select extensions.ok(
  exists(select 1 from public.cloud_source_transitions
    where id='93000000-0000-4000-8000-000000000601' and state='completed')
  and exists(select 1 from public.cloud_source_transitions
    where id=(select (value->>'rollbackTransitionId')::uuid
      from phase4_builder_ctx where key='rollback') and state='completed')
  and exists(select 1 from public.cloud_source_catalog_generations
    where source_id='93000000-0000-4000-8000-000000000102'),
  'cleanup retains transition and generation metadata as audit evidence');

select * from extensions.finish();
rollback;
