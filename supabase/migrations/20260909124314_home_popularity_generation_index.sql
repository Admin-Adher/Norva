-- Drive popularity from watched files, not every visible catalogue variant.
-- The generation-aware natural index is (source_id, generation_id, item_type,
-- external_id). An unconstrained generation makes PostgreSQL scan entire source
-- catalogues for each history row. Separate legacy and active generations so
-- both reads use all four index keys, retaining the canonical visibility view.
create or replace function public.top_viewed_titles(p_item_type text, p_limit int default 50)
returns table (provider_tmdb_id text, views bigint)
language sql
stable
security definer
set search_path = public
as $$
  select ct.provider_tmdb_id, count(distinct h.user_id)::bigint as views
  from public.cloud_watch_history h
  left join public.cloud_source_catalog_heads active_head
    on active_head.source_id = h.source_id
   and active_head.user_id = h.user_id
  join lateral (
    select v.title_id
    from public.cloud_catalog_visible_title_variants v
    where v.user_id = h.user_id
      and v.source_id = h.source_id
      and v.item_type = p_item_type
      and v.generation_id is null
      and v.external_id = any(array[h.item_id, h.parent_item_id])
    union all
    select v.title_id
    from public.cloud_catalog_visible_title_variants v
    where v.user_id = h.user_id
      and v.source_id = h.source_id
      and v.item_type = p_item_type
      and v.generation_id = active_head.active_generation_id
      and v.external_id = any(array[h.item_id, h.parent_item_id])
    -- Keep these lookups parameterized by history; pulling the union into a
    -- global join would restore the full-catalogue scan this function avoids.
    offset 0
  ) v on true
  join public.cloud_titles ct on ct.id = v.title_id and ct.user_id = h.user_id
  where ct.provider_tmdb_id is not null
    and ct.provider_tmdb_id <> ''
    and ct.provider_tmdb_id !~ '^(tt)?0+$'
  group by ct.provider_tmdb_id
  order by views desc, ct.provider_tmdb_id
  limit greatest(1, least(p_limit, 200));
$$;

revoke all on function public.top_viewed_titles(text, int) from public, anon, authenticated;
grant execute on function public.top_viewed_titles(text, int) to service_role;
