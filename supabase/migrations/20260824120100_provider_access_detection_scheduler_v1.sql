-- Phase 7 automatic detection scheduler. Provider I/O remains in Edge/Gateway;
-- PostgreSQL owns due selection, leases, retries and the final detection CAS.

create table public.cloud_provider_access_check_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  source_id uuid not null,
  state text not null default 'queued'
    check (state in ('queued','leased','retry','completed','dead')),
  expected_access_revision bigint check (expected_access_revision is null or expected_access_revision > 0),
  lease_owner text check (lease_owner is null or (btrim(lease_owner) <> '' and length(lease_owner) <= 200)),
  lease_sequence bigint not null default 0 check (lease_sequence >= 0),
  lease_expires_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count between 0 and 20),
  next_attempt_at timestamptz not null default now(),
  last_error_code text check (
    last_error_code is null
    or (last_error_code ~ '^[A-Z][A-Z0-9_]{1,119}$')
  ),
  idempotency_key text not null unique check (
    btrim(idempotency_key) <> '' and length(idempotency_key) <= 200
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint cloud_provider_access_check_jobs_source_owner_fk
    foreign key (user_id, source_id)
    references public.cloud_sources(user_id, id)
    on update cascade on delete cascade,
  constraint cloud_provider_access_check_jobs_lease_ck check (
    (state = 'leased' and lease_owner is not null and lease_expires_at is not null and expected_access_revision is not null)
    or (state <> 'leased' and lease_owner is null and lease_expires_at is null)
  ),
  constraint cloud_provider_access_check_jobs_terminal_ck check (
    (state in ('completed','dead') and completed_at is not null)
    or (state not in ('completed','dead') and completed_at is null)
  )
);

create unique index cloud_provider_access_check_jobs_one_open_source_uidx
  on public.cloud_provider_access_check_jobs (source_id)
  where state in ('queued','leased','retry');

create index cloud_provider_access_check_jobs_due_idx
  on public.cloud_provider_access_check_jobs (next_attempt_at, created_at, id)
  where state in ('queued','retry');

alter table public.cloud_provider_access_check_jobs enable row level security;
revoke all on table public.cloud_provider_access_check_jobs
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.cloud_provider_access_check_jobs
  to service_role;

