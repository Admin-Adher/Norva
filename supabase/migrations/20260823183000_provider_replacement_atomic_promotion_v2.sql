begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- The v1 transition terminal payload is append-immutable.  Keep the v2-only
-- candidate-head replay fence in a separate durable record rather than
-- weakening that protection after the legacy promotion has completed.
create table public.cloud_source_replacement_promotion_v2_proofs (
  transition_id uuid primary key,
  user_id uuid not null,
  candidate_generation_id uuid not null,
  candidate_head_revision_before bigint not null check (candidate_head_revision_before >= 0),
  candidate_head_revision_after bigint not null check (candidate_head_revision_after >= 0),
  created_at timestamptz not null default now(),
  constraint cloud_source_replacement_promotion_v2_proofs_transition_fk
    foreign key (user_id, transition_id)
    references public.cloud_source_transitions(user_id, id)
    on update cascade on delete restrict,
  constraint cloud_source_replacement_promotion_v2_proofs_generation_fk
    foreign key (user_id, candidate_generation_id)
    references public.cloud_source_catalog_generations(user_id, id)
    on update cascade on delete restrict,
  constraint cloud_source_replacement_promotion_v2_proofs_revision_ck
    check (candidate_head_revision_after = candidate_head_revision_before + 1)
);
alter table public.cloud_source_replacement_promotion_v2_proofs enable row level security;
revoke all on table public.cloud_source_replacement_promotion_v2_proofs
  from public, anon, authenticated, service_role;

