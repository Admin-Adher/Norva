begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

-- Re-enrollment retains logical titles for history/reactions. The ordered
-- selector's owner resolver must bind their indexed identity before projecting
-- shared variants, just as the runtime hydrator already does.
do $migration$
declare definition text; header text;
begin
 definition:=pg_get_functiondef('public.norva_visible_catalog_title_owner(uuid,uuid)'::regprocedure);
 if position('public.cloud_catalog_visible_title_variants' in definition)=0 then raise exception 'Title owner consumer drift'; end if;
 execute replace(replace(definition,'FUNCTION public.norva_visible_catalog_title_owner(',
   'FUNCTION public.norva_title_owner_shared_physical('),'public.cloud_catalog_visible_title_variants','public.selection_shared_runtime_physical_variants');
 execute replace(replace(definition,'FUNCTION public.norva_visible_catalog_title_owner(',
   'FUNCTION public.norva_title_owner_shared_impl('),'public.cloud_catalog_visible_title_variants','public.norva_selection_title_runtime_variants(p_title_id,p_user_id)');
 header:=replace(split_part(definition,'AS $function$',1),'LANGUAGE sql','LANGUAGE plpgsql');
 execute header||$body$AS $wrapper$ begin
   if public.norva_selection_shared_active(p_user_id) then
     return query select * from public.norva_title_owner_shared_impl(p_title_id,p_user_id);
   else return query select * from public.norva_title_owner_shared_physical(p_title_id,p_user_id); end if;
 end $wrapper$;$body$;
end $migration$;
revoke all on function public.norva_title_owner_shared_physical(uuid,uuid),public.norva_title_owner_shared_impl(uuid,uuid) from public,anon,authenticated;
grant execute on function public.norva_title_owner_shared_physical(uuid,uuid),public.norva_title_owner_shared_impl(uuid,uuid) to service_role;
commit;
