-- Internal/pilot accounts are never billable.
--
-- The original 2026-07-03 migration tagged every account that existed at that
-- point in time, but later pilot accounts still required an explicit admin tag.
-- It also left the entitlement projection writable by delayed provider events.
-- One old Revolut card-validation failure consequently changed an internal VIP
-- projection to revolut/past_due.  This migration repairs today's explicitly
-- known pilots and makes the invariant durable without auto-tagging future users.

-- Keep the exact entitlement that existed before an account became internal so
-- removing the flag is a real state transition, not a permanent free-access
-- leak.  Four legacy pilots have no pre-tag snapshot; they safely fall back to
-- expired/no-plan if an admin ever removes their internal classification.
create table if not exists public.admin_internal_entitlement_snapshots (
  user_id uuid primary key references auth.users(id) on delete cascade,
  projection jsonb,
  captured_at timestamptz not null default now()
);
alter table public.admin_internal_entitlement_snapshots enable row level security;
revoke all on table public.admin_internal_entitlement_snapshots
  from public, anon, authenticated, service_role;

-- Serialise the exact transition between billable and internal for one user.
-- The billing claim takes the same transaction lock below, so an admin tag that
-- wins this lock is committed before a renewal can be claimed.  Hash collisions
-- only serialise two unrelated accounts; they cannot weaken the invariant.
create or replace function public.norva_lock_internal_billing_transition()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_first uuid;
  v_second uuid;
begin
  if tg_op = 'UPDATE' and old.user_id is distinct from new.user_id then
    if old.user_id::text < new.user_id::text then
      v_first := old.user_id;
      v_second := new.user_id;
    else
      v_first := new.user_id;
      v_second := old.user_id;
    end if;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_first::text, 20260721)
    );
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_second::text, 20260721)
    );
  else
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        case when tg_op = 'DELETE' then old.user_id::text else new.user_id::text end,
        20260721
      )
    );
  end if;

  if tg_op = 'INSERT' then
    -- A claimed cycle may already have reached Revolut. Refuse the admin tag
    -- until reconciliation applies that immutable attempt; never falsify its
    -- provider state or hide a captured debit from the ledger.
    if exists (
      select 1
      from public.cloud_revolut_billing_attempts a
      where a.user_id = new.user_id
        and a.applied_at is null
    ) then
      raise exception 'internal_account_billing_inflight' using errcode = 'P0001';
    end if;

    -- BEFORE INSERT also runs for ON CONFLICT. Capture only a genuinely new
    -- classification, never the already-system state of a legacy internal row.
    if not exists (
      select 1 from public.admin_internal_accounts a where a.user_id = new.user_id
    ) then
      insert into public.admin_internal_entitlement_snapshots (user_id, projection)
      select new.user_id, to_jsonb(p)
      from public.cloud_entitlement_projection p
      where p.user_id = new.user_id
      on conflict (user_id) do nothing;
    end if;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$function$;

drop trigger if exists aaa_norva_lock_internal_billing_transition
  on public.admin_internal_accounts;
create trigger aaa_norva_lock_internal_billing_transition
before insert or update or delete on public.admin_internal_accounts
for each row execute function public.norva_lock_internal_billing_transition();

-- Only these known owner/pilot identities are backfilled.  New sign-ups remain
-- ordinary customer accounts unless an admin deliberately marks them internal.
insert into public.admin_internal_accounts (user_id, note)
select u.id, 'explicit pilot/system account backfill 2026-07-21'
from auth.users u
where lower(u.email) in (
  'adrien.hernandez@outlook.com',
  'hernandez.jeremy@outlook.fr',
  'projethorizon2030@gmail.com',
  'adrienhernandez20@gmail.com',
  'cventis.support@gmail.com'
)
on conflict (user_id) do update
set note = coalesce(admin_internal_accounts.note, excluded.note);

