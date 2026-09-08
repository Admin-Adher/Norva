-- Disposable database only. No SMTP, production events or clock changes.
begin;
do $test$
declare
  u uuid := gen_random_uuid();
  other_user uuid := gen_random_uuid();
  progressive uuid := gen_random_uuid();
begin
  insert into auth.users(id,email) values
    (u,'usable-catalog-fixture@example.test'),
    (other_user,'other-owner-fixture@example.test');
  insert into public.cloud_sources(user_id,source_type,sync_status,sync_error)
    values(u,'m3u','error','provider_unavailable');
  update public.behavioral_lifecycle_user_state
    set import_issue_started_at=clock_timestamp(),import_issue_origin='source',
      import_succeeded_at=null,catalog_ready_at=null
    where user_id=u;
  if not public.norva_behavioral_state_relevant(u,'import_unresolved') then
    raise exception 'A genuinely blocked import lost its reminder';
  end if;

  insert into public.cloud_sources(id,user_id,source_type,sync_status,config_hint)
    values(progressive,u,'xtream','syncing',
      '{"syncProgress":{"usable":true,"browseReady":true,"counts":{"total":27000}}}');
  if public.norva_behavioral_state_relevant(u,'import_unresolved') then
    raise exception 'A usable progressive catalogue received an unnecessary import reminder';
  end if;

  update public.cloud_sources set config_hint='{"syncProgress":{"usable":true}}' where id=progressive;
  if not public.norva_behavioral_state_relevant(u,'import_unresolved') then
    raise exception 'Incomplete readiness flags suppressed a blocked import';
  end if;
  update public.cloud_sources set config_hint='{"syncProgress":{"usable":false,"browseReady":true}}' where id=progressive;
  if not public.norva_behavioral_state_relevant(u,'import_unresolved') then
    raise exception 'An unusable catalogue suppressed a blocked import';
  end if;
  update public.cloud_sources set config_hint='{"syncProgress":{"usable":true,"browseReady":true}}',enabled=false where id=progressive;
  if not public.norva_behavioral_state_relevant(u,'import_unresolved') then
    raise exception 'A disabled catalogue suppressed a blocked import';
  end if;
  update public.cloud_sources set enabled=true,deleted_at=clock_timestamp() where id=progressive;
  if not public.norva_behavioral_state_relevant(u,'import_unresolved') then
    raise exception 'A deleted catalogue suppressed a blocked import';
  end if;
  update public.cloud_sources set deleted_at=null,sync_error='provider_unavailable' where id=progressive;
  if not public.norva_behavioral_state_relevant(u,'import_unresolved') then
    raise exception 'An errored catalogue suppressed a blocked import';
  end if;
  update public.cloud_sources set sync_error=null,sync_status='idle' where id=progressive;
  if not public.norva_behavioral_state_relevant(u,'import_unresolved') then
    raise exception 'Stale readiness on an idle source suppressed a blocked import';
  end if;

  update public.cloud_sources set sync_status='syncing',user_id=other_user where id=progressive;
  if not public.norva_behavioral_state_relevant(u,'import_unresolved') then
    raise exception 'Another owner catalogue changed reminder eligibility';
  end if;
  update public.cloud_sources set user_id=u,sync_status='ready' where id=progressive;
  if public.norva_behavioral_state_relevant(u,'import_unresolved') then
    raise exception 'A completed catalogue regained an import reminder';
  end if;
  if public.norva_behavioral_state_relevant(u,'no_source') then
    raise exception 'The no-source journey changed for an account with sources';
  end if;
end;
$test$;
rollback;
select 'BEHAVIORAL_USABLE_CATALOG_PROOF_OK';
