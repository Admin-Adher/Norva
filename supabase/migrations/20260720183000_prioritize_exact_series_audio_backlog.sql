-- Prioritize the historical series-language backlog when discovering exact
-- episodes.  The legacy parent row is used only as an ordering hint: its
-- ordered tracks are never copied to an episode and it is never accepted as
-- ownership proof.

begin;

create or replace function public.catalog_series_inventory_candidates(
  p_user uuid,
  p_source uuid,
  p_limit int default 4
) returns table(
  parent_series_id text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select variant.external_id as parent_series_id
  from public.cloud_title_variants variant
  join public.cloud_titles title
    on title.id = variant.title_id
   and title.user_id = variant.user_id
   and title.item_type = variant.item_type
  join public.cloud_sources source
    on source.id = variant.source_id
   and source.user_id = variant.user_id
   and source.deleted_at is null
   and source.enabled = true
   and source.sync_status = 'ready'
   and source.source_type = 'xtream'
  join public.catalog_source_provider_identities identity
    on identity.source_id = source.id
   and identity.user_id = source.user_id
  left join public.catalog_series_inventory_state inventory
    on inventory.user_id = variant.user_id
   and inventory.source_id = variant.source_id
   and inventory.parent_variant_id = variant.id
   and inventory.parent_series_id = variant.external_id
   and inventory.provider_identity_id = identity.identity_id
  left join public.catalog_file_tracks legacy_parent
    on legacy_parent.server_host = identity.identity_id::text
   and legacy_parent.item_type = 'series'
   and legacy_parent.external_id = variant.external_id
  where variant.user_id = p_user
    and variant.source_id = p_source
    and variant.item_type = 'series'
    and variant.title_id is not null
    and coalesce(btrim(variant.external_id), '') <> ''
    and (
      inventory.source_id is null
      or inventory.next_retry_at <= now()
    )
  order by
    case when exists (
      select 1
      from jsonb_array_elements(
        case
          when jsonb_typeof(legacy_parent.audio_tracks) = 'array'
            then legacy_parent.audio_tracks
          else '[]'::jsonb
        end
      ) track
      where coalesce(
        nullif(lower(btrim(track->>'lang')), ''),
        nullif(lower(btrim(track->>'language')), ''),
        'und'
      ) in ('und', 'un', 'mis', 'mul', 'zxx', 'nar', 'unknown')
    ) then 0 else 1 end,
    case when inventory.source_id is null then 0 else 1 end,
    title.release_year desc nulls last,
    inventory.next_retry_at nulls first,
    variant.external_id,
    variant.id
  limit greatest(1, least(100, coalesce(p_limit, 4)))
$function$;

revoke all on function public.catalog_series_inventory_candidates(
  uuid, uuid, int
) from public, anon, authenticated;
grant execute on function public.catalog_series_inventory_candidates(
  uuid, uuid, int
) to service_role;

comment on function public.catalog_series_inventory_candidates(uuid, uuid, int) is
  'Exact parent-series inventory queue. Legacy parent tracks may prioritize a row but never prove or populate an episode.';

commit;
