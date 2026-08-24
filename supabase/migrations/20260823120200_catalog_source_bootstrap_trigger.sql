begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';
create or replace trigger trg_cloud_sources_catalog_generation_bootstrap
after insert on public.cloud_sources
for each row execute function public.norva_bootstrap_source_catalog_generation();
do $assert$
begin
  if not public.norva_catalog_expand_trigger_is_exact('public.cloud_sources','trg_cloud_sources_catalog_generation_bootstrap','public.norva_bootstrap_source_catalog_generation()'::regprocedure,5) then
    raise exception 'catalog source bootstrap trigger drift' using errcode = '55000';
  end if;
end
$assert$;
commit;
