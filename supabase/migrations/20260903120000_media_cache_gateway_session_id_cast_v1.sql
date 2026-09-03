begin;

-- cloud_gateway_sessions.external_session_id deliberately remains text because
-- Gateway identifiers are external transport data. The cache RPCs accept a
-- UUID only after Edge has validated the identifier, so compare it through an
-- explicit text cast. Without this cast PostgreSQL raises text = uuid before a
-- producer heartbeat, abandon, continuation or publication can be processed.
do $repair$
declare
  v_signature text;
  v_function regprocedure;
  v_definition text;
  v_repaired text;
  v_needle constant text := 'gateway.external_session_id = p_gateway_session_id';
begin
  foreach v_signature in array array[
    'public.norva_abandon_media_cache_producer_for_gateway(uuid,uuid)',
    'public.norva_commit_admitted_media_cache_publication(uuid,uuid,uuid,text,text,bigint,text,text,text,bigint,text,text,text,text,text,bigint,integer,timestamptz)',
    'public.norva_commit_media_cache_publication(uuid,uuid,uuid,text,text,bigint,text,text,text,bigint,text,text,text,text,text,bigint,integer,timestamptz)',
    'public.norva_complete_media_cache_producer_for_gateway(uuid,uuid,uuid,text)',
    'public.norva_pulse_media_cache_continuation_for_gateway(uuid,uuid,text,integer)',
    'public.norva_pulse_media_cache_producer_for_gateway(uuid,uuid,text,integer)',
    'public.norva_request_media_cache_continuation_for_gateway(uuid,uuid,integer)'
  ] loop
    v_function := pg_catalog.to_regprocedure(v_signature);
    if v_function is null then
      raise exception 'required media cache Gateway RPC is missing: %', v_signature;
    end if;

    v_definition := pg_catalog.pg_get_functiondef(v_function);
    if pg_catalog.position((v_needle || '::text') in v_definition) > 0 then
      continue;
    end if;
    if pg_catalog.position(v_needle in v_definition) = 0 then
      raise exception 'media cache Gateway RPC comparison drifted: %', v_signature;
    end if;

    v_repaired := pg_catalog.replace(
      v_definition,
      v_needle,
      v_needle || '::text'
    );
    execute v_repaired;

    if pg_catalog.position(
      (v_needle || '::text') in pg_catalog.pg_get_functiondef(v_function)
    ) = 0 then
      raise exception 'media cache Gateway RPC cast repair failed: %', v_signature;
    end if;
  end loop;
end
$repair$;

commit;
