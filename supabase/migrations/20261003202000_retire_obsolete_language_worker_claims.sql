begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

-- A due job for an older observed file repeatedly fails the profile trigger
-- while keeping first place in dispatch. Retire only that obsolete job before
-- admitting it; never rewrite its evidence or the current file certificate.
do $patch$
declare d text; old text; replacement text;
begin
 d:=pg_get_functiondef('public.claim_catalog_file_audio_validation_job(uuid,text,integer)'::regprocedure);
 old:=$old$  if not v_is_renewal then
    perform pg_advisory_xact_lock(hashtextextended('catalog-language-admission',0));$old$;
 if (length(d)-length(replace(d,old,'')))/length(old)<>1 then
   raise exception 'Language worker admission guard drifted';
 end if;
 replacement:=$new$  -- An obsolete due job must not pin the provider dispatch lane.
  -- Earlier guards reject terminal jobs, future retries and live leases.
  -- Keep the existing job -> cache lock order and retain the trigger as the
  -- final fence if an observation advances concurrently with this claim.
  if not v_is_renewal and v_job.quarantined_at is null and exists (
    select 1 from public.catalog_file_tracks cache
    where cache.server_host=v_job.identity_key and cache.item_type=v_job.item_type
      and cache.external_id=v_job.external_id
      and cache.observed_profile_fingerprint is not null
      and (v_job.profile_fingerprint is distinct from cache.observed_profile_fingerprint
        or v_job.profile_probed_at is distinct from cache.observed_profile_probed_at
        or v_job.profile_snapshot is distinct from cache.observed_profile_snapshot
        or v_job.file_size_bytes is distinct from public.vod_language_profile_file_size_bytes(cache.observed_profile_snapshot))
  ) then
    update public.catalog_file_audio_validation_jobs
       set state='failed',error_code='PROFILE_CHANGED',
           lease_owner=null,lease_expires_at=null,queue_expires_at=null,retry_at=null,
           purge_after=v_now+interval '7 days',updated_at=v_now
     where id=v_job.id;
    return null;
  end if;
  if not v_is_renewal then
    perform pg_advisory_xact_lock(hashtextextended('catalog-language-admission',0));$new$;
 execute replace(d,old,replacement);
end $patch$;

-- CREATE OR REPLACE preserves the installed owner and service-only ACLs.
notify pgrst,'reload schema';
commit;
