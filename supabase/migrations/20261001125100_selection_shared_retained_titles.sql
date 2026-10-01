begin;
set local lock_timeout='3s';
set local statement_timeout='30s';
-- Retained historical identities do not force every unplayed shared card
-- through physical runtime aggregation. Preserve their IDs and shared metadata.
create or replace view public.selection_shared_physical_titles with(security_invoker=true,security_barrier=true) as
( SELECT title.id,
    projection.user_id,
    projection.item_type,
    projection.identity_key,
    projection.identity_source,
    projection.provider_tmdb_id,
    projection.provider_imdb_id,
    projection.match_status,
    projection.title,
    projection.original_title,
    projection.release_year,
    projection.poster_url,
    projection.backdrop_url,
    projection.metadata,
    runtime.best_variant_id AS default_variant_id,
    runtime.variant_count,
    runtime.last_observed_ttff_ms,
    projection.synced_at,
    projection.catalog_created_at AS created_at,
    projection.updated_at,
    runtime.version_languages,
    runtime.file_audio_languages AS audio_languages,
    runtime.audio_probed_at,
    NULL::jsonb AS audio_tracks,
    projection.genre_category,
    projection.genre_payload,
    '[]'::jsonb AS subtitle_tracks,
    runtime.subtitle_probed_at,
    runtime.whisper_attempted_at,
    projection.year_backfill_attempted_at,
    projection.revalidate_attempted_at,
    projection.search_match_attempted_at,
    runtime.audio_lang_verified_at,
    projection.genre_buckets,
    projection.rating_num,
    runtime.file_audio_languages,
    runtime.file_subtitle_languages,
    runtime.file_audio_verified_languages,
    runtime.visible_source_ids,
    projection.poster_url IS NOT NULL AS has_poster
   FROM cloud_source_catalog_generation_candidate_titles projection
     JOIN cloud_titles title ON title.id = projection.title_id AND title.user_id = projection.user_id
     CROSS JOIN LATERAL norva_visible_catalog_title_runtime(title.id, title.user_id) runtime(best_variant_id, best_generation_id, display_generation_id, variant_count, last_observed_ttff_ms, version_languages, whisper_attempted_at, visible_source_ids, file_audio_languages, file_subtitle_languages, file_audio_verified_languages, audio_probed_at, subtitle_probed_at, audio_lang_verified_at)
  WHERE EXISTS (select 1 from public.selection_shared_runtime_physical_variants actual where actual.user_id=title.user_id and actual.title_id=title.id) AND projection.generation_id = runtime.display_generation_id
  ORDER BY projection.synced_at DESC, projection.updated_at DESC)
UNION ALL
( SELECT title.id,
    title.user_id,
    title.item_type,
    title.identity_key,
    title.identity_source,
    title.provider_tmdb_id,
    title.provider_imdb_id,
    title.match_status,
    title.title,
    title.original_title,
    title.release_year,
    title.poster_url,
    title.backdrop_url,
    title.metadata,
    runtime.best_variant_id AS default_variant_id,
    runtime.variant_count,
    runtime.last_observed_ttff_ms,
    title.synced_at,
    title.created_at,
    title.updated_at,
    runtime.version_languages,
    runtime.file_audio_languages AS audio_languages,
    runtime.audio_probed_at,
    NULL::jsonb AS audio_tracks,
    title.genre_category,
    title.genre_payload,
    '[]'::jsonb AS subtitle_tracks,
    runtime.subtitle_probed_at,
    runtime.whisper_attempted_at,
    title.year_backfill_attempted_at,
    title.revalidate_attempted_at,
    title.search_match_attempted_at,
    runtime.audio_lang_verified_at,
    title.genre_buckets,
    title.rating_num,
    runtime.file_audio_languages,
    runtime.file_subtitle_languages,
    runtime.file_audio_verified_languages,
    runtime.visible_source_ids,
    title.poster_url IS NOT NULL AS has_poster
   FROM cloud_titles title
     CROSS JOIN LATERAL norva_visible_catalog_title_runtime(title.id, title.user_id) runtime(best_variant_id, best_generation_id, display_generation_id, variant_count, last_observed_ttff_ms, version_languages, whisper_attempted_at, visible_source_ids, file_audio_languages, file_subtitle_languages, file_audio_verified_languages, audio_probed_at, subtitle_probed_at, audio_lang_verified_at)
  WHERE EXISTS (select 1 from public.selection_shared_runtime_physical_variants actual where actual.user_id=title.user_id and actual.title_id=title.id) AND NOT (EXISTS ( SELECT 1
           FROM cloud_source_catalog_generation_candidate_titles projection
          WHERE projection.title_id = title.id AND projection.user_id = title.user_id AND projection.generation_id = runtime.display_generation_id))
  ORDER BY title.synced_at DESC, title.updated_at DESC);
