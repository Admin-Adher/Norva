-- Account-stable paywall experiments and an authoritative conversion chain.
--
-- Design invariants:
--   * assignment is sticky on (user_id, experiment_key), hence shared by Web,
--     mobile and every paired TV;
--   * clients never choose a variant and never write analytics tables directly;
--   * internal/pilot accounts are ineligible at both claim and event-write time;
--   * checkout commercial terms are frozen server-side on the order journal;
--   * paywall exposure is idempotent per account/experiment/placement;
--   * successful playback means a first_frame event, not a play-button click.

create table if not exists public.paywall_experiments (
  experiment_key text primary key
    check (experiment_key ~ '^[a-z0-9][a-z0-9_.:-]{0,63}$'),
  assignment_salt text not null check (length(assignment_salt) between 16 and 128),
  active boolean not null default false,
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);

create table if not exists public.paywall_experiment_variants (
  experiment_key text not null references public.paywall_experiments(experiment_key) on delete cascade,
  variant text not null check (variant ~ '^[a-z0-9][a-z0-9_.:-]{0,63}$'),
  allocation_bps integer not null check (allocation_bps between 0 and 10000),
  ordinal smallint not null check (ordinal between 0 and 100),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (experiment_key, variant),
  unique (experiment_key, ordinal)
);

create table if not exists public.paywall_experiment_assignments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  experiment_key text not null,
  variant text not null,
  assignment_bucket integer not null check (assignment_bucket between 0 and 9999),
  assigned_at timestamptz not null default now(),
  assignment_source text not null default 'account_hash'
    check (assignment_source in ('account_hash', 'admin_override')),
  unique (user_id, experiment_key),
  foreign key (experiment_key, variant)
    references public.paywall_experiment_variants(experiment_key, variant)
);

create index if not exists idx_paywall_experiment_assignments_experiment_variant
  on public.paywall_experiment_assignments (experiment_key, variant, assigned_at);

create table if not exists public.paywall_funnel_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null check (event_type in (
    'paywall_exposed', 'checkout_started', 'order_authorized', 'payment_captured',
    'entitlement_activated', 'first_play'
  )),
  event_source text not null check (event_source in (
    'client_rpc', 'checkout_order', 'billing_ledger',
    'entitlement_projection', 'playback_first_frame'
  )),
  experiment_key text,
  experiment_variant text,
  placement text check (placement is null or placement ~ '^[a-z0-9][a-z0-9_.:-]{0,63}$'),
  surface text check (surface is null or surface in ('web', 'mobile_android', 'android_tv', 'samsung_tv', 'unknown')),
  plan_code text check (plan_code is null or plan_code in ('plus', 'family')),
  billing_cadence text check (billing_cadence is null or billing_cadence in ('monthly', 'annual')),
  price_amount_minor integer check (price_amount_minor is null or price_amount_minor between 1 and 9999999),
  price_currency text check (price_currency is null or price_currency ~ '^[A-Z]{3}$'),
  order_id text,
  entitlement_event_id uuid references public.cloud_entitlement_events(id) on delete set null,
  playback_event_id uuid references public.cloud_playback_events(id) on delete set null,
  previous_event_id uuid references public.paywall_funnel_events(id) on delete set null,
  dedupe_key text not null unique check (length(dedupe_key) between 8 and 240),
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  check (
    (experiment_key is null and experiment_variant is null)
    or (experiment_key is not null and experiment_variant is not null)
  )
);

create index if not exists idx_paywall_funnel_events_user_time
  on public.paywall_funnel_events (user_id, occurred_at, id);
create index if not exists idx_paywall_funnel_events_experiment_stage
  on public.paywall_funnel_events (experiment_key, experiment_variant, event_type, occurred_at);
create index if not exists idx_paywall_funnel_events_order
  on public.paywall_funnel_events (order_id) where order_id is not null;

alter table public.paywall_experiments enable row level security;
alter table public.paywall_experiment_variants enable row level security;
alter table public.paywall_experiment_assignments enable row level security;
alter table public.paywall_funnel_events enable row level security;

