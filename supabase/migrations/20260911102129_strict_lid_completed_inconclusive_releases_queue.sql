-- A completed, non-certifying receipt set is an outcome, not runnable work.
-- Keep its evidence and the existing retry cooldown, but release its active
-- queue slot. Infrastructure failures and unfinished windows still retry.
-- This migration changes no existing job, certificate, quota or quarantine.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '20s';

DO $migration$
DECLARE
  target regprocedure := 'public.fail_catalog_file_audio_validation_job(uuid,text,text,boolean,timestamptz)'::regprocedure;
  definition text := pg_get_functiondef(target);
  old_transition text := $old$  v_code := left(v_code, 64);$old$;
  new_transition text := $new$  v_code := left(v_code, 64);
  -- Completed evidence must not reserve a tenant slot for another 24 hours.
  -- This is NOT a language certificate and never resets/replays a receipt.
  if v_code = 'LANGUAGE_VALIDATION_STRICT_CONSENSUS_PENDING'
     and v_job.quarantined_at is null
     and v_job.verified_at is null
     and v_job.lease_expires_at > v_now
     and v_job.strict_lid_window_protocol = 1
     and v_job.strict_lid_window_count in (4, 6)
     and v_job.strict_lid_window_position = v_job.strict_lid_window_count
     and jsonb_array_length(v_job.strict_lid_window_tokens) = v_job.strict_lid_window_count
     and public.strict_lid_window_tokens_are_valid(v_job.strict_lid_window_tokens) then
    p_terminal := true;
    v_code := 'LANGUAGE_VALIDATION_STRICT_CONSENSUS_INCONCLUSIVE';
  end if;$new$;
  old_status text := $old$    'status', 'pending',$old$;
  new_status text := $new$    'status', case when coalesce(p_terminal, false) then 'failed' else 'pending' end,
    'jobId', v_job.id,$new$;
BEGIN
  IF position(new_transition IN definition) > 0 AND position(new_status IN definition) > 0 THEN
    RETURN;
  END IF;
  IF (length(definition)-length(replace(definition,old_transition,''))) <> length(old_transition)
     OR (length(definition)-length(replace(definition,old_status,''))) <> length(old_status)
     OR position('LANGUAGE_VALIDATION_STRICT_CONSENSUS_INCONCLUSIVE' IN definition) > 0 THEN
    RAISE EXCEPTION 'Strict LID completed-outcome guard drifted';
  END IF;
  -- Preserve the deployed ownership, ACL, search_path and all other logic.
  EXECUTE replace(replace(definition,old_transition,new_transition),old_status,new_status);
END
$migration$;

COMMIT;
