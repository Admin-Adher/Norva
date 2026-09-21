-- Synthetic ownership fixtures, always rolled back. No provider/network calls.
begin;
set local lock_timeout='2s';
set local statement_timeout='30s';
create temp table subtitle_checks(label text primary key);
create function pg_temp.subtitle_assert(ok boolean,label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Subtitle assertion: %',label; end if;
  insert into subtitle_checks values(label);
end $$;
create function pg_temp.subtitle_update_variant(p_variant uuid,p_raw_title text,p_metadata jsonb) returns void language sql as $$
  update public.cloud_title_variants variant
  set raw_title=coalesce(p_raw_title,variant.raw_title),metadata=coalesce(p_metadata,variant.metadata),
    write_head_revision=head.head_revision,write_config_revision=lifecycle.config_revision,
    write_source_visibility_epoch=lifecycle.visibility_epoch,write_user_visibility_epoch=epoch.visibility_epoch
  from public.cloud_source_catalog_heads head
  join public.cloud_source_lifecycle lifecycle on lifecycle.source_id=head.source_id and lifecycle.user_id=head.user_id
  join public.cloud_user_catalog_visibility_epochs epoch on epoch.user_id=head.user_id
  where variant.id=p_variant and variant.source_id=head.source_id and variant.user_id=head.user_id;
$$;
create temp table subtitle_fixture(key text primary key,id uuid);

do $fixture$
declare u uuid:=gen_random_uuid(); other_u uuid:=gen_random_uuid(); s uuid:=gen_random_uuid(); other_s uuid:=gen_random_uuid(); foreign_s uuid:=gen_random_uuid();
  t uuid:=gen_random_uuid(); other_t uuid:=gen_random_uuid(); foreign_t uuid:=gen_random_uuid(); v uuid; g uuid; i integer; chosen_s uuid; chosen_u uuid; chosen_t uuid; raw text;
begin
  insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    values(u,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','subtitle-fixture-'||u||'@invalid.test','',now(),'{}','{}',now(),now()),
      (other_u,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','subtitle-fixture-'||other_u||'@invalid.test','',now(),'{}','{}',now(),now());
  insert into public.cloud_sources(id,user_id,source_type,display_name,config_ciphertext,config_hint,sync_status,catalog_version,enabled,last_synced_at)
    values(s,u,'xtream','Subtitle fixture A','cipher','{}','ready',1,true,now()),
      (other_s,u,'xtream','Subtitle fixture B','cipher','{}','ready',1,true,now()),
      (foreign_s,other_u,'xtream','Subtitle fixture foreign','cipher','{}','ready',1,true,now());
  insert into public.cloud_titles(id,user_id,item_type,identity_key,identity_source,match_status,title,metadata)
    values(t,u,'movie','subtitle-fixture-1','normalized','unmatched','Subtitle fixture 1','{}'),
      (other_t,u,'movie','subtitle-fixture-2','normalized','unmatched','Subtitle fixture 2','{}'),
      (foreign_t,other_u,'movie','subtitle-fixture-foreign','normalized','unmatched','Foreign subtitle fixture','{}');
  insert into subtitle_fixture values('owner',u),('foreign_owner',other_u),('source',s),('other_source',other_s),('foreign_source',foreign_s),('title',t),('other_title',other_t);
  for i in 1..5 loop
    chosen_s:=case when i=2 then other_s when i=5 then foreign_s else s end;
    chosen_u:=case when i=5 then other_u else u end;
    chosen_t:=case when i=4 then other_t when i=5 then foreign_t else t end;
    raw:=case when i=2 then 'Example [SUB-ES]' when i=4 then 'MULTI - Example' else 'Example VOSTFR' end;
    select active_generation_id into strict g from public.cloud_source_catalog_heads where source_id=chosen_s and user_id=chosen_u;
    v:=gen_random_uuid();
    insert into public.cloud_title_variants(id,user_id,title_id,source_id,generation_id,item_type,external_id,raw_title,metadata,
      write_head_revision,write_config_revision,write_source_visibility_epoch,write_user_visibility_epoch)
      select v,chosen_u,chosen_t,chosen_s,g,'movie','subtitle-fixture-file-'||i,raw,'{}',
        head.head_revision,lifecycle.config_revision,lifecycle.visibility_epoch,epoch.visibility_epoch
      from public.cloud_source_catalog_heads head
      join public.cloud_source_lifecycle lifecycle on lifecycle.source_id=head.source_id and lifecycle.user_id=head.user_id
      join public.cloud_user_catalog_visibility_epochs epoch on epoch.user_id=head.user_id
      where head.source_id=chosen_s and head.user_id=chosen_u;
    insert into subtitle_fixture values('variant'||i,v);
    if i<=2 then
      insert into public.cloud_title_file_language_observations(user_id,title_id,variant_id,file_external_id,audio_languages,audio_observed,subtitle_languages,subtitle_observed)
        values(chosen_u,chosen_t,v,'subtitle-fixture-file-'||i,case when i=1 then array['en'] else array['fr'] end,true,'{}',false);
    end if;
  end loop;
end $fixture$;
set constraints all immediate;

do $tests$
declare u uuid; other_u uuid; s uuid; other_s uuid; v uuid; duplicate_v uuid; t uuid; generation uuid; retained uuid:=gen_random_uuid(); page jsonb;
begin
  select id into strict u from subtitle_fixture where key='owner';
  select id into strict other_u from subtitle_fixture where key='foreign_owner';
  select id into strict s from subtitle_fixture where key='source';
  select id into strict other_s from subtitle_fixture where key='other_source';
  select id into strict v from subtitle_fixture where key='variant1';
  select id into strict duplicate_v from subtitle_fixture where key='variant3';
  select id into strict t from subtitle_fixture where key='title';
  perform pg_temp.subtitle_assert(public.cloud_catalog_subtitle_language_counts(u,'movie',s)='{"fr":1}','title dedup and import trigger');
  perform pg_temp.subtitle_assert(public.cloud_catalog_subtitle_language_counts(u,'movie',null)='{"fr":1,"es":1}','all owned sources union');
  perform pg_temp.subtitle_assert(public.cloud_catalog_subtitle_language_counts(other_u,'movie',s)='{}','foreign owner cannot read source hints');
  perform pg_temp.subtitle_assert(public.cloud_catalog_subtitle_language_counts(u,'series',s)='{}','media type fence');
  perform pg_temp.subtitle_assert((select count(*)=0 from public.cloud_catalog_visible_title_ids_by_source_languages(u,'movie',null,'catalog-fr','catalog-fr')),'audio and subtitle cannot cross sibling variants');
  perform pg_temp.subtitle_assert((select count(*)=1 from public.cloud_catalog_visible_title_ids_by_source_languages(u,'movie',s,'catalog-en','catalog-fr')),'same variant audio plus subtitle accepted');
  perform pg_temp.subtitle_assert((select count(*)=0 from public.cloud_catalog_visible_title_ids_by_source_languages(u,'movie',s,null,'fr')),'strict ISO subtitle filter never uses declarations');
  perform pg_temp.subtitle_assert((select count(*)=1 from public.cloud_catalog_visible_title_ids_by_source_languages(u,'movie',s,'unidentified','catalog-fr')),'unidentified audio and declared subtitles compose');
  page:=public.cloud_catalog_visible_title_language_page(u,'movie',s,'{"subtitle":"catalog-fr","limit":1,"offset":0}');
  perform pg_temp.subtitle_assert((page->>'count')::int=1 and jsonb_array_length(page->'titleIds')=1,'real bounded SQL page matches facet count');

  update public.cloud_title_file_language_observations set subtitle_observed=true,subtitle_languages=array['eng'] where variant_id=v;
  perform pg_temp.subtitle_assert((select array_agg(language)=array['en'] from public.cloud_catalog_effective_subtitle_languages(u,'movie',s) where variant_id=v),'exact subtitle overrides contradictory declaration');
  update public.cloud_title_file_language_observations set subtitle_languages=array['yue'] where variant_id=v;
  perform pg_temp.subtitle_assert((select array_agg(language)=array['yue'] from public.cloud_catalog_effective_subtitle_languages(u,'movie',s) where variant_id=v),'Cantonese exact three-letter code survives');
  perform pg_temp.subtitle_assert((select count(*)=1 from public.cloud_catalog_visible_title_ids_by_source_languages(u,'movie',s,null,'catalog-yue')),'Cantonese is actually filterable');
  update public.cloud_title_file_language_observations set subtitle_languages=array['und','unknown','xx','zz'] where variant_id=v;
  perform pg_temp.subtitle_assert((select array_agg(language)=array['fr'] from public.cloud_catalog_effective_subtitle_languages(u,'movie',s) where variant_id=v),'unknown observations never suppress declaration');
  update public.cloud_title_file_language_observations set subtitle_languages=array['en'],file_external_id='stale-replaced-file' where variant_id=v;
  perform pg_temp.subtitle_assert((select array_agg(language)=array['fr'] from public.cloud_catalog_effective_subtitle_languages(u,'movie',s) where variant_id=v),'stale exact file does not override declaration');
  update public.cloud_title_file_language_observations set subtitle_languages='{}',subtitle_observed=false,file_external_id='subtitle-fixture-file-1' where variant_id=v;

  perform pg_temp.subtitle_update_variant(duplicate_v,'Example [SUB-DE]',null);
  perform pg_temp.subtitle_assert((select array_agg(language)=array['de'] from public.cloud_catalog_provider_subtitle_hints where variant_id=duplicate_v),'title change replaces derived hint');
  perform pg_temp.subtitle_update_variant(duplicate_v,'Example no language tag',null);
  perform pg_temp.subtitle_assert((select count(*)=0 from public.cloud_catalog_provider_subtitle_hints where variant_id=duplicate_v),'removed tag deletes derived hint');
  perform pg_temp.subtitle_update_variant(duplicate_v,null,'{"providerLanguageDeclarations":{"schemaVersion":1,"providerType":"xtream","evidence":"provider_declaration","declarations":[{"role":"subtitle","values":["spa"]}]}}');
  perform pg_temp.subtitle_assert((select array_agg(language)=array['es'] from public.cloud_catalog_provider_subtitle_hints where variant_id=duplicate_v),'metadata change preserves explicit subtitle role');

  update public.cloud_sources set enabled=false where id=other_s;
  perform pg_temp.subtitle_assert(public.cloud_catalog_subtitle_language_counts(u,'movie',other_s)='{}','disabled source hidden');
  update public.cloud_sources set enabled=true where id=other_s;
  select active_generation_id into strict generation from public.cloud_source_catalog_heads where source_id=s and user_id=u;
  insert into public.cloud_source_catalog_generations(id,user_id,source_id,config_revision,state)
    select retained,u,s,config_revision,'retained' from public.cloud_source_catalog_generations where id=generation;
  -- Only a synthetic head changes, inside this rollback-only fixture.
  update public.cloud_source_catalog_heads set active_generation_id=retained where source_id=s and user_id=u;
  perform pg_temp.subtitle_assert(public.cloud_catalog_subtitle_language_counts(u,'movie',s)='{}','old generation hints and observations excluded');
  update public.cloud_source_catalog_heads set active_generation_id=generation where source_id=s and user_id=u;
  perform pg_temp.subtitle_assert(public.cloud_catalog_subtitle_language_counts(u,'movie',s)='{"fr":1,"es":1}','generation visibility restored');
end $tests$;
select jsonb_build_object('passed',count(*),'checks',jsonb_agg(label order by label)) from subtitle_checks;
rollback;
