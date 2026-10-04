-- Run only in the networkless schema-only proof container; no customer rows.
begin;
set local statement_timeout='30s';
set local request.jwt.claim.role='service_role';
create function pg_temp.uid(n int) returns uuid language sql immutable as $$select ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid$$;
create temp table checks(label text primary key);
create function pg_temp.ok(v boolean,label text) returns void language plpgsql as $$
begin if v is distinct from true then raise exception 'fixture_failed: %',label; end if; insert into checks values(label); end $$;
set local session_replication_role=replica;
insert into auth.users(id) select pg_temp.uid(n) from generate_series(1,3)n;
insert into provider_identities(id) values(pg_temp.uid(31));
insert into cloud_sources(id,user_id,source_type,display_name,sync_status)
 select pg_temp.uid(10+n),pg_temp.uid(n),'xtream','Synthetic source','ready' from generate_series(1,2)n;
insert into cloud_source_lifecycle(source_id,user_id,replacement_root_id,config_revision,visibility_epoch)
 select pg_temp.uid(10+n),pg_temp.uid(n),pg_temp.uid(10+n),1,1 from generate_series(1,2)n;
insert into cloud_source_catalog_heads(source_id,user_id,active_generation_id,head_revision)
 select pg_temp.uid(10+n),pg_temp.uid(n),pg_temp.uid(20+n),1 from generate_series(1,2)n;
insert into cloud_source_catalog_generations(id,user_id,source_id,config_revision,state)
 select pg_temp.uid(20+n),pg_temp.uid(n),pg_temp.uid(10+n),1,'active' from generate_series(1,2)n;
insert into catalog_source_provider_identities(source_id,user_id,identity_id,provider_key,verified_at)
 select pg_temp.uid(10+n),pg_temp.uid(n),pg_temp.uid(31),'synthetic',now() from generate_series(1,2)n;
insert into cloud_titles(id,user_id,item_type,identity_key,identity_source,title)
 select pg_temp.uid(1000+n),pg_temp.uid(1),'movie','synthetic-'||n,'normalized','Synthetic movie' from generate_series(1,5)n;
insert into cloud_title_variants(id,user_id,title_id,source_id,generation_id,item_type,external_id,raw_title,
 write_head_revision,write_config_revision,write_source_visibility_epoch,write_user_visibility_epoch)
 select pg_temp.uid(100+n),pg_temp.uid(1),pg_temp.uid(1000+n),pg_temp.uid(11),pg_temp.uid(21),'movie',(100+n)::text,'Synthetic movie',1,1,1,1 from generate_series(1,5)n;
insert into cloud_titles(id,user_id,item_type,identity_key,identity_source,title)
 values(pg_temp.uid(2001),pg_temp.uid(2),'movie','other','normalized','Other owner');
insert into cloud_title_variants(id,user_id,title_id,source_id,generation_id,item_type,external_id,raw_title)
 values(pg_temp.uid(201),pg_temp.uid(2),pg_temp.uid(2001),pg_temp.uid(12),pg_temp.uid(22),'movie','201','Other owner');
insert into admin_feature_flags(key,enabled) values('automatic_vod_language_fleet_enabled',true),('audio_lid_enabled',true),('adaptive_language_admission_enabled',true),('owned_provider_language_metadata_enabled',true)
 on conflict(key) do update set enabled=excluded.enabled;
set local session_replication_role=origin;

