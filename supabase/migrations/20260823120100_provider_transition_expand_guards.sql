begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';
do $ddl$
begin
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = 'public.cloud_source_transitions'::regclass and conname = 'cloud_source_transitions_request_fingerprint_ck') then
    alter table public.cloud_source_transitions add constraint cloud_source_transitions_request_fingerprint_ck check (
      request_fingerprint is null or request_fingerprint ~ '^[0-9a-f]{64}$'
    ) not valid;
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = 'public.cloud_source_transitions'::regclass and conname = 'cloud_source_transitions_candidate_generation_fk') then
    alter table public.cloud_source_transitions add constraint cloud_source_transitions_candidate_generation_fk foreign key (user_id, candidate_catalog_generation_id) references public.cloud_source_catalog_generations(user_id, id) on update cascade on delete restrict not valid;
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = 'public.cloud_source_transitions'::regclass and conname = 'cloud_source_transitions_previous_generation_fk') then
    alter table public.cloud_source_transitions add constraint cloud_source_transitions_previous_generation_fk foreign key (old_source_id, previous_catalog_generation_id) references public.cloud_source_catalog_generations(source_id, id) on update cascade on delete restrict not valid;
  end if;
end
$ddl$;
create or replace trigger trg_cloud_source_transition_fingerprint_guard
before update on public.cloud_source_transitions
for each row execute function public.norva_credential_transition_fingerprint_guard();
do $assert$
begin
  if not public.norva_catalog_expand_constraint_is_exact('public.cloud_source_transitions','cloud_source_transitions_request_fingerprint_ck','c',array['request_fingerprint']::name[],null,null,'request_fingerprint',null,null,null,false)
     or not public.norva_catalog_expand_constraint_is_exact('public.cloud_source_transitions','cloud_source_transitions_candidate_generation_fk','f',array['user_id','candidate_catalog_generation_id']::name[],'public.cloud_source_catalog_generations',array['user_id','id']::name[],null,'c','r','s',false)
     or not public.norva_catalog_expand_constraint_is_exact('public.cloud_source_transitions','cloud_source_transitions_previous_generation_fk','f',array['old_source_id','previous_catalog_generation_id']::name[],'public.cloud_source_catalog_generations',array['source_id','id']::name[],null,'c','r','s',false)
     or not public.norva_catalog_expand_trigger_is_exact('public.cloud_source_transitions','trg_cloud_source_transition_fingerprint_guard','public.norva_credential_transition_fingerprint_guard()'::regprocedure,19) then
    raise exception 'provider transition expand guard drift' using errcode = '55000';
  end if;
end
$assert$;
commit;
