-- Compute the best active version and its count from one visibility-filtered scan.
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

  select variant.id, variant.last_observed_ttff_ms, count(*) over ()::integer
    into best_variant_id, best_ttff, variant_total
  from public.cloud_title_variants variant
  left join public.cloud_source_catalog_heads head
    on head.source_id = variant.source_id
   and head.user_id = variant.user_id
  where variant.title_id = target_title_id
    and public.norva_source_catalog_visible(variant.source_id, variant.user_id)
    and (
      variant.generation_id is null
      or head.active_generation_id = variant.generation_id
    )
  order by
    variant.playback_cost_score asc,
    variant.last_observed_ttff_ms asc nulls last,
    variant.created_at desc
  limit 1;

  update public.cloud_titles title
  set default_variant_id = best_variant_id,
      variant_count = coalesce(variant_total, 0),
      last_observed_ttff_ms = best_ttff,
      updated_at = now()
  where title.id = target_title_id
    -- Candidate-only titles start with an empty physical rollup.  Do not issue
    -- even a no-op UPDATE until a variant is active, because statement mirrors
    -- observe UPDATEs, not changed columns.
    and (
      coalesce(variant_total, 0) > 0
      or title.default_variant_id is not null
      or coalesce(title.variant_count, 0) <> 0
      or title.last_observed_ttff_ms is not null
    )
    and (title.default_variant_id, coalesce(title.variant_count, 0),
         title.last_observed_ttff_ms)
        is distinct from
        (best_variant_id, coalesce(variant_total, 0), best_ttff);
end
$function$;


commit;
