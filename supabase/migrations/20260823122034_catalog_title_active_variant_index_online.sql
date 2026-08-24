-- Standalone concurrent-index unit.  The shrinking NULL-marker index makes the
-- final per-action zero-stale-variant proof bounded and retryable.
set lock_timeout = '2s';
set statement_timeout = '30min';
select pg_catalog.pg_advisory_lock(
  pg_catalog.hashtextextended('catalog-generation-index-repair-v1', 0)
);
select public.norva_catalog_title_projection_cic_preflight(
  'cloud_title_variants_projection_refresh_pending_idx',
  'public.cloud_title_variants',
  array['generation_id','item_type','id'],array[0,0,0]::smallint[],
  '(projection_refresh_run_id IS NULL)'
);
create index concurrently if not exists
  cloud_title_variants_projection_refresh_pending_idx
  on public.cloud_title_variants(generation_id,item_type,id)
  where projection_refresh_run_id is null;
select public.norva_catalog_title_projection_cic_assert(
  'cloud_title_variants_projection_refresh_pending_idx',
  'public.cloud_title_variants',
  array['generation_id','item_type','id'],array[0,0,0]::smallint[],
  '(projection_refresh_run_id IS NULL)'
);
select public.norva_catalog_title_projection_cic_preflight(
  'cloud_live_variants_projection_refresh_pending_idx',
  'public.cloud_live_variants',
  array['generation_id','id'],array[0,0]::smallint[],
  '(projection_refresh_run_id IS NULL)'
);
create index concurrently if not exists
  cloud_live_variants_projection_refresh_pending_idx
  on public.cloud_live_variants(generation_id,id)
  where projection_refresh_run_id is null;
select public.norva_catalog_title_projection_cic_assert(
  'cloud_live_variants_projection_refresh_pending_idx',
  'public.cloud_live_variants',
  array['generation_id','id'],array[0,0]::smallint[],
  '(projection_refresh_run_id IS NULL)'
);
select public.norva_catalog_title_projection_cic_preflight(
  'cloud_media_items_projection_refresh_pending_idx',
  'public.cloud_media_items',
  array['generation_id','item_type','id'],array[0,0,0]::smallint[],
  '(projection_refresh_run_id IS NULL)'
);
create index concurrently if not exists
  cloud_media_items_projection_refresh_pending_idx
  on public.cloud_media_items(generation_id,item_type,id)
  where projection_refresh_run_id is null;
select public.norva_catalog_title_projection_cic_assert(
  'cloud_media_items_projection_refresh_pending_idx',
  'public.cloud_media_items',
  array['generation_id','item_type','id'],array[0,0,0]::smallint[],
  '(projection_refresh_run_id IS NULL)'
);
select public.norva_catalog_title_projection_cic_preflight(
  'cloud_live_logical_projection_refresh_pending_idx',
  'public.cloud_live_logical_channels',
  array['generation_id','id'],array[0,0]::smallint[],
  '(projection_refresh_run_id IS NULL)'
);
create index concurrently if not exists
  cloud_live_logical_projection_refresh_pending_idx
  on public.cloud_live_logical_channels(generation_id,id)
  where projection_refresh_run_id is null;
select public.norva_catalog_title_projection_cic_assert(
  'cloud_live_logical_projection_refresh_pending_idx',
  'public.cloud_live_logical_channels',
  array['generation_id','id'],array[0,0]::smallint[],
  '(projection_refresh_run_id IS NULL)'
);
select public.norva_catalog_title_projection_cic_preflight(
  'cloud_source_generation_categories_refresh_pending_idx',
  'public.cloud_source_catalog_generation_categories',
  array['generation_id','category_kind','provider_category_id'],
  array[0,0,0]::smallint[],
  '(projection_refresh_run_id IS NULL)'
);
create index concurrently if not exists
  cloud_source_generation_categories_refresh_pending_idx
  on public.cloud_source_catalog_generation_categories(
    generation_id,category_kind,provider_category_id
  ) where projection_refresh_run_id is null;
select public.norva_catalog_title_projection_cic_assert(
  'cloud_source_generation_categories_refresh_pending_idx',
  'public.cloud_source_catalog_generation_categories',
  array['generation_id','category_kind','provider_category_id'],
  array[0,0,0]::smallint[],
  '(projection_refresh_run_id IS NULL)'
);
do $unlock$
begin
  if not pg_catalog.pg_advisory_unlock(
    pg_catalog.hashtextextended('catalog-generation-index-repair-v1', 0)
  ) then
    raise exception 'active title variant repair lock was not held'
      using errcode = '55000';
  end if;
end
$unlock$;
reset lock_timeout;
reset statement_timeout;
