-- Revolut checkout reliability: immutable order intent, idempotent creation leases,
-- terminal/reconciliation markers, and an atomic abandoned-checkout claim.
--
-- The payment journal is never deleted.  A checkout refresh must reuse the same
-- remote order, and concurrent browser boots must elect a single creator before
-- any POST reaches Revolut.

alter table public.cloud_revolut_orders
  add column if not exists plan text,
  add column if not exists period text,
  add column if not exists requested_amount_cents integer,
  add column if not exists merchant_ext_ref text,
  add column if not exists checkout_url text,
  add column if not exists intent_key text,
  add column if not exists expires_at timestamptz,
  add column if not exists finalized_at timestamptz,
  add column if not exists expired_at timestamptz,
  add column if not exists superseded_at timestamptz,
  add column if not exists reminder_claimed_at timestamptz,
  add column if not exists reminder_sent_at timestamptz,
  add column if not exists last_reconciled_at timestamptz,
  add column if not exists finalization_result jsonb,
  add column if not exists cycle_key text,
  add column if not exists retry_attempt smallint not null default 0;

-- Normalize the legacy rows before the checks/index predicates below are added.
update public.cloud_revolut_orders
set state = upper(state),
    currency = upper(currency),
    updated_at = coalesce(updated_at, now())
where state is distinct from upper(state)
   or currency is distinct from upper(currency)
   or updated_at is null;

update public.cloud_revolut_orders
set expires_at = created_at + interval '30 minutes'
where expires_at is null
  and kind in ('trial_setup', 'plan_change', 'resubscribe', 'card_update');

-- Do NOT infer Norva finalization from a provider state.  In this integration an
-- AUTHORISED order is only the temporary card-validation hold, and CANCELLED can
-- either mean an abandoned checkout or a hold that Norva released *after* applying
-- the entitlement.  Historical rows therefore stay unfinalized until the bounded
-- reconciler re-fetches the order and records the actual application result.

