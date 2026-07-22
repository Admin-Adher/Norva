-- Terminal payment reconciliation and commercial-term invariants.
--
-- This migration closes the last money race between an interactive Revolut
-- checkout and the recurring billing worker. It also makes a provider-confirmed
-- resubscribe capture impossible to silently discard merely because the local
-- checkout TTL elapsed or another UI superseded it.

-- Correct only installations that still carry the old seed. Explicit prices
-- chosen later by an operator are intentionally left untouched.
update public.billing_prices
set amount_cents = 7499, updated_at = clock_timestamp()
where plan = 'family' and period = 'annual' and amount_cents = 7599;

alter table public.cloud_revolut_orders
  add column if not exists base_amount_cents integer,
  add column if not exists promo_cycles integer,
  add column if not exists price_source text,
  add column if not exists charge_mode text,
  add column if not exists trial_days integer,
  add column if not exists first_charge_at timestamptz;

do $order_term_constraints$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.cloud_revolut_orders'::regclass
      and conname = 'cloud_revolut_orders_base_amount_check'
  ) then
    alter table public.cloud_revolut_orders
      add constraint cloud_revolut_orders_base_amount_check
      check (base_amount_cents is null or base_amount_cents between 100 and 99999);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.cloud_revolut_orders'::regclass
      and conname = 'cloud_revolut_orders_promo_cycles_check'
  ) then
    alter table public.cloud_revolut_orders
      add constraint cloud_revolut_orders_promo_cycles_check
      check (promo_cycles is null or promo_cycles between 1 and 24);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.cloud_revolut_orders'::regclass
      and conname = 'cloud_revolut_orders_charge_mode_check'
  ) then
    alter table public.cloud_revolut_orders
      add constraint cloud_revolut_orders_charge_mode_check
      check (charge_mode is null or charge_mode in ('after_trial', 'next_cycle', 'immediate', 'card_validation_only'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.cloud_revolut_orders'::regclass
      and conname = 'cloud_revolut_orders_trial_days_check'
  ) then
    alter table public.cloud_revolut_orders
      add constraint cloud_revolut_orders_trial_days_check
      check (trial_days is null or trial_days between 0 and 90);
  end if;
end
$order_term_constraints$;

comment on column public.cloud_revolut_orders.base_amount_cents is
  'Immutable post-promotion recurring amount from the server price snapshot.';
comment on column public.cloud_revolut_orders.promo_cycles is
  'Total paid periods covered by the checkout promotion, including an immediate resubscribe debit.';

-- One durable queue for the exceptional but financially critical case where
-- Revolut captured a checkout that can no longer legally activate access. The
-- existing admin Revolut refund action resolves this row after a full refund.
create table if not exists public.cloud_revolut_payment_exceptions (
  order_id text primary key references public.cloud_revolut_orders(order_id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete restrict,
  provider_payment_id text,
  reason text not null check (reason in (
    'internal_account', 'hard_blocked', 'missing_projection',
    'non_terminal_projection', 'billing_attempt_inflight',
    'duplicate_captured_term', 'commercial_terms_invalid'
  )),
  status text not null default 'refund_required' check (status in (
    'refund_required', 'refund_processing', 'refund_failed',
    'refunded', 'resolved_access'
  )),
  amount_cents integer check (amount_cents between 1 and 9999999),
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  details jsonb not null default '{}'::jsonb,
  detected_at timestamptz not null default now(),
  resolved_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.cloud_revolut_payment_exceptions enable row level security;
revoke all on table public.cloud_revolut_payment_exceptions from public, anon, authenticated;
grant select, insert, update on table public.cloud_revolut_payment_exceptions to service_role;

create index if not exists idx_revolut_payment_exceptions_open
  on public.cloud_revolut_payment_exceptions (detected_at, order_id)
  where status in ('refund_required', 'refund_processing', 'refund_failed');

-- A refund is a money-producing operation too. Reserve it before the provider
-- call and reuse one deterministic provider idempotency key after crashes.
create table if not exists public.cloud_revolut_refund_attempts (
  order_id text primary key references public.cloud_revolut_orders(order_id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete restrict,
  original_pi_id text not null,
  amount_cents integer not null check (amount_cents between 1 and 9999999),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  country_code text check (country_code is null or country_code ~ '^[A-Z]{2}$'),
  refund_key text not null unique,
  generation integer not null default 1 check (generation between 1 and 100),
  status text not null default 'creating' check (status in ('creating', 'processing', 'failed', 'applied')),
  lease_token text,
  lease_expires_at timestamptz,
  provider_refund_id text,
  provider_response jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.cloud_revolut_refund_attempts enable row level security;
revoke all on table public.cloud_revolut_refund_attempts from public, anon, authenticated;
grant select, insert, update on table public.cloud_revolut_refund_attempts to service_role;

create unique index if not exists idx_revolut_refund_attempts_provider_id
  on public.cloud_revolut_refund_attempts (provider_refund_id)
  where provider_refund_id is not null;

-- Wrap the already-proven checkout claim rather than duplicating it. Both money
-- producers now acquire the same account lock. The terminal-state check happens
-- inside that lock, after the Edge function's advisory UI read.
do $rename_checkout_claim$
begin
  if to_regprocedure(
    'public.claim_revolut_checkout_intent_without_billing_guard(text,uuid,text,text,text,integer,text,integer,integer)'
  ) is null then
    alter function public.claim_revolut_checkout_intent(
      text, uuid, text, text, text, integer, text, integer, integer
    ) rename to claim_revolut_checkout_intent_without_billing_guard;
  end if;
end
$rename_checkout_claim$;

create or replace function public.claim_revolut_checkout_intent(
  p_intent_key text,
  p_user_id uuid,
  p_kind text,
  p_plan text,
  p_period text,
  p_amount_cents integer,
  p_lease_token text,
  p_ttl_seconds integer default 1800,
  p_lease_seconds integer default 60
) returns table(
  action text, order_id text, public_id text, checkout_url text,
  expires_at timestamptz, previous_order_id text, generation bigint
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_projection public.cloud_entitlement_projection%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('norva:revolut:money:' || p_user_id::text, 0)
  );

  if exists (
    select 1 from public.cloud_revolut_billing_attempts a
    where a.user_id = p_user_id
      and a.applied_at is null
      and a.status in ('creating', 'order_created', 'payment_pending', 'completed', 'failed', 'unknown')
  ) then
    return query select
      'billing_inflight'::text, null::text, null::text, null::text,
      clock_timestamp(), null::text, 0::bigint;
    return;
  end if;

  if p_kind = 'resubscribe' then
    select * into v_projection
    from public.cloud_entitlement_projection p
    where p.user_id = p_user_id
    for update;
    if not found or v_projection.status <> 'expired' then
      return query select
        'not_terminal'::text, null::text, null::text, null::text,
        clock_timestamp(), null::text, 0::bigint;
      return;
    end if;
  end if;

  return query
  select r.action, r.order_id, r.public_id, r.checkout_url,
         r.expires_at, r.previous_order_id, r.generation
  from public.claim_revolut_checkout_intent_without_billing_guard(
    p_intent_key, p_user_id, p_kind, p_plan, p_period, p_amount_cents,
    p_lease_token, p_ttl_seconds, p_lease_seconds
  ) r;
end
$function$;

-- The reciprocal wrapper blocks a new recurring debit while any live checkout
-- exists and revalidates the projection CAS before the first remote order is
-- created. Existing attempts remain resumable even if their eventual local CAS
-- needs manual reconciliation.
do $rename_billing_claim$
begin
  if to_regprocedure(
    'public.claim_revolut_billing_cycle_without_checkout_guard(text,uuid,text,timestamptz,integer,text,text,integer,integer,integer,integer,text,text,integer)'
  ) is null then
    alter function public.claim_revolut_billing_cycle(
      text, uuid, text, timestamptz, integer, text, text, integer, integer,
      integer, integer, text, text, integer
    ) rename to claim_revolut_billing_cycle_without_checkout_guard;
  end if;
end
$rename_billing_claim$;

create or replace function public.claim_revolut_billing_cycle(
  p_cycle_key text,
  p_user_id uuid,
  p_kind text,
  p_cycle_anchor timestamptz,
  p_retry_attempt integer,
  p_plan_code text,
  p_bill_period text,
  p_amount_cents integer,
  p_discount_pct integer,
  p_promo_cycles_before integer,
  p_base_amount_cents integer,
  p_merchant_ext_ref text,
  p_lease_token text,
  p_lease_seconds integer default 90
) returns table(
  action text, status text, order_id text, payment_id text,
  merchant_ext_ref text, amount_cents integer, plan_code text,
  bill_period text, discount_pct integer, promo_cycles_before integer,
  base_amount_cents integer, remote_state text, generation bigint
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_projection public.cloud_entitlement_projection%rowtype;
  v_valid boolean := false;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('norva:revolut:money:' || p_user_id::text, 0)
  );

  -- A refund reservation owns the money lane. Even a previously-created cycle
  -- must not resume while money is moving back to the customer.
  if exists (
    select 1 from public.cloud_revolut_refund_attempts r
    where r.user_id=p_user_id and r.status in ('creating','processing')
  ) then
    return query select
      'blocked'::text, 'refund_inflight'::text, null::text, null::text,
      p_merchant_ext_ref, p_amount_cents, p_plan_code, p_bill_period,
      p_discount_pct, p_promo_cycles_before, p_base_amount_cents,
      null::text, 0::bigint;
    return;
  end if;

  -- A known cycle must always be resumable/reconcilable. Only a first creation
  -- is gated by current checkout and projection state.
  if not exists (
    select 1 from public.cloud_revolut_billing_attempts a
    where a.cycle_key = p_cycle_key and a.user_id = p_user_id
  ) then
    if exists (
      select 1 from public.cloud_revolut_checkout_intents i
      where i.user_id = p_user_id
        and i.status in ('creating', 'ready')
        and i.expires_at > clock_timestamp()
    ) then
      return query select
        'blocked'::text, 'checkout_inflight'::text, null::text, null::text,
        p_merchant_ext_ref, p_amount_cents, p_plan_code, p_bill_period,
        p_discount_pct, p_promo_cycles_before, p_base_amount_cents,
        null::text, 0::bigint;
      return;
    end if;

    select * into v_projection
    from public.cloud_entitlement_projection p
    where p.user_id = p_user_id
    for update;
    if found and v_projection.provider = 'revolut' then
      v_valid := (
        p_kind = 'first_charge'
        and v_projection.status = 'trialing'
        and v_projection.trial_ends_at = p_cycle_anchor
      ) or (
        p_kind = 'renewal' and p_retry_attempt = 0
        and v_projection.status = 'active'
        and v_projection.current_period_end = p_cycle_anchor
      ) or (
        p_kind = 'renewal' and p_retry_attempt > 0
        and v_projection.status = 'past_due'
        and v_projection.current_period_end = p_cycle_anchor
        and coalesce(v_projection.billing_retry_count, 0) = p_retry_attempt - 1
      );
    end if;
    if not v_valid then
      return query select
        'blocked'::text, 'projection_changed'::text, null::text, null::text,
        p_merchant_ext_ref, p_amount_cents, p_plan_code, p_bill_period,
        p_discount_pct, p_promo_cycles_before, p_base_amount_cents,
        null::text, 0::bigint;
      return;
    end if;
  end if;

  return query
  select r.action, r.status, r.order_id, r.payment_id,
         r.merchant_ext_ref, r.amount_cents, r.plan_code, r.bill_period,
         r.discount_pct, r.promo_cycles_before, r.base_amount_cents,
         r.remote_state, r.generation
  from public.claim_revolut_billing_cycle_without_checkout_guard(
    p_cycle_key, p_user_id, p_kind, p_cycle_anchor, p_retry_attempt,
    p_plan_code, p_bill_period, p_amount_cents, p_discount_pct,
    p_promo_cycles_before, p_base_amount_cents, p_merchant_ext_ref,
    p_lease_token, p_lease_seconds
  ) r;
end
$function$;

-- Atomically turn one authoritative COMPLETED resubscribe into cash journal,
-- recurring mapping, entitlement and finalization. A stale local TTL is not a
-- rejection criterion; only account/billing ownership can require a refund.
create or replace function public.reconcile_completed_revolut_resubscribe(
  p_order_id text,
  p_user_id uuid,
  p_provider_payment_id text default null,
  p_captured_amount_cents integer default null,
  p_captured_currency text default null,
  p_provider_integrity_valid boolean default true,
  p_customer_id text default null,
  p_payment_method_id text default null,
  p_card_last4 text default null,
  p_card_brand text default null,
  p_card_exp text default null,
  p_card_country text default null
) returns table(result text, period_end timestamptz, exception_reason text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_order public.cloud_revolut_orders%rowtype;
  v_projection public.cloud_entitlement_projection%rowtype;
  v_own_payment public.cloud_billing_ledger%rowtype;
  v_period_end timestamptz;
  v_reason text;
  v_remaining integer;
  v_next_amount integer;
  v_payment_found boolean := false;
  v_projection_found boolean := false;
  v_capture_amount integer;
  v_capture_currency text;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('norva:revolut:money:' || p_user_id::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text, 20260721)
  );

  select * into v_order
  from public.cloud_revolut_orders o
  where o.order_id = p_order_id and o.user_id = p_user_id
  for update;
  if not found then raise exception 'resubscribe order ownership mismatch'; end if;

  -- Provider webhooks may replay COMPLETED after Norva has already issued the
  -- full refund. Never reopen the exception or replace the terminal REFUNDED
  -- result with refund_required. Restore the local state if a caller refreshed
  -- it from the provider immediately before invoking this RPC.
  if exists (
       select 1 from public.cloud_revolut_payment_exceptions e
       where e.order_id = p_order_id and e.user_id = p_user_id and e.status = 'refunded'
     ) or exists (
       select 1 from public.cloud_billing_ledger l
       where l.pi_id = 'rfnd_' || p_order_id and l.user_id = p_user_id
         and l.kind = 'refund' and l.status = 'refunded'
     ) then
    update public.cloud_revolut_orders o
    set state = 'REFUNDED', public_id = null, checkout_url = null,
        last_reconciled_at = v_now, updated_at = v_now
    where o.order_id = p_order_id;
    update public.cloud_revolut_checkout_intents i
    set status = 'finalized', lease_token = null, lease_expires_at = null, updated_at = v_now
    where i.user_id = p_user_id
      and (i.order_id = p_order_id or i.intent_key = v_order.intent_key);
    return query select 'already_refunded'::text, null::timestamptz, null::text;
    return;
  end if;
  if (coalesce(p_provider_integrity_valid, false) and v_order.kind <> 'resubscribe')
     or upper(coalesce(v_order.state, '')) <> 'COMPLETED' then
    raise exception 'resubscribe order is not authoritatively completed';
  end if;
  if not coalesce(p_provider_integrity_valid, false) then
    v_reason := 'commercial_terms_invalid';
  end if;

  if coalesce(v_order.plan, '') not in ('plus', 'family')
     or coalesce(v_order.period, '') not in ('monthly', 'annual')
     or coalesce(v_order.requested_amount_cents, 0) not between 100 and 99999
     or upper(coalesce(v_order.currency, '')) <> 'USD' then
    v_reason := 'commercial_terms_invalid';
  end if;
  -- Financial truth comes from the freshly fetched provider order. The local
  -- commercial snapshot still decides whether access may be activated, but an
  -- invalid snapshot must never make a real provider capture invisible.
  v_capture_amount := case
    when p_captured_amount_cents between 1 and 9999999 then p_captured_amount_cents
    when v_order.amount between 1 and 9999999 then v_order.amount
    else null
  end;
  v_capture_currency := case
    when upper(coalesce(p_captured_currency, '')) ~ '^[A-Z]{3}$'
      then upper(p_captured_currency)
    when upper(coalesce(v_order.currency, '')) ~ '^[A-Z]{3}$'
      then upper(v_order.currency)
    else null
  end;
  if v_capture_amount is null or v_capture_currency is null then
    v_reason := coalesce(v_reason, 'commercial_terms_invalid');
  end if;

  select * into v_own_payment
  from public.cloud_billing_ledger l
  where l.pi_id = 'rvl_' || p_order_id
  for update;
  v_payment_found := found;
  if v_payment_found and (
    v_own_payment.user_id <> p_user_id
    or v_own_payment.status <> 'captured'
    or v_own_payment.amount <> v_capture_amount
    or upper(v_own_payment.currency) <> v_capture_currency
  ) then
    raise exception 'resubscribe payment journal integrity conflict';
  end if;

  select * into v_projection
  from public.cloud_entitlement_projection p
  where p.user_id = p_user_id
  for update;
  v_projection_found := found;

  -- Exact retry after a successful transaction (or a historical crash after the
  -- projection write) is idempotent and may safely close a stale local order.
  if v_payment_found and (
       (
         v_order.finalized_at is not null
         and v_order.finalization_result->>'result' = 'resubscribed'
       ) or (
         v_projection_found
         and v_projection.provider = 'revolut'
         and v_projection.status = 'active'
         and v_own_payment.billing_period_end is not null
         and v_projection.current_period_end >= v_own_payment.billing_period_end
       )
     ) then
    update public.cloud_revolut_orders o
    set finalized_at = coalesce(o.finalized_at, v_now),
        last_reconciled_at = v_now,
        finalization_result = jsonb_build_object(
          'result', 'resubscribed', 'kind', 'resubscribe',
          'remote_state', 'COMPLETED', 'source', 'terminal_reconciliation',
          'idempotent', true, 'current_period_end', v_own_payment.billing_period_end
        ),
        public_id = null, checkout_url = null, updated_at = v_now
    where o.order_id = p_order_id;
    update public.cloud_revolut_checkout_intents i
    set status = 'finalized', lease_token = null, lease_expires_at = null, updated_at = v_now
    where i.user_id = p_user_id
      and (i.order_id = p_order_id or i.intent_key = v_order.intent_key);
    return query select 'already_applied'::text, v_own_payment.billing_period_end, null::text;
    return;
  end if;

  if public.norva_is_internal_account(p_user_id) then
    v_reason := coalesce(v_reason, 'internal_account');
  elsif not v_projection_found then
    v_reason := coalesce(v_reason, 'missing_projection');
  elsif v_projection.status in ('revoked', 'refunded', 'fraud') then
    v_reason := coalesce(v_reason, 'hard_blocked');
  elsif v_projection.status <> 'expired' then
    v_reason := coalesce(v_reason, 'non_terminal_projection');
  end if;

  if v_reason is null and exists (
    select 1 from public.cloud_revolut_billing_attempts a
    where a.user_id = p_user_id and a.applied_at is null
      and a.status in ('creating', 'order_created', 'payment_pending', 'completed', 'failed', 'unknown')
  ) then
    v_reason := 'billing_attempt_inflight';
  end if;

  if v_reason is null and exists (
    select 1 from public.cloud_billing_ledger l
    where l.user_id = p_user_id
      and l.pi_id <> 'rvl_' || p_order_id
      and l.status = 'captured'
      and l.kind in ('first_charge', 'renewal')
      and (
        coalesce(l.billing_period_end, '-infinity'::timestamptz) > v_now
        or l.created_at >= v_order.created_at
      )
  ) then
    v_reason := 'duplicate_captured_term';
  end if;

  v_period_end := case v_order.period
    when 'annual' then v_now + interval '1 year'
    else v_now + interval '1 month'
  end;

  -- The provider capture is financially real even when it must be refunded.
  -- Journal it before either activation or the durable exception decision.
  if v_capture_amount is not null and v_capture_currency is not null then
    insert into public.cloud_billing_ledger (
      pi_id, user_id, kind, amount, currency, status, provider, order_id,
      provider_payment_id, country_code, plan_code, bill_period,
      billing_period_end, experiment_key, experiment_variant,
      paywall_placement, paywall_surface, store_product_id, store_package_id,
      commercial_terms_source
    ) values (
      'rvl_' || p_order_id, p_user_id, 'first_charge',
       v_capture_amount, v_capture_currency, 'captured', 'revolut', p_order_id,
      nullif(p_provider_payment_id, ''),
      case when p_card_country ~ '^[A-Z]{2}$' then p_card_country else null end,
      v_order.plan, v_order.period, v_period_end,
      v_order.experiment_key, v_order.experiment_variant,
      v_order.paywall_placement, v_order.paywall_surface,
      null, null, 'revolut_order_snapshot'
    ) on conflict (pi_id) do nothing;
  end if;

  if v_reason is not null then
    insert into public.cloud_revolut_payment_exceptions as e (
      order_id, user_id, provider_payment_id, reason, status,
      amount_cents, currency, details, detected_at, updated_at
    ) values (
      p_order_id, p_user_id, nullif(p_provider_payment_id, ''), v_reason,
       'refund_required', v_capture_amount, v_capture_currency,
      jsonb_build_object(
        'expired_at', v_order.expired_at,
        'superseded_at', v_order.superseded_at,
        'projection_status', v_projection.status,
        'projection_provider', v_projection.provider
      ), v_now, v_now
    ) on conflict (order_id) do update
      set provider_payment_id = coalesce(excluded.provider_payment_id, e.provider_payment_id),
          reason = excluded.reason,
          status = case
            when e.status in ('refunded', 'refund_processing', 'refund_failed') then e.status
            else 'refund_required'
          end,
          details = excluded.details,
          updated_at = excluded.updated_at;

    update public.cloud_revolut_orders o
    set finalization_result = jsonb_build_object(
          'result', 'refund_required', 'kind', 'resubscribe',
          'remote_state', 'COMPLETED', 'reason', v_reason,
          'source', 'terminal_reconciliation'
        ),
        public_id = null, checkout_url = null,
        last_reconciled_at = v_now, updated_at = v_now
    where o.order_id = p_order_id;
    update public.cloud_revolut_checkout_intents i
    set status = 'expired', lease_token = null, lease_expires_at = null, updated_at = v_now
    where i.user_id = p_user_id
      and (i.order_id = p_order_id or i.intent_key = v_order.intent_key);
    return query select 'refund_required'::text, null::timestamptz, v_reason;
    return;
  end if;

  -- The immediate debit consumes period 1 of an N-period promotion. Therefore
  -- only N-1 promotional renewals remain in the recurring mapping.
  v_remaining := case
    when v_order.base_amount_cents is not null and v_order.promo_cycles is not null
      then greatest(v_order.promo_cycles - 1, 0)
    else null
  end;
  v_next_amount := case
    when v_remaining = 0 and v_order.base_amount_cents is not null
      then v_order.base_amount_cents
    else v_order.requested_amount_cents
  end;

  insert into public.cloud_revolut_customers as c (
    user_id, revolut_customer_id, payment_method_id, card_last4, card_brand,
    card_exp, card_country, plan, period, amount_cents,
    base_amount_cents, promo_cycles_left,
    pending_plan, pending_period, pending_amount_cents,
    pending_base_amount_cents, pending_promo_cycles,
    pending_effective_at, pending_order_id, updated_at
  ) values (
    p_user_id, nullif(p_customer_id, ''), nullif(p_payment_method_id, ''),
    nullif(p_card_last4, ''), nullif(p_card_brand, ''), nullif(p_card_exp, ''),
    case when p_card_country ~ '^[A-Z]{2}$' then p_card_country else null end,
    v_order.plan, v_order.period, v_next_amount,
    case when coalesce(v_remaining, 0) > 0 then v_order.base_amount_cents else null end,
    nullif(v_remaining, 0),
    null, null, null, null, null, null, null, v_now
  ) on conflict (user_id) do update
  set revolut_customer_id = coalesce(excluded.revolut_customer_id, c.revolut_customer_id),
      payment_method_id = coalesce(excluded.payment_method_id, c.payment_method_id),
      card_last4 = coalesce(excluded.card_last4, c.card_last4),
      card_brand = coalesce(excluded.card_brand, c.card_brand),
      card_exp = coalesce(excluded.card_exp, c.card_exp),
      card_country = coalesce(excluded.card_country, c.card_country),
      plan = excluded.plan, period = excluded.period,
      amount_cents = excluded.amount_cents,
      base_amount_cents = excluded.base_amount_cents,
      promo_cycles_left = excluded.promo_cycles_left,
      pending_plan = null, pending_period = null, pending_amount_cents = null,
      pending_base_amount_cents = null, pending_promo_cycles = null,
      pending_effective_at = null, pending_order_id = null,
      updated_at = v_now;

  insert into public.cloud_entitlement_events (
    user_id, provider, provider_event_id, event_type, payload, processed_at
  ) values (
    p_user_id, 'revolut', 'checkout:' || p_order_id || ':resubscribe-captured',
    'RESUBSCRIBE_PURCHASE_CAPTURED',
    jsonb_build_object(
      'order_id', p_order_id, 'plan_label', v_order.plan,
      'bill_period', v_order.period,
      'amount_cents', v_order.requested_amount_cents,
      'currency', 'USD', 'period_end', v_period_end
    ), v_now
  ) on conflict (provider, provider_event_id)
      where provider_event_id is not null
    do nothing;

  update public.cloud_entitlement_projection p
  set status = 'active', provider = 'revolut',
      provider_customer_id = coalesce(nullif(p_customer_id, ''), p.provider_customer_id),
      plan_code = v_order.plan, current_period_end = v_period_end,
      trial_ends_at = null, fail_open_until = null,
      dunning_stage = 0, dunning_last_at = null, billing_retry_count = 0,
      last_event_at = v_now, last_verified_at = v_now,
      mrr_cents = v_order.requested_amount_cents,
      bill_period = v_order.period, billing_currency = 'USD',
      billing_product_id = null, billing_package_id = null,
      billing_terms_source = 'revolut_order_snapshot',
      country_code = coalesce(
        case when p_card_country ~ '^[A-Z]{2}$' then p_card_country else null end,
        p.country_code
      ),
      country_source = case when p_card_country ~ '^[A-Z]{2}$' then 'card' else p.country_source end
  where p.user_id = p_user_id and p.status = 'expired';
  if not found then raise exception 'resubscribe projection changed concurrently'; end if;

  update public.cloud_revolut_orders o
  set finalized_at = v_now, last_reconciled_at = v_now,
      finalization_result = jsonb_build_object(
        'result', 'resubscribed', 'kind', 'resubscribe',
        'remote_state', 'COMPLETED', 'source', 'terminal_reconciliation',
        'current_period_end', v_period_end,
        'reconciled_stale_checkout', o.expired_at is not null or o.superseded_at is not null
      ),
      public_id = null, checkout_url = null, updated_at = v_now
  where o.order_id = p_order_id;
  update public.cloud_revolut_checkout_intents i
  set status = 'finalized', lease_token = null, lease_expires_at = null, updated_at = v_now
  where i.user_id = p_user_id
    and (i.order_id = p_order_id or i.intent_key = v_order.intent_key);
  update public.cloud_revolut_payment_exceptions e
  set status = 'resolved_access', resolved_at = v_now, updated_at = v_now
  where e.order_id = p_order_id and e.status <> 'refunded';

  return query select 'applied'::text, v_period_end, null::text;
end
$function$;

-- Called after the existing admin route has journalled a full Revolut refund.
-- A partial refund deliberately leaves the exception open.
create or replace function public.resolve_revolut_resubscribe_refund(
  p_order_id text,
  p_user_id uuid
) returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_order public.cloud_revolut_orders%rowtype;
  v_exception public.cloud_revolut_payment_exceptions%rowtype;
  v_capture integer;
  v_refund integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('norva:revolut:money:' || p_user_id::text, 0)
  );
  select * into v_order from public.cloud_revolut_orders o
  where o.order_id = p_order_id and o.user_id = p_user_id for update;
  if not found then return 'order_not_found'; end if;
  select * into v_exception from public.cloud_revolut_payment_exceptions e
  where e.order_id = p_order_id and e.user_id = p_user_id for update;
  if not found then return 'no_exception'; end if;
  if v_exception.status = 'refunded' then return 'already_refunded'; end if;

  select l.amount into v_capture from public.cloud_billing_ledger l
  where l.pi_id = 'rvl_' || p_order_id and l.status = 'captured';
  select l.amount into v_refund from public.cloud_billing_ledger l
  where l.pi_id = 'rfnd_' || p_order_id and l.status = 'refunded';
  if coalesce(v_refund, 0) < coalesce(v_capture, v_exception.amount_cents, 1) then
    return 'partial_or_missing_refund';
  end if;

  update public.cloud_revolut_payment_exceptions e
  set status = 'refunded', resolved_at = v_now, updated_at = v_now
  where e.order_id = p_order_id;
  update public.cloud_revolut_orders o
  set state = 'REFUNDED', finalized_at = coalesce(o.finalized_at, v_now),
      last_reconciled_at = v_now,
      finalization_result = jsonb_build_object(
        'result', 'rejected_paid_checkout_refunded', 'kind', 'resubscribe',
        'remote_state', 'COMPLETED', 'reason', v_exception.reason,
        'source', 'admin_full_refund'
      ), public_id = null, checkout_url = null, updated_at = v_now
  where o.order_id = p_order_id;
  update public.cloud_revolut_checkout_intents i
  set status = 'finalized', lease_token = null, lease_expires_at = null, updated_at = v_now
  where i.user_id = p_user_id
    and (i.order_id = p_order_id or i.intent_key = v_order.intent_key);
  return 'refunded';
end
$function$;

create or replace function public.claim_revolut_full_refund(
  p_order_id text,
  p_user_id uuid,
  p_original_pi_id text,
  p_amount_cents integer,
  p_currency text,
  p_lease_token text,
  p_lease_seconds integer default 90
) returns table(
  action text, refund_key text, amount_cents integer, currency text,
  provider_refund_id text
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_payment public.cloud_billing_ledger%rowtype;
  v_attempt public.cloud_revolut_refund_attempts%rowtype;
  v_refund public.cloud_billing_ledger%rowtype;
  v_generation integer := 1;
  v_key text;
begin
  if nullif(btrim(p_lease_token), '') is null then raise exception 'refund lease token required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('norva:revolut:money:' || p_user_id::text, 0)
  );
  if exists (
    select 1 from public.cloud_revolut_billing_attempts a
    where a.user_id=p_user_id and a.applied_at is null
      and a.status in ('creating','order_created','payment_pending','completed','failed','unknown')
  ) then
    raise exception 'recurring billing attempt is still in flight';
  end if;
  select * into v_payment from public.cloud_billing_ledger l
  where l.pi_id = p_original_pi_id and l.user_id = p_user_id for update;
  if not found or v_payment.provider <> 'revolut' or v_payment.status <> 'captured'
     or v_payment.order_id <> p_order_id then
    raise exception 'captured Revolut payment mismatch';
  end if;
  -- Partial refunds are deliberately rejected until the ledger can represent
  -- cumulative provider refunds. This removes the old partial-then-blocked trap.
  if p_amount_cents <> v_payment.amount or upper(p_currency) <> upper(v_payment.currency) then
    raise exception 'only an exact full refund may be reserved';
  end if;

  select * into v_refund from public.cloud_billing_ledger l
  where l.pi_id = 'rfnd_' || p_order_id and l.user_id = p_user_id for update;
  if found and v_refund.status = 'refunded' and v_refund.amount >= v_payment.amount then
    insert into public.cloud_revolut_refund_attempts as a (
      order_id,user_id,original_pi_id,amount_cents,currency,country_code,
      refund_key,generation,status,updated_at
    ) values (
      p_order_id,p_user_id,p_original_pi_id,v_payment.amount,upper(v_payment.currency),v_payment.country_code,
      'nrv-rf-' || md5(p_order_id || ':' || p_user_id::text || ':1'),1,'applied',v_now
    ) on conflict (order_id) do update set status='applied',updated_at=v_now;
    select * into v_attempt from public.cloud_revolut_refund_attempts a
    where a.order_id=p_order_id;
    return query select 'done'::text,v_attempt.refund_key,v_payment.amount,
      upper(v_payment.currency),v_attempt.provider_refund_id;
    return;
  end if;

  select * into v_attempt from public.cloud_revolut_refund_attempts a
  where a.order_id = p_order_id for update;
  if found then
    if v_attempt.user_id <> p_user_id or v_attempt.original_pi_id <> p_original_pi_id
       or v_attempt.amount_cents <> p_amount_cents or v_attempt.currency <> upper(p_currency) then
      raise exception 'refund reservation integrity mismatch';
    end if;
    if v_attempt.status = 'applied' then
      return query select 'done'::text,v_attempt.refund_key,v_attempt.amount_cents,
        v_attempt.currency,v_attempt.provider_refund_id;
      return;
    end if;
    if v_attempt.lease_token is distinct from p_lease_token
       and v_attempt.lease_expires_at > v_now then
      return query select 'wait'::text,v_attempt.refund_key,v_attempt.amount_cents,
        v_attempt.currency,v_attempt.provider_refund_id;
      return;
    end if;
    if v_attempt.status = 'processing' then
      if nullif(v_attempt.provider_refund_id, '') is null then
        raise exception 'processing refund has no provider order id';
      end if;
      update public.cloud_revolut_refund_attempts a
      set lease_token=p_lease_token,
          lease_expires_at=v_now + make_interval(secs => greatest(30,least(p_lease_seconds,300))),
          updated_at=v_now
      where a.order_id=p_order_id;
      return query select 'reconcile'::text,v_attempt.refund_key,v_attempt.amount_cents,
        v_attempt.currency,v_attempt.provider_refund_id;
      return;
    end if;
    if v_attempt.status = 'failed' then
      v_generation := v_attempt.generation + 1;
      if v_generation > 100 then raise exception 'refund retry limit reached'; end if;
      v_key := 'nrv-rf-' || md5(p_order_id || ':' || p_user_id::text || ':' || v_generation::text);
      update public.cloud_revolut_refund_attempts a
      set generation=v_generation,refund_key=v_key,status='creating',
          provider_refund_id=null,provider_response=null,last_error=null,
          lease_token=p_lease_token,
          lease_expires_at=v_now + make_interval(secs => greatest(30,least(p_lease_seconds,300))),
          updated_at=v_now
      where a.order_id=p_order_id;
    else
      v_key := v_attempt.refund_key;
      update public.cloud_revolut_refund_attempts a
      set lease_token=p_lease_token,
          lease_expires_at=v_now + make_interval(secs => greatest(30,least(p_lease_seconds,300))),
          last_error=null,updated_at=v_now
      where a.order_id=p_order_id;
    end if;
  else
    v_key := 'nrv-rf-' || md5(p_order_id || ':' || p_user_id::text || ':1');
    insert into public.cloud_revolut_refund_attempts (
      order_id,user_id,original_pi_id,amount_cents,currency,country_code,refund_key,
      generation,status,lease_token,lease_expires_at,updated_at
    ) values (
      p_order_id,p_user_id,p_original_pi_id,p_amount_cents,upper(p_currency),v_payment.country_code,v_key,
      1,'creating',p_lease_token,
      v_now + make_interval(secs => greatest(30,least(p_lease_seconds,300))),v_now
    );
  end if;
  return query select 'create'::text,v_key,p_amount_cents,upper(p_currency),null::text;
end
$function$;

create or replace function public.fail_revolut_full_refund(
  p_order_id text,
  p_user_id uuid,
  p_lease_token text,
  p_error text
) returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('norva:revolut:money:' || p_user_id::text, 0)
  );
  update public.cloud_revolut_refund_attempts a
  set lease_expires_at=clock_timestamp(),last_error=left(p_error,1000),updated_at=clock_timestamp()
  where a.order_id=p_order_id and a.user_id=p_user_id and a.status='creating'
    and a.lease_token=p_lease_token;
  return found;
end
$function$;

-- A successful POST /refund creates a separate provider refund order, normally
-- in PROCESSING. Persist that order id durably, release the creation lease, and
-- keep the financial exception open until a later authoritative COMPLETED.
create or replace function public.mark_revolut_full_refund_processing(
  p_order_id text,
  p_user_id uuid,
  p_lease_token text,
  p_provider_refund_id text,
  p_provider_response jsonb default null
) returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_attempt public.cloud_revolut_refund_attempts%rowtype;
begin
  if nullif(btrim(p_provider_refund_id), '') is null then
    raise exception 'provider refund order id required';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('norva:revolut:money:' || p_user_id::text, 0)
  );
  select * into v_attempt from public.cloud_revolut_refund_attempts a
  where a.order_id=p_order_id and a.user_id=p_user_id for update;
  if not found then raise exception 'refund reservation missing'; end if;
  if v_attempt.status='applied' then return 'already_applied'; end if;
  if v_attempt.status not in ('creating','processing') then
    raise exception 'refund reservation is not processing';
  end if;
  if v_attempt.provider_refund_id is not null
     and v_attempt.provider_refund_id <> p_provider_refund_id then
    raise exception 'provider refund order conflict';
  end if;
  -- Webhooks can arrive before POST /refund returns to the admin function. If
  -- the same provider order was already bound by that webhook, the later admin
  -- response is an idempotent confirmation and must not fail merely because the
  -- webhook released the creation lease.
  if v_attempt.status='processing'
     and v_attempt.provider_refund_id=p_provider_refund_id then
    update public.cloud_revolut_refund_attempts a
    set provider_response=coalesce(p_provider_response,a.provider_response),
        lease_token=null,lease_expires_at=null,last_error=null,updated_at=v_now
    where a.order_id=p_order_id;
    return 'processing';
  end if;
  -- A trusted service-role webhook may be the first process to see the refund
  -- order id. It can bind an as-yet-unbound `creating` reservation with a null
  -- lease token; every other transition must own the original creation lease.
  if v_attempt.lease_token is distinct from p_lease_token
     and not (
       p_lease_token is null
       and v_attempt.status='creating'
       and v_attempt.provider_refund_id is null
     ) then
    raise exception 'refund lease lost';
  end if;
  update public.cloud_revolut_refund_attempts a
  set status='processing',provider_refund_id=p_provider_refund_id,
      provider_response=coalesce(p_provider_response,a.provider_response),
      lease_token=null,lease_expires_at=null,last_error=null,updated_at=v_now
  where a.order_id=p_order_id;
  update public.cloud_revolut_payment_exceptions e
  set status='refund_processing',updated_at=v_now
  where e.order_id=p_order_id and e.user_id=p_user_id
    and e.status in ('refund_required','refund_failed','refund_processing');
  return 'processing';
end
$function$;

create or replace function public.fail_revolut_refund_order(
  p_provider_refund_id text,
  p_provider_state text,
  p_provider_response jsonb default null
) returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_attempt public.cloud_revolut_refund_attempts%rowtype;
  v_state text := upper(coalesce(p_provider_state,''));
begin
  if v_state not in ('FAILED','DECLINED','CANCELLED','REVERSED','VOIDED') then
    raise exception 'provider refund state is not terminal failure';
  end if;
  select * into v_attempt from public.cloud_revolut_refund_attempts a
  where a.provider_refund_id=p_provider_refund_id;
  if not found then return 'refund_not_found'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('norva:revolut:money:' || v_attempt.user_id::text, 0)
  );
  select * into v_attempt from public.cloud_revolut_refund_attempts a
  where a.provider_refund_id=p_provider_refund_id for update;
  if not found then return 'refund_not_found'; end if;
  if v_attempt.status='applied' then return 'already_applied'; end if;
  update public.cloud_revolut_refund_attempts a
  set status='failed',provider_response=coalesce(p_provider_response,a.provider_response),
      lease_token=null,lease_expires_at=null,
      last_error='provider refund order ' || lower(v_state),updated_at=v_now
  where a.order_id=v_attempt.order_id;
  update public.cloud_revolut_payment_exceptions e
  set status='refund_failed',updated_at=v_now,
      details=e.details || jsonb_build_object(
        'refund_order_id',p_provider_refund_id,'refund_state',v_state
      )
  where e.order_id=v_attempt.order_id and e.status<>'refunded';
  return 'failed';
end
$function$;

create or replace function public.complete_revolut_full_refund(
  p_order_id text,
  p_user_id uuid,
  p_provider_refund_id text,
  p_provider_state text,
  p_related_order_id text,
  p_provider_amount_cents integer,
  p_provider_currency text,
  p_provider_response jsonb default null
) returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_attempt public.cloud_revolut_refund_attempts%rowtype;
  v_existing public.cloud_billing_ledger%rowtype;
  v_has_exception boolean := false;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('norva:revolut:money:' || p_user_id::text, 0)
  );
  select * into v_attempt from public.cloud_revolut_refund_attempts a
  where a.order_id=p_order_id and a.user_id=p_user_id for update;
  if not found then raise exception 'refund reservation missing'; end if;
  if v_attempt.status='applied' then return 'already_applied'; end if;
  if v_attempt.status<>'processing' then raise exception 'refund order is not processing'; end if;
  if v_attempt.provider_refund_id is distinct from nullif(p_provider_refund_id,'') then
    raise exception 'provider refund order mismatch';
  end if;
  if upper(coalesce(p_provider_state,''))<>'COMPLETED'
     or p_related_order_id is distinct from p_order_id
     or p_provider_amount_cents is distinct from v_attempt.amount_cents
     or upper(coalesce(p_provider_currency,'')) is distinct from v_attempt.currency then
    raise exception 'provider refund completion failed integrity validation';
  end if;

  insert into public.cloud_billing_ledger (
    pi_id,user_id,kind,amount,currency,status,provider,order_id,provider_payment_id,country_code
  ) values (
    'rfnd_' || p_order_id,p_user_id,'refund',v_attempt.amount_cents,
    lower(v_attempt.currency),'refunded','revolut',p_order_id,p_provider_refund_id,v_attempt.country_code
  ) on conflict (pi_id) do nothing;
  select * into v_existing from public.cloud_billing_ledger l
  where l.pi_id='rfnd_' || p_order_id for update;
  if not found or v_existing.user_id<>p_user_id or v_existing.status<>'refunded'
     or v_existing.amount<>v_attempt.amount_cents
     or upper(v_existing.currency)<>v_attempt.currency then
    raise exception 'refund ledger integrity mismatch';
  end if;

  insert into public.cloud_entitlement_events (
    user_id,provider,provider_event_id,event_type,payload,processed_at
  ) values (
    p_user_id,'revolut','admin:rfnd_' || p_order_id || ':refund-confirmed',
    'REFUND_CONFIRMED',jsonb_build_object(
      'amount_cents',v_attempt.amount_cents,'currency',v_attempt.currency,
      'reference',left(v_attempt.refund_key,32)
    ),v_now
  ) on conflict (provider,provider_event_id)
      where provider_event_id is not null
    do nothing;

  select exists (
    select 1 from public.cloud_revolut_payment_exceptions e
    where e.order_id=p_order_id and e.user_id=p_user_id
  ) into v_has_exception;
  if v_has_exception then
    -- This is a quarantined paid checkout which never granted the disputed
    -- term. Resolve only that exception; do not disturb an unrelated current
    -- rail or entitlement which was the reason for quarantine.
    perform public.resolve_revolut_resubscribe_refund(p_order_id,p_user_id);
  else
    -- A normal full refund revokes the refunded Revolut term immediately and
    -- removes Norva's card-on-file schedule. Internal/system access and hard
    -- security states remain authoritative.
    delete from public.cloud_revolut_customers c where c.user_id=p_user_id;
    update public.cloud_revolut_checkout_intents i
    set status='expired',lease_token=null,lease_expires_at=null,updated_at=v_now
    where i.user_id=p_user_id and i.status in ('creating','ready');
    if not public.norva_is_internal_account(p_user_id) then
      update public.cloud_entitlement_projection p
      set status='expired',provider_customer_id=null,plan_code='none',
          current_period_end=null,trial_ends_at=null,fail_open_until=null,
          dunning_stage=0,dunning_last_at=null,billing_retry_count=0,
          mrr_cents=null,bill_period=null,billing_currency=null,
          billing_product_id=null,billing_package_id=null,
          billing_terms_source=null,last_event_at=v_now,last_verified_at=v_now
      where p.user_id=p_user_id and p.provider='revolut'
        and p.status not in ('revoked','refunded','fraud');
    end if;
    update public.cloud_revolut_orders o
    set state='REFUNDED',public_id=null,checkout_url=null,
        last_reconciled_at=v_now,updated_at=v_now,
        finalized_at=coalesce(o.finalized_at,v_now),
        finalization_result=jsonb_build_object(
          'result','full_refund_completed','source','provider_refund_order',
          'provider_refund_id',p_provider_refund_id
        )
    where o.order_id=p_order_id and o.user_id=p_user_id;
  end if;

  update public.cloud_revolut_refund_attempts a
  set status='applied',lease_token=null,lease_expires_at=null,
      provider_refund_id=coalesce(nullif(p_provider_refund_id,''),a.provider_refund_id),
      provider_response=coalesce(p_provider_response,a.provider_response),
      last_error=null,updated_at=v_now
  where a.order_id=p_order_id;
  return 'applied';
