begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

-- cron.schedule updates an existing named job's schedule and command but does
-- not change a deliberately paused job back to active. Reactivation is an
-- explicit second operation so a repaired worker cannot remain silently dark.
do $activation$
declare
  v_job_id bigint;
begin
  select job.jobid
    into strict v_job_id
  from cron.job job
  where job.jobname = 'norva-facet-summary-refresh';

  perform cron.alter_job(v_job_id, active => true);

  if not exists (
    select 1
    from cron.job job
    where job.jobid = v_job_id
      and job.active
      and job.schedule = '7-59/15 * * * *'
      and job.command =
        'set statement_timeout=''120s''; select public.cloud_refresh_all_facet_summaries(50);'
  ) then
    raise exception 'facet refresh cron activation did not converge'
      using errcode = '55000', detail = 'reason=cron_activation_mismatch';
  end if;
end
$activation$;

commit;