create or replace view public.selection_shared_visible_titles with(security_invoker=true) as
select
  coalesce(owned.id,public.norva_selection_shared_uuid('title:'||e.user_id::text||':'||t.item_type||':'||t.identity_key)) as id,
  e.user_id as user_id,
  t.item_type as item_type,
  t.identity_key as identity_key,
  t.identity_source as identity_source,
  t.provider_tmdb_id as provider_tmdb_id,
  t.provider_imdb_id as provider_imdb_id,
  t.match_status as match_status,
  t.title as title,
  t.original_title as original_title,
  t.release_year as release_year,
  t.poster_url as poster_url,
  t.backdrop_url as backdrop_url,
  t.metadata as metadata,
  public.norva_selection_shared_uuid('variant:'||e.source_id::text||':'||e.generation_id::text||':'||t.item_type||':'||t.default_external_id) as default_variant_id,
  t.variant_count as variant_count,
  null::integer as last_observed_ttff_ms,
  e.created_at as synced_at,
  e.created_at as created_at,
  r.published_at as updated_at,
  t.version_languages as version_languages,
  t.audio_languages as audio_languages,
  t.audio_probed_at as audio_probed_at,
  null::jsonb as audio_tracks,
  t.genre_category as genre_category,
  t.genre_payload as genre_payload,
  '[]'::jsonb as subtitle_tracks,
  t.subtitle_probed_at as subtitle_probed_at,
  null::timestamptz as whisper_attempted_at,
  null::timestamp with time zone as year_backfill_attempted_at,
  null::timestamp with time zone as revalidate_attempted_at,
  null::timestamp with time zone as search_match_attempted_at,
  t.audio_lang_verified_at as audio_lang_verified_at,
  t.genre_buckets as genre_buckets,
  t.rating_num as rating_num,
  t.file_audio_languages as file_audio_languages,
  t.file_subtitle_languages as file_subtitle_languages,
  t.file_audio_verified_languages as file_audio_verified_languages,
 array[e.source_id] as visible_source_ids, (t.poster_url is not null) as has_poster
from public.selection_shared_visible_enrollments e join public.selection_shared_releases r on r.id=e.release_id
join public.selection_shared_titles t on t.release_id=e.release_id
left join public.cloud_titles owned on owned.user_id=e.user_id and owned.item_type=t.item_type and owned.identity_key=t.identity_key
where not exists(select 1 from public.cloud_title_variants v
  left join public.cloud_source_catalog_heads head on head.user_id=v.user_id and head.source_id=v.source_id
  where v.user_id=e.user_id and v.title_id=owned.id
    and public.norva_source_catalog_visible_internal(v.source_id,v.user_id)
    and (v.generation_id is null or v.generation_id=head.active_generation_id));

create or replace view public.cloud_catalog_visible_titles with(security_invoker=true,security_barrier=true) as
 select * from public.selection_shared_physical_titles union all select * from public.selection_shared_visible_titles;
do $migration$ declare definition text; begin
 definition:=pg_get_functiondef('public.norva_selection_shared_physical_page(uuid,text,text,integer,integer,jsonb,bigint)'::regprocedure);
 if position('public.norva_visible_catalog_title_owner' in definition)=0 then raise exception 'Physical selector owner drift'; end if;
 execute replace(definition,'public.norva_visible_catalog_title_owner','public.norva_title_owner_shared_physical');
end $migration$;

create or replace function public.norva_get_visible_catalog_titles_by_ids(p_user_id uuid,p_title_ids uuid[],p_expected_visibility_epoch bigint)
returns jsonb language plpgsql stable security definer set search_path='' as $f$
declare v_result jsonb; v_shared jsonb; v_items jsonb; v_physical uuid[]; v_epoch bigint;
begin
 if not public.norva_selection_shared_active(p_user_id) then
   return public.norva_get_visible_catalog_titles_before_shared(p_user_id,p_title_ids,p_expected_visibility_epoch); end if;
 perform public.norva_credential_require_service_role();
 if p_user_id is null or p_title_ids is null or cardinality(p_title_ids) not between 1 and 500
   or array_position(p_title_ids,null) is not null or p_expected_visibility_epoch is null then
   raise exception 'Invalid catalog hydration arguments' using errcode='22023'; end if;
 select coalesce((select visibility_epoch from public.cloud_user_catalog_visibility_epochs where user_id=p_user_id),1) into v_epoch;
 if v_epoch<>p_expected_visibility_epoch then raise exception 'Catalog visibility changed' using errcode='PT409'; end if;
 select coalesce(jsonb_agg(to_jsonb(t)||jsonb_build_object('base_updated_at',t.updated_at,'overlay_catalog_metadata',null,
   'best_generation_id',e.generation_id,'display_generation_id',e.generation_id,'overlay_generation_id',null)),'[]') into v_shared
 from public.selection_shared_visible_titles t
 join public.selection_shared_visible_enrollments e on e.user_id=t.user_id and e.source_id=t.visible_source_ids[1]
 where t.user_id=p_user_id and t.id=any(p_title_ids);
 select array_agg(id) into v_physical from unnest(p_title_ids) id
 where not exists(select 1 from jsonb_array_elements(v_shared) x where x->>'id'=id::text);
 v_result:=case when cardinality(v_physical)>0 then public.norva_get_visible_catalog_titles_before_shared(p_user_id,v_physical,p_expected_visibility_epoch)
   else jsonb_build_object('contract','catalog-title-hydration-v3','visibilityEpoch',v_epoch,'items','[]'::jsonb) end;
 select coalesce(jsonb_agg(x order by array_position(p_title_ids,(x->>'id')::uuid)),'[]') into v_items
 from jsonb_array_elements((v_result->'items')||v_shared) x;
 if octet_length(v_items::text)>8388608 then raise exception 'Catalog hydration response exceeds bound' using errcode='54000'; end if;
 return jsonb_set(v_result,'{items}',v_items);
end $f$;
commit;
