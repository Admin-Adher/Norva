begin;

-- One trusted Gateway completion may atomically register immutable R2 bytes
-- and bind them to the exact live catalogue authority that created the
-- playback session. No caller-supplied tenant, source, item or variant is
-- accepted by this function.
create function public.norva_commit_media_cache_publication(
  p_playback_session_id uuid,
  p_gateway_session_id uuid,
  p_user_id uuid,
  p_object_key text,
  p_content_sha256 text,
  p_file_size_bytes bigint,
  p_video_profile_sha256 text,
  p_audio_topology_sha256 text,
  p_subtitle_topology_sha256 text,
  p_duration_milliseconds bigint,
  p_pipeline_build text,
  p_segmenter_build text,
  p_storage_backend text,
  p_root_playlist text,
  p_manifest_sha256 text,
  p_total_bytes bigint,
  p_file_count integer,
  p_expires_at timestamptz
) returns table (
  binding_id uuid,
  object_key text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_session public.cloud_playback_sessions%rowtype;
  v_variant_ids uuid[];
  v_variant_id uuid;
  v_item_type text;
  v_ttl_seconds integer;
  v_registered boolean;
  v_binding_id uuid;
begin
  if p_playback_session_id is null or p_gateway_session_id is null or p_user_id is null
     or p_object_key is null or p_object_key !~ '^[0-9a-f]{64}$'
     or p_content_sha256 is null or p_content_sha256 !~ '^[0-9a-f]{64}$'
     or p_video_profile_sha256 is null or p_video_profile_sha256 !~ '^[0-9a-f]{64}$'
     or p_audio_topology_sha256 is null or p_audio_topology_sha256 !~ '^[0-9a-f]{64}$'
     or p_subtitle_topology_sha256 is null or p_subtitle_topology_sha256 !~ '^[0-9a-f]{64}$'
     or p_manifest_sha256 is null or p_manifest_sha256 !~ '^[0-9a-f]{64}$'
     or p_storage_backend <> 'r2'
     or p_expires_at is null then
    return;
  end if;

  select playback.* into v_session
    from public.cloud_playback_sessions playback
    join public.cloud_gateway_sessions gateway
      on gateway.playback_session_id = playback.id
     and gateway.user_id = playback.user_id
     and gateway.external_session_id = p_gateway_session_id::text
   where playback.id = p_playback_session_id
     and playback.user_id = p_user_id
     and playback.status in ('pending', 'ready', 'expired')
     and playback.superseded_at is null
     and gateway.status <> 'failed'
     and playback.created_at > v_now - interval '8 hours';
  if not found
     or v_session.source_id is null
     or v_session.item_id is null
     or v_session.target_url_hash is null
     or v_session.target_url_hash !~ '^[0-9a-f]{64}$' then
    return;
  end if;

  v_item_type := case
    when v_session.item_type = 'movie' then 'movie'
    when v_session.item_type in ('series', 'episode') then 'episode'
    else null
  end;
  if v_item_type is null then return; end if;

  if v_item_type = 'movie' then
    select array_agg(variant.id order by variant.id)
      into v_variant_ids
      from public.cloud_media_items item
      join public.cloud_source_catalog_heads head
        on head.user_id = item.user_id
       and head.source_id = item.source_id
       and head.active_generation_id = item.generation_id
      join public.cloud_title_variants variant
        on variant.user_id = item.user_id
       and variant.source_id = item.source_id
       and variant.generation_id = item.generation_id
       and variant.media_item_id = item.id
       and variant.item_type = 'movie'
       and variant.external_id = item.external_id
     where item.user_id = p_user_id
       and item.source_id = v_session.source_id
       and item.item_type = 'movie'
       and item.external_id = v_session.item_id
       and item.available;
  else
    select array_agg(coordinates.variant_id order by coordinates.variant_id)
      into v_variant_ids
      from public.catalog_series_episode_coordinates_by_episode(
        p_user_id, v_session.source_id, v_session.item_id
      ) coordinates;
  end if;
  if coalesce(cardinality(v_variant_ids), 0) <> 1 then return; end if;
  v_variant_id := v_variant_ids[1];

  v_ttl_seconds := floor(extract(epoch from (p_expires_at - v_now)))::integer;
  if v_ttl_seconds not between 300 and 7776000 then return; end if;

  v_registered := public.norva_register_ready_media_cache_object(
    p_object_key,
    p_content_sha256,
    p_file_size_bytes,
    p_video_profile_sha256,
    p_audio_topology_sha256,
    p_subtitle_topology_sha256,
    p_duration_milliseconds,
    p_pipeline_build,
    p_segmenter_build,
    p_storage_backend,
    p_root_playlist,
    p_manifest_sha256,
    p_total_bytes,
    p_file_count,
    v_ttl_seconds
  );
  if v_registered is not true then return; end if;

  v_binding_id := public.norva_bind_media_cache_object(
    p_object_key,
    p_user_id,
    v_session.source_id,
    v_item_type,
    v_session.item_id,
    v_session.target_url_hash,
    v_variant_id
  );
  if v_binding_id is null then return; end if;

  return query select v_binding_id, p_object_key;
end
$function$;

-- Hot-path lookup derives every coordinate from the still-active playback
-- session. It returns no provider URL and accepts no binding, variant or source
-- hint from the caller.
create function public.norva_resolve_media_cache_playback(
  p_playback_session_id uuid,
  p_user_id uuid
) returns table (
  binding_id uuid,
  object_key text,
  storage_backend text,
  object_prefix text,
  root_playlist text,
  manifest_sha256 text,
  expires_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_session public.cloud_playback_sessions%rowtype;
  v_binding_ids uuid[];
  v_binding public.media_cache_bindings%rowtype;
  v_item_type text;
begin
  if p_playback_session_id is null or p_user_id is null then return; end if;
  select session.* into v_session
    from public.cloud_playback_sessions session
   where session.id = p_playback_session_id
     and session.user_id = p_user_id
     and session.status in ('pending', 'ready')
     and session.superseded_at is null;
  if not found
     or v_session.source_id is null
     or v_session.item_id is null
     or v_session.target_url_hash is null
     or v_session.target_url_hash !~ '^[0-9a-f]{64}$' then
    return;
  end if;

  v_item_type := case
    when v_session.item_type = 'movie' then 'movie'
    when v_session.item_type in ('series', 'episode') then 'episode'
    else null
  end;
  if v_item_type is null then return; end if;

  select array_agg(binding.id order by binding.id)
    into v_binding_ids
    from public.media_cache_bindings binding
   where binding.user_id = p_user_id
     and binding.source_id = v_session.source_id
     and binding.item_type = v_item_type
     and binding.external_id = v_session.item_id
     and binding.target_url_sha256 = v_session.target_url_hash
     and binding.state = 'active';
  if coalesce(cardinality(v_binding_ids), 0) <> 1 then return; end if;

  select binding.* into v_binding
    from public.media_cache_bindings binding
   where binding.id = v_binding_ids[1];

  return query
  select authorized.binding_id, authorized.object_key,
         authorized.storage_backend, authorized.object_prefix,
         authorized.root_playlist, authorized.manifest_sha256,
         authorized.expires_at
    from public.norva_authorize_media_cache_object(
      v_binding.object_key,
      p_user_id,
      v_session.source_id,
      v_item_type,
      v_session.item_id,
      v_session.target_url_hash,
      v_binding.variant_id
    ) authorized;
end
$function$;

revoke all on function public.norva_commit_media_cache_publication(
  uuid, uuid, uuid, text, text, bigint, text, text, text, bigint,
  text, text, text, text, text, bigint, integer, timestamptz
) from public, anon, authenticated;
revoke all on function public.norva_resolve_media_cache_playback(uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.norva_commit_media_cache_publication(
  uuid, uuid, uuid, text, text, bigint, text, text, text, bigint,
  text, text, text, text, text, bigint, integer, timestamptz
) to service_role;
grant execute on function public.norva_resolve_media_cache_playback(uuid, uuid)
  to service_role;

notify pgrst, 'reload schema';

commit;