create or replace function public.norva_is_internal_account(p_user_id uuid)
returns boolean
language sql
volatile
security definer
set search_path = pg_catalog, public
as $function$
  select exists (
    select 1
    from public.admin_internal_accounts a
    where a.user_id = p_user_id
  )
$function$;

-- Last line of defence for the shared projection.  A delayed webhook, an old
-- checkout confirmation, lifecycle dunning, or a stale billing worker can still
-- journal its event, but it can never turn an internal account into a billable
-- rail or expose billing CTAs.  System grants are perpetual, so billing dates are
-- NULL rather than a fake renewal in 2099.
create or replace function public.norva_enforce_internal_entitlement()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_hard_status text;
begin
  if public.norva_is_internal_account(new.user_id) then
    -- Explicit security/reversal states remain authoritative.  A pilot account
    -- can still be revoked for compromise/fraud; only ordinary billing states
    -- are canonicalised back to included system access.  Even a hard-blocked
    -- pilot stays on the non-billable system rail with every billing field
    -- cleared; only the blocking status itself is preserved.
    if new.status in ('revoked', 'refunded', 'fraud') then
      v_hard_status := new.status;
    elsif tg_op = 'UPDATE' and old.status in ('revoked', 'refunded', 'fraud') then
      v_hard_status := old.status;
    end if;
    new.provider := 'system';
    new.provider_customer_id := null;
    new.plan_code := 'family';
    new.status := coalesce(v_hard_status, 'active');
    new.limits := '{}'::jsonb;
    new.current_period_end := null;
    new.trial_ends_at := null;
    new.fail_open_until := null;
    new.dunning_last_at := null;
    new.dunning_stage := 0;
    new.billing_retry_count := 0;
    new.mrr_cents := null;
    new.bill_period := null;
  end if;
  return new;
end
$function$;

drop trigger if exists aaa_norva_internal_entitlement_invariant
  on public.cloud_entitlement_projection;
create trigger aaa_norva_internal_entitlement_invariant
before insert or update on public.cloud_entitlement_projection
for each row execute function public.norva_enforce_internal_entitlement();

-- Tagging an account is itself enough to grant/canonicalise access, even if the
-- caller did not use admin_internal_toggle. The BEFORE registry trigger refuses
-- the transition while any immutable billing cycle still needs reconciliation.
create or replace function public.norva_grant_internal_entitlement()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := clock_timestamp();
begin
  insert into public.cloud_entitlement_projection as p (
    user_id, provider, provider_customer_id, plan_code, status, limits,
    current_period_end, trial_ends_at, last_verified_at, last_event_at,
    fail_open_until, dunning_last_at, dunning_stage, billing_retry_count,
    mrr_cents, bill_period, notes
  ) values (
    new.user_id, 'system', null, 'family', 'active', '{}'::jsonb,
    null, null, v_now, v_now, null, null, 0, 0, null, null,
    'Internal pilot account: permanent included access; billing disabled.'
  )
  on conflict (user_id) do update
  set provider = 'system',
      provider_customer_id = null,
      plan_code = 'family',
      status = 'active',
      limits = '{}'::jsonb,
      current_period_end = null,
      trial_ends_at = null,
      last_verified_at = v_now,
      last_event_at = v_now,
      fail_open_until = null,
      dunning_last_at = null,
      dunning_stage = 0,
      billing_retry_count = 0,
      mrr_cents = null,
      bill_period = null,
      notes = coalesce(p.notes, excluded.notes);

  return new;
end
$function$;

drop trigger if exists aaa_norva_internal_account_grant
  on public.admin_internal_accounts;
create trigger aaa_norva_internal_account_grant
after insert on public.admin_internal_accounts
for each row execute function public.norva_grant_internal_entitlement();

-- Removing the internal flag restores the exact pre-tag entitlement.  When no
-- snapshot exists (the four legacy accounts tagged before snapshots existed),
-- remove included access explicitly. Security/reversal blocks stay sticky.
create or replace function public.norva_restore_external_entitlement()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_snapshot jsonb;
  v_current_status text;
  v_now timestamptz := clock_timestamp();
