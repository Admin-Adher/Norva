-- Catalog filters re-audit (2026-07-05) — Phase 1 quick fix for the empty genre picker.
--
-- cloud_genre_bucket_counts returned NOTHING above a 60k-item estimate ("too big, return nothing"),
-- which made the genre/Categories filter empty for exactly the large catalogues (verified live:
-- 335k-movie account → []). But /media-genre-summary is CDN-cached 60s and the group-by measures
-- ~4.6s over 334k rows — well under the 120s service_role timeout and amortised by the cache. The
-- guard traded a once-per-minute 4.6s query for a permanently broken filter.
--
-- Raise the ceiling to 1,000,000 so every realistic catalogue (current max ~377k) gets its real
-- genre buckets, keeping a high safety valve for pathological sizes. Phase 2 (a precomputed per-user
-- facet summary) will replace this live count with an instant read and drop the ceiling concern.
-- Body reproduced verbatim from live; only the threshold changed.
create or replace function public.cloud_genre_bucket_counts(p_user_id uuid, p_item_type text, p_source_id uuid default null)
returns table(bucket text, n bigint)
language plpgsql
stable
set search_path to 'public'
as $function$
begin
  -- Big-account guard: a planner ESTIMATE (instant) instead of an exact count(*). Raised from 60k
  -- to 1M so large catalogues still get their genre buckets (the endpoint is cached 60s).
  if public.catalog_item_estimate(p_user_id, p_item_type) > 1000000 then
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
end $function$;
-- SECURITY INVOKER, service_role only (called by the norva-catalog edge). Re-assert defensively.
revoke all on function public.cloud_genre_bucket_counts(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.cloud_genre_bucket_counts(uuid, text, uuid) to service_role;
