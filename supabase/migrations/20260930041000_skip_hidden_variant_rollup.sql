-- A hidden candidate cannot change the head-filtered title rollup. Avoid
-- scanning its visible siblings for every staged row. Head cutover retains
-- its existing reconciliation path; active and legacy writes still refresh.
create or replace function public.refresh_cloud_title_rollup_trigger()
returns trigger language plpgsql set search_path = ''
as $function$
declare old_visible boolean := false; new_visible boolean := false;
begin
  if tg_op <> 'INSERT' then
    old_visible := old.generation_id is null or exists (
      select 1 from public.cloud_source_catalog_heads h
      where h.source_id=old.source_id and h.user_id=old.user_id
        and h.active_generation_id=old.generation_id
    );
  end if;
  if tg_op <> 'DELETE' then
    new_visible := new.generation_id is null or exists (
      select 1 from public.cloud_source_catalog_heads h
      where h.source_id=new.source_id and h.user_id=new.user_id
        and h.active_generation_id=new.generation_id
    );
  end if;
  if tg_op = 'DELETE' then
    if old_visible then perform public.refresh_cloud_title_rollup(old.title_id); end if;
    return old;
  end if;
  if new_visible or (old_visible and tg_op='UPDATE' and old.title_id=new.title_id) then
    perform public.refresh_cloud_title_rollup(new.title_id);
  end if;
  if tg_op='UPDATE' and old_visible and old.title_id is distinct from new.title_id then
    perform public.refresh_cloud_title_rollup(old.title_id);
  end if;
  return new;
end
$function$;
