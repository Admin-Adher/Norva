-- A rollback proof job is an immutable authorization token.  Completion must
-- enqueue a separate purge job instead of rewriting that token's identity.
do $migration$
declare
  v_definition text;
  v_legacy text := $legacy$
  update public.cloud_source_credential_transition_jobs
  set catalog_generation_id = v_candidate_generation.id,
      expected_source_revision = v_transition.expected_source_revision + 1,
      job_kind = 'purge_terminal_generation',
      state = 'pending', lease_owner = null, lease_until = null,
      attempt_count = 0, max_attempts = 25,
      checkpoint_revision = checkpoint_revision + 1,
      available_at = now(), completed_at = null, dead_at = null,
      last_error_code = null
  where id = p_job_id;$legacy$;
  v_fixed text := $fixed$
  update public.cloud_source_credential_transition_jobs
  set state = 'completed', completed_at = now()
  where id = p_job_id
    and state = 'processing'
    and lease_owner = p_worker
    and lease_sequence = p_expected_lease_sequence;
  if not found then
    raise exception 'rollback proof job completion CAS failed'
      using errcode = '40001';
  end if;
  insert into public.cloud_source_credential_transition_jobs (
    user_id, transition_id, source_id, catalog_generation_id,
    expected_source_revision, job_kind, max_attempts
  ) values (
    p_user_id, p_transition_id, v_transition.old_source_id,
    v_candidate_generation.id, v_transition.expected_source_revision + 1,
    'purge_terminal_generation', 25
  );$fixed$;
  v_fixed_with_lease_release text := $fixed_with_lease_release$
  update public.cloud_source_credential_transition_jobs
  set state = 'completed', completed_at = now(),
      lease_owner = null, lease_until = null
  where id = p_job_id
    and state = 'processing'
    and lease_owner = p_worker
    and lease_sequence = p_expected_lease_sequence;
  if not found then
    raise exception 'rollback proof job completion CAS failed'
      using errcode = '40001';
  end if;
  insert into public.cloud_source_credential_transition_jobs (
    user_id, transition_id, source_id, catalog_generation_id,
    expected_source_revision, job_kind, max_attempts
  ) values (
    p_user_id, p_transition_id, v_transition.old_source_id,
    v_candidate_generation.id, v_transition.expected_source_revision + 1,
    'purge_terminal_generation', 25
  );$fixed_with_lease_release$;
begin
  select pg_get_functiondef(
    'public.norva_finish_credential_compensation(uuid,uuid,uuid,text,integer,bigint,bigint,uuid)'::regprocedure
  ) into v_definition;
  if position(v_fixed in v_definition) > 0
     or position(v_fixed_with_lease_release in v_definition) > 0 then
    return;
  end if;
  if position(v_legacy in v_definition) = 0 then
    raise exception 'credential compensation function does not match expected pre-fix definition'
      using errcode = '55000';
  end if;
  execute replace(v_definition,v_legacy,v_fixed);
end
$migration$;
