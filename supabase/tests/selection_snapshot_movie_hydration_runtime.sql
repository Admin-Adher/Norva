-- Disposable schema-only database only. All synthetic fixture writes roll back.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';
create temp table selection_movie_fixture(owner_id uuid,source_id uuid,files jsonb);
create function pg_temp.movie_assert(ok boolean,label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'movie hydration assertion: %',label; end if; end $$;

insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values('98730000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','selection-movie-hydration@invalid.test','',now(),'{}','{}',now(),now());

do $fixture$
declare
  u uuid:='98730000-0000-4000-8000-000000000001'; s uuid; h text; g uuid;
  m uuid; t uuid; v uuid; ext text; url text; digest text; metadata jsonb;
  files jsonb:='[]'; i integer; tracks jsonb:='[{"index":1,"lang":"es","codec":"aac"}]';
begin
  h:=encode(sha256(convert_to('norva-selection-curated-v1:'||u::text,'UTF8')),'hex');
  s:=(substr(h,1,8)||'-'||substr(h,9,4)||'-4'||substr(h,14,3)||'-a'||substr(h,18,3)||'-'||substr(h,21,12))::uuid;
  insert into public.cloud_sources(id,user_id,source_type,display_name,config_ciphertext,config_hint,sync_status,catalog_version,enabled,last_synced_at)
    values(s,u,'m3u','Synthetic Selection movie hydration','cipher','{}','ready',1,true,now());
  select active_generation_id into strict g from public.cloud_source_catalog_heads where source_id=s and user_id=u;
  for i in 1..11 loop
    m:=gen_random_uuid();t:=gen_random_uuid();v:=gen_random_uuid();
    ext:='norva-selection:movie:'||lpad(i::text,64,'0');url:='https://fixture.invalid/movie-'||i||'.mp4';
    digest:=encode(sha256(convert_to(url,'UTF8')),'hex');
    metadata:=jsonb_build_object('selectionRevision','selection-vod-20260906-v1','discoveryFeed','herbert-tested-vod',
      'selectionPlaybackValidation',jsonb_build_object('urlSha256',digest,'containerMetadataCheckedAt','2026-09-07T00:00:00Z'));
    insert into public.cloud_titles(id,user_id,item_type,identity_key,identity_source,match_status,title,metadata)
      values(t,u,'movie','selection-movie-test:'||i,'normalized','unmatched','Synthetic movie '||i,'{}');
    insert into public.cloud_media_items(id,user_id,source_id,generation_id,item_type,external_id,title,available,playback_hint,metadata)
      values(m,u,s,g,'movie',ext,'Synthetic movie '||i,i<>9,
        jsonb_build_object('targetUrl',case when i=7 then 'https://fixture.invalid/wrong.mp4' else url end),
        case when i=8 then jsonb_set(metadata,'{selectionRevision}','"obsolete"') else metadata end);
    insert into public.cloud_title_variants(id,user_id,title_id,source_id,generation_id,media_item_id,item_type,external_id,raw_title,playback_hint,metadata)
      values(v,u,t,s,g,m,'movie',ext,'Synthetic movie '||i,jsonb_build_object('targetUrl',url),metadata);
    files:=files||jsonb_build_array(jsonb_build_object('externalId',ext,'urlSha256',digest,
      'revision','selection-vod-20260906-v1','feedId','herbert-tested-vod','probedAt','2026-09-07T00:00:00Z',
      'audioTracks',tracks,'subtitleTracks','[]'::jsonb,'hasSubtitle',true));
    if i in (2,3,4,5,11) then
      insert into public.catalog_file_tracks(server_host,item_type,external_id,audio_tracks,subtitle_tracks,
        audio_probed_at,audio_lang_verified_at,audio_lang_verification)
      values('source:'||s,'movie',ext,
        case when i=11 then '[{"index":1,"lang":null}]'::jsonb
          when i in (3,5) then '[{"index":1,"lang":"en"}]'::jsonb else tracks end,'[]',
        '2026-09-08T00:00:00Z',case when i=3 then '2026-09-08T01:00:00Z'::timestamptz else null end,
        case when i in (3,11) then jsonb_build_object('urlSha256',digest,'status',case when i=3 then 'verified' else 'unidentified' end)
          when i=4 then jsonb_build_object('urlSha256',repeat('f',64)) else '{}'::jsonb end);
    end if;
    if i in (6,10) then
      insert into public.cloud_title_file_language_observations(user_id,title_id,variant_id,file_external_id,
        audio_languages,audio_observed,subtitle_languages,subtitle_observed)
      values(u,t,v,case when i=6 then ext else ext||'-different-file' end,'{}',true,'{}',false);
    end if;
  end loop;
  insert into selection_movie_fixture values(u,s,files);
end $fixture$;

select set_config('request.jwt.claims','{"role":"service_role"}',true);
select set_config('request.jwt.claim.role','service_role',true);
create function pg_temp.seed_movies(files jsonb,overrides jsonb default '{}') returns integer language plpgsql as $$
declare f record; snap jsonb;
begin
  select * into strict f from selection_movie_fixture;
  snap:=public.norva_get_catalog_write_snapshot(f.source_id,f.owner_id)||overrides;
  return public.hydrate_selection_snapshot_movie_languages(f.owner_id,f.source_id,
    (snap->>'generationId')::uuid,(snap->>'headRevision')::bigint,(snap->>'configRevision')::bigint,
    (snap->>'sourceVisibilityEpoch')::bigint,(snap->>'userVisibilityEpoch')::bigint,files);
end $$;

do $tests$
declare f record; i integer; changed integer; before_cache jsonb; before_observations jsonb;
begin
  select * into strict f from selection_movie_fixture;
  perform pg_temp.movie_assert(not has_function_privilege('anon',
    'public.hydrate_selection_snapshot_movie_languages(uuid,uuid,uuid,bigint,bigint,bigint,bigint,jsonb)','EXECUTE'),'anon ACL');
  perform pg_temp.movie_assert(not has_function_privilege('authenticated',
    'public.hydrate_selection_snapshot_movie_languages(uuid,uuid,uuid,bigint,bigint,bigint,bigint,jsonb)','EXECUTE'),'authenticated ACL');
  perform pg_temp.movie_assert(has_function_privilege('service_role',
    'public.hydrate_selection_snapshot_movie_languages(uuid,uuid,uuid,bigint,bigint,bigint,bigint,jsonb)','EXECUTE'),'service ACL');
  select jsonb_agg(to_jsonb(c) order by external_id) into before_cache from public.catalog_file_tracks c where server_host='source:'||f.source_id;
  changed:=pg_temp.seed_movies(f.files);
  perform pg_temp.movie_assert(changed=5,'only five eligible missing observations inserted');
  perform pg_temp.movie_assert((select audio_languages=array['es'] and audio_verified_at is null
    from public.cloud_title_file_language_observations where user_id=f.owner_id and file_external_id='norva-selection:movie:'||lpad('1',64,'0')),'snapshot is probed not verified');
  perform pg_temp.movie_assert((select audio_languages=array['en'] and audio_verified_at is not null
    from public.cloud_title_file_language_observations where user_id=f.owner_id and file_external_id='norva-selection:movie:'||lpad('3',64,'0')),'stronger exact URL certificate wins');
  perform pg_temp.movie_assert((select audio_languages='{}' and audio_observed from public.cloud_title_file_language_observations
    where user_id=f.owner_id and file_external_id='norva-selection:movie:'||lpad('6',64,'0')),'existing unknown observation preserved');
  perform pg_temp.movie_assert((select audio_languages='{}' and audio_observed from public.cloud_title_file_language_observations
    where user_id=f.owner_id and file_external_id='norva-selection:movie:'||lpad('11',64,'0')),'later unknown exact cache preserved');
  perform pg_temp.movie_assert((select count(*)=2 from public.cloud_title_file_language_observations
    where user_id=f.owner_id and file_external_id like 'norva-selection:movie:'||lpad('10',64,'0')||'%'),'unrelated file observation does not suppress repair');
  perform pg_temp.movie_assert(before_cache=(select jsonb_agg(to_jsonb(c) order by external_id) from public.catalog_file_tracks c
    where server_host='source:'||f.source_id and right(external_id,2)::integer in (2,3,4,5,11)),'all prior cache rows byte-preserved');
  select jsonb_agg(to_jsonb(o) order by variant_id,file_external_id) into before_observations
    from public.cloud_title_file_language_observations o where user_id=f.owner_id;
  perform pg_temp.movie_assert(pg_temp.seed_movies(f.files)=0,'idempotent replay count');
  perform pg_temp.movie_assert(before_observations=(select jsonb_agg(to_jsonb(o) order by variant_id,file_external_id)
    from public.cloud_title_file_language_observations o where user_id=f.owner_id),'idempotent byte-preservation');
  for i in 1..5 loop
    begin
      perform pg_temp.seed_movies(f.files,jsonb_build_object((array['generationId','headRevision','configRevision','sourceVisibilityEpoch','userVisibilityEpoch'])[i],
        case when i=1 then '98730000-0000-4000-8000-000000000099' else '999999999' end));
      raise exception 'stale fence accepted';
    exception when sqlstate 'PT409' then null; end;
  end loop;
  begin
    perform pg_temp.seed_movies(f.files||f.files);raise exception 'duplicate manifest accepted';
  exception when sqlstate '22023' then null;end;
  begin
    perform pg_temp.seed_movies(jsonb_build_array(jsonb_set(f.files->0,'{audioTracks}','[{"index":1,"lang":"und"}]')));
    raise exception 'unknown manifest accepted';
  exception when sqlstate '22023' then null;end;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claims','{"role":"authenticated"}',true);
  begin
    perform pg_temp.seed_movies(f.files);raise exception 'non-service caller accepted';
  exception when sqlstate '42501' then null;end;
end $tests$;
select jsonb_build_object('selection_movie_hydration','passed','production_data_used',false);
rollback;
