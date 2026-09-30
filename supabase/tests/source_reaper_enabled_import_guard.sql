-- Executed only by tests/run-source-reaper-enabled-proof.py against its
-- networkless, schema-only disposable database. No production row is copied.
begin;
set local statement_timeout = '15s';
do $proof$
declare
  target constant uuid := '93093000-0000-4000-8000-000000000001';
  paused constant uuid := '93093000-0000-4000-8000-000000000002';
  owner_id constant uuid := '93093000-0000-4000-8000-000000000003';
  session_id constant uuid := '93093000-0000-4000-8000-000000000004';
  actual integer;
begin
  if current_database() <> 'norva_source_reaper_proof'
     or current_setting('norva.disposable_reaper_proof',true) <> 'on' then
    raise exception 'disposable reaper proof database required';
  end if;
  insert into public.cloud_sources(id,user_id,sync_status,enabled,deleted_at,
    provider_deletion_pending,provider_deletion_epoch)
  values (target,owner_id,'ready',true,now()-interval '7 days',false,0),
    (paused,owner_id,'syncing',false,null,false,0);
  insert into public.cloud_media_items(id,source_id) values (gen_random_uuid(),target);

  -- First run against the unmodified live definition reproduces starvation.
  if current_setting('norva.reaper_expected_legacy',true) = 'on' then
    call public.reap_deleted_sources();
    if (select count(*) from public.cloud_media_items where source_id=target) <> 1 then
      raise exception 'legacy disabled-source starvation was not reproduced';
    end if;
    raise notice 'PASS legacy disabled syncing source prevents cleanup';
    return;
  end if;

  call public.reap_deleted_sources();
  if exists(select 1 from public.cloud_media_items where source_id=target)
     or not (select provider_deletion_pending from public.cloud_sources where id=target)
     or not (select sync_status='syncing' and not enabled
       from public.cloud_sources where id=paused) then
    raise exception 'disabled import did not allow drain without changing paused source';
  end if;
  raise notice 'PASS disabled syncing source permits bounded cleanup and stays paused';

  update public.cloud_sources set provider_deletion_pending=false where id=target;
  insert into public.cloud_media_items(id,source_id) values (gen_random_uuid(),target);
  update public.cloud_sources set enabled=true where id=paused;
  call public.reap_deleted_sources();
  if (select count(*) from public.cloud_media_items where source_id=target) <> 1
     or (select provider_deletion_pending from public.cloud_sources where id=target) then
    raise exception 'enabled syncing import no longer defers cleanup';
  end if;
  raise notice 'PASS enabled syncing source still defers cleanup';

  update public.cloud_sources set sync_status='ready' where id=paused;
  call public.reap_deleted_sources();
  if exists(select 1 from public.cloud_media_items where source_id=target) then
    raise exception 'enabled ready source incorrectly prevents cleanup';
  end if;
  raise notice 'PASS enabled non-syncing source does not defer cleanup';

  update public.cloud_sources set provider_deletion_pending=false,sync_status='syncing'
    where id=target;
  insert into public.cloud_media_items(id,source_id) values (gen_random_uuid(),target);
  call public.reap_deleted_sources();
  if exists(select 1 from public.cloud_media_items where source_id=target) then
    raise exception 'deleted syncing source incorrectly prevents its own cleanup';
  end if;
  raise notice 'PASS deleted syncing source does not prevent cleanup';

  update public.cloud_sources set provider_deletion_pending=false,sync_status='ready'
    where id=target;
  update public.cloud_sources set enabled=false,sync_status='syncing' where id=paused;
  insert into public.cloud_media_items(id,source_id) values (gen_random_uuid(),target);
  insert into public.cloud_provider_call_permits(id,source_id,state,permit_until)
    values(gen_random_uuid(),target,'active',now()+interval '1 hour');
  call public.reap_deleted_sources();
  if (select count(*) from public.cloud_media_items where source_id=target) <> 1 then
    raise exception 'active provider permit no longer protects source';
  end if;
  delete from public.cloud_provider_call_permits where source_id=target;
  raise notice 'PASS active provider permit still prevents cleanup';

  insert into public.cloud_source_direct_fallback_leases(source_id,affinity_hash,lease_until)
    values(target,'synthetic-proof',now()+interval '1 hour');
  call public.reap_deleted_sources();
  if (select count(*) from public.cloud_media_items where source_id=target) <> 1 then
    raise exception 'fallback lease no longer protects source';
  end if;
  delete from public.cloud_source_direct_fallback_leases where source_id=target;
  raise notice 'PASS active fallback lease still prevents cleanup';

  insert into public.cloud_playback_sessions(id,source_id,status,expires_at)
    values(session_id,target,'ready',now()+interval '1 hour');
  call public.reap_deleted_sources();
  if (select count(*) from public.cloud_media_items where source_id=target) <> 1 then
    raise exception 'active playback no longer protects source';
  end if;
  update public.cloud_playback_sessions set status='expired' where id=session_id;
  raise notice 'PASS active playback still prevents cleanup';

  insert into public.cloud_gateway_sessions(id,playback_session_id,status,expires_at)
    values(gen_random_uuid(),session_id,'ready',now()+interval '1 hour');
  call public.reap_deleted_sources();
  if (select count(*) from public.cloud_media_items where source_id=target) <> 1 then
    raise exception 'active gateway session no longer protects source';
  end if;
  delete from public.cloud_gateway_sessions where playback_session_id=session_id;
  delete from public.cloud_playback_sessions where id=session_id;
  raise notice 'PASS active gateway session still prevents cleanup';

  insert into public.cloud_source_catalog_generations(id,user_id,source_id)
    values(gen_random_uuid(),owner_id,target);
  insert into public.cloud_source_lifecycle(source_id,user_id,lifecycle_state,catalog_visibility)
    values(target,owner_id,'purge_pending','hidden');
  insert into public.cloud_source_replacement_cleanup_jobs(transition_id,user_id,source_id,
    state,available_at) values(gen_random_uuid(),owner_id,target,'pending',now()+interval '1 hour');
  call public.reap_deleted_sources();
  if (select count(*) from public.cloud_media_items where source_id=target) <> 1 then
    raise exception 'future cleanup authority no longer protects generation';
  end if;
  update public.cloud_source_replacement_cleanup_jobs set available_at=now()-interval '1 second'
    where source_id=target;
  call public.reap_deleted_sources();
  if exists(select 1 from public.cloud_media_items where source_id=target) then
    raise exception 'due cleanup authority does not admit generation';
  end if;
  raise notice 'PASS generation cleanup still requires an exact due cleanup job';

  update public.cloud_sources set provider_deletion_pending=false where id=target;
  insert into public.cloud_media_items(id,source_id)
    select gen_random_uuid(),target from generate_series(1,5001);
  insert into public.cloud_media_items(id,source_id) values(gen_random_uuid(),paused);
  call public.reap_deleted_sources();
  select count(*) into actual from public.cloud_media_items where source_id=target;
  if actual <> 1 or (select provider_deletion_pending from public.cloud_sources where id=target)
     or (select count(*) from public.cloud_media_items where source_id=paused) <> 1 then
    raise exception 'row budget or source isolation changed: % rows remain',actual;
  end if;
  raise notice 'PASS unchanged 5000-row budget and unrelated source isolation';
end
$proof$;
rollback;
