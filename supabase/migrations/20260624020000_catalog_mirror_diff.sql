-- Read-cutover trust artifact (docs/roadmap/global-title-cache-design.md): prove
-- catalog_titles is a faithful, per-field mirror of the per-user title metadata BEFORE
-- the global-read flip (NORVA_CATALOG_READ_SOURCE) is ever enabled. The flip is only
-- safe when this stays clean (all *_mismatch = 0 and cloud_only = 0) across a window —
-- which also makes flag-ON read output byte-identical to flag-OFF (the anti-rot proof).
-- Read-only. security definer to read across users' cloud_titles (RLS-bypassed); the
-- calling edge route (/catalog-mirror-verify) is service-role gated (NORVA_BACKFILL_TOKEN).
create or replace function public.catalog_mirror_diff(p_item_type text default null)
returns table (
  compared bigint,
  title_mismatch bigint,
  original_title_mismatch bigint,
  release_year_mismatch bigint,
  poster_url_mismatch bigint,
  backdrop_url_mismatch bigint,
  i18n_mismatch bigint,
  tmdb_mismatch bigint,
  cloud_only bigint,
  catalog_only bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with cloud as (
    select distinct on (item_type, provider_tmdb_id)
      item_type, provider_tmdb_id, title, original_title, release_year, poster_url, backdrop_url,
      metadata->'i18n' as i18n, metadata->'tmdb' as tmdb
    from public.cloud_titles
    where provider_tmdb_id is not null and provider_tmdb_id <> '' and provider_tmdb_id !~ '^(tt)?0+$'
      and (p_item_type is null or item_type = p_item_type)
    order by item_type, provider_tmdb_id, updated_at desc nulls last
  ),
  joined as (
    select
      c.title, c.original_title, c.release_year, c.poster_url, c.backdrop_url, c.i18n, c.tmdb,
      cat.title as cat_title, cat.original_title as cat_original_title,
      cat.release_year as cat_release_year, cat.poster_url as cat_poster_url,
      cat.backdrop_url as cat_backdrop_url,
      cat.metadata->'i18n' as cat_i18n, cat.metadata->'tmdb' as cat_tmdb,
      (cat.item_type is not null) as in_catalog
    from cloud c
    left join public.catalog_titles cat using (item_type, provider_tmdb_id)
  )
  select
    count(*) filter (where in_catalog),
    count(*) filter (where in_catalog and title is distinct from cat_title),
    count(*) filter (where in_catalog and original_title is distinct from cat_original_title),
    count(*) filter (where in_catalog and release_year is distinct from cat_release_year),
    count(*) filter (where in_catalog and poster_url is distinct from cat_poster_url),
    count(*) filter (where in_catalog and backdrop_url is distinct from cat_backdrop_url),
    count(*) filter (where in_catalog and i18n is distinct from cat_i18n),
    count(*) filter (where in_catalog and tmdb is distinct from cat_tmdb),
    count(*) filter (where not in_catalog),
    (select count(*) from public.catalog_titles cat
       where (p_item_type is null or cat.item_type = p_item_type)
         and not exists (
           select 1 from public.cloud_titles c2
            where c2.item_type = cat.item_type and c2.provider_tmdb_id = cat.provider_tmdb_id
         ))
  from joined;
$$;

revoke all on function public.catalog_mirror_diff(text) from public;
revoke all on function public.catalog_mirror_diff(text) from anon;
revoke all on function public.catalog_mirror_diff(text) from authenticated;
grant execute on function public.catalog_mirror_diff(text) to service_role;
