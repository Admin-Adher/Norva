-- During a refresh, the NULL run marker disappears for one owner's generation
-- and media type, while most unrelated rows retain it. Independent column
-- estimates can otherwise choose a full-table scan for an empty pending set.
create statistics if not exists public.cloud_media_items_refresh_distribution
  (mcv, dependencies)
  on generation_id,item_type,projection_refresh_run_id,source_id,user_id
  from public.cloud_media_items;
create statistics if not exists public.cloud_title_variants_refresh_distribution
  (mcv, dependencies)
  on generation_id,item_type,projection_refresh_run_id,source_id,user_id
  from public.cloud_title_variants;
alter statistics public.cloud_media_items_refresh_distribution set statistics 1000;
alter statistics public.cloud_title_variants_refresh_distribution set statistics 1000;
analyze public.cloud_media_items
  (generation_id,item_type,projection_refresh_run_id,source_id,user_id);
analyze public.cloud_title_variants
  (generation_id,item_type,projection_refresh_run_id,source_id,user_id);
