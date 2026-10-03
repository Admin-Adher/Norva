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

select pg_temp.ok(public.record_owned_movie_language_declaration(pg_temp.uid(1),pg_temp.uid(2),pg_temp.uid(3),1,1,1,1,pg_temp.uid(102),'102',pg_temp.uid(4),
 '{"movie_data":{"stream_id":"102"},"info":{"audio":{"tags":{"language":"tel"}}}}')=1,'fenced_metadata_writer');
select pg_temp.ok(exists(select 1 from norva_catalog_movie_effective_audio_languages(pg_temp.uid(1),pg_temp.uid(2),'te') where variant_id=pg_temp.uid(102)), 'rollout_publishes_despite_retired_flag');
select pg_temp.ok(not exists(select 1 from cloud_catalog_unidentified_audio_variants(pg_temp.uid(1),'movie',pg_temp.uid(2)) where variant_id=pg_temp.uid(102)), 'real_filter_no_longer_unknown');
select pg_temp.ok(not exists(select 1 from norva_catalog_movie_effective_audio_languages(pg_temp.uid(9),pg_temp.uid(2),null)), 'foreign_owner_excluded');
select pg_temp.ok(not exists(select 1 from norva_catalog_movie_effective_audio_languages(null,pg_temp.uid(2),null)), 'null_owner_excluded');
select pg_temp.ok(not exists(select 1 from norva_catalog_movie_effective_audio_languages(pg_temp.uid(1),pg_temp.uid(7),null)), 'foreign_source_excluded');
select pg_temp.ok(not has_function_privilege('authenticated','norva_catalog_movie_effective_audio_languages(uuid,uuid,text)','EXECUTE'),'private_reader');

-- Explicit observation still wins over the supplier's audio declaration.
set local session_replication_role=replica;
insert into public.cloud_title_file_language_observations(user_id,title_id,variant_id,file_external_id,audio_languages,audio_observed)
 values(pg_temp.uid(1),pg_temp.uid(5),pg_temp.uid(102),'102',array['de'],true);
set local session_replication_role=origin;
select pg_temp.ok(not exists(select 1 from norva_catalog_movie_effective_audio_languages(pg_temp.uid(1),pg_temp.uid(2),'te') where variant_id=pg_temp.uid(102)), 'observed_audio_overrides_metadata');
select pg_temp.ok(exists(select 1 from norva_catalog_movie_effective_audio_languages(pg_temp.uid(1),pg_temp.uid(2),'de') where variant_id=pg_temp.uid(102)), 'observed_audio_remains');
select pg_temp.ok(public.record_owned_movie_language_declaration(pg_temp.uid(1),pg_temp.uid(2),pg_temp.uid(3),1,1,1,1,pg_temp.uid(103),'103',pg_temp.uid(4),
 '{"info":{"audio":{"tags":{"language":"eng"}}}}')=1,'second_current_declaration');
update catalog_owned_language_metadata_rollout set basis_points=0;
select pg_temp.ok(not exists(select 1 from norva_catalog_movie_effective_audio_languages(pg_temp.uid(1),pg_temp.uid(2),null) where variant_id=pg_temp.uid(103)), 'rollout_off_hides_declaration');
select pg_temp.ok(exists(select 1 from norva_catalog_movie_effective_audio_languages(pg_temp.uid(1),pg_temp.uid(2),'de') where variant_id=pg_temp.uid(102)), 'rollout_off_preserves_observation');
update catalog_owned_language_metadata_rollout set basis_points=10000;
set local session_replication_role=replica;
update catalog_owned_language_declarations set config_revision=0 where variant_id=pg_temp.uid(103);
set local session_replication_role=origin;
select pg_temp.ok(not exists(select 1 from norva_catalog_movie_effective_audio_languages(pg_temp.uid(1),pg_temp.uid(2),null) where variant_id=pg_temp.uid(103)), 'stale_configuration_rejected');
select jsonb_build_object('passed',true,'checks',count(*),'productionWrites',0,'providerRequests',0) from checks;
rollback;
