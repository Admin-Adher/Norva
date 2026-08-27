begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select extensions.plan(26);

insert into auth.users(
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) values (
  '94000000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  'replacement-handoff@example.invalid','',clock_timestamp(),
  '{}'::jsonb,'{}'::jsonb,clock_timestamp(),clock_timestamp()
);
insert into public.cloud_sources(
  id,user_id,source_type,display_name,config_ciphertext,config_hint,
  sync_status,catalog_version
) values (
  '94000000-0000-4000-8000-000000000101',
  '94000000-0000-4000-8000-000000000001','xtream','Provider A','cipher-a',
  '{"sourceType":"xtream","serverHost":"a.handoff.invalid","username":"user-a","hasPassword":true}'::jsonb,
  'ready',1
);
set local role service_role;
select public.norva_register_active_catalog_refresh_worker(
  'phase4-handoff-test','credential-transition-worker-v3-active-catalog-refresh',
  'active-catalog-refresh-checkpoint-prune-v1'
);
reset role;
update public.admin_feature_flags set enabled=true
where key in ('provider_credential_transition_v1_enabled','provider_replacement_v1_enabled');

-- Exact terminal Phase-3 handoff input: the encrypted candidate is immutable,
-- its generation is sealed, and its final assessment is DIFFERENT_CATALOG.
insert into public.cloud_source_transitions(
  id,user_id,transition_kind,old_source_id,state,idempotency_key,
  request_fingerprint,candidate_secret_ref,previous_secret_ref,
  expected_source_revision,created_by
) values (
  '94000000-0000-4000-8000-000000000201',
  '94000000-0000-4000-8000-000000000001','credential',
  '94000000-0000-4000-8000-000000000101','validating','phase4-origin',
  repeat('1',64),'credential-transition:phase4:candidate',
  'credential-transition:phase4:previous',0,'phase4-test'
);
insert into public.cloud_source_transition_secrets(
  transition_id,user_id,source_id,candidate_config_ciphertext,
  previous_config_ciphertext,candidate_config_hint,previous_config_hint,
  candidate_account_affinity_hash,previous_account_affinity_hash
) values (
  '94000000-0000-4000-8000-000000000201',
  '94000000-0000-4000-8000-000000000001',
  '94000000-0000-4000-8000-000000000101','cipher-b','cipher-a',
  '{"sourceType":"xtream","serverHost":"b.handoff.invalid","hasPassword":true}'::jsonb,
  '{"sourceType":"xtream","serverHost":"a.handoff.invalid","hasPassword":true}'::jsonb,
  repeat('b',64),repeat('a',64)
);
update public.cloud_source_transitions set state='staging'
where id='94000000-0000-4000-8000-000000000201';
update public.cloud_source_transitions set state='importing'
where id='94000000-0000-4000-8000-000000000201';
insert into public.cloud_source_catalog_generations(
  id,user_id,source_id,transition_id,config_revision,state,
  manifest_checksum,identity_evidence,gateway_complete_at,ready_at
) values (
  '94000000-0000-4000-8000-000000000301',
  '94000000-0000-4000-8000-000000000001',
  '94000000-0000-4000-8000-000000000101',
  '94000000-0000-4000-8000-000000000201',0,'ready',repeat('c',64),
  '{"complete":true,"sampleSize":32,"sample":[],"contentManifestChecksum":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}'::jsonb,
  clock_timestamp(),clock_timestamp()
);
insert into public.cloud_source_identity_assessments(
  user_id,transition_id,algorithm_version,sample_size_old,sample_size_new,
  overlap_count,similarity_score,secondary_signals,automatic_decision,
  final_decision,decision_origin,decided_at
) values (
  '94000000-0000-4000-8000-000000000001',
  '94000000-0000-4000-8000-000000000201','phase4-origin-v1',32,32,0,0,
  '{}'::jsonb,'different_catalog','different_catalog','automatic',clock_timestamp()
);
update public.cloud_source_transitions transition
set identity_decision='different_catalog',decision_origin='automatic',
    candidate_catalog_generation_id='94000000-0000-4000-8000-000000000301',
    previous_catalog_generation_id=head.active_generation_id,
    state='cancelled'
