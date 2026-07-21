-- Revolut recurring billing reliability.
--
-- A remote order id does not exist until after POST /orders, so the order journal
-- alone cannot prevent two cron isolates from charging the same renewal cycle.
-- This table reserves the business cycle first, snapshots the approved amount,
-- and keeps ambiguous network outcomes resumable instead of classifying them as
-- payment failures.

create table if not exists public.cloud_revolut_billing_attempts (
  cycle_key              text primary key,
  user_id                uuid not null references auth.users(id) on delete cascade,
  kind                   text not null check (kind in ('first_charge', 'renewal')),
  cycle_anchor           timestamptz not null,
  retry_attempt          smallint not null default 0 check (retry_attempt between 0 and 8),
  plan_code              text not null check (plan_code in ('plus', 'family')),
  bill_period            text not null check (bill_period in ('monthly', 'annual')),
  amount_cents           integer not null check (amount_cents between 1 and 9999999),
  discount_pct           smallint not null default 0 check (discount_pct between 0 and 99),
  promo_cycles_before    integer check (promo_cycles_before between 1 and 24),
  base_amount_cents      integer check (base_amount_cents between 1 and 9999999),
  currency               text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  merchant_ext_ref       text not null unique,
  status                 text not null default 'creating'
                         check (status in (
                           'creating', 'order_created', 'payment_pending',
                           'completed', 'failed', 'unknown'
                         )),
  lease_token            text,
  lease_expires_at       timestamptz,
  order_id               text unique,
  payment_id             text,
  remote_state           text,
  last_error             text,
  generation             bigint not null default 1,
  completed_at           timestamptz,
  failed_at              timestamptz,
  applied_at             timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

alter table public.cloud_revolut_billing_attempts enable row level security;

-- A later dunning retry must not start while an earlier attempt has an unknown
-- outcome.  Terminal+applied and failed+applied rows no longer occupy this slot.
create unique index if not exists uq_revolut_billing_attempts_inflight_user
  on public.cloud_revolut_billing_attempts (user_id)
  where applied_at is null
    and status in ('creating', 'order_created', 'payment_pending', 'completed', 'failed', 'unknown');

create index if not exists idx_revolut_billing_attempts_resume
  on public.cloud_revolut_billing_attempts (lease_expires_at, updated_at)
  where applied_at is null;

-- Claim or resume one immutable billing cycle.  The user advisory lock makes the
-- partial unique index deterministic and returns `blocked` when an earlier cycle
-- still needs reconciliation.  The financial snapshot of an existing attempt is
-- always returned; a later catalog/mapping change cannot reprice an in-flight debit.
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
  action text,
  status text,
  order_id text,
  payment_id text,
  merchant_ext_ref text,
  amount_cents integer,
  plan_code text,
  bill_period text,
  discount_pct integer,
  promo_cycles_before integer,
  base_amount_cents integer,
  remote_state text,
  generation bigint
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_lease interval := make_interval(secs => greatest(30, least(300, coalesce(p_lease_seconds, 90))));
  v_attempt public.cloud_revolut_billing_attempts%rowtype;
  v_other public.cloud_revolut_billing_attempts%rowtype;
  v_action text;
begin
  if coalesce(btrim(p_cycle_key), '') = ''
     or coalesce(btrim(p_merchant_ext_ref), '') = ''
     or coalesce(btrim(p_lease_token), '') = '' then
    raise exception 'cycle_key, merchant_ext_ref and lease_token are required';
  end if;
  if p_kind not in ('first_charge', 'renewal')
     or p_retry_attempt not between 0 and 8
     or p_plan_code not in ('plus', 'family')
     or p_bill_period not in ('monthly', 'annual')
     or p_amount_cents not between 1 and 9999999
     or p_discount_pct not between 0 and 99 then
    raise exception 'invalid Revolut billing cycle claim';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('norva:revolut:billing:' || p_user_id::text, 0)
  );

  select * into v_other
  from public.cloud_revolut_billing_attempts a
  where a.user_id = p_user_id
    and a.cycle_key <> p_cycle_key
    and a.applied_at is null
    and a.status in ('creating', 'order_created', 'payment_pending', 'completed', 'failed', 'unknown')
  order by a.updated_at desc
  limit 1
  for update;

  if found then
    return query select
      'blocked'::text, v_other.status, v_other.order_id, v_other.payment_id,
      v_other.merchant_ext_ref, v_other.amount_cents, v_other.plan_code,
      v_other.bill_period, v_other.discount_pct::integer,
      v_other.promo_cycles_before, v_other.base_amount_cents,
      v_other.remote_state, v_other.generation;
    return;
  end if;

  insert into public.cloud_revolut_billing_attempts (
    cycle_key, user_id, kind, cycle_anchor, retry_attempt, plan_code,
    bill_period, amount_cents, discount_pct, promo_cycles_before,
    base_amount_cents, merchant_ext_ref, status, lease_token, lease_expires_at
  ) values (
    p_cycle_key, p_user_id, p_kind, p_cycle_anchor, p_retry_attempt,
    p_plan_code, p_bill_period, p_amount_cents, p_discount_pct,
    p_promo_cycles_before, p_base_amount_cents, p_merchant_ext_ref,
    'creating', p_lease_token, v_now + v_lease
  ) on conflict (cycle_key) do nothing;

  select * into v_attempt
  from public.cloud_revolut_billing_attempts a
  where a.cycle_key = p_cycle_key
  for update;

  if v_attempt.user_id <> p_user_id
     or v_attempt.kind <> p_kind
     or v_attempt.cycle_anchor <> p_cycle_anchor
     or v_attempt.retry_attempt <> p_retry_attempt
     or v_attempt.merchant_ext_ref <> p_merchant_ext_ref then
    raise exception 'Revolut billing cycle ownership mismatch';
  end if;

  if v_attempt.applied_at is not null then
    v_action := case when v_attempt.status = 'completed' then 'done' else 'failed' end;
    return query select
      v_action, v_attempt.status, v_attempt.order_id, v_attempt.payment_id,
      v_attempt.merchant_ext_ref, v_attempt.amount_cents, v_attempt.plan_code,
      v_attempt.bill_period, v_attempt.discount_pct::integer,
      v_attempt.promo_cycles_before, v_attempt.base_amount_cents,
      v_attempt.remote_state, v_attempt.generation;
    return;
  end if;

  if v_attempt.lease_token is distinct from p_lease_token
     and v_attempt.lease_expires_at > v_now then
    return query select
      'wait'::text, v_attempt.status, v_attempt.order_id, v_attempt.payment_id,
      v_attempt.merchant_ext_ref, v_attempt.amount_cents, v_attempt.plan_code,
      v_attempt.bill_period, v_attempt.discount_pct::integer,
      v_attempt.promo_cycles_before, v_attempt.base_amount_cents,
      v_attempt.remote_state, v_attempt.generation;
    return;
  end if;

  update public.cloud_revolut_billing_attempts a
  set lease_token = p_lease_token,
      lease_expires_at = v_now + v_lease,
      generation = case
        when a.lease_token is distinct from p_lease_token then a.generation + 1
        else a.generation
      end,
      updated_at = v_now
  where a.cycle_key = p_cycle_key
  returning * into v_attempt;

  v_action := case
    when v_attempt.status = 'completed' then 'apply'
    when v_attempt.status = 'failed' then 'apply_failed'
    when v_attempt.order_id is not null then 'resume'
    else 'create'
  end;

  return query select
    v_action, v_attempt.status, v_attempt.order_id, v_attempt.payment_id,
    v_attempt.merchant_ext_ref, v_attempt.amount_cents, v_attempt.plan_code,
    v_attempt.bill_period, v_attempt.discount_pct::integer,
    v_attempt.promo_cycles_before, v_attempt.base_amount_cents,
    v_attempt.remote_state, v_attempt.generation;
