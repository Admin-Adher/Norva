-- Avoid rollup scans when none of their inputs changed.
begin;
set local lock_timeout='2s';
CREATE OR REPLACE FUNCTION public.refresh_cloud_title_rollup_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare old_visible boolean := false; new_visible boolean := false;
begin
  -- Only these columns affect refresh_cloud_title_rollup membership/ranking.
  -- Proof, metadata and timestamp writes do not change the chosen version.
  if tg_op = 'UPDATE' and
    (old.id,old.title_id,old.user_id,old.source_id,old.generation_id,
     old.playback_cost_score,old.last_observed_ttff_ms,old.created_at)
    is not distinct from
    (new.id,new.title_id,new.user_id,new.source_id,new.generation_id,
     new.playback_cost_score,new.last_observed_ttff_ms,new.created_at) then
    return new;
  end if;
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


commit;