-- These are backend evidence tables. Authenticated clients only use the narrow
-- SECURITY DEFINER RPCs below; no table policy deliberately exists.
revoke all on table public.paywall_experiments from public, anon, authenticated;
revoke all on table public.paywall_experiment_variants from public, anon, authenticated;
revoke all on table public.paywall_experiment_assignments from public, anon, authenticated;
revoke all on table public.paywall_funnel_events from public, anon, authenticated;
grant select, insert, update, delete on table public.paywall_experiments to service_role;
grant select, insert, update, delete on table public.paywall_experiment_variants to service_role;
grant select, insert, update, delete on table public.paywall_experiment_assignments to service_role;
grant select, insert, update, delete on table public.paywall_funnel_events to service_role;

-- First experiment. Existing accounts are not backfilled: the first eligible
-- claim atomically assigns them. Changing weights later cannot move an assigned
-- account because the assignment row is immutable.
insert into public.paywall_experiments (
  experiment_key, assignment_salt, active, starts_at
) values (
  'paywall_positioning_v1',
  'norva-paywall-positioning-v1-2026-07',
  true,
  now()
) on conflict (experiment_key) do nothing;

insert into public.paywall_experiment_variants (
  experiment_key, variant, allocation_bps, ordinal, active
) values
  -- Establish a trustworthy baseline before serving divergent copy. The second
  -- variant is deliberately allocation-zero until the UI treatment and test
  -- protocol are both approved; changing weights only affects new assignments.
  ('paywall_positioning_v1', 'control', 10000, 0, true),
  ('paywall_positioning_v1', 'multiscreen_value', 0, 1, true)
on conflict (experiment_key, variant) do nothing;

-- Internal primitive. It is only callable by its authenticated wrapper and by
-- service-role Edge functions that already established the account identity.
create or replace function public.norva_claim_paywall_experiment_for_user(
  p_user_id uuid,
  p_experiment_key text default 'paywall_positioning_v1'
) returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_experiment public.paywall_experiments%rowtype;
  v_assignment public.paywall_experiment_assignments%rowtype;
  v_variant text;
  v_bucket integer;
  v_total integer;
begin
  if p_user_id is null or coalesce(btrim(p_experiment_key), '') = '' then
    raise exception 'user_id and experiment_key are required' using errcode = '22023';
  end if;
  if not exists (select 1 from auth.users u where u.id = p_user_id) then
    raise exception 'account not found' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.admin_internal_accounts i where i.user_id = p_user_id) then
    return jsonb_build_object(
      'eligible', false, 'reason', 'internal_account',
      'experiment_key', p_experiment_key, 'variant', null
    );
  end if;

  select * into v_experiment
  from public.paywall_experiments e
  where e.experiment_key = p_experiment_key;
  if not found or not v_experiment.active
     or (v_experiment.starts_at is not null and v_experiment.starts_at > clock_timestamp())
     or (v_experiment.ends_at is not null and v_experiment.ends_at <= clock_timestamp()) then
    return jsonb_build_object(
      'eligible', false, 'reason', 'experiment_inactive',
      'experiment_key', p_experiment_key, 'variant', null
    );
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('norva:paywall:' || p_user_id::text || ':' || p_experiment_key, 0)
  );

  select * into v_assignment
  from public.paywall_experiment_assignments a
  where a.user_id = p_user_id and a.experiment_key = p_experiment_key;
  if found then
    return jsonb_build_object(
      'eligible', true,
      'experiment_key', v_assignment.experiment_key,
      'variant', v_assignment.variant,
      'assignment_id', v_assignment.id,
      'assigned_at', v_assignment.assigned_at,
      'new_assignment', false
    );
  end if;

  select coalesce(sum(v.allocation_bps), 0)::integer into v_total
  from public.paywall_experiment_variants v
  where v.experiment_key = p_experiment_key and v.active;
  if v_total <> 10000 then
    raise exception 'paywall experiment allocation must total 10000 bps' using errcode = '23514';
  end if;

  v_bucket := mod(
    hashtextextended(v_experiment.assignment_salt || ':' || p_user_id::text, 0)
      & 9223372036854775807,
    10000
  )::integer;

  select choice.variant into v_variant
  from (
    select
      v.variant,
      sum(v.allocation_bps) over (order by v.ordinal, v.variant) as upper_bound
    from public.paywall_experiment_variants v
    where v.experiment_key = p_experiment_key and v.active
  ) choice
  where choice.upper_bound > v_bucket
  order by choice.upper_bound
  limit 1;
  if v_variant is null then
    raise exception 'paywall experiment has no selectable variant' using errcode = '23514';
  end if;

  insert into public.paywall_experiment_assignments (
    user_id, experiment_key, variant, assignment_bucket
  ) values (
    p_user_id, p_experiment_key, v_variant, v_bucket
  )
  returning * into v_assignment;

  return jsonb_build_object(
    'eligible', true,
    'experiment_key', v_assignment.experiment_key,
    'variant', v_assignment.variant,
    'assignment_id', v_assignment.id,
    'assigned_at', v_assignment.assigned_at,
    'new_assignment', true
  );
