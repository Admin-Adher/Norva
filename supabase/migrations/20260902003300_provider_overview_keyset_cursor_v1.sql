-- Provider synopsis claims previously re-read and sorted every movie variant
-- before returning four rows. Large sources therefore crossed the API role's
-- statement timeout even though their provider transport was healthy.
--
-- Keep a generation-scoped keyset cursor on the existing per-source schedule,
-- walk the active catalog in exact external-id order, and advance the cursor
-- only after the Edge worker durably records a contiguous page. One terminal
-- empty page resets the sweep for the next scheduled pass.

begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

alter table public.catalog_enrichment_source_schedule
  add column if not exists provider_overview_cursor text,
  add column if not exists provider_overview_generation_id uuid;

alter table public.catalog_enrichment_source_schedule
  drop constraint if exists catalog_enrichment_source_schedule_overview_cursor_ck;
alter table public.catalog_enrichment_source_schedule
  add constraint catalog_enrichment_source_schedule_overview_cursor_ck check (
    provider_overview_cursor is null
    or (
      length(provider_overview_cursor) between 1 and 512
      and provider_overview_cursor !~ '[[:cntrl:]]'
    )
  );

comment on column public.catalog_enrichment_source_schedule.provider_overview_cursor
  is 'Durable exact external-id cursor for the bounded provider synopsis lane.';
comment on column public.catalog_enrichment_source_schedule.provider_overview_generation_id
  is 'Active catalog generation that owns provider_overview_cursor; mismatches restart the sweep.';

commit;

-- This covering keyset is intentionally movie-only. It lets the candidate
-- walk stay ordered and generation-scoped without fetching full JSON payloads
-- for rows that are only needed to advance the cursor.
create index concurrently if not exists
  cloud_title_variants_provider_overview_keyset_idx
on public.cloud_title_variants (
  source_id,
  generation_id,
  external_id
)
include (user_id, title_id, media_item_id)
where item_type = 'movie' and btrim(external_id) <> '';

-- Both anti-joins below ask only whether a trusted synopsis already exists.
-- Partial indexes make those checks index-only instead of repeatedly loading
-- multi-kilobyte metadata documents from the two largest title tables.
create index concurrently if not exists
  cloud_title_variants_default_overview_present_idx
on public.cloud_title_variants (user_id, title_id, id)
where nullif(btrim(coalesce(
  metadata ->> 'overview',
  metadata ->> 'plot',
  metadata ->> 'description',
  ''
)), '') is not null;

create index concurrently if not exists
  catalog_titles_valid_overview_idx
on public.catalog_titles (item_type, provider_tmdb_id)
where metadata #>> '{tmdbValidation,valid}' = 'true'
  and nullif(btrim(coalesce(
    metadata #>> '{i18n,fr,overview}',
    metadata #>> '{tmdb,overview}',
    metadata ->> 'overview',
    metadata #>> '{i18n,en,overview}',
    ''
  )), '') is not null;

