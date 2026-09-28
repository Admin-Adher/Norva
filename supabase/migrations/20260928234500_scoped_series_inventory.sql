begin;
set local lock_timeout='3s';
set local statement_timeout='30s';
set local search_path='';

do $migration$
declare definition text; visible text; anchor text;
begin
 definition:=pg_get_functiondef('public.catalog_series_inventory_candidates(uuid,uuid,integer)'::regprocedure);
 visible:=rtrim(pg_get_viewdef('public.cloud_catalog_visible_title_variants'::regclass,true),E';\n ');
 anchor:='public.cloud_catalog_visible_sources source';
 if (length(visible)-length(replace(visible,anchor,'')))/length(anchor)<>1 then
   raise exception 'Visible variant source contract drift';
 end if;
 visible:=replace(visible,anchor,'scoped_sources source');
 anchor:='with unknowns as materialized (';
 if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1
   or (length(definition)-length(replace(definition,'from public.cloud_catalog_visible_title_variants v','')))/length('from public.cloud_catalog_visible_title_variants v')<>1 then
   raise exception 'Series inventory scope drift';
 end if;
 -- Reuse the complete visible-variant contract, including legacy null generation.
 -- Its visible source set is evaluated once for this owner/source, before rows.
 definition:=replace(definition,anchor,'with scoped_sources as materialized (
   select * from public.cloud_catalog_visible_sources where id=p_source and user_id=p_user
 ), scoped_variants as materialized (
   select scoped.* from ('||visible||') scoped
   where scoped.user_id=p_user and scoped.source_id=p_source and scoped.item_type=''series''
 ), unknowns as materialized (');
 definition:=replace(definition,'from public.cloud_catalog_visible_title_variants v','from scoped_variants v');
 anchor:='public.catalog_owned_language_metadata_enabled_for_source(p_user,p_source)';
 if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then
   raise exception 'Series metadata gate drift';
 end if;
 execute replace(definition,anchor,'(select '||anchor||')');
end $migration$;
notify pgrst,'reload schema';
commit;