end
$function$;

-- Extend the causal RevenueCat projection writer with the complete server-side
-- commercial snapshot. RevenueCat `price` is USD and full-period; the immutable
-- cash ledger separately retains paidMoney in the buyer's local currency.
do $rename_rc_nonblocked$
begin
  if to_regprocedure(
    'public.apply_revenuecat_entitlement_event_without_commercial_terms(uuid,timestamptz,text,jsonb)'
  ) is null then
    alter function public.apply_revenuecat_entitlement_event_nonblocked(uuid, timestamptz, text, jsonb)
      rename to apply_revenuecat_entitlement_event_without_commercial_terms;
  end if;
end
$rename_rc_nonblocked$;

create or replace function public.apply_revenuecat_entitlement_event_nonblocked(
  p_user_id uuid,
  p_event_at timestamptz,
  p_event_id text,
  p_patch jsonb
) returns table(applied boolean, projection_last_event_at timestamptz)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_applied boolean;
  v_last timestamptz;
  v_currency text;
begin
  v_currency := nullif(p_patch->>'billing_currency', '');
  if v_currency is not null and v_currency !~ '^[A-Z]{3}$' then
    raise exception 'invalid RevenueCat billing currency';
  end if;
  if p_patch ? 'bill_period' and coalesce(p_patch->>'bill_period', '') not in ('monthly', 'annual') then
    raise exception 'invalid RevenueCat billing cadence';
  end if;

  select r.applied, r.projection_last_event_at into v_applied, v_last
  from public.apply_revenuecat_entitlement_event_without_commercial_terms(
    p_user_id, p_event_at, p_event_id, p_patch
  ) r;

  if v_applied then
    update public.cloud_entitlement_projection p
    set billing_currency = case
          when p_patch ? 'billing_currency' then v_currency else p.billing_currency end,
        billing_product_id = case
          when p_patch ? 'billing_product_id' then nullif(p_patch->>'billing_product_id', '')
          else p.billing_product_id end,
        billing_package_id = case
          when p_patch ? 'billing_package_id' then nullif(p_patch->>'billing_package_id', '')
          else p.billing_package_id end,
        billing_terms_source = case
          when p_patch ? 'billing_terms_source' then nullif(p_patch->>'billing_terms_source', '')
          else p.billing_terms_source end
    where p.user_id = p_user_id;
  end if;
  return query select v_applied, v_last;
