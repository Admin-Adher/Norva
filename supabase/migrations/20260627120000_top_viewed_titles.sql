-- Global "real views" signal for the Home Top 10 rail.
--
-- Read-only aggregation (no schema change, no write-path hook): counts the distinct
-- users who have a watch-history row for any provider variant of each canonical title
-- (keyed by item_type + provider_tmdb_id). The Home "popular" rail ranks by this, with
-- TMDB rating as the tiebreak, so the Top 10 reflects real viewing as it accumulates and
-- degrades gracefully to top-rated when views are still sparse.
--
-- Join is deliberately tolerant: a movie's watch-history item_id == the movie variant's
-- external_id; a series episode's parent_item_id == the series variant's external_id.
-- Matching external_id against (item_id, parent_item_id) covers both without depending on
-- the exact item_type string stored in history. source_id is per-user (cloud_sources →
-- user), so the source match keeps each play tied to its own owner's variant.
--
-- Service-role only (the edge functions use the service client); never exposed to anon/auth.

create or replace function public.top_viewed_titles(p_item_type text, p_limit int default 50)
returns table (provider_tmdb_id text, views bigint)
language sql
stable
security definer
set search_path = public
as $$
  select ct.provider_tmdb_id, count(distinct h.user_id)::bigint as views
  from public.cloud_watch_history h
  join public.cloud_title_variants v
    on v.source_id = h.source_id
   and v.item_type = p_item_type
   and v.external_id in (h.item_id, h.parent_item_id)
  join public.cloud_titles ct on ct.id = v.title_id
  where ct.provider_tmdb_id is not null
    and ct.provider_tmdb_id <> ''
    and ct.provider_tmdb_id !~ '^(tt)?0+$'
  group by ct.provider_tmdb_id
  order by views desc, ct.provider_tmdb_id
  limit greatest(1, least(p_limit, 200));
$$;

revoke all on function public.top_viewed_titles(text, int) from public, anon, authenticated;
