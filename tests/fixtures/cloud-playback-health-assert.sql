do $$
declare
 u uuid := '11111111-1111-4111-8111-111111111111';
 other_u uuid := '22222222-2222-4222-8222-222222222222';
 src uuid := '33333333-3333-4333-8333-333333333333';
 dev uuid := '44444444-4444-4444-8444-444444444444';
 old_session uuid := '55555555-5555-4555-8555-555555555555';
 new_session uuid := '66666666-6666-4666-8666-666666666666';
 r jsonb;
begin
 insert into auth.users values(u),(other_u);
 insert into cloud_sources values(src,u);
 insert into cloud_source_lifecycle values(src,u,7,'active','visible');
 insert into cloud_playback_sessions(id,user_id,source_id,device_id,item_type,item_id,created_at)
 values(old_session,u,src,dev,'series','episode-2','2026-10-01T00:00:00Z'),
       (new_session,u,src,dev,'series','episode-2','2026-10-01T00:01:00Z');
 if (select health_source_revision from cloud_playback_sessions where id=old_session) <> 7 then
   raise exception 'revision not snapshotted';
 end if;
 r := norva_record_playback_health(u,old_session,'broken','codec URL secret',dev);
 if r#>>'{entry,item_type}' <> 'episode' or r#>>'{entry,item_id}' <> 'episode-2'
   or r#>>'{entry,last_error}' <> 'format' or r#>>'{entry,unavailable}' <> 'false'
   or r::text like '%secret%' then raise exception 'identity/category/privacy failure'; end if;
 begin
   perform norva_record_playback_health(other_u,old_session,'ok');
   raise exception 'foreign owner accepted';
 exception when no_data_found then null; end;
 begin
   perform norva_record_playback_health(u,old_session,'ok','',other_u);
   raise exception 'foreign device accepted';
 exception when no_data_found then null; end;
 if norva_list_playback_health(other_u)->'entries' <> '[]'::jsonb then raise exception 'owner read leak'; end if;
 if norva_list_playback_health(u,src,'series')->'entries' <> '[]'::jsonb then raise exception 'episode poisoned series'; end if;

 -- Real native first-frame event must update the ledger without new client code.
 insert into cloud_playback_events(user_id,device_id,playback_session_id,event_type)
 values(u,dev,new_session,'first_frame');
 r := norva_record_playback_health(u,old_session,'broken','network');
 if r->>'reason' <> 'superseded' then raise exception 'older session won'; end if;
 r := norva_record_playback_health(u,new_session,'broken','late startup failure');
 if r->>'reason' <> 'superseded' then raise exception 'late same-session error won'; end if;
 if norva_list_playback_health(u)#>>'{entries,0,status}' <> 'ok' then raise exception 'recovery lost'; end if;

 update cloud_source_lifecycle set config_revision=8 where source_id=src;
 if norva_list_playback_health(u)->'entries' <> '[]'::jsonb then raise exception 'old configuration exposed'; end if;
 r := norva_record_playback_health(u,new_session,'broken','network');
 if r->>'reason' <> 'source-revision-changed' then raise exception 'old address wrote health'; end if;
 -- A session predating the migration must never borrow the current revision.
 update cloud_playback_sessions set health_source_revision=null where id=new_session;
 r := norva_record_playback_health(u,new_session,'ok');
 if r->>'persisted' <> 'false' then raise exception 'unbound session accepted'; end if;
 if has_function_privilege('authenticated','norva_record_playback_health(uuid,uuid,text,text,uuid)','execute')
   or has_function_privilege('anon','norva_list_playback_health(uuid,uuid,text,uuid)','execute')
   or has_table_privilege('authenticated','cloud_playback_health','select') then raise exception 'direct privilege leak'; end if;
 raise notice 'PASS: revision snapshot, owner/device isolation, exact episode, redaction, native projection, stale session, recovery, source replacement, old client session, SQL privileges';
end;
$$;
