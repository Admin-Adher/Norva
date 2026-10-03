begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

-- Finish a bounded partial file before opening another file. Receipts/captures
-- have a two-hour TTL; pure FIFO under admission contention expired evidence.
-- Keep owner checks, orphan deferral, the two-job limit and eight attempts.
do $f$
declare definition text; original text; replacement text;
begin
  definition:=pg_get_functiondef('public.claim_selection_audio_job()'::regprocedure);
  original:='job.priority desc,job.next_attempt_at,job.created_at,job.external_id,job.url_sha256';
  replacement:='case when case when jsonb_typeof(job.progress->''receipts'')=''array''
      then jsonb_array_length(job.progress->''receipts'') else 0 end>0 then 0 else 1 end,
      job.priority desc,job.next_attempt_at,job.created_at,job.external_id,job.url_sha256';
  if position(original in definition)=0 or position(replacement in definition)>0 then
    raise exception 'SELECTION_PARTIAL_PRIORITY_SOURCE_DRIFT';
  end if;
  execute replace(definition,original,replacement);
end $f$;
commit;
