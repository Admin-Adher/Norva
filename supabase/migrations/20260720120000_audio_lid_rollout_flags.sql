-- Independently reversible gates for the accelerated audio-language pipeline.
-- The common kill switch starts enabled to preserve the existing LID behaviour.
-- Both detect-only rollout stages remain fail-closed until explicitly enabled.
insert into public.admin_feature_flags(key, enabled, description)
values
  (
    'audio_lid_enabled',
    true,
    'Kill switch commun du LID audio : false arrête toute nouvelle détection automatique sans effacer les langues déjà persistées'
  ),
  (
    'lid_detect_only_shadow_enabled',
    false,
    'Exécute whisper.cpp detect-language en shadow pour mesurer vitesse et accord ; son résultat rapide ne peut jamais être persisté'
  ),
  (
    'lid_detect_only_production_enabled',
    false,
    'CANARI seulement après calibration shadow : résultat primaire non certifiant si confiance >= 0,95, avec repli sur la transcription du même WAV'
  )
on conflict (key) do nothing;

-- Keep the canonical and per-owner detection provenance aligned with the exact track map.
-- The existing fanout RPC predates detect-only and labels every non-strict observation
-- whisper-basic-v1. Per-track lidMethod is durable across resumable multi-pass files, so this
-- repair step can derive the aggregate method without trusting a caller-provided label.
create or replace function public.refresh_catalog_file_audio_detection_provenance(
  p_server_host text,
  p_item_type text,
  p_external_id text,
  p_audio_tracks jsonb
) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_method text := 'whisper-basic-v1';
  v_count integer := 0;
  v_rows integer := 0;
begin
  if coalesce(btrim(p_server_host), '') = ''
     or p_item_type is distinct from 'movie'
     or coalesce(btrim(p_external_id), '') = '' then
    return 0;
  end if;

  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_audio_tracks, '[]'::jsonb)) track
    where track->>'lidMethod' = 'whisper-detect-only-v1'
  ) then
    v_method := 'whisper-detect-only-v1';
  end if;

  update public.catalog_file_tracks cache
     set audio_lang_verification = jsonb_build_object(
           'status', 'detected',
           'method', v_method,
           'scope', 'canonical-file',
           'detectedAt', clock_timestamp()
         ),
         updated_at = clock_timestamp()
   where cache.server_host = p_server_host
     and cache.item_type = p_item_type
     and cache.external_id = p_external_id
     and cache.audio_lang_verified_at is null;
  get diagnostics v_rows = row_count;
  v_count := v_count + v_rows;

  update public.cloud_title_file_language_observations observation
     set audio_verification = jsonb_build_object(
           'status', 'detected',
           'method', v_method,
           'scope', 'canonical-file'
         ),
         updated_at = clock_timestamp()
    from public.cloud_title_variants variant
    join public.cloud_sources source
      on source.id = variant.source_id
     and source.user_id = variant.user_id
     and source.deleted_at is null
    left join public.catalog_source_provider_identities verified_identity
      on verified_identity.source_id = source.id
     and verified_identity.user_id = source.user_id
   where observation.user_id = variant.user_id
     and observation.variant_id = variant.id
     and observation.file_external_id = p_external_id
     and observation.audio_verified_at is null
     and variant.item_type = p_item_type
     and variant.external_id = p_external_id
     and coalesce(
       verified_identity.identity_id::text,
       'source:' || source.id::text
     ) = p_server_host;
  get diagnostics v_rows = row_count;
  v_count := v_count + v_rows;

  return v_count;
end
$function$;

revoke all on function public.refresh_catalog_file_audio_detection_provenance(
  text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.refresh_catalog_file_audio_detection_provenance(
  text, text, text, jsonb
) to service_role;
