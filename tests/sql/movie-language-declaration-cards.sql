-- Schema-only networkless database; no customer rows or provider requests.
begin;
set local statement_timeout='20s';
set local request.jwt.claim.role='service_role';
create function pg_temp.uid(n int) returns uuid language sql immutable as $$select ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid$$;
create temp table checks(label text primary key);
create function pg_temp.ok(value boolean,label text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'fixture_failed: %',label; end if; insert into checks values(label); end $$;
insert into admin_feature_flags(key,enabled) values('owned_provider_language_metadata_enabled',true) on conflict(key) do update set enabled=true;
set local session_replication_role=replica;
insert into auth.users(id) values(pg_temp.uid(1)),(pg_temp.uid(9));
insert into provider_identities(id) values(pg_temp.uid(4));
insert into cloud_sources(id,user_id,source_type,display_name,sync_status) values(pg_temp.uid(2),pg_temp.uid(1),'xtream','Synthetic provider','ready');
insert into cloud_source_lifecycle(source_id,user_id,replacement_root_id,config_revision,visibility_epoch)
values(pg_temp.uid(2),pg_temp.uid(1),pg_temp.uid(2),1,1);
insert into cloud_source_catalog_heads(source_id,user_id,active_generation_id,head_revision) values(pg_temp.uid(2),pg_temp.uid(1),pg_temp.uid(3),1);
insert into cloud_source_catalog_generations(id,user_id,source_id,config_revision,state) values(pg_temp.uid(3),pg_temp.uid(1),pg_temp.uid(2),1,'active');
insert into catalog_source_provider_identities(source_id,user_id,identity_id,provider_key,verified_at) values(pg_temp.uid(2),pg_temp.uid(1),pg_temp.uid(4),'fixture',now());
insert into cloud_titles(id,user_id,item_type,identity_key,identity_source,title) values(pg_temp.uid(5),pg_temp.uid(1),'movie','fixture','normalized','Synthetic movie');
insert into cloud_title_variants(id,user_id,title_id,source_id,generation_id,item_type,external_id,raw_title,
write_head_revision,write_config_revision,write_source_visibility_epoch,write_user_visibility_epoch)
select pg_temp.uid(n),pg_temp.uid(1),pg_temp.uid(5),pg_temp.uid(2),pg_temp.uid(3),'movie',n::text,'Synthetic [MULTI-SUB]',1,1,1,1 from generate_series(101,103) n;
set local session_replication_role=origin;
select pg_temp.ok(record_owned_movie_language_declaration(pg_temp.uid(1),pg_temp.uid(2),pg_temp.uid(3),1,1,1,1,pg_temp.uid(101),'101',pg_temp.uid(4),'{"movie_data":{"stream_id":101},"info":{"audio":{"tags":{"language":"eng"}}}}')=1,'capture_owned_audio');
select pg_temp.ok(record_owned_movie_language_declaration(pg_temp.uid(1),pg_temp.uid(2),pg_temp.uid(3),1,1,1,1,pg_temp.uid(102),'102',pg_temp.uid(4),'{"movie_data":{"stream_id":102},"info":{"subtitles":[{"tags":{"language":"fra"}}]}}')=0,'subtitle_not_audio');
select pg_temp.ok((select array_agg(language)=array['en'] from cloud_catalog_owned_movie_audio_declarations_batch(pg_temp.uid(1),pg_temp.uid(2),array[pg_temp.uid(101),pg_temp.uid(102)])),'known_movie_projects');
select pg_temp.ok((select count(*)=1 from cloud_catalog_owned_movie_audio_declarations_batch(pg_temp.uid(1),pg_temp.uid(2),array[pg_temp.uid(101),pg_temp.uid(101),null])),'duplicate_null_ids_bounded');
select pg_temp.ok(not exists(select * from cloud_catalog_owned_movie_audio_declarations_batch(pg_temp.uid(9),pg_temp.uid(2),array[pg_temp.uid(101)])),'other_owner_closed');
select pg_temp.ok(not exists(select * from cloud_catalog_owned_movie_audio_declarations_batch(pg_temp.uid(1),pg_temp.uid(99),array[pg_temp.uid(101)])),'other_source_closed');
select pg_temp.ok(not exists(select * from cloud_catalog_owned_movie_audio_declarations_batch(null,pg_temp.uid(2),array[pg_temp.uid(101)])),'null_owner_closed');
select pg_temp.ok(not exists(select * from cloud_catalog_owned_movie_audio_declarations_batch(pg_temp.uid(1),null,array[pg_temp.uid(101)])),'null_source_closed');
select pg_temp.ok(not exists(select * from cloud_catalog_owned_movie_audio_declarations_batch(pg_temp.uid(1),pg_temp.uid(2),null)),'null_ids_closed');
select pg_temp.ok(not exists(select * from cloud_catalog_owned_movie_audio_declarations_batch(pg_temp.uid(1),pg_temp.uid(2),'{}')),'empty_ids_closed');
select pg_temp.ok(not exists(select * from cloud_catalog_owned_movie_audio_declarations_batch(pg_temp.uid(1),pg_temp.uid(2),array[pg_temp.uid(103)])),'unknown_not_inferred_from_title');
select pg_temp.ok(not has_function_privilege('authenticated','public.cloud_catalog_owned_movie_audio_declarations_batch(uuid,uuid,uuid[])','EXECUTE'),'authenticated_closed');
select pg_temp.ok(not has_function_privilege('anon','public.cloud_catalog_owned_movie_audio_declarations_batch(uuid,uuid,uuid[])','EXECUTE'),'anon_closed');
select pg_temp.ok(has_function_privilege('service_role','public.cloud_catalog_owned_movie_audio_declarations_batch(uuid,uuid,uuid[])','EXECUTE'),'service_allowed');
do $$begin
 begin perform * from cloud_catalog_owned_movie_audio_declarations_batch(pg_temp.uid(1),pg_temp.uid(2),array_fill(pg_temp.uid(101),array[201]));
 raise exception 'missing bound'; exception when invalid_parameter_value then perform pg_temp.ok(true,'oversize_rejected');end;
end $$;
set local session_replication_role=replica;
insert into cloud_title_file_language_observations(user_id,title_id,variant_id,file_external_id,audio_languages,audio_observed)
values(pg_temp.uid(1),pg_temp.uid(5),pg_temp.uid(101),'101',array['de'],true);
set local session_replication_role=origin;
select pg_temp.ok(not exists(select * from cloud_catalog_owned_movie_audio_declarations_batch(pg_temp.uid(1),pg_temp.uid(2),array[pg_temp.uid(101)])),'exact_observation_wins');
delete from cloud_title_file_language_observations where variant_id=pg_temp.uid(101);
update admin_feature_flags set enabled=false where key='owned_provider_language_metadata_enabled';
select pg_temp.ok(not exists(select * from cloud_catalog_owned_movie_audio_declarations_batch(pg_temp.uid(1),pg_temp.uid(2),array[pg_temp.uid(101)])),'disabled_projection_closed');
update admin_feature_flags set enabled=true where key='owned_provider_language_metadata_enabled';
update cloud_source_lifecycle set config_revision=2 where source_id=pg_temp.uid(2);
select pg_temp.ok(not exists(select * from cloud_catalog_owned_movie_audio_declarations_batch(pg_temp.uid(1),pg_temp.uid(2),array[pg_temp.uid(101)])),'old_credentials_closed');
select jsonb_build_object('assertions',count(*),'passed',true) from checks;
rollback;