end
$function$;

-- System/internal access is never a commercial subscription. These columns were
-- added after the original invariant trigger, so clear them in a later-ordered
-- BEFORE trigger as well as cleaning existing rows.
create or replace function public.norva_clear_system_commercial_terms()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
begin
  if new.provider = 'system' or public.norva_is_internal_account(new.user_id) then
    new.mrr_cents := null;
    new.bill_period := null;
    new.billing_currency := null;
    new.billing_product_id := null;
    new.billing_package_id := null;
    new.billing_terms_source := null;
  end if;
  return new;
end
$function$;

drop trigger if exists aab_norva_system_commercial_terms
  on public.cloud_entitlement_projection;
create trigger aab_norva_system_commercial_terms
before insert or update on public.cloud_entitlement_projection
for each row execute function public.norva_clear_system_commercial_terms();

update public.cloud_entitlement_projection p
set mrr_cents = null, bill_period = null,
    billing_currency = null, billing_product_id = null,
    billing_package_id = null, billing_terms_source = null
where p.provider = 'system'
   or exists (select 1 from public.admin_internal_accounts i where i.user_id = p.user_id);

-- Rebuild the two funnel joins so assignment alone is never mistaken for an
-- exposure, and an activation can only follow a recent captured payment on the
-- same billing rail (trials may follow their recent authorization/exposure).
create or replace function public.norva_billing_ledger_funnel_event()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_previous uuid;
  v_when timestamptz := coalesce(new.updated_at, new.created_at, now());
