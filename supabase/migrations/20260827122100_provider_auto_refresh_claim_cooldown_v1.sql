begin;

-- A provider detection can outlive its Edge background isolate or its durable
-- lease. Retrying that same oldest source on the next cron tick starves every
-- younger due source. A claim now reserves a retry cooldown beyond the lease;
-- success/error settlement still replaces it with the normal outcome cadence.
do $migration$
declare
  v_definition text;
  v_updated text;
  v_needle constant text :=
    'auto_refresh_next_at = clock_timestamp() + make_interval(secs => p_lease_seconds),';
  v_replacement constant text :=
    'auto_refresh_next_at = clock_timestamp() + make_interval(secs => p_lease_seconds) + interval ''30 minutes'',';
  v_occurrences integer;
begin
  select pg_catalog.pg_get_functiondef(
    'public.norva_claim_cloud_auto_refresh_sources(text,integer,integer)'::regprocedure
  ) into v_definition;

  v_occurrences := (
    length(v_definition) - length(replace(v_definition, v_needle, ''))
  ) / length(v_needle);
  if v_occurrences <> 1 then
    raise exception
      'unexpected cloud auto-refresh claim contract: expected 1 next-at assignment, found %',
      v_occurrences
      using errcode = '55000';
  end if;

  v_updated := replace(v_definition, v_needle, v_replacement);
  execute v_updated;
end
$migration$;

-- Recover only already-expired scheduler leases from the previous contract.
-- The owner/sequence is never reused; a late worker remains unable to settle.
set local request.jwt.claim.role = 'service_role';
update public.cloud_sources source
set auto_refresh_lease_owner = null,
    auto_refresh_lease_expires_at = null,
    auto_refresh_next_at = clock_timestamp() + interval '30 minutes',
    auto_refresh_state = (
      coalesce(source.auto_refresh_state, '{}'::jsonb)
      - array['lockedAt','backoffUntil']
    ) || jsonb_build_object(
      'attempts', least(20, case
        when coalesce(source.auto_refresh_state ->> 'attempts', '') ~ '^[0-9]{1,2}$'
          then (source.auto_refresh_state ->> 'attempts')::integer + 1
        else 1
      end),
      'lastOutcome', 'transient_failure',
      'lastErrorKind', 'unknown',
      'lastCompletedAt', clock_timestamp(),
      'backoffUntil', clock_timestamp() + interval '30 minutes'
    )
where source.auto_refresh_lease_owner like 'cloud-auto-refresh:%'
  and source.auto_refresh_lease_expires_at <= clock_timestamp();

commit;