end
$function$;

-- CAS every remote transition against the current lease.  `completed` and
-- `failed` retain the lease so the same worker can atomically apply the local
-- entitlement transition.  Pending/unknown releases it for a later cron run.
create or replace function public.record_revolut_billing_attempt(
  p_cycle_key text,
  p_lease_token text,
  p_status text,
  p_order_id text default null,
  p_payment_id text default null,
  p_remote_state text default null,
  p_error text default null,
  p_release_lease boolean default false
) returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_changed integer;
  v_now timestamptz := clock_timestamp();
begin
  if p_status not in ('creating', 'order_created', 'payment_pending', 'completed', 'failed', 'unknown') then
    raise exception 'invalid Revolut billing attempt status';
  end if;

  update public.cloud_revolut_billing_attempts a
  set status = p_status,
      order_id = coalesce(p_order_id, a.order_id),
      payment_id = coalesce(p_payment_id, a.payment_id),
      remote_state = coalesce(nullif(upper(p_remote_state), ''), a.remote_state),
      last_error = case when p_error is null then a.last_error else left(p_error, 1000) end,
      completed_at = case when p_status = 'completed' then coalesce(a.completed_at, v_now) else a.completed_at end,
      failed_at = case when p_status = 'failed' then coalesce(a.failed_at, v_now) else a.failed_at end,
      lease_token = case when p_release_lease then null else a.lease_token end,
      lease_expires_at = case when p_release_lease then null else a.lease_expires_at end,
      updated_at = v_now
  where a.cycle_key = p_cycle_key
    and a.applied_at is null
    and a.lease_token = p_lease_token
    -- Remote final states are monotonic.  A late timeout/error handler must never
    -- downgrade a confirmed COMPLETED/failed attempt and make it chargeable again.
    and case a.status
      when 'completed' then p_status = 'completed'
      when 'failed' then p_status = 'failed'
      when 'payment_pending' then p_status in ('payment_pending', 'completed', 'failed', 'unknown')
      when 'order_created' then p_status in ('order_created', 'payment_pending', 'completed', 'failed', 'unknown')
      when 'unknown' then p_status in ('order_created', 'payment_pending', 'completed', 'failed', 'unknown')
      else p_status in ('creating', 'order_created', 'payment_pending', 'completed', 'failed', 'unknown')
    end
    -- Once known, provider identifiers belong to this immutable cycle.
    and (a.order_id is null or p_order_id is null or a.order_id = p_order_id)
    and (a.payment_id is null or p_payment_id is null or a.payment_id = p_payment_id);
  get diagnostics v_changed = row_count;
  return v_changed = 1;
