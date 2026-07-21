-- Revolut plan changes are scheduled for the next billing boundary.
--
-- Checkout authorisation only records the requested plan.  The billing-cycle
-- claim snapshots that request into the immutable attempt, and the active plan
-- is promoted only inside apply_revolut_billing_success, after the provider order
-- has reached COMPLETED.  A failed/pending debit therefore never grants a new
-- plan, and a newer checkout cannot reprice an already claimed debit.

alter table public.cloud_revolut_customers
  add column if not exists pending_plan text,
  add column if not exists pending_period text,
  add column if not exists pending_amount_cents integer,
  add column if not exists pending_base_amount_cents integer,
  add column if not exists pending_promo_cycles integer,
  add column if not exists pending_effective_at timestamptz,
  add column if not exists pending_order_id text;

alter table public.cloud_revolut_billing_attempts
  add column if not exists scheduled_plan_change boolean not null default false,
  add column if not exists scheduled_change_order_id text,
  add column if not exists scheduled_recurring_amount_cents integer,
  add column if not exists scheduled_base_amount_cents integer,
  add column if not exists scheduled_promo_cycles integer;

do $constraints$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.cloud_revolut_customers'::regclass
      and conname = 'cloud_revolut_customers_pending_plan_check'
  ) then
    alter table public.cloud_revolut_customers
      add constraint cloud_revolut_customers_pending_plan_check
      check (pending_plan is null or pending_plan in ('plus', 'family'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.cloud_revolut_customers'::regclass
      and conname = 'cloud_revolut_customers_pending_period_check'
  ) then
    alter table public.cloud_revolut_customers
      add constraint cloud_revolut_customers_pending_period_check
      check (pending_period is null or pending_period in ('monthly', 'annual'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.cloud_revolut_customers'::regclass
      and conname = 'cloud_revolut_customers_pending_amount_check'
  ) then
    alter table public.cloud_revolut_customers
      add constraint cloud_revolut_customers_pending_amount_check
      check (pending_amount_cents is null or pending_amount_cents between 1 and 9999999);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.cloud_revolut_customers'::regclass
      and conname = 'cloud_revolut_customers_pending_base_amount_check'
  ) then
    alter table public.cloud_revolut_customers
      add constraint cloud_revolut_customers_pending_base_amount_check
      check (pending_base_amount_cents is null or pending_base_amount_cents between 1 and 9999999);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.cloud_revolut_customers'::regclass
      and conname = 'cloud_revolut_customers_pending_promo_cycles_check'
  ) then
    alter table public.cloud_revolut_customers
      add constraint cloud_revolut_customers_pending_promo_cycles_check
      check (pending_promo_cycles is null or pending_promo_cycles between 1 and 24);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.cloud_revolut_billing_attempts'::regclass
      and conname = 'cloud_revolut_attempts_scheduled_amount_check'
  ) then
    alter table public.cloud_revolut_billing_attempts
      add constraint cloud_revolut_attempts_scheduled_amount_check
      check (scheduled_recurring_amount_cents is null or scheduled_recurring_amount_cents between 1 and 9999999);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.cloud_revolut_billing_attempts'::regclass
      and conname = 'cloud_revolut_attempts_scheduled_base_check'
  ) then
    alter table public.cloud_revolut_billing_attempts
      add constraint cloud_revolut_attempts_scheduled_base_check
      check (scheduled_base_amount_cents is null or scheduled_base_amount_cents between 1 and 9999999);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.cloud_revolut_billing_attempts'::regclass
      and conname = 'cloud_revolut_attempts_scheduled_cycles_check'
  ) then
    alter table public.cloud_revolut_billing_attempts
      add constraint cloud_revolut_attempts_scheduled_cycles_check
      check (scheduled_promo_cycles is null or scheduled_promo_cycles between 1 and 24);
  end if;
end
$constraints$;

