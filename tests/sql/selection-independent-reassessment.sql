-- Isolated PostgreSQL only; all fixture changes roll back.
begin;
set local statement_timeout='60s';
set local request.jwt.claim.role='service_role';
do $test$
declare rel uuid; manifest text; row public.selection_shared_titles; patch jsonb; unit jsonb;
 review jsonb; md jsonb; receipt jsonb; files text; variants text;
begin
 select id,manifest_sha256 into rel,manifest from selection_shared_releases where published_at is not null limit 1;
 select * into row from selection_shared_titles where release_id=rel and item_type='movie' and title='Guerreiros da Virtude';
 review:='{"reason":"old_id_rejected","reviewedAt":"2026-10-02T00:00:00Z","rejectedTmdbIds":["49478","99999"]}'::jsonb;
 update selection_shared_titles set provider_tmdb_id=null,metadata=(metadata-'tmdb'-'i18n')||
   jsonb_build_object('tmdbValidation','{"valid":false,"reason":"public_title_alias_mismatch"}'::jsonb,'tmdbSearchReview',review)
   where release_id=rel and identity_key=row.identity_key returning * into row;
 update selection_shared_media set metadata=metadata||'{"year":1997,"selectionVodGroup":"Movies / Test / 1997","providerTmdbId":"49478"}'
   where release_id=rel and item_type='movie' and external_id=row.default_external_id;
 select jsonb_build_object('external_id',external_id,'title',title,'provider_year',metadata->'year',
   'provider_group',metadata->>'selectionVodGroup','source_unit',metadata->'selectionUnit') into unit
   from selection_shared_media where release_id=rel and item_type='movie' and external_id=row.default_external_id;
 select md5(jsonb_agg(to_jsonb(m) order by item_type,external_id)::text) into files from selection_shared_media m where release_id=rel;
 select md5(jsonb_agg(to_jsonb(v) order by item_type,external_id)::text) into variants from selection_shared_variants v where release_id=rel;
 patch:=jsonb_build_object('itemType','movie','identityKey',row.identity_key,'expectedTitle',row.title,
   'expectedId',null,'expectedPoster',row.poster_url,'expectedMetadata',row.metadata,'action','verified','tmdbId','49478',
   'evidence','source_media_year_alias','sourceUnits',jsonb_build_array(unit),'year',1997,
   'poster','https://image.tmdb.org/t/p/w500/test.jpg','originalTitle','Warriors of Virtue',
   'editorial','{"tmdb":{"id":49478,"release_date":"1997-05-02","runtime":103,"overview":"QA only"},"tmdbValidation":{"valid":true,"confidence":0.923}}'::jsonb);
 execute 'set local role service_role';
 begin
   perform norva_apply_selection_editorial_audit(rel,manifest,jsonb_build_array(patch));
   raise exception 'Rejection reassessed without explicit receipt';
 exception when sqlstate '22023' then null; end;
 patch:=patch||jsonb_build_object('rejectionReassessment',jsonb_build_object(
   'reason','independent_public_manifest_reassessment','previousReview',review,'sourceProofSha256',repeat('a',64)));
 begin
   perform norva_apply_selection_editorial_audit(rel,manifest,jsonb_build_array(jsonb_set(patch,'{evidence}','"unique_exact_title"')));
   raise exception 'Weak name-only proof reassessed rejection';
 exception when sqlstate '22023' then null; end;
 begin
   perform norva_apply_selection_editorial_audit(rel,manifest,jsonb_build_array(jsonb_set(patch,'{rejectionReassessment,previousReview}','{}')));
   raise exception 'Stale rejection history accepted';
 exception when sqlstate '22023' then null; end;
 begin
   perform norva_apply_selection_editorial_audit(rel,manifest,jsonb_build_array(jsonb_set(patch,'{sourceUnits,0,external_id}','"foreign"')));
   raise exception 'Foreign source evidence accepted';
 exception when sqlstate 'PT409' then null; end;
 receipt:=norva_apply_selection_editorial_audit(rel,manifest,jsonb_build_array(patch));
 if receipt->>'updatedTitles'<>'1' then raise exception 'Independent source reassessment rejected'; end if;
 select metadata into md from selection_shared_titles where release_id=rel and identity_key=row.identity_key;
 if md#>'{tmdbSearchReview,rejectedTmdbIds}'<>'["99999"]'::jsonb
   or md#>'{tmdbSearchReview,reassessments,0,previousReview}' is distinct from review
   or md#>>'{tmdbSearchReview,reassessments,0,tmdbId}'<>'49478' then
   raise exception 'Rejection history lost or unrelated rejection removed'; end if;
 patch:=(patch-'rejectionReassessment')||jsonb_build_object('expectedId','49478',
   'expectedPoster','https://image.tmdb.org/t/p/w500/test.jpg','expectedMetadata',md,
   'evidence','source_original_provider_id','originalIdUnits',jsonb_build_array(jsonb_build_object(
     'externalId',row.default_external_id,'providerId','49478')));
 begin
   perform norva_apply_selection_editorial_audit(rel,manifest,jsonb_build_array(jsonb_set(patch,'{originalIdUnits,0,providerId}','"99999"')));
   raise exception 'Foreign original provider ID accepted';
 exception when sqlstate 'PT409' then null; end;
 receipt:=norva_apply_selection_editorial_audit(rel,manifest,jsonb_build_array(patch));
 select metadata into md from selection_shared_titles where release_id=rel and identity_key=row.identity_key;
 if md#>'{tmdbSearchReview,reassessments,0,previousReview}' is distinct from review then
   raise exception 'Later valid refresh erased reassessment history'; end if;
 if files<>(select md5(jsonb_agg(to_jsonb(m) order by item_type,external_id)::text) from selection_shared_media m where release_id=rel)
   or variants<>(select md5(jsonb_agg(to_jsonb(v) order by item_type,external_id)::text) from selection_shared_variants v where release_id=rel) then
   raise exception 'Reassessment changed public files'; end if;
 execute 'reset role';
 raise notice 'PASS: explicit independent reassessment, stale/weak/foreign receipts rejected, archived history and files preserved';
end $test$;
rollback;
