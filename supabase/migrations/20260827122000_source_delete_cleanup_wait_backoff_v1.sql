begin;

-- Source payloads are drained by reap_deleted_sources(), whose production
-- cadence is ten minutes. Polling the terminal cleanup queue every ten seconds
-- while that durable reaper fence is still false creates thousands of no-op
-- updates for a large catalogue. Match the retry to the reaper cadence; once
-- provider_deletion_pending is true the existing one-second bounded drain is
-- unchanged.
do $migration$
declare
  v_definition text;
  v_updated text;
  v_needle constant text := 'interval ''10 seconds''';
  v_occurrences integer;
begin
  select pg_catalog.pg_get_functiondef(
    'public.norva_run_replacement_cleanup_batch(text,integer)'::regprocedure
  ) into v_definition;

  v_occurrences := (
    length(v_definition) - length(replace(v_definition, v_needle, ''))
  ) / length(v_needle);

  if v_occurrences <> 2 then
    raise exception
      'unexpected replacement cleanup wait contract: expected 2 ten-second waits, found %',
      v_occurrences
      using errcode = '55000';
  end if;

  v_updated := replace(
    v_definition,
    v_needle,
    'interval ''10 minutes'''
  );
  execute v_updated;
end
$migration$;

commit;