begin
  select p.status into v_current_status
  from public.cloud_entitlement_projection p
  where p.user_id = old.user_id;

  select s.projection into v_snapshot
  from public.admin_internal_entitlement_snapshots s
  where s.user_id = old.user_id
  for update;

  if v_current_status in ('revoked', 'refunded', 'fraud') then
    update public.cloud_entitlement_projection p
    set provider = 'system', provider_customer_id = null, plan_code = 'none',
        status = v_current_status, limits = '{}'::jsonb,
        current_period_end = null, trial_ends_at = null,
        last_verified_at = v_now, last_event_at = v_now,
        fail_open_until = null, dunning_last_at = null, dunning_stage = 0,
        billing_retry_count = 0, mrr_cents = null, bill_period = null
    where p.user_id = old.user_id;
  elsif v_snapshot is not null then
    delete from public.cloud_entitlement_projection p where p.user_id = old.user_id;
    insert into public.cloud_entitlement_projection
    select (pg_catalog.jsonb_populate_record(
      null::public.cloud_entitlement_projection, v_snapshot
    )).*;
    -- A once-valid paid period can expire while the account is internal. Never
    -- restore it as immediately chargeable; require an explicit resubscribe.
    update public.cloud_entitlement_projection p
    set status = 'expired',
        fail_open_until = null,
        dunning_last_at = null,
        dunning_stage = 0,
        billing_retry_count = 0,
        mrr_cents = null,
        bill_period = null,
        last_verified_at = v_now,
        last_event_at = v_now
    where p.user_id = old.user_id
      and p.provider not in ('system', 'manual')
      and p.status in ('trialing', 'active', 'past_due', 'grace', 'cancelled_at_period_end')
      and greatest(
        coalesce(p.current_period_end, '-infinity'::timestamptz),
        coalesce(p.trial_ends_at, '-infinity'::timestamptz),
        coalesce(p.fail_open_until, '-infinity'::timestamptz)
      ) <= v_now;
  else
    insert into public.cloud_entitlement_projection as p (
      user_id, provider, provider_customer_id, plan_code, status, limits,
      current_period_end, trial_ends_at, last_verified_at, last_event_at,
      fail_open_until, dunning_last_at, dunning_stage, billing_retry_count,
      mrr_cents, bill_period, notes
    ) values (
      old.user_id, 'system', null, 'none', 'expired', '{}'::jsonb,
      null, null, v_now, v_now, null, null, 0, 0, null, null,
      'Internal classification removed; no previous entitlement snapshot.'
    )
    on conflict (user_id) do update
    set provider = 'system', provider_customer_id = null, plan_code = 'none',
        status = 'expired', limits = '{}'::jsonb,
        current_period_end = null, trial_ends_at = null,
        last_verified_at = v_now, last_event_at = v_now,
        fail_open_until = null, dunning_last_at = null, dunning_stage = 0,
        billing_retry_count = 0, mrr_cents = null, bill_period = null,
        notes = excluded.notes;
  end if;

  delete from public.admin_internal_entitlement_snapshots s
  where s.user_id = old.user_id;
  return old;
end
$function$;

drop trigger if exists aaz_norva_internal_account_restore
  on public.admin_internal_accounts;
create trigger aaz_norva_internal_account_restore
after delete on public.admin_internal_accounts
for each row execute function public.norva_restore_external_entitlement();

-- Repair every currently tagged account, including a pilot whose old Revolut
-- card-validation failure left a hybrid past_due/2099 projection.
insert into public.cloud_entitlement_projection as p (
  user_id, provider, provider_customer_id, plan_code, status, limits,
  current_period_end, trial_ends_at, last_verified_at, last_event_at,
  fail_open_until, dunning_last_at, dunning_stage, billing_retry_count,
  mrr_cents, bill_period, notes
)
select
  a.user_id, 'system', null, 'family', 'active', '{}'::jsonb,
  null, null, clock_timestamp(), clock_timestamp(),
  null, null, 0, 0, null, null,
  'Internal pilot account: permanent included access; billing disabled.'
