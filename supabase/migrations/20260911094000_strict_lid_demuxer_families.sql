-- Accept exact FFprobe demuxer families already admitted by observed-file
-- persistence and the playback worker. Do not rewrite snapshots/fingerprints:
-- existing cache certificates and active jobs must retain their identity.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '20s';

DO $migration$
DECLARE
  target regprocedure := 'public.start_automatic_catalog_file_audio_validation_job(uuid,uuid,uuid,text,text,text,integer[],jsonb,text,timestamptz,bigint,jsonb,boolean)'::regprocedure;
  definition text := pg_get_functiondef(target);
  old_formats text := $old$'mkv', 'matroska', 'matroskawebm', 'mp4', 'mov', 'avi', 'ogg', 'flv', 'mpg', 'ts'$old$;
  new_formats text := $new$'mkv', 'matroska', 'matroskawebm', 'webm', 'mp4', 'mov', 'movmp4m4a3gp3g2mj2', 'avi', 'ogg', 'flv', 'mpg', 'mpeg', 'ts', 'mpegts'$new$;
BEGIN
  -- Fail closed on drift rather than replacing a function with an old copy.
  -- CREATE OR REPLACE from its current definition preserves ownership, ACL,
  -- security attributes and every tenant/quota/finalization check.
  IF position(new_formats IN definition) > 0 AND position(old_formats IN definition) = 0 THEN
    RETURN;
  END IF;
  IF (length(definition)-length(replace(definition,old_formats,''))) <> length(old_formats)
     OR position('v_profile_snapshot->>''container'' not in (' IN definition) = 0 THEN
    RAISE EXCEPTION 'Strict LID container guard drifted';
  END IF;
  EXECUTE replace(definition, old_formats, new_formats);
END
$migration$;

COMMIT;
