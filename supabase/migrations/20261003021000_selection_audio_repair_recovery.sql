begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

-- One archived operator recovery for the now-repaired admission/receipt bugs.
-- The old 24h gate remains for unrelated generic failures. This narrowly scoped
-- hotfix recovery needs the exact reviewed repair revision, never user input.
do $f$
declare definition text; original text; replacement text;
begin
  definition:=pg_get_functiondef('public.recover_selection_audio_job(uuid,timestamptz,text)'::regprocedure);
  original:=$old$or prior.completed_at>clock_timestamp()-interval '24 hours'
    or prior.error_code not in ('SELECTION_AUDIO_GATEWAY_REJECTED','ATTEMPT_LIMIT')$old$;
  replacement:=$new$or not (
      (prior.error_code in ('SELECTION_AUDIO_GATEWAY_REJECTED','ATTEMPT_LIMIT')
        and prior.completed_at<=clock_timestamp()-interval '24 hours')
      or (prior.error_code in ('SELECTION_AUDIO_VIEWER_BUSY',
          'SELECTION_AUDIO_CHECKPOINT_RESET_REQUIRED','SELECTION_AUDIO_CAPTURE_LOCAL_RETRY')
        and p_repair_revision='2d02867c337f1a824e82908005fb14fd2c6d3388')
    )$new$;
  if position(original in definition)=0 or position(replacement in definition)>0 then
    raise exception 'SELECTION_REPAIR_RECOVERY_SOURCE_DRIFT';
  end if;
  execute replace(definition,original,replacement);
end $f$;
commit;
