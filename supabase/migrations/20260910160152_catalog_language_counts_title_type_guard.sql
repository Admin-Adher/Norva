begin;
set local lock_timeout='2s';
set local statement_timeout='20s';
-- The all-provider acceptance found three movie variants attached to series
-- title records. Do not rewrite those old associations here: apply the same
-- owned-title/type fence used by pagination to both facets and membership.
create or replace function public.cloud_catalog_effective_audio_languages(p_user_id uuid,p_item_type text,p_source_id uuid)
returns table(title_id uuid,variant_id uuid,language text)
language sql stable security invoker set search_path = '' as $f$
  select effective.* from (
    select variant.title_id,variant.id,
      case language.value when 'yue' then 'yue' else public.norva_canonical_language_code(language.value) end
    from public.cloud_title_file_language_observations observation
    join public.cloud_catalog_visible_title_variants variant
      on variant.user_id=observation.user_id and variant.title_id=observation.title_id and variant.id=observation.variant_id
        and variant.external_id=observation.file_external_id
    cross join lateral unnest(observation.audio_languages) language(value)
    where observation.user_id=p_user_id and observation.audio_observed
      and (language.value='yue' or public.norva_canonical_language_code(language.value) is not null)
      and variant.item_type=p_item_type and p_item_type in ('movie','series')
      and (p_source_id is null or variant.source_id=p_source_id)
    union all
    select variant.title_id,variant.id,case hint.language when 'fil' then 'tl' else hint.language end
    from public.cloud_catalog_provider_language_hints hint
    join public.cloud_catalog_visible_title_variants variant
      on variant.id=hint.variant_id and variant.user_id=hint.user_id and variant.title_id=hint.title_id and variant.source_id=hint.source_id
    where hint.user_id=p_user_id and hint.item_type=p_item_type and variant.item_type=p_item_type
      and p_item_type in ('movie','series') and (p_source_id is null or hint.source_id=p_source_id)
      and not exists(select 1 from public.cloud_title_file_language_observations observation
        where observation.user_id=hint.user_id and observation.title_id=hint.title_id and observation.variant_id=hint.variant_id
          and observation.file_external_id=variant.external_id
          and observation.audio_observed and cardinality(observation.audio_languages)>0)
  ) effective(title_id,variant_id,language)
  join public.cloud_titles title on title.id=effective.title_id and title.user_id=p_user_id and title.item_type=p_item_type
$f$;
revoke all on function public.cloud_catalog_effective_audio_languages(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.cloud_catalog_effective_audio_languages(uuid,text,uuid) to service_role;
notify pgrst,'reload schema';
commit;
