-- Match the already accepted finite-file Gateway demuxer names. This is a
-- profile-eligibility check, not a language certificate or a job admission.
-- Preserve all other exact-file, track, ACL, ownership and evidence checks.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '20s';

DO $migration$
DECLARE
  target regprocedure := 'public.vod_language_profile_is_exact(jsonb)'::regprocedure;
  definition text := pg_get_functiondef(target);
  old_formats text := $old$'mkv', 'matroska', 'mp4', 'mov', 'avi', 'ogg', 'flv', 'mpg', 'mpeg'$old$;
  new_formats text := $new$'mkv', 'matroska', 'mp4', 'mov', 'avi', 'ogg', 'flv', 'mpg', 'mpeg', 'm4v', 'movmp4m4a3gp3g2mj2', 'ts', 'mpegts'$new$;
BEGIN
  IF position(new_formats IN definition) > 0 THEN
    RETURN;
  END IF;
  IF (length(definition)-length(replace(definition,old_formats,''))) <> length(old_formats)
     OR position('normalized.container_token in (' IN definition) = 0
     OR position('public.vod_language_profile_file_size_bytes(p_profile) is not null' IN definition) = 0
     OR position('public.vod_language_profile_audio_indices(p_profile)' IN definition) = 0 THEN
    RAISE EXCEPTION 'Exact VOD profile guard drifted';
  END IF;
  EXECUTE replace(definition, old_formats, new_formats);
END
$migration$;

COMMIT;
