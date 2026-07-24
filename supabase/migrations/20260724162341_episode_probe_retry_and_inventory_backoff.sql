-- Exact retry state for series episode probes and provider-wide backoff for
-- the metadata-only series inventory lane.
--
-- Security boundary:
--   * both tables are service-role-only and have RLS enabled with no policies;
--   * callers identify an owned source/file, never a provider identity directly;
--   * no response body, URL, hostname, credential or free-form details are
--     accepted or persisted;
--   * status is numeric, code is allow-listed, and transport is enumerated.
--
-- A successful episode probe deletes its exact retry row. A successful
-- provider inventory request clears the provider-wide block while retaining a
-- last-success timestamp for operations.

begin;

create or replace function public.catalog_sanitize_provider_failure_code(
  p_code text
) returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, public
as $function$
  select case lower(btrim(coalesce(p_code, '')))
    when 'account_busy' then 'account_busy'
    when 'viewer_busy' then 'viewer_busy'
    when 'viewer_active' then 'viewer_active'
    when 'viewer_preempted' then 'viewer_preempted'
    when 'playback_active' then 'playback_active'
    when 'background_busy' then 'background_busy'
    when 'local_background_busy' then 'local_background_busy'
    when 'provider_busy' then 'provider_busy'
    when 'upstream_multi_ip' then 'upstream_multi_ip'
    when 'upstream_provider_busy' then 'upstream_provider_busy'
    when 'unauthorized' then 'unauthorized'
    when 'authentication_failed' then 'authentication_failed'
    when 'upstream_unauthorized' then 'upstream_unauthorized'
    when 'forbidden' then 'forbidden'
    when 'upstream_forbidden' then 'upstream_forbidden'
    when 'rate_limited' then 'rate_limited'
    when 'too_many_requests' then 'too_many_requests'
    when 'upstream_rate_limit' then 'upstream_rate_limit'
    when 'request_timeout' then 'request_timeout'
    when 'gateway_timeout' then 'gateway_timeout'
    when 'gateway_unreachable' then 'gateway_unreachable'
    when 'upstream_timeout' then 'upstream_timeout'
    when 'upstream_unavailable' then 'upstream_unavailable'
    when 'upstream_refused' then 'upstream_refused'
    when 'upstream_error' then 'upstream_error'
    when 'bad_gateway' then 'bad_gateway'
    when 'service_unavailable' then 'service_unavailable'
    when 'provider_unavailable' then 'provider_unavailable'
    when 'not_found' then 'not_found'
    when 'item_unavailable' then 'item_unavailable'
    when 'upstream_not_found' then 'upstream_not_found'
    when 'no_stream' then 'no_stream'
    when 'no_audio_tracks' then 'no_audio_tracks'
    when 'empty_response' then 'empty_response'
    when 'invalid_media' then 'invalid_media'
    when 'invalid_container' then 'invalid_container'
    when 'unrecognized_input_format' then 'unrecognized_input_format'
    when 'observation_write_failed' then 'observation_write_failed'
    else null
  end
$function$;

create or replace function public.catalog_sanitize_probe_transport(
  p_transport text
) returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, public
as $function$
  select case lower(btrim(coalesce(p_transport, '')))
    when 'gateway' then 'gateway'
    when 'relay' then 'relay'
    when 'direct' then 'direct'
    when 'provider' then 'provider'
    when 'unknown' then 'unknown'
    else 'unknown'
  end
$function$;

