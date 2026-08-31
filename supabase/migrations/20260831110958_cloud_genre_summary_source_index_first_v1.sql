begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

-- A source-scoped genre summary used to hydrate cloud_catalog_visible_titles
-- for every matching title.  That projection intentionally computes the full
-- runtime rollup (all visible variants, languages and best playback variant),
-- which is appropriate for a rendered title but not for an aggregate.  On a
-- real 11k-title source the aggregate exceeded the API role's 8 second budget.
--
-- Resolve the small visible-source set once, then use the generation head and
-- direct variant indexes in bulk.  display_owners reproduces the exact payload
-- owner selected by norva_visible_catalog_title_runtime, so the category counts
-- remain identical to the source-filtered title grid without invoking that
-- runtime function once per title.
create or replace function public.cloud_genre_bucket_counts(
  p_user_id uuid,
  p_item_type text,
  p_source_id uuid default null
) returns table(bucket text, n bigint)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if p_source_id is null then
    return query
      select genre_bucket, count(*)::bigint
      from public.cloud_catalog_visible_titles title
      cross join lateral unnest(
        coalesce(title.genre_buckets, array['autres'])
      ) genre_bucket
      where title.user_id = p_user_id
        and title.item_type = p_item_type
      group by genre_bucket;
    return;
  end if;

  if not public.norva_source_catalog_visible(p_source_id, p_user_id) then
    return;
  end if;

  return query
    with requested_source as materialized (
      select source.id, source.user_id
      from public.cloud_catalog_visible_sources source
      where source.id = p_source_id
        and source.user_id = p_user_id
    ), visible_sources as materialized (
      select source.id, source.user_id
      from public.cloud_catalog_visible_sources source
      join requested_source requested
        on requested.user_id = source.user_id
    ), source_titles as materialized (
      select distinct variant.title_id, variant.user_id
      from requested_source source
      join public.cloud_title_variants variant
        on variant.source_id = source.id
       and variant.user_id = source.user_id
      left join public.cloud_source_catalog_heads head
        on head.source_id = variant.source_id
       and head.user_id = variant.user_id
      where variant.item_type = p_item_type
        and (
          variant.generation_id is null
          or head.active_generation_id = variant.generation_id
        )
    ), display_owners as materialized (
      select distinct on (variant.title_id)
        variant.title_id,
        variant.user_id,
        variant.generation_id
      from source_titles selected
      join public.cloud_title_variants variant
        on variant.title_id = selected.title_id
       and variant.user_id = selected.user_id
      join visible_sources source
        on source.id = variant.source_id
       and source.user_id = variant.user_id
      left join public.cloud_source_catalog_heads head
        on head.source_id = variant.source_id
       and head.user_id = variant.user_id
      where variant.generation_id is null
         or head.active_generation_id = variant.generation_id
      order by
        variant.title_id,
        variant.source_id,
        variant.generation_id nulls first,
        variant.id
    ), selected_payloads as materialized (
      select
        selected.title_id,
        coalesce(
          projection.genre_buckets,
          title.genre_buckets,
          array['autres']
        ) as genre_buckets
      from source_titles selected
      join display_owners owner
        on owner.title_id = selected.title_id
       and owner.user_id = selected.user_id
      join public.cloud_titles title
        on title.id = selected.title_id
       and title.user_id = selected.user_id
      left join public.cloud_source_catalog_generation_candidate_titles projection
        on projection.title_id = selected.title_id
       and projection.user_id = selected.user_id
       and projection.generation_id = owner.generation_id
    )
    select genre_bucket, count(*)::bigint
    from selected_payloads payload
    cross join lateral unnest(payload.genre_buckets) genre_bucket
    group by genre_bucket;
end
$function$;

revoke all on function public.cloud_genre_bucket_counts(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.cloud_genre_bucket_counts(uuid, text, uuid)
  to service_role;

comment on function public.cloud_genre_bucket_counts(uuid, text, uuid) is
  'Exact lifecycle/generation-fenced genre counts; source scope uses a bulk index-first projection instead of per-title runtime hydration.';

do $assert$
declare
  v_security_definer boolean;
  v_config text[];
begin
  select routine.prosecdef, routine.proconfig
    into v_security_definer, v_config
  from pg_proc routine
  where routine.oid = 'public.cloud_genre_bucket_counts(uuid,text,uuid)'::regprocedure;

  if not coalesce(v_security_definer, false)
     or not ('search_path=""' = any(coalesce(v_config, '{}'::text[]))) then
    raise exception 'cloud_genre_bucket_counts security contract drift'
      using errcode = '55000';
  end if;

  if has_function_privilege(
       'anon',
       'public.cloud_genre_bucket_counts(uuid,text,uuid)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.cloud_genre_bucket_counts(uuid,text,uuid)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.cloud_genre_bucket_counts(uuid,text,uuid)',
       'EXECUTE'
     ) then
    raise exception 'cloud_genre_bucket_counts privilege contract drift'
      using errcode = '55000';
  end if;
end
$assert$;

commit;