create or replace function public.norva_claim_provider_overview_candidates_v2(
  p_user_id uuid,
  p_source_id uuid,
  p_limit integer,
  p_identity_scope text
) returns table(
  external_id text,
  media_item_id uuid,
  title_id uuid,
  raw_title text,
  cached_overview text,
  cached_status text,
  scan_cursor text,
  scan_generation_id uuid,
  scan_has_more boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_cache_key text;
  v_generation_id uuid;
  v_after_external_id text;
  v_limit integer := greatest(1, least(8, coalesce(p_limit, 4)));
begin
  if p_user_id is null or p_source_id is null
     or p_identity_scope not in ('verified', 'source') then
    raise exception 'invalid provider overview claim arguments'
      using errcode = '22023';
  end if;

  if p_identity_scope = 'verified' then
    select
      link.identity_id::text,
      head.active_generation_id,
      case
        when schedule.provider_overview_generation_id
          is not distinct from head.active_generation_id
          then schedule.provider_overview_cursor
        else null
      end
    into v_cache_key, v_generation_id, v_after_external_id
    from public.cloud_sources source
    join public.catalog_source_provider_identities link
      on link.source_id = source.id
     and link.user_id = source.user_id
    left join public.cloud_source_catalog_heads head
      on head.source_id = source.id
     and head.user_id = source.user_id
    left join public.catalog_enrichment_source_schedule schedule
      on schedule.source_id = source.id
     and schedule.user_id = source.user_id
    where source.id = p_source_id
      and source.user_id = p_user_id
      and source.source_type = 'xtream'
      and source.sync_status = 'ready'
      and source.enabled = true
      and source.deleted_at is null;
  else
    select
      'source:' || source.id::text,
      head.active_generation_id,
      case
        when schedule.provider_overview_generation_id
          is not distinct from head.active_generation_id
          then schedule.provider_overview_cursor
        else null
      end
    into v_cache_key, v_generation_id, v_after_external_id
    from public.cloud_sources source
    left join public.cloud_source_catalog_heads head
      on head.source_id = source.id
     and head.user_id = source.user_id
    left join public.catalog_enrichment_source_schedule schedule
      on schedule.source_id = source.id
     and schedule.user_id = source.user_id
    where source.id = p_source_id
      and source.user_id = p_user_id
      and source.source_type = 'xtream'
      and source.sync_status = 'ready'
      and source.enabled = true
      and source.deleted_at is null
      and not exists (
        select 1
        from public.catalog_source_provider_identities verified
        where verified.source_id = source.id
          and verified.user_id = source.user_id
      );
  end if;

  if not found then
    return;
  end if;

  -- The generation head is the snapshot boundary for this crawler. Refuse a
  -- legacy/null generation instead of introducing an OR that prevents the
  -- ordered keyset index from remaining the planner's obvious path. A source
  -- without a head is not safe to enrich against a moving catalogue anyway.
  if v_generation_id is null then
    return;
  end if;

  return query
  with candidate_window as materialized (
    select
      variant.external_id,
      variant.media_item_id,
      variant.title_id,
      variant.raw_title,
      cache.provider_overview as cached_overview,
      cache.overview_status as cached_status
    from public.cloud_title_variants variant
    join public.cloud_titles title
      on title.id = variant.title_id
     and title.user_id = p_user_id
     and title.item_type = 'movie'
     and title.variant_count > 0
    join public.cloud_media_items media
      on media.id = variant.media_item_id
     and media.source_id = p_source_id
     and media.user_id = p_user_id
     and media.item_type = 'movie'
     and media.available = true
    left join public.catalog_file_tracks cache
      on cache.server_host = v_cache_key
     and cache.item_type = 'movie'
     and cache.external_id = variant.external_id
    where variant.source_id = p_source_id
      and variant.user_id = p_user_id
      and variant.item_type = 'movie'
      and variant.generation_id = v_generation_id
      and btrim(variant.external_id) <> ''
      and (
        v_after_external_id is null
        or variant.external_id > v_after_external_id
      )
      and nullif(btrim(coalesce(
        title.metadata #>> '{i18n,fr,overview}',
        title.metadata #>> '{tmdb,overview}',
        title.metadata ->> 'overview',
        ''
      )), '') is null
      and not exists (
        select 1
        from public.cloud_title_variants summary_variant
        where summary_variant.user_id = title.user_id
          and summary_variant.title_id = title.id
          and summary_variant.id = title.default_variant_id
          and nullif(btrim(coalesce(
            summary_variant.metadata ->> 'overview',
            summary_variant.metadata ->> 'plot',
            summary_variant.metadata ->> 'description',
            ''
          )), '') is not null
      )
      and not exists (
        select 1
        from public.catalog_titles catalog
        where catalog.item_type = 'movie'
          and catalog.provider_tmdb_id = title.provider_tmdb_id
          and catalog.metadata #>> '{tmdbValidation,valid}' = 'true'
          and nullif(btrim(coalesce(
            catalog.metadata #>> '{i18n,fr,overview}',
            catalog.metadata #>> '{tmdb,overview}',
            catalog.metadata ->> 'overview',
            catalog.metadata #>> '{i18n,en,overview}',
            ''
          )), '') is not null
      )
      and (
        cache.external_id is null
        or (
          cache.overview_status = 'resolved'
          and nullif(btrim(cache.provider_overview), '') is not null
        )
        or (
          cache.overview_status in ('missing', 'retry')
          and coalesce(cache.overview_retry_at, '-infinity'::timestamptz)
            <= clock_timestamp()
        )
        or cache.overview_status is null
      )
    order by variant.external_id
    limit v_limit + 1
  ), selected as materialized (
    select candidate.*
    from candidate_window candidate
    order by candidate.external_id
    limit v_limit
  ), scan as (
    select
      (select max(candidate.external_id) from selected candidate) as cursor_value,
      (select count(*) from candidate_window) > v_limit as has_more
  )
  select
    selected.external_id,
    selected.media_item_id,
    selected.title_id,
    selected.raw_title,
    selected.cached_overview,
    selected.cached_status,
    scan.cursor_value,
    v_generation_id,
    scan.has_more
  from selected
  cross join scan
  union all
  select
    null::text,
    null::uuid,
    null::uuid,
    null::text,
    null::text,
    null::text,
    null::text,
    v_generation_id,
    false
  where not exists (select 1 from selected)
  order by 1 nulls last;
end
$function$;

revoke all on function public.norva_claim_provider_overview_candidates_v2(
  uuid,uuid,integer,text
) from public, anon, authenticated;
grant execute on function public.norva_claim_provider_overview_candidates_v2(
  uuid,uuid,integer,text
) to service_role;

-- Do not replace claim_provider_overview_candidates() or
-- claim_source_provider_overview_candidates() here. PostgreSQL treats a changed
-- RETURNS TABLE shape as a return-type change, and old Edge isolates still use
-- their original six-column contract during a rolling deploy. The new worker
-- calls this v2 RPC directly after the migration is present.

-- Preserve the twelve-lane scheduler contract while checkpointing only lane
-- 11's synopsis cursor. Other lanes can keep replacing last_result without
-- losing synopsis progress.
create or replace function public.finish_catalog_enrichment_source(
  p_source_id uuid,
  p_claim_token uuid,
  p_success boolean,
  p_next_delay_seconds integer,
  p_release_leases boolean default true,
  p_result jsonb default '{}'::jsonb
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  changed integer := 0;
  delay_seconds integer;
  current_lane integer;
  prior_cycle_had_work boolean;
  result_had_work boolean;
  v_overview_cursor text;
  v_overview_generation_id uuid;
  v_overview_sweep_complete boolean := false;
  v_overview_cursor_protocol boolean := false;
begin
  if p_source_id is null or p_claim_token is null then
    return false;
  end if;

  delay_seconds := greatest(
    30,
    least(
      86400,
      coalesce(
        p_next_delay_seconds,
        case when coalesce(p_success, false) then 300 else 600 end
      )
    )
  );

  select
    mod(schedule.dispatch_count, 12),
    schedule.cycle_had_work
  into current_lane, prior_cycle_had_work
  from public.catalog_enrichment_source_schedule schedule
  where schedule.source_id = p_source_id
    and schedule.claim_token = p_claim_token
  for update;
  if not found then
    return false;
  end if;

  result_had_work := coalesce((p_result->>'processed')::integer, 0) > 0
    or coalesce(p_result @> '{"hasMore":true}'::jsonb, false);

  if current_lane = 11 then
    v_overview_cursor := nullif(btrim(p_result->>'overviewCursor'), '');
    if v_overview_cursor is not null and (
      length(v_overview_cursor) > 512
      or v_overview_cursor ~ '[[:cntrl:]]'
    ) then
      v_overview_cursor := null;
    end if;
    if coalesce(p_result->>'overviewGenerationId', '')
       ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' then
      v_overview_generation_id := (p_result->>'overviewGenerationId')::uuid;
    end if;
    v_overview_sweep_complete :=
      coalesce(p_result->>'overviewSweepComplete', 'false') = 'true';
    v_overview_cursor_protocol :=
      coalesce(p_result->>'overviewCursorProtocol', '0') = '1';
  end if;

  if current_lane = 11 and prior_cycle_had_work then
    delay_seconds := least(delay_seconds, 30);
  end if;

  update public.catalog_enrichment_source_schedule schedule
  set next_run_at = clock_timestamp() + make_interval(secs => delay_seconds),
      lease_until = case
        when coalesce(p_release_leases, true) then null
        else schedule.lease_until
      end,
      claim_token = case
        when coalesce(p_release_leases, true) then null
        else schedule.claim_token
      end,
      last_finished_at = clock_timestamp(),
      consecutive_failures = case
        when coalesce(p_success, false) then 0
        else least(12, schedule.consecutive_failures + 1)
      end,
      dispatch_count = schedule.dispatch_count + 1,
      cycle_had_work = case
        when current_lane = 11 then false
        else prior_cycle_had_work or result_had_work
      end,
      provider_overview_cursor = case
        when current_lane <> 11 or not v_overview_cursor_protocol
          then schedule.provider_overview_cursor
        when v_overview_sweep_complete then null
        when v_overview_cursor is not null then v_overview_cursor
        else schedule.provider_overview_cursor
      end,
      provider_overview_generation_id = case
        when current_lane = 11 and v_overview_cursor_protocol
          then v_overview_generation_id
        else schedule.provider_overview_generation_id
      end,
      last_result = coalesce(p_result, '{}'::jsonb),
      updated_at = clock_timestamp()
  where schedule.source_id = p_source_id
    and schedule.claim_token = p_claim_token;
  get diagnostics changed = row_count;

  if coalesce(p_release_leases, true) then
    delete from public.catalog_enrichment_dispatch_leases lease
    where lease.claim_token = p_claim_token;
  end if;

  return changed = 1;
end
$function$;

revoke all on function public.finish_catalog_enrichment_source(
  uuid,uuid,boolean,integer,boolean,jsonb
) from public, anon, authenticated;
grant execute on function public.finish_catalog_enrichment_source(
  uuid,uuid,boolean,integer,boolean,jsonb
) to service_role;

comment on function public.norva_claim_provider_overview_candidates_v2(
  uuid,uuid,integer,text
) is 'Generation-scoped, keyset-bounded provider synopsis candidate reader with an explicit sweep-control row.';