-- The original lifecycle promotion is intentionally narrow: it makes B
-- visible only after all of its source-level checks pass.  Generation v2 adds
-- the missing catalogue-head cutover in the *same transaction*.  Therefore a
-- visible B can never resolve its genesis head while its imported, sealed
-- replacement generation is merely READY.
create or replace function public.norva_promote_source_replacement_v2(
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
set search_path = ''
as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_candidate_generation public.cloud_source_catalog_generations%rowtype;
  v_previous_candidate_generation public.cloud_source_catalog_generations%rowtype;
  v_candidate_head public.cloud_source_catalog_heads%rowtype;
  v_proof public.cloud_source_replacement_promotion_v2_proofs%rowtype;
  v_result jsonb;
begin
  perform public.norva_replacement_require_enabled();
  if p_transition_id is null or p_user_id is null
     or p_idempotency_key is null or btrim(p_idempotency_key) = ''
     or length(p_idempotency_key) > 200
     or p_expected_source_revision is null or p_expected_source_revision < 0
     or p_expected_transition_revision is null or p_expected_transition_revision < 0
     or p_expected_candidate_head_revision is null
     or p_expected_candidate_head_revision < 0 then
    raise exception 'replacement promotion v2 input is invalid' using errcode = '22023';
  end if;

  -- Account-first lock matches credential-transition RPCs and makes the
  -- lifecycle/catalog pair serializable per user without relying on a lease.
  perform public.norva_credential_lock_account(p_user_id);
  select transition.* into v_transition
  from public.cloud_source_transitions transition
  where transition.id = p_transition_id and transition.user_id = p_user_id
  for update;
  if not found then
    raise exception 'replacement transition not found' using errcode = 'P0002';
  end if;

  if v_transition.state = 'completed' then
    -- The legacy terminal record predates the candidate-head fence.  v2
    -- persists it below and every replay binds to that exact before/after
    -- revision, not merely to the old-source lifecycle revision.
    select proof.* into v_proof
    from public.cloud_source_replacement_promotion_v2_proofs proof
    where proof.transition_id = v_transition.id and proof.user_id = p_user_id
    for share;
    if not found
       or v_proof.candidate_head_revision_before
            is distinct from p_expected_candidate_head_revision
       or v_proof.candidate_generation_id
            is distinct from v_transition.candidate_catalog_generation_id then
      raise exception 'completed replacement candidate head replay CAS failed'
        using errcode = '40001';
    end if;
    v_result := public.norva_promote_source_replacement(
      p_transition_id,p_user_id,p_idempotency_key,
      p_expected_source_revision,p_expected_transition_revision
    );
    return v_result || jsonb_build_object(
      'candidateGenerationId',v_transition.candidate_catalog_generation_id,
      'candidateHeadRevision',v_proof.candidate_head_revision_after
    );
  end if;

  if v_transition.transition_kind <> 'replacement'
     or v_transition.state <> 'ready_to_switch'
     or v_transition.identity_decision <> 'different_catalog'
     or v_transition.readiness_check_id is null
     or v_transition.readiness_passed_at is null
     or v_transition.revision <> p_expected_transition_revision
     or v_transition.expected_source_revision <> p_expected_source_revision
     or v_transition.candidate_source_id is null
     or v_transition.candidate_catalog_generation_id is null then
    raise exception 'replacement promotion v2 CAS failed' using errcode = '40001';
  end if;

  select generation.* into v_candidate_generation
  from public.cloud_source_catalog_generations generation
  where generation.id = v_transition.candidate_catalog_generation_id
    and generation.user_id = p_user_id
    and generation.source_id = v_transition.candidate_source_id
    and generation.transition_id = v_transition.id
  for update;
  if not found
     or v_candidate_generation.state <> 'ready'
     or v_candidate_generation.ready_at is null
     or v_candidate_generation.gateway_complete_at is null
     or coalesce(v_candidate_generation.manifest_checksum, '') = '' then
    raise exception 'replacement candidate generation is not ready' using errcode = '55000';
  end if;

  select head.* into v_candidate_head
  from public.cloud_source_catalog_heads head
  where head.source_id = v_transition.candidate_source_id
    and head.user_id = p_user_id
  for update;
  if not found
     or v_candidate_head.head_revision <> p_expected_candidate_head_revision
     or v_candidate_head.active_generation_id = v_candidate_generation.id then
    raise exception 'replacement candidate head CAS failed' using errcode = '40001';
  end if;

  select generation.* into v_previous_candidate_generation
  from public.cloud_source_catalog_generations generation
  where generation.id = v_candidate_head.active_generation_id
    and generation.user_id = p_user_id
    and generation.source_id = v_transition.candidate_source_id
    and generation.state = 'active'
  for update;
  if not found then
    raise exception 'replacement candidate previous head CAS failed' using errcode = '40001';
  end if;

  -- Ordering avoids the one-active-generation unique partial index.  No reader
  -- can observe this intermediate state because all writes commit atomically.
  update public.cloud_source_catalog_generations generation
  set state = 'retained', retained_at = coalesce(generation.retained_at, now()),
      revision = generation.revision + 1, updated_at = now()
  where generation.id = v_previous_candidate_generation.id
    and generation.state = 'active';
  if not found then
    raise exception 'replacement candidate previous generation CAS failed' using errcode = '40001';
  end if;
  update public.cloud_source_catalog_generations generation
  set state = 'active', activated_at = now(), retained_at = null,
      revision = generation.revision + 1, updated_at = now()
  where generation.id = v_candidate_generation.id
    and generation.state = 'ready';
  if not found then
    raise exception 'replacement candidate generation activation CAS failed' using errcode = '40001';
  end if;
  update public.cloud_source_catalog_heads head
  set active_generation_id = v_candidate_generation.id,
      head_revision = head.head_revision + 1, updated_at = now()
  where head.source_id = v_transition.candidate_source_id
    and head.user_id = p_user_id
    and head.active_generation_id = v_previous_candidate_generation.id
    and head.head_revision = p_expected_candidate_head_revision;
  if not found then
    raise exception 'replacement candidate head promotion CAS failed' using errcode = '40001';
  end if;

  -- This performs the already-audited A/B lifecycle visibility cutover and
  -- persists its idempotent terminal result.  Any error rolls back the head
  -- changes above as part of this single database transaction.
  v_result := public.norva_promote_source_replacement(
    p_transition_id,p_user_id,p_idempotency_key,
    p_expected_source_revision,p_expected_transition_revision
  );
  v_result := v_result || jsonb_build_object(
    'candidateGenerationId',v_candidate_generation.id,
    'candidateHeadRevision',p_expected_candidate_head_revision + 1
  );
  insert into public.cloud_source_replacement_promotion_v2_proofs (
    transition_id,user_id,candidate_generation_id,
    candidate_head_revision_before,candidate_head_revision_after
  ) values (
    p_transition_id,p_user_id,v_candidate_generation.id,
    p_expected_candidate_head_revision,p_expected_candidate_head_revision + 1
  ) on conflict (transition_id) do nothing;
  if not found then
    raise exception 'replacement v2 proof persistence CAS failed'
      using errcode = '40001';
  end if;
  return v_result;
end
$function$;

revoke all on function public.norva_promote_source_replacement_v2(
  uuid,uuid,text,bigint,bigint,bigint
) from public, anon, authenticated;
grant execute on function public.norva_promote_source_replacement_v2(
  uuid,uuid,text,bigint,bigint,bigint
) to service_role;

commit;