select pg_temp.ok((select count(*)=2 from list_catalog_language_campaign_sources(null,128)),'all_visible_owners_discovered');
select pg_temp.ok((select count(*)=1 from list_catalog_language_campaign_sources(pg_temp.uid(11),1)),'keyset_pagination');
update auth.users set banned_until=now()+interval '1 day' where id=pg_temp.uid(2);
select pg_temp.ok((select count(*)=1 from list_catalog_language_campaign_sources(null,128)),'banned_owner_excluded');
update auth.users set banned_until=null where id=pg_temp.uid(2);
update cloud_sources set enabled=false where id=pg_temp.uid(12);
select pg_temp.ok((select count(*)=1 from list_catalog_language_campaign_sources(null,128)),'disabled_source_excluded');
update cloud_sources set enabled=true where id=pg_temp.uid(12);
set local session_replication_role=replica;
insert into cloud_sources(id,user_id,source_type,display_name,sync_status) values(pg_temp.uid(13),pg_temp.uid(3),'m3u','Future owner','ready');
insert into cloud_source_lifecycle(source_id,user_id,replacement_root_id,config_revision,visibility_epoch) values(pg_temp.uid(13),pg_temp.uid(3),pg_temp.uid(13),1,1);
insert into cloud_source_catalog_heads(source_id,user_id,active_generation_id,head_revision) values(pg_temp.uid(13),pg_temp.uid(3),pg_temp.uid(23),1);
insert into cloud_source_catalog_generations(id,user_id,source_id,config_revision,state) values(pg_temp.uid(23),pg_temp.uid(3),pg_temp.uid(13),1,'active');
set local session_replication_role=origin;
select pg_temp.ok((select count(*)=3 from list_catalog_language_campaign_sources(null,128)),'future_import_discovered_without_configuration');
select pg_temp.ok(not has_function_privilege('authenticated','list_catalog_language_campaign_sources(uuid,integer)','EXECUTE'),'discovery_service_only');
select pg_temp.ok(not has_function_privilege('authenticated','record_catalog_featured_language_titles(uuid,uuid[])','EXECUTE'),'priority_write_service_only');
select pg_temp.ok(not has_table_privilege('authenticated','catalog_featured_language_titles','SELECT'),'priority_owner_data_not_public');
select pg_temp.ok(record_catalog_featured_language_titles(pg_temp.uid(1),array[pg_temp.uid(1002),pg_temp.uid(1001),pg_temp.uid(2001)])=2,'foreign_owner_title_rejected');
select pg_temp.ok(catalog_featured_language_rank(pg_temp.uid(1),pg_temp.uid(1002))=1,'display_order_preserved');
select pg_temp.ok(catalog_featured_language_rank(pg_temp.uid(2),pg_temp.uid(1002))=2147483647,'priority_is_owner_scoped');
select pg_temp.ok(record_catalog_featured_language_titles(pg_temp.uid(1),array[pg_temp.uid(1001),pg_temp.uid(1002)])=0,'repeat_browsing_does_not_rewrite_rows');
update catalog_featured_language_titles set expires_at=now()-interval '1 second' where title_id=pg_temp.uid(1001);
select pg_temp.ok(catalog_featured_language_rank(pg_temp.uid(1),pg_temp.uid(1001))=2147483647,'expired_priority_ignored');

-- Isolate ordering from live capacity in this transaction only. All real lease,
-- retry, unknown-language and prior strict-result predicates remain executed.
create or replace function catalog_language_execution_available() returns boolean language sql as $$select true$$;
create or replace function catalog_language_queue_available(p_identity_key text) returns boolean language sql as $$select true$$;
create or replace function catalog_language_metadata_available_for_source(p_user uuid,p_source uuid) returns boolean language sql as $$select true$$;
insert into catalog_language_metadata_capacity(singleton,max_workers,reason,observed_at,expires_at) values(true,2,'capacity-available',now(),now()+interval '1 hour') on conflict(singleton) do update set max_workers=2,expires_at=excluded.expires_at;
insert into catalog_vod_language_sweeps(source_id,user_id,generation_id,after_variant_id,unknown_after_variant_id)
 values(pg_temp.uid(11),pg_temp.uid(1),pg_temp.uid(21),pg_temp.uid(104),pg_temp.uid(104));
do $test$
declare q jsonb;before_cursor uuid;
begin
 select unknown_after_variant_id into before_cursor from catalog_vod_language_sweeps where source_id=pg_temp.uid(11);
 q:=claim_catalog_vod_language_file(pg_temp.uid(1),pg_temp.uid(11));
 perform pg_temp.ok(q->>'variantId'=pg_temp.uid(102)::text,'featured_file_before_existing_cursor_selected');
 perform pg_temp.ok((select unknown_after_variant_id=before_cursor from catalog_vod_language_sweeps where source_id=pg_temp.uid(11)),'featured_selection_does_not_advance_regular_cursor');
 perform pg_temp.ok(claim_catalog_vod_language_file(pg_temp.uid(1),pg_temp.uid(11))->>'skipped'='intake-busy','featured_cannot_overlap_source_intake');
 perform finish_catalog_vod_language_file(pg_temp.uid(1),pg_temp.uid(11),pg_temp.uid(102),(q->>'leaseToken')::uuid,'deferred','provider-account-busy',false);
 q:=claim_catalog_vod_language_file(pg_temp.uid(1),pg_temp.uid(11));
 perform pg_temp.ok(q->>'variantId' is distinct from pg_temp.uid(102)::text,'featured_future_retry_not_forced');
 if q ? 'variantId' then perform finish_catalog_vod_language_file(pg_temp.uid(1),pg_temp.uid(11),(q->>'variantId')::uuid,(q->>'leaseToken')::uuid,'unsupported','fixture',false); end if;
 q:=claim_catalog_provider_audio_metadata(pg_temp.uid(1),pg_temp.uid(11));
 perform pg_temp.ok(q->>'variantId'=pg_temp.uid(102)::text,'featured_metadata_first');
 perform pg_temp.ok(claim_catalog_provider_audio_metadata(pg_temp.uid(1),pg_temp.uid(11))->>'skipped'='metadata-capacity','metadata_lease_excludes_second_call');
