begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';
do $ddl$
begin
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid='public.cloud_user_catalog_visibility_epochs'::regclass and conname='cloud_user_catalog_visibility_epochs_user_id_fkey') then
    alter table public.cloud_user_catalog_visibility_epochs add constraint cloud_user_catalog_visibility_epochs_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade not valid;
  end if;
end
$ddl$;
alter table public.cloud_user_catalog_visibility_epochs validate constraint cloud_user_catalog_visibility_epochs_user_id_fkey;
do $assert$
begin
  if not public.norva_provider_access_foundation_fk_is_exact('public.cloud_user_catalog_visibility_epochs','cloud_user_catalog_visibility_epochs_user_id_fkey',array['user_id']::name[],'auth.users',array['id']::name[],'a','c',true) then raise exception 'visibility epoch user FK drift' using errcode='55000'; end if;
end
$assert$;
commit;
