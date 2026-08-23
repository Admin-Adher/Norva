begin;
set local lock_timeout='2s';
set local statement_timeout='15s';
create or replace trigger trg_cloud_source_transition_secret_affinity_clear
before update on public.cloud_source_transition_secrets
for each row execute function public.norva_clear_transition_affinity_hashes();
do $postcondition$
begin
  if not public.norva_provider_access_foundation_trigger_is_exact('public.cloud_source_transition_secrets','trg_cloud_source_transition_secret_affinity_clear','public.norva_clear_transition_affinity_hashes()'::regprocedure,19)
     or coalesce((select cardinality(tgattr::smallint[])<>0 from pg_catalog.pg_trigger where tgrelid='public.cloud_source_transition_secrets'::regclass and tgname='trg_cloud_source_transition_secret_affinity_clear'),true) then
    raise exception 'transition secret affinity clear trigger drift' using errcode='55000';
  end if;
end
$postcondition$;
commit;
