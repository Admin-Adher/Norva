-- RevenueCat TRANSFER post-hardening recovery state machine.
--
-- The receiver acknowledges a delivery only after this schema proves an
-- applied or policy-rejected terminal disposition. Retryable authority
-- failures and partially reconciled sources remain leaseable by the dedicated
-- worker. Only normalized environment/store and canonical Norva UUIDs are
-- retained; raw RevenueCat aliases and subscriber attributes never enter SQL.

alter table public.cloud_revenuecat_transfer_events
  add column if not exists environment text,
  add column if not exists store text,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists next_retry_at timestamptz,
  add column if not exists lease_worker_id text,
  add column if not exists lease_token_hash text,
  add column if not exists lease_until timestamptz,
  add column if not exists terminal_at timestamptz,
  add column if not exists source_absent_count smallint not null default 0,
  add column if not exists source_internal_preserved_count smallint not null default 0,
  add column if not exists source_hard_block_preserved_count smallint not null default 0,
  add column if not exists source_cross_rail_preserved_count smallint not null default 0,
  add column if not exists source_newer_pending_count smallint not null default 0,
  add column if not exists source_newer_preserved_count smallint not null default 0,
  add column if not exists source_equal_pending_count smallint not null default 0,
  add column if not exists partner_status text not null default 'not_required',
  add column if not exists partner_attempt_count integer not null default 0,
  add column if not exists partner_next_retry_at timestamptz,
  add column if not exists partner_lease_worker_id text,
  add column if not exists partner_lease_token_hash text,
  add column if not exists partner_lease_until timestamptz,
  add column if not exists partner_last_error_code text,
  add column if not exists partner_observed_at timestamptz;

alter table public.cloud_revenuecat_transfer_events
  drop constraint if exists revenuecat_transfer_status_check;
alter table public.cloud_revenuecat_transfer_events
  add constraint revenuecat_transfer_status_check
  check (status in ('quarantined', 'partial', 'rejected', 'applied', 'dead_letter'));

alter table public.cloud_revenuecat_transfer_events
  add constraint revenuecat_transfer_environment_check
  check (environment is null or environment in ('production', 'sandbox')),
  add constraint revenuecat_transfer_store_check
  check (
    store is null or store in (
      'amazon', 'app_store', 'mac_app_store', 'paddle', 'play_store',
      'rc_billing', 'roku', 'stripe'
    )
  ),
  add constraint revenuecat_transfer_attempt_count_check
  check (attempt_count between 0 and 1000000),
  add constraint revenuecat_transfer_lease_hash_check
  check (lease_token_hash is null or lease_token_hash ~ '^[0-9a-f]{64}$'),
  add constraint revenuecat_transfer_source_outcome_counts_check
  check (
    source_absent_count between 0 and 32
    and source_internal_preserved_count between 0 and 32
    and source_hard_block_preserved_count between 0 and 32
    and source_cross_rail_preserved_count between 0 and 32
    and source_newer_pending_count between 0 and 32
    and source_newer_preserved_count between 0 and 32
    and source_equal_pending_count between 0 and 32
  ),
  add constraint revenuecat_transfer_partner_status_check
  check (partner_status in ('not_required', 'pending', 'processing', 'succeeded', 'dead_letter')),
  add constraint revenuecat_transfer_partner_attempt_count_check
  check (partner_attempt_count between 0 and 1000000),
  add constraint revenuecat_transfer_partner_lease_hash_check
  check (
    partner_lease_token_hash is null
    or partner_lease_token_hash ~ '^[0-9a-f]{64}$'
  ),
  add constraint revenuecat_transfer_partner_error_check
  check (
    partner_last_error_code is null
    or partner_last_error_code ~ '^[a-z0-9_]{3,80}$'
  );

create index if not exists revenuecat_transfer_retry_due_idx
  on public.cloud_revenuecat_transfer_events (next_retry_at, first_seen_at)
  where status in ('quarantined', 'partial');
create index if not exists revenuecat_transfer_partner_due_idx
  on public.cloud_revenuecat_transfer_events (partner_next_retry_at, applied_at)
  where status = 'applied' and partner_status in ('pending', 'processing');
create index if not exists revenuecat_transfer_partner_dead_letter_idx
  on public.cloud_revenuecat_transfer_events (last_seen_at)
  where status = 'applied' and partner_status = 'dead_letter';
create index if not exists revenuecat_transfer_observability_status_seen_idx
  on public.cloud_revenuecat_transfer_events (status, first_seen_at)
  where status in ('partial', 'quarantined', 'dead_letter');

drop function if exists public.quarantine_revenuecat_entitlement_transfer(
  text, timestamptz, text, text, uuid, uuid[], integer, integer
);
drop function if exists public.apply_revenuecat_entitlement_transfer(
  text, timestamptz, text, text, uuid, uuid[], integer, integer, jsonb
);

