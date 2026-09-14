-- Synthetic mutation proof, never a production script. All rows roll back.
begin;
do $$ begin
  if current_database()<>'norva_series_episode_projection_test_20260914' then
    raise exception 'Fixture requires its dedicated disposable database';
  end if;
end $$;
set local statement_timeout='30s';
create temp table episode_checks(label text primary key);
create function pg_temp.episode_assert(ok boolean,label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Episode projection assertion: %',label; end if;
  insert into episode_checks values(label);
end $$;
create temp table episode_fixture(user_id uuid,source_id uuid,generation_id uuid,title_id uuid,
  variant_id uuid,media_id uuid,identity_id uuid);
insert into episode_fixture values('11100000-0000-4000-8000-000000000001',
  '11100000-0000-4000-8000-000000000002','11100000-0000-4000-8000-000000000003',
  '11100000-0000-4000-8000-000000000004','11100000-0000-4000-8000-000000000005',
  '11100000-0000-4000-8000-000000000006','11100000-0000-4000-8000-000000000007');
insert into public.cloud_sources select source_id,user_id,true from episode_fixture;
insert into public.cloud_source_catalog_heads select source_id,user_id,generation_id from episode_fixture;
insert into public.cloud_titles select title_id,user_id,'series' from episode_fixture;
insert into public.cloud_media_items(id,user_id,source_id,generation_id,item_type,external_id)
  select media_id,user_id,source_id,generation_id,'series','series-1' from episode_fixture;
insert into public.cloud_title_variants(id,user_id,source_id,generation_id,title_id,media_item_id,item_type,external_id)
  select variant_id,user_id,source_id,generation_id,title_id,media_id,'series','series-1' from episode_fixture;
insert into public.cloud_title_file_language_observations(user_id,title_id,variant_id,file_external_id,audio_languages)
  select user_id,title_id,variant_id,'episode-1',array['es'] from episode_fixture;
insert into public.catalog_series_episode_memberships
  select user_id,source_id,generation_id,identity_id,title_id,variant_id,'series-1','series','episode-1' from episode_fixture;
insert into public.catalog_source_provider_identities(user_id,source_id,identity_id)
  select user_id,source_id,identity_id from episode_fixture;
insert into public.catalog_file_tracks(server_host,item_type,external_id,audio_tracks,audio_probed_at)
  select identity_id::text,'episode','episode-1','[{"index":1,"lang":"es"}]',now() from episode_fixture;
insert into public.cloud_catalog_provider_language_hints
  select variant_id,user_id,title_id,source_id,'series','fr' from episode_fixture;
create function pg_temp.episode_languages() returns text[] language sql as $$
  select coalesce(array_agg(distinct x.language order by x.language),'{}'::text[])
  from episode_fixture f cross join lateral public.cloud_catalog_effective_audio_languages(f.user_id,'series',f.source_id,null) x
$$;

do $tests$
declare f record; tracks jsonb; scenario text;
  other uuid:='11100000-0000-4000-8000-000000000099';
begin
  select * into strict f from episode_fixture;
  perform pg_temp.episode_assert(pg_temp.episode_languages()=array['es'],'different episode ID projects ES to owned parent');
  perform pg_temp.episode_assert((select count(*)=0 from public.cloud_catalog_effective_audio_languages(f.user_id,'series',f.source_id,'fr')),'observed ES vetoes FR hint under FR filter');
  perform pg_temp.episode_assert((select count(*)=1 from public.cloud_catalog_effective_audio_languages(f.user_id,'series',f.source_id,'es')),'ES filter agrees with count projection');
  perform pg_temp.episode_assert((select count(*)=0 from public.cloud_catalog_xtream_series_episode_audio_evidence(other,null)),'wrong owner cannot read episode evidence');
  perform pg_temp.episode_assert((select count(*)=0 from public.cloud_catalog_xtream_series_episode_audio_evidence(f.user_id,other)),'wrong source cannot read episode evidence');
  perform pg_temp.episode_assert((select count(*)=0 from public.cloud_catalog_effective_audio_languages(f.user_id,'movie',f.source_id,null)),'series episode never becomes movie language');
  foreach scenario in array array['und','mixed','empty','duplicate index','missing index','conflicting language'] loop
    tracks:=case scenario when 'und' then '[{"index":1,"lang":"und"}]'::jsonb
      when 'mixed' then '[{"index":1,"lang":"es"},{"index":2,"lang":"und"}]'::jsonb
      when 'empty' then '[]'::jsonb
      when 'duplicate index' then '[{"index":1,"lang":"es"},{"index":1,"lang":"es"}]'::jsonb
      when 'missing index' then '[{"lang":"es"}]'::jsonb
      else '[{"index":1,"lang":"en"}]'::jsonb end;
    update public.catalog_file_tracks set audio_tracks=tracks;
    perform pg_temp.episode_assert(pg_temp.episode_languages()=array['fr'],'cache '||scenario||' keeps declaration without observed promotion');
    perform pg_temp.episode_assert((select count(*)=0 from public.cloud_catalog_xtream_series_episode_audio_evidence(f.user_id,f.source_id)),
      'cache '||scenario||' yields no observed audio');
  end loop;
  update public.catalog_file_tracks set audio_tracks='[{"index":1,"lang":"es"}]',audio_probed_at=null;
  perform pg_temp.episode_assert(pg_temp.episode_languages()=array['fr'],'unprobed cache keeps declaration only');
  update public.catalog_file_tracks set audio_probed_at=now();
  update public.cloud_title_variants set external_id='episode-1' where id=f.variant_id;
  update public.cloud_media_items set external_id='episode-1' where id=f.media_id;
  update public.catalog_series_episode_memberships set parent_series_id='episode-1';
  update public.catalog_file_tracks set audio_tracks='[{"index":1,"lang":"und"}]';
  perform pg_temp.episode_assert(pg_temp.episode_languages()=array['fr'],'coincident parent episode IDs cannot masquerade as observed parent audio');
  update public.cloud_title_variants set external_id='series-1' where id=f.variant_id;
  update public.cloud_media_items set external_id='series-1' where id=f.media_id;
  update public.catalog_series_episode_memberships set parent_series_id='series-1';
  update public.catalog_file_tracks set audio_tracks='[{"index":1,"lang":"es"}]';
  update public.catalog_file_tracks set external_id='not-this-file';
  perform pg_temp.episode_assert(pg_temp.episode_languages()=array['fr'],'missing exact cache preserves existing declaration');
  update public.catalog_file_tracks set external_id='episode-1';
  update public.cloud_title_file_language_observations set audio_languages=array['und'];
  perform pg_temp.episode_assert(pg_temp.episode_languages()=array['fr'],'unknown exact observation is no observed promotion and no disproof of declaration');
  update public.cloud_title_file_language_observations set audio_languages=array['es','und'];
  perform pg_temp.episode_assert(pg_temp.episode_languages()=array['fr'],'mixed observation keeps declaration without promotion');
  update public.cloud_title_file_language_observations set audio_languages=array['spa'];
  perform pg_temp.episode_assert(pg_temp.episode_languages()=array['es'],'canonical observed alias accepted');
  update public.cloud_title_file_language_observations set audio_languages=array['es'];

  -- Missing trusted linkage is NOT observation evidence; provider hint behavior
  -- remains separate, so assert the helper directly for identity/ownership gates.
  update public.catalog_source_provider_identities set identity_id=other;
  perform pg_temp.episode_assert((select count(*)=0 from public.cloud_catalog_xtream_series_episode_audio_evidence(f.user_id,f.source_id)),'wrong provider identity rejected');
  update public.catalog_source_provider_identities set identity_id=f.identity_id,verified_at=null;
  perform pg_temp.episode_assert((select count(*)=0 from public.cloud_catalog_xtream_series_episode_audio_evidence(f.user_id,f.source_id)),'unverified identity rejected');
  update public.catalog_source_provider_identities set verified_at=now();
  update public.catalog_series_episode_memberships set generation_id=other;
  perform pg_temp.episode_assert((select count(*)=0 from public.cloud_catalog_xtream_series_episode_audio_evidence(f.user_id,f.source_id)),'stale generation membership rejected');
  update public.catalog_series_episode_memberships set generation_id=f.generation_id,parent_title_id=other;
  perform pg_temp.episode_assert((select count(*)=0 from public.cloud_catalog_xtream_series_episode_audio_evidence(f.user_id,f.source_id)),'wrong title membership rejected');
  update public.catalog_series_episode_memberships set parent_title_id=f.title_id,parent_variant_id=other;
  perform pg_temp.episode_assert((select count(*)=0 from public.cloud_catalog_xtream_series_episode_audio_evidence(f.user_id,f.source_id)),'wrong variant membership rejected');
  update public.catalog_series_episode_memberships set parent_variant_id=f.variant_id,parent_series_id='other-series';
  perform pg_temp.episode_assert((select count(*)=0 from public.cloud_catalog_xtream_series_episode_audio_evidence(f.user_id,f.source_id)),'wrong relational series rejected');
  update public.catalog_series_episode_memberships set parent_series_id='series-1';
  update public.cloud_media_items set available=false;
  perform pg_temp.episode_assert((select count(*)=0 from public.cloud_catalog_xtream_series_episode_audio_evidence(f.user_id,f.source_id)),'unavailable parent media rejected');
  update public.cloud_media_items set available=true;

  update public.catalog_file_tracks set observed_profile_fingerprint=repeat('a',64),
    observed_profile_probed_at=now(),observed_profile_snapshot='{"audioTracks":[{"index":1}],"fileSizeBytes":1000}';
  perform pg_temp.episode_assert(pg_temp.episode_languages()=array['es'],'matching current profile accepted without speech certification');
  update public.catalog_file_tracks set observed_profile_snapshot='{"audioTracks":[{"index":2}],"fileSizeBytes":1000}';
  perform pg_temp.episode_assert(pg_temp.episode_languages()=array['fr'],'changed profile audio indexes reject stale observation but keep declaration');
  update public.catalog_file_tracks set observed_profile_snapshot='{"audioTracks":[{"index":1}],"fileSizeBytes":1000}',observed_profile_probed_at=now()+interval '1 day';
  perform pg_temp.episode_assert(pg_temp.episode_languages()=array['fr'],'newer profile rejects older cache timestamp but keeps declaration');
  update public.catalog_file_tracks set observed_profile_probed_at=now(),audio_lang_verified_at=now(),
    audio_lang_verification=jsonb_build_object('profileFingerprint',repeat('b',64),'fileSizeBytes',1000);
  perform pg_temp.episode_assert(pg_temp.episode_languages()=array['fr'],'cache certificate mismatched fingerprint is not promoted');
  update public.catalog_file_tracks set audio_lang_verification=jsonb_build_object('profileFingerprint',repeat('a',64),'fileSizeBytes',1000);
  update public.cloud_title_file_language_observations set audio_verified_at=now(),audio_verification=jsonb_build_object('profileFingerprint',repeat('b',64));
  perform pg_temp.episode_assert(pg_temp.episode_languages()=array['fr'],'owner certificate mismatched fingerprint is not promoted');
  update public.cloud_title_file_language_observations set audio_verification=jsonb_build_object('profileFingerprint',repeat('a',64));
  perform pg_temp.episode_assert(pg_temp.episode_languages()=array['es'],'concordant exact certificates accepted');

  insert into public.cloud_title_file_language_observations(user_id,title_id,variant_id,file_external_id,audio_languages)
    values(f.user_id,f.title_id,f.variant_id,'episode-2','{}');
  insert into public.catalog_series_episode_memberships values(f.user_id,f.source_id,f.generation_id,f.identity_id,f.title_id,f.variant_id,'series-1','series','episode-2');
  perform pg_temp.episode_assert(pg_temp.episode_languages()=array['es'],'one unknown episode does not erase another observed episode language');
  insert into public.cloud_sources values(other,other,true);
  insert into public.cloud_source_catalog_heads values(other,other,other);
  insert into public.cloud_titles values(other,other,'series');
  insert into public.cloud_title_variants(id,user_id,source_id,generation_id,title_id,media_item_id,item_type,external_id)
    values(other,other,other,other,other,other,'series','another-parent');
  insert into public.catalog_source_provider_identities(user_id,source_id,identity_id) values(other,other,f.identity_id);
  insert into public.catalog_series_episode_memberships values(other,other,other,f.identity_id,other,other,'another-parent','series','episode-1');
  perform pg_temp.episode_assert(pg_temp.episode_languages()=array['fr'],'ambiguous canonical episode not promoted while declaration remains');
  update public.cloud_sources set enabled=false where id=other;
  perform pg_temp.episode_assert(pg_temp.episode_languages()=array['es'],'inactive competing parent cannot poison current mapping');
  update public.cloud_sources set enabled=true where id=other;
  update public.catalog_source_provider_identities set verified_at=null where source_id=other;
  perform pg_temp.episode_assert(pg_temp.episode_languages()=array['es'],'unverified competing identity cannot poison current mapping');
  perform pg_temp.episode_assert(not has_function_privilege('anon','public.cloud_catalog_xtream_series_episode_audio_evidence(uuid,uuid)','EXECUTE'),'anon denied');
  perform pg_temp.episode_assert(not has_function_privilege('authenticated','public.cloud_catalog_xtream_series_episode_audio_evidence(uuid,uuid)','EXECUTE'),'authenticated denied');
  perform pg_temp.episode_assert(has_function_privilege('service_role','public.cloud_catalog_xtream_series_episode_audio_evidence(uuid,uuid)','EXECUTE'),'service role allowed');
end $tests$;

-- JSONB equality treats 1 and 1.0 as equal; the textual index guard does not.
-- Both maps must coexist without memoizing the valid result onto the other.
do $numeric_maps$
declare f record; second uuid:='11100000-0000-4000-8000-000000000088';
begin
  select * into strict f from episode_fixture;
  insert into public.cloud_titles values(second,f.user_id,'series');
  insert into public.cloud_media_items(id,user_id,source_id,generation_id,item_type,external_id)
    values(second,f.user_id,f.source_id,f.generation_id,'series','series-3');
  insert into public.cloud_title_variants(id,user_id,source_id,generation_id,title_id,media_item_id,item_type,external_id)
    values(second,f.user_id,f.source_id,f.generation_id,second,second,'series','series-3');
  insert into public.cloud_title_file_language_observations(user_id,title_id,variant_id,file_external_id,audio_languages)
    values(f.user_id,second,second,'episode-3',array['es']);
  insert into public.catalog_series_episode_memberships
    values(f.user_id,f.source_id,f.generation_id,f.identity_id,second,second,'series-3','series','episode-3');
  insert into public.catalog_file_tracks(server_host,item_type,external_id,audio_tracks,audio_probed_at)
    values(f.identity_id::text,'episode','episode-3','[{"index":1.0,"lang":"es"}]',now());
  insert into public.cloud_catalog_provider_language_hints values(second,f.user_id,second,f.source_id,'series','fr');
  perform pg_temp.episode_assert((select array_agg(language)=array['fr']
    from public.cloud_catalog_effective_audio_languages(f.user_id,'series',f.source_id,null) where variant_id=second),
    'decimal index cannot share integer track-map validation');
  perform pg_temp.episode_assert((select array_agg(language)=array['es']
    from public.cloud_catalog_effective_audio_languages(f.user_id,'series',f.source_id,null) where variant_id=f.variant_id),
    'integer index remains valid beside equal JSONB decimal map');
  update public.catalog_file_tracks set audio_tracks='[{"index":1.0,"lang":"es"}]' where external_id='episode-1';
  update public.catalog_file_tracks set audio_tracks='[{"index":1,"lang":"es"}]' where external_id='episode-3';
  perform pg_temp.episode_assert((select array_agg(language)=array['fr']
    from public.cloud_catalog_effective_audio_languages(f.user_id,'series',f.source_id,null) where variant_id=f.variant_id),
    'reversed decimal index remains unqualified');
  perform pg_temp.episode_assert((select array_agg(language)=array['es']
    from public.cloud_catalog_effective_audio_languages(f.user_id,'series',f.source_id,null) where variant_id=second),
    'reversed integer index remains qualified');
end $numeric_maps$;

-- Valid re-enrolled Selection source, not the historical deterministic UUID.
do $selection$
declare u uuid:='22200000-0000-4000-8000-000000000001'; s uuid; g uuid:=gen_random_uuid();
  t uuid:=gen_random_uuid(); v uuid:=gen_random_uuid(); m uuid:=gen_random_uuid(); e uuid:=gen_random_uuid();
  h text; ext text:='norva-selection:series:'||repeat('a',64); ep text:='norva-selection:movie:'||repeat('b',64);
  meta jsonb; url text:='https://fixture.invalid/episode.mp4'; n bigint;
begin
  h:=encode(sha256(convert_to('norva-selection-enrolment-v1:1:'||u::text,'UTF8')),'hex');
  s:=(substr(h,1,8)||'-'||substr(h,9,4)||'-4'||substr(h,14,3)||'-a'||substr(h,18,3)||'-'||substr(h,21,4)||'00000001')::uuid;
  perform pg_temp.episode_assert(public.norva_selection_source_identity_valid(s,u),'real Selection re-enrolment identity accepted');
  meta:=jsonb_build_object('seriesDelivery','selection','selectionRevision','selection-vod-20260906-v1','discoveryFeed','fixture');
  insert into public.cloud_sources values(s,u,true);
  insert into public.cloud_source_catalog_heads values(s,u,g);
  insert into public.cloud_titles values(t,u,'series');
  insert into public.cloud_media_items(id,user_id,source_id,generation_id,item_type,external_id,metadata)
    values(m,u,s,g,'series',ext,meta);
  insert into public.cloud_title_variants values(v,u,s,g,t,m,'series',ext,meta);
  insert into public.cloud_media_items(id,user_id,source_id,generation_id,item_type,external_id,parent_external_id,metadata,playback_hint)
    values(e,u,s,g,'episode',ep,ext,meta||jsonb_build_object('selectionParentId',ext,
      'codecProfile',jsonb_build_object('audioTracks','[{"index":1,"lang":"es"}]'::jsonb),
      'selectionPlaybackValidation',jsonb_build_object('urlSha256',encode(sha256(convert_to(url,'UTF8')),'hex'),
        'containerMetadataCheckedAt','2026-09-13T00:00:00Z')),jsonb_build_object('targetUrl',url));
  insert into public.cloud_title_file_language_observations(user_id,title_id,variant_id,file_external_id,audio_languages) values(u,t,v,ep,array['es']);
  insert into public.cloud_catalog_provider_language_hints values(v,u,t,s,'series','fr');
  select count(*) into n from public.cloud_catalog_selection_series_observed_audio_languages(u,s) where language='es';
  perform pg_temp.episode_assert(n=1,'re-enrolled owned Selection episode projects ES');
  perform pg_temp.episode_assert((select count(*)=0 from public.cloud_catalog_effective_audio_languages(u,'series',s,'fr')),'re-enrolled ES vetoes FR hint');
  insert into public.catalog_file_tracks(server_host,item_type,external_id,audio_tracks,audio_probed_at)
    values('source:'||s::text,'episode',ep,'[{"index":1,"lang":"und"}]',now());
  perform pg_temp.episode_assert((select array_agg(language)=array['fr'] from public.cloud_catalog_effective_audio_languages(u,'series',s,null)),
    'Selection unknown cache suppresses observed promotion but keeps declaration');
  update public.catalog_file_tracks set audio_tracks='[{"index":1,"lang":"es"},{"index":2,"lang":"und"}]' where server_host='source:'||s::text;
  perform pg_temp.episode_assert((select array_agg(language)=array['fr'] from public.cloud_catalog_effective_audio_languages(u,'series',s,null)),
    'Selection incomplete observed cache keeps declaration without promotion');
  update public.catalog_file_tracks set audio_tracks='[{"index":1,"lang":"es"}]' where server_host='source:'||s::text;
  perform pg_temp.episode_assert((select count(*)=1 from public.cloud_catalog_effective_audio_languages(u,'series',s,null)),'Selection restored concordant file accepted');
  update public.cloud_media_items set generation_id=gen_random_uuid() where id=e;
  perform pg_temp.episode_assert((select count(*)=0 from public.cloud_catalog_selection_series_observed_audio_languages(u,s)),'Selection stale episode generation rejected');
end $selection$;
select jsonb_build_object('passed',count(*),'checks',jsonb_agg(label order by label)) from episode_checks;
rollback;