begin
  if new.user_id is null or new.status <> 'captured'
     or new.kind not in ('first_charge', 'resubscribe')
     or exists (select 1 from public.admin_internal_accounts i where i.user_id = new.user_id) then
    return new;
  end if;

  if new.order_id is not null then
    select e.id into v_previous from public.paywall_funnel_events e
    where e.user_id = new.user_id
      and e.order_id = new.order_id
      and e.event_type in ('order_authorized', 'checkout_started')
    order by case e.event_type when 'order_authorized' then 0 else 1 end,
             e.occurred_at desc, e.id desc limit 1;
  end if;
  if v_previous is null and new.experiment_key is not null then
    select e.id into v_previous from public.paywall_funnel_events e
    where e.user_id = new.user_id and e.event_type = 'paywall_exposed'
      and e.experiment_key = new.experiment_key
      and (new.paywall_surface is null or e.surface = new.paywall_surface)
      and e.occurred_at between v_when - interval '30 days' and v_when + interval '5 minutes'
    order by e.occurred_at desc, e.id desc limit 1;
  end if;

  insert into public.paywall_funnel_events (
    user_id, event_type, event_source, experiment_key, experiment_variant,
    placement, surface, plan_code, billing_cadence, price_amount_minor, price_currency,
    order_id, previous_event_id, dedupe_key, occurred_at, metadata
  ) values (
    new.user_id, 'payment_captured', 'billing_ledger',
    new.experiment_key, new.experiment_variant,
    new.paywall_placement, new.paywall_surface,
    new.plan_code, new.bill_period, new.amount, upper(new.currency),
    coalesce(new.order_id, new.pi_id), v_previous,
    'payment_captured:ledger:' || new.pi_id, v_when,
    jsonb_build_object('provider', new.provider, 'kind', new.kind)
  ) on conflict (dedupe_key) do nothing;
  return new;
