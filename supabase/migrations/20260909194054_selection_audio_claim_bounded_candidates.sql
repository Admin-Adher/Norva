begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create or replace function public.claim_selection_audio_job()
returns jsonb language plpgsql volatile security definer set search_path='' as $function$
declare
  v_candidate public.catalog_selection_audio_jobs%rowtype;
  v_job public.catalog_selection_audio_jobs%rowtype;
  v_now timestamptz:=clock_timestamp();
begin
  perform public.norva_credential_require_service_role();
  if not pg_try_advisory_xact_lock(hashtextextended('selection-audio-global-worker-v1',0)) then return null; end if;
  if exists(select 1 from public.catalog_selection_audio_jobs where state='running' and lease_until>v_now) then return null; end if;
  update public.catalog_selection_audio_jobs set state='failed',error_code='ATTEMPT_LIMIT',
    lease_token=null,lease_until=null,updated_at=v_now,completed_at=v_now
    where state='running' and lease_until<=v_now and attempt_count>=8;

  -- Owner validation is deliberately outside the candidate SQL. PostgreSQL may
  -- evaluate a function in WHERE for every due job before sorting and LIMIT;
  -- with hundreds of files that exhausts the RPC deadline before any claim.
  for v_candidate in
    select job.* from public.catalog_selection_audio_jobs job
    where ((job.state in ('queued','retry_wait') and job.next_attempt_at<=v_now)
      or (job.state='running' and job.lease_until<=v_now)) and job.attempt_count<8
    order by case when job.error_code='NO_ACTIVE_OWNER' then 1 else 0 end,
      job.priority desc,job.next_attempt_at,job.created_at,job.external_id,job.url_sha256
    limit 16 for update skip locked
  loop
    -- Commit already deferred orphans before repeated lookups approach the
    -- REST deadline. A larger retired-source batch advances over later polls.
    if clock_timestamp()>=v_now+interval '3 seconds' then return null; end if;
    if jsonb_array_length(public.selection_audio_job_owners(v_candidate.external_id,v_candidate.url_sha256))=0 then
      -- Removed-source jobs neither burn analysis attempts nor occupy the front
      -- of every poll. New visible owners can revive them through normal seed.
      update public.catalog_selection_audio_jobs set state='retry_wait',error_code='NO_ACTIVE_OWNER',
        next_attempt_at=v_now+interval '15 minutes',lease_token=null,lease_until=null,updated_at=v_now
        where external_id=v_candidate.external_id and url_sha256=v_candidate.url_sha256;
      continue;
    end if;
    update public.catalog_selection_audio_jobs set state='running',attempt_count=attempt_count+1,
      lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '5 minutes',error_code=null,updated_at=clock_timestamp()
      where external_id=v_candidate.external_id and url_sha256=v_candidate.url_sha256 returning * into v_job;
    return to_jsonb(v_job);
  end loop;
  return null;
end
$function$;

create or replace function public.seed_selection_audio_jobs(p_manifest jsonb)
returns integer language plpgsql volatile security definer set search_path='' as $function$
declare v_count integer;
begin
  perform public.norva_credential_require_service_role();
  if jsonb_typeof(p_manifest) is distinct from 'array' or jsonb_array_length(p_manifest)>250 then
    raise exception 'A bounded Selection manifest is required' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_array_elements(p_manifest) entry
    where coalesce(entry->>'externalId','') !~ '^norva-selection:movie:[a-f0-9]{64}$'
      or coalesce(entry->>'urlSha256','') !~ '^[a-f0-9]{64}$'
      or coalesce(entry->>'priority','0') !~ '^([0-9]{1,3}|1000)$') then
    raise exception 'Invalid Selection manifest identity' using errcode='22023';
  end if;
  with manifest as materialized (
    select entry->>'externalId' external_id,entry->>'urlSha256' url_sha256,
      max(coalesce((entry->>'priority')::integer,0)) priority
    from jsonb_array_elements(p_manifest) entry group by 1,2
  ), candidates as (
    select distinct manifest.* from manifest
    join public.cloud_catalog_visible_title_variants variant on variant.item_type='movie'
      and variant.external_id=manifest.external_id
    join public.cloud_media_items media on media.id=variant.media_item_id
      and media.user_id=variant.user_id and media.source_id=variant.source_id
      and media.generation_id=variant.generation_id and media.item_type='movie' and media.available
    left join public.catalog_file_tracks cache on cache.server_host='source:'||variant.source_id::text
      and cache.item_type='movie' and cache.external_id=variant.external_id
    where public.norva_selection_source_identity_valid(variant.source_id,variant.user_id)
      and encode(sha256(convert_to(variant.playback_hint->>'targetUrl','UTF8')),'hex')=manifest.url_sha256
      and media.playback_hint->>'targetUrl'=variant.playback_hint->>'targetUrl'
      and not coalesce(public.selection_audio_tracks_complete(case when cache.audio_probed_at is not null
        and cache.audio_lang_verification->>'urlSha256'=manifest.url_sha256 then cache.audio_tracks
        when media.metadata->'selectionPlaybackValidation'->>'urlSha256'=manifest.url_sha256
          then media.metadata->'codecProfile'->'audioTracks' else null end),false)
  )
  insert into public.catalog_selection_audio_jobs as job(external_id,url_sha256,priority)
    select external_id,url_sha256,priority from candidates
  on conflict (external_id,url_sha256) do update set
    priority=greatest(job.priority,excluded.priority),
    state=case when job.error_code='NO_ACTIVE_OWNER' then 'queued' else job.state end,
    next_attempt_at=case when job.error_code='NO_ACTIVE_OWNER' then clock_timestamp() else job.next_attempt_at end,
    error_code=case when job.error_code='NO_ACTIVE_OWNER' then null else job.error_code end,
    updated_at=clock_timestamp()
    where job.state in ('queued','retry_wait')
      and (excluded.priority>job.priority or job.error_code='NO_ACTIVE_OWNER');
  get diagnostics v_count=row_count;
  return v_count;
end
$function$;

revoke all on function public.claim_selection_audio_job() from public,anon,authenticated;
revoke all on function public.seed_selection_audio_jobs(jsonb) from public,anon,authenticated;
grant execute on function public.claim_selection_audio_job() to service_role;
grant execute on function public.seed_selection_audio_jobs(jsonb) to service_role;
notify pgrst,'reload schema';
commit;
