begin;
set local lock_timeout='2s';
set local statement_timeout='30s';

create or replace function public.norva_replacement_transition_result(
  p_transition_id uuid,
  p_user_id uuid
) returns jsonb
language sql
stable
security definer
set search_path=''
as $function$
  select jsonb_build_object(
    'replacementId',transition.id,
    'oldSourceId',transition.old_source_id,
    'candidateSourceId',transition.candidate_source_id,
    'state',upper(transition.state),
    'comparison',case when transition.identity_decision is null then null
      else upper(transition.identity_decision) end,
    'decisionOrigin',case when transition.decision_origin is null then null
      else upper(transition.decision_origin) end,
    'revision',transition.revision,
    'expectedSourceRevision',transition.expected_source_revision,
    'expectedCandidateRevision',transition.expected_candidate_revision,
    'candidateGenerationId',transition.candidate_catalog_generation_id,
    'readinessCheckId',transition.readiness_check_id,
    'readinessPassedAt',transition.readiness_passed_at,
    'rollbackUntil',transition.rollback_until,
    'rollbackTransitionId',rollback.id,
    'rolledBackAt',rollback.completed_at,
    'startedAt',transition.started_at,
    'readyAt',transition.ready_at,
    'completedAt',transition.completed_at,
    'failureCode',transition.failure_code
  )
  from public.cloud_source_transitions transition
  left join lateral (
    select reversal.id,reversal.completed_at
    from public.cloud_source_transitions reversal
    where reversal.user_id=transition.user_id
      and reversal.reversal_of_transition_id=transition.id
      and reversal.state='completed'
    order by reversal.completed_at desc,reversal.id
    limit 1
  ) rollback on true
  where transition.id=p_transition_id and transition.user_id=p_user_id
    and transition.transition_kind='replacement'
$function$;

-- V3 keeps the audited v2 head+lifecycle cutover, then completes the terminal
-- secret and retention bookkeeping in the same transaction.
create or replace function public.norva_promote_source_replacement_v3(
  p_transition_id uuid,
  p_user_id uuid,
  p_idempotency_key text,
  p_expected_source_revision bigint,
  p_expected_transition_revision bigint,
  p_expected_candidate_head_revision bigint
) returns jsonb
language plpgsql
volatile
security definer
set search_path=''
as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_result jsonb;
begin
  v_result:=public.norva_promote_source_replacement_v2(
    p_transition_id,p_user_id,p_idempotency_key,p_expected_source_revision,
    p_expected_transition_revision,p_expected_candidate_head_revision
  );
  select transition.* into v_transition
  from public.cloud_source_transitions transition
  where transition.id=p_transition_id and transition.user_id=p_user_id
  for update;
  if not found or v_transition.transition_kind<>'replacement'
     or v_transition.state<>'completed' then
    raise exception 'replacement promotion v3 terminal CAS failed' using errcode='40001';
  end if;
  perform public.norva_clear_terminal_credential_secrets(
    p_transition_id,p_user_id,v_transition.revision
  );
  update public.cloud_source_lifecycle lifecycle
  set purge_after=coalesce(lifecycle.purge_after,lifecycle.rollback_until),
      updated_at=clock_timestamp()
  where lifecycle.source_id=v_transition.old_source_id
    and lifecycle.user_id=p_user_id
    and lifecycle.lifecycle_state='replaced'
    and lifecycle.catalog_visibility='hidden';
  if not found then
    raise exception 'replacement promotion v3 retention CAS failed' using errcode='40001';
  end if;
  return public.norva_replacement_transition_result(p_transition_id,p_user_id)
    || jsonb_build_object(
      'candidateGenerationId',v_transition.candidate_catalog_generation_id,
      'candidateHeadRevision',v_result->'candidateHeadRevision',
      'visibilityEpoch',v_result->'visibilityEpoch',
      'replayed',coalesce((v_result->>'replayed')::boolean,false)
    );
end
$function$;

create or replace function public.norva_rollback_source_replacement(
  p_transition_id uuid,
  p_user_id uuid,
  p_actor text,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_expected_transition_revision bigint,
  p_expected_active_source_revision bigint
) returns jsonb
language plpgsql
volatile
security definer
set search_path=''
as $function$
declare
  v_original public.cloud_source_transitions%rowtype;
  v_existing public.cloud_source_transitions%rowtype;
  v_reverse_id uuid:=gen_random_uuid();
  v_active_source public.cloud_sources%rowtype;
  v_retained_source public.cloud_sources%rowtype;
  v_active public.cloud_source_lifecycle%rowtype;
  v_retained public.cloud_source_lifecycle%rowtype;
  v_visibility_epoch bigint;
  v_result jsonb;