end
$function$;

create or replace function public.claim_paywall_experiment(
  p_experiment_key text default 'paywall_positioning_v1'
) returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  return public.norva_claim_paywall_experiment_for_user(v_user_id, p_experiment_key);
end
$function$;

create or replace function public.norva_record_paywall_exposure_for_user(
  p_user_id uuid,
  p_experiment_key text default 'paywall_positioning_v1',
  p_placement text default 'subscribe',
  p_surface text default 'web'
) returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_claim jsonb;
  v_variant text;
  v_event_id uuid;
  v_inserted boolean := false;
  v_placement text := lower(btrim(coalesce(p_placement, 'subscribe')));
  v_surface text := lower(btrim(coalesce(p_surface, 'unknown')));
  v_dedupe text;
begin
  if v_placement !~ '^[a-z0-9][a-z0-9_.:-]{0,63}$' then
    raise exception 'invalid paywall placement' using errcode = '22023';
  end if;
  if v_surface not in ('web', 'mobile_android', 'android_tv', 'samsung_tv', 'unknown') then
    raise exception 'invalid paywall surface' using errcode = '22023';
  end if;
  v_claim := public.norva_claim_paywall_experiment_for_user(p_user_id, p_experiment_key);
  if coalesce((v_claim ->> 'eligible')::boolean, false) is not true then
    return v_claim || jsonb_build_object('exposed', false);
  end if;
  v_variant := v_claim ->> 'variant';
  v_dedupe := 'paywall_exposed:' || p_user_id::text || ':' || p_experiment_key
    || ':' || v_placement || ':' || v_surface;

  insert into public.paywall_funnel_events (
    user_id, event_type, event_source, experiment_key, experiment_variant,
    placement, surface, dedupe_key
  ) values (
    p_user_id, 'paywall_exposed', 'client_rpc', p_experiment_key, v_variant,
    v_placement, v_surface, v_dedupe
  ) on conflict (dedupe_key) do nothing
  returning id into v_event_id;
  v_inserted := v_event_id is not null;
  if v_event_id is null then
    select e.id into v_event_id from public.paywall_funnel_events e
    where e.dedupe_key = v_dedupe;
  end if;

  return v_claim || jsonb_build_object(
    'exposed', true,
    'event_id', v_event_id,
    'event_inserted', v_inserted,
    'placement', v_placement,
    'surface', v_surface
  );
end
$function$;

create or replace function public.record_paywall_exposure(
  p_experiment_key text default 'paywall_positioning_v1',
  p_placement text default 'subscribe',
  p_surface text default 'web'
) returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  return public.norva_record_paywall_exposure_for_user(
    v_user_id, p_experiment_key, p_placement, p_surface
  );
end
$function$;

revoke all on function public.norva_claim_paywall_experiment_for_user(uuid, text)
  from public, anon, authenticated;
revoke all on function public.norva_record_paywall_exposure_for_user(uuid, text, text, text)
  from public, anon, authenticated;
revoke all on function public.claim_paywall_experiment(text) from public, anon;
revoke all on function public.record_paywall_exposure(text, text, text) from public, anon;
grant execute on function public.norva_claim_paywall_experiment_for_user(uuid, text)
  to service_role;
grant execute on function public.norva_record_paywall_exposure_for_user(uuid, text, text, text)
  to service_role;
grant execute on function public.claim_paywall_experiment(text) to authenticated, service_role;
grant execute on function public.record_paywall_exposure(text, text, text) to authenticated, service_role;

-- Freeze experiment attribution next to the server-decided commercial terms.
alter table public.cloud_revolut_checkout_intents
  add column if not exists currency text not null default 'USD',
  add column if not exists experiment_key text,
  add column if not exists experiment_variant text,
  add column if not exists paywall_placement text,
  add column if not exists paywall_surface text;

alter table public.cloud_revolut_orders
  add column if not exists experiment_key text,
  add column if not exists experiment_variant text,
  add column if not exists paywall_placement text,
  add column if not exists paywall_surface text;