from public.cloud_source_catalog_heads head
where transition.id='94000000-0000-4000-8000-000000000201'
  and head.source_id=transition.old_source_id;

set local role service_role;
create temporary table phase4_ctx(key text primary key,value jsonb) on commit drop;
insert into phase4_ctx values ('create',public.norva_create_source_replacement_from_candidate(
  '94000000-0000-4000-8000-000000000001',
  '94000000-0000-4000-8000-000000000101',
  '94000000-0000-4000-8000-000000000201','phase4-replacement-create',
  repeat('d',64),0,'Provider B','user:phase4-test'
));

select extensions.is((select value->>'state' from phase4_ctx where key='create'),
  'STAGING','classified candidate handoff starts a durable staging replacement');
select extensions.is(
  (select value->>'replacementId' from phase4_ctx where key='create'),
  (select public.norva_create_source_replacement_from_candidate(
    '94000000-0000-4000-8000-000000000001',
    '94000000-0000-4000-8000-000000000101',
    '94000000-0000-4000-8000-000000000201','phase4-replacement-create',
    repeat('d',64),0,'Provider B','user:phase4-test')->>'replacementId'),
  'the exact handoff replay returns the same replacement');
reset role;

select extensions.ok((
  select lifecycle.lifecycle_state='staging'
    and lifecycle.catalog_visibility='hidden'
    and lifecycle.replacement_root_id='94000000-0000-4000-8000-000000000101'
    and lifecycle.replaces_source_id='94000000-0000-4000-8000-000000000101'
  from public.cloud_source_lifecycle lifecycle
  where lifecycle.source_id=(select (value->>'candidateSourceId')::uuid
    from phase4_ctx where key='create')
),'B is atomically committed as STAGING/HIDDEN on A logical root');
select extensions.is((select count(*)::integer
  from public.cloud_catalog_visible_sources
  where user_id='94000000-0000-4000-8000-000000000001'),1,
  'B staging does not count as a visible commercial source');
select extensions.is((select display_name from public.cloud_catalog_visible_sources
  where user_id='94000000-0000-4000-8000-000000000001'),
  'Provider A','A remains the only visible source before promotion');
select extensions.is((select config_ciphertext from public.cloud_sources
  where id=(select (value->>'candidateSourceId')::uuid from phase4_ctx where key='create')),
  'cipher-b','B receives the exact already-classified encrypted candidate');
select extensions.ok(exists(
  select 1 from public.cloud_source_replacement_origins origin
  where origin.replacement_transition_id=(select (value->>'replacementId')::uuid
      from phase4_ctx where key='create')
    and origin.credential_transition_id='94000000-0000-4000-8000-000000000201'
),'replacement keeps an immutable origin link to the classified candidate');
select extensions.ok(exists(
  select 1 from public.cloud_source_identity_assessments assessment
  where assessment.transition_id=(select (value->>'replacementId')::uuid
      from phase4_ctx where key='create')
    and assessment.final_decision='different_catalog'
    and assessment.decision_origin='automatic'
),'the final DIFFERENT_CATALOG proof is copied to the replacement');
select extensions.ok((select cleared_at is not null
  from public.cloud_source_transition_secrets
  where transition_id='94000000-0000-4000-8000-000000000201'),
  'the consumed credential candidate ciphertext is cleared');
select extensions.ok((select state='purging'
  from public.cloud_source_catalog_generations
  where id='94000000-0000-4000-8000-000000000301') and exists(
    select 1 from public.cloud_source_credential_transition_jobs
    where transition_id='94000000-0000-4000-8000-000000000201'
      and job_kind='purge_terminal_generation' and state='pending'
  ),'the consumed off-head Phase-3 generation enters bounded cleanup');
