-- Run only on a disposable schema-only DB. Synthetic rows always roll back.
begin;
do $$ begin
  if current_database()<>'norva_language_remediation_test_20260913' then
    raise exception 'This fixture is restricted to its disposable database';
  end if;
end $$;
set local lock_timeout='3s';
set local statement_timeout='30s';
create temp table series_checks(label text primary key);
create function pg_temp.series_assert(ok boolean,label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Selection series assertion: %',label; end if;
  insert into series_checks values(label);
end $$;
create temp table series_fixture(i integer,owner_id uuid,source_id uuid,generation_id uuid,
  title_id uuid,variant_id uuid,media_id uuid,episode_id uuid,parent_external_id text,file_external_id text,
  episode_metadata jsonb,parent_metadata jsonb,url text);

insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values('98740000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','selection-series-fixture@invalid.test','',now(),'{}','{}',now(),now());

do $fixture$
declare
  u uuid:='98740000-0000-4000-8000-000000000001'; s uuid; other_s uuid:='98740000-0000-4000-8000-000000000002';
  h text; g uuid; chosen_s uuid; m uuid; e uuid; t uuid; v uuid; ext text; file_ext text;
  url text; metadata jsonb; parent_metadata jsonb; kind text; i integer;
begin
  h:=encode(sha256(convert_to('norva-selection-curated-v1:'||u::text,'UTF8')),'hex');
  s:=(substr(h,1,8)||'-'||substr(h,9,4)||'-4'||substr(h,14,3)||'-a'||substr(h,18,3)||'-'||substr(h,21,12))::uuid;
  insert into public.cloud_sources(id,user_id,source_type,display_name,config_ciphertext,config_hint,sync_status,catalog_version,enabled,last_synced_at)
  values(s,u,'m3u','Synthetic Selection series','cipher','{}','ready',1,true,now()),
    (other_s,u,'xtream','Synthetic other provider','cipher','{}','ready',1,true,now());
  for i in 1..4 loop
    chosen_s:=case when i=4 then other_s else s end;
    select active_generation_id into strict g from public.cloud_source_catalog_heads where source_id=chosen_s and user_id=u;
    m:=gen_random_uuid();e:=gen_random_uuid();t:=gen_random_uuid();v:=gen_random_uuid();
    kind:=case when i in (1,4) then 'series' else 'movie' end;
    ext:='norva-selection:'||kind||':'||lpad(i::text,64,'0');
    file_ext:=case when i=2 then ext else 'norva-selection:movie:'||lpad((i+100)::text,64,'0') end;
    url:='https://fixture.invalid/episode-'||i||'.mp4';
    parent_metadata:=jsonb_build_object('seriesDelivery','selection','selectionRevision','selection-vod-20260906-v1','discoveryFeed','fixture-audited-feed');
    metadata:=parent_metadata||jsonb_build_object('selectionParentId',ext,'codecProfile',
      jsonb_build_object('audioTracks','[{"index":1,"lang":"es","codec":"aac"}]'::jsonb),
      'selectionPlaybackValidation',jsonb_build_object('urlSha256',encode(sha256(convert_to(url,'UTF8')),'hex'),
      'containerMetadataCheckedAt','2026-09-07T00:00:00Z'));
    insert into public.cloud_titles(id,user_id,item_type,identity_key,identity_source,match_status,title,metadata)
      values(t,u,kind,'selection-series-test:'||i,'normalized','unmatched','Synthetic item '||i,'{}');
    insert into public.cloud_media_items(id,user_id,source_id,generation_id,item_type,external_id,title,available,metadata,playback_hint)
      values(m,u,chosen_s,g,kind,ext,'Synthetic parent '||i,true,parent_metadata,jsonb_build_object('targetUrl',url));
    if kind='series' then
      insert into public.cloud_media_items(id,user_id,source_id,generation_id,item_type,external_id,parent_external_id,title,available,metadata,playback_hint)
        values(e,u,chosen_s,g,'episode',file_ext,ext,'Synthetic episode '||i,true,metadata,jsonb_build_object('targetUrl',url));
    end if;
    insert into public.cloud_title_variants(id,user_id,title_id,source_id,generation_id,media_item_id,item_type,external_id,raw_title,metadata)
      values(v,u,t,chosen_s,g,m,kind,ext,'Synthetic item '||i,parent_metadata);
    insert into public.cloud_title_file_language_observations(user_id,title_id,variant_id,file_external_id,audio_languages,audio_observed,subtitle_languages,subtitle_observed)
      values(u,t,v,file_ext,array['es'],true,'{}',false);
    insert into series_fixture values(i,u,chosen_s,g,t,v,m,e,ext,file_ext,metadata,parent_metadata,url);
  end loop;
end $fixture$;

create function pg_temp.series_count() returns bigint language sql as $$
  select count(*) from series_fixture f cross join lateral
    public.cloud_catalog_selection_series_observed_audio_languages(f.owner_id,f.source_id) x
  where f.i=1 and x.variant_id=f.variant_id
$$;

do $tests$
declare f record; other record; bad_tracks jsonb; scenario text;
  stale_generation uuid:='98740000-0000-4000-8000-000000000099';
begin
  select * into strict f from series_fixture where i=1;
  select * into strict other from series_fixture where i=4;
  perform pg_temp.series_assert(pg_temp.series_count()=1,'owned current Selection episode accepted');
  perform pg_temp.series_assert((select array_agg(language)=array['es'] from public.cloud_catalog_effective_audio_languages(f.owner_id,'series',f.source_id,null)),'effective series ES');
  perform pg_temp.series_assert((select count(*)=0 from public.cloud_catalog_unidentified_audio_variants(f.owner_id,'series',f.source_id)),'unknown facet excludes qualified parent');
  perform pg_temp.series_assert((select count(*)=0 from public.cloud_catalog_selection_series_observed_audio_languages(f.owner_id,other.source_id)),'noncanonical source rejected');
  perform pg_temp.series_assert((select count(*)=0 from public.cloud_catalog_effective_audio_languages(f.owner_id,'series',other.source_id,null)),'generic Xtream episode union unchanged');
  perform pg_temp.series_assert((select count(*)=0 from public.cloud_catalog_selection_series_observed_audio_languages('98740000-0000-4000-8000-000000000099',null)),'wrong owner rejected');
  perform pg_temp.series_assert((select count(*)=1 from public.cloud_catalog_effective_audio_languages(f.owner_id,'movie',f.source_id,null)),'movie exact file only; unrelated file excluded');
  perform pg_temp.series_assert(not has_function_privilege('anon','public.cloud_catalog_selection_series_observed_audio_languages(uuid,uuid)','EXECUTE'),'anon helper denied');
  perform pg_temp.series_assert(not has_function_privilege('authenticated','public.cloud_catalog_selection_series_observed_audio_languages(uuid,uuid)','EXECUTE'),'authenticated helper denied');
  perform pg_temp.series_assert(has_function_privilege('service_role','public.cloud_catalog_selection_series_observed_audio_languages(uuid,uuid)','EXECUTE'),'service helper allowed');

  insert into public.cloud_catalog_provider_language_hints(variant_id,user_id,title_id,source_id,item_type,language)
    values(f.variant_id,f.owner_id,f.title_id,f.source_id,'series','fr') on conflict(variant_id) do update set language='fr';
  perform pg_temp.series_assert((select count(*)=0 from public.cloud_catalog_effective_audio_languages(f.owner_id,'series',f.source_id,'fr')),'ES observation vetoes conflicting FR hint even under FR filter');
  perform pg_temp.series_assert((select count(*)=1 from public.cloud_catalog_effective_audio_languages(f.owner_id,'series',f.source_id,'es')),'ES filter uses same qualified set');
  delete from public.cloud_catalog_provider_language_hints where variant_id=f.variant_id;

  update public.cloud_title_file_language_observations set audio_observed=false,audio_languages='{}' where variant_id=f.variant_id;
  perform pg_temp.series_assert(pg_temp.series_count()=0,'metadata alone is insufficient');
  update public.cloud_title_file_language_observations set audio_observed=true,audio_languages=array['und'] where variant_id=f.variant_id;
  perform pg_temp.series_assert(pg_temp.series_count()=0,'und observation is insufficient');
  update public.cloud_title_file_language_observations set audio_languages=array['en'] where variant_id=f.variant_id;
  perform pg_temp.series_assert(pg_temp.series_count()=0,'observation versus current file disagreement rejected');
  update public.cloud_title_file_language_observations set audio_languages=array['spa'] where variant_id=f.variant_id;
  perform pg_temp.series_assert(pg_temp.series_count()=1,'canonical observed alias accepted');
  update public.cloud_title_file_language_observations set audio_languages=array['es'] where variant_id=f.variant_id;

  foreach scenario in array array['revision','feed','parent','missing checked date','wrong URL digest','missing tracks','und tracks','unindexed tracks','duplicate indexes'] loop
    update public.cloud_media_items set metadata=case scenario
      when 'revision' then jsonb_set(f.episode_metadata,'{selectionRevision}','"obsolete"')
      when 'feed' then jsonb_set(f.episode_metadata,'{discoveryFeed}','"another-feed"')
      when 'parent' then jsonb_set(f.episode_metadata,'{selectionParentId}','"wrong-parent"')
      when 'missing checked date' then f.episode_metadata #- '{selectionPlaybackValidation,containerMetadataCheckedAt}'
      when 'wrong URL digest' then jsonb_set(f.episode_metadata,'{selectionPlaybackValidation,urlSha256}',to_jsonb(repeat('f',64)))
      when 'missing tracks' then f.episode_metadata #- '{codecProfile,audioTracks}'
      when 'und tracks' then jsonb_set(f.episode_metadata,'{codecProfile,audioTracks}','[{"index":1,"lang":"und"}]')
      when 'unindexed tracks' then jsonb_set(f.episode_metadata,'{codecProfile,audioTracks}','[{"lang":"es"}]')
      when 'duplicate indexes' then jsonb_set(f.episode_metadata,'{codecProfile,audioTracks}','[{"index":1,"lang":"es"},{"index":1,"lang":"es"}]') end
      where id=f.episode_id;
    perform pg_temp.series_assert(pg_temp.series_count()=0,'episode '||scenario||' rejected');
  end loop;
  update public.cloud_media_items set metadata=f.episode_metadata where id=f.episode_id;
  update public.cloud_media_items set parent_external_id='wrong-parent' where id=f.episode_id;
  perform pg_temp.series_assert(pg_temp.series_count()=0,'wrong relational parent rejected');
  update public.cloud_media_items set parent_external_id=f.parent_external_id,available=false where id=f.episode_id;
  perform pg_temp.series_assert(pg_temp.series_count()=0,'unavailable episode rejected');
  update public.cloud_media_items set available=true,playback_hint='{"targetUrl":"https://fixture.invalid/replaced.mp4"}' where id=f.episode_id;
  perform pg_temp.series_assert(pg_temp.series_count()=0,'changed current target URL rejected');
  update public.cloud_media_items set playback_hint=jsonb_build_object('targetUrl',f.url) where id=f.episode_id;
  update public.cloud_media_items set available=false where id=f.media_id;
  perform pg_temp.series_assert(pg_temp.series_count()=0,'unavailable parent rejected');
  update public.cloud_media_items set available=true where id=f.media_id;
  update public.cloud_title_variants set metadata=jsonb_set(f.parent_metadata,'{seriesDelivery}','"xtream"') where id=f.variant_id;
  perform pg_temp.series_assert(pg_temp.series_count()=0,'non Selection delivery rejected');
  update public.cloud_title_variants set metadata=f.parent_metadata where id=f.variant_id;

  insert into public.catalog_file_tracks(server_host,item_type,external_id,audio_tracks,subtitle_tracks,audio_probed_at,audio_lang_verification)
    values('source:'||f.source_id,'episode',f.file_external_id,'[{"index":1,"lang":"es"}]','[]',now(),'{}');
  perform pg_temp.series_assert(pg_temp.series_count()=1,'matching observed episode cache accepted');
  update public.catalog_file_tracks set audio_lang_verification=jsonb_build_object('urlSha256',repeat('f',64)) where server_host='source:'||f.source_id;
  perform pg_temp.series_assert(pg_temp.series_count()=0,'same-language cache with wrong URL digest rejected');
  update public.catalog_file_tracks set audio_lang_verification='{}',audio_tracks='[{"index":1,"lang":"en"}]' where server_host='source:'||f.source_id;
  perform pg_temp.series_assert(pg_temp.series_count()=0,'current observed cache language disagreement rejected');
  update public.catalog_file_tracks set audio_tracks='[{"index":1,"lang":"und"}]' where server_host='source:'||f.source_id;
  perform pg_temp.series_assert(pg_temp.series_count()=0,'later unknown cache does not revive old language');
  update public.catalog_file_tracks set audio_tracks='[{"lang":"es"}]' where server_host='source:'||f.source_id;
  perform pg_temp.series_assert(pg_temp.series_count()=0,'unindexed observed cache rejected');
  delete from public.catalog_file_tracks where server_host='source:'||f.source_id;
  perform pg_temp.series_assert(pg_temp.series_count()=1,'missing cache allowed by owned snapshot proof');

  -- Generation is part of both the episode membership and visibility proof.
  -- The write guard prevents new stale-generation writes. Construct an older
  -- retained generation and simulate pre-existing membership only for these
  -- synthetic mutations, in this explicitly guarded disposable transaction.
  insert into public.cloud_source_catalog_generations(id,user_id,source_id,config_revision,state)
    select stale_generation,f.owner_id,f.source_id,config_revision,'retained'
    from public.cloud_source_catalog_generations where id=f.generation_id;
  perform set_config('session_replication_role','replica',true);
  update public.cloud_media_items set generation_id=stale_generation where id=f.episode_id;
  perform set_config('session_replication_role','origin',true);
  perform pg_temp.series_assert(pg_temp.series_count()=0,'stale generation episode rejected');
  perform set_config('session_replication_role','replica',true);
  update public.cloud_media_items set generation_id=f.generation_id where id=f.episode_id;
  update public.cloud_source_catalog_heads set active_generation_id=stale_generation where source_id=f.source_id;
  perform set_config('session_replication_role','origin',true);
  perform pg_temp.series_assert(pg_temp.series_count()=0,'stale generation parent rejected');
  perform set_config('session_replication_role','replica',true);
  update public.cloud_source_catalog_heads set active_generation_id=f.generation_id where source_id=f.source_id;
  perform set_config('session_replication_role','origin',true);
  perform pg_temp.series_assert(pg_temp.series_count()=1,'all baseline guards restored');
end $tests$;
select jsonb_build_object('passed',count(*),'checks',jsonb_agg(label order by label)) from series_checks;
rollback;
