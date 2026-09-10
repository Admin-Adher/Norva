begin;
set local lock_timeout='2s';
set local statement_timeout='20s';

-- Normalize each distinct observed code once, not twice for every file track.
-- Keep the requested language inside the shared relation so filtered pages do
-- not materialize every language first. NULL remains the complete facet union.
create function public.cloud_catalog_effective_audio_languages(
  p_user_id uuid,p_item_type text,p_source_id uuid,p_language text
) returns table(title_id uuid,variant_id uuid,language text)
language sql stable security invoker set search_path = '' as $f$
  with codes as materialized (
    select raw_code,case raw_code when 'yue' then 'yue' else public.norva_canonical_language_code(raw_code) end as code
    from (select distinct unnest(audio_languages) as raw_code
      from public.cloud_title_file_language_observations where user_id=p_user_id and audio_observed) raw
  )
  select effective.* from (
    select variant.title_id,variant.id,codes.code
    from public.cloud_title_file_language_observations observation
    join public.cloud_catalog_visible_title_variants variant
      on variant.user_id=observation.user_id and variant.title_id=observation.title_id and variant.id=observation.variant_id
        and variant.external_id=observation.file_external_id
    cross join lateral unnest(observation.audio_languages) language(value)
    join codes on codes.raw_code=language.value
    where observation.user_id=p_user_id and observation.audio_observed
      and codes.code is not null and (p_language is null or codes.code=p_language)
      and variant.item_type=p_item_type and p_item_type in ('movie','series')
      and (p_source_id is null or variant.source_id=p_source_id)
    union all
    select variant.title_id,variant.id,case hint.language when 'fil' then 'tl' else hint.language end
    from public.cloud_catalog_provider_language_hints hint
    join public.cloud_catalog_visible_title_variants variant
      on variant.id=hint.variant_id and variant.user_id=hint.user_id and variant.title_id=hint.title_id and variant.source_id=hint.source_id
    where hint.user_id=p_user_id and hint.item_type=p_item_type and variant.item_type=p_item_type
      and p_item_type in ('movie','series') and (p_source_id is null or hint.source_id=p_source_id)
      and (p_language is null or hint.language=p_language or (p_language='tl' and hint.language='fil'))
      and not exists(select 1 from public.cloud_title_file_language_observations observation
        where observation.user_id=hint.user_id and observation.title_id=hint.title_id and observation.variant_id=hint.variant_id
          and observation.file_external_id=variant.external_id
          and observation.audio_observed and cardinality(observation.audio_languages)>0)
  ) effective(title_id,variant_id,language)
  join public.cloud_titles title on title.id=effective.title_id and title.user_id=p_user_id and title.item_type=p_item_type
$f$;
revoke all on function public.cloud_catalog_effective_audio_languages(uuid,text,uuid,text) from public,anon,authenticated;
grant execute on function public.cloud_catalog_effective_audio_languages(uuid,text,uuid,text) to service_role;

create or replace function public.cloud_catalog_effective_audio_languages(p_user_id uuid,p_item_type text,p_source_id uuid)
returns table(title_id uuid,variant_id uuid,language text)
language sql stable security invoker set search_path = '' as $f$
  select * from public.cloud_catalog_effective_audio_languages(p_user_id,p_item_type,p_source_id,null::text)
$f$;
revoke all on function public.cloud_catalog_effective_audio_languages(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.cloud_catalog_effective_audio_languages(uuid,text,uuid) to service_role;

create or replace function public.cloud_catalog_provider_title_ids_by_source_languages(
  p_user_id uuid,p_item_type text,p_source_id uuid,p_audio_language text default null,p_subtitle_language text default null
) returns table(title_id uuid) language sql stable security invoker set search_path = '' as $f$
  with parameters as (
    select nullif(lower(btrim(p_audio_language)),'') as audio, nullif(lower(btrim(p_subtitle_language)),'') as subtitle
  ), matching as (
    select effective.title_id,effective.variant_id
    from parameters p
    cross join lateral public.cloud_catalog_effective_audio_languages(
      p_user_id,p_item_type,p_source_id,regexp_replace(p.audio,'^(catalog|provider)-','')
    ) effective
    where p.audio ~ '^(catalog|provider)-'
    union all
    -- Legacy strict filters and same-file subtitles retain their semantics.
    select variant.title_id,variant.id
    from public.cloud_catalog_visible_title_variants variant,parameters p
    where variant.user_id=p_user_id and variant.item_type=p_item_type and p_item_type in ('movie','series')
      and (p_source_id is null or variant.source_id=p_source_id)
      and (p.audio is null or (p.audio !~ '^(catalog|provider)-' and exists(
        select 1 from public.cloud_title_file_language_observations observation
        where observation.user_id=variant.user_id and observation.title_id=variant.title_id
          and observation.variant_id=variant.id and observation.file_external_id=variant.external_id
          and observation.audio_observed and p.audio=any(observation.audio_languages))))
  )
  select distinct matching.title_id from matching,parameters p
  where p.subtitle is null or exists(
    select 1 from public.cloud_title_file_language_observations observation
    join public.cloud_catalog_visible_title_variants variant
      on variant.user_id=observation.user_id and variant.id=observation.variant_id and variant.external_id=observation.file_external_id
    where observation.user_id=p_user_id and observation.title_id=matching.title_id
      and observation.variant_id=matching.variant_id and observation.subtitle_observed and p.subtitle=any(observation.subtitle_languages))
$f$;
revoke all on function public.cloud_catalog_provider_title_ids_by_source_languages(uuid,text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.cloud_catalog_provider_title_ids_by_source_languages(uuid,text,uuid,text,text) to service_role;
notify pgrst,'reload schema';
commit;
