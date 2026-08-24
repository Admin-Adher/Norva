begin;
set local lock_timeout='2s';
set local statement_timeout='15s';
create or replace trigger trg_00_legacy_fenced_write_proof
before update on public.cloud_title_variants for each row
execute function public.norva_apply_legacy_catalog_write_proof();
do $postcondition$
begin
  if not public.norva_provider_access_foundation_trigger_is_exact('public.cloud_title_variants','trg_00_legacy_fenced_write_proof','public.norva_apply_legacy_catalog_write_proof()'::regprocedure,19)
     or coalesce((select cardinality(tgattr::smallint[])<>0 from pg_catalog.pg_trigger where tgrelid='public.cloud_title_variants'::regclass and tgname='trg_00_legacy_fenced_write_proof'),true) then
    raise exception 'title variant legacy proof trigger drift' using errcode='55000';
  end if;
end
$postcondition$;
commit;
