-- RevenueCat TRANSFER is a dedicated identity event applied post-hardening. It has no transaction or
-- product fields, so the Edge receiver must re-fetch CustomerInfo before this
-- RPC can move an entitlement. Raw aliases and subscriber attributes are never
-- persisted: only canonical Norva UUIDs, bounded counts and SHA-256 evidence.

create table if not exists public.cloud_revenuecat_transfer_events (
  event_id text primary key,
  event_at timestamptz not null,
  payload_fingerprint text not null,
  authority_fingerprint text,
  destination_user_id uuid,
  source_user_ids uuid[] not null default '{}'::uuid[],
  source_identifier_count smallint not null,
  destination_identifier_count smallint not null,
  status text not null default 'quarantined',
  reason text not null,
  delivery_count integer not null default 1,
  source_expired_count smallint not null default 0,
  first_seen_at timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz not null default clock_timestamp(),
  applied_at timestamptz,
  constraint revenuecat_transfer_event_id_check check (
    length(event_id) between 8 and 255
    and event_id !~ '[[:space:][:cntrl:]]'
  ),
  constraint revenuecat_transfer_payload_fingerprint_check check (
    payload_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  constraint revenuecat_transfer_authority_fingerprint_check check (
    authority_fingerprint is null
    or authority_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  constraint revenuecat_transfer_source_ids_check check (
    cardinality(source_user_ids) between 0 and 32
  ),
  constraint revenuecat_transfer_identifier_counts_check check (
    source_identifier_count between 1 and 32
    and destination_identifier_count between 1 and 32
  ),
  constraint revenuecat_transfer_status_check check (
    status in ('quarantined', 'rejected', 'applied')
  ),
  constraint revenuecat_transfer_reason_check check (
    reason ~ '^[a-z0-9_]{3,80}$'
  ),
  constraint revenuecat_transfer_delivery_count_check check (
    delivery_count between 1 and 1000000
  ),
  constraint revenuecat_transfer_expired_count_check check (
    source_expired_count between 0 and 32
  )
);

alter table public.cloud_revenuecat_transfer_events enable row level security;
revoke all on table public.cloud_revenuecat_transfer_events
  from public, anon, authenticated;
grant select on table public.cloud_revenuecat_transfer_events to service_role;

create index if not exists revenuecat_transfer_events_status_seen_idx
  on public.cloud_revenuecat_transfer_events (status, last_seen_at desc);

create or replace function public.quarantine_revenuecat_entitlement_transfer(
  p_event_id text,
  p_event_at timestamptz,
  p_payload_fingerprint text,
  p_reason text,
  p_destination_user_id uuid,
  p_source_user_ids uuid[],
  p_source_identifier_count integer,
  p_destination_identifier_count integer
) returns table(
  transfer_status text,
  transfer_reason text
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_existing public.cloud_revenuecat_transfer_events%rowtype;
  v_sources uuid[];
begin
  if p_event_at is null
     or p_event_id is null
     or length(p_event_id) not between 8 and 255
     or p_event_id ~ '[[:space:][:cntrl:]]' then
    raise exception 'invalid_revenuecat_transfer_event';
  end if;
  if p_payload_fingerprint is null
     or p_payload_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_revenuecat_transfer_fingerprint';
  end if;
  if p_reason is null or p_reason !~ '^[a-z0-9_]{3,80}$' then
    raise exception 'invalid_revenuecat_transfer_reason';
  end if;
  if p_source_identifier_count not between 1 and 32
     or p_destination_identifier_count not between 1 and 32 then
    raise exception 'invalid_revenuecat_transfer_identifier_count';
  end if;

  select coalesce(array_agg(s.source_id order by s.source_id), '{}'::uuid[])
    into v_sources
  from (
    select distinct u.source_id
    from unnest(coalesce(p_source_user_ids, '{}'::uuid[])) as u(source_id)
    where u.source_id is not null
      and u.source_id is distinct from p_destination_user_id
  ) s;
  if cardinality(v_sources) > 32 then
    raise exception 'too_many_revenuecat_transfer_sources';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('norva:revenuecat:transfer:' || p_event_id, 0)
  );
  select *
    into v_existing
  from public.cloud_revenuecat_transfer_events e
  where e.event_id = p_event_id
  for update;

  if found then
    if v_existing.payload_fingerprint <> p_payload_fingerprint then
      raise exception 'revenuecat_transfer_event_conflict';
    end if;
    update public.cloud_revenuecat_transfer_events e
    set delivery_count = least(e.delivery_count + 1, 1000000),
        last_seen_at = clock_timestamp(),
        reason = case when e.status = 'applied' then e.reason else p_reason end,
        destination_user_id = coalesce(
          e.destination_user_id,
          p_destination_user_id
        ),
        source_user_ids = case
          when cardinality(e.source_user_ids) = 0 then v_sources
          else e.source_user_ids
        end
    where e.event_id = p_event_id
    returning e.status, e.reason
      into transfer_status, transfer_reason;
    return next;
    return;
  end if;

  insert into public.cloud_revenuecat_transfer_events (
    event_id,
    event_at,
    payload_fingerprint,
    destination_user_id,
    source_user_ids,
    source_identifier_count,
    destination_identifier_count,
    status,
    reason
  ) values (
    p_event_id,
    p_event_at,
    p_payload_fingerprint,
    p_destination_user_id,
    v_sources,
    p_source_identifier_count,
    p_destination_identifier_count,
    'quarantined',
    p_reason
  )
  returning status, reason into transfer_status, transfer_reason;
  return next;
end
$function$;

create or replace function public.apply_revenuecat_entitlement_transfer(
  p_event_id text,
  p_event_at timestamptz,
  p_payload_fingerprint text,
  p_authority_fingerprint text,
  p_destination_user_id uuid,
  p_source_user_ids uuid[],
  p_source_identifier_count integer,
  p_destination_identifier_count integer,
  p_patch jsonb
) returns table(
  applied boolean,
  disposition text,
  source_expired_count integer
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_existing public.cloud_revenuecat_transfer_events%rowtype;
  v_destination_projection public.cloud_entitlement_projection%rowtype;
  v_destination_applied boolean := false;
  v_destination_last_event_at timestamptz;
  v_source_id uuid;
  v_source_projection public.cloud_entitlement_projection%rowtype;
  v_source_cursor public.cloud_revenuecat_projection_cursor%rowtype;
  v_sources uuid[];
  v_expired integer := 0;
  v_disposition text := 'applied';
  v_event_exists boolean := false;
begin
  if p_event_at is null
     or p_event_id is null
     or length(p_event_id) not between 8 and 255
     or p_event_id ~ '[[:space:][:cntrl:]]' then
    raise exception 'invalid_revenuecat_transfer_event';
  end if;
  if p_payload_fingerprint is null
     or p_payload_fingerprint !~ '^[0-9a-f]{64}$'
     or p_authority_fingerprint is null
     or p_authority_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_revenuecat_transfer_fingerprint';
  end if;
  if p_destination_user_id is null then
    raise exception 'missing_revenuecat_transfer_destination';
  end if;
  if p_source_identifier_count not between 1 and 32
     or p_destination_identifier_count not between 1 and 32 then
    raise exception 'invalid_revenuecat_transfer_identifier_count';
  end if;
  if p_patch is null
     or jsonb_typeof(p_patch) <> 'object'
     or nullif(p_patch->>'user_id', '')::uuid is distinct from p_destination_user_id
     or coalesce(p_patch->>'provider', '') not in (
       'revenuecat', 'google_play', 'apple_app_store', 'stripe', 'web'
     )
     or coalesce(p_patch->>'plan_code', '') not in ('plus', 'family')
     or coalesce(p_patch->>'status', '') not in (
       'trialing', 'active', 'past_due', 'cancelled_at_period_end'
     )
     or nullif(p_patch->>'current_period_end', '') is null
     or nullif(p_patch->>'current_period_end', '')::timestamptz
          <= clock_timestamp()
     or nullif(p_patch->>'last_event_at', '')::timestamptz
          is distinct from p_event_at
     or nullif(p_patch->>'provider_customer_id', '')::uuid
          is distinct from p_destination_user_id
     or coalesce(p_patch->>'bill_period', '') not in ('monthly', 'annual')
     or nullif(p_patch->>'billing_product_id', '') is null
     or not (p_patch ? 'mrr_cents')
     or p_patch->'mrr_cents' <> 'null'::jsonb
     or not (p_patch ? 'billing_currency')
     or p_patch->'billing_currency' <> 'null'::jsonb
     or not (p_patch ? 'billing_package_id')
     or p_patch->'billing_package_id' <> 'null'::jsonb
     or coalesce(p_patch->>'billing_terms_source', '')
          <> 'revenuecat_transfer_refetch' then
    raise exception 'invalid_revenuecat_transfer_patch';
  end if;

  select coalesce(array_agg(s.source_id order by s.source_id), '{}'::uuid[])
    into v_sources
  from (
    select distinct u.source_id
    from unnest(coalesce(p_source_user_ids, '{}'::uuid[])) as u(source_id)
    where u.source_id is not null
      and u.source_id <> p_destination_user_id
  ) s;
  if cardinality(v_sources) > 32 then
    raise exception 'too_many_revenuecat_transfer_sources';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('norva:revenuecat:transfer:' || p_event_id, 0)
  );
  select *
    into v_existing
  from public.cloud_revenuecat_transfer_events e
  where e.event_id = p_event_id
  for update;
  v_event_exists := found;

  if v_event_exists and v_existing.payload_fingerprint <> p_payload_fingerprint then
    raise exception 'revenuecat_transfer_event_conflict';
  end if;
  if v_event_exists and v_existing.status = 'applied' then
    update public.cloud_revenuecat_transfer_events e
    set delivery_count = least(e.delivery_count + 1, 1000000),
        last_seen_at = clock_timestamp()
    where e.event_id = p_event_id;
    return query
    select true, v_existing.reason, v_existing.source_expired_count::integer;
    return;
  end if;

  if not exists (
    select 1 from auth.users u where u.id = p_destination_user_id
  ) then
    perform public.quarantine_revenuecat_entitlement_transfer(
      p_event_id,
      p_event_at,
      p_payload_fingerprint,
      'destination_user_not_found',
      p_destination_user_id,
      v_sources,
      p_source_identifier_count,
      p_destination_identifier_count
    );
    update public.cloud_revenuecat_transfer_events e
    set status = 'rejected',
        reason = 'destination_user_not_found',
        authority_fingerprint = p_authority_fingerprint,
        last_seen_at = clock_timestamp()
    where e.event_id = p_event_id;
    return query select false, 'destination_user_not_found'::text, 0;
    return;
  end if;

  -- Lock every account in UUID order before either side is changed. This makes
  -- concurrent reciprocal transfers deterministic and avoids lock inversion.
  for v_source_id in
    select user_id
    from (
      select p_destination_user_id as user_id
      union
      select unnest(v_sources)
    ) locked_users
    order by user_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_source_id::text, 20260721)
    );
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'norva:revenuecat:' || v_source_id::text,
        0
      )
    );
  end loop;

  if not v_event_exists then
    insert into public.cloud_revenuecat_transfer_events (
      event_id,
      event_at,
      payload_fingerprint,
      authority_fingerprint,
      destination_user_id,
      source_user_ids,
      source_identifier_count,
      destination_identifier_count,
      status,
      reason
    ) values (
      p_event_id,
      p_event_at,
      p_payload_fingerprint,
      p_authority_fingerprint,
      p_destination_user_id,
      v_sources,
      p_source_identifier_count,
      p_destination_identifier_count,
      'quarantined',
      'authority_verified'
    );
  else
    update public.cloud_revenuecat_transfer_events e
    set authority_fingerprint = p_authority_fingerprint,
        destination_user_id = p_destination_user_id,
        source_user_ids = v_sources,
        source_identifier_count = p_source_identifier_count,
        destination_identifier_count = p_destination_identifier_count,
        delivery_count = least(e.delivery_count + 1, 1000000),
        last_seen_at = clock_timestamp(),
        reason = 'authority_verified'
    where e.event_id = p_event_id;
  end if;

  select p.*
    into v_destination_projection
  from public.cloud_entitlement_projection p
  where p.user_id = p_destination_user_id
  for update;

  select r.applied, r.projection_last_event_at
    into v_destination_applied, v_destination_last_event_at
  from public.apply_revenuecat_entitlement_event(
    p_destination_user_id,
    p_event_at,
    p_event_id,
    p_patch
  ) r;

  if not coalesce(v_destination_applied, false) then
    v_disposition := case
      when public.norva_is_internal_account(p_destination_user_id)
        then 'destination_internal_account'
      when v_destination_projection.status in ('revoked', 'refunded', 'fraud')
        then 'destination_hard_blocked'
      when v_destination_projection.user_id is not null
       and lower(coalesce(v_destination_projection.provider, '')) not in (
         'revenuecat', 'google_play', 'apple_app_store', 'stripe', 'web'
       )
        then 'destination_cross_rail_preserved'
      else 'destination_stale_or_rejected'
    end;
    update public.cloud_revenuecat_transfer_events e
    set status = 'rejected',
        reason = v_disposition,
        last_seen_at = clock_timestamp()
    where e.event_id = p_event_id;

    insert into public.cloud_entitlement_events (
      user_id,
      provider,
      provider_event_id,
      event_type,
      payload,
      processed_at
    ) values (
      p_destination_user_id,
      'revenuecat',
      p_event_id,
      'TRANSFER',
      jsonb_build_object(
        'source_identifier_count', p_source_identifier_count,
        'destination_identifier_count', p_destination_identifier_count,
        'canonical_source_count', cardinality(v_sources),
        '_norva', jsonb_build_object(
          'projection_applied', false,
          'disposition', v_disposition,
          'authority', 'revenuecat_customer_info_refetch'
        )
      ),
      clock_timestamp()
    )
    on conflict (provider, provider_event_id)
      where provider_event_id is not null
      do nothing;

    return query select false, v_disposition, 0;
    return;
  end if;

  for v_source_id in
    select unnest(v_sources) order by 1
  loop
    select p.*
      into v_source_projection
    from public.cloud_entitlement_projection p
    where p.user_id = v_source_id
    for update;
    if not found
       or public.norva_is_internal_account(v_source_id)
       or v_source_projection.status in ('revoked', 'refunded', 'fraud')
       or lower(coalesce(v_source_projection.provider, '')) not in (
         'revenuecat', 'google_play', 'apple_app_store', 'stripe', 'web'
       )
       or coalesce(v_source_projection.last_event_at, '-infinity'::timestamptz)
            >= p_event_at then
      continue;
    end if;

    select c.*
      into v_source_cursor
    from public.cloud_revenuecat_projection_cursor c
    where c.user_id = v_source_id
    for update;
    if found and v_source_cursor.last_event_at >= p_event_at then
      continue;
    end if;

    update public.cloud_entitlement_projection p
    set status = 'expired',
        provider_customer_id = null,
        current_period_end = least(
          coalesce(p.current_period_end, p_event_at),
          p_event_at
        ),
        fail_open_until = null,
        last_verified_at = clock_timestamp(),
        last_event_at = p_event_at,
        mrr_cents = null,
        bill_period = null,
        billing_currency = null,
        billing_product_id = null,
        billing_package_id = null,
        billing_terms_source = null
    where p.user_id = v_source_id;

    insert into public.cloud_revenuecat_projection_cursor as c (
      user_id,
      last_event_at,
      last_event_id,
      last_projection_applied,
      updated_at
    ) values (
      v_source_id,
      p_event_at,
      p_event_id,
      false,
      clock_timestamp()
    )
    on conflict (user_id) do update
    set last_event_at = excluded.last_event_at,
        last_event_id = excluded.last_event_id,
        last_projection_applied = false,
        updated_at = excluded.updated_at;

    insert into public.cloud_entitlement_events (
      user_id,
      provider,
      provider_event_id,
      event_type,
      payload,
      processed_at
    ) values (
      v_source_id,
      'revenuecat',
      left(p_event_id, 130) || ':' || left(p_payload_fingerprint, 16)
        || ':transfer-out:' || v_source_id::text,
      'TRANSFER_SOURCE_EXPIRED',
      jsonb_build_object(
        'source_identifier_count', p_source_identifier_count,
        'destination_identifier_count', p_destination_identifier_count,
        '_norva', jsonb_build_object(
          'projection_applied', true,
          'disposition', 'transferred_out',
          'authority', 'revenuecat_destination_webhook'
        )
      ),
      clock_timestamp()
    )
    on conflict (provider, provider_event_id)
      where provider_event_id is not null
      do nothing;
    v_expired := v_expired + 1;
  end loop;

  insert into public.cloud_entitlement_events (
    user_id,
    provider,
    provider_event_id,
    event_type,
    payload,
    processed_at
  ) values (
    p_destination_user_id,
    'revenuecat',
    p_event_id,
    'TRANSFER',
    jsonb_build_object(
      'source_identifier_count', p_source_identifier_count,
      'destination_identifier_count', p_destination_identifier_count,
      'canonical_source_count', cardinality(v_sources),
      '_norva', jsonb_build_object(
        'projection_applied', true,
        'disposition', 'applied',
        'source_projections_expired', v_expired,
        'authority', 'revenuecat_customer_info_refetch'
      )
    ),
    clock_timestamp()
  )
  on conflict (provider, provider_event_id)
    where provider_event_id is not null
    do nothing;

  update public.cloud_revenuecat_transfer_events e
  set status = 'applied',
      reason = 'applied',
      authority_fingerprint = p_authority_fingerprint,
      source_expired_count = v_expired,
      applied_at = clock_timestamp(),
      last_seen_at = clock_timestamp()
  where e.event_id = p_event_id;

  return query select true, 'applied'::text, v_expired;
end
$function$;

revoke all on function public.quarantine_revenuecat_entitlement_transfer(
  text, timestamptz, text, text, uuid, uuid[], integer, integer
) from public, anon, authenticated;
revoke all on function public.apply_revenuecat_entitlement_transfer(
  text, timestamptz, text, text, uuid, uuid[], integer, integer, jsonb
) from public, anon, authenticated;

grant execute on function public.quarantine_revenuecat_entitlement_transfer(
  text, timestamptz, text, text, uuid, uuid[], integer, integer
) to service_role;
grant execute on function public.apply_revenuecat_entitlement_transfer(
  text, timestamptz, text, text, uuid, uuid[], integer, integer, jsonb
) to service_role;

comment on function public.quarantine_revenuecat_entitlement_transfer(
  text, timestamptz, text, text, uuid, uuid[], integer, integer
) is
  'Service-only, privacy-minimized and idempotent RevenueCat TRANSFER quarantine.';
comment on function public.apply_revenuecat_entitlement_transfer(
  text, timestamptz, text, text, uuid, uuid[], integer, integer, jsonb
) is
  'Atomically applies a freshly re-fetched RevenueCat destination entitlement and expires only older same-rail source projections.';

notify pgrst, 'reload schema';
