-- Run only in a schema-only, networkless clone. Synthetic rows roll back.
begin;
set local statement_timeout='20s';
set local request.jwt.claim.role='service_role';
create function pg_temp.uid(n int) returns uuid language sql immutable as $$select ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid$$;
create temp table checks(label text primary key);
create function pg_temp.ok(value boolean,label text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'fixture_failed: %',label; end if; insert into checks values(label); end $$;


create function pg_temp.projection_equal() returns void language plpgsql as $check$
declare scope record; kind text;
begin
 for scope in
   select u.id as owner_id,s.id as source_id from auth.users u cross join cloud_sources s
   union select u.id,null::uuid from auth.users u
 loop
  foreach kind in array array['movie','series'] loop
   if exists(
    (select * from public.cloud_catalog_owned_audio_declarations_scoped(scope.owner_id,scope.source_id,kind)
     except all select * from public.cloud_catalog_owned_audio_declarations d where d.user_id=scope.owner_id and d.item_type=kind and (scope.source_id is null or d.source_id=scope.source_id))
    union all
    (select * from public.cloud_catalog_owned_audio_declarations d where d.user_id=scope.owner_id and d.item_type=kind and (scope.source_id is null or d.source_id=scope.source_id)
     except all select * from public.cloud_catalog_owned_audio_declarations_scoped(scope.owner_id,scope.source_id,kind))
   ) then raise exception 'Scoped declaration differs from reference'; end if;
  end loop;
 end loop;
 if exists(select * from public.cloud_catalog_owned_audio_declarations_scoped(pg_temp.uid(1),pg_temp.uid(999),'series')) then raise exception 'Wrong source leaks'; end if;
 if exists(select * from public.cloud_catalog_owned_audio_declarations_scoped(null,null,'series')) then raise exception 'Null owner leaks'; end if;
end $check$;
select pg_temp.ok(public.catalog_provider_stream_audio_languages('{"info":{"audio":{"tags":{"LANGUAGE":"spa"}}}}')=array['es'],'uppercase_tag');
select pg_temp.projection_equal();
select pg_temp.ok(public.catalog_provider_stream_audio_languages('{"info":{"audio":{"tags":{"language":"eng","LANGUAGE":"spa"}}}}')='{}','contradiction_not_union');
select pg_temp.projection_equal();
select pg_temp.ok(public.catalog_provider_stream_audio_languages('{"info":{"audio_tracks":[{"tags":{"language":"eng"}},{"tags":{"language":"fra"}}]}}')=array['en','fr'],'multiple_actual_stream_declarations');
select pg_temp.projection_equal();
select pg_temp.ok(public.catalog_provider_stream_audio_languages('{"info":{"language":"en","original_language":"en","subtitles":[{"language":"ar"}]},"country":"US","audio":"aac"}')='{}','subtitle_original_country_codec_excluded');
select pg_temp.projection_equal();
select pg_temp.ok(public.catalog_provider_stream_audio_languages('{"info":{"audio":{"tags":{"language":"und"}}}}')='{}','und_not_identified');
select pg_temp.projection_equal();
select pg_temp.ok(public.catalog_provider_stream_audio_languages('{"info":{"audio":{"tags":{"language":"https://secret.invalid"}}}}')='{}','urls_excluded');
select pg_temp.projection_equal();
select pg_temp.ok(not has_table_privilege('authenticated','public.catalog_owned_language_declarations','SELECT'),'internal_table_private');
select pg_temp.projection_equal();
select pg_temp.ok(not has_table_privilege('service_role','public.catalog_owned_language_declarations','INSERT'),'writes_only_via_fence');
select pg_temp.projection_equal();
select pg_temp.ok(not has_function_privilege('authenticated','public.record_owned_movie_language_declaration(uuid,uuid,uuid,bigint,bigint,bigint,bigint,uuid,text,uuid,jsonb)','EXECUTE'),'writer_private');
select pg_temp.projection_equal();
insert into public.admin_feature_flags(key,enabled) values('owned_provider_language_metadata_enabled',true) on conflict(key) do update set enabled=true;

-- Seeding bypasses application row triggers only. Tests below restore them.
set local session_replication_role=replica;
insert into auth.users(id) values(pg_temp.uid(1)),(pg_temp.uid(9));
insert into public.provider_identities(id) values(pg_temp.uid(4));
insert into public.cloud_sources(id,user_id,source_type,display_name,sync_status) values(pg_temp.uid(2),pg_temp.uid(1),'xtream','Synthetic provider','ready');
insert into public.cloud_source_lifecycle(source_id,user_id,replacement_root_id,config_revision,visibility_epoch)
values(pg_temp.uid(2),pg_temp.uid(1),pg_temp.uid(2),1,1);
insert into public.cloud_source_catalog_heads(source_id,user_id,active_generation_id,head_revision) values(pg_temp.uid(2),pg_temp.uid(1),pg_temp.uid(3),1);
insert into public.cloud_source_catalog_generations(id,user_id,source_id,config_revision,state)
values(pg_temp.uid(3),pg_temp.uid(1),pg_temp.uid(2),1,'active');
insert into public.catalog_source_provider_identities(source_id,user_id,identity_id,provider_key,verified_at)
values(pg_temp.uid(2),pg_temp.uid(1),pg_temp.uid(4),'fixture',now());
insert into public.cloud_titles(id,user_id,item_type,identity_key,identity_source,title)
values(pg_temp.uid(5),pg_temp.uid(1),'movie','fixture','normalized','Synthetic movie');
insert into public.cloud_title_variants(id,user_id,title_id,source_id,generation_id,item_type,external_id,raw_title,
write_head_revision,write_config_revision,write_source_visibility_epoch,write_user_visibility_epoch)
select pg_temp.uid(n),pg_temp.uid(1),pg_temp.uid(5),pg_temp.uid(2),pg_temp.uid(3),'movie',n::text,'Synthetic movie',1,1,1,1 from generate_series(101,140) n;
insert into public.cloud_catalog_provider_language_hints(variant_id,user_id,title_id,source_id,item_type,language)
values(pg_temp.uid(101),pg_temp.uid(1),pg_temp.uid(5),pg_temp.uid(2),'movie','fr');
set local session_replication_role=origin;

select pg_temp.ok(public.catalog_movie_audio_identified(pg_temp.uid(1),pg_temp.uid(2),pg_temp.uid(101)),'hint_known');
select pg_temp.projection_equal();
select pg_temp.ok(not public.catalog_movie_audio_identified(pg_temp.uid(1),pg_temp.uid(2),pg_temp.uid(102)),'missing_unknown');
select pg_temp.projection_equal();
select pg_temp.ok(not public.catalog_movie_audio_identified(pg_temp.uid(9),pg_temp.uid(2),pg_temp.uid(101)),'other_owner_closed');
select pg_temp.projection_equal();
select pg_temp.ok(public.record_owned_movie_language_declaration(pg_temp.uid(1),pg_temp.uid(2),pg_temp.uid(3),1,1,1,1,
 pg_temp.uid(102),'102',pg_temp.uid(4),'{"movie_data":{"stream_id":102},"info":{"audio":{"tags":{"LANGUAGE":"spa"}}}}')=1,'fenced_capture');
select pg_temp.ok(public.catalog_movie_audio_identified(pg_temp.uid(1),pg_temp.uid(2),pg_temp.uid(102)),'declaration_known');
select pg_temp.projection_equal();
select pg_temp.ok(exists(select 1 from public.cloud_catalog_effective_audio_languages(pg_temp.uid(1),'movie',pg_temp.uid(2),'es') where variant_id=pg_temp.uid(102)),'declaration_in_filter');
select pg_temp.projection_equal();
select pg_temp.ok(not exists(select 1 from public.cloud_catalog_unidentified_audio_variants(pg_temp.uid(1),'movie',pg_temp.uid(2)) where variant_id=pg_temp.uid(102)),'removed_from_unknown_filter');
select pg_temp.projection_equal();
select pg_temp.ok(not exists(select 1 from public.cloud_title_file_language_observations where variant_id=pg_temp.uid(102)),'not_fake_audio_observation');
select pg_temp.projection_equal();
do $$begin
 begin perform public.record_owned_movie_language_declaration(pg_temp.uid(1),pg_temp.uid(2),pg_temp.uid(3),1,2,1,1,pg_temp.uid(102),'102',pg_temp.uid(4),'{}');
 raise exception 'fixture_missing_fence'; exception when others then perform pg_temp.ok(SQLERRM='catalog delete proof CAS failed','config_drift_rejected'); end;
 begin perform public.record_owned_movie_language_declaration(pg_temp.uid(1),pg_temp.uid(2),pg_temp.uid(3),1,1,1,1,pg_temp.uid(102),'102',pg_temp.uid(4),'{"movie_data":{"stream_id":999}}');
 raise exception 'fixture_missing_id_check'; exception when invalid_parameter_value then perform pg_temp.ok(true,'response_file_mismatch_rejected'); end;
end $$;

-- An exact observed language wins, including when querying the old language.
set local session_replication_role=replica;
insert into public.cloud_title_file_language_observations(user_id,title_id,variant_id,file_external_id,audio_languages,audio_observed)
values(pg_temp.uid(1),pg_temp.uid(5),pg_temp.uid(102),'102',array['de'],true);
set local session_replication_role=origin;
select pg_temp.ok(not exists(select 1 from public.cloud_catalog_effective_audio_languages(pg_temp.uid(1),'movie',pg_temp.uid(2),'es') where variant_id=pg_temp.uid(102)),'observations_override_declarations');
select pg_temp.projection_equal();
select pg_temp.ok(exists(select 1 from public.cloud_catalog_effective_audio_languages(pg_temp.uid(1),'movie',pg_temp.uid(2),'de') where variant_id=pg_temp.uid(102)),'observed_language_preserved');
select pg_temp.projection_equal();

-- Capacity is deterministic ONLY in this fixture. Real claim retains the
-- production admission calls, flags, 20-minute lease and all retry history.
create or replace function public.catalog_language_execution_available() returns boolean language sql as $$select true$$;
create or replace function public.catalog_language_queue_available(p_identity_key text) returns boolean language sql as $$select true$$;
insert into public.admin_feature_flags(key,enabled) values('automatic_vod_language_fleet_enabled',true),('audio_lid_enabled',true),('adaptive_language_admission_enabled',true)
on conflict(key) do update set enabled=excluded.enabled;
do $$declare q jsonb;n integer;begin
 for n in 1..10 loop
  q:=public.claim_catalog_vod_language_file(pg_temp.uid(1),pg_temp.uid(2));
  perform pg_temp.ok(q->>'lane'=case when n=10 then 'validation' else 'unknown' end,'priority_lane_'||n);
  perform pg_temp.ok(public.catalog_movie_audio_identified(pg_temp.uid(1),pg_temp.uid(2),(q->>'variantId')::uuid)=(n=10),'selected_membership_'||n);
  if n=1 then perform pg_temp.ok(public.claim_catalog_vod_language_file(pg_temp.uid(1),pg_temp.uid(2))->>'skipped'='intake-busy','one_active_claim'); end if;
  perform public.finish_catalog_vod_language_file(pg_temp.uid(1),pg_temp.uid(2),(q->>'variantId')::uuid,(q->>'leaseToken')::uuid,'unsupported','fixture-unsupported',false);
 end loop;
end $$;
select pg_temp.ok((select unknown_after_variant_id is not null and after_variant_id=pg_temp.uid(101) from public.catalog_vod_language_sweeps where source_id=pg_temp.uid(2)),'independent_cursors');
select pg_temp.projection_equal();

set local session_replication_role=replica;
insert into public.cloud_titles(id,user_id,item_type,identity_key,identity_source,title)
values(pg_temp.uid(6),pg_temp.uid(1),'series','series-fixture','normalized','Synthetic series');
insert into public.cloud_title_variants(id,user_id,title_id,source_id,generation_id,item_type,external_id,raw_title,
write_head_revision,write_config_revision,write_source_visibility_epoch,write_user_visibility_epoch)
values(pg_temp.uid(201),pg_temp.uid(1),pg_temp.uid(6),pg_temp.uid(2),pg_temp.uid(3),'series','201','Synthetic series',1,1,1,1);
set local session_replication_role=origin;
select pg_temp.ok(public.register_catalog_series_episodes(pg_temp.uid(1),pg_temp.uid(2),pg_temp.uid(3),1,1,1,1,'201',
'{"episodes":{"1":[{"id":"301","episode_num":1,"season":1,"container_extension":"mkv","info":{"audio":{"tags":{"LANGUAGE":"fra"}}}},
{"id":"302","episode_num":2,"season":1,"container_extension":"mkv","info":{"audio":{"tags":{"language":"eng"}}}}]}}')=2,'owned_series_registration');
select pg_temp.ok((select count(*)=2 from public.catalog_owned_language_declarations where variant_id=pg_temp.uid(201)),'episode_declarations_bound');
select pg_temp.projection_equal();
select pg_temp.ok((select array_agg(language order by language)=array['en','fr'] from public.cloud_catalog_effective_audio_languages(pg_temp.uid(1),'series',pg_temp.uid(2),null) where variant_id=pg_temp.uid(201)),'series_declaration_union_no_all_episodes_claim');
select pg_temp.projection_equal();
select pg_temp.ok(not exists(select 1 from public.catalog_file_tracks where external_id in ('201','301','302')),'no_parent_or_episode_fake_tracks');
select pg_temp.projection_equal();
select pg_temp.ok(not exists(select 1 from public.cloud_title_file_language_observations where variant_id=pg_temp.uid(201)),'no_series_fake_observation');
select pg_temp.projection_equal();
select pg_temp.ok(public.register_catalog_series_episodes(pg_temp.uid(1),pg_temp.uid(2),pg_temp.uid(3),1,1,1,1,'201',
'{"episodes":{"1":[{"id":"301","episode_num":1,"season":1,"container_extension":"mkv","info":{"audio":{"tags":{"LANGUAGE":"und"}}}}]}}')=1,'inventory_replacement');
select pg_temp.ok(not exists(select 1 from public.cloud_catalog_owned_audio_declarations where variant_id=pg_temp.uid(201)),'removed_episode_and_unknown_replacement_not_reused');
select pg_temp.projection_equal();

