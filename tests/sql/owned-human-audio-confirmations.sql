-- Run after the migration in a schema-only database with network disabled.
-- All rows are synthetic; no provider connection, customer copy or LID work.
begin;
set local statement_timeout='30s';
set local request.jwt.claim.role='service_role';
create function pg_temp.uid(n int) returns uuid language sql immutable as $$select ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid$$;
create temp table checks(label text primary key);
create function pg_temp.ok(value boolean,label text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'fixture_failed: %',label; end if; insert into checks values(label); end $$;
create function pg_temp.reject(query text,code text,label text) returns void language plpgsql as $$
declare actual text;
begin begin execute query; exception when others then get stacked diagnostics actual=returned_sqlstate; end;
if actual is distinct from code then raise exception 'fixture_failed: %, expected %, got %',label,code,actual; end if;
perform pg_temp.ok(true,label); end $$;
set local session_replication_role=replica;
insert into auth.users(id) values(pg_temp.uid(1)),(pg_temp.uid(2));
insert into provider_identities(id) values(pg_temp.uid(31)),(pg_temp.uid(32));
insert into cloud_sources(id,user_id,source_type,display_name,sync_status)
values(pg_temp.uid(11),pg_temp.uid(1),'xtream','Synthetic owner A','ready'),
      (pg_temp.uid(12),pg_temp.uid(2),'xtream','Synthetic owner B','ready');
insert into cloud_source_lifecycle(source_id,user_id,replacement_root_id,config_revision,visibility_epoch)
select id,user_id,id,1,1 from cloud_sources;
insert into cloud_source_catalog_heads(source_id,user_id,active_generation_id,head_revision)
select id,user_id,case when user_id=pg_temp.uid(1) then pg_temp.uid(21) else pg_temp.uid(22) end,1 from cloud_sources;
insert into cloud_source_catalog_generations(id,user_id,source_id,config_revision,state)
select active_generation_id,user_id,source_id,1,'active' from cloud_source_catalog_heads;
insert into cloud_user_catalog_visibility_epochs(user_id,visibility_epoch) values(pg_temp.uid(1),1),(pg_temp.uid(2),1);
insert into catalog_source_provider_identities(source_id,user_id,identity_id,provider_key,verified_at)
select id,user_id,pg_temp.uid(31),'synthetic',now() from cloud_sources;
insert into cloud_titles(id,user_id,item_type,identity_key,identity_source,title)
values(pg_temp.uid(51),pg_temp.uid(1),'movie','fixture','normalized','Synthetic movie'),
      (pg_temp.uid(52),pg_temp.uid(2),'movie','fixture','normalized','Synthetic movie');
insert into cloud_title_variants(id,user_id,title_id,source_id,generation_id,item_type,external_id,raw_title,codec_profile,
write_head_revision,write_config_revision,write_source_visibility_epoch,write_user_visibility_epoch)
select pg_temp.uid(n),pg_temp.uid(1),pg_temp.uid(51),pg_temp.uid(11),pg_temp.uid(21),'movie',n::text,'Synthetic EN| [SUB]',
'{"probeSource":"gateway-inband","metadataComplete":false,"container":"mkv","durationSeconds":6000,"fileSizeBytes":1000000,"probedAt":"2026-10-04T17:00:00Z","audioTracks":[{"index":1,"codec":"aac","channels":6,"default":true,"lang":"und"}]}'::jsonb,
1,1,1,1 from generate_series(101,102)n;
insert into cloud_title_variants(id,user_id,title_id,source_id,generation_id,item_type,external_id,raw_title,codec_profile,
write_head_revision,write_config_revision,write_source_visibility_epoch,write_user_visibility_epoch)
select pg_temp.uid(201),pg_temp.uid(2),pg_temp.uid(52),pg_temp.uid(12),pg_temp.uid(22),'movie','101','Same provider file',codec_profile,
1,1,1,1 from cloud_title_variants where id=pg_temp.uid(101);
set local session_replication_role=origin;
create temp table original_variants as select * from cloud_title_variants;
create temp table original_jobs as select * from catalog_file_audio_validation_jobs;
create temp table original_observations as select * from cloud_title_file_language_observations;
create temp table original_declarations as select * from catalog_owned_language_declarations;
create function pg_temp.confirm(lang text,ref text,track int default 1) returns uuid language sql as $$
select record_owned_movie_human_audio_confirmation(pg_temp.uid(1),pg_temp.uid(11),pg_temp.uid(21),1,1,1,1,
 pg_temp.uid(101),'101',pg_temp.uid(31),vod_language_profile_snapshot(codec_profile),track,lang,ref)
 from cloud_title_variants where id=pg_temp.uid(101) $$;
create function pg_temp.read_confirmation() returns setof jsonb language sql as $$
select to_jsonb(t) from cloud_catalog_owned_movie_human_audio_confirmations_batch(pg_temp.uid(1),pg_temp.uid(11),array[pg_temp.uid(101)])t $$;
create temp table confirmation as select pg_temp.confirm('es','codex:test:innocent-voices-es') id;
select pg_temp.ok((select id is not null from confirmation),'incomplete_lid_profile_accepts_actual_heard_track');
select pg_temp.ok(pg_temp.confirm('es','codex:test:innocent-voices-es')=(select id from confirmation),'same_evidence_idempotent');
select pg_temp.ok((select count(*)=1 from catalog_owned_human_audio_confirmations),'idempotent_no_duplicate');
select pg_temp.ok((select value->>'language'='es' and value->>'method'='owner-listening-v1' and value->>'track_index'='1'
 from pg_temp.read_confirmation() t(value)),'explicit_human_provenance');
select pg_temp.ok(not exists(select * from cloud_catalog_owned_movie_human_audio_confirmations_batch(pg_temp.uid(2),pg_temp.uid(11),array[pg_temp.uid(101)])),'foreign_owner_cannot_read');
select pg_temp.ok(not exists(select * from cloud_catalog_owned_movie_human_audio_confirmations_batch(pg_temp.uid(1),pg_temp.uid(12),array[pg_temp.uid(101)])),'foreign_source_cannot_read');
select pg_temp.ok(not exists(select * from cloud_catalog_owned_movie_human_audio_confirmations_batch(pg_temp.uid(2),pg_temp.uid(12),array[pg_temp.uid(201)])),'same_provider_file_other_owner_not_promoted');
select pg_temp.ok(not exists(select * from cloud_catalog_owned_movie_human_audio_confirmations_batch(pg_temp.uid(1),pg_temp.uid(11),array[pg_temp.uid(102)])),'same_title_other_copy_not_promoted');
select pg_temp.ok((select count(*)=1 from cloud_catalog_owned_movie_human_audio_confirmations_batch(pg_temp.uid(1),pg_temp.uid(11),array[pg_temp.uid(101),null,pg_temp.uid(101)])),'duplicate_null_requests_bounded');
select pg_temp.ok(not exists(select * from cloud_catalog_owned_movie_human_audio_confirmations_batch(null,pg_temp.uid(11),array[pg_temp.uid(101)])),'null_owner_closed');
select pg_temp.ok(not exists(select * from cloud_catalog_owned_movie_human_audio_confirmations_batch(pg_temp.uid(1),null,array[pg_temp.uid(101)])),'null_source_closed');
select pg_temp.ok(not exists(select * from cloud_catalog_owned_movie_human_audio_confirmations_batch(pg_temp.uid(1),pg_temp.uid(11),null)),'null_variants_closed');
select pg_temp.ok(not exists(select * from cloud_catalog_owned_movie_human_audio_confirmations_batch(pg_temp.uid(1),pg_temp.uid(11),'{}')),'empty_variants_closed');
select pg_temp.reject($q$select * from cloud_catalog_owned_movie_human_audio_confirmations_batch(pg_temp.uid(1),pg_temp.uid(11),array_fill(pg_temp.uid(101),array[201]))$q$,'22023','oversize_batch_rejected');
select pg_temp.reject($q$select pg_temp.confirm('en','codex:test:innocent-voices-es')$q$,'PT409','same_reference_cannot_change_language');
select pg_temp.reject($q$select pg_temp.confirm('und','codex:test:invalid')$q$,'22023','unknown_language_rejected');
select pg_temp.reject($q$select pg_temp.confirm('zz','codex:test:invalid')$q$,'22023','unsupported_language_rejected');
select pg_temp.reject($q$select pg_temp.confirm('xx','codex:test:invalid')$q$,'22023','xx_language_rejected');
select pg_temp.reject($q$select pg_temp.confirm('un','codex:test:invalid')$q$,'22023','un_language_rejected');
select pg_temp.reject($q$select pg_temp.confirm('EN','codex:test:invalid')$q$,'22023','noncanonical_language_rejected');
select pg_temp.reject($q$select pg_temp.confirm(null,'codex:test:invalid')$q$,'22023','null_language_rejected');
select pg_temp.reject($q$select pg_temp.confirm('en','https://provider/private')$q$,'22023','unsafe_evidence_reference_rejected');
select pg_temp.reject($q$select pg_temp.confirm('en','codex:test:wrong-track',2)$q$,'PT409','absent_audio_track_rejected');
select pg_temp.reject($q$select record_owned_movie_human_audio_confirmation(pg_temp.uid(1),pg_temp.uid(11),pg_temp.uid(21),1,1,1,1,pg_temp.uid(101),'wrong-file',pg_temp.uid(31),vod_language_profile_snapshot(codec_profile),1,'en','codex:test:wrong-file') from cloud_title_variants where id=pg_temp.uid(101)$q$,'PT409','external_file_fence');
select pg_temp.reject($q$select record_owned_movie_human_audio_confirmation(pg_temp.uid(1),pg_temp.uid(11),pg_temp.uid(21),1,1,1,1,pg_temp.uid(101),'101',pg_temp.uid(32),vod_language_profile_snapshot(codec_profile),1,'en','codex:test:wrong-provider') from cloud_title_variants where id=pg_temp.uid(101)$q$,'PT409','provider_identity_fence');
select pg_temp.reject($q$select record_owned_movie_human_audio_confirmation(pg_temp.uid(1),pg_temp.uid(11),pg_temp.uid(21),1,1,1,1,pg_temp.uid(101),'101',pg_temp.uid(31),'{}',1,'en','codex:test:wrong-profile')$q$,'PT409','submitted_profile_fence');
select pg_temp.reject($q$select record_owned_movie_human_audio_confirmation(pg_temp.uid(2),pg_temp.uid(11),pg_temp.uid(21),1,1,1,1,pg_temp.uid(101),'101',pg_temp.uid(31),'{}',1,'en','codex:test:wrong-owner')$q$,'PT409','writer_owner_cas');
select pg_temp.reject($q$select record_owned_movie_human_audio_confirmation(pg_temp.uid(1),pg_temp.uid(11),pg_temp.uid(21),2,1,1,1,pg_temp.uid(101),'101',pg_temp.uid(31),'{}',1,'en','codex:test:stale-head')$q$,'PT409','writer_head_cas');
set local session_replication_role=replica;
update cloud_title_variants set codec_profile=jsonb_set(codec_profile,'{probedAt}','"2026-10-04T17:05:00Z"') where id=pg_temp.uid(101);
set local session_replication_role=origin;
select pg_temp.ok((select count(*)=1 from pg_temp.read_confirmation()),'timestamp_only_refresh_preserves_testimony');
set local session_replication_role=replica;
update cloud_title_variants set codec_profile=jsonb_set(codec_profile,'{fileSizeBytes}','1000001') where id=pg_temp.uid(101);
set local session_replication_role=origin;
select pg_temp.ok(not exists(select * from pg_temp.read_confirmation()),'changed_file_size_invalidates_testimony');
set local session_replication_role=replica;
update cloud_title_variants v set codec_profile=jsonb_set(o.codec_profile,'{audioTracks,0,channels}','2') from original_variants o where v.id=o.id and v.id=pg_temp.uid(101);
set local session_replication_role=origin;
select pg_temp.ok(not exists(select * from pg_temp.read_confirmation()),'changed_audio_track_invalidates_testimony');
set local session_replication_role=replica;
update cloud_title_variants v set codec_profile=o.codec_profile from original_variants o where v.id=o.id;
update cloud_source_catalog_heads set active_generation_id=pg_temp.uid(99) where source_id=pg_temp.uid(11);
set local session_replication_role=origin;
select pg_temp.ok(not exists(select * from pg_temp.read_confirmation()),'reimport_generation_invalidates_testimony');
set local session_replication_role=replica;
update cloud_source_catalog_heads set active_generation_id=pg_temp.uid(21) where source_id=pg_temp.uid(11);
update cloud_source_lifecycle set config_revision=2 where source_id=pg_temp.uid(11);
set local session_replication_role=origin;
select pg_temp.ok(not exists(select * from pg_temp.read_confirmation()),'changed_credentials_invalidates_testimony');
set local session_replication_role=replica;
update cloud_source_lifecycle set config_revision=1,visibility_epoch=2 where source_id=pg_temp.uid(11);
set local session_replication_role=origin;
select pg_temp.ok(not exists(select * from pg_temp.read_confirmation()),'source_visibility_invalidates_testimony');
set local session_replication_role=replica;
update cloud_source_lifecycle set visibility_epoch=1 where source_id=pg_temp.uid(11);
update cloud_user_catalog_visibility_epochs set visibility_epoch=2 where user_id=pg_temp.uid(1);
set local session_replication_role=origin;
select pg_temp.ok(not exists(select * from pg_temp.read_confirmation()),'user_visibility_invalidates_testimony');
set local session_replication_role=replica;
update cloud_user_catalog_visibility_epochs set visibility_epoch=1 where user_id=pg_temp.uid(1);
update catalog_source_provider_identities set identity_id=pg_temp.uid(32) where source_id=pg_temp.uid(11);
set local session_replication_role=origin;
select pg_temp.ok(not exists(select * from pg_temp.read_confirmation()),'provider_identity_change_invalidates_testimony');
set local session_replication_role=replica;
update catalog_source_provider_identities set identity_id=pg_temp.uid(31) where source_id=pg_temp.uid(11);
update cloud_sources set enabled=false where id=pg_temp.uid(11);
set local session_replication_role=origin;
select pg_temp.ok(not exists(select * from pg_temp.read_confirmation()),'disabled_source_hidden');
set local session_replication_role=replica;
update cloud_sources set enabled=true where id=pg_temp.uid(11);
set local session_replication_role=origin;
select pg_temp.ok((select count(*)=1 from pg_temp.read_confirmation()),'unchanged_exact_file_visible');
select pg_temp.ok(pg_temp.confirm('en','codex:test:explicit-correction')<>(select id from confirmation),'explicit_correction_appends_evidence');
select pg_temp.ok((select value->>'language'='en' from pg_temp.read_confirmation() t(value)),'latest_testimony_wins_same_track');
select pg_temp.ok((select count(*)=2 from catalog_owned_human_audio_confirmations),'old_human_evidence_retained');
select pg_temp.ok(not exists((select to_jsonb(v) from cloud_title_variants v except select to_jsonb(v) from original_variants v)
 union all (select to_jsonb(v) from original_variants v except select to_jsonb(v) from cloud_title_variants v)),'variant_facts_not_rewritten');
select pg_temp.ok(not exists((select to_jsonb(v) from catalog_file_audio_validation_jobs v except select to_jsonb(v) from original_jobs v)
 union all (select to_jsonb(v) from original_jobs v except select to_jsonb(v) from catalog_file_audio_validation_jobs v)),'jobs_receipts_bails_unchanged');
select pg_temp.ok(not exists((select to_jsonb(v) from cloud_title_file_language_observations v except select to_jsonb(v) from original_observations v)
 union all (select to_jsonb(v) from original_observations v except select to_jsonb(v) from cloud_title_file_language_observations v)),'automatic_observations_unchanged');
select pg_temp.ok(not exists((select to_jsonb(v) from catalog_owned_language_declarations v except select to_jsonb(v) from original_declarations v)
 union all (select to_jsonb(v) from original_declarations v except select to_jsonb(v) from catalog_owned_language_declarations v)),'provider_declarations_unchanged');
select pg_temp.ok(not has_function_privilege('authenticated','public.record_owned_movie_human_audio_confirmation(uuid,uuid,uuid,bigint,bigint,bigint,bigint,uuid,text,uuid,jsonb,integer,text,text)','EXECUTE'),'authenticated_cannot_confirm');
select pg_temp.ok(not has_function_privilege('anon','public.record_owned_movie_human_audio_confirmation(uuid,uuid,uuid,bigint,bigint,bigint,bigint,uuid,text,uuid,jsonb,integer,text,text)','EXECUTE'),'anonymous_cannot_confirm');
select pg_temp.ok(has_function_privilege('service_role','public.record_owned_movie_human_audio_confirmation(uuid,uuid,uuid,bigint,bigint,bigint,bigint,uuid,text,uuid,jsonb,integer,text,text)','EXECUTE'),'service_can_confirm');
select pg_temp.ok(not has_function_privilege('authenticated','public.cloud_catalog_owned_movie_human_audio_confirmations_batch(uuid,uuid,uuid[])','EXECUTE'),'authenticated_cannot_read_rpc');
select pg_temp.ok(not has_function_privilege('anon','public.cloud_catalog_owned_movie_human_audio_confirmations_batch(uuid,uuid,uuid[])','EXECUTE'),'anonymous_cannot_read_rpc');
select pg_temp.ok(has_function_privilege('service_role','public.cloud_catalog_owned_movie_human_audio_confirmations_batch(uuid,uuid,uuid[])','EXECUTE'),'service_can_read_rpc');
select pg_temp.ok(not has_table_privilege('service_role','public.catalog_owned_human_audio_confirmations','INSERT,UPDATE,DELETE'),'no_direct_service_writes');
select pg_temp.ok((select relrowsecurity from pg_class where oid='public.catalog_owned_human_audio_confirmations'::regclass),'rls_enabled');
select jsonb_build_object('passed',count(*),'checks',jsonb_agg(label order by label)) from checks;
rollback;
