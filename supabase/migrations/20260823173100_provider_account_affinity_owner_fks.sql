begin;
set local lock_timeout='2s';
set local statement_timeout='30s';

do $install$
begin
  if exists (select 1 from pg_catalog.pg_constraint where conrelid='public.cloud_source_provider_account_affinities'::regclass and conname='cloud_source_provider_account_affinities_source_fk')
     and not (
       public.norva_provider_access_foundation_fk_is_exact('public.cloud_source_provider_account_affinities','cloud_source_provider_account_affinities_source_fk',array['source_id']::name[],'public.cloud_sources',array['id']::name[],'a','c',false)
       or public.norva_provider_access_foundation_fk_is_exact('public.cloud_source_provider_account_affinities','cloud_source_provider_account_affinities_source_fk',array['source_id']::name[],'public.cloud_sources',array['id']::name[],'a','c',true)
     ) then raise exception 'provider affinity source FK drift' using errcode='55000'; end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid='public.cloud_source_provider_account_affinities'::regclass and conname='cloud_source_provider_account_affinities_source_fk') then
    alter table public.cloud_source_provider_account_affinities
      add constraint cloud_source_provider_account_affinities_source_fk
      foreign key(source_id) references public.cloud_sources(id)
      on delete cascade not valid;
  end if;

  if exists (select 1 from pg_catalog.pg_constraint where conrelid='public.cloud_source_provider_account_affinities'::regclass and conname='cloud_source_provider_account_affinities_user_fk')
     and not (
       public.norva_provider_access_foundation_fk_is_exact('public.cloud_source_provider_account_affinities','cloud_source_provider_account_affinities_user_fk',array['user_id']::name[],'auth.users',array['id']::name[],'a','c',false)
       or public.norva_provider_access_foundation_fk_is_exact('public.cloud_source_provider_account_affinities','cloud_source_provider_account_affinities_user_fk',array['user_id']::name[],'auth.users',array['id']::name[],'a','c',true)
     ) then raise exception 'provider affinity user FK drift' using errcode='55000'; end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid='public.cloud_source_provider_account_affinities'::regclass and conname='cloud_source_provider_account_affinities_user_fk') then
    alter table public.cloud_source_provider_account_affinities
      add constraint cloud_source_provider_account_affinities_user_fk
      foreign key(user_id) references auth.users(id)
      on delete cascade not valid;
  end if;

  if exists (select 1 from pg_catalog.pg_constraint where conrelid='public.cloud_source_provider_account_affinities'::regclass and conname='cloud_source_provider_account_affinities_owner_fk')
     and not (
       public.norva_provider_access_foundation_fk_is_exact('public.cloud_source_provider_account_affinities','cloud_source_provider_account_affinities_owner_fk',array['user_id','source_id']::name[],'public.cloud_sources',array['user_id','id']::name[],'c','c',false)
       or public.norva_provider_access_foundation_fk_is_exact('public.cloud_source_provider_account_affinities','cloud_source_provider_account_affinities_owner_fk',array['user_id','source_id']::name[],'public.cloud_sources',array['user_id','id']::name[],'c','c',true)
     ) then raise exception 'provider affinity owner FK drift' using errcode='55000'; end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid='public.cloud_source_provider_account_affinities'::regclass and conname='cloud_source_provider_account_affinities_owner_fk') then
    alter table public.cloud_source_provider_account_affinities
      add constraint cloud_source_provider_account_affinities_owner_fk
      foreign key(user_id,source_id) references public.cloud_sources(user_id,id)
      on update cascade on delete cascade not valid;
  end if;
end
$install$;

alter table public.cloud_source_provider_account_affinities
  validate constraint cloud_source_provider_account_affinities_source_fk;
alter table public.cloud_source_provider_account_affinities
  validate constraint cloud_source_provider_account_affinities_user_fk;
alter table public.cloud_source_provider_account_affinities
  validate constraint cloud_source_provider_account_affinities_owner_fk;

do $postcondition$
begin
  if not public.norva_provider_access_foundation_fk_is_exact('public.cloud_source_provider_account_affinities','cloud_source_provider_account_affinities_source_fk',array['source_id']::name[],'public.cloud_sources',array['id']::name[],'a','c',true)
     or not public.norva_provider_access_foundation_fk_is_exact('public.cloud_source_provider_account_affinities','cloud_source_provider_account_affinities_user_fk',array['user_id']::name[],'auth.users',array['id']::name[],'a','c',true)
     or not public.norva_provider_access_foundation_fk_is_exact('public.cloud_source_provider_account_affinities','cloud_source_provider_account_affinities_owner_fk',array['user_id','source_id']::name[],'public.cloud_sources',array['user_id','id']::name[],'c','c',true) then
    raise exception 'provider affinity FK postcondition failed' using errcode='55000';
  end if;
end
$postcondition$;
commit;