select extensions.ok((select secret.source_id=transition.candidate_source_id
    and secret.candidate_config_ciphertext='cipher-b'
  from public.cloud_source_transition_secrets secret
  join public.cloud_source_transitions transition on transition.id=secret.transition_id
  where transition.id=(select (value->>'replacementId')::uuid from phase4_ctx where key='create')),
  'replacement secret is immutable and bound to B');

set local role service_role;
select extensions.ok(not exists (
    select 1
    from public.norva_claim_credential_transition_jobs(
      'phase4-legacy-credential-worker',10,120,
      'credential-transition-worker-v2-title-cleanup'
    ) claim
    where claim.transition_id=(select (value->>'replacementId')::uuid
      from phase4_ctx where key='create')
  ),'credential claimant cannot lease a replacement build');
insert into phase4_ctx
select 'claim',to_jsonb(claim)
from public.norva_claim_replacement_catalog_build_jobs_v2('phase4-worker-1',1,120) claim;
select extensions.ok((select
    value->>'source_id'=(select value->>'candidateSourceId' from phase4_ctx where key='create')
    and value->>'comparison_source_id'='94000000-0000-4000-8000-000000000101'
    and value->>'transition_kind'='replacement'
  from phase4_ctx where key='claim'),
  'replacement claim binds writes to B and identity comparison to A');
insert into phase4_ctx values ('allocate',public.norva_allocate_replacement_catalog_generation(
  (select (value->>'replacementId')::uuid from phase4_ctx where key='create'),
  '94000000-0000-4000-8000-000000000001',
  (select (value->>'job_id')::uuid from phase4_ctx where key='claim'),
  'phase4-worker-1',(select (value->>'lease_sequence')::integer from phase4_ctx where key='claim'),
  (select (value->>'transition_revision')::bigint from phase4_ctx where key='claim')
));
select extensions.is((select state from public.cloud_source_transitions
  where id=(select (value->>'replacementId')::uuid from phase4_ctx where key='create')),
  'importing','replacement allocation reaches durable IMPORTING');
select extensions.is((select source_id from public.cloud_source_catalog_generations
  where id=(select (value->>'generationId')::uuid from phase4_ctx where key='allocate')),
  (select (value->>'candidateSourceId')::uuid from phase4_ctx where key='create'),
  'the replacement generation belongs only to B');
reset role;
select extensions.is((select copy.previous_generation_id
    from public.cloud_source_catalog_generation_episode_copy copy
    where copy.generation_id=(select (value->>'generationId')::uuid
      from phase4_ctx where key='allocate')),
  (select head.active_generation_id
    from public.cloud_source_catalog_heads head
    where head.source_id=(select (value->>'candidateSourceId')::uuid
      from phase4_ctx where key='create')),
  'replacement sealing compares B only with its own genesis head');
set local role service_role;
select extensions.is((select value->>'generationId'
    from phase4_ctx where key='allocate'),
  (select public.norva_get_replacement_catalog_generation(
      (select (value->>'replacementId')::uuid from phase4_ctx where key='create'),
      '94000000-0000-4000-8000-000000000001'::uuid)->>'generationId'),
  'replacement generation lookup is bound to the B head');
reset role;
select extensions.ok(position(
    'v_transition.old_source_id := v_transition.candidate_source_id'
    in pg_get_functiondef(
      'public.norva_seal_credential_catalog_generation(uuid,uuid,uuid,uuid,text,integer,bigint,bigint)'::regprocedure
    )
  )>0,'bounded manifest sealing selects B for replacement transitions');
set local role service_role;

