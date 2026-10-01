begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

-- Playback observations and reactions have physical FK targets. Create only
-- the selected file (and an episode's parent), under the normal write fences.
-- Browsing and activation never call this function for the entire inventory.
create function public.norva_bind_selection_shared_file(p_user_id uuid,p_source_id uuid,p_item_type text,p_external_id text)
returns jsonb language plpgsql security definer set search_path='' set jit=off as $f$
declare e public.selection_shared_enrollments; snap jsonb; media jsonb; row jsonb; variant jsonb; title jsonb;
  selected public.selection_shared_media; bound integer:=0; evidence jsonb;
begin
 perform public.norva_credential_require_service_role();
 if p_user_id is null or p_source_id is null or p_item_type not in ('movie','series','episode','live')
   or nullif(p_external_id,'') is null then raise exception 'Exact file coordinates required' using errcode='22023'; end if;
 if not public.norva_selection_source_identity_valid(p_source_id,p_user_id) then return jsonb_build_object('bound',0); end if;
 select * into e from public.selection_shared_enrollments where user_id=p_user_id and source_id=p_source_id;
 if e.source_id is null then return jsonb_build_object('bound',0); end if;
 perform 1 from public.cloud_sources s where s.id=p_source_id and s.user_id=p_user_id for share;
 perform 1 from public.cloud_source_catalog_heads h join public.cloud_source_lifecycle l on l.source_id=h.source_id and l.user_id=h.user_id
   where h.source_id=p_source_id and h.user_id=p_user_id for share of h,l;
 perform 1 from public.cloud_user_catalog_visibility_epochs v where v.user_id=p_user_id for update;
 snap:=public.norva_get_catalog_write_snapshot(p_source_id,p_user_id);
 if not exists(select 1 from public.selection_shared_visible_enrollments where source_id=p_source_id and user_id=p_user_id)
   or (snap->>'generationId')::uuid is distinct from e.generation_id or (snap->>'configRevision')::bigint is distinct from e.config_revision then
   raise exception 'Shared enrollment changed' using errcode='PT409'; end if;
 select * into selected from public.selection_shared_media m where m.release_id=e.release_id and m.external_id=p_external_id
   and (m.item_type=p_item_type or (p_item_type='series' and m.item_type='episode')) and m.available;
 if selected.external_id is null then raise exception 'Shared file unavailable' using errcode='P0002'; end if;
 select coalesce(jsonb_agg(to_jsonb(m) order by m.item_type='episode'),'[]') into media
 from public.selection_shared_visible_media m where m.user_id=p_user_id and m.source_id=p_source_id and m.generation_id=e.generation_id
   and ((m.item_type=selected.item_type and m.external_id=selected.external_id)
     or (selected.item_type='episode' and m.item_type='series' and m.external_id=selected.parent_external_id));
 for row in select value from jsonb_array_elements(media) loop
   snap:=public.norva_get_catalog_write_snapshot(p_source_id,p_user_id);
   row:=row||jsonb_build_object('write_head_revision',snap->'headRevision','write_config_revision',snap->'configRevision',
     'write_source_visibility_epoch',snap->'sourceVisibilityEpoch','write_user_visibility_epoch',snap->'userVisibilityEpoch');
   insert into public.cloud_media_items(id,user_id,source_id,item_type,external_id,parent_external_id,title,subtitle,poster_url,backdrop_url,metadata,playback_hint,available,created_at,updated_at,added_at,rating_num,release_year,catalog_version,dedup_key,is_dedup_primary,generation_id,ingest_job_id,ingest_attempt,ingest_lease_owner,write_head_revision,write_config_revision,write_source_visibility_epoch,write_user_visibility_epoch,projection_refresh_run_id)
   select r.id,r.user_id,r.source_id,r.item_type,r.external_id,r.parent_external_id,r.title,r.subtitle,r.poster_url,r.backdrop_url,r.metadata,r.playback_hint,r.available,r.created_at,r.updated_at,r.added_at,r.rating_num,r.release_year,r.catalog_version,r.dedup_key,r.is_dedup_primary,r.generation_id,r.ingest_job_id,r.ingest_attempt,r.ingest_lease_owner,r.write_head_revision,r.write_config_revision,r.write_source_visibility_epoch,r.write_user_visibility_epoch,r.projection_refresh_run_id from jsonb_populate_record(null::public.cloud_media_items,row) r
   on conflict(source_id,generation_id,item_type,external_id) do nothing;
   bound:=bound+1;
 end loop;
 select to_jsonb(v) into variant from public.selection_shared_visible_variants v
 where v.user_id=p_user_id and v.source_id=p_source_id and v.generation_id=e.generation_id
   and v.item_type=case when selected.item_type='episode' then 'series' else selected.item_type end
   and v.external_id=case when selected.item_type='episode' then selected.parent_external_id else selected.external_id end;
 if variant is not null then
   select to_jsonb(t) into title from public.cloud_catalog_visible_titles t where t.user_id=p_user_id and t.id=(variant->>'title_id')::uuid;
   if title is null then raise exception 'Shared title missing' using errcode='PT409'; end if;
   insert into public.cloud_titles(id,user_id,item_type,identity_key,identity_source,provider_tmdb_id,provider_imdb_id,match_status,title,original_title,release_year,poster_url,backdrop_url,metadata,default_variant_id,variant_count,last_observed_ttff_ms,synced_at,created_at,updated_at,version_languages,audio_languages,audio_probed_at,audio_tracks,genre_category,genre_payload,subtitle_tracks,subtitle_probed_at,whisper_attempted_at,year_backfill_attempted_at,revalidate_attempted_at,search_match_attempted_at,audio_lang_verified_at,genre_buckets,rating_num,file_audio_languages,file_subtitle_languages,file_audio_verified_languages)
   select r.id,r.user_id,r.item_type,r.identity_key,r.identity_source,r.provider_tmdb_id,r.provider_imdb_id,r.match_status,r.title,r.original_title,r.release_year,r.poster_url,r.backdrop_url,r.metadata,r.default_variant_id,r.variant_count,r.last_observed_ttff_ms,r.synced_at,r.created_at,r.updated_at,r.version_languages,r.audio_languages,r.audio_probed_at,r.audio_tracks,r.genre_category,r.genre_payload,r.subtitle_tracks,r.subtitle_probed_at,r.whisper_attempted_at,r.year_backfill_attempted_at,r.revalidate_attempted_at,r.search_match_attempted_at,r.audio_lang_verified_at,r.genre_buckets,r.rating_num,r.file_audio_languages,r.file_subtitle_languages,r.file_audio_verified_languages from jsonb_populate_record(null::public.cloud_titles,title) r
   on conflict(user_id,item_type,identity_key) do nothing;
   snap:=public.norva_get_catalog_write_snapshot(p_source_id,p_user_id);
   variant:=variant||jsonb_build_object('write_head_revision',snap->'headRevision','write_config_revision',snap->'configRevision',
     'write_source_visibility_epoch',snap->'sourceVisibilityEpoch','write_user_visibility_epoch',snap->'userVisibilityEpoch');
   insert into public.cloud_title_variants(id,user_id,title_id,source_id,media_item_id,item_type,external_id,raw_title,label,language,quality,resolution,container_extension,poster_url,playback_hint,codec_profile,compatibility_tier,playback_cost_score,last_observed_ttff_ms,observed_success_rate,metadata,created_at,updated_at,audio_whisper_attempted_at,audio_whisper_retry_at,audio_lang_verified_at,audio_lang_verify_retry_at,generation_id,ingest_job_id,ingest_attempt,ingest_lease_owner,write_head_revision,write_config_revision,write_source_visibility_epoch,write_user_visibility_epoch,projection_refresh_run_id)
   select r.id,r.user_id,r.title_id,r.source_id,r.media_item_id,r.item_type,r.external_id,r.raw_title,r.label,r.language,r.quality,r.resolution,r.container_extension,r.poster_url,r.playback_hint,r.codec_profile,r.compatibility_tier,r.playback_cost_score,r.last_observed_ttff_ms,r.observed_success_rate,r.metadata,r.created_at,r.updated_at,r.audio_whisper_attempted_at,r.audio_whisper_retry_at,r.audio_lang_verified_at,r.audio_lang_verify_retry_at,r.generation_id,r.ingest_job_id,r.ingest_attempt,r.ingest_lease_owner,r.write_head_revision,r.write_config_revision,r.write_source_visibility_epoch,r.write_user_visibility_epoch,r.projection_refresh_run_id from jsonb_populate_record(null::public.cloud_title_variants,variant) r
   on conflict(source_id,generation_id,item_type,external_id) do nothing;
 end if;
 if bound>0 and selected.item_type='movie' then
   if selected.file_tags->>'probedAt' is not null and public.selection_audio_tracks_complete(selected.file_tags->'audioTracks') then
     snap:=public.norva_get_catalog_write_snapshot(p_source_id,p_user_id);
     evidence:=jsonb_build_object('externalId',selected.external_id,
       'urlSha256',encode(sha256(convert_to(selected.playback_hint->>'targetUrl','UTF8')),'hex'),
       'revision',selected.metadata->'selectionRevision','feedId',selected.metadata->'discoveryFeed',
       'probedAt',selected.file_tags->'probedAt','audioTracks',selected.file_tags->'audioTracks',
       'subtitleTracks',selected.file_tags->'subtitleTracks','hasSubtitle',selected.file_tags->'hasSubtitle');
     perform public.hydrate_selection_snapshot_movie_languages(p_user_id,p_source_id,e.generation_id,
       (snap->>'headRevision')::bigint,(snap->>'configRevision')::bigint,
       (snap->>'sourceVisibilityEpoch')::bigint,(snap->>'userVisibilityEpoch')::bigint,jsonb_build_array(evidence));
   end if;
   snap:=public.norva_get_catalog_write_snapshot(p_source_id,p_user_id);
   perform public.hydrate_selection_audio_results(p_user_id,p_source_id,e.generation_id,
     (snap->>'headRevision')::bigint,(snap->>'configRevision')::bigint,
     (snap->>'sourceVisibilityEpoch')::bigint,(snap->>'userVisibilityEpoch')::bigint,array[selected.external_id]);
 elsif bound>0 and selected.item_type='episode' then
   snap:=public.norva_get_catalog_write_snapshot(p_source_id,p_user_id);
   perform public.hydrate_selection_episode_file_languages(p_user_id,p_source_id,e.generation_id,
     (snap->>'headRevision')::bigint,(snap->>'configRevision')::bigint,
     (snap->>'sourceVisibilityEpoch')::bigint,(snap->>'userVisibilityEpoch')::bigint,array[selected.parent_external_id]);
 end if;
 return jsonb_build_object('bound',bound,'generationId',e.generation_id);
end
$f$;
revoke all on function public.norva_bind_selection_shared_file(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.norva_bind_selection_shared_file(uuid,uuid,text,text) to service_role;
commit;
