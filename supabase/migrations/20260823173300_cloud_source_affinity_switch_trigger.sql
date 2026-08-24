begin;
set local lock_timeout='2s';
set local statement_timeout='15s';
create or replace trigger trg_cloud_sources_provider_account_affinity
after update of source_type, config_ciphertext, config_hint on public.cloud_sources
for each row execute function public.norva_switch_provider_account_affinity();
do $postcondition$
declare v_expected smallint[]; v_actual smallint[];
begin
  if not public.norva_provider_access_foundation_trigger_is_exact('public.cloud_sources','trg_cloud_sources_provider_account_affinity','public.norva_switch_provider_account_affinity()'::regprocedure,17) then
    raise exception 'cloud source affinity switch trigger drift' using errcode='55000';
  end if;
  select pg_catalog.array_agg(attribute_state.attnum::smallint order by expected.ordinal)
    into v_expected
  from pg_catalog.unnest(array['source_type','config_ciphertext','config_hint']::name[])
    with ordinality expected(column_name,ordinal)
  join pg_catalog.pg_attribute attribute_state
    on attribute_state.attrelid='public.cloud_sources'::regclass
   and attribute_state.attname=expected.column_name and not attribute_state.attisdropped;
  select tgattr::smallint[] into strict v_actual from pg_catalog.pg_trigger where tgrelid='public.cloud_sources'::regclass and tgname='trg_cloud_sources_provider_account_affinity';
  if pg_catalog.array_to_string(v_actual,',') is distinct from pg_catalog.array_to_string(v_expected,',') then raise exception 'cloud source affinity trigger column drift' using errcode='55000'; end if;
end
$postcondition$;
commit;
