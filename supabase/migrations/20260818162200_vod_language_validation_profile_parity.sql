-- Keep the durable strict-language gate aligned with the server-authoritative
-- Edge profile accepted before the RPC. Exact Gateway probes are valid for
-- every canonical VOD container; only in-band profiles require the explicit
-- metadata-complete attestation.
create or replace function public.vod_language_profile_is_exact(p_profile jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $function$
  with normalized as (
    select
      regexp_replace(
        lower(coalesce(p_profile->>'container', '')),
        '[^a-z0-9]+',
        '',
        'g'
      ) as container_token,
      regexp_replace(
        lower(coalesce(p_profile->>'probeSource', p_profile->>'probe_source', '')),
        '[^a-z0-9]+',
        '',
        'g'
      ) as probe_token
  )
  select coalesce(
    jsonb_typeof(p_profile) = 'object'
    and (
      normalized.container_token in (
        'mkv', 'matroska', 'mp4', 'mov', 'avi', 'ogg', 'flv', 'mpg', 'mpeg'
      )
      or normalized.container_token like '%matroska%'
      or normalized.container_token like '%webm%'
    )
    and (
      normalized.probe_token = 'gatewayprobe'
      or (
        normalized.probe_token = 'gatewayinband'
        and lower(coalesce(
          p_profile->>'metadataComplete',
          p_profile->>'metadata_complete',
          'false'
        )) = 'true'
      )
    )
    and coalesce(
      p_profile->>'videoCodec',
      p_profile->>'video_codec',
      p_profile->>'video',
      ''
    ) <> ''
    and coalesce(
      p_profile->>'audioCodec',
      p_profile->>'audio_codec',
      p_profile->>'audio',
      ''
    ) <> ''
    and (
      jsonb_typeof(p_profile->'audioTracks') = 'array'
      or jsonb_typeof(p_profile->'audio_tracks') = 'array'
    )
    and (
      jsonb_typeof(p_profile->'subtitles') = 'array'
      or jsonb_typeof(p_profile->'subtitleTracks') = 'array'
      or jsonb_typeof(p_profile->'subtitle_tracks') = 'array'
    )
    and coalesce(
      p_profile->>'durationSeconds',
      p_profile->>'duration_seconds',
      p_profile->>'duration',
      ''
    ) ~ '^[0-9]+(?:\.[0-9]+)?$'
    and coalesce(
      p_profile->>'durationSeconds',
      p_profile->>'duration_seconds',
      p_profile->>'duration'
    )::numeric > 0
    and coalesce(p_profile->>'probedAt', p_profile->>'probed_at', '') <> ''
    and public.vod_language_profile_file_size_bytes(p_profile) is not null
    and cardinality(public.vod_language_profile_audio_indices(p_profile)) between 1 and 32
    and jsonb_array_length(
      case
        when jsonb_typeof(p_profile->'audioTracks') = 'array' then p_profile->'audioTracks'
        when jsonb_typeof(p_profile->'audio_tracks') = 'array' then p_profile->'audio_tracks'
        else '[]'::jsonb
      end
    ) = cardinality(public.vod_language_profile_audio_indices(p_profile)),
    false
  )
  from normalized
$function$;

revoke all on function public.vod_language_profile_is_exact(jsonb)
  from public, anon, authenticated;
grant execute on function public.vod_language_profile_is_exact(jsonb) to service_role;