create or replace function public.catalog_provider_failure_class(
  p_status integer,
  p_code text
) returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, public
as $function$
  with normalized as (
    select public.catalog_sanitize_provider_failure_code(p_code) as code
  )
  select case
    when normalized.code in (
      'account_busy',
      'viewer_busy',
      'viewer_active',
      'viewer_preempted',
      'playback_active',
      'upstream_multi_ip',
      'upstream_provider_busy'
    ) or p_status = 409
      then 'viewer_priority'
    when normalized.code in ('background_busy', 'local_background_busy', 'provider_busy')
      then 'background_busy'
    when p_status = 401
      or normalized.code in (
        'unauthorized',
        'authentication_failed',
        'upstream_unauthorized'
      )
      then 'authentication'
    when p_status = 403
      or normalized.code in ('forbidden', 'upstream_forbidden')
      then 'forbidden'
    when p_status = 429
      or normalized.code in (
        'rate_limited',
        'too_many_requests',
        'upstream_rate_limit'
      )
      then 'rate_limited'
    when p_status = 408
      or p_status = 425
      or p_status between 500 and 599
      or normalized.code in (
        'request_timeout',
        'gateway_timeout',
        'gateway_unreachable',
        'upstream_timeout',
        'upstream_unavailable',
        'upstream_refused',
        'upstream_error',
        'observation_write_failed',
        'bad_gateway',
        'service_unavailable',
        'provider_unavailable'
      )
      then 'transient'
    when p_status in (404, 410)
      or normalized.code in (
        'not_found',
        'item_unavailable',
        'upstream_not_found',
        'no_stream'
      )
      then 'item_unavailable'
    else 'invalid_response'
  end
  from normalized
$function$;

create or replace function public.catalog_provider_retry_interval(
  p_failure_class text,
  p_attempt integer
) returns interval
language sql
immutable
parallel safe
set search_path = pg_catalog, public
as $function$
  select case p_failure_class
    when 'viewer_priority' then interval '1 minute'
    when 'background_busy' then interval '2 minutes'
    when 'authentication' then interval '24 hours'
    when 'forbidden' then interval '24 hours'
    when 'rate_limited' then make_interval(
      mins => least(
        1440,
        60 * power(
          2::numeric,
          least(4, greatest(0, coalesce(p_attempt, 1) - 1))
        )::integer
      )
    )
    when 'transient' then make_interval(
      mins => least(
        360,
        15 * power(
          2::numeric,
          least(5, greatest(0, coalesce(p_attempt, 1) - 1))
        )::integer
      )
    )
    when 'item_unavailable' then interval '24 hours'
    else make_interval(
      mins => least(
        1440,
        360 * power(
          2::numeric,
          least(2, greatest(0, coalesce(p_attempt, 1) - 1))
        )::integer
      )
    )
  end
$function$;

create table if not exists public.catalog_episode_probe_state (
  provider_identity_id uuid not null
    references public.provider_identities(id) on delete cascade,
  variant_id uuid not null
    references public.cloud_title_variants(id) on delete cascade,
  episode_id text not null
    check (
      btrim(episode_id) <> ''
      and length(episode_id) <= 255
      and episode_id !~ '[[:cntrl:]]'
    ),
  attempts integer not null default 0
    check (attempts between 0 and 100000),
  failure_class text not null
    check (
      failure_class in (
        'viewer_priority',
        'background_busy',
        'authentication',
        'forbidden',
        'rate_limited',
        'transient',
        'item_unavailable',
        'invalid_response'
      )
    ),
  last_status integer
    check (last_status is null or last_status between 100 and 599),
  last_code text
    check (
      last_code is null
      or (
        length(last_code) <= 64
        and last_code ~ '^[a-z][a-z0-9_]{0,63}$'
      )
    ),
  last_transport text not null default 'unknown'
    check (last_transport in ('gateway', 'relay', 'direct', 'provider', 'unknown')),
  next_retry_at timestamptz not null,
  last_attempted_at timestamptz not null,
  last_failed_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (provider_identity_id, variant_id, episode_id)
);

create index if not exists catalog_episode_probe_state_variant_due_idx
  on public.catalog_episode_probe_state (
    variant_id,
    next_retry_at,
    episode_id
  );

create index if not exists catalog_episode_probe_state_provider_due_idx
  on public.catalog_episode_probe_state (
    provider_identity_id,
    next_retry_at,
    variant_id,
    episode_id
  );

alter table public.catalog_episode_probe_state enable row level security;
revoke all on table public.catalog_episode_probe_state
  from public, anon, authenticated;
grant select, insert, update, delete
  on table public.catalog_episode_probe_state to service_role;

comment on table public.catalog_episode_probe_state is
  'Service-role-only retry state for one canonical provider episode file. '
  'Stores only bounded status/class/code/transport metadata; success deletes the row.';

