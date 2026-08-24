begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- Phase 4 starts only from the exact encrypted credential candidate that was
-- classified DIFFERENT_CATALOG.  This durable link makes that handoff
-- auditable without copying a credential or its HMAC into observability.
create table public.cloud_source_replacement_origins (
  replacement_transition_id uuid primary key,
  credential_transition_id uuid not null unique,
  user_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint cloud_source_replacement_origins_replacement_fk
    foreign key (user_id,replacement_transition_id)
    references public.cloud_source_transitions(user_id,id)
    on update cascade on delete restrict,
  constraint cloud_source_replacement_origins_credential_fk
    foreign key (user_id,credential_transition_id)
    references public.cloud_source_transitions(user_id,id)
    on update cascade on delete restrict,
  constraint cloud_source_replacement_origins_distinct_ck
    check (replacement_transition_id<>credential_transition_id)
);
alter table public.cloud_source_replacement_origins enable row level security;
revoke all on table public.cloud_source_replacement_origins
  from public,anon,authenticated,service_role;

-- Replacement workers need the same encrypted candidate bytes as the
-- classifier consumed.  The row is bound to B, never A, and remains immutable;
-- terminal clearance is still the only permitted ciphertext mutation.
create or replace function public.norva_credential_secret_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_expected_source_id uuid;
begin
  if tg_op = 'DELETE' then
    raise exception 'provider transition secrets cannot be deleted'
      using errcode = '42501';
  end if;
  select transition.* into v_transition
  from public.cloud_source_transitions transition
  where transition.id=new.transition_id and transition.user_id=new.user_id;
  v_expected_source_id := case v_transition.transition_kind
    when 'credential' then v_transition.old_source_id
    when 'replacement' then v_transition.candidate_source_id
    else null
  end;
  if not found or v_expected_source_id is distinct from new.source_id then
    raise exception 'secret row must belong to its provider transition source'
      using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' then
    if new.transition_id is distinct from old.transition_id
       or new.user_id is distinct from old.user_id
       or new.source_id is distinct from old.source_id
       or new.created_at is distinct from old.created_at
       or new.retain_until < old.retain_until
       or (new.swap_applied_at is distinct from old.swap_applied_at
           and old.swap_applied_at is not null)
       or (new.candidate_refresh_healthy_at is distinct from old.candidate_refresh_healthy_at
           and old.candidate_refresh_healthy_at is not null)
       or (new.compensation_started_at is distinct from old.compensation_started_at
           and old.compensation_started_at is not null)
       or (new.previous_config_restored_at is distinct from old.previous_config_restored_at
           and old.previous_config_restored_at is not null)
       or (new.rollback_refresh_healthy_at is distinct from old.rollback_refresh_healthy_at
           and old.rollback_refresh_healthy_at is not null) then
      raise exception 'provider transition secret evidence is immutable'
        using errcode = '23514';
    end if;
    if new.candidate_config_ciphertext is distinct from old.candidate_config_ciphertext
       or new.previous_config_ciphertext is distinct from old.previous_config_ciphertext
       or new.candidate_config_hint is distinct from old.candidate_config_hint
       or new.previous_config_hint is distinct from old.previous_config_hint
       or new.cleared_at is distinct from old.cleared_at then
      if current_setting('norva.credential_secret_clear',true) is distinct from 'on'
         or old.cleared_at is not null
         or new.candidate_config_ciphertext is not null
         or new.previous_config_ciphertext is not null
         or new.candidate_config_hint is not null
         or new.previous_config_hint is not null
         or new.cleared_at is null
         or v_transition.state not in ('completed','failed','cancelled') then
        raise exception 'provider ciphertexts may only be cleared after terminal state'
          using errcode = '42501';
      end if;
    end if;
  end if;
  new.updated_at := clock_timestamp();
  return new;
end
$function$;

