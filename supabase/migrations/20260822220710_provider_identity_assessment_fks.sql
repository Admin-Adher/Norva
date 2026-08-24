begin;
set local lock_timeout='2s';
set local statement_timeout='30s';
do $ddl$ begin
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid='public.cloud_source_identity_assessments'::regclass and conname='cloud_source_identity_assessments_old_identity_id_fkey') then alter table public.cloud_source_identity_assessments add constraint cloud_source_identity_assessments_old_identity_id_fkey foreign key (old_identity_id) references public.provider_identities(id) on delete set null not valid; end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid='public.cloud_source_identity_assessments'::regclass and conname='cloud_source_identity_assessments_candidate_identity_id_fkey') then alter table public.cloud_source_identity_assessments add constraint cloud_source_identity_assessments_candidate_identity_id_fkey foreign key (candidate_identity_id) references public.provider_identities(id) on delete set null not valid; end if;
end $ddl$;
alter table public.cloud_source_identity_assessments validate constraint cloud_source_identity_assessments_old_identity_id_fkey;
alter table public.cloud_source_identity_assessments validate constraint cloud_source_identity_assessments_candidate_identity_id_fkey;
do $assert$ begin
  if not public.norva_provider_access_foundation_fk_is_exact('public.cloud_source_identity_assessments','cloud_source_identity_assessments_old_identity_id_fkey',array['old_identity_id']::name[],'public.provider_identities',array['id']::name[],'a','n',true)
     or not public.norva_provider_access_foundation_fk_is_exact('public.cloud_source_identity_assessments','cloud_source_identity_assessments_candidate_identity_id_fkey',array['candidate_identity_id']::name[],'public.provider_identities',array['id']::name[],'a','n',true) then raise exception 'identity assessment FK drift' using errcode='55000'; end if;
end $assert$;
commit;
