begin;
set local lock_timeout='2s';
set local statement_timeout='15s';
create or replace trigger trg_00_cloud_sources_provider_account_affinity_insert
after insert on public.cloud_sources
for each row execute function public.norva_insert_source_provider_account_affinity();
do $postcondition$
begin
  if not public.norva_provider_access_foundation_trigger_is_exact(
       'public.cloud_sources','trg_00_cloud_sources_provider_account_affinity_insert',
       'public.norva_insert_source_provider_account_affinity()'::regprocedure,5
     ) or coalesce((select cardinality(tgattr::smallint[])<>0 from pg_catalog.pg_trigger
       where tgrelid='public.cloud_sources'::regclass
         and tgname='trg_00_cloud_sources_provider_account_affinity_insert'),true) then
    raise exception 'source affinity insert trigger drift' using errcode='55000';
  end if;
end
$postcondition$;
commit;