alter table public.cloud_billing_ledger
  add column if not exists experiment_key text,
  add column if not exists experiment_variant text,
  add column if not exists paywall_placement text,
  add column if not exists paywall_surface text,
  add column if not exists store_product_id text,
  add column if not exists store_package_id text,
  add column if not exists commercial_terms_source text;

alter table public.cloud_entitlement_projection
  add column if not exists billing_currency text,
  add column if not exists billing_product_id text,
  add column if not exists billing_package_id text,
  add column if not exists billing_terms_source text;

do $constraints$
begin
  if not exists (
    select 1 from pg_constraint where conrelid = 'public.cloud_revolut_checkout_intents'::regclass
      and conname = 'cloud_revolut_checkout_intents_currency_check'
  ) then
    alter table public.cloud_revolut_checkout_intents
      add constraint cloud_revolut_checkout_intents_currency_check check (currency ~ '^[A-Z]{3}$');
  end if;
  if not exists (
    select 1 from pg_constraint where conrelid = 'public.cloud_revolut_orders'::regclass
      and conname = 'cloud_revolut_orders_experiment_pair_check'
  ) then
    alter table public.cloud_revolut_orders
      add constraint cloud_revolut_orders_experiment_pair_check check (
        (experiment_key is null and experiment_variant is null)
        or (experiment_key is not null and experiment_variant is not null)
      );
  end if;
  if not exists (
    select 1 from pg_constraint where conrelid = 'public.cloud_entitlement_projection'::regclass
      and conname = 'cloud_entitlement_projection_billing_currency_check'
  ) then
    alter table public.cloud_entitlement_projection
      add constraint cloud_entitlement_projection_billing_currency_check
      check (billing_currency is null or billing_currency ~ '^[A-Z]{3}$');
  end if;
end
$constraints$;

comment on column public.cloud_revolut_orders.plan is 'Server-decided plan frozen when checkout opens.';
comment on column public.cloud_revolut_orders.period is 'Server-decided billing cadence frozen when checkout opens.';
comment on column public.cloud_revolut_orders.requested_amount_cents is 'Server-decided recurring price in minor units frozen when checkout opens.';
comment on column public.cloud_revolut_orders.currency is 'ISO-4217 currency paired with requested_amount_cents.';
comment on column public.cloud_revolut_orders.experiment_variant is 'Server-resolved sticky account variant; never accepted as client authority.';

create or replace function public.norva_validate_revolut_order_attribution()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if new.experiment_key is not null then
    if not exists (
      select 1 from public.paywall_experiment_assignments a
      where a.user_id = new.user_id
        and a.experiment_key = new.experiment_key
        and a.variant = new.experiment_variant
    ) then
      raise exception 'checkout experiment attribution mismatch' using errcode = '23514';
    end if;
  end if;
  if new.paywall_placement is not null
     and new.paywall_placement !~ '^[a-z0-9][a-z0-9_.:-]{0,63}$' then
    raise exception 'invalid checkout paywall placement' using errcode = '23514';
  end if;
  if new.paywall_surface is not null
     and new.paywall_surface not in ('web', 'mobile_android', 'android_tv', 'samsung_tv', 'unknown') then
    raise exception 'invalid checkout paywall surface' using errcode = '23514';
  end if;
  return new;
end
$function$;

drop trigger if exists validate_revolut_order_attribution on public.cloud_revolut_orders;
create trigger validate_revolut_order_attribution
  before insert or update of user_id, experiment_key, experiment_variant, paywall_placement, paywall_surface
  on public.cloud_revolut_orders
  for each row execute function public.norva_validate_revolut_order_attribution();

-- Immutable, deduplicated chain writers. Triggers are used so webhook, browser
-- return, cron and native-store paths all produce the same evidence.
create or replace function public.norva_revolut_order_funnel_event()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_previous uuid;
  v_was_authorized boolean := false;
  v_is_authorized boolean;
