set lock_timeout='2s';
set statement_timeout='30min';
select public.norva_preflight_catalog_generation_online_index('catalog_series_inventory_variant_online_uidx');
create unique index concurrently if not exists catalog_series_inventory_variant_online_uidx
  on public.catalog_series_inventory_state(user_id,generation_id,parent_variant_id);
select public.norva_assert_catalog_generation_online_index('catalog_series_inventory_variant_online_uidx');
reset lock_timeout;
reset statement_timeout;
