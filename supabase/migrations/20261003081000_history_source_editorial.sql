-- Keep generation tables private. Expose only bounded, owned presentation
-- metadata for the exact source/generation of a currently visible variant.
begin;
create function public.norva_get_history_source_editorial(
 p_user_id uuid,p_source_id uuid,p_item_type text,p_generation_id uuid,
 p_title_ids uuid[],p_expected_visibility_epoch bigint
) returns jsonb language plpgsql stable security definer set search_path='' set jit=off as $f$
declare
 v_role text:=coalesce(nullif(auth.jwt()->>'role',''),nullif(current_setting('request.jwt.claim.role',true),''),nullif(current_setting('role',true),'none'),'');
 v_epoch bigint;
 v_result jsonb;
begin
 if v_role<>'service_role' and not (v_role in ('','postgres') and session_user='postgres') then
  raise exception 'service role required' using errcode='42501';
 end if;
 if p_user_id is null or p_source_id is null or p_generation_id is null
  or p_item_type is null or p_item_type not in ('movie','series')
  or p_title_ids is null or cardinality(p_title_ids) not between 1 and 100
  or array_position(p_title_ids,null) is not null or p_expected_visibility_epoch is null then
  raise exception 'invalid history editorial arguments' using errcode='22023';
 end if;
 v_epoch:=public.norva_user_catalog_visibility_epoch(p_user_id);
 if v_epoch<>p_expected_visibility_epoch then
  raise exception 'catalog visibility changed' using errcode='40001';
 end if;
 select jsonb_build_object('contract','history-source-editorial-v1','visibilityEpoch',v_epoch,
  'items',coalesce(jsonb_agg(jsonb_build_object(
   'user_id',p.user_id,'source_id',p.source_id,'item_type',p.item_type,
   'title_id',p.title_id,'generation_id',p.generation_id,'match_status',p.match_status,
   'title',p.title,'poster_url',p.poster_url,'backdrop_url',p.backdrop_url,
   'release_year',p.release_year,'rating_num',p.rating_num,
   'metadata',jsonb_strip_nulls(jsonb_build_object('i18n',p.metadata->'i18n',
    'overview',p.metadata->'overview','plot',p.metadata->'plot','genres',p.metadata->'genres')),
   'catalog_metadata',jsonb_strip_nulls(jsonb_build_object(
    'tmdbValidation',jsonb_build_object('valid',true),'i18n',p.catalog_metadata->'i18n',
    'overview',p.catalog_metadata->'overview','plot',p.catalog_metadata->'plot','genres',p.catalog_metadata->'genres',
    'tmdb',jsonb_strip_nulls(jsonb_build_object('overview',p.catalog_metadata#>'{tmdb,overview}',
     'vote_average',p.catalog_metadata#>'{tmdb,vote_average}','genres',p.catalog_metadata#>'{tmdb,genres}')))
   )
  ) order by p.title_id),'[]'::jsonb)) into v_result
 from public.cloud_source_catalog_generation_candidate_titles p
 where p.user_id=p_user_id and p.source_id=p_source_id and p.item_type=p_item_type
  and p.generation_id=p_generation_id and p.title_id=any(p_title_ids)
  and p.match_status in ('matched','manual','provider_verified')
  and p.catalog_metadata#>'{tmdbValidation,valid}'='true'::jsonb
  and exists(select 1 from public.cloud_catalog_visible_sources s
   where s.user_id=p_user_id and s.id=p_source_id)
  and exists(select 1 from public.cloud_catalog_visible_title_variants v
   where v.user_id=p_user_id and v.source_id=p_source_id and v.item_type=p_item_type
    and v.generation_id=p_generation_id and v.title_id=p.title_id);
 if octet_length(v_result::text)>8388608 then
  raise exception 'history editorial response exceeds bound' using errcode='54000';
 end if;
 if public.norva_user_catalog_visibility_epoch(p_user_id)<>v_epoch then
  raise exception 'catalog visibility changed' using errcode='40001';
 end if;
 return v_result;
end $f$;
revoke all on function public.norva_get_history_source_editorial(uuid,uuid,text,uuid,uuid[],bigint) from public,anon,authenticated;
grant execute on function public.norva_get_history_source_editorial(uuid,uuid,text,uuid,uuid[],bigint) to service_role;
commit;
