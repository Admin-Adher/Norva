-- An obsolete manual job must not poison the user's entire next request.
-- Retain its evidence; only terminalize due, unleased/expired manual work.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '20s';
DO $migration$
DECLARE
  target regprocedure := 'public.start_catalog_file_audio_validation_job(uuid,uuid,uuid,text,text,integer[],text,timestamptz,bigint,jsonb)'::regprocedure;
  definition text := pg_get_functiondef(target);
  marker text := '-- Retire obsolete due manual work before attempting to requeue it.';
  old_block text := $old$  update public.catalog_file_audio_validation_jobs job
     set state = 'queued',$old$;
  new_block text := $new$  -- Retire obsolete due manual work before attempting to requeue it.
  -- The existing requester lock serializes this maintenance. Never change
  -- automatic work, a live worker lease, terminal/quarantined rows or cache
  -- evidence. The observed-profile trigger remains the final authority.
  update public.catalog_file_audio_validation_jobs job
     set state = 'failed',
         error_code = 'PROFILE_CHANGED',
         lease_owner = null,
         lease_expires_at = null,
         queue_expires_at = null,
         retry_at = null,
         purge_after = v_now + interval '7 days',
         updated_at = v_now
   where job.requested_by = p_requested_by
     and job.request_origin <> 'automatic'
     and (job.lease_expires_at is null or job.lease_expires_at <= v_now)
     and (
       (job.state in ('running', 'finalizing') and job.lease_expires_at <= v_now)
       or (job.state = 'retry_wait' and (job.retry_at is null or job.retry_at <= v_now))
     )
     and exists (
       select 1 from public.catalog_file_tracks cache
       where cache.server_host = job.identity_key
         and cache.item_type = job.item_type
         and cache.external_id = job.external_id
         and cache.observed_profile_fingerprint is not null
         and (
              job.profile_fingerprint is distinct from cache.observed_profile_fingerprint
           or job.profile_probed_at is distinct from cache.observed_profile_probed_at
           or job.profile_snapshot is distinct from cache.observed_profile_snapshot
           or job.file_size_bytes is distinct from public.vod_language_profile_file_size_bytes(cache.observed_profile_snapshot)
         )
     );

  update public.catalog_file_audio_validation_jobs job
     set state = 'queued',$new$;
BEGIN
  IF position(marker IN definition) > 0 THEN RETURN; END IF;
  IF (length(definition)-length(replace(definition,old_block,''))) <> length(old_block)
     OR position('catalog-file-audio-validation-user:' IN definition) = 0
     OR position('job.request_origin <> ''automatic''' IN definition) = 0 THEN
    RAISE EXCEPTION 'Manual validation requeue guard drifted';
  END IF;
  EXECUTE replace(definition, old_block, new_block);
END
$migration$;
COMMIT;
