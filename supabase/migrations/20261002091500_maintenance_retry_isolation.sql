-- Expected concurrency retries must not roll back successful work for other
-- owners. Preserve the lower-level visibility and provider-account fences.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';
do $patch$
declare
  signature text;
  definition text;
  old_body text;
  new_body text;
begin
  foreach signature in array array[
    'public.cloud_refresh_all_facet_summaries(integer)',
    'public.cloud_refresh_all_genre_rail_candidates(integer)'
  ] loop
    definition := pg_get_functiondef(signature::regprocedure);
    if definition like '%maintenance_retry_isolation_v1%' then continue; end if;
    if definition not like '%  loop%    perform public.cloud_refresh_%'
      or definition not like '%    refreshed := refreshed + 1;%' then
      raise exception 'Unexpected refresh function: %',signature;
    end if;
    definition := replace(definition,'  loop','  loop
    -- maintenance_retry_isolation_v1
    begin');
    definition := replace(definition,'    refreshed := refreshed + 1;',
      '    refreshed := refreshed + 1;
    exception when serialization_failure then
      declare diagnostic text;
      begin
        get stacked diagnostics diagnostic = pg_exception_detail;
        if diagnostic is distinct from ''reason=catalog_visibility_changed'' then raise; end if;
        -- Keep the existing summary; the next sweep retries this owner.
      end;
    end;');
    execute definition;
  end loop;

  definition := pg_get_functiondef('public.norva_recover_source_delete_cleanups(integer)'::regprocedure);
  if definition not like '%maintenance_retry_isolation_v1%' then
    old_body := '    if public.norva_enqueue_source_delete_cleanup(';
    if strpos(definition,old_body)=0 then raise exception 'Unexpected cleanup recovery'; end if;
    definition := replace(definition,old_body,'    -- maintenance_retry_isolation_v1
    begin
    if public.norva_enqueue_source_delete_cleanup(');
    definition := replace(definition,'    end if;
  end loop;', '    end if;
    exception when lock_not_available then
      declare diagnostic text;
      begin
        get stacked diagnostics diagnostic = pg_exception_detail;
        if diagnostic is distinct from ''reason=account_transition_active'' then raise; end if;
        -- Do not bypass the active transition. Retry this tombstone later.
      end;
    end;
  end loop;');
    execute definition;
  end if;

  definition := pg_get_functiondef('public.prune_branded_email_outbox()'::regprocedure);
  old_body := 'resend_response=''{}''::jsonb, payload_scrubbed_at=';
  new_body := 'resend_response=case when mail_provider=''resend'' then ''{}''::jsonb else null end,
      postal_response=case when mail_provider=''postal'' then ''{}''::jsonb else null end,
      payload_scrubbed_at=';
  if strpos(definition,new_body)=0 then
    if strpos(definition,old_body)=0 then raise exception 'Unexpected branded prune'; end if;
    execute replace(definition,old_body,new_body);
  end if;
end
$patch$;
commit;
