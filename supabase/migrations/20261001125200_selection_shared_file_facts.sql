begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

-- Browsing must expose the same exact-file proof as a lazily bound file,
-- without creating personal observation rows for the complete catalogue.
create function public.norva_selection_shared_file_facts(p_user_id uuid,p_variant_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path='' set jit=off as $f$
declare result jsonb;
begin
 perform public.norva_credential_require_service_role();
 if p_user_id is null or coalesce(cardinality(p_variant_ids),0)>200 then
   raise exception 'Bounded owned variants required' using errcode='22023'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('variantId',v.id,'userId',v.user_id,
   'sourceId',v.source_id,'itemType',v.item_type,'externalId',v.external_id,
   'urlSha256',case when v.item_type='movie' then encode(sha256(convert_to(m.playback_hint->>'targetUrl','UTF8')),'hex') end,
   'fileTags',case when v.item_type='movie' then m.file_tags end,
   'seriesLanguages',case when v.item_type='series' then (
     select jsonb_build_object('audio',coalesce(jsonb_agg(distinct l.language) filter(where l.kind='audio'),'[]'),
       'subtitles',coalesce(jsonb_agg(distinct l.language) filter(where l.kind='subtitle'),'[]'))
     from public.selection_shared_languages l where l.release_id=e.release_id
       and l.item_type='series' and l.external_id=v.external_id) end)), '[]') into result
 from public.selection_shared_visible_variants v
 join public.selection_shared_visible_enrollments e on e.source_id=v.source_id and e.user_id=v.user_id
 left join public.selection_shared_media m on m.release_id=e.release_id and m.item_type='movie' and m.external_id=v.external_id
 where v.user_id=p_user_id and v.id=any(p_variant_ids);
 return result;
end
$f$;
revoke all on function public.norva_selection_shared_file_facts(uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.norva_selection_shared_file_facts(uuid,uuid[]) to service_role;
notify pgrst,'reload schema';
commit;