from public.admin_internal_accounts a
on conflict (user_id) do update
set provider = 'system',
    provider_customer_id = null,
    plan_code = 'family',
    status = 'active',
    limits = '{}'::jsonb,
    current_period_end = null,
    trial_ends_at = null,
    last_verified_at = excluded.last_verified_at,
    last_event_at = excluded.last_event_at,
    fail_open_until = null,
    dunning_last_at = null,
    dunning_stage = 0,
    billing_retry_count = 0,
    mrr_cents = null,
    bill_period = null,
    notes = coalesce(p.notes, excluded.notes);

-- A direct call to the old/base claim function must also fail before an attempt
-- can be inserted.  The public wrapper below normally returns action=internal;
-- this trigger protects against accidental future callers of the base function.
create or replace function public.norva_block_internal_billing_attempt()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(new.user_id::text, 20260721)
  );
  if public.norva_is_internal_account(new.user_id) then
    raise exception 'internal_account_not_billable' using errcode = 'P0001';
  end if;
  return new;
end
$function$;

drop trigger if exists aaa_norva_block_internal_billing_attempt
  on public.cloud_revolut_billing_attempts;
create trigger aaa_norva_block_internal_billing_attempt
before insert on public.cloud_revolut_billing_attempts
for each row execute function public.norva_block_internal_billing_attempt();

-- Wrap the immutable-cycle claim.  The internal result is returned before the
-- base function can insert a lease; the worker treats it as a terminal skip and
-- therefore never reaches Revolut's POST /orders endpoint.
do $rename_claim$
begin
  if to_regprocedure(
    'public.claim_revolut_billing_cycle_noninternal(text,uuid,text,timestamptz,integer,text,text,integer,integer,integer,integer,text,text,integer)'
  ) is null then
    alter function public.claim_revolut_billing_cycle(
      text, uuid, text, timestamptz, integer, text, text, integer, integer,
      integer, integer, text, text, integer
    ) rename to claim_revolut_billing_cycle_noninternal;
  end if;
end
$rename_claim$;

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
begin
  -- Linearisation point shared with admin_internal_accounts' BEFORE trigger.
  -- Recheck membership while holding it before the base RPC can create a lease.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text, 20260721)
  );
  if public.norva_is_internal_account(p_user_id) then
    return query select
      'internal'::text, 'blocked'::text, null::text, null::text,
      p_merchant_ext_ref, p_amount_cents, p_plan_code, p_bill_period,
      p_discount_pct, p_promo_cycles_before, p_base_amount_cents,
      null::text, 0::bigint;
    return;
  end if;

  return query
  select r.*
  from public.claim_revolut_billing_cycle_noninternal(
    p_cycle_key, p_user_id, p_kind, p_cycle_anchor, p_retry_attempt,
    p_plan_code, p_bill_period, p_amount_cents, p_discount_pct,
    p_promo_cycles_before, p_base_amount_cents, p_merchant_ext_ref,
    p_lease_token, p_lease_seconds
  ) r;
end
$function$;

-- Wrap both apply paths as well. The shared advisory lock makes applying a
-- completed/failed cycle and tagging the account one linear order. The registry
-- trigger refuses a tag until the earlier cycle has been fully reconciled.
do $rename_apply_success$
begin
  if to_regprocedure(
    'public.apply_revolut_billing_success_noninternal(text,text,timestamptz)'
  ) is null then
    alter function public.apply_revolut_billing_success(text, text, timestamptz)
      rename to apply_revolut_billing_success_noninternal;
  end if;
end
$rename_apply_success$;

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
  v_user_id uuid;
