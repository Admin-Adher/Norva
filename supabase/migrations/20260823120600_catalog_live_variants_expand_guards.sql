begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';
do $ddl$
begin
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = 'public.cloud_live_variants'::regclass and conname = 'cloud_live_variants_generation_required_ck') then
    alter table public.cloud_live_variants add constraint cloud_live_variants_generation_required_ck check (generation_id is not null) not valid;
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = 'public.cloud_live_variants'::regclass and conname = 'cloud_live_variants_generation_fk') then
    alter table public.cloud_live_variants add constraint cloud_live_variants_generation_fk foreign key (source_id, generation_id) references public.cloud_source_catalog_generations(source_id, id) on update cascade on delete restrict not valid;
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = 'public.cloud_live_variants'::regclass and conname = 'cloud_live_variants_ingest_lease_ck') then
    alter table public.cloud_live_variants add constraint cloud_live_variants_ingest_lease_ck check (
      (ingest_job_id is null and ingest_attempt is null and ingest_lease_owner is null)
      or (ingest_job_id is not null and ingest_attempt between 1 and 25 and btrim(ingest_lease_owner) <> '' and length(ingest_lease_owner) <= 160)
    ) not valid;
  end if;
end
$ddl$;
create or replace trigger trg_cloud_live_variants_generation_guard_statement before insert or update or delete on public.cloud_live_variants for each statement execute function public.norva_catalog_generation_guard_begin_statement();
create or replace trigger trg_cloud_live_variants_generation_write_guard before insert or update or delete on public.cloud_live_variants for each row execute function public.norva_catalog_generation_write_guard();
create or replace trigger trg_cloud_live_variants_generation_revision_i after insert on public.cloud_live_variants referencing new table as new_rows for each statement execute function public.norva_catalog_generation_row_changed();
create or replace trigger trg_cloud_live_variants_generation_revision_u after update on public.cloud_live_variants referencing new table as new_rows for each statement execute function public.norva_catalog_generation_row_changed();
create or replace trigger trg_cloud_live_variants_generation_revision_d after delete on public.cloud_live_variants referencing old table as old_rows for each statement execute function public.norva_catalog_generation_row_changed();
do $assert$
begin
  if not public.norva_catalog_expand_constraint_is_exact('public.cloud_live_variants','cloud_live_variants_generation_required_ck','c',array['generation_id']::name[],null,null,'generation_required',null,null,null,false)
     or not public.norva_catalog_expand_constraint_is_exact('public.cloud_live_variants','cloud_live_variants_generation_fk','f',array['source_id','generation_id']::name[],'public.cloud_source_catalog_generations',array['source_id','id']::name[],null,'c','r','s',false)
     or not public.norva_catalog_expand_constraint_is_exact('public.cloud_live_variants','cloud_live_variants_ingest_lease_ck','c',array['ingest_job_id','ingest_attempt','ingest_lease_owner']::name[],null,null,'ingest_lease',null,null,null,false)
     or not public.norva_catalog_expand_trigger_is_exact('public.cloud_live_variants','trg_cloud_live_variants_generation_guard_statement','public.norva_catalog_generation_guard_begin_statement()'::regprocedure,30)
     or not public.norva_catalog_expand_trigger_is_exact('public.cloud_live_variants','trg_cloud_live_variants_generation_write_guard','public.norva_catalog_generation_write_guard()'::regprocedure,31)
     or not public.norva_catalog_expand_trigger_is_exact('public.cloud_live_variants','trg_cloud_live_variants_generation_revision_i','public.norva_catalog_generation_row_changed()'::regprocedure,4)
     or not public.norva_catalog_expand_trigger_is_exact('public.cloud_live_variants','trg_cloud_live_variants_generation_revision_u','public.norva_catalog_generation_row_changed()'::regprocedure,16)
     or not public.norva_catalog_expand_trigger_is_exact('public.cloud_live_variants','trg_cloud_live_variants_generation_revision_d','public.norva_catalog_generation_row_changed()'::regprocedure,8) then
    raise exception 'cloud_live_variants expand guard drift' using errcode = '55000';
  end if;
end
$assert$;
commit;
