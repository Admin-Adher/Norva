-- Real functions in a disposable database; no production events or transport.
begin;
select set_config('request.jwt.claim.role','service_role',true);
do $test$
declare
  u uuid := gen_random_uuid();
  existing_source uuid := gen_random_uuid();
  observed_type text;
  observed_failure text;
begin
  insert into auth.users(id,email) values(u,'import-context-fixture@example.test');
  insert into public.cloud_sources(id,user_id,source_type,sync_status)
    values(existing_source,u,'xtream','syncing');
  perform public.norva_capture_behavioral_source_attempt(
    u,'m3u','failed','endpoint_not_found','mobile_android','1.3.19',gen_random_uuid()
  );
  select last_source_type,last_failure_family into observed_type,observed_failure
    from public.behavioral_lifecycle_user_state where user_id=u;
  if observed_type is distinct from 'm3u' or observed_failure is distinct from 'endpoint_not_found' then
    raise exception 'The failed M3U attempt was not captured';
  end if;

  -- The large existing Xtream import writes this same-status heartbeat.
  update public.cloud_sources set sync_status='syncing',updated_at=clock_timestamp()
    where id=existing_source;
  select last_source_type,last_failure_family into observed_type,observed_failure
    from public.behavioral_lifecycle_user_state where user_id=u;
  if observed_type is distinct from 'm3u' or observed_failure is distinct from 'endpoint_not_found' then
    raise exception 'An unrelated source heartbeat replaced the failed-attempt help context';
  end if;

  -- A real new failure must still change the contextual source format.
  update public.cloud_sources set sync_status='error',sync_error='provider_unavailable'
    where id=existing_source;
  select last_source_type into observed_type from public.behavioral_lifecycle_user_state where user_id=u;
  if observed_type is distinct from 'xtream' then
    raise exception 'A genuine Xtream failure kept the old M3U context';
  end if;
end;
$test$;
rollback;
select 'BEHAVIORAL_IMPORT_CONTEXT_PROOF_OK';