create or replace function public.snapshot_revolut_pending_plan_change()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_customer public.cloud_revolut_customers%rowtype;
begin
  select * into v_customer
  from public.cloud_revolut_customers c
  where c.user_id = new.user_id
  for update;

  if found
     and v_customer.pending_plan in ('plus', 'family')
     and v_customer.pending_period in ('monthly', 'annual')
     and v_customer.pending_amount_cents between 1 and 9999999
     and v_customer.pending_effective_at is not null
     and v_customer.pending_effective_at <= new.cycle_anchor then
    new.plan_code := v_customer.pending_plan;
    new.bill_period := v_customer.pending_period;
    new.amount_cents := case
      when new.discount_pct > 0
        then greatest(50, round(v_customer.pending_amount_cents * (100 - new.discount_pct) / 100.0)::integer)
      else v_customer.pending_amount_cents
    end;
    -- The pending promotion has its own counters.  The base success function
    -- must not decrement counters belonging to the currently active plan.
    new.promo_cycles_before := null;
    new.base_amount_cents := null;
    new.scheduled_plan_change := true;
    new.scheduled_change_order_id := v_customer.pending_order_id;
    new.scheduled_recurring_amount_cents := v_customer.pending_amount_cents;
    new.scheduled_base_amount_cents := v_customer.pending_base_amount_cents;
    new.scheduled_promo_cycles := v_customer.pending_promo_cycles;
  end if;
  return new;
end
$function$;

drop trigger if exists trg_snapshot_revolut_pending_plan_change
  on public.cloud_revolut_billing_attempts;
create trigger trg_snapshot_revolut_pending_plan_change
before insert on public.cloud_revolut_billing_attempts
for each row execute function public.snapshot_revolut_pending_plan_change();

do $rename$
begin
  if to_regprocedure('public.apply_revolut_billing_success_base(text,text,timestamptz)') is null then
    alter function public.apply_revolut_billing_success(text, text, timestamptz)
      rename to apply_revolut_billing_success_base;
  end if;
end
$rename$;

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
  v_applied boolean;
  v_already_applied boolean;
  v_warning text;
  v_attempt public.cloud_revolut_billing_attempts%rowtype;
  v_pending_matches boolean;
  v_cycles_left integer;
begin
  select r.applied, r.already_applied, r.warning
  into v_applied, v_already_applied, v_warning
  from public.apply_revolut_billing_success_base(
    p_cycle_key, p_lease_token, p_next_period_end
  ) r;

  if v_applied then
    select * into v_attempt
    from public.cloud_revolut_billing_attempts a
    where a.cycle_key = p_cycle_key;

    if v_attempt.scheduled_plan_change then
      if v_attempt.scheduled_recurring_amount_cents is null then
        raise exception 'scheduled plan change amount missing';
      end if;
      v_cycles_left := case
        when v_attempt.scheduled_promo_cycles is null then null
        else greatest(v_attempt.scheduled_promo_cycles - 1, 0)
      end;

      select c.pending_order_id is not distinct from v_attempt.scheduled_change_order_id
      into v_pending_matches
      from public.cloud_revolut_customers c
      where c.user_id = v_attempt.user_id
      for update;
      if not found then raise exception 'Revolut customer mapping missing'; end if;

      update public.cloud_revolut_customers c
      set plan = v_attempt.plan_code,
          period = v_attempt.bill_period,
          amount_cents = case
            when v_cycles_left = 0 and v_attempt.scheduled_base_amount_cents is not null
              then v_attempt.scheduled_base_amount_cents
            else v_attempt.scheduled_recurring_amount_cents
          end,
          base_amount_cents = case
            when v_cycles_left is not null and v_cycles_left > 0
              then v_attempt.scheduled_base_amount_cents
            else null
          end,
          promo_cycles_left = case when v_cycles_left > 0 then v_cycles_left else null end,
          pending_plan = case when v_pending_matches then null else c.pending_plan end,
          pending_period = case when v_pending_matches then null else c.pending_period end,
          pending_amount_cents = case when v_pending_matches then null else c.pending_amount_cents end,
          pending_base_amount_cents = case when v_pending_matches then null else c.pending_base_amount_cents end,
          pending_promo_cycles = case when v_pending_matches then null else c.pending_promo_cycles end,
          pending_effective_at = case when v_pending_matches then null else c.pending_effective_at end,
          pending_order_id = case when v_pending_matches then null else c.pending_order_id end,
          updated_at = clock_timestamp()
      where c.user_id = v_attempt.user_id;
      if not found then raise exception 'scheduled plan change promotion failed'; end if;
    end if;
  end if;

  return query select v_applied, v_already_applied, v_warning;
end
$function$;

comment on column public.cloud_revolut_customers.pending_effective_at is
  'Billing boundary at which a Revolut plan change may first be charged and promoted.';

revoke all on function public.snapshot_revolut_pending_plan_change()
  from public, anon, authenticated, service_role;
revoke all on function public.apply_revolut_billing_success_base(text, text, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.apply_revolut_billing_success(text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.apply_revolut_billing_success(text, text, timestamptz)
  to service_role;

notify pgrst, 'reload schema';
