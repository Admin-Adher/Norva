-- Phase 2a: propagate the already-validated TMDB canonical title/poster/i18n from the GLOBAL
-- catalog_titles cache onto each user's cloud_titles rows that have a provider TMDB id but were
-- never validated (match_status='provider_unverified', no tmdbValidation). Zero TMDB calls — pure
-- reuse of what another user/pass already resolved. identity_key is unchanged (tmdb:<id>), so this
-- never re-keys / re-dedups; it only upgrades the display title + metadata. Bounded per call so a
-- cron can drain the backlog (and catch new entries as the TMDB cron fills catalog_titles) without
-- ever running unbounded. Poster kept if the row already has one (fill only when missing).

-- Support the enrichment join + the backlog scan: a small PARTIAL index over just the
-- unverified-with-tmdb-id rows, so finding the next batch is an index scan, not a full seq scan.
create index if not exists cloud_titles_unverified_tmdb_idx
  on public.cloud_titles (item_type, provider_tmdb_id)
  where match_status = 'provider_unverified' and provider_tmdb_id is not null;

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
    limit greatest(1, coalesce(p_limit, 5000))
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

revoke all on function public.cloud_enrich_titles_from_catalog(int) from public, anon, authenticated;
grant execute on function public.cloud_enrich_titles_from_catalog(int) to service_role;

-- Drain continuously: every 5 min enrich up to 5k rows from the global cache. Cheap (indexed
-- join, no external calls); stops doing work once the backlog is drained (0-row batches).
select cron.schedule(
  'norva-enrich-titles-from-catalog',
  '3-59/5 * * * *',
  $cron$ set statement_timeout='120s'; select public.cloud_enrich_titles_from_catalog(5000); $cron$
);
