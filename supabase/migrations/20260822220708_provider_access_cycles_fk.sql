begin;
set local lock_timeout='2s';
set local statement_timeout='30s';
do $ddl$ begin
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid='public.cloud_source_access_cycles'::regclass and conname='cloud_source_access_cycles_source_owner_fk') then
    alter table public.cloud_source_access_cycles add constraint cloud_source_access_cycles_source_owner_fk foreign key (user_id,source_id) references public.cloud_sources(user_id,id) on update cascade on delete cascade not valid;
  end if;
end $ddl$;
alter table public.cloud_source_access_cycles validate constraint cloud_source_access_cycles_source_owner_fk;
do $assert$ begin
  if not public.norva_provider_access_foundation_fk_is_exact('public.cloud_source_access_cycles','cloud_source_access_cycles_source_owner_fk',array['user_id','source_id']::name[],'public.cloud_sources',array['user_id','id']::name[],'c','c',true) then raise exception 'access cycle FK drift' using errcode='55000'; end if;
end $assert$;
commit;
