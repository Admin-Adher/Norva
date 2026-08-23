begin;
set local lock_timeout='2s';
set local statement_timeout='15s';
create or replace trigger trg_cloud_sources_bootstrap_lifecycle
after insert on public.cloud_sources
for each row execute function public.norva_cloud_source_bootstrap_lifecycle();
create or replace trigger trg_cloud_sources_track_config_revision
after update of source_type, config_ciphertext, enabled, deleted_at
on public.cloud_sources
for each row execute function public.norva_cloud_source_track_revision();
do $assert$
declare
  v_expected smallint[];
  v_actual smallint[];
begin
  if not public.norva_provider_access_foundation_trigger_is_exact('public.cloud_sources','trg_cloud_sources_bootstrap_lifecycle','public.norva_cloud_source_bootstrap_lifecycle()'::regprocedure,5)
     or not public.norva_provider_access_foundation_trigger_is_exact('public.cloud_sources','trg_cloud_sources_track_config_revision','public.norva_cloud_source_track_revision()'::regprocedure,17) then
    raise exception 'cloud_sources lifecycle trigger drift' using errcode='55000';
  end if;
  select array_agg(attribute_state.attnum::smallint order by expected.ordinal)
    into v_expected
  from pg_catalog.unnest(array['source_type','config_ciphertext','enabled','deleted_at']::name[]) with ordinality expected(column_name,ordinal)
  join pg_catalog.pg_attribute attribute_state on attribute_state.attrelid='public.cloud_sources'::regclass and attribute_state.attname=expected.column_name and not attribute_state.attisdropped;
  select trigger_state.tgattr::smallint[] into v_actual
  from pg_catalog.pg_trigger trigger_state
  where trigger_state.tgrelid='public.cloud_sources'::regclass and trigger_state.tgname='trg_cloud_sources_track_config_revision';
  -- pg_trigger.tgattr is an int2vector whose array cast has a zero lower
  -- bound, whereas array_agg() produces a one-based array.  Compare the
  -- ordered values, not the representation bounds.
  if pg_catalog.array_to_string(v_actual, ',') is distinct from pg_catalog.array_to_string(v_expected, ',') then
    raise exception 'cloud_sources track trigger column drift' using errcode='55000';
  end if;
end
$assert$;
grant execute on function public.norva_backfill_provider_access_foundation(integer) to service_role;
do $acl$
begin
  if not has_function_privilege('service_role','public.norva_backfill_provider_access_foundation(integer)','EXECUTE')
     or has_function_privilege('anon','public.norva_backfill_provider_access_foundation(integer)','EXECUTE')
     or has_function_privilege('authenticated','public.norva_backfill_provider_access_foundation(integer)','EXECUTE')
     or not has_table_privilege('service_role','public.cloud_provider_access_foundation_rollout','SELECT')
     or has_table_privilege('service_role','public.cloud_provider_access_foundation_rollout','INSERT,UPDATE,DELETE') then
    raise exception 'provider access foundation backfill ACL drift' using errcode='55000';
  end if;
end
$acl$;
commit;