select public.norva_mark_credential_category_list_complete(
  (select (value->>'replacementId')::uuid from phase4_ctx where key='create'),
  '94000000-0000-4000-8000-000000000001',
  (select (value->>'generationId')::uuid from phase4_ctx where key='allocate'),
  (select (value->>'job_id')::uuid from phase4_ctx where key='claim'),
  'phase4-worker-1',(select (value->>'lease_sequence')::integer from phase4_ctx where key='claim'),'live',0
);
select public.norva_mark_credential_category_list_complete(
  (select (value->>'replacementId')::uuid from phase4_ctx where key='create'),
  '94000000-0000-4000-8000-000000000001',
  (select (value->>'generationId')::uuid from phase4_ctx where key='allocate'),
  (select (value->>'job_id')::uuid from phase4_ctx where key='claim'),
  'phase4-worker-1',(select (value->>'lease_sequence')::integer from phase4_ctx where key='claim'),'vod',0
);
select public.norva_mark_credential_category_list_complete(
  (select (value->>'replacementId')::uuid from phase4_ctx where key='create'),
  '94000000-0000-4000-8000-000000000001',
  (select (value->>'generationId')::uuid from phase4_ctx where key='allocate'),
  (select (value->>'job_id')::uuid from phase4_ctx where key='claim'),
  'phase4-worker-1',(select (value->>'lease_sequence')::integer from phase4_ctx where key='claim'),'series',0
);
select public.norva_mark_credential_parent_action_complete(
  (select (value->>'replacementId')::uuid from phase4_ctx where key='create'),
  '94000000-0000-4000-8000-000000000001',
  (select (value->>'generationId')::uuid from phase4_ctx where key='allocate'),
  (select (value->>'job_id')::uuid from phase4_ctx where key='claim'),
  'phase4-worker-1',(select (value->>'lease_sequence')::integer from phase4_ctx where key='claim'),
  'live','get_live_streams',0
);
select public.norva_mark_credential_parent_action_complete(
  (select (value->>'replacementId')::uuid from phase4_ctx where key='create'),
  '94000000-0000-4000-8000-000000000001',
  (select (value->>'generationId')::uuid from phase4_ctx where key='allocate'),
  (select (value->>'job_id')::uuid from phase4_ctx where key='claim'),
  'phase4-worker-1',(select (value->>'lease_sequence')::integer from phase4_ctx where key='claim'),
  'vod','get_vod_streams',0
);
select public.norva_mark_credential_parent_action_complete(
  (select (value->>'replacementId')::uuid from phase4_ctx where key='create'),
  '94000000-0000-4000-8000-000000000001',
  (select (value->>'generationId')::uuid from phase4_ctx where key='allocate'),
  (select (value->>'job_id')::uuid from phase4_ctx where key='claim'),
  'phase4-worker-1',(select (value->>'lease_sequence')::integer from phase4_ctx where key='claim'),
  'series','get_series',0
);
insert into phase4_ctx values ('copy',public.norva_copy_credential_generation_episode_state(
  (select (value->>'replacementId')::uuid from phase4_ctx where key='create'),
  '94000000-0000-4000-8000-000000000001',
  (select (value->>'generationId')::uuid from phase4_ctx where key='allocate'),
  (select (value->>'job_id')::uuid from phase4_ctx where key='claim'),
  'phase4-worker-1',(select (value->>'lease_sequence')::integer from phase4_ctx where key='claim'),0,200
));
select extensions.is((select value->>'complete' from phase4_ctx where key='copy'),'true',
  'replacement episode state is copied only inside B');
select public.norva_checkpoint_credential_generation_job(
  (select (value->>'job_id')::uuid from phase4_ctx where key='claim'),
  '94000000-0000-4000-8000-000000000001','phase4-worker-1',
  (select (value->>'lease_sequence')::integer from phase4_ctx where key='claim'),0,
  '{"action":"complete","version":1,"typeIndex":7,"categoryOrdinal":0,"itemOffset":0,"categoryPageCursor":"","categoriesDone":true,"itemCursor":"","processedCategories":0,"processedItems":0}'::jsonb
);
insert into phase4_ctx
select 'sealclaim',to_jsonb(claim)
from public.norva_claim_replacement_catalog_build_jobs_v2('phase4-seal-worker',1,120) claim;
do $seal$
declare v_result jsonb:='{}'::jsonb; v_iteration integer;
begin
  for v_iteration in 1..32 loop
    v_result:=public.norva_seal_credential_catalog_generation(
      (select (value->>'replacementId')::uuid from phase4_ctx where key='create'),
      '94000000-0000-4000-8000-000000000001',
      (select (value->>'generationId')::uuid from phase4_ctx where key='allocate'),
      (select (value->>'job_id')::uuid from phase4_ctx where key='sealclaim'),
      'phase4-seal-worker',
      (select (value->>'lease_sequence')::integer from phase4_ctx where key='sealclaim'),
      (select (value->>'transition_revision')::bigint from phase4_ctx where key='sealclaim'),
      (select (public.norva_get_replacement_catalog_generation(
        (select (value->>'replacementId')::uuid from phase4_ctx where key='create'),
        '94000000-0000-4000-8000-000000000001')->>'generationRevision')::bigint)
    );
    exit when coalesce((v_result->>'complete')::boolean,false);
  end loop;
  if not coalesce((v_result->>'complete')::boolean,false) then
    raise exception 'replacement manifest seal did not complete within 32 slices';
  end if;
  insert into phase4_ctx values ('seal',v_result);
