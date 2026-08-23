set lock_timeout='2s';
set statement_timeout='30min';
select public.norva_preflight_catalog_generation_online_index('cloud_live_variants_generation_natural_online_uidx');
create unique index concurrently if not exists cloud_live_variants_generation_natural_online_uidx
  on public.cloud_live_variants(source_id,generation_id,logical_id,stream_id,label);
select public.norva_assert_catalog_generation_online_index('cloud_live_variants_generation_natural_online_uidx');
reset lock_timeout;
reset statement_timeout;
