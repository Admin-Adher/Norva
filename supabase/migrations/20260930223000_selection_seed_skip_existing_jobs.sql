begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

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
  with input_manifest as materialized (
    select entry->>'externalId' external_id,entry->>'urlSha256' url_sha256,
      max(coalesce((entry->>'priority')::integer,0)) priority
    from jsonb_array_elements(p_manifest) entry group by 1,2
  ), manifest as materialized (
    -- Terminal or unchanged jobs cannot be modified by ON CONFLICT below.
    -- Eliminate them before expensive owner/catalogue visibility joins.
    select entry.* from input_manifest entry
    left join public.catalog_selection_audio_jobs existing
      on existing.external_id=entry.external_id and existing.url_sha256=entry.url_sha256
    where existing.id is null or (existing.state in ('queued','retry_wait')
      and (entry.priority>existing.priority or existing.error_code='NO_ACTIVE_OWNER'))
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
notify pgrst,'reload schema';
commit;
