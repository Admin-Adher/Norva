-- Quality-aware flip-readiness gate for the global title cache, superseding the
-- byte-equality catalog_mirror_diff() — which is obsolete now that the mirror's
-- self-thinning empties cloud_titles.metadata BY DESIGN (so catalog vs cloud can
-- never be byte-equal again, and that is correct, not rot).
--
-- This measures the question that actually matters at read-cutover: would serving
-- catalog_titles ever show WORSE than the per-user cloud_titles row it replaces?
-- "Clean" (flip-ready) = every *_worse count is 0: the cache is never blank where
-- the best cloud row has a value, never less TMDB-enriched, and every user title
-- exists in the cache (identity). The keep-best trigger keeps it clean going
-- forward. Read-only, service-role gated (called via an edge route like the old
-- /catalog-mirror-verify).

create or replace function public.catalog_titles_quality_gate(p_item_type text default null)
returns table (
  compared         bigint,
  title_worse      bigint,
  year_worse       bigint,
  poster_worse     bigint,
  backdrop_worse   bigint,
  enrich_worse     bigint,
  identity_missing bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with cloud as (
    select distinct on (item_type, provider_tmdb_id)
      item_type, provider_tmdb_id, title, release_year, poster_url, backdrop_url,
      (jsonb_typeof(metadata->'tmdb')='object') as enriched
    from public.cloud_titles
    where provider_tmdb_id is not null and provider_tmdb_id <> '' and provider_tmdb_id !~ '^(tt)?0+$'
      and (p_item_type is null or item_type = p_item_type)
    order by item_type, provider_tmdb_id,
             (jsonb_typeof(metadata->'tmdb')='object') desc, updated_at desc nulls last
  ),
  j as (
    select c.title, c.release_year, c.poster_url, c.backdrop_url, c.enriched,
           cat.title as cat_title, cat.release_year as cat_year, cat.poster_url as cat_poster,
           cat.backdrop_url as cat_backdrop,
           (jsonb_typeof(cat.metadata->'tmdb')='object') as cat_enriched,
           (cat.item_type is not null) as in_catalog
    from cloud c
    left join public.catalog_titles cat using (item_type, provider_tmdb_id)
  )
  select
    count(*) filter (where in_catalog),
    count(*) filter (where in_catalog and cat_title    is null and title        is not null),
    count(*) filter (where in_catalog and cat_year     is null and release_year is not null),
    count(*) filter (where in_catalog and cat_poster   is null and poster_url   is not null),
    count(*) filter (where in_catalog and cat_backdrop is null and backdrop_url is not null),
    count(*) filter (where in_catalog and not cat_enriched and enriched),
    count(*) filter (where not in_catalog)
  from j;
$$;

revoke all on function public.catalog_titles_quality_gate(text) from public, anon, authenticated;
grant execute on function public.catalog_titles_quality_gate(text) to service_role;