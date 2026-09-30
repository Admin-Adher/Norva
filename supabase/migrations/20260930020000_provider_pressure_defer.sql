-- Playback pressure yields the queue lease without consuming failure attempts.
-- Exact lease/worker CAS and all terminal/identity guards remain in force.
create or replace function public.norva_settle_credential_transition_job(
  p_job_id uuid,
  p_worker text,
  p_expected_attempt integer,
  p_outcome text,
  p_error_code text default null,
  p_retry_after_seconds integer default 60
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_job public.cloud_source_credential_transition_jobs%rowtype;
  v_outcome text := lower(p_outcome);
  v_state text;
begin
  perform public.norva_credential_require_service_role();
  if v_outcome not in ('completed', 'retry', 'dead', 'defer') then
    raise exception 'invalid job outcome' using errcode = '22023';
  end if;
  if p_error_code is not null and p_error_code not in (
    'network_timeout', 'provider_unavailable', 'auth_rejected',
    'rate_limited', 'invalid_payload', 'catalog_unhealthy',
    'internal_error', 'lease_expired'
  ) then raise exception 'invalid job error code' using errcode = '22023'; end if;
  if v_outcome in ('retry', 'dead') and p_error_code is null then
    raise exception 'failed job outcome requires an error code' using errcode = '22023';
  end if;
  if p_retry_after_seconds < 1 or p_retry_after_seconds > 86400 then
    raise exception 'retry delay is out of bounds' using errcode = '22023';
  end if;
  if v_outcome = 'defer' and p_error_code is distinct from 'rate_limited' then
    raise exception 'only provider pressure can defer without failure' using errcode = '22023';
  end if;
  select job.* into v_job
  from public.cloud_source_credential_transition_jobs job
  where job.id = p_job_id
  for update;
  if not found
     or v_job.state <> 'processing'
     or v_job.lease_owner is distinct from p_worker
     or v_job.lease_sequence <> p_expected_attempt
     or v_job.lease_until <= now() then
    raise exception 'credential job lease CAS failed' using errcode = '40001';
  end if;

  v_state := case
    when v_outcome = 'defer' then 'pending'
    when v_outcome = 'completed' then 'completed'
    when v_outcome = 'dead' or v_job.attempt_count + 1 >= v_job.max_attempts then 'dead'
    else 'pending'
  end;
  update public.cloud_source_credential_transition_jobs job
  set state = v_state,
      lease_owner = null,
      lease_until = null,
      attempt_count = case
        when v_outcome in ('retry', 'dead') then job.attempt_count + 1
        else job.attempt_count
      end,
      available_at = case
        when v_state = 'pending' then now() + make_interval(secs => p_retry_after_seconds)
        else job.available_at
      end,
      last_error_code = case when v_state = 'completed' then null else p_error_code end,
      completed_at = case when v_state = 'completed' then now() else null end,
      dead_at = case when v_state = 'dead' then now() else null end
  where job.id = p_job_id;
  return jsonb_build_object(
    'jobId', p_job_id,
    'state', upper(v_state),
    'failureAttemptCount', case
      when v_outcome in ('retry', 'dead') then v_job.attempt_count + 1
      else v_job.attempt_count
    end,
    'leaseSequence', v_job.lease_sequence
  );
end
$function$;
notify pgrst, 'reload schema';