end
$seal$;
select extensions.is(public.norva_get_replacement_catalog_generation(
    (select (value->>'replacementId')::uuid from phase4_ctx where key='create'),
    '94000000-0000-4000-8000-000000000001')->>'generationState',
  'READY','bounded sealing makes the B generation READY');
insert into phase4_ctx values ('ready',public.norva_mark_replacement_transition_ready(
  (select (value->>'replacementId')::uuid from phase4_ctx where key='create'),
  '94000000-0000-4000-8000-000000000001',gen_random_uuid(),
  (select revision from public.cloud_source_transitions
    where id=(select (value->>'replacementId')::uuid from phase4_ctx where key='create'))
));
select extensions.is((select value->>'state' from phase4_ctx where key='ready'),
  'READY_TO_SWITCH','sealed B reaches READY_TO_SWITCH without reclassifying A');

select extensions.throws_ok(format($sql$select public.norva_allocate_replacement_catalog_generation(
  %L,%L,%L,%L,%s,%s)$sql$,
  (select value->>'replacementId' from phase4_ctx where key='create'),
  '94000000-0000-4000-8000-000000000001',
  (select value->>'job_id' from phase4_ctx where key='claim'),'phase4-worker-1',
  (select (value->>'lease_sequence')::integer from phase4_ctx where key='claim'),
  (select (value->>'transition_revision')::bigint from phase4_ctx where key='claim')),
  'PT409','replacement candidate generation CAS failed',
  'the pre-allocation worker snapshot is stale after IMPORTING');
insert into phase4_ctx values ('cancel',public.norva_cancel_source_replacement(
  (select (value->>'replacementId')::uuid from phase4_ctx where key='create'),
  '94000000-0000-4000-8000-000000000001','user:phase4-test',
  (select revision from public.cloud_source_transitions
    where id=(select (value->>'replacementId')::uuid from phase4_ctx where key='create')),
  'phase4-replacement-cancel',repeat('e',64)
));
reset role;
select extensions.is((select value->>'state' from phase4_ctx where key='cancel'),
  'CANCELLED','replacement cancellation reaches a durable terminal state');
select extensions.ok((select lifecycle.lifecycle_state='purge_pending'
    and lifecycle.catalog_visibility='hidden' and source.deleted_at is not null
    and not source.enabled and source.sync_status='disabled'
  from public.cloud_source_lifecycle lifecycle
  join public.cloud_sources source on source.id=lifecycle.source_id
  where lifecycle.source_id=(select (value->>'candidateSourceId')::uuid
    from phase4_ctx where key='create')),
  'cancellation retires B without mutating A');
select extensions.ok((select lifecycle_state='active' and catalog_visibility='visible'
  from public.cloud_source_lifecycle
  where source_id='94000000-0000-4000-8000-000000000101'),
  'A stays ACTIVE/VISIBLE after B cancellation');
select extensions.ok((select cleared_at is not null
  from public.cloud_source_transition_secrets
  where transition_id=(select (value->>'replacementId')::uuid from phase4_ctx where key='create')),
  'terminal replacement cancellation clears its copied ciphertext');

select * from extensions.finish();
rollback;
