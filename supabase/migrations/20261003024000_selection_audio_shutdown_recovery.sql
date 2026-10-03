begin;
set local lock_timeout='3s';
set local statement_timeout='30s';
-- One archived recovery of the old worker's proven deployment interruption.
-- Safe shutdown is now checkpointed with a positive drain, before compute.
-- Do not widen generic retries, reset completed/inconclusive jobs, or repeat
-- an already archived exact-file recovery.
do $f$
declare definition text; original text; replacement text;
begin
 definition:=pg_get_functiondef('public.recover_selection_audio_job(uuid,timestamptz,text)'::regprocedure);
 original:=$old$and p_repair_revision='2d02867c337f1a824e82908005fb14fd2c6d3388')$old$;
 replacement:=$new$and p_repair_revision='2d02867c337f1a824e82908005fb14fd2c6d3388')
      or (prior.error_code='SELECTION_AUDIO_ABORTED'
        and p_repair_revision='ad790c1a41b07434dc8bb595388e6365b0dc3c67')$new$;
 if position(original in definition)=0 or position(replacement in definition)>0 then raise exception 'SELECTION_SHUTDOWN_RECOVERY_SOURCE_DRIFT';end if;
 execute replace(definition,original,replacement);
end $f$;
commit;
