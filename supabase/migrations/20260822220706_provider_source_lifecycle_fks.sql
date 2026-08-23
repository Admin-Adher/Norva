begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';
do $ddl$
begin
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid='public.cloud_source_lifecycle'::regclass and conname='cloud_source_lifecycle_replaces_source_id_fkey') then alter table public.cloud_source_lifecycle add constraint cloud_source_lifecycle_replaces_source_id_fkey foreign key (replaces_source_id) references public.cloud_sources(id) on delete set null not valid; end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid='public.cloud_source_lifecycle'::regclass and conname='cloud_source_lifecycle_replaced_by_source_id_fkey') then alter table public.cloud_source_lifecycle add constraint cloud_source_lifecycle_replaced_by_source_id_fkey foreign key (replaced_by_source_id) references public.cloud_sources(id) on delete set null not valid; end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid='public.cloud_source_lifecycle'::regclass and conname='cloud_source_lifecycle_source_owner_fk') then alter table public.cloud_source_lifecycle add constraint cloud_source_lifecycle_source_owner_fk foreign key (user_id,source_id) references public.cloud_sources(user_id,id) on update cascade on delete cascade not valid; end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid='public.cloud_source_lifecycle'::regclass and conname='cloud_source_lifecycle_root_owner_fk') then alter table public.cloud_source_lifecycle add constraint cloud_source_lifecycle_root_owner_fk foreign key (user_id,replacement_root_id) references public.cloud_sources(user_id,id) on update cascade on delete restrict not valid; end if;
end
$ddl$;
alter table public.cloud_source_lifecycle validate constraint cloud_source_lifecycle_replaces_source_id_fkey;
alter table public.cloud_source_lifecycle validate constraint cloud_source_lifecycle_replaced_by_source_id_fkey;
alter table public.cloud_source_lifecycle validate constraint cloud_source_lifecycle_source_owner_fk;
alter table public.cloud_source_lifecycle validate constraint cloud_source_lifecycle_root_owner_fk;
do $assert$
begin
  if not public.norva_provider_access_foundation_fk_is_exact('public.cloud_source_lifecycle','cloud_source_lifecycle_replaces_source_id_fkey',array['replaces_source_id']::name[],'public.cloud_sources',array['id']::name[],'a','n',true)
     or not public.norva_provider_access_foundation_fk_is_exact('public.cloud_source_lifecycle','cloud_source_lifecycle_replaced_by_source_id_fkey',array['replaced_by_source_id']::name[],'public.cloud_sources',array['id']::name[],'a','n',true)
     or not public.norva_provider_access_foundation_fk_is_exact('public.cloud_source_lifecycle','cloud_source_lifecycle_source_owner_fk',array['user_id','source_id']::name[],'public.cloud_sources',array['user_id','id']::name[],'c','c',true)
     or not public.norva_provider_access_foundation_fk_is_exact('public.cloud_source_lifecycle','cloud_source_lifecycle_root_owner_fk',array['user_id','replacement_root_id']::name[],'public.cloud_sources',array['user_id','id']::name[],'c','r',true) then raise exception 'source lifecycle FK drift' using errcode='55000'; end if;
end
$assert$;
commit;
