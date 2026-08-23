-- A replacement B is deliberately empty while it is moved to hidden STAGING.
-- Once the generation writer contract is active, only this durable job path may
-- populate it; direct catalog writes remain fail-closed.
begin;

alter table public.cloud_source_transitions
  drop constraint if exists cloud_source_transitions_candidate_generation_fk;
alter table public.cloud_source_transitions
  add constraint cloud_source_transitions_candidate_generation_fk
  foreign key (user_id, candidate_catalog_generation_id)
  references public.cloud_source_catalog_generations(user_id, id)
  on update cascade on delete restrict not valid;

create or replace function public.norva_catalog_generation_guard_begin_statement()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare v_nonce uuid := gen_random_uuid(); v_enabled boolean := false; v_contracted boolean := false;
begin
  select exists (
    select 1 from public.admin_feature_flags flag
    where flag.key in (
      'provider_credential_transition_v1_enabled', 'provider_replacement_v1_enabled'
    ) and flag.enabled
  ), rollout.contracted_at is not null
  into v_enabled, v_contracted
  from public.cloud_catalog_generation_rollout rollout where rollout.singleton;
  perform set_config('norva.catalog_guard_nonce', v_nonce::text, true);
  perform set_config('norva.catalog_guard_transition_enabled', v_enabled::text, true);
  perform set_config('norva.catalog_guard_rollout_contracted', v_contracted::text, true);
  perform set_config('norva.catalog_guard_validation_count', '0', true);
  perform set_config('norva.catalog_guard_head_lookup_count', '0', true);
  return null;
end
$function$;

-- The existing table name is retained for rolling compatibility, but its
-- source fence is now transition-kind aware: credential jobs bind to A and
-- replacement build jobs bind to B.
create or replace function public.norva_credential_job_guard()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare v_transition public.cloud_source_transitions%rowtype;
begin
  if tg_op = 'DELETE' then
    raise exception 'credential transition jobs cannot be deleted' using errcode = '42501';
  end if;
  select transition.* into v_transition from public.cloud_source_transitions transition
  where transition.id = new.transition_id and transition.user_id = new.user_id;
  if not found
     or (v_transition.transition_kind = 'credential'
         and v_transition.old_source_id is distinct from new.source_id)
     or (v_transition.transition_kind = 'replacement'
         and v_transition.candidate_source_id is distinct from new.source_id)
     or v_transition.transition_kind not in ('credential','replacement') then
    raise exception 'job must belong to its transition source' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id or new.user_id is distinct from old.user_id
       or new.transition_id is distinct from old.transition_id
       or new.source_id is distinct from old.source_id
       or (old.catalog_generation_id is not null and new.catalog_generation_id is distinct from old.catalog_generation_id)
       or new.expected_source_revision is distinct from old.expected_source_revision
       or (new.job_kind is distinct from old.job_kind and not (
         old.job_kind = 'post_switch_verify' and new.job_kind = 'promote_generation_titles'
         and v_transition.state = 'completed' and old.state = 'processing' and new.state = 'pending'
       )) or new.max_attempts is distinct from old.max_attempts
       or new.created_at is distinct from old.created_at then
      raise exception 'credential job identity is immutable' using errcode = '23514';
    end if;
    if old.state in ('completed','dead') then
      raise exception 'terminal credential job is immutable' using errcode = '23514';
    end if;
  end if;
  new.updated_at := now();
  return new;
end
$function$;

create or replace function public.norva_replacement_require_enabled()
returns void language plpgsql stable security definer set search_path = '' as $function$
begin
  perform public.norva_credential_require_service_role();
  if not exists (
    select 1 from public.admin_feature_flags
    where key = 'provider_replacement_v1_enabled' and enabled
  ) then
    raise exception 'provider replacement transition feature is disabled'
      using errcode = '55000';
  end if;
end
$function$;