create or replace function public.norva_schedule_provider_access_checks(
  p_limit integer default 100,
  p_now timestamptz default now()
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_scheduled integer := 0;
begin
  perform public.norva_provider_access_capability_required('provider_access_v1_enabled');
  perform public.norva_provider_access_capability_required('provider_access_auto_detection_v1_enabled');
  if p_limit is null or p_limit < 1 or p_limit > 500 or p_now is null then
    raise exception 'invalid Provider Access scheduling bound' using errcode = '22023';
  end if;

  insert into public.cloud_provider_access_check_jobs (
    user_id, source_id, state, next_attempt_at, idempotency_key
  )
  select source.user_id, source.id, 'queued', p_now,
    'provider-access-check:' || source.id::text || ':' || to_char(p_now at time zone 'UTC', 'YYYY-MM-DD')
  from public.cloud_sources source
  join public.cloud_source_lifecycle lifecycle
    on lifecycle.source_id = source.id and lifecycle.user_id = source.user_id
  join public.cloud_source_provider_access access
    on access.source_id = source.id and access.user_id = source.user_id
  where source.source_type = 'xtream'
    and source.enabled and source.deleted_at is null
    and lifecycle.lifecycle_state = 'active'
    and (
      access.provider_access_status = 'restoring'
      or access.provider_access_last_checked_at is null
      or access.provider_access_last_checked_at <= p_now - interval '24 hours'
    )
    and not exists (
      select 1 from public.cloud_provider_access_check_jobs open_job
      where open_job.source_id = source.id and open_job.state in ('queued','leased','retry')
    )
  order by access.provider_access_last_checked_at nulls first, source.id
  limit p_limit
  on conflict do nothing;
  get diagnostics v_scheduled = row_count;
  return jsonb_build_object('scheduled', v_scheduled, 'limit', p_limit);
end
$function$;

create or replace function public.norva_claim_provider_access_check_jobs(
  p_worker text,
  p_limit integer default 1,
  p_lease_seconds integer default 180
) returns table (
  job_id uuid,
  user_id uuid,
  source_id uuid,
  expected_access_revision bigint,
  lease_sequence bigint,
  attempt_count integer
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform public.norva_provider_access_capability_required('provider_access_v1_enabled');
  perform public.norva_provider_access_capability_required('provider_access_auto_detection_v1_enabled');
  if p_worker is null or btrim(p_worker) = '' or length(p_worker) > 200
     or p_limit is null or p_limit < 1 or p_limit > 10
     or p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 600 then
    raise exception 'invalid Provider Access claim request' using errcode = '22023';
  end if;

  update public.cloud_provider_access_check_jobs job
  set state = 'retry', lease_owner = null, lease_expires_at = null,
      expected_access_revision = null, next_attempt_at = now(),
      last_error_code = 'LEASE_EXPIRED', updated_at = now()
  where job.state = 'leased' and job.lease_expires_at <= now();

  return query
  with candidates as materialized (
    select job.id
    from public.cloud_provider_access_check_jobs job
    where job.state in ('queued','retry') and job.next_attempt_at <= now()
    order by job.next_attempt_at, job.created_at, job.id
    for update skip locked
    limit p_limit
  ), claimed as (
    update public.cloud_provider_access_check_jobs job
    set state = 'leased', lease_owner = p_worker,
        lease_sequence = job.lease_sequence + 1,
        lease_expires_at = now() + make_interval(secs => p_lease_seconds),
        attempt_count = job.attempt_count + 1,
        expected_access_revision = access.revision,
        last_error_code = null, updated_at = now()
    from candidates, public.cloud_source_provider_access access
    where job.id = candidates.id
      and access.user_id = job.user_id and access.source_id = job.source_id
    returning job.id, job.user_id, job.source_id,
      job.expected_access_revision, job.lease_sequence, job.attempt_count
  )
  select claimed.id, claimed.user_id, claimed.source_id,
    claimed.expected_access_revision, claimed.lease_sequence, claimed.attempt_count
  from claimed;
end
$function$;

create or replace function public.norva_apply_claimed_provider_access_detection(
  p_job_id uuid,
  p_worker text,
  p_expected_lease_sequence bigint,
  p_detection jsonb,
  p_checked_at timestamptz,
  p_retry_after_seconds integer default null
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_job public.cloud_provider_access_check_jobs%rowtype;
  v_result jsonb;
  v_retry boolean;
begin
  perform public.norva_provider_access_capability_required('provider_access_v1_enabled');
  perform public.norva_provider_access_capability_required('provider_access_auto_detection_v1_enabled');
  if p_job_id is null or p_worker is null or btrim(p_worker) = ''
     or p_expected_lease_sequence is null or p_expected_lease_sequence < 1
     or p_checked_at is null
     or (p_retry_after_seconds is not null and (p_retry_after_seconds < 15 or p_retry_after_seconds > 3600)) then
    raise exception 'invalid claimed Provider Access detection' using errcode = '22023';
  end if;
  select job.* into strict v_job
  from public.cloud_provider_access_check_jobs job
  where job.id = p_job_id
  for update;
  if v_job.state <> 'leased'
     or v_job.lease_owner is distinct from p_worker
     or v_job.lease_sequence is distinct from p_expected_lease_sequence
     or v_job.lease_expires_at <= now() then
    raise exception 'Provider Access check lease is stale' using errcode = '40001';
  end if;

  v_result := public.norva_apply_provider_access_detection(
    v_job.user_id, v_job.source_id, v_job.expected_access_revision,
    p_detection, p_checked_at,
    v_job.id::text || ':lease:' || p_expected_lease_sequence::text,
    'provider-access-worker'
  );
  v_retry := p_retry_after_seconds is not null and v_job.attempt_count < 5;
  update public.cloud_provider_access_check_jobs job
  set state = case when v_retry then 'retry' else 'completed' end,
      lease_owner = null, lease_expires_at = null, expected_access_revision = null,
      next_attempt_at = case when v_retry then now() + make_interval(secs => p_retry_after_seconds) else job.next_attempt_at end,
      completed_at = case when v_retry then null else now() end,
      last_error_code = case when v_retry then 'PROVIDER_CHECK_TEMPORARY_FAILURE' else null end,
      updated_at = now()
  where job.id = v_job.id and job.state = 'leased'
    and job.lease_owner = p_worker and job.lease_sequence = p_expected_lease_sequence;
  if not found then raise exception 'Provider Access check lease is stale' using errcode = '40001'; end if;
  return v_result || jsonb_build_object(
    'jobId', v_job.id,
    'jobState', case when v_retry then 'RETRY' else 'COMPLETED' end
  );
end
$function$;

create or replace function public.norva_fail_provider_access_check_job(
  p_job_id uuid,
  p_worker text,
  p_expected_lease_sequence bigint,
  p_error_code text,
  p_retryable boolean,
  p_retry_after_seconds integer default 60
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_job public.cloud_provider_access_check_jobs%rowtype;
  v_retry boolean;
begin
  perform public.norva_provider_access_service_role_required();
  if p_job_id is null or p_worker is null or btrim(p_worker) = ''
     or p_expected_lease_sequence is null or p_expected_lease_sequence < 1
     or p_error_code is null or p_error_code !~ '^[A-Z][A-Z0-9_]{1,119}$'
     or p_retryable is null or p_retry_after_seconds < 15 or p_retry_after_seconds > 3600 then
    raise exception 'invalid Provider Access failure settlement' using errcode = '22023';
  end if;
  select job.* into strict v_job from public.cloud_provider_access_check_jobs job
  where job.id = p_job_id for update;
  if v_job.state <> 'leased' or v_job.lease_owner is distinct from p_worker
     or v_job.lease_sequence is distinct from p_expected_lease_sequence then
    raise exception 'Provider Access check lease is stale' using errcode = '40001';
  end if;
  v_retry := p_retryable and v_job.attempt_count < 5;
  update public.cloud_provider_access_check_jobs job
  set state = case when v_retry then 'retry' else 'dead' end,
      lease_owner = null, lease_expires_at = null, expected_access_revision = null,
      next_attempt_at = case when v_retry then now() + make_interval(secs => p_retry_after_seconds) else job.next_attempt_at end,
      completed_at = case when v_retry then null else now() end,
      last_error_code = p_error_code, updated_at = now()
  where job.id = v_job.id and job.state = 'leased'
    and job.lease_owner = p_worker and job.lease_sequence = p_expected_lease_sequence;
  if not found then raise exception 'Provider Access check lease is stale' using errcode = '40001'; end if;
  return jsonb_build_object('jobId', v_job.id, 'state', case when v_retry then 'RETRY' else 'DEAD' end);
end
$function$;

create or replace function public.norva_prune_provider_access_check_jobs(
  p_limit integer default 500
) returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare v_deleted integer;
begin
  perform public.norva_provider_access_service_role_required();
  if p_limit is null or p_limit < 1 or p_limit > 5000 then
    raise exception 'invalid Provider Access prune bound' using errcode = '22023';
  end if;
  with victims as materialized (
    select job.id from public.cloud_provider_access_check_jobs job
    where job.state in ('completed','dead') and job.completed_at < now() - interval '30 days'
    order by job.completed_at, job.id for update skip locked limit p_limit
  )
  delete from public.cloud_provider_access_check_jobs job using victims
  where job.id = victims.id;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end
$function$;

-- Installation is explicit and capability-gated. Applying the migration to a
-- proof/staging database never schedules network traffic by itself.
create or replace function public.norva_install_provider_access_check_cron()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare v_job_id bigint;
begin
  perform public.norva_provider_access_capability_required('provider_access_v1_enabled');
  perform public.norva_provider_access_capability_required('provider_access_auto_detection_v1_enabled');
  if to_regprocedure('cron.schedule(text,text,text)') is null
     or to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null
     or not exists (select 1 from vault.decrypted_secrets where name='norva_cron_shared_secret' and decrypted_secret <> '')
     or not exists (select 1 from vault.decrypted_secrets where name='norva_provider_access_worker_token' and decrypted_secret <> '') then
    raise exception 'Provider Access cron prerequisites unavailable'
      using errcode = '55000', detail = 'reason=cron_prerequisites_unavailable';
  end if;
  select jobid into v_job_id from cron.job where jobname='norva-provider-access-checks';
  if v_job_id is not null then perform cron.unschedule(v_job_id); end if;
  v_job_id := cron.schedule(
    'norva-provider-access-checks', '* * * * *',
    $job$
      select net.http_post(
        url := 'https://api.norva.tv/functions/v1/norva-provider-access/internal/access-check/drain',
        headers := jsonb_build_object(
          'Content-Type','application/json',
          'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='norva_cron_shared_secret' limit 1),
          'X-Norva-Worker-Token',(select decrypted_secret from vault.decrypted_secrets where name='norva_provider_access_worker_token' limit 1)
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 180000
      );
    $job$
  );
  return jsonb_build_object('installed', true, 'jobId', v_job_id, 'schedule', '* * * * *');
end
$function$;

revoke all on function public.norva_apply_provider_access_detection(uuid,uuid,bigint,jsonb,timestamptz,text,text)
  from service_role;
revoke all on function public.norva_schedule_provider_access_checks(integer,timestamptz)
  from public, anon, authenticated;
revoke all on function public.norva_claim_provider_access_check_jobs(text,integer,integer)
  from public, anon, authenticated;
revoke all on function public.norva_apply_claimed_provider_access_detection(uuid,text,bigint,jsonb,timestamptz,integer)
  from public, anon, authenticated;
revoke all on function public.norva_fail_provider_access_check_job(uuid,text,bigint,text,boolean,integer)
  from public, anon, authenticated;
revoke all on function public.norva_prune_provider_access_check_jobs(integer)
  from public, anon, authenticated;
revoke all on function public.norva_install_provider_access_check_cron()
  from public, anon, authenticated;

grant execute on function public.norva_schedule_provider_access_checks(integer,timestamptz) to service_role;
grant execute on function public.norva_claim_provider_access_check_jobs(text,integer,integer) to service_role;
grant execute on function public.norva_apply_claimed_provider_access_detection(uuid,text,bigint,jsonb,timestamptz,integer) to service_role;
grant execute on function public.norva_fail_provider_access_check_job(uuid,text,bigint,text,boolean,integer) to service_role;
grant execute on function public.norva_prune_provider_access_check_jobs(integer) to service_role;
grant execute on function public.norva_install_provider_access_check_cron() to service_role;
