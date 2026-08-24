-- A missing row must fail a completion CAS.  SQL three-valued comparisons in
-- the original compound predicate otherwise let a missing claimed job fall
-- through to a later, less precise proof check.
begin;

do $credential_completion_null_fences$
declare
  v_definition text;
  v_old text := $old$
  select job.* into v_job from public.cloud_source_credential_transition_jobs job
  where job.id = p_job_id and job.transition_id = p_transition_id
    and job.user_id = p_user_id for update;
  select head.* into v_head from public.cloud_source_catalog_heads head
$old$;
  v_new text := $new$
  select job.* into v_job from public.cloud_source_credential_transition_jobs job
  where job.id = p_job_id and job.transition_id = p_transition_id
    and job.user_id = p_user_id for update;
  if not found then
    raise exception 'credential completion job CAS failed'
      using errcode = '40001', detail = 'reason=credential_job_lease_changed';
  end if;
  select head.* into v_head from public.cloud_source_catalog_heads head
$new$;
begin
  select pg_catalog.pg_get_functiondef(
    'public.norva_complete_credential_transition(uuid,uuid,uuid,text,integer,bigint,bigint,uuid)'::regprocedure
  ) into v_definition;
  if position('credential completion job CAS failed' in v_definition) = 0 then
    if position(v_old in v_definition) = 0 then
      raise exception 'credential completion job fence anchor drift' using errcode='55000';
    end if;
    execute replace(v_definition,v_old,v_new);
  end if;
end
$credential_completion_null_fences$;

commit;
