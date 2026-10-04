begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

-- Read only: recover alternate logical title IDs for one already-owned movie.
-- Provider labels/posters and language guesses are never identity evidence.
create function public.norva_movie_recovery_validated_tmdb(p_title jsonb)
returns text language plpgsql immutable parallel safe set search_path='' as $f$
declare evidence jsonb; canonical text:=p_title->>'provider_tmdb_id';
begin
 if p_title->>'item_type' is distinct from 'movie'
   or coalesce(p_title->>'match_status','') not in ('matched','manual','provider_verified')
   or canonical is null or canonical !~ '^[1-9][0-9]{0,15}$' then return null; end if;
 if nullif(p_title->>'overlay_generation_id','') is not null then
   if p_title->>'overlay_generation_id' is distinct from p_title->>'display_generation_id' then return null; end if;
   evidence:=p_title->'overlay_catalog_metadata';
 else evidence:=p_title->'metadata'; end if;
 if evidence#>'{tmdbValidation,valid}' is distinct from 'true'::jsonb
   or evidence#>>'{tmdb,id}' is distinct from canonical then return null; end if;
 return canonical;
end $f$;

create function public.norva_get_owned_movie_recovery_title_ids(
 p_user_id uuid,p_anchor_title_id uuid,p_expected_visibility_epoch bigint,p_limit integer default 64
) returns jsonb language plpgsql stable security definer set search_path='' set jit=off as $f$
declare snapshot jsonb; anchor jsonb; canonical text; candidates uuid[]; result_ids uuid[];
 epoch bigint; row_data jsonb;
begin
 perform public.norva_credential_require_service_role();
 if p_user_id is null or p_anchor_title_id is null or p_expected_visibility_epoch is null
   or p_limit is null or p_limit not between 1 and 64 then
   raise exception 'Invalid movie recovery arguments' using errcode='22023'; end if;
 epoch:=public.norva_user_catalog_visibility_epoch(p_user_id);
 if epoch<>p_expected_visibility_epoch then
   raise exception 'Catalog visibility changed' using errcode='PT409'; end if;
 snapshot:=public.norva_get_visible_catalog_titles_by_ids(p_user_id,array[p_anchor_title_id],epoch);
 if snapshot->>'contract' is distinct from 'catalog-title-hydration-v3'
   or snapshot->>'visibilityEpoch' is distinct from epoch::text
   or jsonb_typeof(snapshot->'items') is distinct from 'array' then
   raise exception 'Catalog hydration unavailable' using errcode='PT409'; end if;
 select value into anchor from jsonb_array_elements(snapshot->'items')
   where value->>'id'=p_anchor_title_id::text and value->>'user_id'=p_user_id::text
     and value->>'item_type'='movie' and (value->>'variant_count')::integer>0;
 if anchor is null then raise exception 'Owned movie is no longer visible' using errcode='PT409'; end if;
 result_ids:=array[p_anchor_title_id];
 canonical:=public.norva_movie_recovery_validated_tmdb(anchor);
 if canonical is not null then
   -- Limit each candidate path before hydration. Physical paths use existing
   -- owner/TMDB indexes; Selection is scoped to published enrolled releases.
   -- Current hydration remains authoritative for visibility and generation.
   with base as materialized (
     select t.id from public.cloud_titles t
     where t.user_id=p_user_id and t.item_type='movie' and t.provider_tmdb_id=canonical
     limit p_limit+1
   ), projections as materialized (
     select distinct p.title_id id from public.cloud_source_catalog_generation_candidate_titles p
     join public.cloud_source_catalog_heads h on h.user_id=p.user_id and h.source_id=p.source_id
       and h.active_generation_id=p.generation_id
     join public.cloud_catalog_visible_sources s on s.user_id=p.user_id and s.id=p.source_id
     where p.user_id=p_user_id and p.item_type='movie' and p.provider_tmdb_id=canonical
     limit p_limit+1
   ), shared as materialized (
     select distinct coalesce(owned.id,public.norva_selection_shared_uuid(
       'title:'||e.user_id::text||':'||t.item_type||':'||t.identity_key)) id
     from public.selection_shared_visible_enrollments e
     join public.selection_shared_titles t on t.release_id=e.release_id
       and t.item_type='movie' and t.provider_tmdb_id=canonical
     left join public.cloud_titles owned on owned.user_id=e.user_id
       and owned.item_type=t.item_type and owned.identity_key=t.identity_key
     where e.user_id=p_user_id
     limit p_limit+1
   ), ids as (
     select p_anchor_title_id id union select id from base
     union select id from projections union select id from shared
   ) select array_agg(id order by id) into candidates from (select id from ids limit p_limit+1) bounded;
   if cardinality(candidates)>p_limit then
     raise exception 'Movie recovery candidates exceed bound' using errcode='54000'; end if;
   snapshot:=public.norva_get_visible_catalog_titles_by_ids(p_user_id,candidates,epoch);
   if snapshot->>'contract' is distinct from 'catalog-title-hydration-v3'
     or snapshot->>'visibilityEpoch' is distinct from epoch::text
     or jsonb_typeof(snapshot->'items') is distinct from 'array' then
     raise exception 'Catalog hydration unavailable' using errcode='PT409'; end if;
   for row_data in select value from jsonb_array_elements(snapshot->'items') loop
     if row_data->>'user_id' is distinct from p_user_id::text
       or not ((row_data->>'id')::uuid=any(candidates)) then
       raise exception 'Catalog hydration scope changed' using errcode='PT409'; end if;
     if row_data->>'id'<>p_anchor_title_id::text and (row_data->>'variant_count')::integer>0
       and public.norva_movie_recovery_validated_tmdb(row_data)=canonical then
       result_ids:=array_append(result_ids,(row_data->>'id')::uuid);
     end if;
   end loop;
   if not exists(select 1 from jsonb_array_elements(snapshot->'items') x
       where x->>'id'=p_anchor_title_id::text and x->>'user_id'=p_user_id::text
         and (x->>'variant_count')::integer>0
         and public.norva_movie_recovery_validated_tmdb(x)=canonical) then
     raise exception 'Movie identity changed during recovery' using errcode='PT409'; end if;
 end if;
 if public.norva_user_catalog_visibility_epoch(p_user_id)<>epoch then
   raise exception 'Catalog visibility changed' using errcode='PT409'; end if;
 select array_agg(id order by (id=p_anchor_title_id) desc,id) into result_ids
 from (select distinct unnest(result_ids) id) unique_ids;
 return jsonb_build_object('contract','owned-movie-recovery-v1','visibilityEpoch',epoch,
   'anchorTitleId',p_anchor_title_id,'titleIds',to_jsonb(result_ids));
end $f$;

revoke all on function public.norva_movie_recovery_validated_tmdb(jsonb),
 public.norva_get_owned_movie_recovery_title_ids(uuid,uuid,bigint,integer) from public,anon,authenticated;
grant execute on function public.norva_movie_recovery_validated_tmdb(jsonb),
 public.norva_get_owned_movie_recovery_title_ids(uuid,uuid,bigint,integer) to service_role;
notify pgrst,'reload schema';
commit;