do $constraints$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.cloud_revolut_orders'::regclass
      and conname = 'cloud_revolut_orders_plan_check'
  ) then
    alter table public.cloud_revolut_orders
      add constraint cloud_revolut_orders_plan_check
      check (plan is null or plan in ('plus', 'family'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.cloud_revolut_orders'::regclass
      and conname = 'cloud_revolut_orders_period_check'
  ) then
    alter table public.cloud_revolut_orders
      add constraint cloud_revolut_orders_period_check
      check (period is null or period in ('monthly', 'annual'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.cloud_revolut_orders'::regclass
      and conname = 'cloud_revolut_orders_currency_check'
  ) then
    alter table public.cloud_revolut_orders
      add constraint cloud_revolut_orders_currency_check
      check (currency is null or currency ~ '^[A-Z]{3}$');
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.cloud_revolut_orders'::regclass
      and conname = 'cloud_revolut_orders_requested_amount_check'
  ) then
    alter table public.cloud_revolut_orders
      add constraint cloud_revolut_orders_requested_amount_check
      check (requested_amount_cents is null or requested_amount_cents between 1 and 9999999);
  end if;
end
$constraints$;

create index if not exists idx_revolut_orders_open_expiry
  on public.cloud_revolut_orders (expires_at, created_at)
  where finalized_at is null and expired_at is null and superseded_at is null;

create index if not exists idx_revolut_orders_abandoned
  on public.cloud_revolut_orders (created_at, user_id)
  where kind in ('trial_setup', 'resubscribe')
    and reminder_sent_at is null;

create unique index if not exists uq_revolut_orders_cycle_key
  on public.cloud_revolut_orders (cycle_key)
  where cycle_key is not null;

create table if not exists public.cloud_revolut_checkout_intents (
  intent_key       text primary key,
  user_id          uuid not null references auth.users(id) on delete cascade,
  kind             text not null,
  plan             text not null check (plan in ('plus', 'family')),
  period           text not null check (period in ('monthly', 'annual')),
  amount_cents     integer not null check (amount_cents between 1 and 9999999),
  status           text not null default 'creating'
                   check (status in ('creating', 'ready', 'finalized', 'failed', 'expired')),
  lease_token      text,
  lease_expires_at timestamptz,
  expires_at       timestamptz not null,
  order_id         text references public.cloud_revolut_orders(order_id) on delete set null,
  last_error       text,
  generation       bigint not null default 1,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

alter table public.cloud_revolut_checkout_intents enable row level security;

create index if not exists idx_revolut_checkout_intents_expiry
  on public.cloud_revolut_checkout_intents (expires_at, status);

create unique index if not exists uq_revolut_checkout_intents_current_user
  on public.cloud_revolut_checkout_intents (user_id)
  where status in ('creating', 'ready');

-- Elect exactly one remote-order creator.  The row lock spans this transaction,
-- while lease_expires_at lets another request recover after a crashed Edge call.
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
  action text,
  order_id text,
  public_id text,
  checkout_url text,
  expires_at timestamptz,
  previous_order_id text,
  generation bigint
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_ttl interval := make_interval(secs => greatest(300, least(3600, coalesce(p_ttl_seconds, 1800))));
  v_lease interval := make_interval(secs => greatest(15, least(180, coalesce(p_lease_seconds, 60))));
  v_intent public.cloud_revolut_checkout_intents%rowtype;
  v_other public.cloud_revolut_checkout_intents%rowtype;
  v_order public.cloud_revolut_orders%rowtype;
  v_previous text;
  v_generation bigint;
  v_recovery boolean := false;
begin
  if coalesce(btrim(p_intent_key), '') = '' or coalesce(btrim(p_lease_token), '') = '' then
    raise exception 'intent_key and lease_token are required';
  end if;
  if p_kind not in ('trial_setup', 'plan_change', 'resubscribe', 'card_update')
     or p_plan not in ('plus', 'family')
     or p_period not in ('monthly', 'annual')
     or p_amount_cents not between 1 and 9999999 then
    raise exception 'invalid checkout intent';
  end if;

  -- One current checkout per account.  This also serializes two different plan
  -- selections racing from separate tabs.  A fresh creator lease wins; an older
  -- ready intent is expired/superseded before the new selection is opened.
  perform pg_advisory_xact_lock(hashtextextended('norva:revolut:checkout:' || p_user_id::text, 0));
  select * into v_other
  from public.cloud_revolut_checkout_intents i
  where i.user_id = p_user_id
    and i.intent_key <> p_intent_key
    and i.status in ('creating', 'ready')
  order by i.updated_at desc
  limit 1
  for update;

  if found then
    if v_other.status = 'creating' and v_other.lease_expires_at > v_now then
      return query select
        'wait'::text, null::text, null::text, null::text,
        v_other.expires_at, v_other.order_id, v_other.generation;
      return;
    end if;
    v_previous := v_other.order_id;
    update public.cloud_revolut_checkout_intents i
    set status = 'expired', lease_token = null, lease_expires_at = null,
        updated_at = v_now
    where i.intent_key = v_other.intent_key;
    if v_other.order_id is not null then
      update public.cloud_revolut_orders o
      set superseded_at = coalesce(o.superseded_at, v_now), updated_at = v_now
      where o.order_id = v_other.order_id and o.finalized_at is null;
    end if;
  end if;

  insert into public.cloud_revolut_checkout_intents (
    intent_key, user_id, kind, plan, period, amount_cents, status,
    lease_token, lease_expires_at, expires_at
  ) values (
    p_intent_key, p_user_id, p_kind, p_plan, p_period, p_amount_cents, 'creating',
    p_lease_token, v_now + v_lease, v_now + v_ttl
  ) on conflict (intent_key) do nothing;

  select * into v_intent
  from public.cloud_revolut_checkout_intents i
  where i.intent_key = p_intent_key
  for update;

  if v_intent.user_id <> p_user_id
     or v_intent.kind <> p_kind
     or v_intent.plan <> p_plan
     or v_intent.period <> p_period
     or v_intent.amount_cents <> p_amount_cents then
    raise exception 'checkout intent ownership mismatch';
  end if;

  -- Recover a remote order that was journalled successfully but whose intent
  -- completion RPC failed.  Without this bridge a lease takeover would POST a
  -- second provider order even though the first one is already known locally.
  select * into v_order
  from public.cloud_revolut_orders o
  where o.intent_key = p_intent_key
    and o.user_id = p_user_id
    and o.public_id is not null
    and o.finalized_at is null
    and o.expired_at is null
    and o.superseded_at is null
    and upper(coalesce(o.state, 'PENDING')) in (
      'PENDING', 'PROCESSING', 'AUTHORISED', 'COMPLETED'
    )
    and coalesce(o.expires_at, v_intent.expires_at) > v_now
  order by o.created_at desc, o.order_id desc
  limit 1
  for update;

  if found then
    update public.cloud_revolut_checkout_intents i
    set status = 'ready', order_id = v_order.order_id,
        lease_token = null, lease_expires_at = null,
        expires_at = coalesce(v_order.expires_at, i.expires_at),
        updated_at = v_now
    where i.intent_key = p_intent_key;
    return query select
      'reuse'::text, v_order.order_id, v_order.public_id, v_order.checkout_url,
      coalesce(v_order.expires_at, v_intent.expires_at), null::text, v_intent.generation;
    return;
  end if;

  if v_intent.status = 'ready'
     and v_intent.expires_at > v_now
     and v_intent.order_id is not null then
    select * into v_order
    from public.cloud_revolut_orders o
    where o.order_id = v_intent.order_id;

    if found
       and upper(coalesce(v_order.state, 'PENDING')) in (
         'PENDING', 'PROCESSING', 'AUTHORISED', 'COMPLETED'
       )
       and v_order.public_id is not null
       and v_order.finalized_at is null
       and v_order.expired_at is null
       and v_order.superseded_at is null
       and coalesce(v_order.expires_at, v_intent.expires_at) > v_now then
      return query select
        'reuse'::text, v_order.order_id, v_order.public_id, v_order.checkout_url,
        coalesce(v_order.expires_at, v_intent.expires_at), null::text, v_intent.generation;
      return;
    end if;
  end if;

  if v_intent.status = 'creating'
     and v_intent.lease_token is distinct from p_lease_token
     and v_intent.lease_expires_at > v_now then
    return query select
      'wait'::text, null::text, null::text, null::text,
      v_intent.expires_at, v_intent.order_id, v_intent.generation;
    return;
  end if;

  -- A crashed/ambiguous creator keeps the same generation and therefore the
  -- same merchant external reference.  Tell the Edge function to query Revolut
  -- before it attempts another POST.
  v_recovery := v_intent.status = 'creating'
    and v_intent.lease_token is distinct from p_lease_token;

  v_previous := coalesce(v_previous, v_intent.order_id);
  update public.cloud_revolut_checkout_intents i
  set status = 'creating',
      lease_token = p_lease_token,
      lease_expires_at = v_now + v_lease,
      expires_at = v_now + v_ttl,
      order_id = null,
      last_error = null,
      -- A lease takeover after an ambiguous timeout must reuse the exact same
      -- merchant external reference. Only a known failed/expired generation rolls.
      generation = case when i.status = 'creating' then i.generation else i.generation + 1 end,
      updated_at = v_now
  where i.intent_key = p_intent_key
  returning i.generation into v_generation;

  return query select
    case when v_recovery then 'recover' else 'create' end::text,
    null::text, null::text, null::text,
    v_now + v_ttl, v_previous, v_generation;
end
$function$;

create or replace function public.complete_revolut_checkout_intent(
  p_intent_key text,
  p_lease_token text,
  p_order_id text
) returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_changed integer;
begin
  update public.cloud_revolut_checkout_intents i
  set status = 'ready', order_id = p_order_id,
      lease_token = null, lease_expires_at = null, updated_at = clock_timestamp()
  where i.intent_key = p_intent_key
    and i.status = 'creating'
    and i.lease_token = p_lease_token;
  get diagnostics v_changed = row_count;
  return v_changed = 1;
end
$function$;

create or replace function public.fail_revolut_checkout_intent(
  p_intent_key text,
  p_lease_token text,
  p_error text
) returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_changed integer;
begin
  update public.cloud_revolut_checkout_intents i
  set status = 'failed', last_error = left(coalesce(p_error, 'checkout_failed'), 500),
      lease_token = null, lease_expires_at = null, updated_at = clock_timestamp()
  where i.intent_key = p_intent_key
    and i.status = 'creating'
    and i.lease_token = p_lease_token;
  get diagnostics v_changed = row_count;
  return v_changed = 1;
end
$function$;

-- Atomically close the immutable order journal and its current checkout intent.
-- Entitlement/customer writes happen before this RPC and are idempotent; this row
-- lock makes browser + webhook completion converge without leaving an intent ready
-- after the order itself was finalized.
create or replace function public.finalize_revolut_checkout_order(
  p_order_id text,
  p_user_id uuid,
  p_state text,
  p_finalization_result jsonb
) returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_order public.cloud_revolut_orders%rowtype;
begin
  select * into v_order
  from public.cloud_revolut_orders o
  where o.order_id = p_order_id
    and o.user_id = p_user_id
  for update;

  if not found then raise exception 'checkout order ownership mismatch'; end if;
  if v_order.finalized_at is not null then return 'already_finalized'; end if;
  if v_order.expired_at is not null or v_order.superseded_at is not null then
    return 'ineligible';
  end if;

  update public.cloud_revolut_orders o
  set state = coalesce(nullif(upper(p_state), ''), o.state),
      finalized_at = v_now,
      last_reconciled_at = v_now,
      finalization_result = coalesce(p_finalization_result, '{}'::jsonb),
      public_id = null,
      checkout_url = null,
      updated_at = v_now
  where o.order_id = p_order_id
    and o.user_id = p_user_id
    and o.finalized_at is null;
  if not found then raise exception 'checkout order finalization lost'; end if;

  update public.cloud_revolut_checkout_intents i
  set status = 'finalized', lease_token = null, lease_expires_at = null,
      updated_at = v_now
  where i.user_id = p_user_id
    and (i.order_id = p_order_id or (v_order.intent_key is not null and i.intent_key = v_order.intent_key));

  return 'finalized';
end
$function$;

-- Claims at most one latest abandoned order per user.  A newer attempt younger
-- than one hour suppresses older attempts.  A crashed worker's claim is reusable
-- after 30 minutes.  Marketing remains disabled until consent/RFC8058 lands.
create or replace function public.claim_revolut_abandoned_orders(
  p_limit integer default 100
) returns table(
  order_id text,
  user_id uuid,
  plan text,
  period text,
  amount integer,
  currency text,
  claimed_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_claimed_at timestamptz := clock_timestamp();
begin
  -- Serialize the tiny lifecycle claim without holding row locks while email is sent.
  if not pg_try_advisory_xact_lock(hashtext('norva:revolut:abandoned-claim')) then
    return;
  end if;

  return query
  with latest as materialized (
    select distinct on (o.user_id)
      o.order_id, o.user_id, o.plan, o.period, o.amount, o.currency, o.created_at,
      o.reminder_claimed_at, o.reminder_sent_at, o.state,
      o.finalized_at, o.superseded_at
    from public.cloud_revolut_orders o
    where o.user_id is not null
      and o.kind in ('trial_setup', 'resubscribe')
    order by o.user_id, o.created_at desc, o.order_id desc
  ), candidates as materialized (
    select l.order_id
    from latest l
    left join public.cloud_entitlement_projection p on p.user_id = l.user_id
    where l.created_at >= v_claimed_at - interval '48 hours'
      and l.created_at <= v_claimed_at - interval '1 hour'
      and upper(coalesce(l.state, 'PENDING')) in ('PENDING', 'PROCESSING')
      and l.finalized_at is null
      and l.superseded_at is null
      and l.reminder_sent_at is null
      and (
        l.reminder_claimed_at is null
        or l.reminder_claimed_at <= v_claimed_at - interval '30 minutes'
      )
      and not exists (
        select 1 from public.admin_internal_accounts a where a.user_id = l.user_id
      )
      and not (
        coalesce(p.status, '') in ('trialing', 'active', 'cancelled_at_period_end')
        and (
          p.status <> 'trialing' or coalesce(p.trial_ends_at, '-infinity'::timestamptz) > v_claimed_at
        )
        and (
          p.status not in ('active', 'cancelled_at_period_end')
          or p.current_period_end is null or p.current_period_end > v_claimed_at
        )
      )
    order by l.created_at desc
    limit greatest(1, least(100, coalesce(p_limit, 100)))
  ), claimed as (
    update public.cloud_revolut_orders o
    set reminder_claimed_at = v_claimed_at, updated_at = v_claimed_at
    from candidates c
    where o.order_id = c.order_id
      and o.reminder_sent_at is null
      and (
        o.reminder_claimed_at is null
        or o.reminder_claimed_at <= v_claimed_at - interval '30 minutes'
      )
    returning o.order_id, o.user_id, o.plan, o.period, o.amount, o.currency
  )
  select c.order_id, c.user_id, c.plan, c.period, c.amount, c.currency, v_claimed_at
  from claimed c;
end
$function$;

revoke all on table public.cloud_revolut_checkout_intents from public, anon, authenticated;
revoke all on function public.claim_revolut_checkout_intent(text, uuid, text, text, text, integer, text, integer, integer)
  from public, anon, authenticated;
revoke all on function public.complete_revolut_checkout_intent(text, text, text)
  from public, anon, authenticated;
revoke all on function public.fail_revolut_checkout_intent(text, text, text)
  from public, anon, authenticated;
revoke all on function public.finalize_revolut_checkout_order(text, uuid, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.claim_revolut_abandoned_orders(integer)
  from public, anon, authenticated;

grant all on table public.cloud_revolut_checkout_intents to service_role;
grant execute on function public.claim_revolut_checkout_intent(text, uuid, text, text, text, integer, text, integer, integer)
  to service_role;
grant execute on function public.complete_revolut_checkout_intent(text, text, text)
  to service_role;
grant execute on function public.fail_revolut_checkout_intent(text, text, text)
  to service_role;
grant execute on function public.finalize_revolut_checkout_order(text, uuid, text, jsonb)
  to service_role;
grant execute on function public.claim_revolut_abandoned_orders(integer)
  to service_role;
