-- Missing FK index on the cascade target cloud_live_variants(media_item_id).
--
-- cloud_media_items -> cloud_live_variants is ON DELETE CASCADE, but media_item_id was
-- unindexed on cloud_live_variants. Clearing a source's catalog (sync re-import, or
-- norva-cloud source delete) deletes cloud_media_items in batches; each delete cascades
-- to cloud_live_variants with a SEQ SCAN per row (O(n^2)), so a large live catalog blew
-- past the edge's ~8s statement budget -> "Unable to clear old catalog items" -> the
-- source stuck in an error/re-sync loop (cronResumeStuck re-kicked it every minute).
--
-- cloud_title_variants(media_item_id) already had a partial index; live was the gap.
-- With this index the cascade is an index lookup and the batched clear finishes well
-- within budget. Idempotent.
create index if not exists idx_cloud_live_variants_media_item
  on public.cloud_live_variants (media_item_id);
