-- Keep the cached Providers console fast while adding a bounded set of live
-- provisional sources that the legacy dashboard snapshot intentionally omits. Verified
-- source links remain the only authority for canonical identity membership.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

create or replace function public.admin_sources_v2()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_cached jsonb;
  v_sources jsonb;
  v_provisional_count bigint;
  v_provisional_emitted bigint;
  v_provisional_sample_limit constant integer := 100;
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  v_cached := coalesce(public.admin_sources(), '[]'::jsonb);

  with cached_items as materialized (
    select
      item.value,
      item.ordinality,
      nullif(item.value ->> 'source_id', '')::uuid as source_id
    from jsonb_array_elements(v_cached) with ordinality as item(value, ordinality)
  ),
  candidate_sources as materialized (
    select
      source.id as source_id,
      source.user_id,
      account.email::text as owner_email,
      source.source_type,
      source.display_name::text as display_name,
      source.sync_status,
      source.sync_error,
      source.catalog_version,
      source.enabled,
      source.created_at,
      source.last_synced_at,
      candidate.evidence_count,
      candidate.required_evidence,
      candidate.last_attempt_at,
      exists (
        select 1
        from public.admin_enrichment_accounts driver
        where driver.user_id = source.user_id
      ) as is_driver
    from public.catalog_source_provider_identity_candidates candidate
    join public.cloud_sources source
      on source.id = candidate.source_id
     and source.user_id = candidate.user_id
    left join auth.users account on account.id = source.user_id
    left join public.catalog_source_provider_identities verified
      on verified.source_id = source.id
     and verified.user_id = source.user_id
    where source.deleted_at is null
      and verified.source_id is null
  ),
  candidate_media as materialized (
    select
      item.source_id,
      count(*)::bigint as media_items,
      count(*) filter (where item.item_type in ('movie', 'series'))::bigint as movie_series_items
    from public.cloud_media_items item
    join candidate_sources candidate on candidate.source_id = item.source_id
    group by item.source_id
  ),
  candidate_variants as materialized (
    select variant.source_id, count(*)::bigint as variants
    from public.cloud_title_variants variant
    join candidate_sources candidate on candidate.source_id = variant.source_id
    group by variant.source_id
  ),
  candidate_titles as materialized (
    select
      variant.source_id,
      count(*) filter (where title.item_type = 'movie')::bigint as movie_titles,
      count(*) filter (where title.item_type = 'series')::bigint as series_titles
    from public.cloud_titles title
    join public.cloud_title_variants variant on variant.id = title.default_variant_id
    join candidate_sources candidate on candidate.source_id = variant.source_id
    where title.variant_count > 0
      and title.item_type in ('movie', 'series')
    group by variant.source_id
  ),
  enriched_cached as materialized (
    select
      cached.value || jsonb_build_object(
        'source_id', source.id,
        'user_id', source.user_id,
        'owner_email', account.email::text,
        'source_type', source.source_type,
        'display_name', source.display_name::text,
        'sync_status', source.sync_status,
        'sync_error', source.sync_error,
        'catalog_version', source.catalog_version,
        'enabled', source.enabled,
        'created_at', source.created_at,
        'last_synced_at', source.last_synced_at,
        'identity_id', verified.identity_id,
        'identity_name', identity.display_name::text,
        'is_driver', exists (
          select 1
          from public.admin_enrichment_accounts driver
          where driver.user_id = source.user_id
        ),
        'resolution_state', case
          when verified.source_id is not null then 'verified'
          when candidate.source_id is not null then 'provisional'
          else 'unresolved'
        end,
        'evidence_count', case when verified.source_id is null then candidate.evidence_count end,
        'required_evidence', case when verified.source_id is null then candidate.required_evidence end,
        'resolution_last_attempt_at', case when verified.source_id is null then candidate.last_attempt_at end
      ) as row_data,
      0::integer as sort_bucket,
      cached.ordinality::bigint as sort_rank
    from cached_items cached
    join public.cloud_sources source
      on source.id = cached.source_id
     and source.deleted_at is null
    left join auth.users account on account.id = source.user_id
    left join public.catalog_source_provider_identities verified
      on verified.source_id = source.id
     and verified.user_id = source.user_id
    left join public.provider_identities identity on identity.id = verified.identity_id
    left join public.catalog_source_provider_identity_candidates candidate
      on candidate.source_id = source.id
     and candidate.user_id = source.user_id
  ),
  missing_provisional_ranked as materialized (
    select
      candidate.*,
      row_number() over (
        order by candidate.last_attempt_at desc, candidate.created_at desc, candidate.source_id
      ) as provisional_rank
    from candidate_sources candidate
    where not exists (
      select 1 from cached_items cached where cached.source_id = candidate.source_id
    )
  ),
  missing_provisional as materialized (
    select
      jsonb_build_object(
        'source_id', candidate.source_id,
        'user_id', candidate.user_id,
        'owner_email', candidate.owner_email,
        'source_type', candidate.source_type,
        'display_name', candidate.display_name,
        'sync_status', candidate.sync_status,
        'sync_error', candidate.sync_error,
        'catalog_version', candidate.catalog_version,
        'enabled', candidate.enabled,
        'created_at', candidate.created_at,
        'last_synced_at', candidate.last_synced_at,
        'media_items', coalesce(media.media_items, 0),
        'variants', coalesce(variants.variants, 0),
        'movie_titles', coalesce(titles.movie_titles, 0),
        'series_titles', coalesce(titles.series_titles, 0),
        'incomplete', coalesce(media.movie_series_items, 0) > 0
          and coalesce(variants.variants, 0) = 0,
        'identity_id', null,
        'identity_name', null,
        'is_driver', candidate.is_driver,
        'resolution_state', 'provisional',
        'evidence_count', candidate.evidence_count,
        'required_evidence', candidate.required_evidence,
        'resolution_last_attempt_at', candidate.last_attempt_at
      ) as row_data,
      1::integer as sort_bucket,
      candidate.provisional_rank::bigint as sort_rank
    from missing_provisional_ranked candidate
    left join candidate_media media on media.source_id = candidate.source_id
    left join candidate_variants variants on variants.source_id = candidate.source_id
    left join candidate_titles titles on titles.source_id = candidate.source_id
    where candidate.provisional_rank <= v_provisional_sample_limit
  ),
  combined as materialized (
    select row_data, sort_bucket, sort_rank from enriched_cached
    union all
    select row_data, sort_bucket, sort_rank from missing_provisional
  ),
  sources_payload as (
    select coalesce(
      jsonb_agg(row_data order by sort_bucket, sort_rank),
      '[]'::jsonb
    ) as value
    from combined
  ),
  totals as (
    select
      (select count(*) from candidate_sources) as provisional_count,
      count(*) filter (
        where row_data ->> 'resolution_state' = 'provisional'
      ) as provisional_emitted
    from combined
  )
  select payload.value, totals.provisional_count, totals.provisional_emitted
    into v_sources, v_provisional_count, v_provisional_emitted
  from sources_payload payload
  cross join totals;

  return jsonb_build_object(
    'schema_version', 2,
    'generated_at', statement_timestamp(),
    'sources', coalesce(v_sources, '[]'::jsonb),
    'provisional_source_count', coalesce(v_provisional_count, 0),
    'provisional_sources_emitted', coalesce(v_provisional_emitted, 0),
    'provisional_sources_truncated', coalesce(v_provisional_emitted, 0) < coalesce(v_provisional_count, 0),
    'provisional_sample_limit', v_provisional_sample_limit
  );
end
$function$;

revoke all on function public.admin_sources_v2()
  from public, anon, authenticated;
grant execute on function public.admin_sources_v2()
  to authenticated;

comment on function public.admin_sources_v2() is
  'Admin-only Providers payload enriched from verified source links and bounded provisional source evidence. Deleted sources and sensitive resolver keys are omitted.';

notify pgrst, 'reload schema';
commit;
