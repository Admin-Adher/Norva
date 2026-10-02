-- Real PostgreSQL replay in the isolated QA database; no production users.
begin;
set local statement_timeout='60s';
set local request.jwt.claim.role='service_role';
do $test$
declare rel uuid; rev text; manifest text; key text; ext text; person uuid; src uuid; snap jsonb;
 readers uuid[]:='{}'; sources uuid[]:='{}'; ids uuid[]:='{}'; ct uuid;
 old_md jsonb:='{"tmdb":{"id":999,"overview":"Wrong overview"},"tmdbValidation":{"valid":true,"confidence":0.783}}';
 patch jsonb; receipt jsonb; after_md jsonb; before_files text; before_shared text; before_variants text;
 before_epoch bigint; counter int; before_global jsonb;
begin
 select id,revision,manifest_sha256 into rel,rev,manifest from public.selection_shared_releases where published_at is not null limit 1;
 select identity_key,default_external_id into key,ext from public.selection_shared_titles where release_id=rel and title='Guerreiros da Virtude';
 update public.selection_shared_rollout set enabled=true;
 update public.selection_shared_titles set provider_tmdb_id='999',match_status='provider_verified',metadata=old_md,
   poster_url='https://image.tmdb.org/t/p/w500/wrong.jpg' where release_id=rel and identity_key=key and item_type='movie';
 for counter in 1..3 loop
   person:=gen_random_uuid(); readers:=array_append(readers,person);
   insert into auth.users(id,email,created_at,updated_at) values(person,'editorial-audit-'||person::text||'@example.invalid',now(),now());
   src:=overlay(public.norva_selection_shared_uuid('norva-selection-curated-v1:'||person::text)::text placing '4' from 15)::uuid;
   sources:=array_append(sources,src);
   insert into public.cloud_sources(id,user_id,source_type,display_name,enabled,sync_status)
     values(src,person,'m3u','Synthetic audit reader',true,'syncing');
   execute 'set local role service_role';
   snap:=public.norva_get_catalog_write_snapshot(src,person);
   perform public.norva_activate_selection_shared_catalog(src,person,rev,(snap->>'generationId')::uuid,(snap->>'headRevision')::bigint,
     (snap->>'configRevision')::bigint,(snap->>'sourceVisibilityEpoch')::bigint,(snap->>'userVisibilityEpoch')::bigint);
   perform public.norva_bind_selection_shared_file(person,src,'movie',ext);
   execute 'reset role';
   select id into ct from public.cloud_titles where user_id=person and identity_key=key;
   ids:=array_append(ids,ct);
   update public.cloud_titles set metadata=metadata||'{"privatePreference":"keep","audioTracks":["private"]}' where id=ct;
 end loop;
 update public.cloud_titles set match_status='manual' where id=ids[2];
 update public.cloud_title_variants set playback_hint=jsonb_set(playback_hint,'{targetUrl}','"https://private.invalid/different.mp4"')
   where title_id=ids[3];
 select md5(jsonb_agg(to_jsonb(m) order by id)::text) into before_files from public.cloud_media_items m where user_id=any(readers);
 select md5(jsonb_agg(to_jsonb(v) order by id)::text) into before_variants from public.cloud_title_variants v where user_id=any(readers);
 select md5(jsonb_agg(to_jsonb(m) order by item_type,external_id)::text) into before_shared from public.selection_shared_media m where release_id=rel;
 select visibility_epoch into before_epoch from public.cloud_user_catalog_visibility_epochs where user_id=readers[1];
 patch:=jsonb_build_object('itemType','movie','identityKey',key,'expectedTitle','Guerreiros da Virtude',
   'expectedId','999','expectedPoster','https://image.tmdb.org/t/p/w500/wrong.jpg','expectedMetadata',old_md,
   'action','verified','tmdbId','49478','evidence','unique_exact_title','originalTitle','Warriors of Virtue','year',1997,
   'poster','https://image.tmdb.org/t/p/w500/correct.jpg','backdrop',null,
   'editorial','{"tmdb":{"id":49478,"title":"Warriors of Virtue","overview":"Correct overview","genres":["Action"],"credential":"never-publish"},"tmdbValidation":{"valid":true,"confidence":0.923},"i18n":{"fr":{"overview":"Synopsis correct","token":"never-publish"}}}'::jsonb);
 execute 'set local role service_role';
 begin
   perform public.norva_apply_selection_editorial_audit(rel,'changed',jsonb_build_array(patch));
   raise exception 'Changed manifest accepted';
 exception when sqlstate 'PT409' then null; end;
 begin
   perform public.norva_apply_selection_editorial_audit(rel,manifest,jsonb_build_array(patch,patch));
   raise exception 'Duplicate input accepted';
 exception when invalid_parameter_value then null; end;
 begin
   perform public.norva_apply_selection_editorial_audit(rel,manifest,jsonb_build_array(jsonb_set(patch,'{editorial,tmdbValidation,confidence}','0.783')));
   raise exception 'Weak proof accepted';
 exception when invalid_parameter_value then null; end;
 receipt:=public.norva_apply_selection_editorial_audit(rel,manifest,jsonb_build_array(patch));
 if receipt->>'updatedTitles'<>'1' or receipt->>'ownedBindings'<>'1' then raise exception 'Qualified association not repaired: %',receipt; end if;
 if (select provider_tmdb_id from public.cloud_titles where id=ids[1])<>'49478'
   or (select metadata->>'privatePreference' from public.cloud_titles where id=ids[1])<>'keep'
   or (select metadata#>>'{audioTracks,0}' from public.cloud_titles where id=ids[1])<>'private' then
   raise exception 'Owner preference lost or association stale'; end if;
 if exists(select 1 from public.cloud_titles where id in(ids[2],ids[3]) and provider_tmdb_id<>'999') then
   raise exception 'Manual/private title overwritten'; end if;
 if (select metadata::text from public.selection_shared_titles where release_id=rel and identity_key=key) like '%never-publish%' then
   raise exception 'Unrelated metadata published'; end if;
 if (select visibility_epoch from public.cloud_user_catalog_visibility_epochs where user_id=readers[1])<=before_epoch then
   raise exception 'Reader epoch not invalidated'; end if;
 begin
   perform public.norva_apply_selection_editorial_audit(rel,manifest,jsonb_build_array(patch));
   raise exception 'Stale input accepted';
 exception when sqlstate 'PT409' then null; end;
 select metadata into after_md from public.selection_shared_titles where release_id=rel and identity_key=key;
 patch:=patch||jsonb_build_object('expectedId','49478','expectedPoster','https://image.tmdb.org/t/p/w500/correct.jpg',
   'expectedMetadata',after_md,'action','quarantine','tmdbId',null,'evidence','old_id_rejected',
   'poster',null,'year',null,'editorial','{"tmdbValidation":{"valid":false,"confidence":0}}'::jsonb);
 receipt:=public.norva_apply_selection_editorial_audit(rel,manifest,jsonb_build_array(patch));
 if receipt->>'quarantined'<>'1' or receipt->>'ownedBindings'<>'1' then raise exception 'Quarantine did not cover owned binding: %',receipt; end if;
 if exists(select 1 from public.cloud_titles where id=ids[1] and (provider_tmdb_id is not null or metadata?'tmdb' or poster_url is not null)) then
   raise exception 'Rejected content survives in owned fiche'; end if;
 -- Legacy inventories have no shared enrollment. They still need the same
 -- verified editorial data, with source/generation/URL and manual guards.
 execute 'reset role';
 update public.selection_shared_titles set provider_tmdb_id='49478',match_status='provider_verified',poster_url='https://image.tmdb.org/t/p/w500/correct.jpg',
   metadata='{"tmdb":{"id":49478,"overview":"Legacy refreshed"},"tmdbValidation":{"valid":true,"confidence":0.923},"tmdbSearchReview":{"reason":"unique_exact_title","rejectedTmdbIds":["999"]}}'
   where release_id=rel and identity_key=key;
 update public.cloud_titles set provider_tmdb_id='999',metadata=old_md||'{"privatePreference":"keep","audioTracks":["private"]}' where id=ids[1];
 delete from public.selection_shared_enrollments where user_id=any(readers);
 select metadata into before_global from public.catalog_titles where item_type='movie' and provider_tmdb_id='49478';
 execute 'set local role service_role';
 snap:=public.norva_get_catalog_write_snapshot(sources[1],readers[1]);
 receipt:=public.norva_refresh_selection_owned_editorial(readers[1],sources[1],(snap->>'generationId')::uuid,100);
 if receipt->>'updatedTitles'<>'1' or (select provider_tmdb_id from public.cloud_titles where id=ids[1])<>'49478'
   or (select metadata->>'privatePreference' from public.cloud_titles where id=ids[1])<>'keep'
   or not (select metadata#>'{tmdbSearchReview,rejectedTmdbIds}' from public.cloud_titles where id=ids[1]) @> '["999"]' then
   raise exception 'Legacy exact binding stayed stale: %',receipt; end if;
 receipt:=public.norva_refresh_selection_owned_editorial(readers[1],sources[1],(snap->>'generationId')::uuid,100);
 if receipt->>'updatedTitles'<>'0' then raise exception 'Legacy replay rewrites unchanged metadata'; end if;
 if (select metadata from public.catalog_titles where item_type='movie' and provider_tmdb_id='49478') is distinct from before_global
   or nullif(current_setting('norva.selection_owned_editorial_context',true),'') is not null then
   raise exception 'Owner refresh leaked private metadata into global cache or left mirror bypass active'; end if;
 begin
   perform public.norva_refresh_selection_owned_editorial(readers[2],sources[1],(snap->>'generationId')::uuid,100);
   raise exception 'Foreign legacy owner accepted';
 exception when insufficient_privilege then null; end;
 begin
   perform public.norva_refresh_selection_owned_editorial(readers[1],sources[1],gen_random_uuid(),100);
   raise exception 'Stale legacy generation accepted';
 exception when sqlstate 'PT409' then null; end;
 snap:=public.norva_get_catalog_write_snapshot(sources[2],readers[2]);
 receipt:=public.norva_refresh_selection_owned_editorial(readers[2],sources[2],(snap->>'generationId')::uuid,100);
 if receipt->>'updatedTitles'<>'0' then raise exception 'Manual legacy title overwritten'; end if;
 snap:=public.norva_get_catalog_write_snapshot(sources[3],readers[3]);
 receipt:=public.norva_refresh_selection_owned_editorial(readers[3],sources[3],(snap->>'generationId')::uuid,100);
 if receipt->>'updatedTitles'<>'0' then raise exception 'Private legacy URL overwritten'; end if;
 if before_files<>(select md5(jsonb_agg(to_jsonb(m) order by id)::text) from public.cloud_media_items m where user_id=any(readers))
   or before_variants<>(select md5(jsonb_agg(to_jsonb(v) order by id)::text) from public.cloud_title_variants v where user_id=any(readers))
   or before_shared<>(select md5(jsonb_agg(to_jsonb(m) order by item_type,external_id)::text) from public.selection_shared_media m where release_id=rel) then
   raise exception 'Files or playback bindings changed'; end if;
 if has_function_privilege('authenticated','public.norva_apply_selection_editorial_audit(uuid,text,jsonb)','execute')
   or has_function_privilege('anon','public.norva_apply_selection_editorial_audit(uuid,text,jsonb)','execute')
   or has_function_privilege('authenticated','public.norva_refresh_selection_owned_editorial_all(int,int)','execute') then
   raise exception 'Public user can apply audit'; end if;
 raise notice 'PASS: audited correction/quarantine, exact bindings, private/manual exclusions, CAS/manifest/duplicates/weak-proof fences, epochs, immutable files and grants';
end $test$;
rollback;