end
$function$;

create or replace function public.norva_entitlement_activation_funnel_event()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_previous public.paywall_funnel_events%rowtype;
  v_entitlement_event_id uuid;
  v_activation_key text;
  v_now timestamptz := clock_timestamp();
begin
  if exists (select 1 from public.admin_internal_accounts i where i.user_id = new.user_id) then
    return new;
  end if;
  if new.status not in ('trialing', 'active') then return new; end if;
  if tg_op = 'UPDATE'
     and old.status in ('trialing', 'active')
     and old.provider is not distinct from new.provider
     and old.plan_code is not distinct from new.plan_code then
    return new;
  end if;

  if new.status = 'active' then
    select * into v_previous from public.paywall_funnel_events e
    where e.user_id = new.user_id and e.event_type = 'payment_captured'
      and e.occurred_at between v_now - interval '10 minutes' and v_now + interval '1 minute'
      and (e.plan_code is null or e.plan_code = new.plan_code)
      and coalesce(e.metadata->>'provider', '') = coalesce(new.provider, '')
    order by e.occurred_at desc, e.id desc limit 1;
    -- Active grants, uncancellations and extensions without a new capture are
    -- entitlement lifecycle events, not purchase-funnel activations.
    if not found then return new; end if;
  else
    select * into v_previous from public.paywall_funnel_events e
    where e.user_id = new.user_id
      and e.event_type in ('order_authorized', 'paywall_exposed')
      and e.occurred_at between v_now - interval '30 days' and v_now + interval '1 minute'
      and (e.plan_code is null or e.plan_code = new.plan_code)
    order by case e.event_type when 'order_authorized' then 0 else 1 end,
             e.occurred_at desc, e.id desc limit 1;
  end if;

  v_activation_key := 'entitlement_activated:' || new.user_id::text || ':' || v_previous.id::text;
  select ce.id into v_entitlement_event_id
  from public.cloud_entitlement_events ce
  where ce.user_id = new.user_id
    and (ce.provider = new.provider or (
      new.provider in ('google_play', 'apple_app_store', 'web', 'stripe', 'revenuecat')
      and ce.provider = 'revenuecat'
    ))
    and coalesce(ce.processed_at, ce.created_at) between v_now - interval '10 minutes' and v_now + interval '1 minute'
  order by coalesce(ce.processed_at, ce.created_at) desc, ce.id desc limit 1;

  insert into public.paywall_funnel_events (
    user_id, event_type, event_source, experiment_key, experiment_variant,
    placement, surface, plan_code, billing_cadence, price_amount_minor, price_currency,
    order_id, entitlement_event_id, previous_event_id, dedupe_key, occurred_at, metadata
  ) values (
    new.user_id, 'entitlement_activated', 'entitlement_projection',
    v_previous.experiment_key, v_previous.experiment_variant,
    v_previous.placement, v_previous.surface,
    new.plan_code, coalesce(v_previous.billing_cadence, new.bill_period),
    v_previous.price_amount_minor, v_previous.price_currency,
    v_previous.order_id, v_entitlement_event_id, v_previous.id,
    v_activation_key, v_now,
    jsonb_build_object(
      'provider', new.provider, 'status', new.status,
      'commercial_terms_source', case
        when v_previous.event_type = 'payment_captured' then 'captured_payment_event'
        when v_previous.event_type = 'order_authorized' then 'authorized_checkout_snapshot'
        else 'exposed_trial'
      end
    )
  ) on conflict (dedupe_key) do nothing;
  return new;
