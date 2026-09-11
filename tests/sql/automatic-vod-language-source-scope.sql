-- Exact production observation/admission/finalizer/fanout/cache bodies.
-- Synthetic rows, no model or provider I/O; production row triggers are not copied.
insert into public.cloud_source_lifecycle(source_id,user_id,config_revision,visibility_epoch)
select id,user_id,1,1 from public.cloud_sources;
insert into public.cloud_user_catalog_visibility_epochs(user_id,visibility_epoch)
select id,1 from auth.users;
insert into public.cloud_titles(id,user_id,item_type) values
 ('50000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','movie'),
 ('50000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000002','movie');
update public.cloud_title_variants set title_id='50000000-0000-0000-0000-000000000001'
where id='30000000-0000-0000-0000-000000000901';
insert into public.cloud_title_variants(id,user_id,source_id,generation_id,item_type,external_id,title_id) values
 ('30000000-0000-0000-0000-000000000902','00000000-0000-0000-0000-000000000002',
  '10000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000002','movie','future',
  '50000000-0000-0000-0000-000000000002');
do $test$
declare
 u uuid:='00000000-0000-0000-0000-000000000001'; s uuid:='10000000-0000-0000-0000-000000000001';
 v uuid:='30000000-0000-0000-0000-000000000901';
 at timestamptz:=clock_timestamp(); p jsonb; tracks jsonb:='[{"index":0,"codec":"aac","lang":null}]';
 r jsonb; j uuid; denied boolean:=false;
begin
 p:=jsonb_build_object('container','mp4','probeSource','gateway_probe','probedAt',at,
   'metadataComplete',true,'durationSeconds',1200,'fileSizeBytes',1000000,'audioTracks',tracks,'subtitles','[]'::jsonb);
 update public.cloud_title_variants set codec_profile=p where id=v;
 r:=public.observe_catalog_file_profile(u,s,v,'movie','future',repeat('a',64),p,tracks,'[]',true,true);
 perform public.fleet_assert(r->>'accepted'='true','private_observation_accepted');
 perform public.fleet_assert(exists(select 1 from public.catalog_file_tracks where server_host='source:'||s::text
   and external_id='future' and observed_profile_fingerprint=repeat('a',64)),'private_cache_is_source_bound');
 begin
   perform public.start_automatic_catalog_file_audio_validation_job(u,s,v,'source:10000000-0000-0000-0000-000000000002',
     'movie','future',array[0],p,repeat('a',64),at,1000000,tracks,false);
 exception when sqlstate 'PT409' then denied:=true;
 end;
 perform public.fleet_assert(denied,'private_cross_source_enqueue_denied');
 r:=public.start_automatic_catalog_file_audio_validation_job(u,s,v,'source:'||s::text,'movie','future',array[0],p,repeat('a',64),at,1000000,tracks,false);
 j:=(r->>'jobId')::uuid;
 perform public.fleet_assert(j is not null,'private_automatic_enqueue_accepted');
 update public.catalog_file_audio_validation_jobs set state='finalizing',lease_owner='fixture',lease_expires_at=now()+interval '5 minutes',
   next_track_position=1,evidence='[{"index":0,"language":"fr","consensus":6,"minSampleProbability":0.99,"minSampleWordCount":20,"minSampleUniqueWordCount":10}]'
 where id=j;
 r:=public.finalize_catalog_file_audio_validation_job(j,'fixture',repeat('a',64),at,1000000,array[0]);
 perform public.fleet_assert(r->>'verifiedAt' is not null,'private_finalizer_accepts_same_source');
 perform public.fleet_assert((select file_audio_verified_languages=array['fr'] from public.cloud_titles
   where id='50000000-0000-0000-0000-000000000001'),'private_language_published_to_own_title');
 perform public.fleet_assert((select coalesce(cardinality(file_audio_verified_languages),0)=0 from public.cloud_titles
   where id='50000000-0000-0000-0000-000000000002'),'private_language_not_published_to_other_title');
 perform public.fleet_assert(not exists(select 1 from public.catalog_file_tracks
   where server_host='source:10000000-0000-0000-0000-000000000002' and external_id='future'),'private_no_other_account_cache');

 -- Replacement bytes clear the old certificate and derived own-source facets.
 at:=clock_timestamp(); p:=p||jsonb_build_object('probedAt',at,'fileSizeBytes',2000000);
 update public.cloud_title_variants set codec_profile=p where id=v;
 r:=public.observe_catalog_file_profile(u,s,v,'movie','future',repeat('b',64),p,tracks,'[]',true,true);
 perform public.fleet_assert((select audio_lang_verified_at is null from public.catalog_file_tracks
   where server_host='source:'||s::text and external_id='future'),'private_replacement_clears_certificate');
 perform public.fleet_assert((select cardinality(file_audio_verified_languages)=0 from public.cloud_titles
   where id='50000000-0000-0000-0000-000000000001'),'private_replacement_clears_title_facets');

 -- A newly resolved shared identity must invalidate a still-pending private
 -- job. It is not permission to copy a private certificate to that identity.
 update public.catalog_file_audio_validation_jobs set state='finalizing',verified_at=null,lease_owner='fixture',lease_expires_at=now()+interval '5 minutes',
   profile_fingerprint=repeat('b',64),profile_probed_at=at,file_size_bytes=2000000,profile_snapshot=p where id=j;
 insert into public.catalog_source_provider_identities(source_id,user_id,identity_id,verified_at)
 values(s,u,'40000000-0000-0000-0000-000000000001',now());
 denied:=false;
 begin perform public.finalize_catalog_file_audio_validation_job(j,'fixture',repeat('b',64),at,2000000,array[0]);
 exception when sqlstate 'PT409' then denied:=true; end;
 perform public.fleet_assert(denied,'identity_promotion_invalidates_private_job');
 perform public.fleet_assert(not exists(select 1 from public.catalog_file_tracks where server_host='40000000-0000-0000-0000-000000000001'),
   'identity_promotion_does_not_copy_certificate');
end $test$;