-- A legacy successful inventory gets one bounded refresh, not a cooldown reset.
set local session_replication_role=replica;
insert into public.cloud_title_variants(id,user_id,title_id,source_id,generation_id,item_type,external_id,raw_title,
write_head_revision,write_config_revision,write_source_visibility_epoch,write_user_visibility_epoch)
values(pg_temp.uid(202),pg_temp.uid(1),pg_temp.uid(6),pg_temp.uid(2),pg_temp.uid(3),'series','202','Legacy series',1,1,1,1);
insert into public.catalog_series_inventory_state(user_id,source_id,provider_identity_id,parent_title_id,parent_variant_id,parent_series_id,
 last_succeeded_at,next_retry_at,consecutive_failures,generation_id,write_head_revision,write_config_revision,write_source_visibility_epoch,write_user_visibility_epoch)
values(pg_temp.uid(1),pg_temp.uid(2),pg_temp.uid(4),pg_temp.uid(6),pg_temp.uid(202),'202',now()-interval '1 day',now()+interval '1 day',0,pg_temp.uid(3),1,1,1,1);
set local session_replication_role=origin;
select pg_temp.ok(exists(select 1 from public.catalog_series_inventory_candidates(pg_temp.uid(1),pg_temp.uid(2),4) where parent_series_id='202'),'legacy_success_refresh_due');
select pg_temp.projection_equal();
update public.catalog_series_inventory_state set consecutive_failures=1 where parent_variant_id=pg_temp.uid(202);
select pg_temp.ok(not exists(select 1 from public.catalog_series_inventory_candidates(pg_temp.uid(1),pg_temp.uid(2),4) where parent_series_id='202'),'inventory_failure_backoff_preserved');
select pg_temp.projection_equal();
update public.catalog_series_inventory_state set consecutive_failures=0,last_succeeded_at=now() where parent_variant_id=pg_temp.uid(202);
select pg_temp.ok(not exists(select 1 from public.catalog_series_inventory_candidates(pg_temp.uid(1),pg_temp.uid(2),4) where parent_series_id='202'),'recent_success_cooldown_preserved');
select pg_temp.projection_equal();
update public.catalog_series_inventory_state set last_succeeded_at=now()-interval '1 day' where parent_variant_id=pg_temp.uid(202);
insert into public.catalog_provider_inventory_backoff(source_id,provider_identity_id,next_retry_at)
values(pg_temp.uid(2),pg_temp.uid(4),now()+interval '1 hour');
select pg_temp.ok(not exists(select 1 from public.catalog_series_inventory_candidates(pg_temp.uid(1),pg_temp.uid(2),4)),'provider_backoff_preserved');
select pg_temp.projection_equal();
update public.catalog_provider_inventory_backoff set next_retry_at=now()-interval '1 hour' where source_id=pg_temp.uid(2);
select pg_temp.ok(public.register_catalog_series_episodes(pg_temp.uid(1),pg_temp.uid(2),pg_temp.uid(3),1,1,1,1,'202',
'{"episodes":{"1":[{"id":"401","episode_num":1,"season":1,"container_extension":"mkv","info":{"audio":{"tags":{"language":"und"}}}}]}}')=1,'refresh_unknown_captured');
update public.catalog_series_inventory_state set last_succeeded_at=now()-interval '1 day',next_retry_at=now()+interval '1 day' where parent_variant_id=pg_temp.uid(202);
select pg_temp.ok(not exists(select 1 from public.catalog_series_inventory_candidates(pg_temp.uid(1),pg_temp.uid(2),4) where parent_series_id='202'),'empty_declaration_does_not_repeat_refresh');
select pg_temp.projection_equal();
update public.admin_feature_flags set enabled=false where key='owned_provider_language_metadata_enabled';
select pg_temp.ok(not exists(select 1 from public.cloud_catalog_owned_audio_declarations),'projection_off_before_edge_activation');
select pg_temp.projection_equal();
select pg_temp.ok(not exists(
 (select * from public.cloud_catalog_effective_audio_languages(pg_temp.uid(1),'movie',pg_temp.uid(2),null)
 except select * from public.cloud_catalog_effective_audio_languages_before_owned(pg_temp.uid(1),'movie',pg_temp.uid(2),null))
 union all
 (select * from public.cloud_catalog_effective_audio_languages_before_owned(pg_temp.uid(1),'movie',pg_temp.uid(2),null)
 except select * from public.cloud_catalog_effective_audio_languages(pg_temp.uid(1),'movie',pg_temp.uid(2),null))
),'disabled_flag_matches_existing_filter');
select pg_temp.projection_equal();
select pg_temp.projection_equal();
select pg_temp.ok(not has_function_privilege('authenticated','public.cloud_catalog_owned_audio_declarations_scoped(uuid,uuid,text)','EXECUTE'),'scoped_reader_private');
select pg_temp.ok(not exists (
 select 1 from (values(1),(2),(3)) candidate(id)
 where (not exists(select 1 from (values(1),(1),(null::int)) evidence(id) where evidence.id=candidate.id))
 is distinct from (candidate.id not in(select id from (values(1),(1),(null::int)) evidence(id) where id is not null))
),'membership_preserves_null_and_duplicate_evidence');