end
$function$;

create or replace function public.norva_first_play_funnel_event()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_activation public.paywall_funnel_events%rowtype;
  v_projection public.cloud_entitlement_projection%rowtype;
begin
  if new.event_type <> 'first_frame'
     or exists (select 1 from public.admin_internal_accounts i where i.user_id = new.user_id) then
    return new;
  end if;
  select * into v_projection
  from public.cloud_entitlement_projection p
  where p.user_id = new.user_id;
  if not found or v_projection.status not in (
    'trialing', 'active', 'grace', 'past_due', 'cancelled_at_period_end'
  ) then
    return new;
  end if;
  if v_projection.status = 'trialing'
     and coalesce(v_projection.trial_ends_at, '-infinity'::timestamptz) < new.created_at then
    return new;
  elsif v_projection.status in ('active', 'cancelled_at_period_end')
     and v_projection.current_period_end is not null
     and v_projection.current_period_end < new.created_at then
    return new;
  elsif v_projection.status in ('grace', 'past_due')
     and greatest(
       coalesce(v_projection.current_period_end, '-infinity'::timestamptz),
       coalesce(v_projection.fail_open_until, '-infinity'::timestamptz)
     ) < new.created_at then
    return new;
  end if;
  select * into v_activation from public.paywall_funnel_events e
  where e.user_id = new.user_id and e.event_type = 'entitlement_activated'
    and e.occurred_at between new.created_at - interval '30 days' and new.created_at
    and (e.plan_code is null or e.plan_code = v_projection.plan_code)
    and coalesce(e.metadata->>'provider', '') = coalesce(v_projection.provider, '')
  order by e.occurred_at desc, e.id desc limit 1;
  if not found then return new; end if;
  insert into public.paywall_funnel_events (
    user_id,event_type,event_source,experiment_key,experiment_variant,
    placement,surface,plan_code,billing_cadence,price_amount_minor,price_currency,
    order_id,playback_event_id,previous_event_id,dedupe_key,occurred_at,metadata
  ) values (
    new.user_id,'first_play','playback_first_frame',
    v_activation.experiment_key,v_activation.experiment_variant,
    v_activation.placement,v_activation.surface,v_activation.plan_code,v_activation.billing_cadence,
    v_activation.price_amount_minor,v_activation.price_currency,
    v_activation.order_id,new.id,v_activation.id,
    'first_play:activation:' || v_activation.id::text,new.created_at,
    jsonb_build_object(
      'item_type',new.item_type,'playback_mode',new.playback_mode,
      'time_to_first_frame_ms',new.time_to_first_frame_ms
    )
  ) on conflict (dedupe_key) do nothing;
  return new;
