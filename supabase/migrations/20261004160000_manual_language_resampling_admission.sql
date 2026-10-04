-- Explicit resampling uses the manual tenant budget. A full automatic backlog
-- must not block it. Provider queue bounds and execution admission stay intact.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
do $patch$
declare d text; old text; replacement text;
  target regprocedure := 'public.start_resampled_catalog_file_audio_validation_job(uuid,uuid,uuid,text,text,text,integer[],jsonb,text,timestamptz,bigint,jsonb,boolean,integer)'::regprocedure;
begin
  d := replace(pg_get_functiondef(target), E'\r\n', E'\n');
  if md5(d) <> '2ce3215e0b6983199aa16935481f0537' then
    raise exception 'Explicit language resampling definition drifted';
  end if;
  old := $old$  if not exists(select 1 from public.admin_feature_flags where key='adaptive_language_admission_enabled' and enabled) then$old$;
  replacement := $new$  -- The existing owner advisory lock serializes ordinary manual requests too.
  select count(*)::integer,
         min(coalesce(job.queue_expires_at, job.lease_expires_at, job.retry_at))
    into v_active_count, v_quota_retry_at
  from public.catalog_file_audio_validation_jobs job
  where job.requested_by = p_requested_by
    and job.request_origin = 'manual'
    and job.state in ('queued', 'running', 'retry_wait', 'finalizing');
  if v_active_count >= 2 then
    return jsonb_build_object('limited', true,
      'code', 'LANGUAGE_VALIDATION_CONCURRENCY_LIMIT',
      'retryAt', coalesce(v_quota_retry_at, v_now + interval '30 seconds'),
      'retryAfterSeconds', greatest(1, least(900,
        ceil(extract(epoch from (coalesce(v_quota_retry_at, v_now + interval '30 seconds') - v_now)))::integer)));
  end if;

$new$ || old;
  if (length(d)-length(replace(d,old,'')))/length(old) <> 1 then
    raise exception 'Explicit language admission guard drifted';
  end if;
  d := replace(d, old, replacement);
  old := '  if not public.catalog_language_queue_available(btrim(p_identity_key)) then';
  replacement := $new$  -- Under the unchanged admission lock, retain four outstanding files for
  -- this provider identity, including work belonging to other Norva owners.
  if (select count(*) from public.catalog_file_audio_validation_jobs job
      where job.identity_key = btrim(p_identity_key)
        and job.state in ('queued', 'running', 'retry_wait', 'finalizing')) >= 4 then$new$;
  if (length(d)-length(replace(d,old,'')))/length(old) <> 1 then
    raise exception 'Explicit language queue guard drifted';
  end if;
  execute replace(d, old, replacement);
end $patch$;
commit;