end $test$;

-- Actual production account lease: independent Norva owners cannot acquire a
-- second holder for the same provider account. Playback has priority.
select pg_temp.ok(claim_provider_account_language_validation(repeat('a',64),'first-owner',180),'first_provider_lease');
select pg_temp.ok(not claim_provider_account_language_validation(repeat('a',64),'second-owner',180),'shared_provider_account_single_connection');
select pg_temp.ok(not release_provider_account_language_validation(repeat('a',64),'wrong-owner'),'other_lease_cannot_be_released');
set local session_replication_role=replica;
insert into cloud_playback_sessions(id,user_id,source_id,item_type,item_id,provider_account_hash,status,expires_at)
 values(pg_temp.uid(7001),pg_temp.uid(2),pg_temp.uid(12),'movie','201',repeat('b',64),'pending',now()+interval '10 minutes');
set local session_replication_role=origin;
select pg_temp.ok(not claim_provider_account_language_validation(repeat('b',64),'featured-background',180),'viewer_blocks_featured_background');

-- Series priority applies to their actual owned episode files, not a guessed
-- language assigned to every episode from a series-level label.
set local session_replication_role=replica;
insert into cloud_titles(id,user_id,item_type,identity_key,identity_source,title)
 select pg_temp.uid(3000+n),pg_temp.uid(1),'series','series-'||n,'normalized','Synthetic series' from generate_series(1,2)n;
insert into cloud_title_variants(id,user_id,title_id,source_id,generation_id,item_type,external_id,raw_title)
 select pg_temp.uid(300+n),pg_temp.uid(1),pg_temp.uid(3000+n),pg_temp.uid(11),pg_temp.uid(21),'series',(300+n)::text,'Synthetic series' from generate_series(1,2)n;
insert into catalog_series_episode_memberships(user_id,source_id,provider_identity_id,parent_title_id,parent_variant_id,parent_series_id,episode_id,payload_fingerprint,generation_id)
 select pg_temp.uid(1),pg_temp.uid(11),pg_temp.uid(31),pg_temp.uid(3000+n),pg_temp.uid(300+n),(300+n)::text,(400+n)::text,repeat('a',32),pg_temp.uid(21) from generate_series(1,2)n;
set local session_replication_role=origin;
select pg_temp.ok(record_catalog_featured_language_titles(pg_temp.uid(1),array[pg_temp.uid(3002)])=1,'featured_series_recorded');
select pg_temp.ok((select parent_series_id='302' from catalog_series_inventory_candidates(pg_temp.uid(1),pg_temp.uid(11),1)),'featured_series_inventory_first');
select pg_temp.ok((select episode_id='402' from catalog_episode_probe_candidates(pg_temp.uid(1),pg_temp.uid(11),1)),'featured_episode_probe_first');
insert into catalog_file_tracks(server_host,item_type,external_id,audio_tracks,audio_probed_at)
 select pg_temp.uid(31)::text,'episode',(400+n)::text,'[{"index":0,"lang":null}]',now() from generate_series(1,2)n;
select pg_temp.ok((select episode_id='402' from catalog_episode_lid_candidates(pg_temp.uid(1),pg_temp.uid(11),1)),'featured_episode_lid_first');
update catalog_file_tracks set audio_whisper_retry_at=now()+interval '1 day' where external_id='402';
select pg_temp.ok((select episode_id='401' from catalog_episode_lid_candidates(pg_temp.uid(1),pg_temp.uid(11),1)),'featured_episode_future_retry_preserved');

-- Featured strict captures precede ordinary captures, after manual requests
-- and complete receipt finalizers. Priority never overrides eligibility.
set local session_replication_role=replica;
insert into catalog_file_audio_validation_jobs(id,requested_by,source_id,variant_id,identity_key,item_type,external_id,
 expected_audio_indices,profile_fingerprint,profile_snapshot,profile_probed_at,file_size_bytes,cached_audio_tracks,
 state,queue_expires_at,retry_at,request_origin,created_at,purge_after)
 select pg_temp.uid(8000+n),pg_temp.uid(1),pg_temp.uid(11),pg_temp.uid(100+n),'lane-'||n,'movie',(100+n)::text,
 array[0],repeat('a',64),'{}',now(),1000000,'[{"index":0,"lang":null}]',
 'retry_wait',null,now()-interval '2 hours','automatic',now()-interval '3 hours',now()+interval '1 day'
 from generate_series(1,3)n;
