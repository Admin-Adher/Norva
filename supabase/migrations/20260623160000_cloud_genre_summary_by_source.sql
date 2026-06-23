-- Manage Content lets the user scope the per-genre show/hide view to a single
-- provider (or "All providers"). Extend the genre-summary aggregation with an
-- optional source filter: when p_source_id is null we count every title the
-- user has; when set we count only titles that have at least one playable
-- variant from that provider. The 2-arg call site keeps working because the
-- new argument defaults to null, so we drop the old 2-arg function to avoid an
-- overload-resolution ambiguity in PostgREST.
drop function if exists public.cloud_genre_summary(uuid, text);

create or replace function public.cloud_genre_summary(
  p_user_id uuid,
  p_item_type text,
  p_source_id uuid default null
)
returns table(category_name text, genres jsonb, n bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select
    t.metadata->>'categoryName'        as category_name,
    t.metadata->'tmdb'->'genres'       as genres,
    count(*)                           as n
  from public.cloud_titles t
  where t.user_id = p_user_id
    and t.item_type = p_item_type
    and (
      p_source_id is null
      or exists (
        select 1
        from public.cloud_title_variants v
        where v.title_id = t.id
          and v.source_id = p_source_id
      )
    )
  group by 1, 2
$$;

revoke execute on function public.cloud_genre_summary(uuid, text, uuid) from public, anon, authenticated;
grant  execute on function public.cloud_genre_summary(uuid, text, uuid) to service_role;
