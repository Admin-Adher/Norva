-- Standalone one-index unit; never wrap CREATE INDEX CONCURRENTLY in BEGIN.
set lock_timeout='2s';
set statement_timeout='30min';
select public.norva_preflight_catalog_generation_online_index('cloud_media_items_generation_natural_online_uidx');
create unique index concurrently if not exists cloud_media_items_generation_natural_online_uidx
  on public.cloud_media_items(source_id,generation_id,item_type,external_id);
select public.norva_assert_catalog_generation_online_index('cloud_media_items_generation_natural_online_uidx');
reset lock_timeout;
reset statement_timeout;