begin
  if new.user_id is null
     or exists (select 1 from public.admin_internal_accounts i where i.user_id = new.user_id) then
    return new;
  end if;

  if tg_op = 'INSERT' and new.kind in ('trial_setup', 'resubscribe') then
    select e.id into v_previous
    from public.paywall_funnel_events e
    where e.user_id = new.user_id and e.event_type = 'paywall_exposed'
      and (new.experiment_key is null or e.experiment_key = new.experiment_key)
    order by e.occurred_at desc, e.id desc limit 1;
    insert into public.paywall_funnel_events (
      user_id, event_type, event_source, experiment_key, experiment_variant,
      placement, surface, plan_code, billing_cadence, price_amount_minor, price_currency,
      order_id, previous_event_id, dedupe_key, occurred_at
    ) values (
      new.user_id, 'checkout_started', 'checkout_order', new.experiment_key,
      new.experiment_variant, new.paywall_placement, new.paywall_surface, new.plan, new.period,
      new.requested_amount_cents, upper(new.currency), new.order_id, v_previous,
      'checkout_started:revolut:' || new.order_id, new.created_at
    ) on conflict (dedupe_key) do nothing;
  end if;

  if tg_op = 'UPDATE' then
    v_was_authorized := upper(coalesce(old.state, '')) in ('AUTHORISED', 'AUTHORIZED', 'COMPLETED');
  end if;
  v_is_authorized := upper(coalesce(new.state, '')) in ('AUTHORISED', 'AUTHORIZED', 'COMPLETED');
  if v_is_authorized and not v_was_authorized and new.kind in ('trial_setup', 'resubscribe') then
    select e.id into v_previous from public.paywall_funnel_events e
    where e.dedupe_key = 'checkout_started:revolut:' || new.order_id;
    insert into public.paywall_funnel_events (
      user_id, event_type, event_source, experiment_key, experiment_variant,
      placement, surface, plan_code, billing_cadence, price_amount_minor, price_currency,
      order_id, previous_event_id, dedupe_key, occurred_at,
      metadata
    ) values (
      new.user_id, 'order_authorized', 'checkout_order', new.experiment_key,
      new.experiment_variant, new.paywall_placement, new.paywall_surface, new.plan, new.period,
      new.requested_amount_cents, upper(new.currency), new.order_id, v_previous,
      'order_authorized:revolut:' || new.order_id,
      coalesce(new.last_reconciled_at, new.updated_at, now()),
      jsonb_build_object('provider_state', upper(coalesce(new.state, '')))
    ) on conflict (dedupe_key) do nothing;
  end if;
  return new;
end
$function$;

drop trigger if exists revolut_order_funnel_event on public.cloud_revolut_orders;
create trigger revolut_order_funnel_event
  after insert or update of state on public.cloud_revolut_orders
  for each row execute function public.norva_revolut_order_funnel_event();

create or replace function public.norva_billing_ledger_funnel_event()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_assignment public.paywall_experiment_assignments%rowtype;
  v_previous uuid;
begin
  if new.user_id is null or new.status <> 'captured'
     or new.kind not in ('first_charge', 'resubscribe')
     or exists (select 1 from public.admin_internal_accounts i where i.user_id = new.user_id) then
    return new;
  end if;
  select * into v_assignment from public.paywall_experiment_assignments a
  where a.user_id = new.user_id
  order by a.assigned_at desc limit 1;
  select e.id into v_previous from public.paywall_funnel_events e
  where e.user_id = new.user_id and e.event_type in ('order_authorized', 'checkout_started', 'paywall_exposed')
    and (new.experiment_key is null or e.experiment_key = new.experiment_key)
    order by e.occurred_at desc, e.id desc limit 1;
  insert into public.paywall_funnel_events (
    user_id, event_type, event_source, experiment_key, experiment_variant,
    placement, surface, plan_code, billing_cadence, price_amount_minor, price_currency,
    order_id, previous_event_id, dedupe_key, occurred_at,
    metadata
  ) values (
    new.user_id, 'payment_captured', 'billing_ledger',
    coalesce(new.experiment_key, v_assignment.experiment_key),
    coalesce(new.experiment_variant, v_assignment.variant),
    new.paywall_placement, new.paywall_surface,
    new.plan_code, new.bill_period, new.amount, upper(new.currency),
    coalesce(new.order_id, new.pi_id), v_previous,
    'payment_captured:ledger:' || new.pi_id,
    coalesce(new.updated_at, new.created_at, now()),
    jsonb_build_object('provider', new.provider, 'kind', new.kind)
  ) on conflict (dedupe_key) do nothing;
  return new;
end
$function$;

drop trigger if exists billing_ledger_funnel_event on public.cloud_billing_ledger;
create trigger billing_ledger_funnel_event
  after insert or update of status on public.cloud_billing_ledger
  for each row execute function public.norva_billing_ledger_funnel_event();

