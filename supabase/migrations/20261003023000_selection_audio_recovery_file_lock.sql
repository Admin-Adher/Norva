begin;
set local lock_timeout='3s';
set local statement_timeout='30s';
-- Recovery locks a failed job row and creates/archives its replacement atomically.
-- New rows are invisible until commit; the worker cannot claim an intermediate
-- replacement. Serialize competing recovery operators per original job instead
-- of starving the global two-job worker admission during source verification.
do $f$
declare definition text; original text; replacement text;
begin
 definition:=pg_get_functiondef('public.recover_selection_audio_job(uuid,timestamptz,text)'::regprocedure);
 original:='pg_try_advisory_xact_lock(hashtextextended(''selection-audio-global-worker-v1'',0))';
 replacement:='pg_try_advisory_xact_lock(hashtextextended(''selection-audio-recovery-v1:''||p_job_id::text,0))';
 if position(original in definition)=0 then raise exception 'SELECTION_RECOVERY_LOCK_SOURCE_DRIFT';end if;
 execute replace(definition,original,replacement);
end $f$;
commit;
