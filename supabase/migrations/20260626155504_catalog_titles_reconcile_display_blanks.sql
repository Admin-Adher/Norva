-- One-time reconciliation: fill catalog_titles display nulls from the best
-- (enriched-then-freshest) cloud_titles row, so the global cache is never
-- *blanker* than the per-user copy it replaces at read-cutover. Pure improvement
-- (coalesce-fill only where catalog is null and cloud has a value); the keep-best
-- trigger + year-clamp guardrail apply to every write here. Measured before this
-- ran: 481 release_year blanks + 718 backdrop_url blanks vs the best cloud row
-- (title/poster/enrichment/identity already 0). Re-runnable and idempotent.

with best_cloud as (
  select distinct on (item_type, provider_tmdb_id)
    item_type, provider_tmdb_id, title, release_year, poster_url, backdrop_url
  from public.cloud_titles
  where provider_tmdb_id is not null and provider_tmdb_id <> '' and provider_tmdb_id !~ '^(tt)?0+$'
  order by item_type, provider_tmdb_id,
           (jsonb_typeof(metadata->'tmdb')='object') desc, updated_at desc nulls last
)
update public.catalog_titles cat
   set title        = coalesce(cat.title, bc.title),
       release_year = coalesce(cat.release_year, bc.release_year),
       poster_url   = coalesce(cat.poster_url, bc.poster_url),
       backdrop_url = coalesce(cat.backdrop_url, bc.backdrop_url)
  from best_cloud bc
 where cat.item_type = bc.item_type and cat.provider_tmdb_id = bc.provider_tmdb_id
   and ( (cat.title is null        and bc.title is not null)
      or (cat.release_year is null and bc.release_year is not null)
      or (cat.poster_url is null   and bc.poster_url is not null)
      or (cat.backdrop_url is null and bc.backdrop_url is not null) );