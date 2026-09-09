begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

-- A newly imported source can have deliberately low planner estimates until
-- autovacuum analyzes it. Materialize the requested owned parents first: the
-- old three-way join could scan every episode again for every parent item and
-- time out even for a single series. Keep every existing identity, lifecycle,
-- snapshot, exact-file and URL-hash predicate in the final join.
do $patch$
declare
  v_definition text;
  v_old text := 'with candidates as materialized (';
  v_new text := $bounded$with owned_parents as materialized (
    -- selection_episode_hydration_bounds_v1
    select parent.* from public.cloud_title_variants parent
    where parent.user_id=p_user_id and parent.source_id=p_source_id
      and parent.generation_id=p_generation_id and parent.item_type='series'
      and parent.external_id=any(p_parent_series_ids)
  ), owned_parent_items as materialized (
    select id,user_id,source_id,generation_id,item_type,available from public.cloud_media_items
    where user_id=p_user_id and source_id=p_source_id
      and generation_id=p_generation_id and item_type='series' and available
  ), candidates as materialized ($bounded$;
begin
  select replace(pg_get_functiondef('public.hydrate_selection_episode_file_languages(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text[])'::regprocedure),chr(13),'') into v_definition;
  if position('selection_episode_hydration_bounds_v1' in v_definition) = 0 then
    if position('selection_reenrollment_identity_v1' in v_definition) = 0
      or (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1
      or (length(v_definition)-length(replace(v_definition,'join public.cloud_title_variants parent','')))/length('join public.cloud_title_variants parent') <> 1
      or (length(v_definition)-length(replace(v_definition,'join public.cloud_media_items parent_item','')))/length('join public.cloud_media_items parent_item') <> 1 then
      raise exception 'Selection episode hydration definition drifted' using errcode='55000';
    end if;
    v_definition := replace(v_definition,v_old,v_new);
    v_definition := replace(v_definition,'join public.cloud_title_variants parent','join owned_parents parent');
    v_definition := replace(v_definition,'join public.cloud_media_items parent_item','join owned_parent_items parent_item');
    execute v_definition;
  end if;
end
$patch$;
notify pgrst, 'reload schema';
commit;
