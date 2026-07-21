-- RevenueCat webhook deliveries are at-least-once and may arrive out of order.
-- Apply the entitlement cache with a database-side causal compare-and-set so an
-- old cancellation/expiration can never overwrite a newer renewal.

-- RevenueCat has its own causal clock. Do not compare its event timestamps with
-- cloud_entitlement_projection.last_event_at, which is also written by Revolut,
-- manual grants and lifecycle jobs.
create table if not exists public.cloud_revenuecat_projection_cursor (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_event_at timestamptz not null,
  last_event_id text not null,
  last_projection_applied boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.cloud_revenuecat_projection_cursor
  add column if not exists last_projection_applied boolean not null default false;

alter table public.cloud_revenuecat_projection_cursor enable row level security;
revoke all on table public.cloud_revenuecat_projection_cursor from public, anon, authenticated;
grant all on table public.cloud_revenuecat_projection_cursor to service_role;

create or replace function public.apply_revenuecat_entitlement_event(
  p_user_id uuid,
  p_event_at timestamptz,
  p_event_id text,
  p_patch jsonb
) returns table(
  applied boolean,
  projection_last_event_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_last_event_at timestamptz;
  v_cursor public.cloud_revenuecat_projection_cursor%rowtype;
  v_projection_applied boolean := false;
begin
  if p_user_id is null or p_event_at is null or nullif(btrim(p_event_id), '') is null then
    raise exception 'RevenueCat user_id, event_at and event_id are required';
  end if;
  if coalesce(p_patch->>'plan_code', '') not in ('plus', 'family') then
    raise exception 'RevenueCat projection requires an explicit store plan';
  end if;
  if coalesce(p_patch->>'status', '') not in (
    'trialing', 'active', 'grace', 'past_due', 'cancelled_at_period_end',
    'expired', 'revoked', 'refunded', 'fraud', 'unknown'
  ) then
    raise exception 'invalid RevenueCat entitlement status';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('norva:revenuecat:' || p_user_id::text, 0));
  select * into v_cursor
  from public.cloud_revenuecat_projection_cursor c
  where c.user_id = p_user_id
  for update;

  -- An exact retry must reproduce the result of its first projection attempt.
  -- Otherwise a failure after this RPC (for example while writing the payment
  -- ledger) could make the retry journal an applied activation as not applied.
  if found and p_event_id = v_cursor.last_event_id then
    select p.last_event_at into v_last_event_at
    from public.cloud_entitlement_projection p
    where p.user_id = p_user_id;
    return query select v_cursor.last_projection_applied, v_last_event_at;
    return;
  end if;

  -- Delayed events are acknowledged without touching the shared projection.
  -- Equal timestamps are one causal point; the first distinct event wins, while
  -- the immutable event table still retains every distinct id.
  if found and p_event_at <= v_cursor.last_event_at then
    select p.last_event_at into v_last_event_at
    from public.cloud_entitlement_projection p
    where p.user_id = p_user_id;
    return query select false, v_last_event_at;
    return;
  end if;

  insert into public.cloud_entitlement_projection as current_projection (
    user_id,
    provider,
    provider_customer_id,
    plan_code,
    status,
    limits,
    current_period_end,
    trial_ends_at,
    trial_consumed_at,
    last_verified_at,
    last_event_at,
    fail_open_until,
    country_code,
    country_source,
    mrr_cents,
    bill_period
  ) values (
    p_user_id,
    coalesce(nullif(p_patch->>'provider', ''), 'revenuecat'),
    nullif(p_patch->>'provider_customer_id', ''),
    p_patch->>'plan_code',
    p_patch->>'status',
    coalesce(p_patch->'limits', '{}'::jsonb),
    nullif(p_patch->>'current_period_end', '')::timestamptz,
    nullif(p_patch->>'trial_ends_at', '')::timestamptz,
    nullif(p_patch->>'trial_consumed_at', '')::timestamptz,
    coalesce(nullif(p_patch->>'last_verified_at', '')::timestamptz, clock_timestamp()),
    p_event_at,
    nullif(p_patch->>'fail_open_until', '')::timestamptz,
    nullif(p_patch->>'country_code', ''),
    nullif(p_patch->>'country_source', ''),
    nullif(p_patch->>'mrr_cents', '')::integer,
    nullif(p_patch->>'bill_period', '')
  )
  on conflict (user_id) do update
  set provider = excluded.provider,
      provider_customer_id = excluded.provider_customer_id,
      plan_code = excluded.plan_code,
      status = excluded.status,
      limits = excluded.limits,
      current_period_end = case
        when p_patch ? 'current_period_end' then excluded.current_period_end
        else current_projection.current_period_end
      end,
      trial_ends_at = case
        when p_patch ? 'trial_ends_at' then excluded.trial_ends_at
        else current_projection.trial_ends_at
      end,
      trial_consumed_at = case
        when p_patch ? 'trial_consumed_at' then excluded.trial_consumed_at
        else current_projection.trial_consumed_at
      end,
      last_verified_at = excluded.last_verified_at,
      last_event_at = excluded.last_event_at,
      fail_open_until = case
        when p_patch ? 'fail_open_until' then excluded.fail_open_until
        else current_projection.fail_open_until
      end,
      country_code = case
        when p_patch ? 'country_code' then excluded.country_code
        else current_projection.country_code
      end,
      country_source = case
        when p_patch ? 'country_source' then excluded.country_source
        else current_projection.country_source
      end,
      mrr_cents = case
        when p_patch ? 'mrr_cents' then excluded.mrr_cents
        else current_projection.mrr_cents
      end,
      bill_period = case
        when p_patch ? 'bill_period' then excluded.bill_period
        else current_projection.bill_period
      end
  -- Causality was already validated against the RevenueCat cursor above; the
  -- cursor is advanced below after this explicit cross-rail ownership policy.
  where (
    -- RevenueCat/store events may freely evolve a projection already owned by
    -- that rail. They must never cancel or downgrade a live Revolut/manual/system
    -- entitlement merely because their delivery timestamp is newer.
    lower(coalesce(current_projection.provider, '')) in (
      'revenuecat', 'google_play', 'apple_app_store', 'stripe', 'web'
    )
    or (
      excluded.status in ('trialing', 'active')
      and current_projection.status not in ('fraud', 'revoked')
      and (
        current_projection.status = 'expired'
        or (
          current_projection.current_period_end is not null
          or current_projection.trial_ends_at is not null
          or current_projection.fail_open_until is not null
        )
        and greatest(
          coalesce(current_projection.current_period_end, '-infinity'::timestamptz),
          coalesce(current_projection.trial_ends_at, '-infinity'::timestamptz),
          coalesce(current_projection.fail_open_until, '-infinity'::timestamptz)
        ) <= p_event_at
      )
    )
  )
  returning current_projection.last_event_at into v_last_event_at;

  v_projection_applied := found;
  if not v_projection_applied then
    select p.last_event_at into v_last_event_at
    from public.cloud_entitlement_projection p
    where p.user_id = p_user_id;
  end if;

  -- Advance the RevenueCat causal clock even when the explicit cross-rail policy
  -- rejects this projection, and remember that outcome for an exact delivery
  -- retry. The advisory lock serializes the no-row cursor creation path.
  insert into public.cloud_revenuecat_projection_cursor as c (
    user_id, last_event_at, last_event_id, last_projection_applied, updated_at
  ) values (
    p_user_id, p_event_at, p_event_id, v_projection_applied, clock_timestamp()
  )
  on conflict (user_id) do update
  set last_event_at = excluded.last_event_at,
      last_event_id = excluded.last_event_id,
      last_projection_applied = excluded.last_projection_applied,
      updated_at = excluded.updated_at;

  return query select v_projection_applied, v_last_event_at;
end
$function$;

revoke all on function public.apply_revenuecat_entitlement_event(uuid, timestamptz, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.apply_revenuecat_entitlement_event(uuid, timestamptz, text, jsonb)
  to service_role;

comment on function public.apply_revenuecat_entitlement_event(uuid, timestamptz, text, jsonb) is
  'RevenueCat projection guarded by a rail-specific causal cursor and explicit cross-rail ownership policy; service role only.';
