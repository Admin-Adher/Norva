-- Networkless schema-only database; synthetic records, full rollback.
begin;
set local statement_timeout='30s';
set local request.jwt.claim.role='service_role';
create function pg_temp.uid(n int) returns uuid language sql immutable as $$select ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid$$;
create temp table checks(label text primary key);
create function pg_temp.ok(v boolean,label text) returns void language plpgsql as $$
begin if v is distinct from true then raise exception 'fixture_failed: %',label; end if; insert into checks values(label); end $$;
set local session_replication_role=replica;
insert into auth.users(id) values(pg_temp.uid(1));
insert into provider_identities(id) values(pg_temp.uid(31));
insert into cloud_sources(id,user_id,source_type,display_name,sync_status)
 values(pg_temp.uid(11),pg_temp.uid(1),'xtream','Synthetic','ready');
insert into cloud_source_lifecycle(source_id,user_id,replacement_root_id,config_revision,visibility_epoch)
 values(pg_temp.uid(11),pg_temp.uid(1),pg_temp.uid(11),1,1);
insert into cloud_source_catalog_heads(source_id,user_id,active_generation_id,head_revision)
 values(pg_temp.uid(11),pg_temp.uid(1),pg_temp.uid(21),1);
insert into cloud_source_catalog_generations(id,user_id,source_id,config_revision,state)
 values(pg_temp.uid(21),pg_temp.uid(1),pg_temp.uid(11),1,'active');
insert into catalog_source_provider_identities(source_id,user_id,identity_id,provider_key,verified_at)
 values(pg_temp.uid(11),pg_temp.uid(1),pg_temp.uid(31),'synthetic',now());
insert into cloud_titles(id,user_id,item_type,identity_key,identity_source,title)
 values(pg_temp.uid(3),pg_temp.uid(1),'movie','fixture','normalized','Synthetic');
insert into cloud_title_variants(id,user_id,title_id,source_id,generation_id,item_type,external_id,raw_title,codec_profile,
 write_head_revision,write_config_revision,write_source_visibility_epoch,write_user_visibility_epoch)
 select pg_temp.uid(n),pg_temp.uid(1),pg_temp.uid(3),pg_temp.uid(11),pg_temp.uid(21),'movie',n::text,'Synthetic',
 '{"probeSource":"gateway-probe","metadataComplete":true,"container":"mp4","durationSeconds":6000,"fileSizeBytes":1000000,"probedAt":"2026-10-04T00:00:00Z","audioTracks":[{"index":1,"codec":"aac","channels":6,"default":true,"lang":"und"}]}'::jsonb,
 1,1,1,1 from generate_series(101,107)n;
insert into catalog_file_tracks(server_host,item_type,external_id,audio_tracks,audio_probed_at,
 observed_profile_fingerprint,observed_profile_probed_at,observed_profile_snapshot)
 select pg_temp.uid(31)::text,'movie',external_id,'[{"index":1,"codec":"aac","channels":6,"lang":"und"}]',now(),
 repeat('a',64),'2026-10-04T00:00:00Z',vod_language_profile_snapshot(codec_profile)
 from cloud_title_variants;
insert into catalog_file_audio_validation_jobs(id,requested_by,source_id,variant_id,identity_key,item_type,external_id,
 expected_audio_indices,profile_fingerprint,profile_snapshot,profile_probed_at,file_size_bytes,cached_audio_tracks,
 state,error_code,queue_expires_at,retry_at,request_origin,attempt_count,provider_attempt_count,
 strict_lid_window_position,strict_lid_window_count,strict_lid_window_tokens,strict_lid_window_protocol)
 select pg_temp.uid(1000+external_id::int),user_id,source_id,id,pg_temp.uid(31)::text,'movie',external_id,
 array[1],repeat('a',64),vod_language_profile_snapshot(codec_profile),'2026-10-04T00:00:00Z',1000000,
 '[{"index":1,"codec":"aac","channels":6,"lang":"und"}]',
 'failed','LANGUAGE_VALIDATION_STRICT_CONSENSUS_INCONCLUSIVE',null,now()+interval '1 day','automatic',12,7,
 6,6,'["v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb.synthetic1.cccccccccccccccccccccc","v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb.synthetic2.cccccccccccccccccccccc","v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb.synthetic3.cccccccccccccccccccccc","v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb.synthetic4.cccccccccccccccccccccc","v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb.synthetic5.cccccccccccccccccccccc","v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb.synthetic6.cccccccccccccccccccccc"]',1
 from cloud_title_variants;