create table if not exists public.catalog_provider_inventory_backoff (
  source_id uuid primary key
    references public.cloud_sources(id) on delete cascade,
  provider_identity_id uuid not null
    references public.provider_identities(id) on delete cascade,
  consecutive_failures integer not null default 0
    check (consecutive_failures between 0 and 100000),
  failure_class text
    check (
      failure_class is null
      or failure_class in (
        'viewer_priority',
        'background_busy',
        'authentication',
        'forbidden',
        'rate_limited',
        'transient',
        'item_unavailable',
        'invalid_response'
      )
    ),
  last_status integer
    check (last_status is null or last_status between 100 and 599),
  last_code text
    check (
      last_code is null
      or (
        length(last_code) <= 64
        and last_code ~ '^[a-z][a-z0-9_]{0,63}$'
      )
    ),
  last_transport text
    check (
      last_transport is null
      or last_transport in ('gateway', 'relay', 'direct', 'provider', 'unknown')
    ),
  next_retry_at timestamptz not null default now(),
  last_attempted_at timestamptz,
  last_succeeded_at timestamptz,
  last_failed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists catalog_provider_inventory_backoff_due_idx
  on public.catalog_provider_inventory_backoff (
    next_retry_at,
    source_id,
    provider_identity_id
  );

create index if not exists catalog_provider_inventory_backoff_identity_idx
  on public.catalog_provider_inventory_backoff (
    provider_identity_id,
    next_retry_at,
    source_id
  );

alter table public.catalog_provider_inventory_backoff enable row level security;
revoke all on table public.catalog_provider_inventory_backoff
  from public, anon, authenticated;
grant select, insert, update, delete
  on table public.catalog_provider_inventory_backoff to service_role;

comment on table public.catalog_provider_inventory_backoff is
  'Service-role-only series-inventory backoff for one owned source/provider account. Canonical provider identities are retained for diagnostics but never share auth/rate blocks across accounts.';

create or replace function public.catalog_episode_probe_retry_state(
  p_user uuid,
  p_source uuid,
  p_variant uuid,
  p_episode_id text
) returns table(
  provider_identity_id uuid,
  blocked boolean,
  attempts integer,
  failure_class text,
  last_status integer,
  last_code text,
  last_transport text,
  next_retry_at timestamptz,
  last_attempted_at timestamptz,
  last_failed_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select
    membership.provider_identity_id,
    coalesce(retry.next_retry_at > now(), false) as blocked,
    coalesce(retry.attempts, 0) as attempts,
    retry.failure_class,
    retry.last_status,
    retry.last_code,
    retry.last_transport,
    retry.next_retry_at,
    retry.last_attempted_at,
    retry.last_failed_at
  from public.catalog_series_episode_memberships membership
  join public.cloud_sources source
    on source.id = membership.source_id
   and source.user_id = membership.user_id
   and source.deleted_at is null
   and source.enabled = true
   and source.sync_status = 'ready'
  join public.catalog_source_provider_identities identity
    on identity.source_id = membership.source_id
   and identity.user_id = membership.user_id
   and identity.identity_id = membership.provider_identity_id
  left join public.catalog_episode_probe_state retry
    on retry.provider_identity_id = membership.provider_identity_id
   and retry.variant_id = membership.parent_variant_id
   and retry.episode_id = membership.episode_id
  where membership.user_id = p_user
    and membership.source_id = p_source
    and membership.parent_variant_id = p_variant
    and membership.episode_id = btrim(p_episode_id)
    and not exists (
      select 1
      from public.catalog_series_episode_memberships conflicting
      where conflicting.provider_identity_id = membership.provider_identity_id
        and conflicting.episode_id = membership.episode_id
        and conflicting.parent_series_id is distinct from membership.parent_series_id
    )
  limit 1
$function$;

create or replace function public.record_catalog_episode_probe_outcome(
  p_user uuid,
  p_source uuid,
  p_variant uuid,
  p_episode_id text,
  p_success boolean,
  p_status integer default null,
  p_code text default null,
  p_transport text default null,
  p_retry_at timestamptz default null
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_identity_id uuid;
  v_attempt integer := 1;
  v_failure_class text;
  v_code text;
  v_transport text;
  v_now timestamptz := clock_timestamp();
  v_default_retry_at timestamptz;
  v_retry_at timestamptz;
begin
  if p_user is null
     or p_source is null
     or p_variant is null
     or coalesce(btrim(p_episode_id), '') = ''
     or length(btrim(p_episode_id)) > 255
     or p_success is null
     or (p_status is not null and p_status not between 100 and 599) then
    raise exception 'Invalid catalog episode probe outcome'
      using errcode = '22023';
  end if;

  select membership.provider_identity_id
    into v_identity_id
  from public.catalog_series_episode_memberships membership
  join public.cloud_sources source
    on source.id = membership.source_id
   and source.user_id = membership.user_id
   and source.deleted_at is null
   and source.enabled = true
   and source.sync_status = 'ready'
  join public.catalog_source_provider_identities identity
    on identity.source_id = membership.source_id
   and identity.user_id = membership.user_id
   and identity.identity_id = membership.provider_identity_id
  where membership.user_id = p_user
    and membership.source_id = p_source
    and membership.parent_variant_id = p_variant
    and membership.episode_id = btrim(p_episode_id)
    and not exists (
      select 1
      from public.catalog_series_episode_memberships conflicting
      where conflicting.provider_identity_id = membership.provider_identity_id
        and conflicting.episode_id = membership.episode_id
        and conflicting.parent_series_id is distinct from membership.parent_series_id
    )
  for key share of membership, source;

  if not found then
    return jsonb_build_object('recorded', false, 'reason', 'not_owned');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'catalog-episode-probe-state:'
      || v_identity_id::text
      || ':'
      || p_variant::text
      || ':'
      || btrim(p_episode_id),
    0
  ));

  if p_success then
    delete from public.catalog_episode_probe_state retry
    where retry.provider_identity_id = v_identity_id
      and retry.variant_id = p_variant
      and retry.episode_id = btrim(p_episode_id);

    return jsonb_build_object(
      'recorded', true,
      'cleared', true,
      'providerIdentityId', v_identity_id,
      'variantId', p_variant,
      'episodeId', btrim(p_episode_id)
    );
  end if;

  select least(100000, retry.attempts + 1)
    into v_attempt
  from public.catalog_episode_probe_state retry
  where retry.provider_identity_id = v_identity_id
    and retry.variant_id = p_variant
    and retry.episode_id = btrim(p_episode_id)
  for update;
  v_attempt := coalesce(v_attempt, 1);

  v_code := public.catalog_sanitize_provider_failure_code(p_code);
  v_transport := public.catalog_sanitize_probe_transport(p_transport);
  v_failure_class := public.catalog_provider_failure_class(p_status, p_code);
  v_default_retry_at :=
    v_now + public.catalog_provider_retry_interval(v_failure_class, v_attempt);
  v_retry_at := case
    when p_retry_at is null then v_default_retry_at
    else greatest(
      v_default_retry_at,
      greatest(
        v_now + interval '30 seconds',
        least(v_now + interval '30 days', p_retry_at)
      )
    )
  end;

  insert into public.catalog_episode_probe_state as retry (
    provider_identity_id,
    variant_id,
    episode_id,
    attempts,
    failure_class,
    last_status,
    last_code,
    last_transport,
    next_retry_at,
    last_attempted_at,
    last_failed_at,
    created_at,
    updated_at
  ) values (
    v_identity_id,
    p_variant,
    btrim(p_episode_id),
    v_attempt,
    v_failure_class,
    p_status,
    v_code,
    v_transport,
    v_retry_at,
    v_now,
    v_now,
    v_now,
    v_now
  )
  on conflict (provider_identity_id, variant_id, episode_id) do update set
    attempts = excluded.attempts,
    failure_class = excluded.failure_class,
    last_status = excluded.last_status,
    last_code = excluded.last_code,
    last_transport = excluded.last_transport,
    next_retry_at = excluded.next_retry_at,
    last_attempted_at = excluded.last_attempted_at,
    last_failed_at = excluded.last_failed_at,
    updated_at = excluded.updated_at;

  return jsonb_build_object(
    'recorded', true,
    'cleared', false,
    'providerIdentityId', v_identity_id,
    'variantId', p_variant,
    'episodeId', btrim(p_episode_id),
    'attempts', v_attempt,
    'failureClass', v_failure_class,
    'status', p_status,
    'code', v_code,
    'transport', v_transport,
    'nextRetryAt', v_retry_at
  );
end
$function$;

create or replace function public.catalog_provider_inventory_backoff_state(
  p_user uuid,
  p_source uuid
) returns table(
  provider_identity_id uuid,
  blocked boolean,
  consecutive_failures integer,
  failure_class text,
  last_status integer,
  last_code text,
  last_transport text,
  next_retry_at timestamptz,
  last_attempted_at timestamptz,
  last_succeeded_at timestamptz,
  last_failed_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select
    identity.identity_id as provider_identity_id,
    coalesce(backoff.next_retry_at > now(), false) as blocked,
    coalesce(backoff.consecutive_failures, 0) as consecutive_failures,
    backoff.failure_class,
    backoff.last_status,
    backoff.last_code,
    backoff.last_transport,
    backoff.next_retry_at,
    backoff.last_attempted_at,
    backoff.last_succeeded_at,
    backoff.last_failed_at
  from public.cloud_sources source
  join public.catalog_source_provider_identities identity
    on identity.source_id = source.id
   and identity.user_id = source.user_id
  left join public.catalog_provider_inventory_backoff backoff
    on backoff.source_id = source.id
   and backoff.provider_identity_id = identity.identity_id
  where source.id = p_source
    and source.user_id = p_user
    and source.deleted_at is null
    and source.source_type = 'xtream'
  limit 1
$function$;

create or replace function public.record_catalog_provider_inventory_outcome(
  p_user uuid,
  p_source uuid,
  p_success boolean,
  p_status integer default null,
  p_code text default null,
  p_transport text default null,
  p_retry_at timestamptz default null
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_identity_id uuid;
  v_attempt integer := 1;
  v_failure_class text;
  v_code text;
  v_transport text;
  v_now timestamptz := clock_timestamp();
  v_default_retry_at timestamptz;
  v_retry_at timestamptz;
begin
  if p_user is null
     or p_source is null
     or p_success is null
     or (p_status is not null and p_status not between 100 and 599) then
    raise exception 'Invalid provider inventory outcome'
      using errcode = '22023';
  end if;

  select identity.identity_id
    into v_identity_id
  from public.cloud_sources source
  join public.catalog_source_provider_identities identity
    on identity.source_id = source.id
   and identity.user_id = source.user_id
  where source.id = p_source
    and source.user_id = p_user
    and source.deleted_at is null
    and source.enabled = true
    and source.sync_status = 'ready'
    and source.source_type = 'xtream'
  for key share of source, identity;

  if not found then
    return jsonb_build_object('recorded', false, 'reason', 'not_owned');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'catalog-provider-inventory-backoff:' || p_source::text,
    0
  ));

  if p_success then
    insert into public.catalog_provider_inventory_backoff as backoff (
      source_id,
      provider_identity_id,
      consecutive_failures,
      failure_class,
      last_status,
      last_code,
      last_transport,
      next_retry_at,
      last_attempted_at,
      last_succeeded_at,
      last_failed_at,
      created_at,
      updated_at
    ) values (
      p_source,
      v_identity_id,
      0,
      null,
      null,
      null,
      null,
      transaction_timestamp(),
      v_now,
      v_now,
      null,
      v_now,
      v_now
    )
    on conflict (source_id) do update set
      provider_identity_id = excluded.provider_identity_id,
      consecutive_failures = 0,
      failure_class = null,
      last_status = null,
      last_code = null,
      last_transport = null,
      next_retry_at = transaction_timestamp(),
      last_attempted_at = v_now,
      last_succeeded_at = v_now,
      last_failed_at = null,
      updated_at = v_now;

    return jsonb_build_object(
      'recorded', true,
      'cleared', true,
      'providerIdentityId', v_identity_id,
      'nextRetryAt', transaction_timestamp()
    );
  end if;

  select least(100000, backoff.consecutive_failures + 1)
    into v_attempt
  from public.catalog_provider_inventory_backoff backoff
  where backoff.source_id = p_source
    and backoff.provider_identity_id = v_identity_id
  for update;
  v_attempt := coalesce(v_attempt, 1);

  v_code := public.catalog_sanitize_provider_failure_code(p_code);
  v_transport := public.catalog_sanitize_probe_transport(p_transport);
  v_failure_class := public.catalog_provider_failure_class(p_status, p_code);
  v_default_retry_at :=
    v_now + public.catalog_provider_retry_interval(v_failure_class, v_attempt);
  v_retry_at := case
    when p_retry_at is null then v_default_retry_at
    else greatest(
      v_default_retry_at,
      greatest(
        v_now + interval '30 seconds',
        least(v_now + interval '30 days', p_retry_at)
      )
    )
  end;

  insert into public.catalog_provider_inventory_backoff as backoff (
    source_id,
    provider_identity_id,
    consecutive_failures,
    failure_class,
    last_status,
    last_code,
    last_transport,
    next_retry_at,
    last_attempted_at,
    last_succeeded_at,
    last_failed_at,
    created_at,
    updated_at
  ) values (
    p_source,
    v_identity_id,
    v_attempt,
    v_failure_class,
    p_status,
    v_code,
    v_transport,
    v_retry_at,
    v_now,
    null,
    v_now,
    v_now,
    v_now
  )
  on conflict (source_id) do update set
    provider_identity_id = excluded.provider_identity_id,
    consecutive_failures = excluded.consecutive_failures,
    failure_class = excluded.failure_class,
    last_status = excluded.last_status,
    last_code = excluded.last_code,
    last_transport = excluded.last_transport,
    next_retry_at = excluded.next_retry_at,
    last_attempted_at = excluded.last_attempted_at,
    last_failed_at = excluded.last_failed_at,
    updated_at = excluded.updated_at;

  return jsonb_build_object(
    'recorded', true,
    'cleared', false,
    'providerIdentityId', v_identity_id,
    'consecutiveFailures', v_attempt,
    'failureClass', v_failure_class,
    'status', p_status,
    'code', v_code,
    'transport', v_transport,
    'nextRetryAt', v_retry_at
  );
end
$function$;

-- Preserve the exact return contract and fair parent-first ordering installed
-- by 20260723100000; add only the exact file retry guard.
create or replace function public.catalog_episode_probe_candidates(
  p_user uuid,
  p_source uuid default null,
  p_limit integer default 4
) returns table(
  user_id uuid,
  source_id uuid,
  title_id uuid,
  variant_id uuid,
  provider_identity_id uuid,
  server_host text,
  parent_series_id text,
  episode_id text,
  container_extension text,
  season_number integer,
  episode_number integer,
  audio_tracks jsonb,
  subtitle_tracks jsonb,
  audio_probed_at timestamptz,
  subtitle_probed_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  with owned_memberships as (
    select
      membership.user_id,
      membership.source_id,
      membership.parent_title_id as title_id,
      membership.parent_variant_id as variant_id,
      membership.provider_identity_id,
      membership.parent_series_id,
      membership.episode_id,
      membership.container_extension,
      membership.season_number,
      membership.episode_number,
      membership.series_info_observed_at,
      coalesce(cache.audio_tracks, '[]'::jsonb) as audio_tracks,
      coalesce(cache.subtitle_tracks, '[]'::jsonb) as subtitle_tracks,
      cache.audio_probed_at,
      cache.subtitle_probed_at,
      retry.next_retry_at as probe_retry_at,
      bool_or(cache.audio_probed_at is not null) over (
        partition by
          membership.user_id,
          membership.source_id,
          membership.parent_series_id
      ) as parent_has_probe
    from public.catalog_series_episode_memberships membership
    join public.cloud_sources source
      on source.id = membership.source_id
     and source.user_id = membership.user_id
     and source.deleted_at is null
     and source.enabled = true
     and source.sync_status = 'ready'
    join public.catalog_source_provider_identities identity
      on identity.source_id = membership.source_id
     and identity.user_id = membership.user_id
     and identity.identity_id = membership.provider_identity_id
    left join public.catalog_file_tracks cache
      on cache.server_host = membership.provider_identity_id::text
     and cache.item_type = 'episode'
     and cache.external_id = membership.episode_id
    left join public.catalog_episode_probe_state retry
      on retry.provider_identity_id = membership.provider_identity_id
     and retry.variant_id = membership.parent_variant_id
     and retry.episode_id = membership.episode_id
    where membership.user_id = p_user
      and (p_source is null or membership.source_id = p_source)
      and (
        retry.provider_identity_id is null
        or retry.next_retry_at <= now()
      )
      and not exists (
        select 1
        from public.catalog_series_episode_memberships conflicting
        where conflicting.provider_identity_id = membership.provider_identity_id
          and conflicting.episode_id = membership.episode_id
          and conflicting.parent_series_id is distinct from membership.parent_series_id
      )
  ),
  due as (
    select
      owned.*,
      row_number() over (
        partition by
          owned.user_id,
          owned.source_id,
          owned.parent_series_id
        order by
          owned.audio_probed_at asc nulls first,
          owned.series_info_observed_at desc,
          owned.season_number nulls last,
          owned.episode_number nulls last,
          owned.episode_id
      ) as parent_due_rank
    from owned_memberships owned
    where owned.audio_probed_at is null
       or owned.audio_probed_at < now() - interval '180 days'
  )
  select
    due.user_id,
    due.source_id,
    due.title_id,
    due.variant_id,
    due.provider_identity_id,
    due.provider_identity_id::text as server_host,
    due.parent_series_id,
    due.episode_id,
    due.container_extension,
    due.season_number,
    due.episode_number,
    due.audio_tracks,
    due.subtitle_tracks,
    due.audio_probed_at,
    due.subtitle_probed_at
  from due
  order by
    case
      when not due.parent_has_probe and due.parent_due_rank = 1 then 0
      else 1
    end,
    due.parent_due_rank,
    due.parent_has_probe asc,
    due.audio_probed_at asc nulls first,
    due.series_info_observed_at desc,
    due.parent_series_id,
    due.season_number nulls last,
    due.episode_number nulls last,
    due.episode_id
  limit greatest(1, least(100, coalesce(p_limit, 4)))
$function$;

-- Preserve the exact backlog-priority contract installed by
-- 20260720183000; add only the provider-wide inventory backoff guard.
create or replace function public.catalog_series_inventory_candidates(
  p_user uuid,
  p_source uuid,
  p_limit int default 4
) returns table(
  parent_series_id text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select variant.external_id as parent_series_id
  from public.cloud_title_variants variant
  join public.cloud_titles title
    on title.id = variant.title_id
   and title.user_id = variant.user_id
   and title.item_type = variant.item_type
  join public.cloud_sources source
    on source.id = variant.source_id
   and source.user_id = variant.user_id
   and source.deleted_at is null
   and source.enabled = true
   and source.sync_status = 'ready'
   and source.source_type = 'xtream'
  join public.catalog_source_provider_identities identity
    on identity.source_id = source.id
   and identity.user_id = source.user_id
  left join public.catalog_series_inventory_state inventory
    on inventory.user_id = variant.user_id
   and inventory.source_id = variant.source_id
   and inventory.parent_variant_id = variant.id
   and inventory.parent_series_id = variant.external_id
   and inventory.provider_identity_id = identity.identity_id
  left join public.catalog_provider_inventory_backoff provider_backoff
    on provider_backoff.source_id = source.id
   and provider_backoff.provider_identity_id = identity.identity_id
  left join public.catalog_file_tracks legacy_parent
    on legacy_parent.server_host = identity.identity_id::text
   and legacy_parent.item_type = 'series'
   and legacy_parent.external_id = variant.external_id
  where variant.user_id = p_user
    and variant.source_id = p_source
    and variant.item_type = 'series'
    and variant.title_id is not null
    and coalesce(btrim(variant.external_id), '') <> ''
    and (
      inventory.source_id is null
      or inventory.next_retry_at <= now()
    )
    and (
      provider_backoff.provider_identity_id is null
      or provider_backoff.next_retry_at <= now()
    )
  order by
    case when exists (
      select 1
      from jsonb_array_elements(
        case
          when jsonb_typeof(legacy_parent.audio_tracks) = 'array'
            then legacy_parent.audio_tracks
          else '[]'::jsonb
        end
      ) track
      where coalesce(
        nullif(lower(btrim(track->>'lang')), ''),
        nullif(lower(btrim(track->>'language')), ''),
        'und'
      ) in ('und', 'un', 'mis', 'mul', 'zxx', 'nar', 'unknown')
    ) then 0 else 1 end,
    case when inventory.source_id is null then 0 else 1 end,
    title.release_year desc nulls last,
    inventory.next_retry_at nulls first,
    variant.external_id,
    variant.id
  limit greatest(1, least(100, coalesce(p_limit, 4)))
$function$;

revoke all on function public.catalog_sanitize_provider_failure_code(text)
  from public, anon, authenticated;
revoke all on function public.catalog_sanitize_probe_transport(text)
  from public, anon, authenticated;
revoke all on function public.catalog_provider_failure_class(integer, text)
  from public, anon, authenticated;
revoke all on function public.catalog_provider_retry_interval(text, integer)
  from public, anon, authenticated;
revoke all on function public.catalog_episode_probe_retry_state(
  uuid, uuid, uuid, text
) from public, anon, authenticated;
revoke all on function public.record_catalog_episode_probe_outcome(
  uuid, uuid, uuid, text, boolean, integer, text, text, timestamptz
) from public, anon, authenticated;
revoke all on function public.catalog_provider_inventory_backoff_state(
  uuid, uuid
) from public, anon, authenticated;
revoke all on function public.record_catalog_provider_inventory_outcome(
  uuid, uuid, boolean, integer, text, text, timestamptz
) from public, anon, authenticated;
revoke all on function public.catalog_episode_probe_candidates(
  uuid, uuid, integer
) from public, anon, authenticated;
revoke all on function public.catalog_series_inventory_candidates(
  uuid, uuid, int
) from public, anon, authenticated;

grant execute on function public.catalog_sanitize_provider_failure_code(text)
  to service_role;
grant execute on function public.catalog_sanitize_probe_transport(text)
  to service_role;
grant execute on function public.catalog_provider_failure_class(integer, text)
  to service_role;
grant execute on function public.catalog_provider_retry_interval(text, integer)
  to service_role;
grant execute on function public.catalog_episode_probe_retry_state(
  uuid, uuid, uuid, text
) to service_role;
grant execute on function public.record_catalog_episode_probe_outcome(
  uuid, uuid, uuid, text, boolean, integer, text, text, timestamptz
) to service_role;
grant execute on function public.catalog_provider_inventory_backoff_state(
  uuid, uuid
) to service_role;
grant execute on function public.record_catalog_provider_inventory_outcome(
  uuid, uuid, boolean, integer, text, text, timestamptz
) to service_role;
grant execute on function public.catalog_episode_probe_candidates(
  uuid, uuid, integer
) to service_role;
grant execute on function public.catalog_series_inventory_candidates(
  uuid, uuid, int
) to service_role;

comment on function public.catalog_episode_probe_retry_state(uuid, uuid, uuid, text) is
  'Reads sanitized retry state for one exact owned episode file; returns no row when ownership is not proven.';
comment on function public.record_catalog_episode_probe_outcome(
  uuid, uuid, uuid, text, boolean, integer, text, text, timestamptz
) is
  'Records one exact episode probe failure or clears its retry state on success. No free-form provider data is stored.';
comment on function public.catalog_provider_inventory_backoff_state(uuid, uuid) is
  'Reads provider-wide inventory backoff through an exact owned source-to-identity link.';
comment on function public.record_catalog_provider_inventory_outcome(
  uuid, uuid, boolean, integer, text, text, timestamptz
) is
  'Records or clears provider-wide series inventory backoff using sanitized status, code and transport only.';
comment on function public.catalog_episode_probe_candidates(uuid, uuid, integer) is
  'Fair exact episode probe queue. Excludes files whose service-only retry state is not due.';
comment on function public.catalog_series_inventory_candidates(uuid, uuid, int) is
  'Exact parent-series inventory queue. Excludes canonical providers whose service-only inventory backoff is not due.';

notify pgrst, 'reload schema';

commit;
