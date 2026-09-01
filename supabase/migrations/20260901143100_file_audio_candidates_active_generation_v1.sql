-- Exact-file backfill must never probe a historical catalogue generation. The
-- visible variant projection binds every candidate to the source's current
-- active head and also preserves the disabled/hidden source boundary.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '2min';

create or replace function public.file_audio_backfill_candidates(
  p_user uuid,
  p_source uuid default null,
  p_item_type text default 'movie',
  p_target text default 'audio',
  p_require_tags text[] default null,
  p_untagged_only boolean default false,
  p_limit integer default 25
) returns table(id uuid, default_variant_id uuid, provider_tmdb_id text)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    title.id,
    variant.id as default_variant_id,
    title.provider_tmdb_id
  from public.cloud_catalog_visible_title_variants variant
  left join public.cloud_source_catalog_heads head
    on head.source_id = variant.source_id
   and head.user_id = variant.user_id
  join public.cloud_titles title
    on title.id = variant.title_id
   and title.user_id = variant.user_id
   and title.item_type = variant.item_type
  left join public.cloud_title_file_language_observations observation
    on observation.user_id = variant.user_id
   and observation.title_id = variant.title_id
   and observation.variant_id = variant.id
   and observation.file_external_id = variant.external_id
  where p_item_type = 'movie'
    and variant.item_type = 'movie'
    and variant.user_id = p_user
    and variant.title_id is not null
    and coalesce(btrim(variant.external_id), '') <> ''
    and (
      (head.active_generation_id is not null
        and variant.generation_id = head.active_generation_id)
      or (head.active_generation_id is null
        and variant.generation_id is null)
    )
    and (p_source is null or variant.source_id = p_source)
    and (
      case when p_target = 'subtitle'
        then not coalesce(observation.subtitle_observed, false)
        else not coalesce(observation.audio_observed, false)
          or observation.updated_at < now() - interval '180 days'
      end
    )
    and (not coalesce(p_untagged_only, false) or title.version_languages = '{}'::text[])
    and (
      p_require_tags is null
      or coalesce(cardinality(p_require_tags), 0) = 0
      or title.version_languages && p_require_tags
    )
  order by
    case when title.version_languages @> array['multi']::text[] then 0 else 1 end,
    title.release_year desc nulls last,
    title.id,
    variant.id
  limit greatest(1, least(300, coalesce(p_limit, 25)))
$function$;

revoke all on function public.file_audio_backfill_candidates(
  uuid, uuid, text, text, text[], boolean, integer
) from public, anon, authenticated;
grant execute on function public.file_audio_backfill_candidates(
  uuid, uuid, text, text, text[], boolean, integer
) to service_role;

commit;