-- Terminal secret cleanup is shared by credential and replacement
-- transitions.  A cancelled replacement must carry its own append-only
-- lifecycle action; a credential cancellation keeps its historical action
-- fence.  This prevents a caller from using terminal state alone to erase a
-- still-recoverable candidate.
create or replace function public.norva_clear_terminal_credential_secrets(
  p_transition_id uuid,
  p_user_id uuid,
  p_expected_transition_revision bigint
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
begin
  perform public.norva_credential_require_service_role();
  select transition.* into v_transition
  from public.cloud_source_transitions transition
  where transition.id=p_transition_id and transition.user_id=p_user_id
  for update;
  if not found then
    raise exception 'provider transition not found' using errcode='P0002';
  end if;
  if v_transition.state not in ('completed','failed','cancelled')
     or v_transition.revision<>p_expected_transition_revision
     or (
       v_transition.state='cancelled'
       and not (
         (
           v_transition.transition_kind='credential'
           and exists (
             select 1
             from public.cloud_source_credential_transition_actions action
             where action.transition_id=v_transition.id
               and action.user_id=v_transition.user_id
               and action.action_kind in ('cancel','replacement_handoff_consumed')
           )
         )
         or (
           v_transition.transition_kind='replacement'
           and exists (
             select 1
             from public.cloud_source_lifecycle_events event
             where event.transition_id=v_transition.id
               and event.user_id=v_transition.user_id
               and event.event_kind='replacement_cancelled'
           )
         )
       )
     ) then
    raise exception 'terminal secret clearance CAS failed' using errcode='40001';
  end if;
  perform set_config('norva.credential_secret_clear','on',true);
  update public.cloud_source_transition_secrets secret
  set candidate_config_ciphertext=null,
      previous_config_ciphertext=null,
      candidate_config_hint=null,
      previous_config_hint=null,
      cleared_at=coalesce(secret.cleared_at,clock_timestamp())
  where secret.transition_id=p_transition_id and secret.user_id=p_user_id
    and secret.cleared_at is null;
  perform set_config('norva.credential_secret_clear','off',true);
  return jsonb_build_object(
    'transitionId',p_transition_id,
    'state',upper(v_transition.state),
    'secretsCleared',true
  );
end
$function$;

create or replace function public.norva_replacement_transition_result(
  p_transition_id uuid,
  p_user_id uuid
) returns jsonb
language sql
stable
security definer
set search_path = ''
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
    'startedAt',transition.started_at,
    'readyAt',transition.ready_at,
    'completedAt',transition.completed_at,
    'failureCode',transition.failure_code
  )
  from public.cloud_source_transitions transition
  where transition.id=p_transition_id and transition.user_id=p_user_id
    and transition.transition_kind='replacement'
$function$;