select pg_temp.ok(not public.catalog_owned_language_metadata_enabled_for_source(pg_temp.uid(1),pg_temp.uid(2)),'rollout_starts_off');
select pg_temp.ok(not has_function_privilege('authenticated','public.set_catalog_owned_language_metadata_rollout(bigint,integer,text)','EXECUTE'),'rollout_mutation_private');
do $stages$
declare points integer; revision bigint:=0; result jsonb;
begin
 begin
  perform public.set_catalog_owned_language_metadata_rollout(0,2000,'fixture rejects skipped stage');
  raise exception 'skip accepted';
 exception when invalid_parameter_value then perform pg_temp.ok(true,'stage_skip_rejected'); end;
 foreach points in array array[100,500,2000,5000,10000] loop
  result:=public.set_catalog_owned_language_metadata_rollout(revision,points,'fixture progressive owned declaration rollout');
  revision:=revision+1;
  perform pg_temp.ok((result->>'revision')::bigint=revision,'stage_revision_'||points);
  perform pg_temp.ok(public.catalog_owned_language_metadata_enabled_for_source(pg_temp.uid(1),pg_temp.uid(2))=
   ((('x'||substr(md5('norva-language-metadata-v1:'||pg_temp.uid(1)::text),1,8))::bit(32)::bigint %10000)<points),'stable_bucket_'||points);
 end loop;
 begin perform public.set_catalog_owned_language_metadata_rollout(0,0,'fixture rejects stale revision');
  raise exception 'stale accepted';
 exception when sqlstate 'PT409' then perform pg_temp.ok(true,'stale_revision_rejected'); end;
