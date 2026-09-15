begin;
set local lock_timeout='2s';
set local statement_timeout='10s';

-- cron.schedule(name,...) is unique per OWNER, not globally. A rollout run by
-- postgres must replace the existing supabase_admin job instead of leaving
-- the legacy 90-second source-locking transaction active alongside discovery.
do $migration$
declare v_keep bigint; v_job record;
begin
  select min(jobid) into v_keep from cron.job where jobname='norva-catalog-tmdb-merge';
  if v_keep is null then raise exception 'expected catalogue merge cron is absent'; end if;
  for v_job in select jobid from cron.job where jobname='norva-catalog-tmdb-merge' order by jobid
  loop
    perform cron.alter_job(v_job.jobid,
      schedule=>'7-59/10 * * * *',
      command=>$$set statement_timeout='90s'; select public.norva_queue_validated_tmdb_merges(300);$$,
      active=>(v_job.jobid=v_keep));
  end loop;
  if (select count(*) from cron.job where jobname='norva-catalog-tmdb-merge' and active)<>1
    or exists(select 1 from cron.job where jobname='norva-catalog-tmdb-merge' and active
      and command like '%norva_canonicalize_titles_for_user%') then
    raise exception 'legacy catalogue merge cron still active';
  end if;
end
$migration$;
commit;