end
$function$;

-- Apply a confirmed COMPLETED order exactly once.  Projection and promo counters
-- move in the same transaction as applied_at, so a crash cannot consume two promo
-- cycles or extend access twice.
create or replace function public.apply_revolut_billing_success(
  p_cycle_key text,
  p_lease_token text,
  p_next_period_end timestamptz
) returns table(applied boolean, already_applied boolean, warning text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_attempt public.cloud_revolut_billing_attempts%rowtype;
  v_projection public.cloud_entitlement_projection%rowtype;
  v_changed integer := 0;
  v_warning text;
  v_left integer;
begin
  select * into v_attempt
  from public.cloud_revolut_billing_attempts a
  where a.cycle_key = p_cycle_key
  for update;

  if not found then raise exception 'billing attempt not found'; end if;
  if v_attempt.applied_at is not null then
    return query select false, true, null::text;
    return;
  end if;
  if v_attempt.status <> 'completed' or v_attempt.lease_token is distinct from p_lease_token then
    raise exception 'billing attempt is not claimable for success application';
  end if;

  update public.cloud_entitlement_projection p
  set status = 'active',
      provider = 'revolut',
      current_period_end = p_next_period_end,
      plan_code = v_attempt.plan_code,
      fail_open_until = null,
      dunning_stage = 0,
      dunning_last_at = null,
      billing_retry_count = 0,
      last_event_at = v_now,
      last_verified_at = v_now,
      mrr_cents = v_attempt.amount_cents,
      bill_period = v_attempt.bill_period
  where p.user_id = v_attempt.user_id
    and p.provider = 'revolut'
    and (
      (v_attempt.kind = 'first_charge'
        and p.status = 'trialing'
        and p.trial_ends_at = v_attempt.cycle_anchor)
      or
      (v_attempt.kind = 'renewal' and v_attempt.retry_attempt = 0
        and p.status = 'active'
        and p.current_period_end = v_attempt.cycle_anchor)
      or
      (v_attempt.kind = 'renewal' and v_attempt.retry_attempt > 0
        and p.status = 'past_due'
        and p.current_period_end = v_attempt.cycle_anchor
        and coalesce(p.billing_retry_count, 0) = v_attempt.retry_attempt - 1)
    );
  get diagnostics v_changed = row_count;

  if v_changed = 0 then
    select * into v_projection
    from public.cloud_entitlement_projection p
    where p.user_id = v_attempt.user_id;
    if not found
       or v_projection.provider <> 'revolut'
       or v_projection.status <> 'active'
       or v_projection.current_period_end is distinct from p_next_period_end
       or v_projection.plan_code is distinct from v_attempt.plan_code
       or v_projection.bill_period is distinct from v_attempt.bill_period then
      raise exception 'projection_cas_conflict';
    end if;
    v_warning := 'projection_already_advanced';
  end if;

  if v_attempt.discount_pct > 0 then
    update public.cloud_revolut_customers c
    set discount_next_pct = null, updated_at = v_now
    where c.user_id = v_attempt.user_id
      and c.discount_next_pct = v_attempt.discount_pct;
    if not found then
      v_warning := concat_ws(',', v_warning, 'discount_changed');
    end if;
  end if;

  if v_attempt.promo_cycles_before is not null and v_attempt.promo_cycles_before > 0 then
    v_left := v_attempt.promo_cycles_before - 1;
    update public.cloud_revolut_customers c
    set promo_cycles_left = case when v_left <= 0 then null else v_left end,
        base_amount_cents = case when v_left <= 0 then null else c.base_amount_cents end,
        amount_cents = case
          when v_left <= 0 and v_attempt.base_amount_cents is not null
            then v_attempt.base_amount_cents
          else c.amount_cents
        end,
        updated_at = v_now
    where c.user_id = v_attempt.user_id
      and c.promo_cycles_left = v_attempt.promo_cycles_before;
    if not found then
      v_warning := concat_ws(',', v_warning, 'promo_counter_changed');
    end if;
  end if;

  update public.cloud_revolut_billing_attempts a
  set applied_at = v_now,
      lease_token = null,
      lease_expires_at = null,
      last_error = v_warning,
      updated_at = v_now
  where a.cycle_key = p_cycle_key
    and a.lease_token = p_lease_token
    and a.applied_at is null;
  if not found then raise exception 'billing success lease lost'; end if;

  return query select true, false, v_warning;
end
$function$;

-- Apply a definitive payment failure once.  An unrelated cancellation or admin
-- transition wins the CAS and is never overwritten by this cron.
create or replace function public.apply_revolut_billing_failure(
  p_cycle_key text,
  p_lease_token text,
  p_fail_open_until timestamptz default null
) returns table(applied boolean, already_applied boolean, warning text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_attempt public.cloud_revolut_billing_attempts%rowtype;
  v_projection public.cloud_entitlement_projection%rowtype;
  v_changed integer := 0;
  v_warning text;
begin
  select * into v_attempt
  from public.cloud_revolut_billing_attempts a
  where a.cycle_key = p_cycle_key
  for update;

  if not found then raise exception 'billing attempt not found'; end if;
  if v_attempt.applied_at is not null then
    return query select false, true, null::text;
    return;
  end if;
  if v_attempt.status <> 'failed' or v_attempt.lease_token is distinct from p_lease_token then
    raise exception 'billing attempt is not claimable for failure application';
  end if;

  update public.cloud_entitlement_projection p
  set status = 'past_due',
      last_event_at = v_now,
      fail_open_until = case
        when v_attempt.retry_attempt = 0 then p_fail_open_until
        else p.fail_open_until
      end,
      billing_retry_count = case
        when v_attempt.retry_attempt > 0 then v_attempt.retry_attempt
        else coalesce(p.billing_retry_count, 0)
      end
  where p.user_id = v_attempt.user_id
    and p.provider = 'revolut'
    and (
      (v_attempt.kind = 'first_charge'
        and p.status = 'trialing'
        and p.trial_ends_at = v_attempt.cycle_anchor)
      or
      (v_attempt.kind = 'renewal' and v_attempt.retry_attempt = 0
        and p.status = 'active'
        and p.current_period_end = v_attempt.cycle_anchor)
      or
      (v_attempt.kind = 'renewal' and v_attempt.retry_attempt > 0
        and p.status = 'past_due'
        and p.current_period_end = v_attempt.cycle_anchor
        and coalesce(p.billing_retry_count, 0) = v_attempt.retry_attempt - 1)
    );
  get diagnostics v_changed = row_count;

  if v_changed = 0 then
    select * into v_projection
    from public.cloud_entitlement_projection p
    where p.user_id = v_attempt.user_id;
    if found and v_projection.provider = 'revolut' and (
      (v_attempt.retry_attempt = 0 and v_projection.status = 'past_due')
      or
      (v_attempt.retry_attempt > 0 and v_projection.status = 'past_due'
        and coalesce(v_projection.billing_retry_count, 0) >= v_attempt.retry_attempt)
    ) then
      v_warning := 'projection_already_failed';
    else
      -- Cancellation/expiry/admin changes are authoritative; record the conflict
      -- but never put such an account back into past_due.
      v_warning := 'projection_changed_elsewhere';
    end if;
  end if;

  update public.cloud_revolut_billing_attempts a
  set applied_at = v_now,
      lease_token = null,
      lease_expires_at = null,
      last_error = coalesce(v_warning, a.last_error),
      updated_at = v_now
  where a.cycle_key = p_cycle_key
    and a.lease_token = p_lease_token
    and a.applied_at is null;
  if not found then raise exception 'billing failure lease lost'; end if;

  return query select true, false, v_warning;
end
$function$;

revoke all on table public.cloud_revolut_billing_attempts from public, anon, authenticated;
revoke all on function public.claim_revolut_billing_cycle(
  text, uuid, text, timestamptz, integer, text, text, integer, integer,
  integer, integer, text, text, integer
) from public, anon, authenticated;
revoke all on function public.record_revolut_billing_attempt(
  text, text, text, text, text, text, text, boolean
) from public, anon, authenticated;
revoke all on function public.apply_revolut_billing_success(text, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.apply_revolut_billing_failure(text, text, timestamptz)
  from public, anon, authenticated;

grant all on table public.cloud_revolut_billing_attempts to service_role;
grant execute on function public.claim_revolut_billing_cycle(
  text, uuid, text, timestamptz, integer, text, text, integer, integer,
  integer, integer, text, text, integer
) to service_role;
grant execute on function public.record_revolut_billing_attempt(
  text, text, text, text, text, text, text, boolean
) to service_role;
grant execute on function public.apply_revolut_billing_success(text, text, timestamptz)
  to service_role;
grant execute on function public.apply_revolut_billing_failure(text, text, timestamptz)
  to service_role;
