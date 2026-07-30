-- « Générer des sous-titres IA » — V1 UX/correctness (audit 2026-07-02, docs/AI-SUBTITLES-V1.md).
--
-- 1) `stage` : progression honnête d'un job (queued / deferred / extracting / transcribing),
--    stampée par les heartbeats du gateway via transcribe-callback (branche non-terminale).
--    Le heartbeat bump AUSSI updated_at → un job vivant (déféré des heures par la lecture du
--    viewer) n'est plus fauché par le reaper 2 h ni volé par le claim TTL 90 min : les quatre
--    timers (poll client 2 h ≤ reaper 2 h < defer cap 4 h, claim 90 min) redeviennent cohérents
--    parce que updated_at reflète enfin la VIE du job, pas son dernier changement de status.
alter table public.catalog_generated_subtitles add column if not exists stage text;

-- 2) Reaper : couvre désormais aussi les lignes `pending-transcript` orphelines (chaînage
--    traduction : l'intention est résolue par le callback du transcript ; si ce transcript est
--    lui-même fauché par le reaper — pas de callback — l'intention resterait pending pour
--    toujours). 24 h >> le pire cas légitime (defer 4 h + whisper long).
do $block$
declare
  v_job_id bigint;
begin
  select jobid
    into v_job_id
    from cron.job
   where jobname = 'norva-generated-subtitle-reaper';

  -- This job pre-dated its versioned creation in
  -- 20260717150000_subtitle_notify_v2.sql. A fresh migration replay must not
  -- pass NULL to cron.alter_job; the later migration installs the full command.
  if v_job_id is null then
    raise notice 'norva-generated-subtitle-reaper is not installed yet; command update deferred';
    return;
  end if;

  perform cron.alter_job(
    v_job_id,
    command => $reap$
  update public.catalog_generated_subtitles
     set status = 'failed',
         error = coalesce(error, '') || ' [reaped: stuck in processing > 2h]',
         updated_at = now()
   where status = 'processing'
     and updated_at < now() - interval '2 hours';
  update public.catalog_generated_subtitles
     set status = 'failed',
         error = coalesce(error, '') || ' [reaped: pending-transcript orphaned > 24h]',
         updated_at = now()
   where status = 'pending-transcript'
     and updated_at < now() - interval '24 hours';
$reap$);
end
$block$;
