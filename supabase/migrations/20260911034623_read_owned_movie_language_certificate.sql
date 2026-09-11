-- Read-only reuse after import: one MVCC snapshot binds a currently visible,
-- unambiguous owned movie to its server-verified provider/file certificate.
-- No codec profile, playback capability, job or owner observation is copied.
begin;
set local statement_timeout = '15s';
set local lock_timeout = '2s';

create function public.read_owned_movie_language_certificate(
  p_user_id uuid, p_source_id uuid, p_external_id text
) returns jsonb
language sql stable security invoker
set search_path = ''
as $function$
  with owned as materialized (
    select variant.user_id, variant.source_id, variant.external_id, variant.codec_profile
    from public.cloud_catalog_visible_title_variants variant
    where variant.user_id = p_user_id
      and variant.source_id = p_source_id
      and variant.item_type = 'movie'
      and variant.external_id = p_external_id
    limit 2
  )
  select jsonb_build_object(
    'audio_tracks', cache.audio_tracks,
    'audio_probed_at', cache.audio_probed_at,
    'audio_lang_verified_at', cache.audio_lang_verified_at,
    'audio_lang_verification', cache.audio_lang_verification,
    'observed_profile_fingerprint', cache.observed_profile_fingerprint,
    'observed_profile_probed_at', cache.observed_profile_probed_at,
    'observed_profile_snapshot', cache.observed_profile_snapshot
  )
  from owned
  join public.catalog_source_provider_identities identity
    on identity.user_id = owned.user_id and identity.source_id = owned.source_id
  join public.catalog_file_tracks cache
    on cache.server_host = identity.identity_id::text
    and cache.item_type = 'movie' and cache.external_id = owned.external_id
  where (select count(*) from owned) = 1
    -- A partial/newer local observation must never be hidden by the fallback.
    and coalesce(owned.codec_profile, '{}'::jsonb) = '{}'::jsonb
    and identity.verified_at is not null and isfinite(identity.verified_at)
    and cache.audio_probed_at is not null
    and cache.audio_lang_verified_at is not null
    and cache.observed_profile_fingerprint is not null
    and cache.observed_profile_probed_at is not null
    and cache.observed_profile_snapshot is not null;
$function$;

-- The Edge derives p_user_id from its authenticated request, never the body.
-- No new table grants or elevated SECURITY DEFINER privileges are necessary.
alter function public.read_owned_movie_language_certificate(uuid,uuid,text) owner to postgres;
revoke all on function public.read_owned_movie_language_certificate(uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function public.read_owned_movie_language_certificate(uuid,uuid,text) to service_role;

commit;
