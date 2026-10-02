-- Real PostgreSQL, isolated QA database only. Every fixture mutation rolls back.
begin;
set local statement_timeout='60s';
set local request.jwt.claim.role='service_role';
do $test$
declare rel uuid; manifest text; key text; ext text; row public.selection_shared_titles;
 unit jsonb; patch jsonb; receipt jsonb; md jsonb; files text; variants text; target text;
begin
 select id,manifest_sha256 into rel,manifest from selection_shared_releases where published_at is not null limit 1;
 select * into row from selection_shared_titles where release_id=rel and item_type='movie' and title='Guerreiros da Virtude';
 key:=row.identity_key; ext:=row.default_external_id;
 update selection_shared_media set metadata=metadata||'{"year":1997,"selectionVodGroup":"Movies / Test / 1997"}'
   where release_id=rel and item_type='movie' and external_id=ext;
 select jsonb_build_object('external_id',external_id,'title',title,'provider_year',metadata->'year',
   'provider_group',metadata->>'selectionVodGroup','source_unit',metadata->'selectionUnit') into unit
   from selection_shared_media where release_id=rel and item_type='movie' and external_id=ext;
 select playback_hint->>'targetUrl' into target from selection_shared_variants where release_id=rel and item_type='movie' and external_id=ext;
 select md5(jsonb_agg(to_jsonb(m) order by item_type,external_id)::text) into files from selection_shared_media m where release_id=rel;
 select md5(jsonb_agg(to_jsonb(v) order by item_type,external_id)::text) into variants from selection_shared_variants v where release_id=rel;
 patch:=jsonb_build_object('itemType','movie','identityKey',key,'expectedTitle',row.title,'expectedId',row.provider_tmdb_id,
   'expectedPoster',row.poster_url,'expectedMetadata',row.metadata,'action','verified','tmdbId','49478',
   'evidence','source_media_year_alias','sourceUnits',jsonb_build_array(unit),'year',1997,
   'poster','https://image.tmdb.org/t/p/w500/test.jpg','originalTitle','Warriors of Virtue',
   'editorial','{"tmdb":{"id":49478,"release_date":"1997-05-02","runtime":100,"overview":"Test only"},"tmdbValidation":{"valid":true,"confidence":0.923}}'::jsonb);
 execute 'set local role service_role';
 begin
   perform norva_apply_selection_editorial_audit(rel,manifest,jsonb_build_array(jsonb_set(patch,'{sourceUnits,0,external_id}','"foreign"')));
   raise exception 'Foreign raw media proof accepted';
 exception when sqlstate 'PT409' then null; end;
 begin
   perform norva_apply_selection_editorial_audit(rel,manifest,jsonb_build_array(jsonb_set(patch,'{editorial,tmdb,release_date}','"2023-01-01"')));
   raise exception 'Conflicting official movie year accepted';
 exception when sqlstate 'PT409' then null; end;
 receipt:=norva_apply_selection_editorial_audit(rel,manifest,jsonb_build_array(patch));
 if receipt->>'updatedTitles'<>'1' then raise exception 'Valid source year receipt rejected'; end if;
 select metadata into md from selection_shared_titles where release_id=rel and identity_key=key;
 patch:=patch||jsonb_build_object('expectedId','49478','expectedPoster','https://image.tmdb.org/t/p/w500/test.jpg',
   'expectedMetadata',md,'evidence','source_alias_file_duration','sourceTitleLabel',row.title,
   'fileDurationSeconds',6000,'expectedTargetUrl',target);
 begin
   perform norva_apply_selection_editorial_audit(rel,manifest,jsonb_build_array(jsonb_set(patch,'{fileDurationSeconds}','6200')));
   raise exception 'Incompatible official runtime accepted';
 exception when sqlstate 'PT409' then null; end;
 begin
   perform norva_apply_selection_editorial_audit(rel,manifest,jsonb_build_array(jsonb_set(patch,'{expectedTargetUrl}','"https://foreign.invalid/a.mp4"')));
   raise exception 'Foreign media duration accepted';
 exception when sqlstate 'PT409' then null; end;
 receipt:=norva_apply_selection_editorial_audit(rel,manifest,jsonb_build_array(patch));
 if receipt->>'updatedTitles'<>'1' then raise exception 'Valid duration receipt rejected'; end if;
 execute 'reset role';
 select * into row from selection_shared_titles where release_id=rel and item_type='series' and title='Special Ops';
 select jsonb_build_object('external_id',m.external_id,'title',m.title,'provider_year',m.metadata->'year',
   'provider_group',m.metadata->>'selectionVodGroup','source_unit',m.metadata->'selectionUnit') into unit
 from selection_shared_media m join selection_shared_variants v on v.release_id=m.release_id
   and v.external_id=m.metadata->>'selectionParentId'
 where v.release_id=rel and v.item_type='series' and v.identity_key=row.identity_key and m.metadata->'year'='2025' limit 1;
 if unit is null then raise exception 'Missing season-2 fixture'; end if;
 patch:=jsonb_build_object('itemType','series','identityKey',row.identity_key,'expectedTitle',row.title,
   'expectedId',row.provider_tmdb_id,'expectedPoster',row.poster_url,'expectedMetadata',row.metadata,
   'action','verified','tmdbId','100612','evidence','source_series_season_alias','sourceUnits',jsonb_build_array(unit),
   'officialSeasons','[{"season_number":2,"air_date":"2025-07-18"}]'::jsonb,'originalTitle','Special Ops',
   'editorial','{"tmdb":{"id":100612,"first_air_date":"2020-03-17","overview":"Test only"},"tmdbValidation":{"valid":true,"confidence":0.923}}'::jsonb);
 execute 'set local role service_role';
 begin
   perform norva_apply_selection_editorial_audit(rel,manifest,jsonb_build_array(jsonb_set(patch,'{officialSeasons,0,air_date}','"2020-03-17"')));
   raise exception 'First-air year confused with later season';
 exception when sqlstate 'PT409' then null; end;
 receipt:=norva_apply_selection_editorial_audit(rel,manifest,jsonb_build_array(patch));
 if receipt->>'updatedTitles'<>'1' then raise exception 'Valid season-2 receipt rejected'; end if;
 if files<>(select md5(jsonb_agg(to_jsonb(m) order by item_type,external_id)::text) from selection_shared_media m where release_id=rel)
   or variants<>(select md5(jsonb_agg(to_jsonb(v) order by item_type,external_id)::text) from selection_shared_variants v where release_id=rel) then
   raise exception 'Editorial proof changed files or variants'; end if;
 raise notice 'PASS: source year/season and duration receipts, foreign-unit/URL/date/runtime rejection, immutable public files';
end $test$;
rollback;
