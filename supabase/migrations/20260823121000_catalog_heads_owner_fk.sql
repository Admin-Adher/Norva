begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';
do $ddl$
begin
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = 'public.cloud_source_catalog_heads'::regclass and conname = 'cloud_source_catalog_heads_source_owner_fk') then
    alter table public.cloud_source_catalog_heads add constraint cloud_source_catalog_heads_source_owner_fk foreign key (user_id, source_id) references public.cloud_sources(user_id, id) on update cascade on delete restrict not valid;
  end if;
end
$ddl$;
alter table public.cloud_source_catalog_heads validate constraint cloud_source_catalog_heads_source_owner_fk;
do $assert$
begin
  if not public.norva_catalog_expand_constraint_is_exact('public.cloud_source_catalog_heads','cloud_source_catalog_heads_source_owner_fk','f',array['user_id','source_id']::name[],'public.cloud_sources',array['user_id','id']::name[],null,'c','r','s',true) then
    raise exception 'catalog head owner foreign key drift' using errcode = '55000';
  end if;
end
$assert$;
commit;