begin
  perform public.norva_replacement_require_enabled();
  if p_actor is null or btrim(p_actor)='' or length(p_actor)>200
     or p_idempotency_key is null or btrim(p_idempotency_key)=''
     or length(p_idempotency_key)>200
     or p_request_fingerprint is null
     or p_request_fingerprint!~'^[0-9a-f]{64}$'
     or p_expected_transition_revision is null or p_expected_transition_revision<0
     or p_expected_active_source_revision is null
     or p_expected_active_source_revision<0 then
    raise exception 'replacement rollback input is invalid' using errcode='22023';
  end if;
  perform public.norva_credential_lock_account(p_user_id);
  select transition.* into v_existing
  from public.cloud_source_transitions transition
  where transition.user_id=p_user_id
    and transition.idempotency_key=p_idempotency_key
  for update;
  if found then
    if v_existing.transition_kind='replacement'
       and v_existing.reversal_of_transition_id=p_transition_id
       and v_existing.request_fingerprint=p_request_fingerprint
       and v_existing.state='completed'
       and v_existing.promotion_result is not null then
      return v_existing.promotion_result||jsonb_build_object('replayed',true);
    end if;
    raise exception 'replacement rollback idempotency key reused'
      using errcode='22023';
  end if;
  select transition.* into v_original
  from public.cloud_source_transitions transition
  where transition.id=p_transition_id and transition.user_id=p_user_id
  for update;
  if not found then
    raise exception 'replacement transition not found' using errcode='P0002';
  end if;
  if v_original.transition_kind<>'replacement'
     or v_original.reversal_of_transition_id is not null
     or v_original.state<>'completed'
     or v_original.revision<>p_expected_transition_revision
     or v_original.rollback_until is null
     or v_original.rollback_until<clock_timestamp() then
    raise exception 'replacement rollback CAS failed' using errcode='40001';
  end if;
  perform 1 from public.cloud_sources source
  where source.id in (v_original.old_source_id,v_original.candidate_source_id)
    and source.user_id=p_user_id order by source.id for update;
  perform 1 from public.cloud_source_lifecycle lifecycle
  where lifecycle.source_id in (v_original.old_source_id,v_original.candidate_source_id)
    and lifecycle.user_id=p_user_id order by lifecycle.source_id for update;
  select source.* into v_active_source from public.cloud_sources source
  where source.id=v_original.candidate_source_id and source.user_id=p_user_id;
  select source.* into v_retained_source from public.cloud_sources source
  where source.id=v_original.old_source_id and source.user_id=p_user_id;
  select lifecycle.* into v_active from public.cloud_source_lifecycle lifecycle
  where lifecycle.source_id=v_original.candidate_source_id
    and lifecycle.user_id=p_user_id;
  select lifecycle.* into v_retained from public.cloud_source_lifecycle lifecycle
  where lifecycle.source_id=v_original.old_source_id
    and lifecycle.user_id=p_user_id;
  if v_active_source.id is null or v_retained_source.id is null
     or v_active_source.deleted_at is not null or not v_active_source.enabled
     or v_retained_source.deleted_at is not null or not v_retained_source.enabled
     or v_active.lifecycle_state<>'active'
     or v_active.catalog_visibility<>'visible'
     or v_active.config_revision<>p_expected_active_source_revision
     or v_retained.lifecycle_state<>'replaced'
     or v_retained.catalog_visibility<>'hidden'
     or v_retained.replaced_by_source_id<>v_active.source_id
     or not exists (
       select 1
       from public.cloud_source_catalog_heads head
       join public.cloud_source_catalog_generations generation
         on generation.id=head.active_generation_id
        and generation.source_id=head.source_id
        and generation.user_id=head.user_id
       where head.source_id=v_retained.source_id and head.user_id=p_user_id
         and generation.state='active'
     ) then
    raise exception 'replacement rollback endpoints changed' using errcode='40001';
  end if;

  insert into public.cloud_source_transitions(
    id,user_id,transition_kind,old_source_id,candidate_source_id,
    state,identity_decision,decision_origin,idempotency_key,
    request_fingerprint,expected_catalog_version,reversal_of_transition_id,
    created_by,approved_by
  ) values (
    v_reverse_id,p_user_id,'replacement',v_active.source_id,
    v_retained.source_id,'validating','different_catalog','manual',
    p_idempotency_key,p_request_fingerprint,v_retained_source.catalog_version,
    v_original.id,p_actor,p_actor
  );
  insert into public.cloud_source_identity_assessments(
    user_id,transition_id,algorithm_version,sample_size_old,sample_size_new,
    overlap_count,similarity_score,secondary_signals,automatic_decision,
    final_decision,decision_origin,decided_at,decided_by
  ) values (
    p_user_id,v_reverse_id,'replacement-rollback-v1',0,0,0,0,
    jsonb_build_object('reason','user_requested_rollback',
      'reversalOfTransitionId',v_original.id),
    'ambiguous','different_catalog','manual',clock_timestamp(),p_actor
  );
  update public.cloud_source_transitions set state='staging'
    where id=v_reverse_id;
  update public.cloud_source_transitions set state='importing'
    where id=v_reverse_id;
  update public.cloud_source_transitions
  set state='ready_to_switch',readiness_check_id=gen_random_uuid(),
      readiness_passed_at=clock_timestamp()
  where id=v_reverse_id;
  update public.cloud_source_transitions
  set state='committing',promotion_idempotency_key=p_idempotency_key,
      promotion_expected_source_revision=p_expected_active_source_revision,
      promotion_expected_transition_revision=3
  where id=v_reverse_id;

  perform set_config('norva.skip_visibility_epoch_bump','on',true);
  v_visibility_epoch:=public.norva_bump_user_catalog_visibility_epoch(p_user_id);
  update public.cloud_source_lifecycle lifecycle
  set lifecycle_state='replaced',catalog_visibility='hidden',
      replaces_source_id=null,replaced_by_source_id=v_retained.source_id,
      hidden_at=clock_timestamp(),rollback_until=null,
      purge_after=clock_timestamp(),
      config_revision=lifecycle.config_revision+1,
      visibility_epoch=v_visibility_epoch,updated_at=clock_timestamp()
  where lifecycle.source_id=v_active.source_id and lifecycle.user_id=p_user_id
    and lifecycle.lifecycle_state='active'
    and lifecycle.catalog_visibility='visible'
    and lifecycle.config_revision=p_expected_active_source_revision;
  if not found then
    raise exception 'replacement rollback active endpoint CAS failed' using errcode='40001';
  end if;
  update public.cloud_source_lifecycle lifecycle
  set lifecycle_state='active',catalog_visibility='visible',
      replaces_source_id=v_active.source_id,replaced_by_source_id=null,
      activated_at=clock_timestamp(),hidden_at=null,rollback_until=null,
      purge_after=null,config_revision=lifecycle.config_revision+1,
      visibility_epoch=v_visibility_epoch,updated_at=clock_timestamp()
  where lifecycle.source_id=v_retained.source_id and lifecycle.user_id=p_user_id
    and lifecycle.lifecycle_state='replaced'
    and lifecycle.catalog_visibility='hidden';
  if not found then
    raise exception 'replacement rollback retained endpoint CAS failed' using errcode='40001';
  end if;
  perform set_config('norva.skip_visibility_epoch_bump','off',true);

  v_result:=jsonb_build_object(
    'replacementId',v_original.id,
    'rollbackTransitionId',v_reverse_id,
    'state','COMPLETED',
    'activeSourceId',v_retained.source_id,
    'retiredSourceId',v_active.source_id,
    'visibilityEpoch',v_visibility_epoch,
    'replayed',false
  );
  update public.cloud_source_transitions transition
  set state='completed',promotion_result=v_result
  where transition.id=v_reverse_id and transition.state='committing';
  if not found then
    raise exception 'replacement rollback completion CAS failed' using errcode='40001';
  end if;
  insert into public.cloud_source_lifecycle_events(
    user_id,source_id,transition_id,event_kind,idempotency_key,payload,actor
  ) values
  (p_user_id,v_retained.source_id,v_reverse_id,'replacement_rolled_back',
    'rollback:'||v_reverse_id::text||':restored',
    jsonb_build_object('retiredSourceId',v_active.source_id,
      'visibilityEpoch',v_visibility_epoch),p_actor),
  (p_user_id,v_active.source_id,v_reverse_id,'replacement_rollback_retired',
    'rollback:'||v_reverse_id::text||':retired',
    jsonb_build_object('restoredSourceId',v_retained.source_id,
      'visibilityEpoch',v_visibility_epoch),p_actor);
  delete from public.cloud_catalog_facet_summary summary
  where summary.user_id=p_user_id;
  return v_result;
end
$function$;

revoke all on function public.norva_promote_source_replacement_v3(
  uuid,uuid,text,bigint,bigint,bigint
),public.norva_rollback_source_replacement(
  uuid,uuid,text,text,text,bigint,bigint
) from public,anon,authenticated;
grant execute on function public.norva_promote_source_replacement_v3(
  uuid,uuid,text,bigint,bigint,bigint
),public.norva_rollback_source_replacement(
  uuid,uuid,text,text,text,bigint,bigint
) to service_role;

commit;
