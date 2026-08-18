-- Durable retries must not depend on the viewer reopening the same title.
-- Select at most one due job per provider identity; the existing job claim,
-- provider-account lease and foreground-playback gates remain authoritative.
create or replace function public.list_due_catalog_file_audio_validation_jobs(
  p_limit integer default 2
) returns table(job_id uuid)
language sql
stable
security definer
set search_path = ''
as $function$
  with due as (
    select
      job.id,
      job.identity_key,
      coalesce(job.retry_at, job.lease_expires_at, job.created_at) as due_at,
      row_number() over (
        partition by job.identity_key
        order by
          case job.state
            when 'queued' then 0
            when 'retry_wait' then 1
            else 2
          end,
          coalesce(job.retry_at, job.lease_expires_at, job.created_at),
          job.created_at,
          job.id
      ) as provider_rank
    from public.catalog_file_audio_validation_jobs job
    where job.state = 'queued'
       or (
         job.state = 'retry_wait'
         and (job.retry_at is null or job.retry_at <= now())
       )
       or (
         job.state in ('running', 'finalizing')
         and job.lease_expires_at is not null
         and job.lease_expires_at <= now()
       )
  )
  select due.id as job_id
  from due
  where due.provider_rank = 1
  order by due.due_at, due.id
  limit greatest(1, least(coalesce(p_limit, 2), 4))
$function$;

revoke all on function public.list_due_catalog_file_audio_validation_jobs(integer)
  from public, anon, authenticated;
grant execute on function public.list_due_catalog_file_audio_validation_jobs(integer)
  to service_role;

comment on function public.list_due_catalog_file_audio_validation_jobs(integer) is
  'Service-only bounded selector for durable exact-file language validation retries; one due job per provider identity.';

-- The endpoint authenticates the dedicated Vault cron secret and only schedules
-- durable job IDs selected by the service-only function above. It never receives
-- a provider URL, credential or user token.
do $schedule$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'cron' and p.proname = 'schedule'
  ) and exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'net' and p.proname = 'http_post'
  ) then
    perform cron.schedule(
      'norva-playback-language-validation-worker',
      '* * * * *',
      $job$
        select net.http_post(
          url := 'https://api.norva.tv/functions/v1/norva-playback/language-validation-worker',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || (
              select decrypted_secret
              from vault.decrypted_secrets
              where name = 'norva_cron_shared_secret'
              limit 1
            )
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 10000
        );
      $job$
    );
  end if;
end
$schedule$;
