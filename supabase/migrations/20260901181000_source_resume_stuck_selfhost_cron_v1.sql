begin;

-- The source-resume watchdog is part of the self-hosted production control
-- plane.  The historical managed-Supabase hostname was decommissioned and a
-- pg_net enqueue could therefore look successful while the HTTP delivery
-- failed later with "Couldn't resolve host name".  Keep exactly one logical
-- dispatcher and point it at the canonical self-hosted Edge ingress.
do $cron_repair$
declare
  v_job_id bigint;
  v_job_count integer;
  v_secret_count integer;
  v_command text := $command$
      select net.http_post(
        url := 'https://api.norva.tv/functions/v1/norva-source-sync/cron/resume-stuck',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (
            select decrypted_secret
            from vault.decrypted_secrets
            where name = 'norva_cron_shared_secret'
          )
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 5000
      )
      where exists (
        select 1
        from public.cloud_sources source
        where source.source_type in ('xtream', 'm3u')
          and source.sync_status in ('syncing', 'error')
          and source.enabled
          and source.deleted_at is null
      );
    $command$;
begin
  if to_regnamespace('cron') is null then
    raise exception 'required pg_cron schema is unavailable'
      using errcode = '55000';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'norva-cron-job:norva-resume-stuck-sync', 0
  ));

  select count(*) into v_secret_count
  from vault.decrypted_secrets secret
  where secret.name = 'norva_cron_shared_secret'
    and nullif(secret.decrypted_secret, '') is not null;
  if v_secret_count <> 1 then
    raise exception 'exactly one non-empty norva_cron_shared_secret is required'
      using errcode = '55000';
  end if;

  select count(*), min(jobid)
  into v_job_count, v_job_id
  from cron.job
  where jobname in ('norva-resume-stuck-sync', 'norva-resume-stuck')
     or command like '%/norva-source-sync/cron/resume-stuck%';

  if v_job_count > 1 then
    raise exception 'exactly one norva-resume-stuck-sync job is required'
      using errcode = '55000';
  elsif v_job_count = 0 then
    v_job_id := cron.schedule(
      'norva-resume-stuck-sync', '* * * * *', v_command
    );
  else
    -- Deliberately preserve the current active state.  Production deployment
    -- can quiesce the dispatcher before applying this migration, then activate
    -- it atomically with the mandatory material-observation restart.  Normal
    -- installs retain the already-active state created by the earlier schema.
    perform cron.alter_job(
      v_job_id,
      schedule => '* * * * *',
      command => v_command
    );
  end if;

  if v_job_id is null then
    raise exception 'norva-resume-stuck-sync job repair did not return a job id'
      using errcode = '55000';
  end if;

  if not exists (
    select 1
    from cron.job job
    where job.jobid = v_job_id
      and (
        job.jobname in ('norva-resume-stuck-sync', 'norva-resume-stuck')
        or job.command like '%/norva-source-sync/cron/resume-stuck%'
      )
      and job.schedule = '* * * * *'
      and job.command like '%https://api.norva.tv/functions/v1/norva-source-sync/cron/resume-stuck%'
      and job.command not like '%oupsceccxsonaalhueff.supabase.co%'
  ) then
    raise exception 'norva-resume-stuck-sync self-host command verification failed'
      using errcode = '55000';
  end if;
end
$cron_repair$;

commit;