end
$function$;

revoke all on function public.claim_revolut_checkout_intent_without_billing_guard(
  text, uuid, text, text, text, integer, text, integer, integer
) from public, anon, authenticated, service_role;
revoke all on function public.claim_revolut_billing_cycle_without_checkout_guard(
  text, uuid, text, timestamptz, integer, text, text, integer, integer,
  integer, integer, text, text, integer
) from public, anon, authenticated, service_role;
revoke all on function public.apply_revenuecat_entitlement_event_without_commercial_terms(
  uuid, timestamptz, text, jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.claim_revolut_checkout_intent(
  text, uuid, text, text, text, integer, text, integer, integer
) from public, anon, authenticated;
revoke all on function public.claim_revolut_billing_cycle(
  text, uuid, text, timestamptz, integer, text, text, integer, integer,
  integer, integer, text, text, integer
) from public, anon, authenticated;
revoke all on function public.reconcile_completed_revolut_resubscribe(
  text, uuid, text, integer, text, boolean, text, text, text, text, text, text
) from public, anon, authenticated;
revoke all on function public.resolve_revolut_resubscribe_refund(text, uuid)
  from public, anon, authenticated;
revoke all on function public.claim_revolut_full_refund(
  text, uuid, text, integer, text, text, integer
) from public, anon, authenticated;
revoke all on function public.fail_revolut_full_refund(text, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.mark_revolut_full_refund_processing(
  text, uuid, text, text, jsonb
) from public, anon, authenticated;
revoke all on function public.fail_revolut_refund_order(text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.complete_revolut_full_refund(
  text, uuid, text, text, text, integer, text, jsonb
) from public, anon, authenticated;
revoke all on function public.apply_revenuecat_entitlement_event_nonblocked(
  uuid, timestamptz, text, jsonb
) from public, anon, authenticated, service_role;

grant execute on function public.claim_revolut_checkout_intent(
  text, uuid, text, text, text, integer, text, integer, integer
) to service_role;
grant execute on function public.claim_revolut_billing_cycle(
  text, uuid, text, timestamptz, integer, text, text, integer, integer,
  integer, integer, text, text, integer
) to service_role;
grant execute on function public.reconcile_completed_revolut_resubscribe(
  text, uuid, text, integer, text, boolean, text, text, text, text, text, text
) to service_role;
grant execute on function public.resolve_revolut_resubscribe_refund(text, uuid)
  to service_role;
grant execute on function public.claim_revolut_full_refund(
  text, uuid, text, integer, text, text, integer
) to service_role;
grant execute on function public.fail_revolut_full_refund(text, uuid, text, text)
  to service_role;
grant execute on function public.mark_revolut_full_refund_processing(
  text, uuid, text, text, jsonb
) to service_role;
grant execute on function public.fail_revolut_refund_order(text, text, jsonb)
  to service_role;
grant execute on function public.complete_revolut_full_refund(
  text, uuid, text, text, text, integer, text, jsonb
) to service_role;
grant execute on function public.apply_revenuecat_entitlement_event_nonblocked(
  uuid, timestamptz, text, jsonb
) to service_role;

notify pgrst, 'reload schema';
