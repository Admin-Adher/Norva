begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

-- Historical logical IDs are kept for personal history. When no physical file
-- is visible for this media type, do not scan those retained titles to prove
-- that every candidate lacks a physical owner. Mixed catalogues keep the exact
-- existing merge and cursor path.
do $migration$
declare definition text;
 anchor text:='v_physical:=public.norva_selection_shared_physical_page(p_user_id,p_item_type,p_mode,p_limit,p_scan_limit,v_physical_cursor,p_expected_visibility_epoch);';
begin
 definition:=pg_get_functiondef('public.norva_select_catalog_title_ordered_page(uuid,text,text,integer,integer,jsonb,bigint)'::regprocedure);
 if position(anchor in definition)=0 then raise exception 'Shared page selector drift'; end if;
 execute replace(definition,anchor,$replacement$
 if exists(select 1 from public.selection_shared_runtime_physical_variants v
   where v.user_id=p_user_id and v.item_type=p_item_type) then
   v_physical:=public.norva_selection_shared_physical_page(p_user_id,p_item_type,p_mode,p_limit,p_scan_limit,v_physical_cursor,p_expected_visibility_epoch);
 else
   v_physical:=jsonb_build_object('items','[]'::jsonb,'complete',true,'nextCursor',null);
 end if;
 $replacement$);
end $migration$;
notify pgrst,'reload schema';
commit;
