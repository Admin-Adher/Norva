-- Networkless schema-only clone; synthetic rows roll back.
begin;
set local statement_timeout='20s';
set local request.jwt.claim.role='service_role';
create function pg_temp.uid(n int) returns uuid language sql immutable as $$select ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid$$;
create temp table checks(label text primary key);
create function pg_temp.ok(value boolean,label text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'fixture_failed: %',label; end if; insert into checks values(label); end $$;
insert into public.admin_feature_flags(key,enabled) values
 ('owned_provider_language_metadata_enabled',true),('language_metadata_lane_enabled',true),('enrichment_paused',false)
 on conflict(key) do update set enabled=excluded.enabled;
insert into public.catalog_language_metadata_rollout(singleton,basis_points) values(true,10000);
insert into public.catalog_owned_language_metadata_rollout(singleton,basis_points) values(true,10000);
insert into public.catalog_language_metadata_capacity(singleton,max_workers,reason,observed_at,expires_at)
 values(true,1,'capacity-available',now(),now()+interval '10 minutes');
set local session_replication_role=replica;
insert into auth.users(id) values(pg_temp.uid(1)),(pg_temp.uid(9));
insert into public.provider_identities(id) values(pg_temp.uid(4));
insert into public.cloud_sources(id,user_id,source_type,display_name,sync_status) values
 (pg_temp.uid(2),pg_temp.uid(1),'xtream','Synthetic unknown supplier','ready'),
 (pg_temp.uid(7),pg_temp.uid(9),'xtream','Other owner','ready');
insert into public.cloud_source_lifecycle(source_id,user_id,replacement_root_id,config_revision,visibility_epoch)
 values(pg_temp.uid(2),pg_temp.uid(1),pg_temp.uid(2),1,1),(pg_temp.uid(7),pg_temp.uid(9),pg_temp.uid(7),1,1);
insert into public.cloud_source_catalog_heads(source_id,user_id,active_generation_id,head_revision)
 values(pg_temp.uid(2),pg_temp.uid(1),pg_temp.uid(3),1),(pg_temp.uid(7),pg_temp.uid(9),pg_temp.uid(8),1);
insert into public.cloud_source_catalog_generations(id,user_id,source_id,config_revision,state)
 values(pg_temp.uid(3),pg_temp.uid(1),pg_temp.uid(2),1,'active'),(pg_temp.uid(8),pg_temp.uid(9),pg_temp.uid(7),1,'active');
insert into public.catalog_source_provider_identities(source_id,user_id,identity_id,provider_key,verified_at)
 values(pg_temp.uid(2),pg_temp.uid(1),pg_temp.uid(4),'fixture',now()),(pg_temp.uid(7),pg_temp.uid(9),pg_temp.uid(4),'fixture',now());
insert into public.cloud_titles(id,user_id,item_type,identity_key,identity_source,title)
 values(pg_temp.uid(5),pg_temp.uid(1),'movie','fixture','normalized','Synthetic movie'),
 (pg_temp.uid(6),pg_temp.uid(9),'movie','fixture','normalized','Other owner movie');
insert into public.cloud_title_variants(id,user_id,title_id,source_id,generation_id,item_type,external_id,raw_title,
 write_head_revision,write_config_revision,write_source_visibility_epoch,write_user_visibility_epoch)
 select pg_temp.uid(n),pg_temp.uid(1),pg_temp.uid(5),pg_temp.uid(2),pg_temp.uid(3),'movie',n::text,'Synthetic movie',1,1,1,1 from generate_series(101,140) n;
insert into public.cloud_title_variants(id,user_id,title_id,source_id,generation_id,item_type,external_id,raw_title,
 write_head_revision,write_config_revision,write_source_visibility_epoch,write_user_visibility_epoch)
 values(pg_temp.uid(201),pg_temp.uid(9),pg_temp.uid(6),pg_temp.uid(7),pg_temp.uid(8),'movie','102','Other owner movie',1,1,1,1);
insert into public.cloud_catalog_provider_language_hints(variant_id,user_id,title_id,source_id,item_type,language)
 values(pg_temp.uid(101),pg_temp.uid(1),pg_temp.uid(5),pg_temp.uid(2),'movie','fr');
set local session_replication_role=origin;
select pg_temp.ok(not has_table_privilege('authenticated','catalog_provider_audio_metadata_retries','SELECT'),'private_retry_state');
select pg_temp.ok(not has_table_privilege('service_role','catalog_provider_audio_metadata_sweeps','INSERT'),'fenced_sweep_writes');
select pg_temp.ok(not has_function_privilege('authenticated','claim_catalog_provider_audio_metadata(uuid,uuid)','EXECUTE'),'private_claim');
select pg_temp.ok(public.catalog_provider_stream_audio_languages('{"info":{"audio":{"tags":{"language":"tel"}}}}')=array['te'],'telugu_tag');
select pg_temp.ok(public.catalog_provider_stream_audio_languages('{"info":{"audio":{"tags":{"language":"tam"}}}}')=array['ta'],'tamil_tag');
select pg_temp.ok(public.catalog_provider_stream_audio_languages('{"info":{"original_language":"fr","language":"en","subtitles":[{"language":"ar"}]}}')='{}','unrelated_languages_excluded');
do $test$
declare q jsonb; q2 jsonb; v uuid; tok uuid;
begin
 q:=public.claim_catalog_provider_audio_metadata(pg_temp.uid(9),pg_temp.uid(2));
 perform pg_temp.ok(q->>'skipped'='metadata-not-eligible','wrong_owner');
 q:=public.claim_catalog_provider_audio_metadata(pg_temp.uid(1),pg_temp.uid(2));
 perform pg_temp.ok(q->>'itemId'='102','unknown_first_without_supplier_specific_rule');
 v:=(q->>'variantId')::uuid;tok:=(q->>'leaseToken')::uuid;
 q2:=public.claim_catalog_provider_audio_metadata(pg_temp.uid(9),pg_temp.uid(7));
 perform pg_temp.ok(q2->>'skipped'='metadata-capacity','shared_capacity_budget');
 perform pg_temp.ok(not public.finish_catalog_provider_audio_metadata(pg_temp.uid(9),pg_temp.uid(2),v,tok,'identified','test'),'wrong_ack_owner');
 perform pg_temp.ok(not public.finish_catalog_provider_audio_metadata(pg_temp.uid(1),pg_temp.uid(2),v,gen_random_uuid(),'identified','test'),'wrong_ack_token');
 perform pg_temp.ok(public.record_owned_movie_language_declaration(pg_temp.uid(1),pg_temp.uid(2),pg_temp.uid(3),1,1,1,1,v,'102',pg_temp.uid(4),
  '{"movie_data":{"stream_id":"102"},"info":{"audio":{"tags":{"language":"tel"}}}}')=1,'real_fenced_declaration_writer');
 perform pg_temp.ok(public.finish_catalog_provider_audio_metadata(pg_temp.uid(1),pg_temp.uid(2),v,tok,'identified','declared-track-languages'),'ack_identified');
 perform pg_temp.ok(not public.finish_catalog_provider_audio_metadata(pg_temp.uid(1),pg_temp.uid(2),v,tok,'identified','test'),'duplicate_ack');
 perform pg_temp.ok(public.catalog_movie_audio_identified(pg_temp.uid(1),pg_temp.uid(2),v),'effective_projection');
 perform pg_temp.ok(not public.catalog_movie_audio_identified(pg_temp.uid(9),pg_temp.uid(7),pg_temp.uid(201)),'no_cross_owner_leak');
 q:=public.claim_catalog_provider_audio_metadata(pg_temp.uid(1),pg_temp.uid(2));
 perform pg_temp.ok(q->>'itemId'='103','cursor_progression');
 v:=(q->>'variantId')::uuid;tok:=(q->>'leaseToken')::uuid;
 perform public.record_owned_movie_language_declaration(pg_temp.uid(1),pg_temp.uid(2),pg_temp.uid(3),1,1,1,1,v,'103',pg_temp.uid(4),'{"info":{"audio":{"tags":{"language":"und"}}}}');
 perform public.finish_catalog_provider_audio_metadata(pg_temp.uid(1),pg_temp.uid(2),v,tok,'inconclusive','metadata-no-language');
 q:=public.claim_catalog_provider_audio_metadata(pg_temp.uid(1),pg_temp.uid(2));
 perform pg_temp.ok(q->>'itemId'='104','empty_metadata_does_not_block_next_file');
 v:=(q->>'variantId')::uuid;tok:=(q->>'leaseToken')::uuid;
 perform public.finish_catalog_provider_audio_metadata(pg_temp.uid(1),pg_temp.uid(2),v,tok,'failed','metadata-timeout',true);
 perform pg_temp.ok((select attempts=1 and lease_until>now() and next_attempt_at>=now()+interval '1 hour' from public.catalog_provider_audio_metadata_retries where variant_id=v),'timeout_retains_exclusion_and_backoff');
 q:=public.claim_catalog_provider_audio_metadata(pg_temp.uid(1),pg_temp.uid(2));
 perform pg_temp.ok(q->>'skipped'='metadata-capacity','uncertain_transport_stops_followup');
 update public.catalog_provider_audio_metadata_retries set lease_until=now()-interval '1 second' where variant_id=v;
 q:=public.claim_catalog_provider_audio_metadata(pg_temp.uid(1),pg_temp.uid(2));
 perform pg_temp.ok(q->>'itemId'='105','failed_file_does_not_pin_cursor');
 perform public.finish_catalog_provider_audio_metadata(pg_temp.uid(1),pg_temp.uid(2),(q->>'variantId')::uuid,(q->>'leaseToken')::uuid,'deferred','live-session');
 perform pg_temp.ok((select attempts=0 and lease_until is null from public.catalog_provider_audio_metadata_retries where variant_id=pg_temp.uid(105)),'viewer_preemption_not_failure');
 update public.catalog_provider_audio_metadata_sweeps set next_scan_at=now()+interval '6 hours' where source_id=pg_temp.uid(2);
 update public.cloud_source_lifecycle set config_revision=2 where source_id=pg_temp.uid(2);
 q:=public.claim_catalog_provider_audio_metadata(pg_temp.uid(1),pg_temp.uid(2));
 perform pg_temp.ok(q->>'itemId'='102','credential_change_invalidates_old_declaration_and_wakes_sweep');
 perform public.finish_catalog_provider_audio_metadata(pg_temp.uid(1),pg_temp.uid(2),(q->>'variantId')::uuid,(q->>'leaseToken')::uuid,'deferred','source-changed');
 update public.admin_feature_flags set enabled=true where key='enrichment_paused';
 q:=public.claim_catalog_provider_audio_metadata(pg_temp.uid(1),pg_temp.uid(2));
 perform pg_temp.ok(q->>'skipped'='metadata-not-eligible','global_pause_preserved');
end $test$;
-- A page containing only known files must yield and persist its cursor, then
-- claim the first unknown file on the next page without gaps or a false EOF.
update public.admin_feature_flags set enabled=false where key='enrichment_paused';
insert into public.cloud_catalog_provider_language_hints(variant_id,user_id,title_id,source_id,item_type,language)
 select pg_temp.uid(n),pg_temp.uid(1),pg_temp.uid(5),pg_temp.uid(2),'movie','fr' from generate_series(102,132) n;
update public.catalog_provider_audio_metadata_sweeps set after_variant_id=null,next_scan_at=now() where source_id=pg_temp.uid(2);
do $test$
declare q jsonb;
begin
 q:=public.claim_catalog_provider_audio_metadata(pg_temp.uid(1),pg_temp.uid(2));
 perform pg_temp.ok(q->>'scanned'='32' and q->>'hasMore'='true' and not(q ? 'variantId'),'bounded_known_page_yields');
 perform pg_temp.ok((select after_variant_id=pg_temp.uid(132) from public.catalog_provider_audio_metadata_sweeps where source_id=pg_temp.uid(2)),'known_page_cursor_persisted');
 q:=public.claim_catalog_provider_audio_metadata(pg_temp.uid(1),pg_temp.uid(2));
 perform pg_temp.ok(q->>'itemId'='133','next_page_unknown_not_skipped');
 perform public.finish_catalog_provider_audio_metadata(pg_temp.uid(1),pg_temp.uid(2),(q->>'variantId')::uuid,(q->>'leaseToken')::uuid,'deferred','live-session');
end $test$;
insert into public.catalog_enrichment_source_schedule(source_id,user_id,dispatch_count,claim_token,lease_until,cycle_had_work,provider_overview_cursor)
 values(pg_temp.uid(2),pg_temp.uid(1),22,pg_temp.uid(301),now()+interval '10 minutes',true,'keep-me');
select pg_temp.ok(public.finish_catalog_enrichment_source(pg_temp.uid(2),pg_temp.uid(301),true,30,true,
 '{"mode":"provider-audio-metadata","fleetRotationProtocol":2,"processed":1}'),'metadata_rotation_ack');
select pg_temp.ok((select dispatch_count=23 and cycle_had_work and provider_overview_cursor='keep-me'
 from public.catalog_enrichment_source_schedule where source_id=pg_temp.uid(2)),'metadata_does_not_reset_legacy_cycle_or_overview_cursor');
update public.catalog_enrichment_source_schedule set claim_token=pg_temp.uid(302),lease_until=now()+interval '10 minutes' where source_id=pg_temp.uid(2);
select pg_temp.ok(public.finish_catalog_enrichment_source(pg_temp.uid(2),pg_temp.uid(302),true,21600,true,
 '{"mode":"provider-overview","fleetRotationProtocol":2,"processed":0,"hasMore":false}'),'last_legacy_rotation_ack');
select pg_temp.ok((select dispatch_count=24 and not cycle_had_work and next_run_at<now()+interval '1 minute'
 from public.catalog_enrichment_source_schedule where source_id=pg_temp.uid(2)),'metadata_work_prevents_six_hour_whole_source_sleep');
select jsonb_build_object('passed',true,'checks',count(*),'productionRows',0,'providerRequests',0) from checks;
rollback;
