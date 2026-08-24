begin;
set local lock_timeout='2s';
set local statement_timeout='15s';

do $readiness$
declare v_expected smallint[]; v_actual smallint[];
begin
  if not public.norva_provider_access_foundation_trigger_is_exact(
       'public.cloud_sources','trg_cloud_sources_provider_account_affinity',
       'public.norva_switch_provider_account_affinity()'::regprocedure,17
     )
     or not public.norva_provider_access_foundation_trigger_is_exact(
       'public.cloud_sources','trg_00_cloud_sources_provider_account_affinity_insert',
       'public.norva_insert_source_provider_account_affinity()'::regprocedure,5
     )
     or not public.norva_provider_access_foundation_trigger_is_exact(
       'public.cloud_source_transitions','trg_00_cloud_source_transition_fallback_lease',
       'public.norva_source_transition_fallback_lease_guard()'::regprocedure,7
     )
     or not public.norva_provider_access_foundation_trigger_is_exact(
       'public.cloud_source_provider_account_affinities',
       'trg_00_provider_account_affinity_fallback_lease',
       'public.norva_provider_account_affinity_fallback_lease_guard()'::regprocedure,31
     ) then raise exception 'provider fallback lease trigger readiness failed' using errcode='55000'; end if;
  select pg_catalog.array_agg(attribute_state.attnum::smallint order by expected.ordinal)
    into v_expected
  from pg_catalog.unnest(array['source_type','config_ciphertext','config_hint']::name[])
    with ordinality expected(column_name,ordinal)
  join pg_catalog.pg_attribute attribute_state
    on attribute_state.attrelid='public.cloud_sources'::regclass
   and attribute_state.attname=expected.column_name and not attribute_state.attisdropped;
  select tgattr::smallint[] into strict v_actual from pg_catalog.pg_trigger
  where tgrelid='public.cloud_sources'::regclass
    and tgname='trg_cloud_sources_provider_account_affinity';
  if pg_catalog.array_to_string(v_actual,',') is distinct from pg_catalog.array_to_string(v_expected,',') then
    raise exception 'provider config mutation fence columns drift' using errcode='55000';
  end if;
end
$readiness$;

grant execute on function
  public.norva_claim_source_direct_fallback_lease(uuid,uuid,text,integer,text,bigint,text),
  public.norva_release_source_direct_fallback_lease(uuid,uuid,uuid),
  public.norva_backfill_source_provider_account_affinities(integer),
  public.norva_create_credential_transition(uuid,uuid,text,text,bigint,text,jsonb,text,text),
  public.claim_catalog_enrichment_sources(integer,integer)
to service_role;

do $acl$
begin
  if not has_function_privilege('service_role','public.norva_claim_source_direct_fallback_lease(uuid,uuid,text,integer,text,bigint,text)','EXECUTE')
     or not has_function_privilege('service_role','public.norva_release_source_direct_fallback_lease(uuid,uuid,uuid)','EXECUTE')
     or not has_function_privilege('service_role','public.norva_backfill_source_provider_account_affinities(integer)','EXECUTE')
     or not has_function_privilege('service_role','public.norva_create_credential_transition(uuid,uuid,text,text,bigint,text,jsonb,text,text)','EXECUTE')
     or has_function_privilege('service_role','public.norva_claim_source_direct_fallback_lease(uuid,uuid,text,integer)','EXECUTE')
     or has_function_privilege('service_role','public.norva_create_credential_transition(uuid,uuid,text,text,bigint,text,jsonb,text)','EXECUTE')
     or has_function_privilege('service_role','public.norva_bind_credential_transition_account_affinity(uuid,uuid,text,bigint)','EXECUTE') then
    raise exception 'provider fallback lease ACL drift' using errcode='55000';
  end if;
end
$acl$;
notify pgrst,'reload schema';
commit;
