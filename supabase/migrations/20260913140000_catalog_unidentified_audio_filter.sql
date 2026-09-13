begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- A title belongs to this audit filter if ANY visible version has no identified
-- audio. A known sibling must not conceal it. Reuse the catalogue's accepted
-- observations + provider declarations, not the global/TMDB language union.
create function public.cloud_catalog_unidentified_audio_variants(
  p_user_id uuid, p_item_type text, p_source_id uuid
) returns table(title_id uuid, variant_id uuid)
language sql stable security invoker set search_path = '' as $f$
  select variant.title_id, variant.id
  from public.cloud_catalog_visible_title_variants variant
  join public.cloud_titles title on title.id=variant.title_id
    and title.user_id=variant.user_id and title.item_type=variant.item_type
  where variant.user_id=p_user_id and variant.item_type=p_item_type
    and p_item_type in ('movie','series')
    and (p_source_id is null or variant.source_id=p_source_id)
  -- EXCEPT uses a bounded set operation. The nested-loop anti join chosen for
  -- small estimated series counts otherwise repeatedly scans the whole known set.
  except
  select effective.title_id, effective.variant_id
  from public.cloud_catalog_effective_audio_languages(p_user_id,p_item_type,p_source_id) effective
$f$;
revoke all on function public.cloud_catalog_unidentified_audio_variants(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.cloud_catalog_unidentified_audio_variants(uuid,text,uuid) to service_role;

create function public.cloud_catalog_unidentified_audio_count(
  p_user_id uuid, p_item_type text, p_source_id uuid
) returns bigint language sql stable security invoker set search_path = '' as $f$
  select count(distinct title_id)
  from public.cloud_catalog_unidentified_audio_variants(p_user_id,p_item_type,p_source_id)
$f$;
revoke all on function public.cloud_catalog_unidentified_audio_count(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.cloud_catalog_unidentified_audio_count(uuid,text,uuid) to service_role;

-- Extend the existing paged query entry point. All normal language semantics,
-- visibility, sorting, genre/year/source/search filters remain unchanged.
create or replace function public.cloud_catalog_visible_title_ids_by_source_languages(
  p_user_id uuid,p_item_type text,p_source_id uuid,p_audio_language text default null,p_subtitle_language text default null
) returns table(title_id uuid) language sql stable security invoker set search_path = '' as $f$
  select title_id from public.cloud_catalog_provider_title_ids_by_source_languages(
    p_user_id,p_item_type,p_source_id,p_audio_language,p_subtitle_language)
  where coalesce(lower(btrim(p_audio_language)),'') <> 'unidentified'
  union
  select unknown_audio.title_id
  from public.cloud_catalog_unidentified_audio_variants(p_user_id,p_item_type,p_source_id) unknown_audio
  where lower(btrim(p_audio_language))='unidentified'
    and (nullif(btrim(p_subtitle_language),'') is null or exists(
      select 1 from public.cloud_title_file_language_observations observation
      join public.cloud_catalog_visible_title_variants variant
        on variant.user_id=observation.user_id and variant.title_id=observation.title_id
          and variant.id=observation.variant_id and variant.external_id=observation.file_external_id
      where observation.user_id=p_user_id and observation.title_id=unknown_audio.title_id
        and observation.variant_id=unknown_audio.variant_id and observation.subtitle_observed
        and lower(btrim(p_subtitle_language))=any(observation.subtitle_languages)))
$f$;
revoke all on function public.cloud_catalog_visible_title_ids_by_source_languages(uuid,text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.cloud_catalog_visible_title_ids_by_source_languages(uuid,text,uuid,text,text) to service_role;
notify pgrst,'reload schema';
commit;
