-- Synthetic fixture, exclusively on a disposable schema-only production copy.
begin;
do $$ begin
 if current_database()<>'norva_media_cache_canary' then
  raise exception 'Disposable database required';
 end if;
end $$;
set local lock_timeout='3s';
set local statement_timeout='30s';
create temp table cache_checks(label text primary key);
create function pg_temp.check_cache(ok boolean,label text) returns void language plpgsql as $$
begin
 if ok is distinct from true then raise exception 'Cache authority failed: %',label; end if;
 insert into cache_checks values(label);
end $$;
create temp table cache_fixture(i int,owner_id uuid,source_id uuid,item_id uuid,variant_id uuid,session_id uuid,binding_id uuid);

insert into public.media_cache_objects(
 object_key,content_sha256,file_size_bytes,video_profile_sha256,audio_topology_sha256,
 subtitle_topology_sha256,duration_milliseconds,pipeline_build,segmenter_build,state,
 storage_backend,object_prefix,root_playlist,manifest_sha256,total_bytes,file_count,
 ready_at,expires_at,retention_until,last_verified_at)
values(repeat('a1',32),repeat('b1',32),1024,repeat('c1',32),repeat('d1',32),repeat('e1',32),6000,
 'runtime-qa-v1','runtime-qa-hls-v1','ready','r2','media-cache/v1/a1/'||repeat('a1',32)||'/',
 'index.m3u8',repeat('f1',32),2048,4,now(),now()+interval '1 day',now()+interval '1 hour',now());

do $fixture$
declare u uuid;s uuid;g uuid;m uuid;v uuid;t uuid;p uuid;b uuid;i int;
begin
 for i in 1..2 loop
  u:=gen_random_uuid();s:=gen_random_uuid();m:=gen_random_uuid();v:=gen_random_uuid();t:=gen_random_uuid();p:=gen_random_uuid();
  insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
   raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  values(u,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
   'cache-owner-'||i||'@invalid.test','',now(),'{}','{}',now(),now());
  insert into public.cloud_sources(id,user_id,source_type,display_name,config_ciphertext,config_hint,sync_status,enabled,last_synced_at)
  values(s,u,'m3u','Synthetic cache source','cipher','{}','ready',true,now());
  select active_generation_id into strict g from public.cloud_source_catalog_heads where source_id=s and user_id=u;
  insert into public.cloud_titles(id,user_id,item_type,identity_key,identity_source,match_status,title,metadata)
  values(t,u,'movie','cache-qa:'||i,'normalized','unmatched','Synthetic cache movie','{}');
  insert into public.cloud_media_items(id,user_id,source_id,generation_id,item_type,external_id,title,available,metadata,playback_hint)
  values(m,u,s,g,'movie','qa-film','Synthetic cache movie',true,'{}','{"container":"mkv"}');
  insert into public.cloud_title_variants(id,user_id,title_id,source_id,generation_id,media_item_id,item_type,external_id,raw_title,metadata)
  values(v,u,t,s,g,m,'movie','qa-film','Synthetic cache movie','{}');
  b:=public.norva_bind_media_cache_object(repeat('a1',32),u,s,'movie','qa-film',repeat('ab',32),v);
  perform pg_temp.check_cache(b is not null,'owned binding '||i);
  insert into public.cloud_playback_sessions(id,user_id,source_id,item_type,item_id,mode,status,target_url_hash,expires_at)
  values(p,u,s,'movie','qa-film','transcode','ready',repeat('ab',32),now()+interval '5 minutes');
  insert into cache_fixture values(i,u,s,m,v,p,b);
 end loop;
end $fixture$;

do $tests$
declare a record;b record;
begin
 select * into strict a from cache_fixture where i=1;
 select * into strict b from cache_fixture where i=2;
 perform pg_temp.check_cache((select count(*)=1 from public.norva_authorize_media_cache_playback(a.session_id,a.owner_id,repeat('a1',32),90)),'owner A playback');
 perform pg_temp.check_cache((select count(*)=1 from public.norva_authorize_media_cache_playback(b.session_id,b.owner_id,repeat('a1',32),90)),'owner B same object playback');
 perform pg_temp.check_cache(a.binding_id<>b.binding_id,'separate owner bindings');
 perform pg_temp.check_cache((select count(*)=0 from public.norva_authorize_media_cache_playback(a.session_id,b.owner_id,repeat('a1',32),90)),'cross-owner session denied');
 perform pg_temp.check_cache(public.norva_bind_media_cache_object(repeat('a1',32),b.owner_id,a.source_id,'movie','qa-film',repeat('ab',32),a.variant_id) is null,'cross-owner binding denied');
 perform pg_temp.check_cache(public.norva_bind_media_cache_object(repeat('a1',32),a.owner_id,a.source_id,'movie','qa-film',repeat('ab',32),b.variant_id) is null,'foreign variant denied');
 perform pg_temp.check_cache((select count(*)=0 from public.norva_authorize_media_cache_playback(a.session_id,a.owner_id,repeat('b2',32),90)),'other object denied');
 update public.cloud_playback_sessions set target_url_hash=repeat('cd',32) where id=a.session_id;
 perform pg_temp.check_cache((select count(*)=0 from public.norva_authorize_media_cache_playback(a.session_id,a.owner_id,repeat('a1',32),90)),'changed exact target denied');
 update public.cloud_playback_sessions set target_url_hash=repeat('ab',32) where id=a.session_id;
 update public.cloud_media_items set available=false where id=a.item_id;
 perform pg_temp.check_cache((select count(*)=0 from public.norva_authorize_media_cache_playback(a.session_id,a.owner_id,repeat('a1',32),90)),'withdrawn title denied');
 update public.cloud_media_items set available=true where id=a.item_id;
 perform pg_temp.check_cache((select count(*)=1 from public.norva_authorize_media_cache_playback(a.session_id,a.owner_id,repeat('a1',32),90)),'current available title restored');
 update public.cloud_sources set enabled=false where id=a.source_id;
 perform pg_temp.check_cache((select count(*)=0 from public.norva_authorize_media_cache_playback(a.session_id,a.owner_id,repeat('a1',32),90)),'disabled source denied');
 perform pg_temp.check_cache((select count(*)=1 from public.norva_authorize_media_cache_playback(b.session_id,b.owner_id,repeat('a1',32),90)),'other owner remains authorized');
 update public.cloud_playback_sessions set status='expired' where id=b.session_id;
 perform pg_temp.check_cache((select count(*)=0 from public.norva_authorize_media_cache_playback(b.session_id,b.owner_id,repeat('a1',32),90)),'closed session denied');
 perform pg_temp.check_cache((select revoked_at is not null from public.media_cache_playback_grants where playback_session_id=b.session_id),'close revokes grant');
end $tests$;
select json_build_object('passed',count(*),'cases',json_agg(label order by label)) from cache_checks;
rollback;
