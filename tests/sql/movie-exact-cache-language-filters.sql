-- Networkless schema-only clone; synthetic rows roll back.
begin;
set local statement_timeout='20s';
set local request.jwt.claim.role='service_role';
create function pg_temp.uid(n int) returns uuid language sql immutable as $$select ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid$$;
create temp table checks(label text primary key);
create function pg_temp.ok(value boolean,label text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'fixture_failed: %',label; end if; insert into checks values(label); end $$;
insert into public.admin_feature_flags(key,enabled) values
 ('owned_provider_language_metadata_enabled',false),('language_metadata_lane_enabled',true),('enrichment_paused',false)
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


set local session_replication_role=replica;
insert into catalog_file_tracks(server_host,item_type,external_id,audio_tracks,audio_probed_at)
 values(pg_temp.uid(4)::text,'movie','102','[{"index":1,"lang":"ml"},{"index":2,"lang":"mal"}]',now());
set local session_replication_role=origin;
select pg_temp.ok((select count(*)=1 from norva_catalog_movie_effective_audio_languages(pg_temp.uid(1),pg_temp.uid(2),'ml') where variant_id=pg_temp.uid(102)),'exact_cache_normalized_deduplicated');
select pg_temp.ok(not exists(select 1 from cloud_catalog_unidentified_audio_variants(pg_temp.uid(1),'movie',pg_temp.uid(2)) where variant_id=pg_temp.uid(102)),'same_file_leaves_unknown_filter');
select pg_temp.ok(exists(select 1 from cloud_catalog_unidentified_audio_variants(pg_temp.uid(1),'movie',pg_temp.uid(2)) where variant_id=pg_temp.uid(103)),'unknown_sibling_remains');
select pg_temp.ok(norva_catalog_movie_unidentified_audio_count(pg_temp.uid(1),pg_temp.uid(2))=1,'mixed_title_keeps_unknown_count');
select pg_temp.ok((norva_catalog_movie_audio_language_counts(pg_temp.uid(1),pg_temp.uid(2))->>'ml')::int=1,'known_facet_same_evidence');
select pg_temp.ok(not exists(select 1 from norva_catalog_movie_effective_audio_languages(pg_temp.uid(9),pg_temp.uid(2),null)),'other_owner_source_rejected');
select pg_temp.ok(not exists(select 1 from norva_catalog_movie_effective_audio_languages(null,pg_temp.uid(2),null)),'null_owner_rejected');
select pg_temp.ok(not exists(select 1 from norva_catalog_movie_effective_audio_languages(pg_temp.uid(1),pg_temp.uid(7),null)),'other_source_rejected');
select pg_temp.ok(exists(select 1 from norva_catalog_movie_effective_audio_languages(pg_temp.uid(9),pg_temp.uid(7),'ml') where variant_id=pg_temp.uid(201)),'verified_same_provider_file_reusable_only_when_owned');
select pg_temp.ok(not exists(select 1 from cloud_title_file_language_observations),'no_new_observation');
select pg_temp.ok(not exists(select 1 from catalog_file_audio_validation_jobs),'no_new_strict_certificate');
select pg_temp.ok(not has_function_privilege('authenticated','norva_catalog_movie_effective_audio_languages(uuid,uuid,text)','EXECUTE'),'reader_private');
select pg_temp.ok(not exists(select 1 from norva_catalog_movie_effective_audio_languages(pg_temp.uid(1),pg_temp.uid(2),'fr') where variant_id=pg_temp.uid(102)),'requested_language_not_inferred');
set local session_replication_role=replica;
update catalog_file_tracks set server_host='unrelated' where external_id='102';
set local session_replication_role=origin;
select pg_temp.ok(not exists(select 1 from norva_catalog_movie_effective_audio_languages(pg_temp.uid(1),pg_temp.uid(2),'ml') where variant_id=pg_temp.uid(102)),'wrong_identity');
set local session_replication_role=replica;
update catalog_file_tracks set server_host=pg_temp.uid(4)::text where external_id='102';
set local session_replication_role=origin;
set local session_replication_role=replica;
update catalog_file_tracks set external_id='other' where item_type='movie';
set local session_replication_role=origin;
select pg_temp.ok(not exists(select 1 from norva_catalog_movie_effective_audio_languages(pg_temp.uid(1),pg_temp.uid(2),'ml') where variant_id=pg_temp.uid(102)),'wrong_file');
set local session_replication_role=replica;
update catalog_file_tracks set external_id='102' where item_type='movie';
set local session_replication_role=origin;
set local session_replication_role=replica;
update catalog_file_tracks set item_type='episode' where external_id='102';
set local session_replication_role=origin;
select pg_temp.ok(not exists(select 1 from norva_catalog_movie_effective_audio_languages(pg_temp.uid(1),pg_temp.uid(2),'ml') where variant_id=pg_temp.uid(102)),'episode_not_movie');
set local session_replication_role=replica;
update catalog_file_tracks set item_type='movie' where external_id='102';
set local session_replication_role=origin;
set local session_replication_role=replica;
update catalog_file_tracks set audio_probed_at=null where external_id='102';
set local session_replication_role=origin;
select pg_temp.ok(not exists(select 1 from norva_catalog_movie_effective_audio_languages(pg_temp.uid(1),pg_temp.uid(2),'ml') where variant_id=pg_temp.uid(102)),'unprobed');
set local session_replication_role=replica;
update catalog_file_tracks set audio_probed_at=now() where external_id='102';
set local session_replication_role=origin;
set local session_replication_role=replica;
update catalog_file_tracks set audio_tracks='[{"lang":"und"}]' where external_id='102';
set local session_replication_role=origin;
select pg_temp.ok(not exists(select 1 from norva_catalog_movie_effective_audio_languages(pg_temp.uid(1),pg_temp.uid(2),'ml') where variant_id=pg_temp.uid(102)),'unknown_tag');
set local session_replication_role=replica;
update catalog_file_tracks set audio_tracks='[{"lang":"ml"}]' where external_id='102';
set local session_replication_role=origin;
do $$ begin
 begin
  update catalog_file_tracks set audio_tracks='{}' where external_id='102';
  raise exception 'malformed cache unexpectedly accepted';
 exception when check_violation then perform pg_temp.ok(true,'malformed_tracks_rejected_by_storage');
 end;
end $$;

set local session_replication_role=replica;
delete from catalog_source_provider_identities where source_id=pg_temp.uid(2);
set local session_replication_role=origin;
select pg_temp.ok(not exists(select 1 from norva_catalog_movie_effective_audio_languages(pg_temp.uid(1),pg_temp.uid(2),'ml') where variant_id=pg_temp.uid(102)),'missing_verified_identity');
set local session_replication_role=replica;
insert into catalog_source_provider_identities(source_id,user_id,identity_id,provider_key,verified_at) values(pg_temp.uid(2),pg_temp.uid(1),pg_temp.uid(4),'fixture',now());
set local session_replication_role=origin;
set local session_replication_role=replica;
update cloud_title_variants set generation_id=pg_temp.uid(99) where id=pg_temp.uid(102);
set local session_replication_role=origin;
select pg_temp.ok(not exists(select 1 from norva_catalog_movie_effective_audio_languages(pg_temp.uid(1),pg_temp.uid(2),'ml') where variant_id=pg_temp.uid(102)),'stale_generation');
set local session_replication_role=replica;
update cloud_title_variants set generation_id=pg_temp.uid(3) where id=pg_temp.uid(102);
set local session_replication_role=origin;
set local session_replication_role=replica;
update cloud_title_variants set external_id='new-file' where id=pg_temp.uid(102);
set local session_replication_role=origin;
select pg_temp.ok(not exists(select 1 from norva_catalog_movie_effective_audio_languages(pg_temp.uid(1),pg_temp.uid(2),'ml') where variant_id=pg_temp.uid(102)),'changed_file');
set local session_replication_role=replica;
update cloud_title_variants set external_id='102' where id=pg_temp.uid(102);
set local session_replication_role=origin;
set local session_replication_role=replica;
update cloud_sources set enabled=false where id=pg_temp.uid(2);
set local session_replication_role=origin;
select pg_temp.ok(not exists(select 1 from norva_catalog_movie_effective_audio_languages(pg_temp.uid(1),pg_temp.uid(2),'ml') where variant_id=pg_temp.uid(102)),'disabled_source');
set local session_replication_role=replica;
update cloud_sources set enabled=true where id=pg_temp.uid(2);
set local session_replication_role=origin;
set local session_replication_role=replica;
update cloud_sources set deleted_at=now() where id=pg_temp.uid(2);
set local session_replication_role=origin;
select pg_temp.ok(not exists(select 1 from norva_catalog_movie_effective_audio_languages(pg_temp.uid(1),pg_temp.uid(2),'ml') where variant_id=pg_temp.uid(102)),'deleted_source');
set local session_replication_role=replica;
update cloud_sources set deleted_at=null where id=pg_temp.uid(2);
set local session_replication_role=origin;

set local session_replication_role=replica;
insert into cloud_catalog_provider_language_hints(variant_id,user_id,title_id,source_id,item_type,language)
 values(pg_temp.uid(102),pg_temp.uid(1),pg_temp.uid(5),pg_temp.uid(2),'movie','hi');
set local session_replication_role=origin;
select pg_temp.ok(not exists(select 1 from norva_catalog_movie_effective_audio_languages(pg_temp.uid(1),pg_temp.uid(2),'hi') where variant_id=pg_temp.uid(102)),'exact_cache_precedes_title_hint');
set local session_replication_role=replica;
update cloud_sources set source_type='m3u' where id=pg_temp.uid(2);
set local session_replication_role=origin;
select pg_temp.ok(not exists(select 1 from norva_catalog_movie_effective_audio_languages(pg_temp.uid(1),pg_temp.uid(2),'ml') where variant_id=pg_temp.uid(102)),'m3u_does_not_inherit_xtream_cache');
set local session_replication_role=replica;
update cloud_sources set source_type='xtream' where id=pg_temp.uid(2);
set local session_replication_role=origin;
select pg_temp.ok(public.record_owned_movie_language_declaration(pg_temp.uid(1),pg_temp.uid(2),pg_temp.uid(3),1,1,1,1,pg_temp.uid(102),'102',pg_temp.uid(4),
 '{"movie_data":{"stream_id":"102"},"info":{"audio":{"tags":{"language":"tel"}}}}')=1,'fenced_declaration');
select pg_temp.ok(exists(select 1 from norva_catalog_movie_effective_audio_languages(pg_temp.uid(1),pg_temp.uid(2),'te') where variant_id=pg_temp.uid(102)),'owned_declaration_precedes_uncertified_cache');
select pg_temp.ok(not exists(select 1 from norva_catalog_movie_effective_audio_languages(pg_temp.uid(1),pg_temp.uid(2),'ml') where variant_id=pg_temp.uid(102)),'cache_does_not_union_conflicting_declaration');
set local session_replication_role=replica;
insert into cloud_title_file_language_observations(user_id,title_id,variant_id,file_external_id,audio_languages,audio_observed)
 values(pg_temp.uid(1),pg_temp.uid(5),pg_temp.uid(102),'102',array['de'],true);
set local session_replication_role=origin;
select pg_temp.ok(exists(select 1 from norva_catalog_movie_effective_audio_languages(pg_temp.uid(1),pg_temp.uid(2),'de') where variant_id=pg_temp.uid(102)),'owned_observation_precedes_cache_and_declaration');
select pg_temp.ok(not exists(select 1 from norva_catalog_movie_effective_audio_languages(pg_temp.uid(1),pg_temp.uid(2),'ml') where variant_id=pg_temp.uid(102)),'cache_does_not_union_conflicting_observation');
select jsonb_build_object('passed',true,'checks',count(*),'customerRows',0,'providerRequests',0) from checks;
rollback;
