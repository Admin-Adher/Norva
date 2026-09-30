-- Resolve provider category IDs from the same verified refresh run before
-- writing media; return the resolved label to the title/live projections.
begin;
set local lock_timeout='2s';
do $patch$
declare body text; needle text;
begin
 select pg_get_functiondef('public.norva_upsert_active_catalog_media_items(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,bigint,jsonb)'::regprocedure) into body;
 needle:=E'  perform set_config(\n    ''norva.catalog_active_variant_refresh'',';
 if position(needle in body)=0 or position('''externalId'',item.external_id' in body)=0 then
  raise exception 'active media category patch source changed';
 end if;
 body:=replace(body,needle,$insert$
  update pg_temp.norva_active_media_input input
  set subtitle=coalesce(nullif(btrim(input.subtitle),''),category.category_name),
      metadata=input.metadata || jsonb_build_object('categoryName',category.category_name)
  from public.cloud_source_catalog_generation_categories category
  where category.generation_id=p_generation_id and category.user_id=p_user_id
    and category.source_id=p_source_id and category.projection_refresh_run_id=p_refresh_run_id
    and category.category_kind=case input.item_type when 'movie' then 'vod' else input.item_type end
    and category.provider_category_id=input.parent_external_id
    and nullif(btrim(input.metadata->>'categoryName'),'') is null;
$insert$ || needle);
 body:=replace(body,'''externalId'',item.external_id',
  '''externalId'',item.external_id,''categoryId'',input.parent_external_id,''categoryName'',input.metadata->>''categoryName''');
 execute body;
end $patch$;
commit;