begin
  select a.user_id into v_user_id
  from public.cloud_revolut_billing_attempts a
  where a.cycle_key = p_cycle_key;
  if not found then raise exception 'billing attempt not found'; end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_user_id::text, 20260721)
  );

  if public.norva_is_internal_account(v_user_id) then
    raise exception 'internal_account_billing_reconciliation_required'
      using errcode = 'P0001';
  end if;

  return query
  select r.applied, r.already_applied, r.warning
  from public.apply_revolut_billing_success_noninternal(
    p_cycle_key, p_lease_token, p_next_period_end
  ) r;
end
$function$;

do $rename_apply_failure$
begin
  if to_regprocedure(
    'public.apply_revolut_billing_failure_noninternal(text,text,timestamptz)'
  ) is null then
    alter function public.apply_revolut_billing_failure(text, text, timestamptz)
      rename to apply_revolut_billing_failure_noninternal;
  end if;
end
$rename_apply_failure$;

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
  v_user_id uuid;
begin
  select a.user_id into v_user_id
  from public.cloud_revolut_billing_attempts a
  where a.cycle_key = p_cycle_key;
  if not found then raise exception 'billing attempt not found'; end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_user_id::text, 20260721)
  );

  if public.norva_is_internal_account(v_user_id) then
    raise exception 'internal_account_billing_reconciliation_required'
      using errcode = 'P0001';
  end if;

  return query
  select r.applied, r.already_applied, r.warning
  from public.apply_revolut_billing_failure_noninternal(
    p_cycle_key, p_lease_token, p_fail_open_until
  ) r;
end
$function$;

-- Every checkout path eventually writes the reusable Revolut customer mapping.
-- Guard that table at the database boundary so an admin tag, a refund/fraud
-- decision, or a cross-rail move that wins the shared lock is authoritative even
-- when it races the browser confirmation or the asynchronous webhook.
create or replace function public.norva_guard_revolut_customer_mapping()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_provider text;
  v_status text;
begin
  if tg_op = 'UPDATE' and old.user_id is distinct from new.user_id then
    raise exception 'revolut_customer_user_id_immutable' using errcode = 'P0001';
  end if;

  -- This is the same linearisation point used by internal-account transitions
  -- and billing claims/applies. If this write wins, it happened before the tag;
  -- if the tag wins, the membership recheck below rejects the mapping write.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(new.user_id::text, 20260721)
  );

  if public.norva_is_internal_account(new.user_id) then
    raise exception 'internal_account_not_billable' using errcode = 'P0001';
  end if;

  -- Hold the projection row through the mapping write. This makes a concurrent
  -- hard block or rail transfer linearisable with the customer upsert as well.
  select p.provider, p.status
    into v_provider, v_status
  from public.cloud_entitlement_projection p
  where p.user_id = new.user_id
  for update;

  if found then
    if v_status in ('revoked', 'refunded', 'fraud') then
      raise exception 'revolut_customer_account_blocked' using errcode = 'P0001';
    end if;
    -- Missing projections and expired projections may legitimately begin a new
    -- web subscription. Every other live/non-terminal rail keeps ownership.
    if v_provider <> 'revolut' and v_status <> 'expired' then
      raise exception 'revolut_customer_rail_mismatch' using errcode = 'P0001';
    end if;
  end if;

  return new;
end
$function$;

drop trigger if exists aaa_norva_guard_revolut_customer_mapping
  on public.cloud_revolut_customers;
create trigger aaa_norva_guard_revolut_customer_mapping
before insert or update on public.cloud_revolut_customers
for each row execute function public.norva_guard_revolut_customer_mapping();

-- Store webhooks use their own causal cursor. Wrap that RPC so delayed Play /
-- App Store events cannot reactivate an internal or hard-blocked account. The
-- cursor still advances with applied=false, making retries deterministic without
-- mutating the authoritative projection.
do $rename_revenuecat_apply$
begin
  if to_regprocedure(
    'public.apply_revenuecat_entitlement_event_nonblocked(uuid,timestamptz,text,jsonb)'
  ) is null then
    alter function public.apply_revenuecat_entitlement_event(uuid, timestamptz, text, jsonb)
      rename to apply_revenuecat_entitlement_event_nonblocked;
  end if;
