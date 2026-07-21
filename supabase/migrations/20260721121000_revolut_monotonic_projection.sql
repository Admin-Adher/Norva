-- Revolut webhook deliveries are at-least-once and can arrive out of order.
-- Keep a rail-specific causal cursor and apply non-checkout lifecycle events in
-- one database transaction.  The shared projection timestamp cannot be used as
-- the cursor because RevenueCat, lifecycle jobs and manual grants also write it.

create table if not exists public.cloud_revolut_projection_cursor (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_event_at timestamptz not null,
  last_event_id text not null,
  last_projection_applied boolean not null default false,
  last_result text not null default 'unknown',
  updated_at timestamptz not null default now()
);

alter table public.cloud_revolut_projection_cursor
  add column if not exists last_projection_applied boolean not null default false;
alter table public.cloud_revolut_projection_cursor
  add column if not exists last_result text not null default 'unknown';

alter table public.cloud_revolut_projection_cursor enable row level security;
revoke all on table public.cloud_revolut_projection_cursor from public, anon, authenticated;
grant all on table public.cloud_revolut_projection_cursor to service_role;

-- Preserve the state already projected before this migration.  A delivery for
-- an older order must not roll that state back merely because its new per-rail
-- cursor did not exist yet.
insert into public.cloud_revolut_projection_cursor (
  user_id, last_event_at, last_event_id, last_projection_applied, last_result
)
select
  p.user_id,
  p.last_event_at,
  'migration:' || p.user_id::text,
  true,
  'bootstrap'
from public.cloud_entitlement_projection p
where lower(p.provider) = 'revolut'
  and p.last_event_at is not null
on conflict (user_id) do nothing;

create or replace function public.apply_revolut_entitlement_event(
  p_user_id uuid,
  p_event_at timestamptz,
  p_event_id text,
  p_patch jsonb
) returns table(
  applied boolean,
  result text,
  projection_last_event_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_cursor public.cloud_revolut_projection_cursor%rowtype;
  v_projection public.cloud_entitlement_projection%rowtype;
  v_projection_found boolean := false;
  v_applied boolean := false;
  v_result text := 'not_applied';
  v_projection_last_event_at timestamptz;
begin
  if p_user_id is null or p_event_at is null or nullif(btrim(p_event_id), '') is null then
    raise exception 'Revolut user_id, event_at and event_id are required';
  end if;
  if lower(coalesce(nullif(p_patch->>'provider', ''), 'revolut')) <> 'revolut' then
    raise exception 'Revolut projection patch cannot change billing rail';
  end if;
  if coalesce(p_patch->>'plan_code', '') not in ('plus', 'family') then
    raise exception 'Revolut projection requires an explicit web plan';
  end if;
  if coalesce(p_patch->>'status', '') not in (
    'trialing', 'active', 'grace', 'past_due', 'cancelled_at_period_end',
    'expired', 'revoked', 'refunded', 'fraud', 'unknown'
  ) then
    raise exception 'invalid Revolut entitlement status';
  end if;

  -- Use the same user lock as internal-account tagging/billing, then a distinct
  -- rail lock for the no-row cursor creation path.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text, 20260721)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('norva:revolut:' || p_user_id::text, 0)
  );

  select * into v_cursor
  from public.cloud_revolut_projection_cursor c
  where c.user_id = p_user_id
  for update;

  -- An exact retry reproduces the first result, including an intentional skip.
  if found and p_event_id = v_cursor.last_event_id then
    select p.last_event_at into v_projection_last_event_at
    from public.cloud_entitlement_projection p
    where p.user_id = p_user_id;
    return query select
      v_cursor.last_projection_applied,
      v_cursor.last_result,
      v_projection_last_event_at;
    return;
  end if;

  -- Equal timestamps are one causal point: the first distinct event wins.
  if found and p_event_at <= v_cursor.last_event_at then
    select p.last_event_at into v_projection_last_event_at
    from public.cloud_entitlement_projection p
    where p.user_id = p_user_id;
    return query select false, 'stale', v_projection_last_event_at;
    return;
  end if;

  select * into v_projection
  from public.cloud_entitlement_projection p
  where p.user_id = p_user_id
  for update;
  v_projection_found := found;
  if v_projection_found then
    v_projection_last_event_at := v_projection.last_event_at;
  end if;

  if public.norva_is_internal_account(p_user_id) then
    v_result := 'internal';
  elsif v_projection_found and v_projection.status in ('revoked', 'refunded', 'fraud') then
    v_result := v_projection.status;
  elsif v_projection_found and lower(coalesce(v_projection.provider, '')) <> 'revolut' then
    -- A lifecycle webhook is not an explicit rail-transfer action.  Only the
    -- authenticated checkout/resubscribe flow may take ownership from a store.
    v_result := 'cross_rail';
  else
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
      bill_period,
      updated_at
    ) values (
      p_user_id,
      'revolut',
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
      nullif(p_patch->>'bill_period', ''),
      clock_timestamp()
    )
    on conflict (user_id) do update
    set provider = 'revolut',
        provider_customer_id = case
          when p_patch ? 'provider_customer_id' then excluded.provider_customer_id
          else current_projection.provider_customer_id
        end,
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
        end,
        updated_at = excluded.updated_at
    -- Recheck ownership and hard states at the write itself.  This also protects
    -- the no-row race against writers that do not share the Revolut advisory lock.
    where lower(coalesce(current_projection.provider, '')) = 'revolut'
      and current_projection.status not in ('revoked', 'refunded', 'fraud')
    returning current_projection.last_event_at into v_projection_last_event_at;

    v_applied := found;
    v_result := case when v_applied then 'applied' else 'concurrent_owner_change' end;
    if not v_applied then
      select p.last_event_at into v_projection_last_event_at
      from public.cloud_entitlement_projection p
      where p.user_id = p_user_id;
    end if;
  end if;

  -- Advance the Revolut causal clock even for an intentional cross-rail/internal
  -- rejection, so an older delivery cannot become eligible after a later change.
  insert into public.cloud_revolut_projection_cursor as c (
    user_id, last_event_at, last_event_id, last_projection_applied, last_result, updated_at
  ) values (
    p_user_id, p_event_at, p_event_id, v_applied, v_result, clock_timestamp()
  )
  on conflict (user_id) do update
  set last_event_at = excluded.last_event_at,
      last_event_id = excluded.last_event_id,
      last_projection_applied = excluded.last_projection_applied,
      last_result = excluded.last_result,
      updated_at = excluded.updated_at;

  return query select v_applied, v_result, v_projection_last_event_at;
end
$function$;

revoke all on function public.apply_revolut_entitlement_event(uuid, timestamptz, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.apply_revolut_entitlement_event(uuid, timestamptz, text, jsonb)
  to service_role;

comment on function public.apply_revolut_entitlement_event(uuid, timestamptz, text, jsonb) is
  'Applies non-checkout Revolut entitlement events with a rail-specific causal cursor and strict cross-rail ownership; service role only.';