update catalog_file_audio_validation_jobs set quarantined_at=now() where external_id='102';
update catalog_file_audio_validation_jobs set error_code='LANGUAGE_VALIDATION_GATEWAY_ERROR' where external_id='103';
update catalog_file_audio_validation_jobs set strict_lid_window_position=5,strict_lid_window_tokens='["v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb.synthetic1.cccccccccccccccccccccc","v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb.synthetic2.cccccccccccccccccccccc","v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb.synthetic3.cccccccccccccccccccccc","v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb.synthetic4.cccccccccccccccccccccc","v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb.synthetic5.cccccccccccccccccccccc"]' where external_id='104';
insert into admin_feature_flags(key,enabled) values('adaptive_language_admission_enabled',true)
 on conflict(key) do update set enabled=true;
set local session_replication_role=origin;
create temp table old_jobs as select * from catalog_file_audio_validation_jobs;
-- Fill the real automatic queue using synthetic rows, without mocking guards.
create function pg_temp.backlog(n int, identity_key text, origin text, state text) returns void language plpgsql as $$
begin
 insert into catalog_file_audio_validation_jobs(id,requested_by,source_id,variant_id,identity_key,item_type,external_id,
 expected_audio_indices,profile_fingerprint,profile_snapshot,profile_probed_at,file_size_bytes,cached_audio_tracks,
 state,queue_expires_at,retry_at,request_origin)
 select pg_temp.uid(n),requested_by,source_id,variant_id,$2,item_type,'backlog-'||n,
 expected_audio_indices,profile_fingerprint,profile_snapshot,profile_probed_at,file_size_bytes,cached_audio_tracks,
 $4,null,now(),$3 from old_jobs where id=pg_temp.uid(1101);
end $$;
select pg_temp.backlog(n,'synthetic-other-provider','automatic','retry_wait') from generate_series(2001,2032)n;
select pg_temp.ok(not catalog_language_queue_available(pg_temp.uid(31)::text),'automatic_global_queue_full');
create function pg_temp.start(n int,pass int) returns jsonb language plpgsql as $$
declare v cloud_title_variants%rowtype; c catalog_file_tracks%rowtype;
begin select * into v from cloud_title_variants where id=pg_temp.uid(n);
 select * into c from catalog_file_tracks where server_host=pg_temp.uid(31)::text and external_id=v.external_id;
 return start_resampled_catalog_file_audio_validation_job(v.user_id,v.source_id,v.id,pg_temp.uid(31)::text,
  'movie',v.external_id,array[1],v.codec_profile,repeat('a',64),'2026-10-04T00:00:00Z',1000000,c.audio_tracks,false,pass);
end $$;
select pg_temp.ok(pg_temp.start(101,0)->>'code'='LANGUAGE_RESAMPLING_NOT_ELIGIBLE','zero_pass_rejected');
select pg_temp.ok(pg_temp.start(101,2)->>'code'='LANGUAGE_RESAMPLING_NOT_ELIGIBLE','cannot_skip_pass');
select pg_temp.ok(pg_temp.start(101,7)->>'code'='LANGUAGE_RESAMPLING_NOT_ELIGIBLE','bounded_pass_count');
select pg_temp.ok(pg_temp.start(102,1)->>'busy'='true','quarantine_preserved');
select pg_temp.ok(pg_temp.start(103,1)->>'busy'='true','transport_error_preserved');
select pg_temp.ok(pg_temp.start(104,1)->>'code'='LANGUAGE_RESAMPLING_NOT_ELIGIBLE','incomplete_analysis_not_restarted');
create temp table started as select pg_temp.start(101,1) result;
select pg_temp.ok((select result ? 'jobId' from started),'new_pass_queued');
select pg_temp.ok((select sampling_pass=1 and request_origin='manual' and attempt_count=0 and provider_attempt_count=0
 from catalog_file_audio_validation_jobs where id=(select (result->>'jobId')::uuid from started)),'new_attempt_has_separate_journal');
select pg_temp.ok(pg_temp.start(101,1)->>'code'='LANGUAGE_RESAMPLING_NOT_ELIGIBLE','duplicate_request_cannot_create_second_job');
select pg_temp.ok(not exists(select 1 from old_jobs old join catalog_file_audio_validation_jobs j using(id)
 where to_jsonb(old) is distinct from to_jsonb(j)),'old_receipts_counters_and_retry_dates_intact');
