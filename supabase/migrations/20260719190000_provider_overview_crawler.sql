-- Resumable Xtream get_vod_info synopsis crawler.
--
-- Bulk get_vod_streams is intentionally the fast catalogue import API, but
-- many panels omit plot/description there and expose it only in get_vod_info.
-- A full resync therefore cannot recover those synopses on its own. This
-- migration extends the canonical exact-file cache and adds service-only RPCs
-- used by the sixth lane of the dynamic enrichment fleet.
--
-- Cross-tenant reuse is keyed exclusively by the server-verified
-- catalog_source_provider_identities.identity_id + exact provider external_id.
-- cloud_sources.config_hint is owner-editable and is never consulted.

alter table public.catalog_file_tracks
  add column if not exists provider_overview text,
  add column if not exists overview_status text,
  add column if not exists overview_attempted_at timestamptz,
  add column if not exists overview_retry_at timestamptz,
  add column if not exists overview_provenance jsonb not null default '{}'::jsonb;

alter table public.catalog_file_tracks
  drop constraint if exists catalog_file_tracks_overview_status_check;
alter table public.catalog_file_tracks
  add constraint catalog_file_tracks_overview_status_check
  check (
    overview_status is null
    or overview_status in ('resolved', 'missing', 'retry')
  );

create index if not exists catalog_file_tracks_overview_due_idx
  on public.catalog_file_tracks
    (server_host, item_type, overview_retry_at, external_id)
  where overview_status is distinct from 'resolved';

