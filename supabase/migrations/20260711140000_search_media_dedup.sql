-- =============================================================================
-- Server-side dedup for global search — opt-in via p_dedup (durable version of
-- the client-only fix from the global-search UX pass).
-- =============================================================================
-- search_media_items returns RAW cloud_media_items rows — every provider
-- version of every film. That is load-bearing for the version picker:
-- MoviesPage/SeriesPage openByItem() re-fetch a tapped result's sibling
-- versions through this same RPC (q = title), so an unconditional collapse
-- here would strip a film's versions.
--
-- Hence dedup is OPT-IN (p_dedup, default false = today's behaviour):
--   * the global-search overlay passes dedup → one row per film, mirroring the
--     grid's model. MATCH still runs on every version's title (a film must
--     surface even when only a mirror's decorated title matches — better
--     recall than filtering on is_dedup_primary). COLLAPSE is DISTINCT ON
--     (dedup_key) with the grid's representative tiebreaker (poster → resolved
--     tmdb → rating → external_id, see 20260704270000_media_dedup_primary.sql).
--     Each film ranks by its BEST-matching version (max over the group).
--   * openByItem() keeps the default and still receives all versions.
-- Rows without a dedup_key (e.g. series not yet backfilled) fall back to their
-- own id — same as the grid's filtered path (no regression).
--
-- Adding a parameter would create an ambiguous overload next to the 4-arg
-- version → drop it first (edge-only caller; applied atomically).

begin;

drop function if exists public.search_media_items(uuid, text, text, int);

create function public.search_media_items(
  p_user uuid,
  p_item_type text,
  p_q text,
  p_limit int default 24,
  p_dedup boolean default false
) returns setof public.cloud_media_items
language sql
stable
security definer
set search_path = public
as $$
  with matched as (
    select t,
           coalesce(t.dedup_key, t.id::text) as dk,
           (t.title ilike '%' || p_q || '%') as substr_hit,
           similarity(t.title, p_q) as sim
    from public.cloud_media_items t
    where t.user_id = p_user
      and t.item_type = p_item_type
      and (
        t.title ilike '%' || p_q || '%'
        or t.title % p_q                       -- trigram similarity (typo tolerance)
      )
  ),
  reps as (
    -- One row per film; group rank = its best-matching version.
    select distinct on (dk)
           t,
           max(substr_hit::int) over (partition by dk) as g_substr,
           max(sim) over (partition by dk) as g_sim
    from matched
    where p_dedup
    order by dk,
      ((t).poster_url is not null) desc,
      (((t).metadata->>'providerTmdbId') is not null) desc,
      (t).rating_num desc nulls last,
      (t).external_id
  ),
  raw as (
    select t, substr_hit::int as g_substr, sim as g_sim
    from matched
    where not p_dedup
  ),
  unioned as (
    select * from reps
    union all
    select * from raw
  )
  select (t).*
  from unioned
  order by g_substr desc, g_sim desc, (t).title
  limit greatest(1, least(p_limit, 50));
$$;

-- Fresh function → ACL starts at PUBLIC (see
-- 20260705050000_secdef_grant_drift_hardening.sql) — assert edge-only access.
revoke all on function public.search_media_items(uuid, text, text, int, boolean)
  from public, anon, authenticated;
grant execute on function public.search_media_items(uuid, text, text, int, boolean)
  to service_role;

commit;