create or replace function public.norva_entitlement_activation_funnel_event()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_assignment public.paywall_experiment_assignments%rowtype;
  v_previous public.paywall_funnel_events%rowtype;
  v_entitlement_event_id uuid;
  v_activation_key text;
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

  select * into v_previous from public.paywall_funnel_events e
  where e.user_id = new.user_id and e.event_type in ('payment_captured', 'order_authorized', 'paywall_exposed')
    and e.occurred_at <= coalesce(new.last_event_at, new.updated_at, now()) + interval '5 minutes'
  order by
    case e.event_type when 'payment_captured' then 0 when 'order_authorized' then 1 else 2 end,
    e.occurred_at desc, e.id desc limit 1;
  if found then
    select * into v_assignment from public.paywall_experiment_assignments a
    where a.user_id = new.user_id and a.experiment_key = v_previous.experiment_key;
  else
    select * into v_assignment from public.paywall_experiment_assignments a
    where a.user_id = new.user_id order by a.assigned_at desc limit 1;
  end if;
  v_activation_key := 'entitlement_activated:' || new.user_id::text || ':'
    || coalesce(new.provider, 'unknown') || ':'
    || coalesce(new.last_event_at::text, new.updated_at::text, new.created_at::text);

  -- Webhooks write the authoritative entitlement journal before applying the
  -- projection. Revolut's billing worker may write it immediately afterwards;
  -- the companion trigger below fills that narrow asynchronous window.
  select ce.id into v_entitlement_event_id
  from public.cloud_entitlement_events ce
  where ce.user_id = new.user_id
    and (
      ce.provider = new.provider
      or (
        new.provider in ('google_play', 'apple_app_store', 'web', 'stripe', 'revenuecat')
        and ce.provider = 'revenuecat'
      )
    )
    and coalesce(ce.processed_at, ce.created_at)
      <= coalesce(new.last_event_at, new.updated_at, now()) + interval '5 minutes'
  order by coalesce(ce.processed_at, ce.created_at) desc, ce.id desc
  limit 1;
  insert into public.paywall_funnel_events (
    user_id, event_type, event_source, experiment_key, experiment_variant,
    placement, surface, plan_code, billing_cadence, price_amount_minor, price_currency,
    order_id, entitlement_event_id, previous_event_id, dedupe_key, occurred_at,
    metadata
  ) values (
    new.user_id, 'entitlement_activated', 'entitlement_projection',
    coalesce(v_previous.experiment_key, v_assignment.experiment_key),
    coalesce(v_previous.experiment_variant, v_assignment.variant),
    v_previous.placement, v_previous.surface, new.plan_code, new.bill_period,
    -- Price means the amount actually represented by the causal purchase, not
    -- MRR. In particular an annual subscription must never be stamped as one
    -- month of revenue.
    v_previous.price_amount_minor, v_previous.price_currency,
    v_previous.order_id, v_entitlement_event_id, v_previous.id, v_activation_key,
    coalesce(new.last_event_at, new.updated_at, now()),
    jsonb_build_object(
      'provider', new.provider,
      'status', new.status,
      'commercial_terms_source', case
        when v_previous.event_type = 'payment_captured' then 'captured_payment_event'
        when v_previous.event_type = 'order_authorized' then 'authorized_checkout_snapshot'
        else 'no_purchase_trial_or_grant'
      end
    )
  ) on conflict (dedupe_key) do nothing;
  return new;
end
$function$;

drop trigger if exists entitlement_activation_funnel_event on public.cloud_entitlement_projection;
create trigger entitlement_activation_funnel_event
  after insert or update of status, provider, plan_code
  on public.cloud_entitlement_projection
  for each row execute function public.norva_entitlement_activation_funnel_event();

