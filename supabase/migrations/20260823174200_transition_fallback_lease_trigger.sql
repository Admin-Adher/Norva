begin;
set local lock_timeout='2s';
set local statement_timeout='15s';
create or replace trigger trg_00_cloud_source_transition_fallback_lease
before insert on public.cloud_source_transitions
for each row execute function public.norva_source_transition_fallback_lease_guard();
do $postcondition$
begin
  if not public.norva_provider_access_foundation_trigger_is_exact(
       'public.cloud_source_transitions','trg_00_cloud_source_transition_fallback_lease',
       'public.norva_source_transition_fallback_lease_guard()'::regprocedure,7
     ) or coalesce((select cardinality(tgattr::smallint[])<>0 from pg_catalog.pg_trigger
       where tgrelid='public.cloud_source_transitions'::regclass
         and tgname='trg_00_cloud_source_transition_fallback_lease'),true) then
    raise exception 'transition fallback lease trigger drift' using errcode='55000';
  end if;
end
$postcondition$;
commit;