end
$rename_revenuecat_apply$;

create or replace function public.apply_revenuecat_entitlement_event(
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
  v_cursor public.cloud_revenuecat_projection_cursor%rowtype;
  v_current_status text;
  v_projection_last_event_at timestamptz;
  v_internal boolean;
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

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('norva:revenuecat:' || p_user_id::text, 0)
  );

  select p.status, p.last_event_at
    into v_current_status, v_projection_last_event_at
  from public.cloud_entitlement_projection p
  where p.user_id = p_user_id
  for update;
  v_internal := public.norva_is_internal_account(p_user_id);

  if v_internal or v_current_status in ('revoked', 'refunded', 'fraud') then
    select * into v_cursor
    from public.cloud_revenuecat_projection_cursor c
    where c.user_id = p_user_id
    for update;

    if found and p_event_id = v_cursor.last_event_id then
      return query select v_cursor.last_projection_applied, v_projection_last_event_at;
      return;
    end if;
    if found and p_event_at <= v_cursor.last_event_at then
      return query select false, v_projection_last_event_at;
      return;
    end if;

    insert into public.cloud_revenuecat_projection_cursor as c (
      user_id, last_event_at, last_event_id, last_projection_applied, updated_at
    ) values (
      p_user_id, p_event_at, p_event_id, false, clock_timestamp()
    )
    on conflict (user_id) do update
    set last_event_at = excluded.last_event_at,
        last_event_id = excluded.last_event_id,
        last_projection_applied = false,
        updated_at = excluded.updated_at;

    return query select false, v_projection_last_event_at;
    return;
  end if;

  return query
  select r.applied, r.projection_last_event_at
  from public.apply_revenuecat_entitlement_event_nonblocked(
    p_user_id, p_event_at, p_event_id, p_patch
  ) r;
end
$function$;

revoke all on function public.norva_is_internal_account(uuid)
  from public, anon, authenticated;
revoke all on function public.norva_lock_internal_billing_transition()
  from public, anon, authenticated, service_role;
revoke all on function public.norva_enforce_internal_entitlement()
  from public, anon, authenticated, service_role;
revoke all on function public.norva_grant_internal_entitlement()
  from public, anon, authenticated, service_role;
revoke all on function public.norva_restore_external_entitlement()
  from public, anon, authenticated, service_role;
revoke all on function public.norva_block_internal_billing_attempt()
  from public, anon, authenticated, service_role;
revoke all on function public.norva_guard_revolut_customer_mapping()
  from public, anon, authenticated, service_role;
revoke all on function public.claim_revolut_billing_cycle_noninternal(
  text, uuid, text, timestamptz, integer, text, text, integer, integer,
  integer, integer, text, text, integer
) from public, anon, authenticated, service_role;
revoke all on function public.apply_revolut_billing_success_noninternal(text, text, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.apply_revolut_billing_failure_noninternal(text, text, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.apply_revenuecat_entitlement_event_nonblocked(uuid, timestamptz, text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.claim_revolut_billing_cycle(
  text, uuid, text, timestamptz, integer, text, text, integer, integer,
  integer, integer, text, text, integer
) from public, anon, authenticated;
revoke all on function public.apply_revolut_billing_success(text, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.apply_revolut_billing_failure(text, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.apply_revenuecat_entitlement_event(uuid, timestamptz, text, jsonb)
  from public, anon, authenticated;

grant execute on function public.claim_revolut_billing_cycle(
  text, uuid, text, timestamptz, integer, text, text, integer, integer,
  integer, integer, text, text, integer
) to service_role;
grant execute on function public.apply_revolut_billing_success(text, text, timestamptz)
  to service_role;
grant execute on function public.apply_revolut_billing_failure(text, text, timestamptz)
  to service_role;
grant execute on function public.apply_revenuecat_entitlement_event(uuid, timestamptz, text, jsonb)
  to service_role;

notify pgrst, 'reload schema';
