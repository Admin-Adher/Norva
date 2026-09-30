-- Explicit service-only recovery after an unavailable old host exhausts rollback.
-- Preserves the active source config/head/history and immutable failed job evidence.
create or replace function public.norva_fail_unavailable_credential_compensation(
  p_transition_id uuid,
  p_user_id uuid,
  p_job_id uuid,
  p_expected_transition_revision bigint,
  p_expected_head_revision bigint,
  p_actor text
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_secret public.cloud_source_transition_secrets%rowtype;
  v_lifecycle public.cloud_source_lifecycle%rowtype;
  v_job public.cloud_source_credential_transition_jobs%rowtype;
  v_head public.cloud_source_catalog_heads%rowtype;
  v_generation public.cloud_source_catalog_generations%rowtype;
  v_candidate_generation public.cloud_source_catalog_generations%rowtype;
  v_config text;
begin
  perform public.norva_credential_require_service_role();
  if p_transition_id is null or p_user_id is null or p_job_id is null
     or p_expected_transition_revision is null or p_expected_head_revision is null then
    raise exception 'recovery identities and revisions are required' using errcode = '22004';
  end if;
  if p_actor is null or btrim(p_actor) = '' or length(p_actor) > 200 then raise exception 'operator actor is required' using errcode = '22023'; end if;
  perform public.norva_credential_lock_account(p_user_id);
  select transition.* into v_transition from public.cloud_source_transitions transition
  where transition.id = p_transition_id and transition.user_id = p_user_id for update;
  if not found then raise exception 'credential transition not found' using errcode = 'P0002'; end if;
  select secret.* into v_secret from public.cloud_source_transition_secrets secret
  where secret.transition_id = p_transition_id and secret.user_id = p_user_id for update;
  select source.config_ciphertext into v_config from public.cloud_sources source
  where source.id = v_transition.old_source_id and source.user_id = p_user_id for update;
  select lifecycle.* into v_lifecycle from public.cloud_source_lifecycle lifecycle
  where lifecycle.source_id = v_transition.old_source_id and lifecycle.user_id = p_user_id for update;
  select job.* into v_job from public.cloud_source_credential_transition_jobs job
  where job.id = p_job_id and job.transition_id = p_transition_id
    and job.user_id = p_user_id for update;
  select head.* into v_head from public.cloud_source_catalog_heads head
  where head.source_id = v_transition.old_source_id and head.user_id = p_user_id for update;
  select generation.* into v_generation from public.cloud_source_catalog_generations generation
  where generation.id = v_transition.previous_catalog_generation_id
    and generation.user_id = p_user_id
    and generation.source_id = v_transition.old_source_id for update;
  select generation.* into v_candidate_generation
  from public.cloud_source_catalog_generations generation
  where generation.id = v_transition.candidate_catalog_generation_id
    and generation.user_id = p_user_id
    and generation.source_id = v_transition.old_source_id
  for update;
  if v_secret.transition_id is null or v_lifecycle.source_id is null
     or v_job.id is null or v_head.source_id is null or v_generation.id is null
     or v_candidate_generation.id is null or v_config is null
     or v_transition.transition_kind <> 'credential'
     or v_transition.state <> 'committing'
     or v_transition.revision <> p_expected_transition_revision
     or v_secret.previous_config_restored_at is null
     or v_config is distinct from v_secret.previous_config_ciphertext
     or v_lifecycle.config_revision <> v_transition.expected_source_revision + 2
     or v_job.job_kind <> 'rollback_refresh'
     or v_job.catalog_generation_id <> v_generation.id
     or v_job.state <> 'dead' or v_job.dead_at is null
     or v_job.last_error_code not in ('provider_unavailable', 'network_timeout', 'auth_rejected')
     or v_job.attempt_count < 1
     or v_job.lease_owner is not null or v_job.lease_until is not null
     or v_secret.rollback_refresh_healthy_at is not null
     or v_secret.rollback_refresh_proof_id is not null
     or exists (select 1 from public.cloud_source_credential_transition_jobs j
       where j.transition_id = p_transition_id and j.state in ('pending','processing'))
     or v_head.head_revision <> p_expected_head_revision
     or v_head.active_generation_id <> v_generation.id
     or v_generation.state <> 'active'
     or v_candidate_generation.state <> 'retained' then
    raise exception 'rollback refresh proof CAS failed' using errcode = 'PT409';
  end if;
  -- Record the unavailable rollback honestly. No healthy refresh proof is created.
  update public.cloud_source_transitions
  set state = 'failed', failure_code = 'rollback_unavailable', approved_by = p_actor
  where id = p_transition_id;
  update public.cloud_source_catalog_generations generation
  set state = 'purging', revision = generation.revision + 1,
      updated_at = now()
  where generation.id = v_candidate_generation.id
    and generation.state = 'retained';
  if not found then
    raise exception 'compensated candidate purge CAS failed'
      using errcode = 'PT409';
  end if;
  insert into public.cloud_source_credential_transition_jobs (
    user_id, transition_id, source_id, catalog_generation_id,
    expected_source_revision, job_kind, max_attempts
  ) values (
    p_user_id, p_transition_id, v_transition.old_source_id,
    v_candidate_generation.id, v_transition.expected_source_revision + 1,
    'purge_terminal_generation', 25
  );
  perform set_config('norva.credential_secret_clear', 'on', true);
  update public.cloud_source_transition_secrets secret
  set candidate_config_ciphertext = null,
      previous_config_ciphertext = null,
      candidate_config_hint = null,
      previous_config_hint = null,
      cleared_at = coalesce(secret.cleared_at, now())
  where secret.transition_id = p_transition_id
    and secret.user_id = p_user_id;
  perform set_config('norva.credential_secret_clear', 'off', true);
  insert into public.cloud_source_lifecycle_events (
    user_id, source_id, transition_id, event_kind, idempotency_key, payload, actor
  ) values (
    p_user_id, v_transition.old_source_id, p_transition_id,
    'credential_compensation_unavailable',
    'credential-transition:' || p_transition_id::text || ':compensation-unavailable',
    jsonb_build_object('failureCode','rollback_unavailable','jobId',p_job_id), p_actor
  ) on conflict (user_id, idempotency_key) do nothing;
  return public.norva_credential_transition_result(p_transition_id, p_user_id);
end
$function$;

revoke all on function public.norva_fail_unavailable_credential_compensation(uuid,uuid,uuid,bigint,bigint,text) from public, anon, authenticated;
grant execute on function public.norva_fail_unavailable_credential_compensation(uuid,uuid,uuid,bigint,bigint,text) to service_role;
