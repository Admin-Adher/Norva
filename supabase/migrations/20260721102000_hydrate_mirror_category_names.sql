-- Repair provider rows whose current Xtream mirror omits category labels.
--
-- A canonical provider identity is established from real stream-id overlap. A
-- missing label can therefore be copied only from the exact same external item
-- on another verified mirror, without opening a provider connection or consuming
-- a customer playback slot. Existing labels are never overwritten and ambiguous
-- donors are skipped; category-id-only guesses are deliberately forbidden.

create or replace function public.norva_hydrate_source_category_names(
  p_source_id uuid,
  p_item_type text default 'movie',
  p_limit integer default 2000
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  changed integer := 0;
begin
  if p_source_id is null or p_item_type not in ('movie', 'series') then
    return 0;
  end if;

  p_limit := least(greatest(coalesce(p_limit, 2000), 1), 20000);
  perform set_config('lock_timeout', '2s', true);
  perform set_config('statement_timeout', '20s', true);

  with target_identity as materialized (
    select identity_id
    from public.catalog_source_provider_identities
    where source_id = p_source_id
  ), targets as materialized (
    select item.id, item.external_id
    from public.cloud_media_items item
    where item.source_id = p_source_id
      and item.item_type = p_item_type
      and nullif(btrim(item.subtitle), '') is null
      and nullif(btrim(item.external_id), '') is not null
    order by item.id
    limit p_limit
  ), direct_raw as materialized (
    select
      target.id,
      min(btrim(donor.subtitle)) as category_name,
      count(distinct btrim(donor.subtitle)) as distinct_names
    from targets target
    join target_identity identity on true
    join public.catalog_source_provider_identities donor_link
      on donor_link.identity_id = identity.identity_id
     and donor_link.source_id <> p_source_id
    join public.cloud_media_items donor
      on donor.source_id = donor_link.source_id
     and donor.item_type = p_item_type
     and donor.external_id = target.external_id
     and nullif(btrim(donor.subtitle), '') is not null
    group by target.id
  ), candidates as materialized (
    select id, category_name from direct_raw where distinct_names = 1
  ), updated_media as (
    update public.cloud_media_items item
    set
      subtitle = candidate.category_name,
      metadata = jsonb_set(
        coalesce(item.metadata, '{}'::jsonb),
        '{categoryName}',
        to_jsonb(candidate.category_name),
        true
      ),
      updated_at = now()
    from candidates candidate
    where item.id = candidate.id
      and nullif(btrim(item.subtitle), '') is null
    returning item.id, candidate.category_name
  ), updated_variants as (
    update public.cloud_title_variants variant
    set
      metadata = jsonb_set(
        coalesce(variant.metadata, '{}'::jsonb),
        '{categoryName}',
        to_jsonb(updated.category_name),
        true
      ),
      updated_at = now()
    from updated_media updated
    where variant.media_item_id = updated.id
    returning variant.id, variant.title_id, updated.category_name
  ), updated_titles as (
    -- Only a missing title-level category may be filled, and only from that
    -- title's selected default variant. Updating metadata intentionally fires
    -- cloud_titles_sync_genre_cols, which recomputes genre_category and the
    -- indexed genre_buckets with the current classifier.
    update public.cloud_titles title
    set
      metadata = jsonb_set(
        coalesce(title.metadata, '{}'::jsonb),
        '{categoryName}',
        to_jsonb(updated.category_name),
        true
      ),
      updated_at = now()
    from updated_variants updated
    where title.id = updated.title_id
      and title.default_variant_id = updated.id
      and nullif(btrim(title.genre_category), '') is null
    returning title.id
  )
  select count(*)::integer into changed from updated_media;

  return coalesce(changed, 0);
exception
  when lock_not_available or query_canceled then
    return 0;
end;
$$;

revoke all on function public.norva_hydrate_source_category_names(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.norva_hydrate_source_category_names(uuid, text, integer)
  to service_role;
