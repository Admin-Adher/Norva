-- Bound parent verification to the requested media IDs even while import
-- statistics underestimate a freshly assigned catalogue version.
begin;
set local lock_timeout='2s';
do $patch$
declare body text; old_join text; new_join text;
begin
 select pg_get_functiondef(oid) into strict body from pg_proc
 where pronamespace='public'::regnamespace and proname='norva_upsert_active_catalog_title_variants';
 old_join := E'left join public.cloud_media_items item\n      on item.id = input.media_item_id and item.generation_id = p_generation_id';
 new_join := E'left join lateral (\n      -- OFFSET 0 keeps the unique-ID lookup parameterized. Otherwise stale\n      -- version statistics can produce a full-catalogue nested-loop scan.\n      select parent.id,parent.generation_id,parent.user_id,parent.source_id,\n        parent.item_type,parent.external_id,parent.catalog_version,\n        parent.projection_refresh_run_id\n      from public.cloud_media_items parent\n      where parent.id = input.media_item_id\n      offset 0\n    ) item on item.generation_id = p_generation_id';
 if position(old_join in body)=0 or
    (length(body)-length(replace(body,old_join,'')))/length(old_join)<>1 then
   raise exception 'variant parent proof function drift' using errcode='55000';
 end if;
 execute replace(body,old_join,new_join);
end $patch$;
commit;
