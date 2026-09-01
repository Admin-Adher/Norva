-- Exact audio observation is a claim that a real ordered stream map was
-- parsed. An empty list is not negative evidence: it is an incomplete probe
-- and must remain retryable. Subtitle completion stays independent and may be
-- an exact empty list.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '2min';

create or replace function public.merge_cloud_title_file_languages(
  p_user_id uuid,
  p_title_id uuid,
  p_variant_id uuid,
  p_file_external_id text,
  p_audio_tracks jsonb,
  p_subtitle_tracks jsonb,
  p_has_audio boolean,
  p_has_subtitle boolean
) returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_item_type text;
  v_variant_external_id text;
  v_source_id uuid;
  v_generation_id uuid;
  v_active_generation_id uuid;
  v_head_found boolean := false;
  v_audio text[] := '{}'::text[];
  v_subtitles text[] := '{}'::text[];
begin
  if p_user_id is null or p_title_id is null or p_variant_id is null
     or coalesce(btrim(p_file_external_id), '') = '' then
    raise exception 'Exact file coordinates are required'
      using errcode = '22023';
  end if;

  select variant.item_type, variant.external_id,
         variant.source_id, variant.generation_id
    into v_item_type, v_variant_external_id,
         v_source_id, v_generation_id
  from public.cloud_title_variants variant
  join public.cloud_titles title
    on title.id = variant.title_id
   and title.user_id = variant.user_id
   and title.item_type = variant.item_type
  where variant.id = p_variant_id
    and variant.user_id = p_user_id
    and variant.title_id = p_title_id
    and title.id = p_title_id
  for update of title;

  if not found then
    raise exception 'Variant is not owned by the requested tenant/title active catalogue'
      using errcode = '42501';
  end if;

  -- Hold the active head through the observation UPSERT/recompute. Merely
  -- joining the head in the lookup leaves a movie-only TOCTOU where a catalogue
  -- generation can switch after validation but before persistence.
  select head.active_generation_id
    into v_active_generation_id
  from public.cloud_source_catalog_heads head
  where head.source_id = v_source_id
    and head.user_id = p_user_id
  for share;
  v_head_found := found;
  if (v_head_found and v_active_generation_id is distinct from v_generation_id)
     or (not v_head_found and v_generation_id is not null) then
    raise exception 'Variant is not owned by the requested tenant/title active catalogue'
      using errcode = '42501';
  end if;

  -- Movie variants name the exact provider file. A series variant names its
  -- parent series; p_file_external_id may therefore name a registered episode.
  if v_item_type = 'movie'
     and v_variant_external_id is distinct from p_file_external_id then
    raise exception 'Movie file id does not match the owned variant'
      using errcode = '22023';
  end if;
  if v_item_type = 'series' then
    perform 1
    from public.catalog_series_episode_memberships membership
    join public.cloud_source_catalog_heads membership_head
      on membership_head.user_id = membership.user_id
     and membership_head.source_id = membership.source_id
     and membership_head.active_generation_id = membership.generation_id
    join public.catalog_source_provider_identities identity
      on identity.source_id = membership.source_id
     and identity.user_id = membership.user_id
     and identity.identity_id = membership.provider_identity_id
     and identity.verified_at is not null
    where membership.user_id = p_user_id
      and membership.source_id = v_source_id
      and membership.generation_id = v_generation_id
      and membership.parent_title_id = p_title_id
      and membership.parent_variant_id = p_variant_id
      and membership.parent_item_type = 'series'
      and membership.parent_series_id = v_variant_external_id
      and membership.episode_id = p_file_external_id
    for share of membership, membership_head, identity;
    if not found then
      raise exception 'Series file id is not a registered episode of the owned active variant'
        using errcode = '22023';
    end if;
  end if;

  if not coalesce(p_has_audio, false)
     and not coalesce(p_has_subtitle, false) then
    return;
  end if;

  if coalesce(p_has_audio, false) then
    if jsonb_typeof(p_audio_tracks) is distinct from 'array'
       or jsonb_array_length(p_audio_tracks) = 0
       or cardinality(public.catalog_audio_track_indexes(p_audio_tracks))
          <> jsonb_array_length(p_audio_tracks) then
      raise exception 'Exact audio observation requires a nonempty unique indexed track map'
        using errcode = '22023';
    end if;
    v_audio := public.cloud_file_track_languages(p_audio_tracks);
  end if;
  if coalesce(p_has_subtitle, false) then
    if jsonb_typeof(p_subtitle_tracks) is distinct from 'array' then
      raise exception 'Exact subtitle observation requires an array'
        using errcode = '22023';
    end if;
    v_subtitles := public.cloud_file_track_languages(p_subtitle_tracks);
  end if;

  insert into public.cloud_title_file_language_observations as observation (
    user_id, title_id, variant_id, file_external_id,
    audio_languages, subtitle_languages,
    audio_observed, subtitle_observed, updated_at
  ) values (
    p_user_id, p_title_id, p_variant_id, p_file_external_id,
    v_audio, v_subtitles,
    coalesce(p_has_audio, false), coalesce(p_has_subtitle, false), clock_timestamp()
  )
  on conflict (user_id, variant_id, file_external_id) do update set
    title_id = excluded.title_id,
    audio_languages = case
      when excluded.audio_observed then excluded.audio_languages
      else observation.audio_languages
    end,
    subtitle_languages = case
      when excluded.subtitle_observed then excluded.subtitle_languages
      else observation.subtitle_languages
    end,
    audio_observed = observation.audio_observed or excluded.audio_observed,
    subtitle_observed = observation.subtitle_observed or excluded.subtitle_observed,
    updated_at = clock_timestamp();

  perform public.recompute_cloud_title_file_languages(p_user_id, p_title_id);
end
$function$;

revoke all on function public.merge_cloud_title_file_languages(
  uuid, uuid, uuid, text, jsonb, jsonb, boolean, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.merge_cloud_title_file_languages(
  uuid, uuid, uuid, text, jsonb, jsonb, boolean, boolean
) to service_role;

comment on function public.merge_cloud_title_file_languages(
  uuid, uuid, uuid, text, jsonb, jsonb, boolean, boolean
) is
  'Persists audio and subtitle truth independently; audio_observed requires a nonempty unique indexed exact-file map.';

commit;