end $stages$;
select pg_temp.ok(not public.catalog_owned_language_metadata_enabled_for_source(pg_temp.uid(9),pg_temp.uid(2)),'rollout_foreign_source_closed');
select pg_temp.ok(not public.catalog_owned_language_metadata_enabled_for_source(null,pg_temp.uid(2)),'rollout_null_owner_closed');
select pg_temp.ok(public.record_owned_movie_language_declaration(pg_temp.uid(1),pg_temp.uid(2),pg_temp.uid(3),1,1,1,1,
 pg_temp.uid(103),'103',pg_temp.uid(4),'{"movie_data":{"stream_id":103},"info":{"audio":{"tags":{"language":"eng"}}}}'::jsonb)=1,'rollout_fresh_declaration');
select pg_temp.projection_equal();
select pg_temp.ok(exists(select 1 from public.cloud_catalog_owned_audio_declarations where variant_id=pg_temp.uid(103) and language='en'),'rollout_view_enabled');
select pg_temp.ok(public.catalog_movie_audio_identified(pg_temp.uid(1),pg_temp.uid(2),pg_temp.uid(103)),'rollout_intake_enabled');
select public.set_catalog_owned_language_metadata_rollout(5,0,'fixture emergency rollback');
select pg_temp.ok(not exists(select 1 from public.cloud_catalog_owned_audio_declarations),'rollback_hides_declarations');
select pg_temp.projection_equal();

select jsonb_build_object('passed',true,'checks',count(*),'productionWrites',0,'providerRequests',0) from checks;
rollback;
