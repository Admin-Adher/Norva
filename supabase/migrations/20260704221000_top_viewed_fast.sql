-- Fix the Home "popular" rail hanging the page (loads for tens of seconds).
--
-- top_viewed_titles() joined cloud_watch_history ⋈ cloud_title_variants ⋈ cloud_titles
-- with the predicate `v.external_id in (h.item_id, h.parent_item_id)`. That IN over two
-- columns of the OUTER row is not a plain equality, so the planner refused to drive the
-- (source_id, item_type, external_id) index from history and instead SEQ-SCANNED all
-- ~755k variant rows on every Home load. Cold buffer cache (after the reconcile cron
-- churned shared_buffers) turned that into 30-60s+ of DataFileRead — the page just spun.
--
-- The result set is tiny (history is only a few dozen rows), so the correct plan is a
-- nested loop from history. A LATERAL subquery expresses `external_id = ANY(...)` as an
-- index condition the planner CAN drive: it now Index-Scans variants per history row
-- (total cost ~382 vs a 755k seq scan) — milliseconds instead of a minute. Semantics are
-- identical: same join keys, same tmdb filters, same count(distinct user) ranking.

create or replace function public.top_viewed_titles(p_item_type text, p_limit int default 50)
returns table (provider_tmdb_id text, views bigint)
language sql
stable
security definer
set search_path = public
as $$
  select ct.provider_tmdb_id, count(distinct h.user_id)::bigint as views
  from public.cloud_watch_history h
  join lateral (
    -- index-driven: (source_id, item_type, external_id) with external_id = ANY(array)
    select v.title_id
    from public.cloud_title_variants v
    where v.source_id = h.source_id
      and v.item_type = p_item_type
      and v.external_id in (h.item_id, h.parent_item_id)
  ) v on true
  join public.cloud_titles ct on ct.id = v.title_id
  where ct.provider_tmdb_id is not null
    and ct.provider_tmdb_id <> ''
    and ct.provider_tmdb_id !~ '^(tt)?0+$'
  group by ct.provider_tmdb_id
  order by views desc, ct.provider_tmdb_id
  limit greatest(1, least(p_limit, 200));
$$;

revoke all on function public.top_viewed_titles(text, int) from public, anon, authenticated;