-- The Revolut billing worker journals its lifecycle event just after atomically
-- applying the projection. Attach that authoritative event id to the already
-- inserted activation row without manufacturing a second funnel stage.
create or replace function public.norva_link_entitlement_event_to_funnel()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if new.user_id is null
     or exists (select 1 from public.admin_internal_accounts i where i.user_id = new.user_id)
     or upper(coalesce(new.event_type, '')) not in (
       'INITIAL_PURCHASE', 'NON_RENEWING_PURCHASE', 'TRIAL_STARTED',
       'RESUBSCRIBE_PURCHASE_CAPTURED', 'PAYMENT_RECOVERED', 'RENEWAL',
       'UNCANCELLATION', 'SUBSCRIPTION_EXTENDED', 'REFUND_REVERSED'
     ) then
    return new;
  end if;

  update public.paywall_funnel_events e
  set entitlement_event_id = new.id,
      metadata = e.metadata || jsonb_build_object(
        'entitlement_event_link', 'post_projection_journal'
      )
  where e.id = (
    select candidate.id
    from public.paywall_funnel_events candidate
    where candidate.user_id = new.user_id
      and candidate.event_type = 'entitlement_activated'
      and candidate.entitlement_event_id is null
      and candidate.occurred_at between
        coalesce(new.processed_at, new.created_at) - interval '5 minutes'
        and coalesce(new.processed_at, new.created_at) + interval '5 minutes'
    order by abs(extract(epoch from (
      candidate.occurred_at - coalesce(new.processed_at, new.created_at)
    ))), candidate.occurred_at desc
    limit 1
  );
  return new;
end
$function$;

drop trigger if exists link_entitlement_event_to_funnel on public.cloud_entitlement_events;
create trigger link_entitlement_event_to_funnel
  after insert or update of processed_at on public.cloud_entitlement_events
  for each row execute function public.norva_link_entitlement_event_to_funnel();

create or replace function public.norva_first_play_funnel_event()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_activation public.paywall_funnel_events%rowtype;
begin
  if new.event_type <> 'first_frame'
     or exists (select 1 from public.admin_internal_accounts i where i.user_id = new.user_id) then
    return new;
  end if;
  select * into v_activation from public.paywall_funnel_events e
  where e.user_id = new.user_id and e.event_type = 'entitlement_activated'
    and e.occurred_at <= new.created_at
  order by e.occurred_at desc, e.id desc limit 1;
  if not found then return new; end if;
  insert into public.paywall_funnel_events (
    user_id, event_type, event_source, experiment_key, experiment_variant,
    placement, surface, plan_code, billing_cadence, price_amount_minor, price_currency,
    order_id, playback_event_id, previous_event_id, dedupe_key, occurred_at,
    metadata
  ) values (
    new.user_id, 'first_play', 'playback_first_frame',
    v_activation.experiment_key, v_activation.experiment_variant,
    v_activation.placement, v_activation.surface, v_activation.plan_code, v_activation.billing_cadence,
    v_activation.price_amount_minor, v_activation.price_currency,
    v_activation.order_id, new.id, v_activation.id,
    'first_play:activation:' || v_activation.id::text,
    new.created_at,
    jsonb_build_object(
      'item_type', new.item_type,
      'playback_mode', new.playback_mode,
      'time_to_first_frame_ms', new.time_to_first_frame_ms
    )
  ) on conflict (dedupe_key) do nothing;
  return new;
end
$function$;

drop trigger if exists first_play_funnel_event on public.cloud_playback_events;
create trigger first_play_funnel_event
  after insert on public.cloud_playback_events
  for each row execute function public.norva_first_play_funnel_event();

-- Detailed analysis view: one row per causal event. Service role only; no PII.
create or replace view public.norva_paywall_funnel as
select
  e.id,
  e.occurred_at,
  e.user_id,
  e.event_type,
  e.experiment_key,
  e.experiment_variant as variant,
  e.placement,
  e.surface,
  e.plan_code,
  e.billing_cadence,
  e.price_amount_minor,
  e.price_currency,
  e.order_id,
  e.entitlement_event_id,
  e.previous_event_id,
  e.event_source,
  e.metadata
from public.paywall_funnel_events e
where not exists (
  select 1 from public.admin_internal_accounts i where i.user_id = e.user_id
);

revoke all on public.norva_paywall_funnel from public, anon, authenticated;
grant select on public.norva_paywall_funnel to service_role;

-- Add paywall exposure to the existing admin daily funnel without replacing its
-- authoritative cross-rail stages. Existing downstream readers can opt into the
-- richer view above for variant/placement joins.
create or replace view public.norva_paywall_funnel_daily as
select
  e.occurred_at::date as day,
  e.event_type as stage,
  e.experiment_key,
  e.experiment_variant as variant,
  e.placement,
  e.surface,
  count(distinct e.user_id)::integer as users
from public.paywall_funnel_events e
where not exists (
  select 1 from public.admin_internal_accounts i where i.user_id = e.user_id
)
group by e.occurred_at::date, e.event_type, e.experiment_key, e.experiment_variant, e.placement, e.surface;

