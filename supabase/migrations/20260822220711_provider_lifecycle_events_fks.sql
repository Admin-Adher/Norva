begin;
set local lock_timeout='2s';
set local statement_timeout='30s';
do $ddl$ begin
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid='public.cloud_source_lifecycle_events'::regclass and conname='cloud_source_lifecycle_events_user_id_fkey') then alter table public.cloud_source_lifecycle_events add constraint cloud_source_lifecycle_events_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade not valid; end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid='public.cloud_source_lifecycle_events'::regclass and conname='cloud_source_lifecycle_events_source_owner_fk') then alter table public.cloud_source_lifecycle_events add constraint cloud_source_lifecycle_events_source_owner_fk foreign key (user_id,source_id) references public.cloud_sources(user_id,id) on update cascade on delete restrict not valid; end if;
end $ddl$;
alter table public.cloud_source_lifecycle_events validate constraint cloud_source_lifecycle_events_user_id_fkey;
alter table public.cloud_source_lifecycle_events validate constraint cloud_source_lifecycle_events_source_owner_fk;
do $assert$ begin
  if not public.norva_provider_access_foundation_fk_is_exact('public.cloud_source_lifecycle_events','cloud_source_lifecycle_events_user_id_fkey',array['user_id']::name[],'auth.users',array['id']::name[],'a','c',true)
     or not public.norva_provider_access_foundation_fk_is_exact('public.cloud_source_lifecycle_events','cloud_source_lifecycle_events_source_owner_fk',array['user_id','source_id']::name[],'public.cloud_sources',array['user_id','id']::name[],'c','r',true) then raise exception 'lifecycle event FK drift' using errcode='55000'; end if;
end $assert$;
commit;