create or replace function public.norva_begin_replacement_catalog_import(
  p_transition_id uuid,
  p_user_id uuid,
  p_expected_transition_revision bigint
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_candidate public.cloud_source_lifecycle%rowtype;
  v_job_id uuid;
begin
  perform public.norva_replacement_require_enabled();
  select transition.* into v_transition
  from public.cloud_source_transitions transition
  where transition.id = p_transition_id and transition.user_id = p_user_id
  for update;
  if not found then
    raise exception 'replacement transition not found' using errcode = 'P0002';
  end if;
  if v_transition.transition_kind <> 'replacement'
     or v_transition.identity_decision <> 'different_catalog'
     or v_transition.state not in ('validating', 'staging')
     or v_transition.revision <> p_expected_transition_revision then
    raise exception 'replacement import transition CAS failed' using errcode = '40001';
  end if;
  select lifecycle.* into v_candidate
  from public.cloud_source_lifecycle lifecycle
  where lifecycle.source_id = v_transition.candidate_source_id
    and lifecycle.user_id = p_user_id
  for update;
  if not found
     or v_candidate.lifecycle_state <> 'staging'
     or v_candidate.catalog_visibility <> 'hidden'
     or v_candidate.replaces_source_id <> v_transition.old_source_id
     or v_candidate.config_revision <> v_transition.expected_candidate_revision then
    raise exception 'replacement candidate is not the transition snapshot'
      using errcode = '40001';
  end if;

  select job.id into v_job_id
  from public.cloud_source_credential_transition_jobs job
  where job.transition_id = p_transition_id
    and job.job_kind = 'build_candidate_generation'
    and job.state in ('pending', 'processing')
  for update;
  if v_job_id is null then
    insert into public.cloud_source_credential_transition_jobs (
      user_id, transition_id, source_id, expected_source_revision, job_kind
    ) values (
      p_user_id, p_transition_id, v_transition.candidate_source_id,
      v_transition.expected_candidate_revision, 'build_candidate_generation'
    ) returning id into v_job_id;
  end if;
  if v_transition.state = 'validating' then
    update public.cloud_source_transitions
    set state = 'staging'
    where id = p_transition_id and revision = p_expected_transition_revision;
  end if;
  return jsonb_build_object(
    'transitionId', p_transition_id, 'jobId', v_job_id,
    'state', 'STAGING', 'transitionRevision', p_expected_transition_revision +
      case when v_transition.state = 'validating' then 1 else 0 end
  );
end
$function$;

create or replace function public.norva_claim_replacement_catalog_build_jobs(
  p_worker text, p_limit integer default 10, p_lease_seconds integer default 60
) returns table (
  job_id uuid, user_id uuid, transition_id uuid, source_id uuid,
  catalog_generation_id uuid, lease_sequence integer, checkpoint_revision bigint,
  expected_source_revision bigint, transition_revision bigint, lease_until timestamptz
)
language plpgsql volatile security definer set search_path = '' as $function$
begin
  perform public.norva_replacement_require_enabled();
  if p_worker is null or btrim(p_worker) = '' or length(p_worker) > 160
     or p_limit not between 1 and 50 or p_lease_seconds not between 10 and 900 then
    raise exception 'replacement build claim bounds are invalid' using errcode = '22023';
  end if;
  return query
  with candidates as (
    select job.id
    from public.cloud_source_credential_transition_jobs job
    join public.cloud_source_transitions transition
      on transition.id = job.transition_id and transition.user_id = job.user_id
    where job.job_kind = 'build_candidate_generation'
      and transition.transition_kind = 'replacement'
      and transition.state = 'staging'
      and ((job.state = 'pending' and job.available_at <= now())
        or (job.state = 'processing' and job.lease_until <= now()
          and job.attempt_count < job.max_attempts))
    order by job.available_at, job.created_at, job.id
    for update of job skip locked limit p_limit
  ), claimed as (
    update public.cloud_source_credential_transition_jobs job
    set state = 'processing',
        attempt_count = job.attempt_count + case when job.state = 'processing' then 1 else 0 end,
        lease_sequence = job.lease_sequence + 1,
        lease_owner = p_worker,
        lease_until = now() + make_interval(secs => p_lease_seconds),
        last_error_code = case when job.state = 'processing' then 'lease_expired' else job.last_error_code end
    from candidates where job.id = candidates.id returning job.*
  )
  select claimed.id, claimed.user_id, claimed.transition_id, claimed.source_id,
         claimed.catalog_generation_id, claimed.lease_sequence,
         claimed.checkpoint_revision, claimed.expected_source_revision,
         transition.revision, claimed.lease_until
  from claimed join public.cloud_source_transitions transition
    on transition.id = claimed.transition_id and transition.user_id = claimed.user_id;
end
$function$;

create or replace function public.norva_allocate_replacement_catalog_generation(
  p_transition_id uuid, p_user_id uuid, p_job_id uuid, p_worker text,
  p_expected_lease_sequence integer, p_expected_transition_revision bigint
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_job public.cloud_source_credential_transition_jobs%rowtype;
  v_head public.cloud_source_catalog_heads%rowtype;
  v_generation_id uuid := gen_random_uuid();
begin
  perform public.norva_replacement_require_enabled();
  select transition.* into v_transition from public.cloud_source_transitions transition
  where transition.id = p_transition_id and transition.user_id = p_user_id for update;
  select job.* into v_job from public.cloud_source_credential_transition_jobs job
  where job.id = p_job_id and job.transition_id = p_transition_id and job.user_id = p_user_id for update;
  if not found or v_job.job_kind <> 'build_candidate_generation'
     or v_job.source_id <> v_transition.candidate_source_id
     or v_job.state <> 'processing' or v_job.lease_owner <> p_worker
     or v_job.lease_sequence <> p_expected_lease_sequence or v_job.lease_until <= now()
     or v_transition.transition_kind <> 'replacement' or v_transition.state <> 'staging'
     or v_transition.revision <> p_expected_transition_revision then
    raise exception 'replacement candidate generation CAS failed' using errcode = '40001';
  end if;
  select head.* into v_head from public.cloud_source_catalog_heads head
  where head.source_id = v_transition.candidate_source_id and head.user_id = p_user_id
  for update;
  if not found then
    raise exception 'replacement candidate catalog head is missing' using errcode = '23503';
  end if;
  insert into public.cloud_source_catalog_generations (
    id, user_id, source_id, transition_id, config_revision, state
  ) values (
    v_generation_id, p_user_id, v_transition.candidate_source_id, p_transition_id,
    v_transition.expected_candidate_revision, 'building'
  );
  -- This is deliberately B -> B: a different provider never inherits A's
  -- progress. The empty B genesis ledger still lets the generic sealed-manifest
  -- protocol prove that its own episode pass completed.
  insert into public.cloud_source_catalog_generation_episode_copy (
    generation_id, user_id, source_id, previous_generation_id
  ) values (
    v_generation_id, p_user_id, v_transition.candidate_source_id,
    v_head.active_generation_id
  );
  update public.cloud_source_credential_transition_jobs
  set catalog_generation_id = v_generation_id
  where id = p_job_id and state = 'processing' and lease_owner = p_worker
    and lease_sequence = p_expected_lease_sequence and lease_until > now();
  if not found then raise exception 'replacement generation job became stale' using errcode = '40001'; end if;
  update public.cloud_source_transitions
  set state = 'importing', candidate_catalog_generation_id = v_generation_id
  where id = p_transition_id and revision = p_expected_transition_revision;
  if not found then raise exception 'replacement import transition became stale' using errcode = '40001'; end if;
  return jsonb_build_object('transitionId', p_transition_id,
    'generationId', v_generation_id, 'generationRevision', 0,
    'transitionRevision', p_expected_transition_revision + 1);
end
$function$;

create or replace function public.norva_mark_replacement_transition_ready(
  p_transition_id uuid, p_user_id uuid, p_readiness_check_id uuid,
  p_expected_transition_revision bigint
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_generation public.cloud_source_catalog_generations%rowtype;
  v_candidate public.cloud_sources%rowtype;
begin
  perform public.norva_replacement_require_enabled();
  if p_readiness_check_id is null then
    raise exception 'replacement readiness proof is required' using errcode = '22004';
  end if;
  select transition.* into v_transition from public.cloud_source_transitions transition
  where transition.id = p_transition_id and transition.user_id = p_user_id for update;
  if not found or v_transition.transition_kind <> 'replacement'
     or v_transition.state <> 'importing'
     or v_transition.identity_decision <> 'different_catalog'
     or v_transition.revision <> p_expected_transition_revision then
    raise exception 'replacement readiness CAS failed' using errcode = '40001';
  end if;
  if not exists (
    select 1 from public.cloud_source_identity_assessments assessment
    where assessment.transition_id = p_transition_id and assessment.user_id = p_user_id
      and assessment.final_decision = 'different_catalog'
      and assessment.decision_origin = v_transition.decision_origin
      and assessment.decided_at is not null
  ) then
    raise exception 'final DIFFERENT_CATALOG assessment is required' using errcode = '55000';
  end if;
  select generation.* into v_generation from public.cloud_source_catalog_generations generation
  where generation.id = v_transition.candidate_catalog_generation_id
    and generation.source_id = v_transition.candidate_source_id
    and generation.user_id = p_user_id and generation.transition_id = p_transition_id
  for update;
  if not found or v_generation.state <> 'ready'
     or v_generation.ready_at is null or v_generation.gateway_complete_at is null
     or coalesce(v_generation.manifest_checksum, '') = '' then
    raise exception 'replacement candidate generation is not sealed and ready'
      using errcode = '55000';
  end if;
  select source.* into v_candidate from public.cloud_sources source
  where source.id = v_transition.candidate_source_id and source.user_id = p_user_id
  for key share;
  if not found then raise exception 'replacement candidate source is missing' using errcode = '23503'; end if;
  update public.cloud_source_transitions
  set state = 'ready_to_switch', readiness_check_id = p_readiness_check_id,
      readiness_passed_at = now(), expected_catalog_version = v_candidate.catalog_version
  where id = p_transition_id and revision = p_expected_transition_revision;
  if not found then raise exception 'replacement readiness became stale' using errcode = '40001'; end if;
  return jsonb_build_object('transitionId', p_transition_id,
    'state', 'READY_TO_SWITCH', 'transitionRevision', p_expected_transition_revision + 1,
    'generationId', v_generation.id, 'manifestChecksum', v_generation.manifest_checksum,
    'expectedCatalogVersion', v_candidate.catalog_version);
end
$function$;

revoke all on function public.norva_replacement_require_enabled() from public, anon, authenticated;
revoke all on function public.norva_begin_replacement_catalog_import(uuid,uuid,bigint) from public, anon, authenticated;
revoke all on function public.norva_claim_replacement_catalog_build_jobs(text,integer,integer) from public, anon, authenticated;
revoke all on function public.norva_allocate_replacement_catalog_generation(uuid,uuid,uuid,text,integer,bigint) from public, anon, authenticated;
revoke all on function public.norva_mark_replacement_transition_ready(uuid,uuid,uuid,bigint) from public, anon, authenticated;
grant execute on function public.norva_begin_replacement_catalog_import(uuid,uuid,bigint),
  public.norva_claim_replacement_catalog_build_jobs(text,integer,integer),
  public.norva_allocate_replacement_catalog_generation(uuid,uuid,uuid,text,integer,bigint),
  public.norva_mark_replacement_transition_ready(uuid,uuid,uuid,bigint) to service_role;

commit;
