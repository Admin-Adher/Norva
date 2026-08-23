-- A terminal job cannot retain a live lease.  Release it in the same CAS that
-- records the rollback proof completion.
do $migration$
declare
  v_definition text;
  v_legacy text := 'set state = ''completed'', completed_at = now()';
  v_fixed text := 'set state = ''completed'', completed_at = now(),' || E'\n' ||
    '      lease_owner = null, lease_until = null';
begin
  select pg_get_functiondef(
    'public.norva_finish_credential_compensation(uuid,uuid,uuid,text,integer,bigint,bigint,uuid)'::regprocedure
  ) into v_definition;
  if position(v_fixed in v_definition) > 0 then return; end if;
  if position(v_legacy in v_definition) = 0 then
    raise exception 'credential compensation completion does not match expected lease-retaining definition'
      using errcode = '55000';
  end if;
  execute replace(v_definition,v_legacy,v_fixed);
end
$migration$;
