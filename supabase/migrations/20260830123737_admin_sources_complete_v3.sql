-- Complete Providers inventory.
--
-- admin_sources_v2 starts from the intentionally selective dashboard cache
-- (enrichment drivers + operational incidents) and appends only provisional
-- candidates. A healthy non-driver source therefore disappears as soon as it
-- becomes verified. V3 instead starts from every live Xtream source, attaches
-- the authoritative verified/candidate state and calculates the displayed
-- statistics in one indexed pass. Deleted sources and resolver keys stay out.

begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

create or replace function public.admin_sources_v3()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_sources jsonb;
  v_summary jsonb;
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  with live_sources as materialized (
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
      verified.identity_id,
      identity.display_name::text as identity_name,
      candidate.evidence_count,
      candidate.required_evidence,
      candidate.last_attempt_at as resolution_last_attempt_at,
      exists (
        select 1
        from public.admin_enrichment_accounts driver
        where driver.user_id = source.user_id
      ) as is_driver
    from public.cloud_sources source
    left join auth.users account on account.id = source.user_id
    left join public.catalog_source_provider_identities verified
      on verified.source_id = source.id
     and verified.user_id = source.user_id
    left join public.provider_identities identity
      on identity.id = verified.identity_id
    left join public.catalog_source_provider_identity_candidates candidate
      on candidate.source_id = source.id
     and candidate.user_id = source.user_id
    where source.deleted_at is null
      and source.source_type = 'xtream'
  ),
  media_counts as materialized (
    select
      item.source_id,
      count(*)::bigint as media_items,
      count(*) filter (
        where item.item_type in ('movie', 'series')
      )::bigint as movie_series_items
    from public.cloud_media_items item
    join live_sources source
      on source.source_id = item.source_id
     and source.user_id = item.user_id
    group by item.source_id
  ),
  variant_counts as materialized (
    select
      variant.source_id,
      count(*)::bigint as variants
    from public.cloud_title_variants variant
    join live_sources source
      on source.source_id = variant.source_id
     and source.user_id = variant.user_id
    group by variant.source_id
  ),
  title_counts as materialized (
    select
      variant.source_id,
      count(*) filter (where title.item_type = 'movie')::bigint as movie_titles,
      count(*) filter (where title.item_type = 'series')::bigint as series_titles
    from public.cloud_titles title
    join public.cloud_title_variants variant
      on variant.id = title.default_variant_id
     and variant.user_id = title.user_id
    join live_sources source
      on source.source_id = variant.source_id
     and source.user_id = variant.user_id
    where title.variant_count > 0
      and title.item_type in ('movie', 'series')
    group by variant.source_id
  ),
  source_rows as materialized (
    select
      source.*,
      coalesce(media.media_items, 0) as media_items,
      coalesce(variants.variants, 0) as variants,
      coalesce(titles.movie_titles, 0) as movie_titles,
      coalesce(titles.series_titles, 0) as series_titles,
      coalesce(media.movie_series_items, 0) > 0
        and coalesce(variants.variants, 0) = 0 as incomplete,
      case
        when source.identity_id is not null then 'verified'
        when source.evidence_count is not null then 'provisional'
        else 'unresolved'
      end as resolution_state
    from live_sources source
    left join media_counts media on media.source_id = source.source_id
    left join variant_counts variants on variants.source_id = source.source_id
    left join title_counts titles on titles.source_id = source.source_id
  ),
  payload as materialized (
    select
      row.source_id,
      jsonb_build_object(
        'source_id', row.source_id,
        'user_id', row.user_id,
        'owner_email', row.owner_email,
        'source_type', row.source_type,
        'display_name', row.display_name,
        'sync_status', row.sync_status,
        'sync_error', row.sync_error,
        'catalog_version', row.catalog_version,
        'enabled', row.enabled,
        'created_at', row.created_at,
        'last_synced_at', row.last_synced_at,
        'media_items', row.media_items,
        'variants', row.variants,
        'movie_titles', row.movie_titles,
        'series_titles', row.series_titles,
        'incomplete', row.incomplete,
        'identity_id', row.identity_id,
        'identity_name', row.identity_name,
        'is_driver', row.is_driver,
        'resolution_state', row.resolution_state,
        'evidence_count', case
          when row.resolution_state = 'provisional' then row.evidence_count
        end,
        'required_evidence', case
          when row.resolution_state = 'provisional' then row.required_evidence
        end,
        'resolution_last_attempt_at', case
          when row.resolution_state = 'provisional' then row.resolution_last_attempt_at
        end
      ) as row_data,
      case
        when row.sync_error is not null or row.sync_status in ('error', 'sync_error') then 0
        when row.incomplete then 1
        when row.resolution_state = 'provisional' then 2
        when row.resolution_state = 'unresolved' then 3
        else 4
      end as priority
    from source_rows row
  )
  select
    coalesce(
      jsonb_agg(
        payload.row_data
        order by payload.priority, source.created_at desc, payload.source_id
      ),
      '[]'::jsonb
    ),
    jsonb_build_object(
      'source_count', count(*),
      'verified_source_count', count(*) filter (
        where source.resolution_state = 'verified'
      ),
      'provisional_source_count', count(*) filter (
        where source.resolution_state = 'provisional'
      ),
      'unresolved_source_count', count(*) filter (
        where source.resolution_state = 'unresolved'
      ),
      'enabled_source_count', count(*) filter (where source.enabled),
      'disabled_source_count', count(*) filter (where not source.enabled),
      'error_source_count', count(*) filter (
        where source.sync_error is not null
           or source.sync_status in ('error', 'sync_error')
      ),
      'incomplete_source_count', count(*) filter (where source.incomplete)
    )
    into v_sources, v_summary
  from payload
  join source_rows source on source.source_id = payload.source_id;

  return jsonb_build_object(
    'schema_version', 3,
    'generated_at', statement_timestamp(),
    'inventory_scope', 'all_live_xtream_sources',
    'statistics_source', 'live_indexed_aggregates',
    'summary', coalesce(v_summary, '{}'::jsonb),
    'sources', coalesce(v_sources, '[]'::jsonb)
  );
end
$function$;

revoke all on function public.admin_sources_v3()
  from public, anon, authenticated;
grant execute on function public.admin_sources_v3()
  to authenticated;

comment on function public.admin_sources_v3() is
  'Admin-only exhaustive inventory of every non-deleted Xtream source with authoritative verified/provisional identity state and indexed live statistics. Resolver keys and deleted sources are omitted.';

notify pgrst, 'reload schema';
commit;