revoke all on public.norva_paywall_funnel_daily from public, anon, authenticated;
grant select on public.norva_paywall_funnel_daily to service_role;

-- Admin dashboard contract. Kept separate from admin_finance() so the existing
-- finance payload stays backwards-compatible while paywall dimensions remain
-- first-class and queryable.
create or replace function public.admin_paywall_funnel_30d()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_stages jsonb;
  v_stage_totals jsonb;
  v_stage_rollup jsonb;
  v_assignments jsonb;
  v_experiments jsonb;
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(to_jsonb(stage_row) order by stage_row.day, stage_row.stage,
    stage_row.experiment_key, stage_row.variant, stage_row.placement, stage_row.surface), '[]'::jsonb)
  into v_stages
  from (
    select
      e.occurred_at::date as day,
      e.event_type as stage,
      e.experiment_key,
      e.experiment_variant as variant,
      e.placement,
      e.surface,
      count(distinct e.user_id)::integer as users,
      count(*)::integer as events
    from public.paywall_funnel_events e
    where e.occurred_at >= current_date - interval '29 days'
      and not exists (
        select 1 from public.admin_internal_accounts i where i.user_id = e.user_id
      )
    group by e.occurred_at::date, e.event_type, e.experiment_key,
      e.experiment_variant, e.placement, e.surface
  ) stage_row;

  select coalesce(jsonb_agg(to_jsonb(total_row) order by total_row.stage,
    total_row.experiment_key, total_row.variant, total_row.placement, total_row.surface), '[]'::jsonb)
  into v_stage_totals
  from (
    select
      e.event_type as stage,
      e.experiment_key,
      e.experiment_variant as variant,
      e.placement,
      e.surface,
      count(distinct e.user_id)::integer as users,
      count(*)::integer as events
    from public.paywall_funnel_events e
    where e.occurred_at >= current_date - interval '29 days'
      and not exists (
        select 1 from public.admin_internal_accounts i where i.user_id = e.user_id
      )
    group by e.event_type, e.experiment_key, e.experiment_variant, e.placement, e.surface
  ) total_row;

  select coalesce(jsonb_agg(to_jsonb(rollup_row) order by rollup_row.stage), '[]'::jsonb)
  into v_stage_rollup
  from (
    select
      e.event_type as stage,
      count(distinct e.user_id)::integer as users,
      count(*)::integer as events
    from public.paywall_funnel_events e
    where e.occurred_at >= current_date - interval '29 days'
      and not exists (
        select 1 from public.admin_internal_accounts i where i.user_id = e.user_id
      )
    group by e.event_type
  ) rollup_row;

  select coalesce(jsonb_agg(to_jsonb(assignment_row) order by assignment_row.experiment_key,
    assignment_row.variant), '[]'::jsonb)
  into v_assignments
  from (
    select a.experiment_key, a.variant, count(*)::integer as accounts
    from public.paywall_experiment_assignments a
    where not exists (
      select 1 from public.admin_internal_accounts i where i.user_id = a.user_id
    )
    group by a.experiment_key, a.variant
  ) assignment_row;

  select coalesce(jsonb_agg(to_jsonb(experiment_row) order by experiment_row.experiment_key), '[]'::jsonb)
  into v_experiments
  from (
    select
      x.experiment_key,
      x.active,
      x.starts_at,
      x.ends_at,
      coalesce(jsonb_agg(jsonb_build_object(
        'variant', v.variant,
        'allocation_bps', v.allocation_bps,
        'active', v.active
      ) order by v.ordinal) filter (where v.variant is not null), '[]'::jsonb) as variants
    from public.paywall_experiments x
    left join public.paywall_experiment_variants v on v.experiment_key = x.experiment_key
    group by x.experiment_key, x.active, x.starts_at, x.ends_at
  ) experiment_row;

  return jsonb_build_object(
    'window_days', 30,
    'generated_at', now(),
    'experiments', v_experiments,
    'assignments', v_assignments,
    'stage_rollup', v_stage_rollup,
    'stage_totals', v_stage_totals,
    'stages', v_stages
  );
end
$function$;

revoke all on function public.admin_paywall_funnel_30d() from public, anon;
grant execute on function public.admin_paywall_funnel_30d() to authenticated, service_role;

notify pgrst, 'reload schema';