create or replace function public.norva_get_source_replacement(
  p_transition_id uuid,
  p_user_id uuid
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare v_result jsonb;
begin
  perform public.norva_credential_require_service_role();
  v_result:=public.norva_replacement_transition_result(p_transition_id,p_user_id);
  if v_result is null then
    raise exception 'replacement transition not found' using errcode='P0002';
  end if;
  return v_result;
end
$function$;

create or replace function public.norva_create_source_replacement_from_candidate(
  p_user_id uuid,
  p_source_id uuid,
  p_credential_transition_id uuid,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_expected_source_revision bigint,
  p_display_name text,
  p_actor text
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_existing public.cloud_source_transitions%rowtype;
  v_origin public.cloud_source_transitions%rowtype;
  v_source public.cloud_sources%rowtype;
  v_lifecycle public.cloud_source_lifecycle%rowtype;
  v_secret public.cloud_source_transition_secrets%rowtype;
  v_assessment public.cloud_source_identity_assessments%rowtype;
  v_candidate_generation public.cloud_source_catalog_generations%rowtype;
  v_replacement_id uuid:=gen_random_uuid();
  v_candidate_source_id uuid:=gen_random_uuid();
  v_result jsonb;
begin
  perform public.norva_replacement_require_enabled();
  if p_user_id is null or p_source_id is null or p_credential_transition_id is null
     or p_idempotency_key is null or btrim(p_idempotency_key)=''
     or length(p_idempotency_key)>200
     or p_request_fingerprint is null
     or p_request_fingerprint!~'^[0-9a-f]{64}$'
     or p_expected_source_revision is null or p_expected_source_revision<0
     or p_display_name is null or btrim(p_display_name)=''
     or length(p_display_name)>160
     or p_actor is null or btrim(p_actor)='' or length(p_actor)>200 then
    raise exception 'replacement handoff input is invalid' using errcode='22023';
  end if;
  perform public.norva_credential_lock_account(p_user_id);
  select transition.* into v_existing
  from public.cloud_source_transitions transition
  where transition.user_id=p_user_id and transition.idempotency_key=p_idempotency_key
  for update;
  if found then
    if v_existing.transition_kind='replacement'
       and v_existing.old_source_id=p_source_id
       and v_existing.request_fingerprint=p_request_fingerprint
       and exists (
         select 1 from public.cloud_source_replacement_origins origin
         where origin.replacement_transition_id=v_existing.id
           and origin.credential_transition_id=p_credential_transition_id
           and origin.user_id=p_user_id
       ) then
      return public.norva_replacement_transition_result(v_existing.id,p_user_id)
        || jsonb_build_object('replayed',true);
    end if;
    raise exception 'replacement idempotency key reused with different request'
      using errcode='22023';
  end if;
  select source.* into v_source from public.cloud_sources source
  where source.id=p_source_id and source.user_id=p_user_id for update;
  select lifecycle.* into v_lifecycle from public.cloud_source_lifecycle lifecycle
  where lifecycle.source_id=p_source_id and lifecycle.user_id=p_user_id for update;
  if v_source.id is null or v_source.deleted_at is not null or not v_source.enabled
     or v_source.source_type<>'xtream'
     or v_lifecycle.lifecycle_state<>'active'
     or v_lifecycle.catalog_visibility<>'visible'
     or v_lifecycle.config_revision<>p_expected_source_revision then
    raise exception 'replacement source snapshot CAS failed' using errcode='40001';
  end if;
  select transition.* into v_origin from public.cloud_source_transitions transition
  where transition.id=p_credential_transition_id and transition.user_id=p_user_id
  for update;
  if not found or v_origin.transition_kind<>'credential'
     or v_origin.old_source_id<>p_source_id
     or v_origin.state<>'cancelled'
     or v_origin.identity_decision<>'different_catalog'
     or v_origin.decision_origin not in ('automatic','manual') then
    raise exception 'classified DIFFERENT_CATALOG candidate is required'
      using errcode='55000';
  end if;
  select secret.* into v_secret from public.cloud_source_transition_secrets secret
  where secret.transition_id=v_origin.id and secret.user_id=p_user_id for update;
  if not found or v_secret.cleared_at is not null
     or v_secret.candidate_config_ciphertext is null
     or v_secret.candidate_account_affinity_hash is null then
    raise exception 'classified candidate secret is unavailable' using errcode='55000';
  end if;
  select assessment.* into v_assessment
  from public.cloud_source_identity_assessments assessment
  where assessment.transition_id=v_origin.id and assessment.user_id=p_user_id
    and assessment.final_decision='different_catalog'
    and assessment.decision_origin=v_origin.decision_origin
  order by assessment.decided_at desc limit 1 for share;
  if not found then
    raise exception 'final DIFFERENT_CATALOG assessment is unavailable'
      using errcode='55000';
  end if;
  select generation.* into v_candidate_generation
  from public.cloud_source_catalog_generations generation
  where generation.id=v_origin.candidate_catalog_generation_id
    and generation.user_id=p_user_id and generation.source_id=p_source_id
    and generation.transition_id=v_origin.id and generation.state='ready'
    and generation.ready_at is not null and generation.gateway_complete_at is not null
  for update;
  if not found then
    raise exception 'sealed classified candidate generation is unavailable'
      using errcode='55000';
  end if;

  insert into public.cloud_sources(
    id,user_id,source_type,display_name,config_ciphertext,config_hint,
    sync_status,catalog_version
  ) values (
    v_candidate_source_id,p_user_id,v_source.source_type,btrim(p_display_name),
    v_secret.candidate_config_ciphertext,v_secret.candidate_config_hint,'ready',1
  );
  perform set_config('norva.skip_visibility_epoch_bump','on',true);
  update public.cloud_source_lifecycle lifecycle
  set lifecycle_state='staging',catalog_visibility='hidden',
      replacement_root_id=v_lifecycle.replacement_root_id,
      replaces_source_id=p_source_id,replaced_by_source_id=null,
      hidden_at=clock_timestamp(),activated_at=null,updated_at=clock_timestamp()
  where lifecycle.source_id=v_candidate_source_id and lifecycle.user_id=p_user_id;
  perform set_config('norva.skip_visibility_epoch_bump','off',true);
  insert into public.cloud_source_provider_account_affinities(
    source_id,user_id,affinity_hash,updated_at
  ) values (
    v_candidate_source_id,p_user_id,v_secret.candidate_account_affinity_hash,
    clock_timestamp()
  ) on conflict (source_id) do update
    set user_id=excluded.user_id,affinity_hash=excluded.affinity_hash,
        updated_at=excluded.updated_at;

  insert into public.cloud_source_transitions(
    id,user_id,transition_kind,old_source_id,candidate_source_id,state,
    identity_decision,decision_origin,idempotency_key,request_fingerprint,
    candidate_secret_ref,previous_secret_ref,expected_source_revision,
    expected_candidate_revision,created_by,approved_by
  ) values (
    v_replacement_id,p_user_id,'replacement',p_source_id,v_candidate_source_id,
    'validating','different_catalog',v_origin.decision_origin,p_idempotency_key,
    p_request_fingerprint,
    'replacement-transition:'||v_replacement_id::text||':candidate',
    'replacement-transition:'||v_replacement_id::text||':previous',
    p_expected_source_revision,0,p_actor,
    case when v_origin.decision_origin='manual' then p_actor else null end
  );
  insert into public.cloud_source_transition_secrets(
    transition_id,user_id,source_id,candidate_config_ciphertext,
    previous_config_ciphertext,candidate_config_hint,previous_config_hint,
    candidate_account_affinity_hash,previous_account_affinity_hash
  ) values (
    v_replacement_id,p_user_id,v_candidate_source_id,
    v_secret.candidate_config_ciphertext,v_source.config_ciphertext,
    v_secret.candidate_config_hint,coalesce(v_source.config_hint,'{}'::jsonb),
    v_secret.candidate_account_affinity_hash,
    v_secret.previous_account_affinity_hash
  );
  insert into public.cloud_source_identity_assessments(
    user_id,transition_id,algorithm_version,old_identity_id,candidate_identity_id,
    sample_size_old,sample_size_new,overlap_count,similarity_score,
    secondary_signals,automatic_decision,final_decision,decision_origin,
    decided_at,decided_by
  ) values (
    p_user_id,v_replacement_id,'replacement-from-credential-candidate-v1',
    v_assessment.old_identity_id,v_assessment.candidate_identity_id,
    v_assessment.sample_size_old,v_assessment.sample_size_new,
    v_assessment.overlap_count,v_assessment.similarity_score,
    v_assessment.secondary_signals,v_assessment.automatic_decision,
    'different_catalog',v_origin.decision_origin,clock_timestamp(),
    case when v_origin.decision_origin='manual' then p_actor else null end
  );
  insert into public.cloud_source_replacement_origins(
    replacement_transition_id,credential_transition_id,user_id
  ) values (v_replacement_id,v_origin.id,p_user_id);

  -- The original off-head generation and secret are no longer authoritative.
  -- Persist explicit terminal actions so generic bounded cleanup can prove why
  -- it is allowed to consume them.
  v_result:=public.norva_credential_transition_result(v_origin.id,p_user_id);
  insert into public.cloud_source_credential_transition_actions(
    user_id,transition_id,action_kind,idempotency_key,request_fingerprint,
    result_state,result_revision,result_identity_decision,result_payload
  ) values
  (p_user_id,v_origin.id,'replacement_handoff_consumed',
   'replacement-handoff:'||v_replacement_id::text,p_request_fingerprint,
   'cancelled',v_origin.revision,'different_catalog',v_result),
  (p_user_id,v_origin.id,'cancel',
   'replacement-handoff-purge:'||v_replacement_id::text,p_request_fingerprint,
   'cancelled',v_origin.revision,'different_catalog',v_result);
  update public.cloud_source_catalog_generations generation
  set state='purging',revision=generation.revision+1,updated_at=clock_timestamp()
  where generation.id=v_candidate_generation.id and generation.state='ready';
  insert into public.cloud_source_credential_transition_jobs(
    user_id,transition_id,source_id,catalog_generation_id,
    expected_source_revision,job_kind,max_attempts
  ) values (
    p_user_id,v_origin.id,p_source_id,v_candidate_generation.id,
    v_origin.expected_source_revision,'purge_terminal_generation',25
  ) on conflict (transition_id,job_kind)
    where state in ('pending','processing') do nothing;
  perform public.norva_clear_terminal_credential_secrets(
    v_origin.id,p_user_id,v_origin.revision
  );
  perform public.norva_begin_replacement_catalog_import(
    v_replacement_id,p_user_id,0
  );
  insert into public.cloud_source_lifecycle_events(
    user_id,source_id,transition_id,event_kind,idempotency_key,payload,actor
  ) values (
    p_user_id,p_source_id,v_replacement_id,'replacement_staging_created',
    'replacement:'||v_replacement_id::text||':staging-created',
    jsonb_build_object('candidateSourceId',v_candidate_source_id,
      'credentialTransitionId',v_origin.id),p_actor
  ) on conflict (user_id,idempotency_key) do nothing;
  return public.norva_replacement_transition_result(v_replacement_id,p_user_id)
    || jsonb_build_object('replayed',false);
end
$function$;

create or replace function public.norva_cancel_source_replacement(
  p_transition_id uuid,
  p_user_id uuid,
  p_actor text,
  p_expected_transition_revision bigint,
  p_idempotency_key text,
  p_request_fingerprint text
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_action public.cloud_source_lifecycle_events%rowtype;
  v_result jsonb;
begin
  perform public.norva_credential_require_service_role();
  if p_actor is null or btrim(p_actor)='' or length(p_actor)>200
     or p_idempotency_key is null or btrim(p_idempotency_key)=''
     or length(p_idempotency_key)>200
     or p_request_fingerprint is null
     or p_request_fingerprint!~'^[0-9a-f]{64}$' then
    raise exception 'replacement cancellation input is invalid' using errcode='22023';
  end if;
  perform public.norva_credential_lock_account(p_user_id);
  select action.* into v_action
  from public.cloud_source_lifecycle_events action
  where action.user_id=p_user_id and action.idempotency_key=p_idempotency_key
  for share;
  if found then
    if v_action.transition_id=p_transition_id
       and v_action.event_kind='replacement_cancelled'
       and v_action.payload->>'requestFingerprint'=p_request_fingerprint
       and jsonb_typeof(v_action.payload->'result')='object' then
      return (v_action.payload->'result')||jsonb_build_object('replayed',true);
    end if;
    raise exception 'replacement cancellation idempotency key reused'
      using errcode='22023';
  end if;
  select transition.* into v_transition
  from public.cloud_source_transitions transition
  where transition.id=p_transition_id and transition.user_id=p_user_id
  for update;
  if not found or v_transition.transition_kind<>'replacement'
     or v_transition.state not in ('validating','staging','importing','ready_to_switch')
     or v_transition.revision<>p_expected_transition_revision then
    raise exception 'replacement cancellation CAS failed' using errcode='40001';
  end if;
  update public.cloud_source_lifecycle lifecycle
  set lifecycle_state='purge_pending',catalog_visibility='hidden',
      purge_after=clock_timestamp(),updated_at=clock_timestamp()
  where lifecycle.source_id=v_transition.candidate_source_id
    and lifecycle.user_id=p_user_id and lifecycle.lifecycle_state='staging';
  if not found then
    raise exception 'replacement candidate retirement CAS failed' using errcode='40001';
  end if;
  update public.cloud_sources source
  set enabled=false,deleted_at=coalesce(source.deleted_at,clock_timestamp()),
      sync_status='disabled',updated_at=clock_timestamp()
  where source.id=v_transition.candidate_source_id and source.user_id=p_user_id;
  update public.cloud_source_transitions
  set state='cancelled',approved_by=p_actor
  where id=p_transition_id;
  update public.cloud_source_credential_transition_jobs job
  set state='dead',lease_owner=null,lease_until=null,completed_at=null,
      dead_at=clock_timestamp(),last_error_code='transition_cancelled'
  where job.transition_id=p_transition_id and job.user_id=p_user_id
    and job.state in ('pending','processing');
  update public.cloud_source_catalog_generations generation
  set state='purging',revision=generation.revision+1,updated_at=clock_timestamp()
  where generation.transition_id=p_transition_id and generation.user_id=p_user_id
    and generation.state in ('building','ready');
  insert into public.cloud_source_credential_transition_jobs(
    user_id,transition_id,source_id,catalog_generation_id,
    expected_source_revision,job_kind,max_attempts
  ) select generation.user_id,p_transition_id,generation.source_id,generation.id,
      v_transition.expected_source_revision,'purge_terminal_generation',25
    from public.cloud_source_catalog_generations generation
    where generation.transition_id=p_transition_id and generation.user_id=p_user_id
      and generation.state='purging'
    on conflict (transition_id,job_kind)
      where state in ('pending','processing') do nothing;
  v_result:=public.norva_replacement_transition_result(p_transition_id,p_user_id);
  insert into public.cloud_source_lifecycle_events(
    user_id,source_id,transition_id,event_kind,idempotency_key,payload,actor
  ) values (
    p_user_id,v_transition.candidate_source_id,p_transition_id,
    'replacement_cancelled',p_idempotency_key,
    jsonb_build_object(
      'requestFingerprint',p_request_fingerprint,
      'result',v_result
    ),p_actor
  );
  perform public.norva_clear_terminal_credential_secrets(
    p_transition_id,p_user_id,(v_result->>'revision')::bigint
  );
  return v_result||jsonb_build_object('replayed',false);
end
$function$;

-- Keep the B genesis head as the replacement generation's previous snapshot.
-- The bounded manifest sealer can then prove B against its own immutable
-- genesis, without ever treating A's rows as part of B.
do $migration$
declare
  v_signature regprocedure:=
    'public.norva_mark_credential_category_list_complete(uuid,uuid,uuid,uuid,text,integer,text,integer)'::regprocedure;
  v_definition text;
  v_old text:='select transition.old_source_id into v_source_id';
  v_new text:='select generation.source_id into v_source_id';
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position(v_new in v_definition)>0 then return; end if;
  if position(v_old in v_definition)=0 then
    raise exception 'replacement category-list source patch precondition drifted'
      using errcode='55000';
  end if;
  execute replace(v_definition,v_old,v_new);
end
$migration$;

create or replace function public.norva_allocate_replacement_catalog_generation(
  p_transition_id uuid,
  p_user_id uuid,
  p_job_id uuid,
  p_worker text,
  p_expected_lease_sequence integer,
  p_expected_transition_revision bigint
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_job public.cloud_source_credential_transition_jobs%rowtype;
  v_head public.cloud_source_catalog_heads%rowtype;
  v_generation_id uuid:=gen_random_uuid();
begin
  perform public.norva_replacement_require_enabled();
  select transition.* into v_transition
  from public.cloud_source_transitions transition
  where transition.id=p_transition_id and transition.user_id=p_user_id
  for update;
  select job.* into v_job
  from public.cloud_source_credential_transition_jobs job
  where job.id=p_job_id and job.transition_id=p_transition_id
    and job.user_id=p_user_id
  for update;
  if not found or v_job.job_kind<>'build_candidate_generation'
     or v_job.source_id<>v_transition.candidate_source_id
     or v_job.state<>'processing' or v_job.lease_owner<>p_worker
     or v_job.lease_sequence<>p_expected_lease_sequence
     or v_job.lease_until<=clock_timestamp()
     or v_transition.transition_kind<>'replacement'
     or v_transition.state<>'staging'
     or v_transition.revision<>p_expected_transition_revision then
    raise exception 'replacement candidate generation CAS failed' using errcode='40001';
  end if;
  select head.* into v_head
  from public.cloud_source_catalog_heads head
  where head.source_id=v_transition.candidate_source_id and head.user_id=p_user_id
  for update;
  if not found then
    raise exception 'replacement candidate catalog head is missing' using errcode='23503';
  end if;
  insert into public.cloud_source_catalog_generations(
    id,user_id,source_id,transition_id,config_revision,state
  ) values (
    v_generation_id,p_user_id,v_transition.candidate_source_id,p_transition_id,
    v_transition.expected_candidate_revision,'building'
  );
  insert into public.cloud_source_catalog_generation_episode_copy(
    generation_id,user_id,source_id,previous_generation_id
  ) values (
    v_generation_id,p_user_id,v_transition.candidate_source_id,
    v_head.active_generation_id
  );
  update public.cloud_source_credential_transition_jobs job
  set catalog_generation_id=v_generation_id
  where job.id=p_job_id and job.state='processing'
    and job.lease_owner=p_worker
    and job.lease_sequence=p_expected_lease_sequence
    and job.lease_until>clock_timestamp();
  if not found then
    raise exception 'replacement generation job became stale' using errcode='40001';
  end if;
  update public.cloud_source_transitions transition
  set state='importing',candidate_catalog_generation_id=v_generation_id
  where transition.id=p_transition_id
    and transition.revision=p_expected_transition_revision;
  if not found then
    raise exception 'replacement import transition became stale' using errcode='40001';
  end if;
  return jsonb_build_object(
    'transitionId',p_transition_id,
    'generationId',v_generation_id,
    'generationRevision',0,
    'transitionRevision',p_expected_transition_revision+1
  );
end
$function$;

-- The current bounded sealer already proves an arbitrary candidate and its
-- previous active generation page by page.  Its historical source selector is
-- A-only.  Patch that selector in a fail-closed migration so replacement
-- transitions select candidate_source_id (B), while credential transitions
-- retain old_source_id (A).  Exact-shape checks prevent silent drift.
do $migration$
declare
  v_signature regprocedure:=
    'public.norva_seal_credential_catalog_generation(uuid,uuid,uuid,uuid,text,integer,bigint,bigint)'::regprocedure;
  v_definition text;
  v_needle text:=E'  end if;\n\n  select generation.* into v_candidate';
  v_basic text:=E'  if v_transition.transition_kind = ''replacement'' then\n    v_transition.old_source_id := v_transition.candidate_source_id;\n  end if;';
  v_expanded text:=E'  if v_transition.transition_kind = ''replacement'' then\n    v_transition.old_source_id := v_transition.candidate_source_id;\n    select head.active_generation_id\n    into v_transition.previous_catalog_generation_id\n    from public.cloud_source_catalog_heads head\n    where head.source_id = v_transition.candidate_source_id\n      and head.user_id = v_transition.user_id\n    for update;\n    if v_transition.previous_catalog_generation_id is null then\n      raise exception ''replacement genesis head is missing''\n        using errcode = ''40001'';\n    end if;\n  end if;';
  v_replacement text;
  v_first integer;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  v_first:=strpos(v_definition,v_needle);
  if position('replacement genesis head is missing' in v_definition)>0 then
    return;
  elsif position(v_basic in v_definition)>0 then
    execute replace(v_definition,v_basic,v_expanded);
    return;
  end if;
  if v_first=0
     or strpos(substr(v_definition,v_first+length(v_needle)),v_needle)>0 then
    raise exception 'replacement manifest sealer patch precondition drifted'
      using errcode='55000';
  end if;
  v_replacement:=E'  end if;\n\n'||v_expanded
    ||E'\n\n  select generation.* into v_candidate';
  execute replace(v_definition,v_needle,v_replacement);
end
$migration$;

create or replace function public.norva_get_replacement_catalog_generation(
  p_transition_id uuid,
  p_user_id uuid
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare v_result jsonb;
begin
  perform public.norva_credential_require_service_role();
  select jsonb_build_object(
    'transitionId',transition.id,
    'transitionRevision',transition.revision,
    'generationId',generation.id,
    'generationState',upper(generation.state),
    'generationRevision',generation.revision,
    'configRevision',generation.config_revision,
    'manifestCounts',generation.manifest_counts,
    'manifestChecksum',generation.manifest_checksum,
    'identityEvidence',generation.identity_evidence,
    'strongIdentity',coalesce(
      generation.identity_evidence->'strongIdentity',
      jsonb_build_object(
        'currentKnown',false,'candidateKnown',false,
        'match',false,'distinct',false
      )
    ),
    'gatewayCompleteAt',generation.gateway_complete_at,
    'headRevision',head.head_revision,
    'isActiveHead',head.active_generation_id=generation.id
  ) into v_result
  from public.cloud_source_transitions transition
  join public.cloud_source_catalog_generations generation
    on generation.id=transition.candidate_catalog_generation_id
   and generation.transition_id=transition.id
   and generation.source_id=transition.candidate_source_id
  join public.cloud_source_catalog_heads head
    on head.source_id=transition.candidate_source_id
   and head.user_id=transition.user_id
  where transition.id=p_transition_id and transition.user_id=p_user_id
    and transition.transition_kind='replacement';
  if v_result is null then
    raise exception 'replacement catalog generation not found' using errcode='P0002';
  end if;
  return v_result;
end
$function$;

create or replace function public.norva_claim_replacement_catalog_build_jobs_v2(
  p_worker text,
  p_limit integer,
  p_lease_seconds integer
) returns table(
  job_id uuid,user_id uuid,transition_id uuid,source_id uuid,
  comparison_source_id uuid,catalog_generation_id uuid,job_kind text,
  transition_kind text,lease_sequence integer,failure_attempt_count integer,
  checkpoint_revision bigint,progress jsonb,expected_source_revision bigint,
  transition_revision bigint,lease_until timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform public.norva_replacement_require_enabled();
  if p_worker is null or btrim(p_worker)='' or length(p_worker)>160
     or p_limit not between 1 and 50
     or p_lease_seconds not between 10 and 900 then
    raise exception 'replacement build claim bounds are invalid' using errcode='22023';
  end if;
  update public.cloud_source_credential_transition_jobs job
  set state='dead',lease_owner=null,lease_until=null,last_error_code='lease_expired',
      dead_at=clock_timestamp()
  from public.cloud_source_transitions transition
  where transition.id=job.transition_id and transition.user_id=job.user_id
    and transition.transition_kind='replacement'
    and job.job_kind='build_candidate_generation'
    and job.state='processing' and job.lease_until<=clock_timestamp()
    and job.attempt_count>=job.max_attempts;
  return query
  with candidates as (
    select job.id
    from public.cloud_source_credential_transition_jobs job
    join public.cloud_source_transitions transition
      on transition.id=job.transition_id and transition.user_id=job.user_id
    where job.job_kind='build_candidate_generation'
      and transition.transition_kind='replacement'
      and transition.state in ('staging','importing')
      and ((job.state='pending' and job.available_at<=clock_timestamp())
        or (job.state='processing' and job.lease_until<=clock_timestamp()
          and job.attempt_count<job.max_attempts))
    order by job.available_at,job.created_at,job.id
    for update of job skip locked limit p_limit
  ), claimed as (
    update public.cloud_source_credential_transition_jobs job
    set state='processing',
        attempt_count=job.attempt_count+case when job.state='processing' then 1 else 0 end,
        lease_sequence=job.lease_sequence+1,lease_owner=p_worker,
        lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),
        last_error_code=case when job.state='processing' then 'lease_expired'
          else job.last_error_code end
    from candidates where job.id=candidates.id returning job.*
  )
  select claimed.id,claimed.user_id,claimed.transition_id,claimed.source_id,
    transition.old_source_id,claimed.catalog_generation_id,claimed.job_kind,
    transition.transition_kind,claimed.lease_sequence,claimed.attempt_count,
    claimed.checkpoint_revision,claimed.progress,claimed.expected_source_revision,
    transition.revision,claimed.lease_until
  from claimed join public.cloud_source_transitions transition
    on transition.id=claimed.transition_id and transition.user_id=claimed.user_id;
end
$function$;

-- Keep the credential claimant useful for terminal continuation jobs, but
-- make its build/validation branch credential-only.  This DB fence protects
-- rolling old Edge workers; claim ordering in Edge is not the authority.
create or replace function public.norva_claim_credential_transition_jobs(
  p_worker text,
  p_limit integer,
  p_lease_seconds integer,
  p_worker_protocol text
) returns table(
  job_id uuid,user_id uuid,transition_id uuid,source_id uuid,
  catalog_generation_id uuid,job_kind text,lease_sequence integer,
  failure_attempt_count integer,checkpoint_revision bigint,progress jsonb,
  expected_source_revision bigint,transition_revision bigint,
  lease_until timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform public.norva_credential_require_service_role();
  if p_worker is null or btrim(p_worker)='' or length(p_worker)>160 then
    raise exception 'bounded worker id is required' using errcode='22023';
  end if;
  if p_worker_protocol is not null
     and p_worker_protocol not in (
       'credential-transition-worker-v2-title-cleanup',
       'credential-transition-worker-v3-active-catalog-refresh'
     ) then
    raise exception 'unsupported credential worker protocol' using errcode='22023';
  end if;
  if p_limit is null or p_limit not between 1 and 50
     or p_lease_seconds is null or p_lease_seconds not between 10 and 900 then
    raise exception 'job claim bounds are invalid' using errcode='22023';
  end if;
  update public.cloud_source_credential_transition_jobs job
  set state='dead',lease_owner=null,lease_until=null,
      last_error_code='lease_expired',dead_at=clock_timestamp()
  where job.state='processing' and job.lease_until<=clock_timestamp()
    and job.attempt_count>=job.max_attempts;
  return query
  with candidates as (
    select job.id
    from public.cloud_source_credential_transition_jobs job
    join public.cloud_source_transitions transition
      on transition.id=job.transition_id and transition.user_id=job.user_id
    where ((job.state='pending' and job.available_at<=clock_timestamp())
      or (job.state='processing' and job.lease_until<=clock_timestamp()
        and job.attempt_count<job.max_attempts))
      and (
        job.job_kind='rollback_refresh'
        or (job.job_kind='post_switch_verify'
          and p_worker_protocol='credential-transition-worker-v3-active-catalog-refresh')
        or (job.job_kind in ('promote_generation_titles','purge_terminal_generation')
          and p_worker_protocol in (
            'credential-transition-worker-v2-title-cleanup',
            'credential-transition-worker-v3-active-catalog-refresh'
          ))
        or (job.job_kind in ('validate_candidate','build_candidate_generation')
          and transition.transition_kind='credential'
          and exists (
            select 1 from public.admin_feature_flags flag
            where flag.key='provider_credential_transition_v1_enabled'
              and flag.enabled
          ))
      )
    order by job.available_at,job.created_at,job.id
    for update of job skip locked
    limit p_limit
  ), claimed as (
    update public.cloud_source_credential_transition_jobs job
    set state='processing',
        attempt_count=job.attempt_count+case when job.state='processing' then 1 else 0 end,
        lease_sequence=job.lease_sequence+1,lease_owner=p_worker,
        lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),
        last_error_code=case when job.state='processing' then 'lease_expired'
          else job.last_error_code end
    from candidates where job.id=candidates.id returning job.*
  )
  select claimed.id,claimed.user_id,claimed.transition_id,claimed.source_id,
    claimed.catalog_generation_id,claimed.job_kind,claimed.lease_sequence,
    claimed.attempt_count,claimed.checkpoint_revision,claimed.progress,
    claimed.expected_source_revision,transition.revision,claimed.lease_until
  from claimed
  join public.cloud_source_transitions transition
    on transition.id=claimed.transition_id and transition.user_id=claimed.user_id;
end
$function$;

revoke all on function public.norva_replacement_transition_result(uuid,uuid),
  public.norva_get_source_replacement(uuid,uuid),
  public.norva_create_source_replacement_from_candidate(
    uuid,uuid,uuid,text,text,bigint,text,text
  ),
  public.norva_cancel_source_replacement(uuid,uuid,text,bigint,text,text),
  public.norva_allocate_replacement_catalog_generation(
    uuid,uuid,uuid,text,integer,bigint
  ),
  public.norva_get_replacement_catalog_generation(uuid,uuid),
  public.norva_claim_replacement_catalog_build_jobs_v2(text,integer,integer)
from public,anon,authenticated;
grant execute on function public.norva_get_source_replacement(uuid,uuid),
  public.norva_create_source_replacement_from_candidate(
    uuid,uuid,uuid,text,text,bigint,text,text
  ),
  public.norva_cancel_source_replacement(uuid,uuid,text,bigint,text,text),
  public.norva_allocate_replacement_catalog_generation(
    uuid,uuid,uuid,text,integer,bigint
  ),
  public.norva_get_replacement_catalog_generation(uuid,uuid),
  public.norva_claim_replacement_catalog_build_jobs_v2(text,integer,integer)
to service_role;

commit;