create or replace function public.record_revenuecat_entitlement_transfer(
  p_event_id text,
  p_event_at timestamptz,
  p_payload_fingerprint text,
  p_reason text,
  p_destination_user_id uuid,
  p_source_user_ids uuid[],
  p_source_identifier_count integer,
  p_destination_identifier_count integer,
  p_environment text,
  p_store text,
  p_retryable boolean,
  p_count_delivery boolean default true
) returns table(
  transfer_status text,
  transfer_reason text,
  terminal boolean
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_existing public.cloud_revenuecat_transfer_events%rowtype;
  v_sources uuid[];
  v_environment text := lower(nullif(btrim(p_environment), ''));
  v_store text := lower(nullif(btrim(p_store), ''));
  v_status text;
begin
  if p_event_at is null
     or p_event_at > clock_timestamp() + interval '5 minutes'
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
  if v_environment is not null
     and v_environment not in ('production', 'sandbox') then
    raise exception 'invalid_revenuecat_transfer_environment';
  end if;
  if v_store is not null
     and v_store not in (
       'amazon', 'app_store', 'mac_app_store', 'paddle', 'play_store',
       'rc_billing', 'roku', 'stripe'
     ) then
    raise exception 'invalid_revenuecat_transfer_store';
  end if;

  select coalesce(array_agg(source_id order by source_id), '{}'::uuid[])
    into v_sources
  from (
    select distinct u.source_id
    from unnest(coalesce(p_source_user_ids, '{}'::uuid[])) as u(source_id)
    where u.source_id is not null
      and u.source_id is distinct from p_destination_user_id
  ) normalized;
  if cardinality(v_sources) > 32
     or cardinality(v_sources) > p_source_identifier_count then
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
    if v_existing.status in ('applied', 'rejected') then
      update public.cloud_revenuecat_transfer_events e
      set delivery_count = case
            when p_count_delivery then least(e.delivery_count + 1, 1000000)
            else e.delivery_count
          end,
          last_seen_at = clock_timestamp()
      where e.event_id = p_event_id
      returning e.status, e.reason, true
        into transfer_status, transfer_reason, terminal;
      return next;
      return;
    end if;

    v_status := case
      when p_retryable and v_existing.status = 'partial' then 'partial'
      when p_retryable then 'quarantined'
      else 'rejected'
    end;
    update public.cloud_revenuecat_transfer_events e
    set delivery_count = case
          when p_count_delivery then least(e.delivery_count + 1, 1000000)
          else e.delivery_count
        end,
        last_seen_at = clock_timestamp(),
        status = v_status,
        reason = p_reason,
        destination_user_id = coalesce(e.destination_user_id, p_destination_user_id),
        source_user_ids = case
          when cardinality(e.source_user_ids) = 0 then v_sources
          else e.source_user_ids
        end,
        source_identifier_count = p_source_identifier_count,
        destination_identifier_count = p_destination_identifier_count,
        environment = coalesce(e.environment, v_environment),
        store = coalesce(e.store, v_store),
        attempt_count = case
          when e.status = 'dead_letter' and p_retryable then 0
          else e.attempt_count
        end,
        next_retry_at = case
          when p_retryable then clock_timestamp() + interval '1 minute'
          else null
        end,
        lease_worker_id = null,
        lease_token_hash = null,
        lease_until = null,
        terminal_at = case when p_retryable then null else clock_timestamp() end
    where e.event_id = p_event_id
    returning e.status, e.reason, e.status in ('applied', 'rejected')
      into transfer_status, transfer_reason, terminal;
    return next;
    return;
  end if;

  v_status := case when p_retryable then 'quarantined' else 'rejected' end;
  insert into public.cloud_revenuecat_transfer_events (
    event_id,
    event_at,
    payload_fingerprint,
    destination_user_id,
    source_user_ids,
    source_identifier_count,
    destination_identifier_count,
    environment,
    store,
    status,
    reason,
    next_retry_at,
    terminal_at
  ) values (
    p_event_id,
    p_event_at,
    p_payload_fingerprint,
    p_destination_user_id,
    v_sources,
    p_source_identifier_count,
    p_destination_identifier_count,
    v_environment,
    v_store,
    v_status,
    p_reason,
    case when p_retryable then clock_timestamp() + interval '1 minute' end,
    case when not p_retryable then clock_timestamp() end
  )
  returning status, reason, status in ('applied', 'rejected')
    into transfer_status, transfer_reason, terminal;
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
  p_environment text,
  p_store text,
  p_patch jsonb
) returns table(
  terminal boolean,
  applied boolean,
  disposition text,
  source_expired_count integer,
  source_absent_count integer,
  source_internal_preserved_count integer,
  source_hard_block_preserved_count integer,
  source_cross_rail_preserved_count integer,
  source_newer_pending_count integer,
  source_newer_preserved_count integer,
  source_equal_pending_count integer
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_existing public.cloud_revenuecat_transfer_events%rowtype;
  v_destination_projection public.cloud_entitlement_projection%rowtype;
  v_destination_cursor public.cloud_revenuecat_projection_cursor%rowtype;
  v_destination_applied boolean := false;
  v_destination_confirmed boolean := false;
  v_destination_was_newer boolean := false;
  v_source_id uuid;
  v_source_projection public.cloud_entitlement_projection%rowtype;
  v_source_cursor public.cloud_revenuecat_projection_cursor%rowtype;
  v_sources uuid[];
  v_environment text := lower(nullif(btrim(p_environment), ''));
  v_store text := lower(nullif(btrim(p_store), ''));
  v_expired integer := 0;
  v_absent integer := 0;
  v_internal integer := 0;
  v_hard_block integer := 0;
  v_cross_rail integer := 0;
  v_newer_preserved integer := 0;
  v_equal_pending integer := 0;
  v_disposition text := 'applied';
  v_current_period_end timestamptz;
begin
  if p_event_at is null
     or p_event_at > clock_timestamp() + interval '5 minutes'
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
  if v_environment not in ('production', 'sandbox') then
    raise exception 'invalid_revenuecat_transfer_environment';
  end if;
  if v_store not in (
    'amazon', 'app_store', 'mac_app_store', 'paddle', 'play_store',
    'rc_billing', 'roku', 'stripe'
  ) then
    raise exception 'invalid_revenuecat_transfer_store';
  end if;
  if p_patch is null
     or jsonb_typeof(p_patch) <> 'object'
     or p_patch - array[
       'user_id', 'provider', 'provider_customer_id', 'plan_code', 'status',
       'limits', 'current_period_end', 'trial_ends_at', 'trial_consumed_at',
       'last_verified_at', 'last_event_at', 'fail_open_until', 'mrr_cents',
       'billing_currency', 'billing_product_id', 'billing_package_id',
       'bill_period', 'billing_terms_source'
     ]::text[] <> '{}'::jsonb
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

  v_current_period_end := nullif(
    p_patch->>'current_period_end',
    ''
  )::timestamptz;
  select coalesce(array_agg(source_id order by source_id), '{}'::uuid[])
    into v_sources
  from (
    select distinct u.source_id
    from unnest(coalesce(p_source_user_ids, '{}'::uuid[])) as u(source_id)
    where u.source_id is not null
      and u.source_id <> p_destination_user_id
  ) normalized;
  if cardinality(v_sources) > 32
     or cardinality(v_sources) > p_source_identifier_count then
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
  if found and v_existing.payload_fingerprint <> p_payload_fingerprint then
    raise exception 'revenuecat_transfer_event_conflict';
  end if;
  if found and v_existing.status in ('applied', 'rejected') then
    return query
    select
      true,
      v_existing.status = 'applied',
      v_existing.reason,
      v_existing.source_expired_count::integer,
      v_existing.source_absent_count::integer,
      v_existing.source_internal_preserved_count::integer,
      v_existing.source_hard_block_preserved_count::integer,
      v_existing.source_cross_rail_preserved_count::integer,
      v_existing.source_newer_pending_count::integer,
      v_existing.source_newer_preserved_count::integer,
      v_existing.source_equal_pending_count::integer;
    return;
  end if;

  if v_existing.event_id is null then
    perform public.record_revenuecat_entitlement_transfer(
      p_event_id,
      p_event_at,
      p_payload_fingerprint,
      'authority_verified',
      p_destination_user_id,
      v_sources,
      p_source_identifier_count,
      p_destination_identifier_count,
      v_environment,
      v_store,
      true,
      true
    );
  end if;

  -- Lock both sides in deterministic UUID order before reading either
  -- projection. Reciprocal account transfers cannot invert this lock order.
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

  if not exists (
    select 1 from auth.users u where u.id = p_destination_user_id
  ) then
    update public.cloud_revenuecat_transfer_events e
    set status = 'quarantined',
        reason = 'destination_user_not_found',
        authority_fingerprint = p_authority_fingerprint,
        next_retry_at = clock_timestamp() + interval '2 minutes',
        lease_worker_id = null,
        lease_token_hash = null,
        lease_until = null,
        terminal_at = null,
        last_seen_at = clock_timestamp()
    where e.event_id = p_event_id;
    return query select false, false, 'destination_user_not_found'::text,
      0, 0, 0, 0, 0, 0, 0, 0;
    return;
  end if;

  select p.*
    into v_destination_projection
  from public.cloud_entitlement_projection p
  where p.user_id = p_destination_user_id
  for update;
  select c.*
    into v_destination_cursor
  from public.cloud_revenuecat_projection_cursor c
  where c.user_id = p_destination_user_id
  for update;

  select r.applied
    into v_destination_applied
  from public.apply_revenuecat_entitlement_event(
    p_destination_user_id,
    p_event_at,
    p_event_id,
    p_patch
  ) r;
  v_destination_confirmed := coalesce(v_destination_applied, false);

  if not v_destination_confirmed then
    if public.norva_is_internal_account(p_destination_user_id) then
      v_disposition := 'destination_internal_account';
    elsif v_destination_projection.status in ('revoked', 'refunded', 'fraud') then
      v_disposition := 'destination_hard_blocked';
    elsif v_destination_projection.user_id is not null
      and lower(coalesce(v_destination_projection.provider, '')) not in (
        'revenuecat', 'google_play', 'apple_app_store', 'stripe', 'web'
      ) then
      v_disposition := 'destination_cross_rail_preserved';
    elsif v_destination_projection.user_id is not null
      and lower(coalesce(v_destination_projection.provider, '')) in (
        'revenuecat', 'google_play', 'apple_app_store', 'stripe', 'web'
      )
      and v_destination_projection.plan_code = p_patch->>'plan_code'
      and v_destination_projection.status = p_patch->>'status'
      and coalesce(
        v_destination_projection.current_period_end,
        '-infinity'::timestamptz
      ) >= v_current_period_end
      and (
        coalesce(v_destination_projection.last_event_at, '-infinity'::timestamptz)
          > p_event_at
        or coalesce(v_destination_cursor.last_event_at, '-infinity'::timestamptz)
          > p_event_at
        or (
          v_destination_cursor.last_event_at = p_event_at
          and v_destination_cursor.last_event_id = p_event_id
        )
      ) then
      -- A later same-rail lifecycle delivery has already projected an equal or
      -- stronger entitlement. Preserve its causal cursor, but clear stale money
      -- and stamp the freshly re-fetched transfer authority.
      update public.cloud_entitlement_projection p
      set provider_customer_id = p_destination_user_id::text,
          last_verified_at = coalesce(
            nullif(p_patch->>'last_verified_at', '')::timestamptz,
            clock_timestamp()
          ),
          fail_open_until = case
            when p_patch ? 'fail_open_until'
              then nullif(p_patch->>'fail_open_until', '')::timestamptz
            else p.fail_open_until
          end,
          mrr_cents = null,
          billing_currency = null,
          billing_product_id = nullif(p_patch->>'billing_product_id', ''),
          billing_package_id = null,
          bill_period = p_patch->>'bill_period',
          billing_terms_source = 'revenuecat_transfer_refetch'
      where p.user_id = p_destination_user_id;
      v_destination_confirmed := true;
      v_destination_was_newer := true;
      v_disposition := 'destination_already_current';
    else
      update public.cloud_revenuecat_transfer_events e
      set status = 'partial',
          reason = 'destination_authority_conflict',
          authority_fingerprint = p_authority_fingerprint,
          environment = v_environment,
          store = v_store,
          next_retry_at = clock_timestamp() + interval '2 minutes',
          lease_worker_id = null,
          lease_token_hash = null,
          lease_until = null,
          terminal_at = null,
          last_seen_at = clock_timestamp()
      where e.event_id = p_event_id;
      return query select false, false, 'destination_authority_conflict'::text,
        0, 0, 0, 0, 0, 0, 0, 0;
      return;
    end if;
  end if;

  if not v_destination_confirmed then
    update public.cloud_revenuecat_transfer_events e
    set status = 'rejected',
        reason = v_disposition,
        authority_fingerprint = p_authority_fingerprint,
        environment = v_environment,
        store = v_store,
        next_retry_at = null,
        lease_worker_id = null,
        lease_token_hash = null,
        lease_until = null,
        terminal_at = clock_timestamp(),
        last_seen_at = clock_timestamp(),
        partner_status = 'not_required'
    where e.event_id = p_event_id;

    insert into public.cloud_entitlement_events (
      user_id, provider, provider_event_id, event_type, payload, processed_at
    ) values (
      p_destination_user_id,
      'revenuecat',
      p_event_id,
      'TRANSFER',
      jsonb_build_object(
        'source_identifier_count', p_source_identifier_count,
        'destination_identifier_count', p_destination_identifier_count,
        'environment', v_environment,
        'store', v_store,
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
    return query select true, false, v_disposition,
      0, 0, 0, 0, 0, 0, 0, 0;
    return;
  end if;

  for v_source_id in select unnest(v_sources) order by 1
  loop
    select p.*
      into v_source_projection
    from public.cloud_entitlement_projection p
    where p.user_id = v_source_id
    for update;
    if not found then
      v_absent := v_absent + 1;
      continue;
    end if;
    if public.norva_is_internal_account(v_source_id) then
      v_internal := v_internal + 1;
      continue;
    end if;
    if v_source_projection.status in ('revoked', 'refunded', 'fraud') then
      v_hard_block := v_hard_block + 1;
      continue;
    end if;
    if lower(coalesce(v_source_projection.provider, '')) not in (
      'revenuecat', 'google_play', 'apple_app_store', 'stripe', 'web'
    ) then
      v_cross_rail := v_cross_rail + 1;
      continue;
    end if;
    if v_source_projection.status = 'expired' then
      -- The source already has no access. Whether that expiration predates the
      -- transfer or was delivered later, replaying TRANSFER must not resurrect
      -- it or keep the event permanently partial.
      v_expired := v_expired + 1;
      continue;
    end if;

    select c.*
      into v_source_cursor
    from public.cloud_revenuecat_projection_cursor c
    where c.user_id = v_source_id
    for update;
    if coalesce(
         v_source_projection.last_event_at,
         '-infinity'::timestamptz
       ) > p_event_at
       or coalesce(
         v_source_cursor.last_event_at,
         '-infinity'::timestamptz
       ) > p_event_at then
      -- A strictly later active lifecycle state is a post-transfer purchase or
      -- renewal. Preserve it as a terminal source outcome.
      v_newer_preserved := v_newer_preserved + 1;
      continue;
    end if;
    if coalesce(
         v_source_projection.last_event_at,
         '-infinity'::timestamptz
       ) = p_event_at
       or coalesce(
         v_source_cursor.last_event_at,
         '-infinity'::timestamptz
       ) = p_event_at then
      if (
        v_source_cursor.last_event_at = p_event_at
        and v_source_cursor.last_event_id = p_event_id
      ) is not true then
        -- Equal timestamps do not establish ordering. A different or
        -- inconsistent event remains explicitly visible for reconciliation.
        v_equal_pending := v_equal_pending + 1;
        continue;
      end if;
      -- The exact same TRANSFER cursor is an idempotent replay. Resume the
      -- source expiration below instead of treating it as a competing event.
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
      user_id, last_event_at, last_event_id, last_projection_applied, updated_at
    ) values (
      v_source_id, p_event_at, p_event_id, false, clock_timestamp()
    )
    on conflict (user_id) do update
    set last_event_at = excluded.last_event_at,
        last_event_id = excluded.last_event_id,
        last_projection_applied = false,
        updated_at = excluded.updated_at;

    insert into public.cloud_entitlement_events (
      user_id, provider, provider_event_id, event_type, payload, processed_at
    ) values (
      v_source_id,
      'revenuecat',
      left(p_event_id, 130) || ':' || left(p_payload_fingerprint, 16)
        || ':transfer-out:' || v_source_id::text,
      'TRANSFER_SOURCE_EXPIRED',
      jsonb_build_object(
        'source_identifier_count', p_source_identifier_count,
        'destination_identifier_count', p_destination_identifier_count,
        'environment', v_environment,
        'store', v_store,
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

  if v_equal_pending > 0 then
    update public.cloud_revenuecat_transfer_events e
    set status = 'partial',
        reason = 'source_equal_timestamp_requires_reconciliation',
        authority_fingerprint = p_authority_fingerprint,
        environment = v_environment,
        store = v_store,
        source_expired_count = v_expired,
        source_absent_count = v_absent,
        source_internal_preserved_count = v_internal,
        source_hard_block_preserved_count = v_hard_block,
        source_cross_rail_preserved_count = v_cross_rail,
        source_newer_pending_count = v_equal_pending,
        source_newer_preserved_count = v_newer_preserved,
        source_equal_pending_count = v_equal_pending,
        next_retry_at = clock_timestamp() + interval '2 minutes',
        lease_worker_id = null,
        lease_token_hash = null,
        lease_until = null,
        terminal_at = null,
        last_seen_at = clock_timestamp()
    where e.event_id = p_event_id;
    return query
    select false, false,
      'source_equal_timestamp_requires_reconciliation'::text,
      v_expired, v_absent, v_internal, v_hard_block, v_cross_rail,
      v_equal_pending, v_newer_preserved, v_equal_pending;
    return;
  end if;

  if v_newer_preserved > 0 then
    v_disposition := case
      when v_destination_was_newer
        then 'applied_newer_destination_with_post_transfer_sources'
      else 'applied_with_post_transfer_sources'
    end;
  elsif v_internal + v_hard_block + v_cross_rail > 0 then
    v_disposition := case
      when v_destination_was_newer then 'applied_newer_destination_with_preserved_sources'
      else 'applied_with_preserved_sources'
    end;
  elsif v_destination_was_newer then
    v_disposition := 'applied_destination_already_current';
  else
    v_disposition := 'applied';
  end if;

  insert into public.cloud_entitlement_events (
    user_id, provider, provider_event_id, event_type, payload, processed_at
  ) values (
    p_destination_user_id,
    'revenuecat',
    p_event_id,
    'TRANSFER',
    jsonb_build_object(
      'source_identifier_count', p_source_identifier_count,
      'destination_identifier_count', p_destination_identifier_count,
      'canonical_source_count', cardinality(v_sources),
      'environment', v_environment,
      'store', v_store,
      '_norva', jsonb_build_object(
        'projection_applied', true,
        'disposition', v_disposition,
        'source_projections_expired', v_expired,
        'source_absent', v_absent,
        'source_internal_preserved', v_internal,
        'source_hard_block_preserved', v_hard_block,
        'source_cross_rail_preserved', v_cross_rail,
        'source_newer_preserved', v_newer_preserved,
        'source_equal_pending', 0,
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
      reason = v_disposition,
      authority_fingerprint = p_authority_fingerprint,
      environment = v_environment,
      store = v_store,
      source_expired_count = v_expired,
      source_absent_count = v_absent,
      source_internal_preserved_count = v_internal,
      source_hard_block_preserved_count = v_hard_block,
      source_cross_rail_preserved_count = v_cross_rail,
      source_newer_pending_count = 0,
      source_newer_preserved_count = v_newer_preserved,
      source_equal_pending_count = 0,
      next_retry_at = null,
      lease_worker_id = null,
      lease_token_hash = null,
      lease_until = null,
      terminal_at = clock_timestamp(),
      applied_at = clock_timestamp(),
      last_seen_at = clock_timestamp(),
      partner_status = case
        when e.partner_status = 'succeeded' then 'succeeded'
        else 'pending'
      end,
      partner_next_retry_at = case
        when e.partner_status = 'succeeded' then null
        else clock_timestamp()
      end
  where e.event_id = p_event_id;

  return query
  select true, true, v_disposition,
    v_expired, v_absent, v_internal, v_hard_block, v_cross_rail,
    0, v_newer_preserved, 0;
end
$function$;

create or replace function public.revenuecat_transfer_retry_jobs_lease(
  p_worker_id text,
  p_lease_token_hash text,
  p_batch_size integer default 4,
  p_lease_seconds integer default 120
) returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_result jsonb;
  v_dead_letter_moved integer := 0;
begin
  if p_worker_id is null
     or p_worker_id !~ '^revenuecat-transfer-worker:[0-9a-f-]{36}$'
     or p_lease_token_hash is null
     or p_lease_token_hash !~ '^[0-9a-f]{64}$'
     or p_batch_size not between 1 and 50
     or p_lease_seconds not between 30 and 300 then
    raise exception 'invalid_revenuecat_transfer_lease';
  end if;

  with exhausted as (
    select e.event_id
    from public.cloud_revenuecat_transfer_events e
    where e.status in ('quarantined', 'partial')
      and e.attempt_count >= 12
      and (e.lease_until is null or e.lease_until < v_now)
    order by coalesce(e.next_retry_at, e.first_seen_at), e.first_seen_at
    for update skip locked
    limit p_batch_size
  )
  update public.cloud_revenuecat_transfer_events e
  set status = 'dead_letter',
      reason = 'retry_exhausted',
      next_retry_at = null,
      lease_worker_id = null,
      lease_token_hash = null,
      lease_until = null,
      terminal_at = coalesce(e.terminal_at, v_now),
      last_seen_at = v_now
  from exhausted x
  where e.event_id = x.event_id;
  get diagnostics v_dead_letter_moved = row_count;

  with candidates as (
    select e.event_id
    from public.cloud_revenuecat_transfer_events e
    where e.status in ('quarantined', 'partial')
      and e.attempt_count < 12
      and coalesce(e.next_retry_at, e.first_seen_at) <= v_now
      and (e.lease_until is null or e.lease_until < v_now)
    order by coalesce(e.next_retry_at, e.first_seen_at), e.first_seen_at
    for update skip locked
    limit p_batch_size
  ), leased as (
    update public.cloud_revenuecat_transfer_events e
    set lease_worker_id = p_worker_id,
        lease_token_hash = p_lease_token_hash,
        lease_until = v_now + make_interval(secs => p_lease_seconds),
        attempt_count = e.attempt_count + 1,
        last_seen_at = v_now
    from candidates c
    where e.event_id = c.event_id
    returning
      e.event_id,
      e.event_at,
      e.payload_fingerprint,
      e.destination_user_id,
      e.source_user_ids,
      e.source_identifier_count,
      e.destination_identifier_count,
      e.environment,
      e.store,
      e.status,
      e.attempt_count
  )
  select jsonb_build_object(
    'schema_version', 1,
    'leased_until', v_now + make_interval(secs => p_lease_seconds),
    'dead_letter_moved', v_dead_letter_moved,
    'jobs', coalesce(jsonb_agg(to_jsonb(leased) order by leased.event_at), '[]'::jsonb)
  )
  into v_result
  from leased;
  return v_result;
end
$function$;

create or replace function public.revenuecat_transfer_retry_job_complete(
  p_event_id text,
  p_worker_id text,
  p_lease_token_hash text,
  p_error_code text,
  p_retry_after_seconds integer default null
) returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_row public.cloud_revenuecat_transfer_events%rowtype;
  v_now timestamptz := clock_timestamp();
  v_status text;
  v_delay integer;
begin
  if p_event_id is null
     or p_worker_id is null
     or p_lease_token_hash is null
     or p_lease_token_hash !~ '^[0-9a-f]{64}$'
     or p_error_code is null
     or p_error_code !~ '^[a-z0-9_]{3,80}$'
     or (
       p_retry_after_seconds is not null
       and p_retry_after_seconds not between 1 and 21600
     ) then
    raise exception 'invalid_revenuecat_transfer_retry_completion';
  end if;
  select *
    into v_row
  from public.cloud_revenuecat_transfer_events e
  where e.event_id = p_event_id
  for update;
  if not found
     or v_row.lease_worker_id is distinct from p_worker_id
     or v_row.lease_token_hash is distinct from p_lease_token_hash
     or v_row.lease_until < v_now then
    raise exception 'revenuecat_transfer_lease_lost';
  end if;
  if v_row.status in ('applied', 'rejected') then
    return jsonb_build_object(
      'schema_version', 1,
      'event_id', p_event_id,
      'status', v_row.status
    );
  end if;

  v_status := case when v_row.attempt_count >= 12 then 'dead_letter'
    when v_row.status = 'partial' then 'partial'
    else 'quarantined'
  end;
  v_delay := coalesce(
    p_retry_after_seconds,
    least(21600, 60 * (2 ^ least(v_row.attempt_count, 8))::integer)
  );
  update public.cloud_revenuecat_transfer_events e
  set status = v_status,
      reason = case when v_status = 'dead_letter' then 'retry_exhausted'
        else p_error_code end,
      next_retry_at = case when v_status = 'dead_letter' then null
        else v_now + make_interval(secs => v_delay) end,
      lease_worker_id = null,
      lease_token_hash = null,
      lease_until = null,
      terminal_at = case
        when v_status = 'dead_letter' then coalesce(e.terminal_at, v_now)
        else null
      end,
      last_seen_at = v_now
  where e.event_id = p_event_id;
  return jsonb_build_object(
    'schema_version', 1,
    'event_id', p_event_id,
    'status', v_status,
    'next_retry_at', case when v_status = 'dead_letter' then null
      else v_now + make_interval(secs => v_delay) end
  );
end
$function$;

create or replace function public.revenuecat_transfer_retry_job_defer(
  p_event_id text,
  p_worker_id text,
  p_lease_token_hash text,
  p_error_code text,
  p_retry_after_seconds integer default null
) returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_row public.cloud_revenuecat_transfer_events%rowtype;
  v_now timestamptz := clock_timestamp();
  v_delay integer;
begin
  if p_event_id is null
     or p_worker_id is null
     or p_lease_token_hash is null
     or p_lease_token_hash !~ '^[0-9a-f]{64}$'
     or p_error_code is null
     or p_error_code !~ '^[a-z0-9_]{3,80}$'
     or (
       p_retry_after_seconds is not null
       and p_retry_after_seconds not between 1 and 21600
     ) then
    raise exception 'invalid_revenuecat_transfer_retry_defer';
  end if;
  select *
    into v_row
  from public.cloud_revenuecat_transfer_events e
  where e.event_id = p_event_id
  for update;
  if not found
     or v_row.lease_worker_id is distinct from p_worker_id
     or v_row.lease_token_hash is distinct from p_lease_token_hash
     or v_row.lease_until < v_now then
    raise exception 'revenuecat_transfer_lease_lost';
  end if;
  if v_row.status not in ('quarantined', 'partial') then
    raise exception 'revenuecat_transfer_not_deferable';
  end if;

  v_delay := coalesce(p_retry_after_seconds, 60);
  update public.cloud_revenuecat_transfer_events e
  set attempt_count = greatest(0, e.attempt_count - 1),
      reason = p_error_code,
      next_retry_at = v_now + make_interval(secs => v_delay),
      lease_worker_id = null,
      lease_token_hash = null,
      lease_until = null,
      last_seen_at = v_now
  where e.event_id = p_event_id;
  return jsonb_build_object(
    'schema_version', 1,
    'event_id', p_event_id,
    'status', v_row.status,
    'next_retry_at', v_now + make_interval(secs => v_delay)
  );
end
$function$;

create or replace function public.revenuecat_transfer_partner_jobs_lease(
  p_worker_id text,
  p_lease_token_hash text,
  p_batch_size integer default 4,
  p_lease_seconds integer default 120
) returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_result jsonb;
  v_dead_letter_moved integer := 0;
begin
  if p_worker_id is null
     or p_worker_id !~ '^revenuecat-transfer-worker:[0-9a-f-]{36}$'
     or p_lease_token_hash is null
     or p_lease_token_hash !~ '^[0-9a-f]{64}$'
     or p_batch_size not between 1 and 50
     or p_lease_seconds not between 30 and 300 then
    raise exception 'invalid_revenuecat_transfer_partner_lease';
  end if;

  with exhausted as (
    select e.event_id
    from public.cloud_revenuecat_transfer_events e
    where e.status = 'applied'
      and e.partner_status in ('pending', 'processing')
      and e.partner_attempt_count >= 12
      and (
        e.partner_lease_until is null
        or e.partner_lease_until < v_now
      )
    order by coalesce(e.partner_next_retry_at, e.applied_at), e.applied_at
    for update skip locked
    limit p_batch_size
  )
  update public.cloud_revenuecat_transfer_events e
  set partner_status = 'dead_letter',
      partner_next_retry_at = null,
      partner_lease_worker_id = null,
      partner_lease_token_hash = null,
      partner_lease_until = null,
      partner_last_error_code = coalesce(
        e.partner_last_error_code,
        'partner_retry_exhausted'
      ),
      last_seen_at = v_now
  from exhausted x
  where e.event_id = x.event_id;
  get diagnostics v_dead_letter_moved = row_count;

  with candidates as (
    select e.event_id
    from public.cloud_revenuecat_transfer_events e
    where e.status = 'applied'
      and e.partner_status in ('pending', 'processing')
      and e.partner_attempt_count < 12
      and coalesce(e.partner_next_retry_at, e.applied_at) <= v_now
      and (e.partner_lease_until is null or e.partner_lease_until < v_now)
    order by coalesce(e.partner_next_retry_at, e.applied_at), e.applied_at
    for update skip locked
    limit p_batch_size
  ), leased as (
    update public.cloud_revenuecat_transfer_events e
    set partner_status = 'processing',
        partner_lease_worker_id = p_worker_id,
        partner_lease_token_hash = p_lease_token_hash,
        partner_lease_until = v_now + make_interval(secs => p_lease_seconds),
        partner_attempt_count = e.partner_attempt_count + 1,
        last_seen_at = v_now
    from candidates c
    where e.event_id = c.event_id
    returning
      e.event_id,
      e.event_at,
      e.destination_user_id,
      e.environment,
      e.store,
      e.partner_attempt_count
  )
  select jsonb_build_object(
    'schema_version', 1,
    'leased_until', v_now + make_interval(secs => p_lease_seconds),
    'partner_dead_letter_moved', v_dead_letter_moved,
    'jobs', coalesce(jsonb_agg(to_jsonb(leased) order by leased.event_at), '[]'::jsonb)
  )
  into v_result
  from leased;
  return v_result;
end
$function$;

create or replace function public.revenuecat_transfer_partner_job_complete(
  p_event_id text,
  p_worker_id text,
  p_lease_token_hash text,
  p_outcome text,
  p_error_code text default null
) returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_row public.cloud_revenuecat_transfer_events%rowtype;
  v_now timestamptz := clock_timestamp();
  v_status text;
  v_delay integer;
begin
  if p_event_id is null
     or p_worker_id is null
     or p_lease_token_hash is null
     or p_lease_token_hash !~ '^[0-9a-f]{64}$'
     or p_outcome not in ('succeeded', 'retry')
     or (
       p_outcome = 'retry'
       and (p_error_code is null or p_error_code !~ '^[a-z0-9_]{3,80}$')
     ) then
    raise exception 'invalid_revenuecat_transfer_partner_completion';
  end if;
  select *
    into v_row
  from public.cloud_revenuecat_transfer_events e
  where e.event_id = p_event_id
  for update;
  if not found
     or v_row.partner_lease_worker_id is distinct from p_worker_id
     or v_row.partner_lease_token_hash is distinct from p_lease_token_hash
     or v_row.partner_lease_until < v_now then
    raise exception 'revenuecat_transfer_partner_lease_lost';
  end if;

  if p_outcome = 'succeeded' then
    update public.cloud_revenuecat_transfer_events e
    set partner_status = 'succeeded',
        partner_next_retry_at = null,
        partner_lease_worker_id = null,
        partner_lease_token_hash = null,
        partner_lease_until = null,
        partner_last_error_code = null,
        partner_observed_at = v_now,
        last_seen_at = v_now
    where e.event_id = p_event_id;
    v_status := 'succeeded';
  else
    v_status := case when v_row.partner_attempt_count >= 12
      then 'dead_letter' else 'pending' end;
    v_delay := least(
      21600,
      60 * (2 ^ least(v_row.partner_attempt_count, 8))::integer
    );
    update public.cloud_revenuecat_transfer_events e
    set partner_status = v_status,
        partner_next_retry_at = case when v_status = 'dead_letter' then null
          else v_now + make_interval(secs => v_delay) end,
        partner_lease_worker_id = null,
        partner_lease_token_hash = null,
        partner_lease_until = null,
        partner_last_error_code = p_error_code,
        last_seen_at = v_now
    where e.event_id = p_event_id;
  end if;
  return jsonb_build_object(
    'schema_version', 1,
    'event_id', p_event_id,
    'status', v_status
  );
end
$function$;

revoke all on function public.record_revenuecat_entitlement_transfer(
  text, timestamptz, text, text, uuid, uuid[], integer, integer, text, text,
  boolean, boolean
) from public, anon, authenticated;
revoke all on function public.apply_revenuecat_entitlement_transfer(
  text, timestamptz, text, text, uuid, uuid[], integer, integer, text, text, jsonb
) from public, anon, authenticated;
revoke all on function public.revenuecat_transfer_retry_jobs_lease(
  text, text, integer, integer
) from public, anon, authenticated;
revoke all on function public.revenuecat_transfer_retry_job_complete(
  text, text, text, text, integer
) from public, anon, authenticated;
revoke all on function public.revenuecat_transfer_retry_job_defer(
  text, text, text, text, integer
) from public, anon, authenticated;
revoke all on function public.revenuecat_transfer_partner_jobs_lease(
  text, text, integer, integer
) from public, anon, authenticated;
revoke all on function public.revenuecat_transfer_partner_job_complete(
  text, text, text, text, text
) from public, anon, authenticated;

grant execute on function public.record_revenuecat_entitlement_transfer(
  text, timestamptz, text, text, uuid, uuid[], integer, integer, text, text,
  boolean, boolean
) to service_role;
grant execute on function public.apply_revenuecat_entitlement_transfer(
  text, timestamptz, text, text, uuid, uuid[], integer, integer, text, text, jsonb
) to service_role;
grant execute on function public.revenuecat_transfer_retry_jobs_lease(
  text, text, integer, integer
) to service_role;
grant execute on function public.revenuecat_transfer_retry_job_complete(
  text, text, text, text, integer
) to service_role;
grant execute on function public.revenuecat_transfer_retry_job_defer(
  text, text, text, text, integer
) to service_role;
grant execute on function public.revenuecat_transfer_partner_jobs_lease(
  text, text, integer, integer
) to service_role;
grant execute on function public.revenuecat_transfer_partner_job_complete(
  text, text, text, text, text
) to service_role;

comment on function public.record_revenuecat_entitlement_transfer(
  text, timestamptz, text, text, uuid, uuid[], integer, integer, text, text,
  boolean, boolean
) is
  'Records a privacy-minimized retryable or terminal RevenueCat TRANSFER delivery; service role only.';
comment on function public.apply_revenuecat_entitlement_transfer(
  text, timestamptz, text, text, uuid, uuid[], integer, integer, text, text, jsonb
) is
  'Atomically confirms a fresh destination authority, reconciles every source outcome and returns terminal=false for partial work.';
comment on function public.revenuecat_transfer_retry_job_defer(
  text, text, text, text, integer
) is
  'Releases an unattempted TRANSFER job after a batch circuit break without consuming its retry budget.';

alter table affiliate_private.affiliate_worker_heartbeats
  drop constraint if exists affiliate_worker_heartbeats_name;
alter table affiliate_private.affiliate_worker_heartbeats
  add constraint affiliate_worker_heartbeats_name
  check (
    worker_name in (
      'commission',
      'correction',
      'maturation',
      'reconciliation',
      'payout',
      'revenuecat_transfer'
    )
  );

create or replace function affiliate_private.partners_worker_heartbeat(
  p_worker_name text,
  p_status text,
  p_details jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_worker text := lower(btrim(coalesce(p_worker_name, '')));
  v_status text := lower(btrim(coalesce(p_status, '')));
  v_details jsonb := coalesce(p_details, '{}'::jsonb);
begin
  if v_worker not in (
    'commission',
    'correction',
    'maturation',
    'reconciliation',
    'payout',
    'revenuecat_transfer'
  )
    or v_status not in ('healthy', 'degraded', 'blocked')
    or jsonb_typeof(v_details) <> 'object'
    or v_details ?| array[
      'email', 'token', 'secret', 'payload', 'user_id', 'account_id'
    ]::text[]
  then
    raise exception 'invalid worker heartbeat'
      using errcode = '22023';
  end if;
  insert into affiliate_private.affiliate_worker_heartbeats (
    worker_name,
    status,
    last_seen_at,
    details,
    updated_at
  )
  values (v_worker, v_status, now(), v_details, now())
  on conflict (worker_name) do update
  set
    status = excluded.status,
    last_seen_at = excluded.last_seen_at,
    details = excluded.details,
    updated_at = now();
  return jsonb_build_object(
    'schema_version', 1,
    'action', 'worker_heartbeat_recorded',
    'worker', v_worker,
    'status', v_status
  );
end;
$$;

create or replace function affiliate_private.partners_ops_alert_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_workers jsonb;
  v_alerts jsonb;
  v_kyc_used bigint;
begin
  with expected(worker_name) as (
    values
      ('commission'::text),
      ('correction'::text),
      ('maturation'::text),
      ('reconciliation'::text),
      ('payout'::text),
      ('revenuecat_transfer'::text)
  )
  select jsonb_agg(
    jsonb_build_object(
      'worker', e.worker_name,
      'status', case
        when h.worker_name is null then 'not_configured'
        when h.last_seen_at < now() - interval '15 minutes' then 'stale'
        else h.status
      end,
      'last_seen_at', h.last_seen_at
    )
    order by e.worker_name
  )
  into v_workers
  from expected e
  left join affiliate_private.affiliate_worker_heartbeats h
    on h.worker_name = e.worker_name;

  select count(*)
  into v_kyc_used
  from affiliate_private.affiliate_kyc_sessions
  where created_at >= now() - interval '30 days';

  with alerts as (
    select
      'commission_dead_letter'::text as code,
      'critical'::text as severity,
      count(*)::bigint as count
    from affiliate_private.affiliate_commission_jobs
    where status = 'dead_letter'
    having count(*) > 0
    union all
    select
      'chargeback_reversal_dead_letter',
      'critical',
      count(*)::bigint
    from affiliate_private.affiliate_revolut_dispute_won_jobs
    where status = 'dead_letter'
    having count(*) > 0
    union all
    select
      'chargeback_reversal_conflict',
      'critical',
      count(*)::bigint
    from affiliate_private.affiliate_revolut_dispute_won_conflicts
    having count(*) > 0
    union all
    select
      'maturation_dead_letter',
      'critical',
      count(*)::bigint
    from affiliate_private.affiliate_maturation_jobs
    where status = 'dead_letter'
    having count(*) > 0
    union all
    select
      'financial_fact_conflict',
      'critical',
      count(*)::bigint
    from affiliate_private.affiliate_financial_fact_conflicts
    having count(*) > 0
    union all
    select
      'financial_transfer_quarantined_recent',
      'warning',
      count(*)::bigint
    from affiliate_private.affiliate_financial_facts
    where event_type = 'transfer'
      and facts_status = 'quarantined'
      and created_at >= now() - interval '24 hours'
    having count(*) > 0
    union all
    select
      'revenuecat_transfer_dead_letter',
      'critical',
      count(*)::bigint
    from (
      select 1
      from public.cloud_revenuecat_transfer_events
      where status = 'dead_letter'
      limit 1000000
    ) bounded
    having count(*) > 0
    union all
    select
      'revenuecat_transfer_partial_aged',
      'warning',
      count(*)::bigint
    from (
      select 1
      from public.cloud_revenuecat_transfer_events
      where status = 'partial'
        and first_seen_at < now() - interval '15 minutes'
      limit 1000000
    ) bounded
    having count(*) > 0
    union all
    select
      'revenuecat_transfer_quarantined_aged',
      'warning',
      count(*)::bigint
    from (
      select 1
      from public.cloud_revenuecat_transfer_events
      where status = 'quarantined'
        and first_seen_at < now() - interval '15 minutes'
      limit 1000000
    ) bounded
    having count(*) > 0
    union all
    select
      'revenuecat_transfer_partner_dead_letter',
      'critical',
      count(*)::bigint
    from (
      select 1
      from public.cloud_revenuecat_transfer_events
      where status = 'applied'
        and partner_status = 'dead_letter'
      limit 1000000
    ) bounded
    having count(*) > 0
    union all
    select
      'shadow_reconciliation_mismatch',
      'critical',
      r.mismatch_count
    from affiliate_private.affiliate_shadow_reconciliation_runs r
    where r.id = (
      select latest.id
      from affiliate_private.affiliate_shadow_reconciliation_runs latest
      order by latest.created_at desc
      limit 1
    )
      and r.status = 'mismatch'
    union all
    select
      'kyc_quota_warning',
      case when v_kyc_used >= 500 then 'critical' else 'warning' end,
      v_kyc_used
    where v_kyc_used >= 400
    union all
    select
      'worker_heartbeat_missing',
      'critical',
      count(*)::bigint
    from (
      values
        ('commission'::text),
        ('correction'::text),
        ('maturation'::text),
        ('reconciliation'::text),
        ('payout'::text),
        ('revenuecat_transfer'::text)
    ) expected(worker_name)
    left join affiliate_private.affiliate_worker_heartbeats h
      on h.worker_name = expected.worker_name
      and h.last_seen_at >= now() - interval '15 minutes'
    where h.worker_name is null
    having count(*) > 0
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'code', a.code,
        'severity', a.severity,
        'count', a.count
      )
      order by a.severity, a.code
    ),
    '[]'::jsonb
  )
  into v_alerts
  from alerts a;

  return jsonb_build_object(
    'schema_version', 1,
    'workers', v_workers,
    'alerts', v_alerts,
    'kyc_quota', jsonb_build_object(
      'used', v_kyc_used,
      'informational_limit', 500,
      'blocking', false
    )
  );
end;
$$;

notify pgrst, 'reload schema';
