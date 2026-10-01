-- Run AFTER the shared migrations, in the SAME transaction, then ROLLBACK.
-- No emails, real catalog deletion, entitlement changes or committed fixtures.
set local request.jwt.claim.role='service_role';
set local statement_timeout='45s';
do $test$
declare u uuid:=gen_random_uuid(); s uuid; r uuid; rev text; snap jsonb; result jsonb;
  started timestamptz; expected integer; n integer; epoch bigint; ids uuid[]; page jsonb; langs jsonb; file_id text; expected_title_id uuid;
  publication jsonb; batch jsonb; u2 uuid:=gen_random_uuid(); s2 uuid; other uuid; own_variant jsonb; own_media jsonb; other_snap jsonb; title_count integer;
begin
  update public.selection_shared_rollout set enabled=true;
  select revision into rev from public.selection_prepared_catalogs
    where payload->>'truncated'='false' order by expires_at desc limit 1;
  if rev is null then raise exception 'Prepared fixture unavailable'; end if;
  -- Extend only within this rolled-back fixture, never in production state.
  update public.selection_prepared_catalogs set expires_at=now()+interval '1 hour' where revision=rev;
  update public.selection_title_recipes set expires_at=now()+interval '1 hour' where revision=rev;
  started:=clock_timestamp();
  r:=public.norva_prepare_selection_shared_release(rev);
  select payload into publication from selection_shared_test_publication;
  for batch in select jsonb_agg(value) from jsonb_array_elements(publication->'files') with ordinality t(value,n)
    group by (t.n-1)/250 loop
    perform public.norva_seed_selection_shared_tags(r,batch);
  end loop;
  perform public.norva_seed_selection_shared_live(r,publication->'live'->'channels',publication->'live'->'variants');
  perform public.norva_publish_selection_shared_release(r);
  raise notice 'Shared public build ms: %',1000*extract(epoch from clock_timestamp()-started);
  insert into auth.users(id,email,created_at,updated_at) values(u,'selection-shared-'||u::text||'@example.invalid',now(),now());
  s:=overlay(public.norva_selection_shared_uuid('norva-selection-curated-v1:'||u::text)::text placing '4' from 15)::uuid;
  insert into public.cloud_sources(id,user_id,source_type,display_name,enabled,sync_status)
    values(s,u,'m3u','Selection rollback fixture',true,'syncing');
  execute 'set local role service_role';
  snap:=public.norva_get_catalog_write_snapshot(s,u);
  started:=clock_timestamp();
  result:=public.norva_activate_selection_shared_catalog(s,u,rev,(snap->>'generationId')::uuid,
    (snap->>'headRevision')::bigint,(snap->>'configRevision')::bigint,
    (snap->>'sourceVisibilityEpoch')::bigint,(snap->>'userVisibilityEpoch')::bigint);
  if result->>'activated' is distinct from 'true' then raise exception 'Activation failed: %',result; end if;
  raise notice 'Activation ms: %',1000*extract(epoch from clock_timestamp()-started);
  select count(*) into n from public.cloud_media_items where user_id=u;
  if n<>0 then raise exception 'Activation materialized owner media'; end if;
  select count(*) into n from public.cloud_titles where user_id=u;
  if n<>0 then raise exception 'Activation materialized owner titles'; end if;
  select count(*) into expected from public.selection_shared_media where release_id=r;
  started:=clock_timestamp();
  select count(*) into n from public.cloud_catalog_visible_media_items where user_id=u and source_id=s;
  if n<>expected then raise exception 'Incomplete catalog: %, expected %',n,expected; end if;
  raise notice 'Visible raw count %, ms %',n,1000*extract(epoch from clock_timestamp()-started);
  select count(*) into expected from public.selection_shared_titles where release_id=r;
  started:=clock_timestamp();
  select count(*) into n from public.cloud_catalog_visible_titles where user_id=u;
  if n<>expected then raise exception 'Incomplete titles: %, expected %',n,expected; end if;
  raise notice 'Visible title count %, ms %',n,1000*extract(epoch from clock_timestamp()-started);
  select visibility_epoch into epoch from public.cloud_user_catalog_visibility_epochs where user_id=u;
  started:=clock_timestamp();
  page:=public.norva_select_catalog_title_ordered_page(u,'movie','home_recent',36,108,null,epoch);
  if jsonb_array_length(page->'items')<>36 or page->>'complete'<>'false' then raise exception 'Incomplete Home page'; end if;
  select array_agg((value->>'id')::uuid) into ids from jsonb_array_elements(page->'items');
  result:=public.norva_get_visible_catalog_titles_by_ids(u,ids,epoch);
  if jsonb_array_length(result->'items')<>36 then raise exception 'Home hydration omitted shared titles'; end if;
  if exists(select 1 from jsonb_array_elements(result->'items') x where x->>'user_id'<>u::text) then raise exception 'Home foreign owner'; end if;
  page:=public.norva_select_catalog_title_ordered_page(u,'movie','home_recent',36,108,page->'nextCursor',epoch);
  if exists(select 1 from jsonb_array_elements(page->'items') x where (x->>'id')::uuid=any(ids)) then raise exception 'Home paging repeated items'; end if;
  raise notice 'Home selection, hydration and cursor ms %',1000*extract(epoch from clock_timestamp()-started);
  started:=clock_timestamp();
  result:=public.list_media_items_deduped(u,'movie',s,null,null,null,null,null,null,'default',36,0);
  if jsonb_array_length(result->'items')<36 then raise exception 'Media page omitted shared films'; end if;
  select count(*) into n from public.search_media_items(u,'movie','Creed',24,false);
  if n<1 then raise exception 'Shared search omitted Creed'; end if;
  select count(*) into n from public.cloud_genre_bucket_counts(u,'movie',s);
  if n<2 then raise exception 'Shared genres absent'; end if;
  raise notice 'Grid, search and genres ms %',1000*extract(epoch from clock_timestamp()-started);
  started:=clock_timestamp();
  perform count(*) from public.norva_selection_shared_languages(u,'movie',s,'audio',null);
  raise notice 'Shared language projection ms %',1000*extract(epoch from clock_timestamp()-started);
  started:=clock_timestamp();
  perform count(*) from public.cloud_catalog_effective_audio_before_shared(u,'movie',s,null);
  raise notice 'Physical language projection ms %',1000*extract(epoch from clock_timestamp()-started);
  started:=clock_timestamp();
  langs:=public.norva_catalog_movie_audio_language_counts(u,s);
  if langs='{}'::jsonb then raise exception 'Shared languages absent'; end if;
  raise notice 'Language counts %, ms %',langs,1000*extract(epoch from clock_timestamp()-started);
  started:=clock_timestamp();
  result:=public.cloud_catalog_visible_title_language_page(u,'movie',s,'{"audio":"catalog-pt","limit":36}');
  if jsonb_array_length(result->'titleIds')<>36 then raise exception 'Audio filter missing shared films'; end if;
  result:=public.norva_get_genre_rail_candidates(u,'movie',epoch);
  if result->'candidates'='{}'::jsonb then raise exception 'Genre rails absent'; end if;
  select count(*) into n from public.cloud_catalog_visible_live_logical_channels where user_id=u and source_id=s;
  if n<>jsonb_array_length(publication->'live'->'channels') then raise exception 'Live channels absent: %',n; end if;
  select count(*) into n from public.cloud_catalog_visible_live_variants where user_id=u and source_id=s;
  if n<>21 then raise exception 'Live variants absent: %',n; end if;
  raise notice 'Audio filtering, genre rails and live catalog ms %',1000*extract(epoch from clock_timestamp()-started);
  execute 'reset role';
  insert into auth.users(id,email,created_at,updated_at) values(u2,'selection-shared-'||u2::text||'@example.invalid',now(),now());
  s2:=overlay(public.norva_selection_shared_uuid('norva-selection-curated-v1:'||u2::text)::text placing '4' from 15)::uuid;
  insert into public.cloud_sources(id,user_id,source_type,display_name,enabled,sync_status)
    values(s2,u2,'m3u','Second Selection fixture',true,'syncing');
  execute 'set local role service_role';
  other_snap:=public.norva_get_catalog_write_snapshot(s2,u2);
  perform public.norva_activate_selection_shared_catalog(s2,u2,rev,(other_snap->>'generationId')::uuid,
    (other_snap->>'headRevision')::bigint,(other_snap->>'configRevision')::bigint,
    (other_snap->>'sourceVisibilityEpoch')::bigint,(other_snap->>'userVisibilityEpoch')::bigint);
  if exists(select 1 from public.cloud_media_items where user_id=u2) then raise exception 'Second account copied inventory'; end if;
  if exists(select 1 from public.cloud_catalog_visible_titles a join public.cloud_catalog_visible_titles b on a.id=b.id
    where a.user_id=u and b.user_id=u2) then raise exception 'Owners share title identities'; end if;
  if exists(select 1 from public.cloud_catalog_visible_title_variants a join public.cloud_catalog_visible_title_variants b on a.id=b.id
    where a.user_id=u and b.user_id=u2) then raise exception 'Owners share variant identities'; end if;
  started:=clock_timestamp();
  select v.external_id,v.title_id into file_id,expected_title_id from public.cloud_catalog_visible_title_variants v
    where v.user_id=u and v.source_id=s and v.item_type='movie' and v.raw_title ilike '%Creed II%' limit 1;
  if file_id is null then raise exception 'Playback fixture missing'; end if;
  result:=public.norva_bind_selection_shared_file(u,s,'movie',file_id);
  if (result->>'bound')::int<>1 then raise exception 'Expected one lazy file'; end if;
  if not exists(select 1 from public.cloud_title_variants v where v.user_id=u and v.source_id=s
    and v.item_type='movie' and v.external_id=file_id and v.title_id=expected_title_id) then raise exception 'Lazy title identity changed'; end if;
  select count(*) into n from public.cloud_catalog_visible_media_items where user_id=u and source_id=s;
  select count(*) into expected from public.selection_shared_media where release_id=r;
  if n<>expected then raise exception 'Lazy binding changed visible media count'; end if;
  result:=public.norva_bind_selection_shared_file(u,s,'movie',file_id);
  if (result->>'bound')::int<>0 then raise exception 'Lazy replay was not idempotent'; end if;
  raise notice 'Movie lazy binding and replay ms %',1000*extract(epoch from clock_timestamp()-started);
  if exists(select 1 from public.cloud_media_items where user_id=u2) then raise exception 'Playback wrote to another owner'; end if;
  -- A second ordinary provider shares this title identity but keeps its own file.
  other:=gen_random_uuid();
  insert into public.cloud_sources(id,user_id,source_type,display_name,enabled,sync_status)
    values(other,u,'m3u','Ordinary provider fixture',true,'ready');
  other_snap:=public.norva_get_catalog_write_snapshot(other,u);
  select to_jsonb(m) into own_media from public.cloud_media_items m where m.user_id=u and m.source_id=s and m.external_id=file_id;
  own_media:=own_media||jsonb_build_object('id',gen_random_uuid(),'source_id',other,'external_id','other-file',
    'generation_id',other_snap->'generationId','write_head_revision',other_snap->'headRevision',
    'write_config_revision',other_snap->'configRevision','write_source_visibility_epoch',other_snap->'sourceVisibilityEpoch',
    'write_user_visibility_epoch',other_snap->'userVisibilityEpoch');
  insert into public.cloud_media_items select * from jsonb_populate_record(null::public.cloud_media_items,own_media);
  other_snap:=public.norva_get_catalog_write_snapshot(other,u);
  select to_jsonb(v) into own_variant from public.cloud_title_variants v where v.user_id=u and v.source_id=s and v.external_id=file_id;
  own_variant:=own_variant||jsonb_build_object('id',gen_random_uuid(),'source_id',other,'external_id','other-file','media_item_id',own_media->'id',
    'generation_id',other_snap->'generationId','write_head_revision',other_snap->'headRevision',
    'write_config_revision',other_snap->'configRevision','write_source_visibility_epoch',other_snap->'sourceVisibilityEpoch',
    'write_user_visibility_epoch',other_snap->'userVisibilityEpoch');
  insert into public.cloud_title_variants select * from jsonb_populate_record(null::public.cloud_title_variants,own_variant);
  select count(*) into title_count from public.cloud_catalog_visible_titles where user_id=u and id=expected_title_id;
  if title_count<>1 then raise exception 'Mixed provider title was duplicated'; end if;
  select count(*) into n from public.cloud_catalog_visible_title_variants where user_id=u and title_id=expected_title_id;
  if n<2 then raise exception 'Mixed provider variants omitted'; end if;
  select visibility_epoch into epoch from public.cloud_user_catalog_visibility_epochs where user_id=u;
  result:=public.norva_get_visible_catalog_titles_by_ids(u,array[expected_title_id],epoch);
  if jsonb_array_length(result->'items')<>1 then raise exception 'Mixed title hydration changed'; end if;
  page:=public.norva_select_catalog_title_ordered_page(u,'movie','home_recent',36,108,null,epoch);
  if jsonb_array_length(page->'items')<>36 then raise exception 'Mixed page incomplete'; end if;
  raise notice 'Two accounts, private bindings and mixed-provider title passed';
  select external_id into file_id from public.selection_shared_media where release_id=r and item_type='episode' limit 1;
  result:=public.norva_bind_selection_shared_file(u,s,'series',file_id);
  if (result->>'bound')::int<>2 then raise exception 'Episode must bind only itself and its parent'; end if;
  if exists(select 1 from public.selection_shared_visible_media where source_id=s and user_id<>u) then
    raise exception 'Foreign owner exposure'; end if;
  begin
    perform public.norva_activate_selection_shared_catalog(s,u,rev,(snap->>'generationId')::uuid,
      (snap->>'headRevision')::bigint,(snap->>'configRevision')::bigint,
      (snap->>'sourceVisibilityEpoch')::bigint,(snap->>'userVisibilityEpoch')::bigint);
    raise exception 'Stale enrollment was accepted';
  exception when sqlstate 'PT409' then null; end;
  begin
    perform public.norva_bind_selection_shared_file(gen_random_uuid(),s,'movie',file_id);
    -- Non-canonical owner is an explicit no-op, never a binding.
  exception when sqlstate '42501' then null; end;
  if exists(select 1 from public.cloud_media_items where source_id=s and user_id<>u) then raise exception 'Foreign lazy binding'; end if;
  update public.cloud_sources set enabled=false where id=s and user_id=u;
  if exists(select 1 from public.cloud_catalog_visible_media_items where source_id=s and user_id=u) then
    raise exception 'Disabled source remains visible'; end if;
  if exists(select 1 from public.cloud_catalog_visible_titles where user_id=u and s=any(visible_source_ids)) then
    raise exception 'Disabled source titles remain visible'; end if;
  if not exists(select 1 from public.cloud_catalog_visible_titles where user_id=u2) then raise exception 'Disabling one owner hides another'; end if;
  raise notice 'Shared activation, full visibility, zero owner rows and disabled source isolation passed';
end
$test$;

