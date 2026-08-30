-- The legacy Identites RPC inferred source membership from display_name. That
-- can attach one source to several identities, retain soft-deleted sources and
-- hide a valid source until its display name happens to match an alias. Use the
-- server-written source -> identity proof as the only membership authority and
-- expose unresolved/recent sources separately so operators can see ingestion
-- without manufacturing a provider identity.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

create or replace function public.admin_identities_v2()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_recent_window_days constant integer := 30;
  v_recent_since constant timestamptz := statement_timestamp() - interval '30 days';
  v_result jsonb;
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
      source.enabled,
      source.created_at,
      source.updated_at,
      source.last_synced_at,
      source.sync_error is not null as has_sync_error,
      exists (
        select 1
        from public.admin_enrichment_accounts driver
        where driver.user_id = source.user_id
      ) as is_driver
    from public.cloud_sources source
    left join auth.users account on account.id = source.user_id
    where source.deleted_at is null
  ),
  linked_sources as materialized (
    select
      link.identity_id,
      link.verified_at,
      source.*,
      row_number() over (
        partition by link.identity_id
        order by source.created_at desc, source.source_id
      ) as identity_rank
    from live_sources source
    join public.catalog_source_provider_identities link
      on link.source_id = source.source_id
     and link.user_id = source.user_id
  ),
  identity_source_rollup as (
    select
      linked.identity_id,
      count(*) as source_count,
      count(*) filter (where linked.enabled) as enabled_source_count,
      count(*) filter (where not linked.enabled) as disabled_source_count,
      count(*) filter (where linked.is_driver) as driver_source_count,
      count(*) filter (where linked.created_at >= v_recent_since) as recent_source_count,
      count(distinct linked.user_id) as account_count,
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'source_id', linked.source_id,
            'display_name', linked.display_name,
            'user_id', linked.user_id,
            'owner_email', linked.owner_email,
            'source_type', linked.source_type,
            'sync_status', linked.sync_status,
            'enabled', linked.enabled,
            'created_at', linked.created_at,
            'updated_at', linked.updated_at,
            'last_synced_at', linked.last_synced_at,
            'has_sync_error', linked.has_sync_error,
            'is_driver', linked.is_driver,
            'verified_at', linked.verified_at
          )
          order by linked.created_at desc, linked.source_id
        ) filter (where linked.identity_rank <= 50),
        '[]'::jsonb
      ) as sources
    from linked_sources linked
    group by linked.identity_id
  ),
  identity_key_counts as (
    select alias.identity_id, count(*) as key_count
    from public.catalog_provider_identities alias
    where alias.identity_id is not null
    group by alias.identity_id
  ),
  distinct_identity_brands as (
    select distinct alias.identity_id, alias.display_name::text as display_name
    from public.catalog_provider_identities alias
    where alias.identity_id is not null
  ),
  identity_brand_rollup as (
    select
      brand.identity_id,
      jsonb_agg(brand.display_name order by brand.display_name) as brands
    from distinct_identity_brands brand
    group by brand.identity_id
  ),
  identity_rows as materialized (
    select
      identity.id,
      identity.display_name::text as display_name,
      identity.status,
      identity.first_seen,
      identity.last_seen,
      identity.notes,
      coalesce(keys.key_count, 0) as key_count,
      coalesce(brands.brands, '[]'::jsonb) as brands,
      coalesce(sources.source_count, 0) as source_count,
      coalesce(sources.enabled_source_count, 0) as enabled_source_count,
      coalesce(sources.disabled_source_count, 0) as disabled_source_count,
      coalesce(sources.driver_source_count, 0) as driver_source_count,
      coalesce(sources.recent_source_count, 0) as recent_source_count,
      coalesce(sources.account_count, 0) as account_count,
      coalesce(sources.sources, '[]'::jsonb) as sources,
      coalesce(sources.source_count, 0) > 50 as sources_truncated
    from public.provider_identities identity
    left join identity_key_counts keys on keys.identity_id = identity.id
    left join identity_brand_rollup brands on brands.identity_id = identity.id
    left join identity_source_rollup sources on sources.identity_id = identity.id
  ),
  identities_payload as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', identity.id,
          'display_name', identity.display_name,
          'status', identity.status,
          'first_seen', identity.first_seen,
          'last_seen', identity.last_seen,
          'notes', identity.notes,
          'key_count', identity.key_count,
          'brands', identity.brands,
          'source_count', identity.source_count,
          'enabled_source_count', identity.enabled_source_count,
          'disabled_source_count', identity.disabled_source_count,
          'driver_source_count', identity.driver_source_count,
          'recent_source_count', identity.recent_source_count,
          'account_count', identity.account_count,
          'sources', identity.sources,
          'sources_truncated', identity.sources_truncated
        )
        order by identity.display_name, identity.id
      ),
      '[]'::jsonb
    ) as value
    from identity_rows identity
  ),
  unresolved_ranked as materialized (
    select
      source.*,
      row_number() over (order by source.created_at desc, source.source_id) as unresolved_rank
    from live_sources source
    left join public.catalog_source_provider_identities link
      on link.source_id = source.source_id
     and link.user_id = source.user_id
    where link.source_id is null
  ),
  unresolved_payload as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'source_id', source.source_id,
          'display_name', source.display_name,
          'user_id', source.user_id,
          'owner_email', source.owner_email,
          'source_type', source.source_type,
          'sync_status', source.sync_status,
          'enabled', source.enabled,
          'created_at', source.created_at,
          'updated_at', source.updated_at,
          'last_synced_at', source.last_synced_at,
          'has_sync_error', source.has_sync_error,
          'is_driver', source.is_driver,
          'resolution_state', 'unresolved'
        )
        order by source.created_at desc, source.source_id
      ) filter (where source.unresolved_rank <= 100),
      '[]'::jsonb
    ) as value
    from unresolved_ranked source
  ),
  recent_ranked as materialized (
    select
      source.*,
      link.identity_id,
      identity.display_name::text as identity_name,
      link.verified_at,
      row_number() over (order by source.created_at desc, source.source_id) as recent_rank
    from live_sources source
    left join public.catalog_source_provider_identities link
      on link.source_id = source.source_id
     and link.user_id = source.user_id
    left join public.provider_identities identity on identity.id = link.identity_id
    where source.created_at >= v_recent_since
  ),
  recent_payload as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'source_id', source.source_id,
          'display_name', source.display_name,
          'user_id', source.user_id,
          'owner_email', source.owner_email,
          'source_type', source.source_type,
          'sync_status', source.sync_status,
          'enabled', source.enabled,
          'created_at', source.created_at,
          'updated_at', source.updated_at,
          'last_synced_at', source.last_synced_at,
          'has_sync_error', source.has_sync_error,
          'is_driver', source.is_driver,
          'identity_id', source.identity_id,
          'identity_name', source.identity_name,
          'verified_at', source.verified_at,
          'resolution_state', case when source.identity_id is null then 'unresolved' else 'verified' end
        )
        order by source.created_at desc, source.source_id
      ) filter (where source.recent_rank <= 100),
      '[]'::jsonb
    ) as value
    from recent_ranked source
  ),
  summary_payload as (
    select jsonb_build_object(
      'identity_count', (select count(*) from identity_rows),
      'active_identity_count', (
        select count(*) from identity_rows identity where identity.status = 'active'
      ),
      'mirror_identity_count', (
        select count(*)
        from identity_rows identity
        where jsonb_array_length(identity.brands) > 1
      ),
      'dormant_identity_count', (
        select count(*)
        from identity_rows identity
        where identity.last_seen is null
           or identity.last_seen < statement_timestamp() - interval '30 days'
      ),
      'brand_count', (select count(*) from distinct_identity_brands),
      'source_count', (select count(*) from live_sources),
      'linked_source_count', (select count(*) from linked_sources),
      'unresolved_source_count', (select count(*) from unresolved_ranked),
      'enabled_source_count', (select count(*) from live_sources source where source.enabled),
      'disabled_source_count', (select count(*) from live_sources source where not source.enabled),
      'recent_source_count', (
        select count(*) from live_sources source where source.created_at >= v_recent_since
      ),
      'intake_source_count', (
        select count(*)
        from (
          select source.source_id from unresolved_ranked source
          union
          select source.source_id from recent_ranked source
        ) intake
      ),
      'deleted_source_count_excluded', (
        select count(*) from public.cloud_sources source where source.deleted_at is not null
      )
    ) as value
  )
  select jsonb_build_object(
    'schema_version', 2,
    'generated_at', statement_timestamp(),
    'recent_window_days', v_recent_window_days,
    'source_sample_limit', 50,
    'intake_sample_limit', 100,
    'summary', summary.value,
    'identities', identities.value,
    'unresolved_sources', unresolved.value,
    'recent_sources', recent.value
  )
  into v_result
  from identities_payload identities
  cross join unresolved_payload unresolved
  cross join recent_payload recent
  cross join summary_payload summary;

  return v_result;
end;
$function$;

revoke all on function public.admin_identities_v2()
from public, anon, authenticated;
grant execute on function public.admin_identities_v2()
to authenticated;

comment on function public.admin_identities_v2() is
  'Admin-only provider identity graph using verified source links; deleted sources are excluded and unresolved/recent sources remain visible.';

notify pgrst, 'reload schema';

commit;
