-- Execute on a disposable schema clone. Fixtures and cache changes roll back.
begin;
set local statement_timeout='60s';
set local request.jwt.claim.role='service_role';
do $test$
declare donor uuid:=gen_random_uuid(); reader uuid:=gen_random_uuid(); unplayed uuid:=gen_random_uuid(); ds uuid; rs uuid; us uuid; rel uuid;
 rev text; manifest text; key text; ext text; snap jsonb; result jsonb; before_raw text; before_files text;
 before_owned text; donor_gen uuid; did uuid; rid uuid; epoch bigint; item jsonb; safe jsonb; n int;
 initial public.selection_shared_titles; variant_id uuid; v_generation uuid;
begin
 select id,revision,manifest_sha256 into rel,rev,manifest from public.selection_shared_releases where published_at is not null limit 1;
 select * into initial from public.selection_shared_titles where release_id=rel and title='Guerreiros da Virtude';
 key:=initial.identity_key; ext:=initial.default_external_id;
 if rel is null or key is null then raise exception 'Qualified public fixture missing'; end if;
 update public.selection_shared_rollout set enabled=true;
 update public.selection_shared_titles set provider_tmdb_id=null,match_status='unmatched',poster_url=null,
   metadata='{}',genre_buckets=array['autres'] where release_id=rel and item_type='movie' and identity_key=key;
 insert into auth.users(id,email,created_at,updated_at) values
   (donor,'selection-donor-'||donor::text||'@example.invalid',now(),now()),
   (reader,'selection-reader-'||reader::text||'@example.invalid',now(),now()),
   (unplayed,'selection-unplayed-'||unplayed::text||'@example.invalid',now(),now());
 ds:=overlay(public.norva_selection_shared_uuid('norva-selection-curated-v1:'||donor::text)::text placing '4' from 15)::uuid;
 rs:=overlay(public.norva_selection_shared_uuid('norva-selection-curated-v1:'||reader::text)::text placing '4' from 15)::uuid;
 us:=overlay(public.norva_selection_shared_uuid('norva-selection-curated-v1:'||unplayed::text)::text placing '4' from 15)::uuid;
 insert into public.cloud_sources(id,user_id,source_type,display_name,enabled,sync_status) values
   (ds,donor,'m3u','Synthetic donor',true,'syncing'),(rs,reader,'m3u','Synthetic reader',true,'syncing'),
   (us,unplayed,'m3u','Synthetic unplayed',true,'syncing');
 execute 'set local role service_role';
 snap:=public.norva_get_catalog_write_snapshot(ds,donor); donor_gen:=(snap->>'generationId')::uuid;
 perform public.norva_activate_selection_shared_catalog(ds,donor,rev,donor_gen,(snap->>'headRevision')::bigint,
   (snap->>'configRevision')::bigint,(snap->>'sourceVisibilityEpoch')::bigint,(snap->>'userVisibilityEpoch')::bigint);
 snap:=public.norva_get_catalog_write_snapshot(rs,reader); v_generation:=(snap->>'generationId')::uuid;
 perform public.norva_activate_selection_shared_catalog(rs,reader,rev,v_generation,(snap->>'headRevision')::bigint,
   (snap->>'configRevision')::bigint,(snap->>'sourceVisibilityEpoch')::bigint,(snap->>'userVisibilityEpoch')::bigint);
 snap:=public.norva_get_catalog_write_snapshot(us,unplayed);
 perform public.norva_activate_selection_shared_catalog(us,unplayed,rev,(snap->>'generationId')::uuid,(snap->>'headRevision')::bigint,
   (snap->>'configRevision')::bigint,(snap->>'sourceVisibilityEpoch')::bigint,(snap->>'userVisibilityEpoch')::bigint);
 select id into rid from public.cloud_catalog_visible_titles where user_id=reader and identity_key=key;
 if (select provider_tmdb_id from public.cloud_catalog_visible_titles where user_id=reader and id=rid) is not null then
   raise exception 'Fresh reader fixture already enriched'; end if;
 -- Bind this file while its common card is still sparse. This reproduces the
 -- played/unplayed divergence without constructing a full owner inventory.
 perform public.norva_bind_selection_shared_file(reader,rs,'movie',ext);
 perform public.norva_bind_selection_shared_file(donor,ds,'movie',ext);
 execute 'reset role';
 select id into did from public.cloud_titles where user_id=donor and identity_key=key;
 update public.cloud_titles set provider_tmdb_id='49478',match_status='provider_verified',
   metadata='{"tmdb":{"id":49478},"tmdbValidation":{"valid":true},"privatePreference":"never-copy-this"}' where id=did;
 insert into public.catalog_titles(item_type,provider_tmdb_id,title,original_title,release_year,poster_url,backdrop_url,metadata)
 values('movie','49478','Warriors of Virtue','Warriors of Virtue',1997,
   'https://image.tmdb.org/t/p/w500/qa-warriors.jpg','https://image.tmdb.org/t/p/w780/qa-warriors.jpg',
   '{"tmdb":{"id":49478,"title":"Warriors of Virtue","overview":"Public QA overview","runtime":103,"vote_average":4.8,"genres":[{"id":28,"name":"Action"}],"audioTracks":[{"lang":"xx"}],"providerPassword":"do-not-publish"},"i18n":{"fr":{"title":"Magic warriors","overview":"Synopsis public QA","token":"do-not-publish"}},"tmdbValidation":{"valid":true},"accountSecret":"do-not-publish"}')
 on conflict(item_type,provider_tmdb_id) do update set metadata=excluded.metadata,poster_url=excluded.poster_url,
   backdrop_url=excluded.backdrop_url,release_year=excluded.release_year;
 select md5(coalesce(jsonb_agg(to_jsonb(m) order by item_type,external_id)::text,'')) into before_raw
   from public.selection_shared_media m where release_id=rel;
 select md5(coalesce(jsonb_agg(to_jsonb(v) order by item_type,external_id)::text,'')) into before_files
   from public.selection_shared_variants v where release_id=rel;
 select md5(coalesce(jsonb_agg(to_jsonb(m) order by id)::text,'')) into before_owned
   from public.cloud_media_items m where user_id in (reader,donor);
 execute 'set local role service_role';
 safe:=public.norva_selection_public_editorial_metadata('{"tmdb":null,"i18n":[],"tmdbValidation":"bad"}');
 if safe<>'{}' then raise exception 'Malformed editorial metadata was not ignored'; end if;
 safe:=public.norva_selection_public_editorial_metadata((select metadata from public.catalog_titles where item_type='movie' and provider_tmdb_id='49478'));
 if safe::text like '%do-not-publish%' or safe::text like '%audioTracks%' or safe::text like '%token%' then
   raise exception 'Public metadata whitelist leaked unrelated data'; end if;
 result:=public.norva_refresh_selection_shared_editorial(rel,manifest,'movie',array[key],donor,ds,donor_gen);
 if result->>'updatedTitles'<>'1' then raise exception 'Known exact-file match not reused: %',result; end if;
 if (select provider_tmdb_id from public.cloud_catalog_visible_titles where user_id=reader and id=rid)<>'49478' then
   raise exception 'Bound reader did not receive common identity'; end if;
 if (select metadata#>>'{i18n,fr,overview}' from public.cloud_catalog_visible_titles where user_id=reader and id=rid)<>'Synopsis public QA' then
   raise exception 'Bound reader synopsis missing'; end if;
 if not exists(select 1 from public.cloud_catalog_visible_titles where user_id=unplayed and identity_key=key
   and provider_tmdb_id='49478' and metadata#>>'{i18n,fr,overview}'='Synopsis public QA' and poster_url like '%qa-warriors.jpg') then
   raise exception 'Unplayed card differs from bound card'; end if;
 if exists(select 1 from public.cloud_media_items where user_id=unplayed) then
   raise exception 'Unplayed account inventory was materialized'; end if;
 select visibility_epoch into epoch from public.cloud_user_catalog_visibility_epochs where user_id=reader;
 item:=public.norva_get_visible_catalog_titles_by_ids(reader,array[rid],epoch)->'items'->0;
 if item->>'id'<>rid::text or item->>'user_id'<>reader::text or item->>'provider_tmdb_id'<>'49478'
   or item#>>'{metadata,i18n,fr,overview}'<>'Synopsis public QA' then raise exception 'Bound hydration diverged'; end if;
 if item::text like '%never-copy-this%' or item::text like '%do-not-publish%' then raise exception 'Donor data leaked'; end if;
 if item->>'default_variant_id' is null or item->>'display_generation_id'<>v_generation::text then
   raise exception 'Editorial repair changed playback proof'; end if;
 if exists(select 1 from public.cloud_catalog_visible_titles where user_id=reader and id=rid and not ('action'=any(genre_buckets))) then
   raise exception 'Bound genre facet missing'; end if;
 if before_raw<>(select md5(coalesce(jsonb_agg(to_jsonb(m) order by item_type,external_id)::text,'')) from public.selection_shared_media m where release_id=rel)
   or before_files<>(select md5(coalesce(jsonb_agg(to_jsonb(v) order by item_type,external_id)::text,'')) from public.selection_shared_variants v where release_id=rel)
   or before_owned<>(select md5(coalesce(jsonb_agg(to_jsonb(m) order by id)::text,'')) from public.cloud_media_items m where user_id in(reader,donor)) then
   raise exception 'Editorial refresh modified files or owner inventory'; end if;
 result:=public.norva_refresh_selection_shared_editorial(rel,manifest,'movie',array[key],donor,ds,donor_gen);
 if result->>'updatedTitles'<>'0' then raise exception 'Repeat generated unnecessary writes'; end if;
 -- A later public translation updates both paths without another import.
 execute 'reset role';
 update public.catalog_titles set metadata=jsonb_set(metadata,'{i18n,fr,overview}','"Synopsis public QA actualisé"')
   where item_type='movie' and provider_tmdb_id='49478';
 execute 'set local role service_role';
 result:=public.norva_refresh_selection_shared_editorial_from_cache(1);
 if result->>'updatedTitles'<>'1' or (select metadata#>>'{i18n,fr,overview}' from public.cloud_catalog_visible_titles
   where user_id=reader and id=rid)<>'Synopsis public QA actualisé' then raise exception 'Later common metadata stayed stale'; end if;
 result:=public.norva_refresh_selection_shared_editorial_from_cache(1);
 if result->>'updatedTitles'<>'0' then raise exception 'Maintenance repeated unchanged writes'; end if;
 begin
   perform public.norva_refresh_selection_shared_editorial_from_cache(null);
   raise exception 'Unbounded maintenance accepted';
 exception when invalid_parameter_value then null; end;
 begin
   perform public.norva_refresh_selection_shared_editorial(rel,manifest,'movie',array[key],reader,ds,donor_gen);
   raise exception 'Foreign donor accepted';
 exception when insufficient_privilege then null; end;
 begin
   perform public.norva_refresh_selection_shared_editorial(rel,manifest,'movie',array[key],donor,ds,gen_random_uuid());
   raise exception 'Stale generation accepted';
 exception when sqlstate 'PT409' then null; end;
 begin
   perform public.norva_refresh_selection_shared_editorial(rel,repeat('0',64),'movie',array[key],donor,ds,donor_gen);
   raise exception 'Changed release accepted';
 exception when sqlstate 'PT409' then null; end;
 -- A different published ID is not overwritten even by a trusted donor.
 execute 'reset role';
 begin
   update public.selection_shared_releases set manifest_sha256=repeat('0',64) where id=rel;
   raise exception 'Published file manifest mutation accepted';
 exception when sqlstate 'PT409' then null; end;
 update public.selection_shared_titles set provider_tmdb_id='999' where release_id=rel and item_type='movie' and identity_key=key;
 execute 'set local role service_role';
 result:=public.norva_refresh_selection_shared_editorial(rel,manifest,'movie',array[key],donor,ds,donor_gen);
 if result->>'updatedTitles'<>'0' or result->>'conflictingIds'<>'1' then raise exception 'Identity conflict not preserved'; end if;
 if (select count(*) from public.cloud_media_items where user_id=reader)<>1 then raise exception 'Owner catalogue was rebuilt'; end if;
 if has_function_privilege('authenticated','public.norva_refresh_selection_shared_editorial(uuid,text,text,text[],uuid,uuid,uuid)','execute')
   or has_function_privilege('anon','public.norva_refresh_selection_shared_editorial(uuid,text,text,text[],uuid,uuid,uuid)','execute') then
   raise exception 'Public role may write common editorial data'; end if;
 raise notice 'PASS: exact match, bound hydration/facets, isolation, immutable files, no-op, foreign/stale/release/conflict guards and service grants';
end $test$;
rollback;
