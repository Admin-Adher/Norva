begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

-- Selection has no Xtream provider identity. Its owned, generation-scoped
-- episode rows are the membership proof; never manufacture a provider account
-- or copy an episode's ordered track indexes onto the parent series.
create or replace function public.hydrate_selection_episode_file_languages(
  p_user_id uuid,
  p_source_id uuid,
  p_generation_id uuid,
  p_head_revision bigint,
  p_config_revision bigint,
  p_source_visibility_epoch bigint,
  p_user_visibility_epoch bigint,
  p_parent_series_ids text[]
) returns integer
-- Like the other generation-fenced catalogue RPCs, this narrow service endpoint
-- owns the head/lifecycle locks; direct UPDATE access to those tables stays
-- revoked from service_role. No client-supplied language payload is accepted.
language plpgsql volatile security definer set search_path = '' as $function$
declare
  v_hash text;
  v_source_id uuid;
  v_snapshot jsonb;
  v_title_id uuid;
  v_title_ids uuid[] := '{}'::uuid[];
  v_count integer := 0;
begin
  perform public.norva_credential_require_service_role();
  v_hash := encode(sha256(convert_to('norva-selection-curated-v1:' || p_user_id::text, 'UTF8')), 'hex');
  v_source_id := (substr(v_hash,1,8) || '-' || substr(v_hash,9,4) || '-4' || substr(v_hash,14,3)
    || '-a' || substr(v_hash,18,3) || '-' || substr(v_hash,21,12))::uuid;
  if p_user_id is null or p_source_id is distinct from v_source_id then
    raise exception 'Canonical Selection ownership is required' using errcode = '42501';
  end if;
  if p_parent_series_ids is null or cardinality(p_parent_series_ids) > 1000 then
    raise exception 'A bounded Selection series batch is required' using errcode = '22023';
  end if;
  -- Use the public service-role snapshot contract, with row locks held until
  -- this transaction finishes. Parent variants and media rows are not mutated.
  perform 1 from public.cloud_source_catalog_heads head
    join public.cloud_source_lifecycle lifecycle
      on lifecycle.user_id=head.user_id and lifecycle.source_id=head.source_id
    where head.source_id=p_source_id and head.user_id=p_user_id
    for share of head,lifecycle;
  perform 1 from public.cloud_user_catalog_visibility_epochs epoch
    where epoch.user_id=p_user_id for share;
  v_snapshot := public.norva_get_catalog_write_snapshot(p_source_id,p_user_id);
  if (v_snapshot->>'generationId')::uuid is distinct from p_generation_id
    or (v_snapshot->>'headRevision')::bigint is distinct from p_head_revision
    or (v_snapshot->>'configRevision')::bigint is distinct from p_config_revision
    or (v_snapshot->>'sourceVisibilityEpoch')::bigint is distinct from p_source_visibility_epoch
    or (v_snapshot->>'userVisibilityEpoch')::bigint is distinct from p_user_visibility_epoch
    or (v_snapshot->>'isCatalogVisible')::boolean is distinct from true then
    raise exception 'Selection catalogue snapshot changed' using errcode='40001';
  end if;

  -- Stale episode evidence must not survive a removed file under a kept parent.
  with removed as (
    delete from public.cloud_title_file_language_observations observation
    using public.cloud_title_variants parent
    where parent.user_id=p_user_id and parent.source_id=p_source_id
      and parent.generation_id=p_generation_id and parent.item_type='series'
      and parent.external_id=any(p_parent_series_ids)
      and parent.metadata->>'seriesDelivery'='selection'
      and observation.user_id=parent.user_id and observation.variant_id=parent.id
      and observation.file_external_id ~ '^norva-selection:movie:[a-f0-9]{64}$'
      and not exists (
        select 1 from public.cloud_media_items episode
        where episode.user_id=parent.user_id and episode.source_id=parent.source_id
          and episode.generation_id=parent.generation_id and episode.item_type='episode'
          and episode.available and episode.parent_external_id=parent.external_id
          and episode.external_id=observation.file_external_id
      )
    returning observation.title_id
  ) select coalesce(array_agg(distinct title_id),'{}'::uuid[]) into v_title_ids from removed;

  with candidates as materialized (
    select parent.user_id,parent.title_id,parent.id variant_id,episode.external_id,
      episode.metadata->'codecProfile'->'audioTracks' audio_tracks,
      episode.metadata->'codecProfile'->'subtitleTracks' subtitle_tracks
    from public.cloud_media_items episode
    join public.cloud_title_variants parent
      on parent.user_id=episode.user_id and parent.source_id=episode.source_id
      and parent.generation_id=episode.generation_id and parent.item_type='series'
      and parent.external_id=episode.parent_external_id
    join public.cloud_media_items parent_item
      on parent_item.id=parent.media_item_id and parent_item.user_id=parent.user_id
      and parent_item.source_id=parent.source_id and parent_item.generation_id=parent.generation_id
      and parent_item.item_type='series' and parent_item.available
    where episode.user_id=p_user_id and episode.source_id=p_source_id
      and episode.generation_id=p_generation_id and episode.item_type='episode' and episode.available
      and parent.external_id=any(p_parent_series_ids)
      and parent.metadata->>'seriesDelivery'='selection'
      and parent.metadata->>'selectionRevision'='selection-vod-20260906-v1'
      and episode.metadata->>'selectionRevision'=parent.metadata->>'selectionRevision'
      and episode.metadata->>'discoveryFeed'=parent.metadata->>'discoveryFeed'
      and episode.metadata->>'selectionParentId'=parent.external_id
      and episode.external_id ~ '^norva-selection:movie:[a-f0-9]{64}$'
      and nullif(episode.metadata->'selectionPlaybackValidation'->>'containerMetadataCheckedAt','') is not null
      and episode.metadata->'selectionPlaybackValidation'->>'urlSha256' =
        encode(sha256(convert_to(episode.playback_hint->>'targetUrl','UTF8')),'hex')
  ), valid_files as (
    select * from candidates
    where jsonb_typeof(audio_tracks)='array'
      and jsonb_array_length(case when jsonb_typeof(audio_tracks)='array' then audio_tracks else '[]'::jsonb end)>0
      and cardinality(public.catalog_audio_track_indexes(audio_tracks))=
        jsonb_array_length(case when jsonb_typeof(audio_tracks)='array' then audio_tracks else '[]'::jsonb end)
  ), inserted as (
    insert into public.cloud_title_file_language_observations as observation (
      user_id,title_id,variant_id,file_external_id,audio_languages,subtitle_languages,
      audio_observed,subtitle_observed,updated_at
    )
    select user_id,title_id,variant_id,external_id,
      public.cloud_file_track_languages(audio_tracks),
      public.cloud_file_track_languages(subtitle_tracks),true,
      coalesce(jsonb_typeof(subtitle_tracks)='array',false),clock_timestamp()
    from valid_files
    on conflict (user_id,variant_id,file_external_id) do update set
      audio_languages=case when observation.audio_observed then observation.audio_languages else excluded.audio_languages end,
      subtitle_languages=case when observation.subtitle_observed then observation.subtitle_languages else excluded.subtitle_languages end,
      audio_observed=true,
      subtitle_observed=observation.subtitle_observed or excluded.subtitle_observed,
      updated_at=clock_timestamp()
    where not observation.audio_observed or (excluded.subtitle_observed and not observation.subtitle_observed)
    returning title_id
  ) select count(*)::integer,v_title_ids || coalesce(array_agg(distinct title_id),'{}'::uuid[])
    into v_count,v_title_ids from inserted;

  for v_title_id in select distinct unnest(v_title_ids) loop
    perform public.recompute_cloud_title_file_languages(p_user_id,v_title_id);
  end loop;
  return v_count;
end
$function$;

revoke all on function public.hydrate_selection_episode_file_languages(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text[])
  from public,anon,authenticated;
grant execute on function public.hydrate_selection_episode_file_languages(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text[])
  to service_role;
comment on function public.hydrate_selection_episode_file_languages(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text[]) is
  'Seeds missing exact episode language evidence from audited Selection media rows, preserving later observations and current catalogue ownership.';
notify pgrst, 'reload schema';
commit;