set local session_replication_role=origin;
select pg_temp.ok((select job_id=pg_temp.uid(8002) from list_due_catalog_file_audio_validation_jobs(1)),'featured_strict_capture_first');
update catalog_file_audio_validation_jobs set request_origin='manual' where id=pg_temp.uid(8003);
select pg_temp.ok((select job_id=pg_temp.uid(8003) from list_due_catalog_file_audio_validation_jobs(1)),'manual_precedes_featured_capture');
update catalog_file_audio_validation_jobs set request_origin='automatic',state='failed',quarantined_at=now() where id=pg_temp.uid(8003);
update catalog_file_audio_validation_jobs set state='running',retry_at=null,lease_owner='expired',lease_expires_at=now()-interval '1 minute',
 strict_lid_window_count=4,strict_lid_window_position=4,strict_lid_window_protocol=1,
 strict_lid_window_tokens=(select jsonb_agg('v1.'||repeat('a',16)||'.'||repeat('b',16)||'.'||i::text||'.'||repeat('c',22)) from generate_series(1,4)i) where id=pg_temp.uid(8001);
select pg_temp.ok((select job_id=pg_temp.uid(8001) from list_due_catalog_file_audio_validation_jobs(1)),'completed_receipts_precede_featured_capture');
update catalog_file_audio_validation_jobs set retry_at=now()+interval '1 hour' where id=pg_temp.uid(8002);
select pg_temp.ok(not exists(select 1 from list_due_catalog_file_audio_validation_jobs(4) where job_id=pg_temp.uid(8002)),'featured_strict_future_retry_preserved');
update catalog_file_audio_validation_jobs set state='failed',retry_at=null,quarantined_at=now() where id=pg_temp.uid(8002);
select pg_temp.ok(not exists(select 1 from list_due_catalog_file_audio_validation_jobs(4) where job_id=pg_temp.uid(8002)),'featured_strict_quarantine_preserved');

-- Shared Selection cards have virtual ids and reuse the public exact-file job.
set local session_replication_role=replica;
insert into selection_shared_releases(id,revision,manifest_sha256,published_at) values(pg_temp.uid(51),repeat('a',64),repeat('b',64),now());
insert into selection_shared_enrollments(source_id,user_id,generation_id,config_revision,release_id) values(pg_temp.uid(13),pg_temp.uid(3),pg_temp.uid(23),1,pg_temp.uid(51));
insert into selection_shared_titles(release_id,item_type,identity_key,title) values(pg_temp.uid(51),'movie','public-fixture','Public fixture');
insert into selection_shared_variants(release_id,item_type,external_id,identity_key,playback_hint)
 values(pg_temp.uid(51),'movie','norva-selection:movie:'||repeat('c',64),'public-fixture','{"targetUrl":"https://example.invalid/public-fixture.mp4"}');
insert into selection_shared_media(release_id,item_type,external_id,available,playback_hint)
 values(pg_temp.uid(51),'movie','norva-selection:movie:'||repeat('c',64),true,'{"targetUrl":"https://example.invalid/public-fixture.mp4"}');
insert into catalog_selection_audio_jobs(external_id,url_sha256,priority,state,next_attempt_at,attempt_count)
 values('norva-selection:movie:'||repeat('c',64),encode(sha256(convert_to('https://example.invalid/public-fixture.mp4','UTF8')),'hex'),1,'retry_wait',now()+interval '1 day',4);
set local session_replication_role=origin;
select pg_temp.ok(record_catalog_featured_language_titles(pg_temp.uid(3),array[norva_selection_shared_uuid('title:'||pg_temp.uid(3)::text||':movie:public-fixture')])=1,'shared_virtual_title_accepted');
select pg_temp.ok((select priority=1000 and state='retry_wait' and next_attempt_at=now()+interval '1 day' and attempt_count=4 from catalog_selection_audio_jobs where external_id='norva-selection:movie:'||repeat('c',64)),'shared_public_file_priority_preserves_delays_and_attempts');
select pg_temp.ok(record_catalog_featured_language_titles(pg_temp.uid(1),array[norva_selection_shared_uuid('title:'||pg_temp.uid(3)::text||':movie:public-fixture')])=0,'foreign_shared_title_rejected');
update cloud_sources set enabled=false where id=pg_temp.uid(13);
select pg_temp.ok(record_catalog_featured_language_titles(pg_temp.uid(3),array[norva_selection_shared_uuid('title:'||pg_temp.uid(3)::text||':movie:public-fixture')])=0,'hidden_shared_source_cannot_refresh_priority');
select jsonb_build_object('assertions',count(*),'labels',jsonb_agg(label order by label)) from checks;
rollback;
