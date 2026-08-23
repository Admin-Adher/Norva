begin;
set local lock_timeout='2s';
set local statement_timeout='15s';
create or replace trigger trg_00_provider_account_affinity_fallback_lease
before insert or update of affinity_hash, source_id, user_id or delete
on public.cloud_source_provider_account_affinities
for each row execute function public.norva_provider_account_affinity_fallback_lease_guard();
do $postcondition$
declare v_expected smallint[]; v_actual smallint[];
begin
  if not public.norva_provider_access_foundation_trigger_is_exact(
       'public.cloud_source_provider_account_affinities',
       'trg_00_provider_account_affinity_fallback_lease',
       'public.norva_provider_account_affinity_fallback_lease_guard()'::regprocedure,31
     ) then raise exception 'affinity fallback lease trigger drift' using errcode='55000'; end if;
  select pg_catalog.array_agg(attribute_state.attnum::smallint order by expected.ordinal)
    into v_expected
  from pg_catalog.unnest(array['affinity_hash','source_id','user_id']::name[])
    with ordinality expected(column_name,ordinal)
  join pg_catalog.pg_attribute attribute_state
    on attribute_state.attrelid='public.cloud_source_provider_account_affinities'::regclass
   and attribute_state.attname=expected.column_name and not attribute_state.attisdropped;
  select tgattr::smallint[] into strict v_actual
  from pg_catalog.pg_trigger where tgrelid='public.cloud_source_provider_account_affinities'::regclass
    and tgname='trg_00_provider_account_affinity_fallback_lease';
  if pg_catalog.array_to_string(v_actual,',') is distinct from pg_catalog.array_to_string(v_expected,',') then
    raise exception 'affinity fallback lease trigger column drift' using errcode='55000';
  end if;
end
$postcondition$;
commit;
