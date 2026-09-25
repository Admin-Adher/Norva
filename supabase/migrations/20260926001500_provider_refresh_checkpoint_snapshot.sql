-- Return the immutable refresh version and current action's durable category
-- count. Generation revision is a mutable CAS counter changed by payload writes.
begin;
set local lock_timeout='2s';
set local statement_timeout='30s';
do $patch$
declare
  v_oid oid := 'public.norva_begin_active_catalog_title_projection_refresh(uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint)'::regprocedure;
  v_definition text;
  v_old text := $old$'checkpoint',v_checkpoint_progress,
    'replayed',v_replayed$old$;
  v_new text := $new$'checkpoint',v_checkpoint_progress,
    'catalogVersion',(v_checkpoint_progress->>'catalogVersion')::bigint,
    'actionCategoryCount',(
      select count(*) from public.cloud_source_catalog_generation_categories category
      where category.generation_id=p_generation_id and category.user_id=p_user_id
        and category.source_id=p_source_id and category.projection_refresh_run_id=v_run_id
        and category.category_kind=case v_checkpoint_progress->>'action'
          when 'live_streams' then 'live' when 'vod_streams' then 'vod'
          when 'series_streams' then 'series' else null end
    ),
    'replayed',v_replayed$new$;
begin
  select pg_get_functiondef(v_oid) into v_definition;
  if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 then
    raise exception 'refresh snapshot return contract drifted';
  end if;
  execute replace(v_definition,v_old,v_new);
end
$patch$;
commit;
