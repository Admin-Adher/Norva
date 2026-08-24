begin;
set local lock_timeout='2s';
set local statement_timeout='30s';
do $install$
begin
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid='public.cloud_catalog_generation_backfill_sources'::regclass and conname='cloud_catalog_generation_backfill_source_owner_fk') then
    alter table public.cloud_catalog_generation_backfill_sources add constraint cloud_catalog_generation_backfill_source_owner_fk foreign key(user_id,source_id) references public.cloud_sources(user_id,id) on update cascade on delete cascade not valid;
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid='public.cloud_catalog_generation_backfill_sources'::regclass and conname='cloud_catalog_generation_backfill_generation_fk') then
    alter table public.cloud_catalog_generation_backfill_sources add constraint cloud_catalog_generation_backfill_generation_fk foreign key(source_id,active_generation_id) references public.cloud_source_catalog_generations(source_id,id) on update cascade on delete restrict not valid;
  end if;
end
$install$;
alter table public.cloud_catalog_generation_backfill_sources validate constraint cloud_catalog_generation_backfill_source_owner_fk;
alter table public.cloud_catalog_generation_backfill_sources validate constraint cloud_catalog_generation_backfill_generation_fk;
do $postcondition$
begin
  if not public.norva_provider_access_foundation_fk_is_exact('public.cloud_catalog_generation_backfill_sources','cloud_catalog_generation_backfill_source_owner_fk',array['user_id','source_id']::name[],'public.cloud_sources',array['user_id','id']::name[],'c','c',true)
     or not public.norva_provider_access_foundation_fk_is_exact('public.cloud_catalog_generation_backfill_sources','cloud_catalog_generation_backfill_generation_fk',array['source_id','active_generation_id']::name[],'public.cloud_source_catalog_generations',array['source_id','id']::name[],'c','r',true) then
    raise exception 'catalog generation backfill queue FK drift' using errcode='55000';
  end if;
end
$postcondition$;
commit;