select pg_temp.ok(pg_temp.start(105,1) ? 'jobId','second_manual_request_allowed');
select pg_temp.ok(pg_temp.start(106,1)->>'code'='LANGUAGE_VALIDATION_CONCURRENCY_LIMIT','two_manual_jobs_per_owner');
update catalog_file_audio_validation_jobs set state='failed' where external_id='105' and sampling_pass=1;
select pg_temp.backlog(n,pg_temp.uid(31)::text,'automatic','retry_wait') from generate_series(3001,3003)n;
-- A second owner sharing the provider identity still consumes its queue budget.
set local session_replication_role=replica;
update catalog_file_audio_validation_jobs set requested_by=pg_temp.uid(2) where id=pg_temp.uid(3003);
set local session_replication_role=origin;
select pg_temp.ok(pg_temp.start(106,1)->>'code'='LANGUAGE_AUTOMATIC_QUEUE_FULL','shared_provider_four_job_bound');
delete from catalog_file_audio_validation_jobs where id between pg_temp.uid(3001) and pg_temp.uid(3003);
select pg_temp.ok(not catalog_language_queue_available(pg_temp.uid(31)::text),'automatic_global_bound_unchanged');
update admin_feature_flags set enabled=false where key='adaptive_language_admission_enabled';
select pg_temp.ok(pg_temp.start(106,1)->>'code'='LANGUAGE_AUTOMATIC_ADMISSION_PAUSED','operator_pause_retained');
update admin_feature_flags set enabled=true where key='adaptive_language_admission_enabled';
select pg_temp.backlog(n,'synthetic-other-provider','manual','failed') from generate_series(4001,4018)n;
select pg_temp.ok(pg_temp.start(106,1)->>'code'='LANGUAGE_VALIDATION_RATE_LIMITED','twenty_manual_starts_per_day');
delete from catalog_file_audio_validation_jobs where id between pg_temp.uid(4001) and pg_temp.uid(4018);
select report_catalog_language_capacity(0,'synthetic-busy',clock_timestamp());
select pg_temp.ok(claim_catalog_file_audio_validation_job((select (result->>'jobId')::uuid from started),'synthetic-worker',300) is null,'zero_execution_capacity_blocks_capture');
select report_catalog_language_capacity(2,'capacity-available',clock_timestamp());
create temp table claimed as select claim_catalog_file_audio_validation_job(
 (select (result->>'jobId')::uuid from started),'synthetic-worker',300) result;
select pg_temp.ok((select result->>'samplingPass'='1' and result->>'windowPosition'='0' from claimed),'claim_carries_persisted_sampling_pass');
select pg_temp.ok(claim_catalog_file_audio_validation_job((select (result->>'jobId')::uuid from started),'other-worker',300) is null,'active_lease_not_stolen');
do $test$
declare v cloud_title_variants%rowtype; rejected boolean:=false;
begin
 select * into v from cloud_title_variants where id=pg_temp.uid(107);
 begin
  perform start_resampled_catalog_file_audio_validation_job(pg_temp.uid(2),v.source_id,v.id,pg_temp.uid(31)::text,
   'movie',v.external_id,array[1],v.codec_profile,repeat('a',64),'2026-10-04T00:00:00Z',1000000,
   '[{"index":1,"codec":"aac","channels":6,"lang":"und"}]',false,1);
 exception when sqlstate 'PT409' then rejected:=true; end;
 perform pg_temp.ok(rejected,'foreign_owner_rejected');
end $test$;
select pg_temp.ok(not has_function_privilege('authenticated','start_resampled_catalog_file_audio_validation_job(uuid,uuid,uuid,text,text,text,integer[],jsonb,text,timestamptz,bigint,jsonb,boolean,integer)','EXECUTE'),'authenticated_cannot_resample');
select pg_temp.ok(not has_function_privilege('anon','start_resampled_catalog_file_audio_validation_job(uuid,uuid,uuid,text,text,text,integer[],jsonb,text,timestamptz,bigint,jsonb,boolean,integer)','EXECUTE'),'anonymous_cannot_resample');
select jsonb_build_object('passed',count(*),'checks',jsonb_agg(label order by label)) from checks;
rollback;
