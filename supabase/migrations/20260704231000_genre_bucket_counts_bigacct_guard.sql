-- Fix: the Movies/Series genre-picker summary times out for mega-accounts.
--
-- cloud_genre_bucket_counts unnests genre_buckets over EVERY title of the user and
-- groups — a ~24s scan at 380k titles (measured), past the statement timeout. The genre
-- PICKER counts are non-essential (the genre RAILS use the GIN-indexed `genre_buckets @>
-- {bucket}` per-bucket fetch, not this summary), so for large catalogues skip the exact
-- tally and return no rows. The size probe is an index-only count on cloud_media_items
-- (~1s at 380k) — the same guard threshold as list_media_items_deduped.
--
-- Consequence: the two mega-accounts lose the per-genre numbers in the picker (a proper
-- fix would cache them), but the grid and the genre rails load normally.

create or replace function public.cloud_genre_bucket_counts(p_user_id uuid, p_item_type text, p_source_id uuid default null)
returns table(bucket text, n bigint)
language plpgsql
stable
set search_path to 'public'
as $$
begin
  if (select count(*) from cloud_media_items
      where user_id = p_user_id and item_type = p_item_type) > 60000 then
    return;
  end if;
  return query
    select b as bucket, count(*) as n
    from public.cloud_titles t
         cross join lateral unnest(coalesce(t.genre_buckets, array['autres'])) as b
    where t.user_id = p_user_id
      and t.item_type = p_item_type
      and t.variant_count > 0
      and b <> 'autres'
      and (
        p_source_id is null
        or exists (
          select 1 from public.cloud_title_variants v
          where v.title_id = t.id and v.source_id = p_source_id
        )
      )
    group by b;
end $$;
