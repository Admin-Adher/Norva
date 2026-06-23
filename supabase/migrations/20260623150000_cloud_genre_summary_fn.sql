-- Aggregates the genre summary in SQL: returns distinct (categoryName, tmdb
-- genres) combinations with their title count, so the edge function transfers a
-- few thousand grouped rows instead of tens of thousands of full rows (which
-- overran the function and produced "Unable to load genres" on large
-- catalogues). The curated-bucket mapping still happens in TS, multiplying by n.
create or replace function public.cloud_genre_summary(p_user_id uuid, p_item_type text)
returns table(category_name text, genres jsonb, n bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select metadata->>'categoryName',
         metadata->'tmdb'->'genres',
         count(*)
  from public.cloud_titles
  where user_id = p_user_id
    and item_type = p_item_type
  group by 1, 2
$$;

revoke execute on function public.cloud_genre_summary(uuid, text) from public, anon, authenticated;
