-- A title may have hundreds of provider variants. Source authorization is
-- invariant within this statement: evaluate it once per owner/source pair.
begin;
set local lock_timeout='2s';
CREATE OR REPLACE FUNCTION public.refresh_cloud_title_rollup(target_title_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  best_variant_id uuid;
  best_ttff integer;
  variant_total integer;
begin
  if target_title_id is null then return; end if;

  with candidates as materialized (
    select id,user_id,source_id,generation_id,playback_cost_score,
      last_observed_ttff_ms,created_at
    from public.cloud_title_variants
    where title_id = target_title_id
  ), source_visibility as materialized (
    select source_id,user_id,
      public.norva_source_catalog_visible(source_id,user_id) as visible
    from (select distinct source_id,user_id from candidates) sources
  )
  select variant.id,variant.last_observed_ttff_ms,count(*) over ()::integer
    into best_variant_id,best_ttff,variant_total
  from candidates variant
  join source_visibility visibility
    on visibility.source_id=variant.source_id
   and visibility.user_id=variant.user_id
   and visibility.visible
  left join public.cloud_source_catalog_heads head
    on head.source_id=variant.source_id and head.user_id=variant.user_id
  where variant.generation_id is null
     or head.active_generation_id=variant.generation_id
  order by variant.playback_cost_score asc,
    variant.last_observed_ttff_ms asc nulls last,variant.created_at desc
  limit 1;

  update public.cloud_titles title
  set default_variant_id=best_variant_id,
      variant_count=coalesce(variant_total,0),
      last_observed_ttff_ms=best_ttff,updated_at=now()
  where title.id=target_title_id
    and (
      coalesce(variant_total,0)>0 or title.default_variant_id is not null
      or coalesce(title.variant_count,0)<>0
      or title.last_observed_ttff_ms is not null
    )
    and (title.default_variant_id,coalesce(title.variant_count,0),
         title.last_observed_ttff_ms)
      is distinct from
        (best_variant_id,coalesce(variant_total,0),best_ttff);
end
$function$;
commit;