-- Return at most one exact provider file per still-missing logical title.
-- A resolved canonical-cache row is returned immediately for free fan-out;
-- missing/transient rows remain ineligible until their explicit retry time.
create or replace function public.claim_provider_overview_candidates(
  p_user_id uuid,
  p_source_id uuid,
  p_limit integer default 4
) returns table(
  external_id text,
  media_item_id uuid,
  title_id uuid,
  raw_title text,
  cached_overview text,
  cached_status text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  with verified_source as materialized (
    select
      source.id as source_id,
      source.user_id,
      link.identity_id
    from public.cloud_sources source
    join public.catalog_source_provider_identities link
      on link.source_id = source.id
     and link.user_id = source.user_id
    where source.id = p_source_id
      and source.user_id = p_user_id
      and source.source_type = 'xtream'
      and source.sync_status = 'ready'
      and source.enabled = true
      and source.deleted_at is null
  ),
  eligible as materialized (
    select
      variant.external_id,
      variant.media_item_id,
      variant.title_id,
      variant.raw_title,
      media.added_at,
      cache.provider_overview as cached_overview,
      cache.overview_status as cached_status,
      row_number() over (
        partition by variant.title_id
        order by
          (cache.overview_status = 'resolved') desc,
          coalesce(media.added_at, 0) desc,
          variant.external_id
      ) as title_rank
    from verified_source verified
    join public.cloud_title_variants variant
      on variant.source_id = verified.source_id
     and variant.user_id = verified.user_id
     and variant.item_type = 'movie'
    join public.cloud_titles title
      on title.id = variant.title_id
     and title.user_id = verified.user_id
     and title.item_type = 'movie'
     and title.variant_count > 0
    join public.cloud_media_items media
      on media.id = variant.media_item_id
     and media.source_id = verified.source_id
     and media.user_id = verified.user_id
     and media.item_type = 'movie'
     and media.available = true
    left join public.catalog_file_tracks cache
      on cache.server_host = verified.identity_id::text
     and cache.item_type = 'movie'
     and cache.external_id = variant.external_id
    where coalesce(btrim(variant.external_id), '') <> ''
      -- Match the read path: a local French/base synopsis already present does
      -- not spend a provider request.
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
      -- Likewise, the trusted global TMDB overlay already fixes the card/detail
      -- for this provider id at read time.
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
  )
  select
    eligible.external_id,
    eligible.media_item_id,
    eligible.title_id,
    eligible.raw_title,
    eligible.cached_overview,
    eligible.cached_status
  from eligible
  where eligible.title_rank = 1
  order by
    (eligible.cached_status = 'resolved') desc,
    coalesce(eligible.added_at, 0) desc,
    eligible.title_id
  limit greatest(1, least(8, coalesce(p_limit, 4)))
$function$;

revoke all on function public.claim_provider_overview_candidates(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_provider_overview_candidates(uuid, uuid, integer)
  to service_role;

-- Cache one get_vod_info outcome and fan it out to every account/source mapped
-- to the same canonical provider identity and exact external id. Existing
-- synopsis text always wins; the crawler only gap-fills.
create or replace function public.record_provider_overview_outcome(
  p_user_id uuid,
  p_source_id uuid,
  p_external_id text,
  p_provider_overview text,
  p_provider_tmdb_id text,
  p_provider_imdb_id text,
  p_outcome text,
  p_retry_at timestamptz default null,
  p_provenance jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  canonical_identity uuid;
  normalized_overview text;
  normalized_tmdb_id text;
  normalized_imdb_id text;
  normalized_outcome text;
  media_items_updated integer := 0;
  variants_updated integer := 0;
  titles_updated integer := 0;
  catalog_titles_updated integer := 0;
  cloud_titles_updated integer := 0;
begin
  if p_user_id is null
     or p_source_id is null
     or coalesce(btrim(p_external_id), '') = '' then
    raise exception 'invalid provider overview identity';
  end if;

  select link.identity_id
    into canonical_identity
  from public.catalog_source_provider_identities link
  join public.cloud_sources source
    on source.id = link.source_id
   and source.user_id = link.user_id
  where link.source_id = p_source_id
    and link.user_id = p_user_id
    and source.source_type = 'xtream'
    and source.deleted_at is null
  limit 1;

  if canonical_identity is null then
    raise exception 'source has no server-verified provider identity';
  end if;

  normalized_overview := nullif(btrim(left(coalesce(p_provider_overview, ''), 4000)), '');
  if normalized_overview ~* '^(?:n/?a|none|null|undefined|no (?:description|overview|plot)(?: available)?|no summary available yet\.?)$' then
    normalized_overview := null;
  end if;

  normalized_tmdb_id := nullif(regexp_replace(coalesce(p_provider_tmdb_id, ''), '[^0-9]', '', 'g'), '');
  if normalized_tmdb_id ~ '^0+$' then normalized_tmdb_id := null; end if;
  normalized_imdb_id := lower(nullif(btrim(coalesce(p_provider_imdb_id, '')), ''));
  if normalized_imdb_id !~ '^tt[0-9]+$' then normalized_imdb_id := null; end if;

  normalized_outcome := case
    when p_outcome = 'resolved' and normalized_overview is not null then 'resolved'
    when p_outcome = 'retry' then 'retry'
    else 'missing'
  end;

  insert into public.catalog_file_tracks as cache (
    server_host,
    item_type,
    external_id,
    provider_tmdb_id,
    provider_imdb_id,
    ids_resolved_at,
    provider_overview,
    overview_status,
    overview_attempted_at,
    overview_retry_at,
    overview_provenance,
    updated_at
  ) values (
    canonical_identity::text,
    'movie',
    btrim(p_external_id),
    normalized_tmdb_id,
    normalized_imdb_id,
    clock_timestamp(),
    normalized_overview,
    normalized_outcome,
    clock_timestamp(),
    case when normalized_outcome = 'resolved' then null else p_retry_at end,
    coalesce(p_provenance, '{}'::jsonb),
    clock_timestamp()
  )
  on conflict (server_host, item_type, external_id) do update
    set provider_tmdb_id = coalesce(excluded.provider_tmdb_id, cache.provider_tmdb_id),
        provider_imdb_id = coalesce(excluded.provider_imdb_id, cache.provider_imdb_id),
        ids_resolved_at = clock_timestamp(),
        provider_overview = case
          when excluded.overview_status = 'resolved'
            then excluded.provider_overview
          else cache.provider_overview
        end,
        overview_status = case
          when cache.overview_status = 'resolved'
               and excluded.overview_status <> 'resolved'
            then cache.overview_status
          else excluded.overview_status
        end,
        overview_attempted_at = clock_timestamp(),
        overview_retry_at = case
          when cache.overview_status = 'resolved'
               or excluded.overview_status = 'resolved'
            then null
          else excluded.overview_retry_at
        end,
        overview_provenance = case
          when cache.overview_status = 'resolved'
               and excluded.overview_status <> 'resolved'
            then cache.overview_provenance
          else excluded.overview_provenance
        end,
        updated_at = clock_timestamp();

  if normalized_outcome <> 'resolved' then
    return jsonb_build_object(
      'cached', true,
      'outcome', normalized_outcome,
      'media_items_updated', 0,
      'variants_updated', 0,
      'titles_updated', 0
    );
  end if;

  with owners as materialized (
    select link.source_id, link.user_id
    from public.catalog_source_provider_identities link
    where link.identity_id = canonical_identity
  )
  update public.cloud_media_items media
     set metadata =
       coalesce(media.metadata, '{}'::jsonb)
       || jsonb_build_object('overview', normalized_overview)
       || case
            when normalized_tmdb_id is not null
                 and coalesce(media.metadata ->> 'providerTmdbId', '') = ''
              then jsonb_build_object('providerTmdbId', normalized_tmdb_id)
            else '{}'::jsonb
          end
       || case
            when normalized_imdb_id is not null
                 and coalesce(media.metadata ->> 'providerImdbId', '') = ''
              then jsonb_build_object('providerImdbId', normalized_imdb_id)
            else '{}'::jsonb
          end,
         updated_at = clock_timestamp()
  from owners
  where media.source_id = owners.source_id
    and media.user_id = owners.user_id
    and media.item_type = 'movie'
    and media.external_id = btrim(p_external_id)
    and media.available = true
    and nullif(btrim(coalesce(
      media.metadata ->> 'overview',
      media.metadata ->> 'plot',
      media.metadata ->> 'description',
      ''
    )), '') is null;
  get diagnostics media_items_updated = row_count;

  with affected_titles as materialized (
    select distinct variant.user_id, variant.title_id
    from public.catalog_source_provider_identities link
    join public.cloud_title_variants variant
      on variant.source_id = link.source_id
     and variant.user_id = link.user_id
     and variant.item_type = 'movie'
     and variant.external_id = btrim(p_external_id)
    where link.identity_id = canonical_identity
      and variant.title_id is not null
  )
  update public.cloud_title_variants variant
     set metadata =
       coalesce(variant.metadata, '{}'::jsonb)
       || jsonb_build_object('overview', normalized_overview)
       || case
            when normalized_tmdb_id is not null
                 and coalesce(variant.metadata ->> 'providerTmdbId', '') = ''
              then jsonb_build_object('providerTmdbId', normalized_tmdb_id)
            else '{}'::jsonb
          end
       || case
            when normalized_imdb_id is not null
                 and coalesce(variant.metadata ->> 'providerImdbId', '') = ''
              then jsonb_build_object('providerImdbId', normalized_imdb_id)
            else '{}'::jsonb
          end,
         updated_at = clock_timestamp()
  from affected_titles affected
  where variant.title_id = affected.title_id
    and variant.user_id = affected.user_id
    and variant.item_type = 'movie'
    and nullif(btrim(coalesce(
      variant.metadata ->> 'overview',
      variant.metadata ->> 'plot',
      variant.metadata ->> 'description',
      ''
    )), '') is null;
  get diagnostics variants_updated = row_count;

  with affected_titles as materialized (
    select distinct variant.user_id, variant.title_id
    from public.catalog_source_provider_identities link
    join public.cloud_title_variants variant
      on variant.source_id = link.source_id
     and variant.user_id = link.user_id
     and variant.item_type = 'movie'
     and variant.external_id = btrim(p_external_id)
    where link.identity_id = canonical_identity
      and variant.title_id is not null
  )
  select count(*)::integer
    into titles_updated
  from affected_titles affected
  join public.cloud_titles title
    on title.id = affected.title_id
   and title.user_id = affected.user_id
  where nullif(btrim(coalesce(
    title.metadata #>> '{i18n,fr,overview}',
    title.metadata #>> '{tmdb,overview}',
    title.metadata ->> 'overview',
    ''
  )), '') is null;

  -- Real provider ids are mirrored through catalog_titles. Updating their
  -- per-user cloud_titles.metadata would fire cloud_titles_mirror_to_catalog,
  -- replace the rich global TMDB blob, then thin the local row back to {}.
  -- Merge the provider fallback directly into the global row instead.
  with affected_catalog_titles as materialized (
    select distinct title.item_type, title.provider_tmdb_id
    from public.catalog_source_provider_identities link
    join public.cloud_title_variants variant
      on variant.source_id = link.source_id
     and variant.user_id = link.user_id
     and variant.item_type = 'movie'
     and variant.external_id = btrim(p_external_id)
    join public.cloud_titles title
      on title.id = variant.title_id
     and title.user_id = variant.user_id
    where link.identity_id = canonical_identity
      and title.provider_tmdb_id is not null
      and title.provider_tmdb_id <> ''
      and title.provider_tmdb_id !~ '^(tt)?0+$'
  )
  update public.catalog_titles catalog
     set metadata =
       coalesce(catalog.metadata, '{}'::jsonb)
       || jsonb_build_object('overview', normalized_overview),
         updated_at = clock_timestamp()
  from affected_catalog_titles affected
  where catalog.item_type = affected.item_type
    and catalog.provider_tmdb_id = affected.provider_tmdb_id
    and nullif(btrim(coalesce(
      catalog.metadata #>> '{i18n,fr,overview}',
      catalog.metadata #>> '{tmdb,overview}',
      catalog.metadata ->> 'overview',
      catalog.metadata #>> '{i18n,en,overview}',
      ''
    )), '') is null;
  get diagnostics catalog_titles_updated = row_count;

  -- Unmatched titles have no global TMDB row and are safe to fill locally.
  with affected_titles as materialized (
    select distinct variant.user_id, variant.title_id
    from public.catalog_source_provider_identities link
    join public.cloud_title_variants variant
      on variant.source_id = link.source_id
     and variant.user_id = link.user_id
     and variant.item_type = 'movie'
     and variant.external_id = btrim(p_external_id)
    where link.identity_id = canonical_identity
      and variant.title_id is not null
  )
  update public.cloud_titles title
     set metadata =
       coalesce(title.metadata, '{}'::jsonb)
       || jsonb_build_object('overview', normalized_overview),
         updated_at = clock_timestamp()
  from affected_titles affected
  where title.id = affected.title_id
    and title.user_id = affected.user_id
    and title.item_type = 'movie'
    and (
      title.provider_tmdb_id is null
      or title.provider_tmdb_id = ''
      or title.provider_tmdb_id ~ '^(tt)?0+$'
    )
    and nullif(btrim(coalesce(
      title.metadata #>> '{i18n,fr,overview}',
      title.metadata #>> '{tmdb,overview}',
      title.metadata ->> 'overview',
      ''
    )), '') is null;
  get diagnostics cloud_titles_updated = row_count;

  return jsonb_build_object(
    'cached', true,
    'outcome', normalized_outcome,
    'media_items_updated', media_items_updated,
    'variants_updated', variants_updated,
    'titles_updated', titles_updated,
    'catalog_titles_updated', catalog_titles_updated,
    'cloud_titles_updated', cloud_titles_updated
  );
end
$function$;

revoke all on function public.record_provider_overview_outcome(
  uuid, uuid, text, text, text, text, text, timestamptz, jsonb
) from public, anon, authenticated;
grant execute on function public.record_provider_overview_outcome(
  uuid, uuid, text, text, text, text, text, timestamptz, jsonb
) to service_role;

create or replace function public.catalog_enrichment_fleet_preflight()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select jsonb_build_object(
    'schemaVersion', 3,
    'scheduledSources', (
      select count(*) from public.catalog_enrichment_source_schedule
    ),
    'verifiedProviderLinks', (
      select count(*) from public.catalog_source_provider_identities
    ),
    'providerOverviewCacheRows', (
      select count(*)
      from public.catalog_file_tracks
      where overview_status is not null
    ),
    'providerOverviewReady',
      to_regprocedure(
        'public.claim_provider_overview_candidates(uuid,uuid,integer)'
      ) is not null
      and to_regprocedure(
        'public.record_provider_overview_outcome(uuid,uuid,text,text,text,text,text,timestamptz,jsonb)'
      ) is not null
  )
$function$;

revoke all on function public.catalog_enrichment_fleet_preflight()
  from public, anon, authenticated;
grant execute on function public.catalog_enrichment_fleet_preflight()
  to service_role;

-- The overview crawl is lane 5, after the existing four media-probe lanes and
-- strict speech lane. Redefine only the completion state machine so a six-lane
-- sweep rests after synopsis work, while any earlier work rotates immediately.
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
    mod(schedule.dispatch_count, 6),
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

  if current_lane = 5 and prior_cycle_had_work then
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
           when current_lane = 5 then false
           else prior_cycle_had_work or result_had_work
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
  uuid, uuid, boolean, integer, boolean, jsonb
) from public, anon, authenticated;
grant execute on function public.finish_catalog_enrichment_source(
  uuid, uuid, boolean, integer, boolean, jsonb
) to service_role;
