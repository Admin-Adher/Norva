-- source-sync robustness: batched server-side delete of a source's catalog items via a subquery LIMIT
-- (no id list over the wire). The edge previously SELECTed ids then .delete().in('id', [2000 uuids]),
-- whose ~74KB request URL PostgREST/proxy rejected, so clearing a large catalogue (272k items) failed
-- deterministically and stranded the sync. Applied live earlier; committed here for version control.
create or replace function public.delete_source_items_batch(p_source uuid, p_user uuid, p_limit integer default 2000)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  n integer;
begin
  delete from public.cloud_media_items
   where id in (
     select id from public.cloud_media_items
      where source_id = p_source and user_id = p_user
      limit greatest(1, least(coalesce(p_limit, 2000), 10000))
   );
  get diagnostics n = row_count;
  return n;
end;
$function$;

revoke all on function public.delete_source_items_batch(uuid, uuid, integer) from public;
grant execute on function public.delete_source_items_batch(uuid, uuid, integer) to service_role;
