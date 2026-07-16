-- =============================================================================
-- cloud_enrich_titles_from_catalog → deadlock-proof (FOR UPDATE SKIP LOCKED).
-- =============================================================================
-- 2026-07-15 20:03 UTC: the norva-enrich-titles-from-catalog cron failed once with
-- "deadlock detected" — its multi-row UPDATE (up to 5000 cloud_titles) crossed
-- another multi-row cloud_titles writer (the projection's 500-row import upserts;
-- note enrich (:03/:08/…) and search-match (every 3 min) also collide at :03/:18/
-- :33/:48). Two batch writers acquiring row locks in different orders → cycle.
--
-- A drain cron should never WAIT on row locks at all: lock the batch up front with
-- FOR UPDATE OF ct SKIP LOCKED. Rows someone else is touching are skipped (picked
-- up by the next 5-min run — same semantics as the failed-run retry, minus the
-- failure) and, holding the locks before the UPDATE, the function can no longer be
-- part of any deadlock cycle. Logic and grants otherwise identical to 20260706120000.

create or replace function public.cloud_enrich_titles_from_catalog(p_limit int default 5000)
returns int
language plpgsql
security definer
set search_path to 'public'
as $function$
declare n int;
begin
  with batch as (
    select ct.id, c.title as ctitle, c.poster_url as cposter, c.backdrop_url as cbackdrop, c.metadata as cmeta
    from public.cloud_titles ct
    join public.catalog_titles c
      on c.item_type = ct.item_type and c.provider_tmdb_id = ct.provider_tmdb_id
    where ct.match_status = 'provider_unverified'
      and ct.metadata->'tmdbValidation' is null
      and (c.metadata->'tmdbValidation'->>'valid') = 'true'
      and c.title is not null and c.title <> ''
    order by ct.id
    limit greatest(1, coalesce(p_limit, 5000))
    for update of ct skip locked
  )
  update public.cloud_titles ct set
    title        = b.ctitle,
    poster_url   = coalesce(nullif(ct.poster_url, ''), b.cposter),
    backdrop_url = coalesce(nullif(ct.backdrop_url, ''), b.cbackdrop),
    match_status = 'provider_verified',
    metadata     = ct.metadata || jsonb_strip_nulls(jsonb_build_object(
                     'tmdb',           b.cmeta->'tmdb',
                     'i18n',           b.cmeta->'i18n',
                     'tmdbValidation', b.cmeta->'tmdbValidation'
                   ))
  from batch b
  where ct.id = b.id;
  get diagnostics n = row_count;
  return n;
end
$function$;

-- CREATE OR REPLACE keeps existing grants; re-assert anyway (cheap, self-documenting).
revoke all on function public.cloud_enrich_titles_from_catalog(int) from public, anon, authenticated;
grant execute on function public.cloud_enrich_titles_from_catalog(int) to service_role;
