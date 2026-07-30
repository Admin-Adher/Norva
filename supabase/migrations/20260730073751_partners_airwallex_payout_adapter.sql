-- Norva Partners - fail-closed Airwallex payout adapter.
--
-- This migration installs no provider configuration and flips no release
-- gate. A real transfer is possible only when an approved LIVE cycle, the
-- existing partners_payouts_live flag, every payout release gate, an active
-- Airwallex country/currency route and the Edge secret contract all agree.
--
-- Provider bank details never enter PostgreSQL. The private payout profile
-- stores only the opaque Airwallex beneficiary id and a masked label.

alter table affiliate_private.affiliate_payout_provider_configs
  drop constraint affiliate_payout_provider_configs_provider;
alter table affiliate_private.affiliate_payout_provider_configs
  add constraint affiliate_payout_provider_configs_provider
  check (
    provider in (
      'airwallex',
      'wise',
      'revolut',
      'stripe_connect'
    )
  );

alter table affiliate_private.affiliate_payout_profiles
  drop constraint affiliate_payout_profiles_provider;
alter table affiliate_private.affiliate_payout_profiles
  add constraint affiliate_payout_profiles_provider
  check (
    provider in (
      'airwallex',
      'wise',
      'revolut',
      'stripe_connect'
    )
  );
alter table affiliate_private.affiliate_payout_profiles
  add column transfer_method text;
alter table affiliate_private.affiliate_payout_profiles
  add constraint affiliate_payout_profiles_transfer_method
  check (
    (provider = 'airwallex' and transfer_method in ('LOCAL', 'SWIFT'))
    or (provider <> 'airwallex' and transfer_method is null)
  );

create table affiliate_private.affiliate_airwallex_beneficiary_reservations (
  id                    uuid primary key default gen_random_uuid(),
  reservation_key       text not null unique default (
    'pbr_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  account_id            uuid not null
    references affiliate_private.affiliate_accounts(id)
    on delete restrict,
  currency              text not null,
  transfer_method       text not null,
  idempotency_hash      text not null,
  request_hash          text not null,
  status                text not null default 'prepared',
  provider_id_hash      text,
  last_error_code       text,
  provider_call_started_at timestamptz,
  completed_at          timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint affiliate_airwallex_beneficiary_reservations_key
    check (reservation_key ~ '^pbr_[0-9a-f]{24}$'),
  constraint affiliate_airwallex_beneficiary_reservations_currency
    check (currency ~ '^[A-Z]{3}$'),
  constraint affiliate_airwallex_beneficiary_reservations_method
    check (transfer_method in ('LOCAL', 'SWIFT')),
  constraint affiliate_airwallex_beneficiary_reservations_hashes
    check (
      idempotency_hash ~ '^[0-9a-f]{64}$'
      and request_hash ~ '^[0-9a-f]{64}$'
      and (
        provider_id_hash is null
        or provider_id_hash ~ '^[0-9a-f]{64}$'
      )
    ),
  constraint affiliate_airwallex_beneficiary_reservations_status
    check (
      status in ('prepared', 'calling', 'recorded', 'unknown', 'failed')
    ),
  constraint affiliate_airwallex_beneficiary_reservations_error
    check (
      last_error_code is null
      or last_error_code ~ '^[a-z0-9][a-z0-9._-]{1,63}$'
    ),
  constraint affiliate_airwallex_beneficiary_reservations_lifecycle
    check (
      (status = 'prepared'
        and provider_call_started_at is null
        and completed_at is null)
      or (status = 'calling'
        and provider_call_started_at is not null
        and completed_at is null)
      or (status in ('recorded', 'unknown', 'failed')
        and provider_call_started_at is not null
        and completed_at is not null)
    ),
  unique (account_id, currency, idempotency_hash)
);

create unique index
affiliate_airwallex_beneficiary_reservations_open_idx
  on affiliate_private.affiliate_airwallex_beneficiary_reservations (
    account_id,
    currency
  )
  where status in ('prepared', 'calling', 'unknown');

create table affiliate_private.affiliate_payout_dispatches (
  id                    uuid primary key default gen_random_uuid(),
  dispatch_key          text not null unique default (
    'pds_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  payout_item_id        uuid not null unique
    references affiliate_private.affiliate_payout_items(id)
    on delete restrict,
  provider              text not null default 'airwallex',
  request_id            text not null unique default (
    'nv_' || replace(gen_random_uuid()::text, '-', '')
  ),
  job_status            text not null default 'pending',
  provider_state        text,
  provider_status       text,
  funding_status        text,
  provider_transfer_id  text,
  provider_transfer_hash text,
  reconciliation_status text not null default 'not_ready',
  worker_id             text,
  lease_token_hash      text,
  leased_until          timestamptz,
  attempts              integer not null default 0,
  next_attempt_at       timestamptz not null default now(),
  last_error_code       text,
  provider_updated_at   timestamptz,
  submitted_at          timestamptz,
  paid_observed_at      timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint affiliate_payout_dispatches_key
    check (dispatch_key ~ '^pds_[0-9a-f]{24}$'),
  constraint affiliate_payout_dispatches_provider
    check (provider = 'airwallex'),
  constraint affiliate_payout_dispatches_request
    check (
      length(request_id) between 8 and 50
      and request_id ~ '^[A-Za-z0-9._:-]+$'
    ),
  constraint affiliate_payout_dispatches_job_status
    check (
      job_status in (
        'pending',
        'leased',
        'observing',
        'exception',
        'dead_letter'
      )
    ),
  constraint affiliate_payout_dispatches_provider_state
    check (
      provider_state is null
      or provider_state in (
        'SCHEDULED',
        'PROCESSING',
        'SENT',
        'PAID',
        'FAILED',
        'CANCELLED',
        'REVERSED'
      )
    ),
  constraint affiliate_payout_dispatches_provider_status
    check (
      (provider_status is null or provider_status ~ '^[A-Z][A-Z_]{2,47}$')
      and (funding_status is null or funding_status ~ '^[A-Z][A-Z_]{2,47}$')
    ),
  constraint affiliate_payout_dispatches_transfer
    check (
      (
        provider_transfer_id is null
        and provider_transfer_hash is null
      )
      or (
        length(provider_transfer_id) between 8 and 128
        and provider_transfer_id !~ '[[:space:][:cntrl:]]'
        and provider_transfer_hash ~ '^[0-9a-f]{64}$'
      )
    ),
  constraint affiliate_payout_dispatches_reconciliation
    check (
      reconciliation_status in (
        'not_ready',
        'pending',
        'confirmed',
        'exception',
        'reversed'
      )
      and (
        provider_state <> 'PAID'
        or reconciliation_status in ('pending', 'confirmed', 'exception')
      )
      and (
        provider_state <> 'REVERSED'
        or reconciliation_status = 'reversed'
      )
    ),
  constraint affiliate_payout_dispatches_lease
    check (
      (
        job_status <> 'leased'
        and worker_id is null
        and lease_token_hash is null
        and leased_until is null
      )
      or (
        job_status = 'leased'
        and worker_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$'
        and lease_token_hash ~ '^[0-9a-f]{64}$'
        and leased_until is not null
      )
    ),
  constraint affiliate_payout_dispatches_attempts
    check (attempts between 0 and 20),
  constraint affiliate_payout_dispatches_error
    check (
      last_error_code is null
      or last_error_code ~ '^[a-z0-9][a-z0-9._-]{1,63}$'
    )
);

create unique index affiliate_payout_dispatches_provider_id_idx
  on affiliate_private.affiliate_payout_dispatches (
    provider,
    provider_transfer_hash
  )
  where provider_transfer_hash is not null;
create index affiliate_payout_dispatches_work_idx
  on affiliate_private.affiliate_payout_dispatches (
    job_status,
    next_attempt_at,
    created_at
  );
create index affiliate_payout_dispatches_reconcile_idx
  on affiliate_private.affiliate_payout_dispatches (
    provider_state,
    reconciliation_status,
    next_attempt_at
  )
  where provider_transfer_id is not null;

create table affiliate_private.affiliate_payout_provider_events (
  id                    uuid primary key default gen_random_uuid(),
  dispatch_id           uuid not null
    references affiliate_private.affiliate_payout_dispatches(id)
    on delete restrict,
  provider              text not null default 'airwallex',
  provider_event_hash   text not null unique,
  provider_state        text not null,
  observed_at           timestamptz not null,
  created_at            timestamptz not null default now(),
  constraint affiliate_payout_provider_events_provider
    check (provider = 'airwallex'),
  constraint affiliate_payout_provider_events_hash
    check (provider_event_hash ~ '^[0-9a-f]{64}$'),
  constraint affiliate_payout_provider_events_state
    check (
      provider_state in (
        'SCHEDULED',
        'PROCESSING',
        'SENT',
        'PAID',
        'FAILED',
        'CANCELLED',
        'REVERSED'
      )
    )
);

create index affiliate_payout_provider_events_dispatch_idx
  on affiliate_private.affiliate_payout_provider_events (
    dispatch_id,
    observed_at desc
  );

alter table affiliate_private.affiliate_airwallex_beneficiary_reservations
  enable row level security;
alter table affiliate_private.affiliate_payout_dispatches
  enable row level security;
alter table affiliate_private.affiliate_payout_provider_events
  enable row level security;

revoke all on table
  affiliate_private.affiliate_airwallex_beneficiary_reservations,
  affiliate_private.affiliate_payout_dispatches,
  affiliate_private.affiliate_payout_provider_events
from public, anon, authenticated, service_role;

create or replace function
affiliate_private.admin_partners_payout_provider_set(
  p_provider text,
  p_country_code text,
  p_currency text,
  p_status text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_provider text := lower(btrim(coalesce(p_provider, '')));
  v_country text := upper(btrim(coalesce(p_country_code, '')));
  v_currency text := upper(btrim(coalesce(p_currency, '')));
  v_status text := lower(btrim(coalesce(p_status, '')));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_actor text;
begin
  perform affiliate_private.partners_require_capability('finance');
  if v_provider not in (
      'airwallex', 'wise', 'revolut', 'stripe_connect'
    )
    or v_country !~ '^[A-Z]{2}$'
    or v_currency !~ '^[A-Z]{3}$'
    or v_status not in ('active', 'disabled')
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid payout provider configuration'
      using errcode = '22023';
  end if;
  if v_status = 'active' and not exists (
    select 1
    from affiliate_private.affiliate_currency_metadata c
    where c.currency_code = v_currency
      and c.status = 'active'
  ) then
    raise exception 'active currency metadata is required'
      using errcode = 'P0001';
  end if;
  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  insert into affiliate_private.affiliate_payout_provider_configs (
    provider,
    country_code,
    currency,
    status,
    configured_by_pseudonym,
    justification,
    updated_at
  )
  values (
    v_provider,
    v_country,
    v_currency,
    v_status,
    v_actor,
    v_justification,
    now()
  )
  on conflict (provider, country_code, currency) do update
  set
    status = excluded.status,
    configured_by_pseudonym = excluded.configured_by_pseudonym,
    justification = excluded.justification,
    updated_at = now();
  return jsonb_build_object(
    'schema_version', 1,
    'action', 'payout_provider_set',
    'status', v_status
  );
end;
$$;

create or replace function
affiliate_private.partners_service_airwallex_beneficiary_prepare(
  p_user_id uuid,
  p_idempotency_key text,
  p_currency text,
  p_transfer_method text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_currency text := upper(btrim(coalesce(p_currency, '')));
  v_method text := upper(btrim(coalesce(p_transfer_method, '')));
  v_idempotency_hash text;
  v_request_hash text;
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_fiscal affiliate_private.affiliate_fiscal_profiles%rowtype;
  v_profile affiliate_private.affiliate_payout_profiles%rowtype;
  v_reservation
    affiliate_private.affiliate_airwallex_beneficiary_reservations%rowtype;
begin
  if p_user_id is null
    or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
    or v_currency !~ '^[A-Z]{3}$'
    or v_method not in ('LOCAL', 'SWIFT')
  then
    raise exception 'invalid Airwallex beneficiary request'
      using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:airwallex-beneficiary:' || p_user_id::text,
      0
    )
  );
  v_idempotency_hash := encode(
    extensions.digest(
      'airwallex-beneficiary-idempotency:v1:'
      || p_user_id::text || ':' || p_idempotency_key,
      'sha256'
    ),
    'hex'
  );
  v_request_hash := encode(
    extensions.digest(
      'airwallex-beneficiary:v1:'
      || p_user_id::text || ':' || v_currency || ':' || v_method,
      'sha256'
    ),
    'hex'
  );

  select a.*
  into v_account
  from affiliate_private.affiliate_accounts a
  where a.user_id = p_user_id
    and a.account_type = 'individual'
    and a.status = 'active'
    and a.verification_status = 'verified'
  for update;
  if not found then
    raise exception 'Partner is not ready for payout setup'
      using errcode = 'P0001';
  end if;
  select f.*
  into v_fiscal
  from affiliate_private.affiliate_fiscal_profiles f
  where f.account_id = v_account.id
    and f.status = 'verified';
  if not found then
    raise exception 'verified fiscal profile is required'
      using errcode = 'P0001';
  end if;
  if not exists (
    select 1
    from affiliate_private.affiliate_currency_metadata c
    where c.currency_code = v_currency
      and c.status = 'active'
  ) or not exists (
    select 1
    from affiliate_private.affiliate_payout_provider_configs c
    where c.provider = 'airwallex'
      and c.country_code = v_account.country_code
      and c.currency = v_currency
      and c.status = 'active'
  ) or not exists (
    select 1
    from affiliate_private.affiliate_country_policies cp
    where cp.id = v_account.country_policy_id
      and v_currency = any (cp.payout_currencies)
  ) then
    raise exception 'Airwallex route is not configured'
      using errcode = 'P0001';
  end if;

  select p.*
  into v_profile
  from affiliate_private.affiliate_payout_profiles p
  where p.account_id = v_account.id
    and p.currency = v_currency
    and p.provider = 'airwallex'
    and p.status = 'active';
  if found then
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'airwallex_beneficiary_prepared',
      'replayed', true,
      'beneficiary', jsonb_build_object(
        'status', 'recorded',
        'display_masked', v_profile.display_masked,
        'currency', v_profile.currency,
        'transfer_method', v_profile.transfer_method
      )
    );
  end if;

  select r.*
  into v_reservation
  from affiliate_private.affiliate_airwallex_beneficiary_reservations r
  where r.account_id = v_account.id
    and r.currency = v_currency
    and r.idempotency_hash = v_idempotency_hash
  for update;
  if found then
    if v_reservation.request_hash <> v_request_hash then
      raise exception 'idempotency key conflicts with request'
        using errcode = 'P0005';
    end if;
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'airwallex_beneficiary_prepared',
      'replayed', true,
      'beneficiary', jsonb_build_object(
        'status', v_reservation.status,
        'reservation_key', v_reservation.reservation_key,
        'currency', v_reservation.currency,
        'transfer_method', v_reservation.transfer_method
      )
    );
  end if;
  if exists (
    select 1
    from affiliate_private.affiliate_airwallex_beneficiary_reservations r
    where r.account_id = v_account.id
      and r.currency = v_currency
      and r.status in ('prepared', 'calling', 'unknown')
  ) then
    raise exception 'Airwallex beneficiary setup requires review'
      using errcode = 'P0004';
  end if;

  insert into
    affiliate_private.affiliate_airwallex_beneficiary_reservations (
      account_id,
      currency,
      transfer_method,
      idempotency_hash,
      request_hash
    )
  values (
    v_account.id,
    v_currency,
    v_method,
    v_idempotency_hash,
    v_request_hash
  )
  returning * into v_reservation;
  return jsonb_build_object(
    'schema_version', 1,
    'action', 'airwallex_beneficiary_prepared',
    'replayed', false,
    'beneficiary', jsonb_build_object(
      'status', 'prepared',
      'reservation_key', v_reservation.reservation_key,
      'currency', v_reservation.currency,
      'transfer_method', v_reservation.transfer_method
    )
  );
end;
$$;

create or replace function
affiliate_private.partners_service_airwallex_beneficiary_start(
  p_user_id uuid,
  p_reservation_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := lower(btrim(coalesce(p_reservation_key, '')));
  v_reservation
    affiliate_private.affiliate_airwallex_beneficiary_reservations%rowtype;
begin
  if p_user_id is null or v_key !~ '^pbr_[0-9a-f]{24}$' then
    raise exception 'invalid Airwallex beneficiary reservation'
      using errcode = '22023';
  end if;
  select r.*
  into v_reservation
  from affiliate_private.affiliate_airwallex_beneficiary_reservations r
  join affiliate_private.affiliate_accounts a
    on a.id = r.account_id
  where r.reservation_key = v_key
    and a.user_id = p_user_id
  for update of r;
  if not found or v_reservation.status <> 'prepared' then
    raise exception 'Airwallex beneficiary call is not startable'
      using errcode = 'P0004';
  end if;
  update affiliate_private.affiliate_airwallex_beneficiary_reservations
  set
    status = 'calling',
    provider_call_started_at = now(),
    updated_at = now()
  where id = v_reservation.id;
  return jsonb_build_object(
    'schema_version', 1,
    'action', 'airwallex_beneficiary_started',
    'reservation_key', v_key
  );
end;
$$;

create or replace function
affiliate_private.partners_service_airwallex_beneficiary_record(
  p_user_id uuid,
  p_reservation_key text,
  p_provider_beneficiary_id text,
  p_display_masked text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := lower(btrim(coalesce(p_reservation_key, '')));
  v_provider_id text := btrim(coalesce(p_provider_beneficiary_id, ''));
  v_masked text := btrim(coalesce(p_display_masked, ''));
  v_provider_hash text;
  v_reservation
    affiliate_private.affiliate_airwallex_beneficiary_reservations%rowtype;
  v_profile affiliate_private.affiliate_payout_profiles%rowtype;
begin
  if p_user_id is null
    or v_key !~ '^pbr_[0-9a-f]{24}$'
    or length(v_provider_id) not between 8 and 128
    or v_provider_id ~ '[[:space:][:cntrl:]]'
    or length(v_masked) not between 4 and 64
    or v_masked ~ '[[:cntrl:]]'
    or v_masked ~* '[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}'
    or v_masked ~ '[0-9]{6,}'
  then
    raise exception 'invalid tokenized Airwallex beneficiary'
      using errcode = '22023';
  end if;
  select r.*
  into v_reservation
  from affiliate_private.affiliate_airwallex_beneficiary_reservations r
  join affiliate_private.affiliate_accounts a
    on a.id = r.account_id
  where r.reservation_key = v_key
    and a.user_id = p_user_id
  for update of r;
  if not found or v_reservation.status <> 'calling' then
    raise exception 'Airwallex beneficiary reservation is unavailable'
      using errcode = 'P0004';
  end if;
  v_provider_hash := encode(
    extensions.digest(v_provider_id, 'sha256'),
    'hex'
  );
  insert into affiliate_private.affiliate_payout_profiles (
    account_id,
    provider,
    beneficiary_token_ref,
    display_masked,
    currency,
    transfer_method,
    status,
    updated_at
  )
  values (
    v_reservation.account_id,
    'airwallex',
    v_provider_id,
    v_masked,
    v_reservation.currency,
    v_reservation.transfer_method,
    'active',
    now()
  )
  on conflict (account_id, currency) do update
  set
    provider = 'airwallex',
    beneficiary_token_ref = excluded.beneficiary_token_ref,
    display_masked = excluded.display_masked,
    transfer_method = excluded.transfer_method,
    status = 'active',
    updated_at = now()
  returning * into v_profile;
  update affiliate_private.affiliate_airwallex_beneficiary_reservations
  set
    status = 'recorded',
    provider_id_hash = v_provider_hash,
    completed_at = now(),
    updated_at = now()
  where id = v_reservation.id;
  insert into affiliate_private.affiliate_events (
    aggregate_type,
    aggregate_key,
    action,
    actor_type,
    actor_pseudonym,
    justification,
    after_state
  )
  select
    'payout',
    a.id::text,
    'airwallex_beneficiary_recorded',
    'service',
    a.user_pseudonym,
    'Opaque PERSONAL Airwallex beneficiary was recorded.',
    jsonb_build_object(
      'provider', 'airwallex',
      'currency', v_profile.currency,
      'transfer_method', v_profile.transfer_method,
      'status', v_profile.status
    )
  from affiliate_private.affiliate_accounts a
  where a.id = v_reservation.account_id;
  return jsonb_build_object(
    'schema_version', 1,
    'action', 'airwallex_beneficiary_recorded',
    'profile', jsonb_build_object(
      'provider', 'airwallex',
      'display_masked', v_profile.display_masked,
      'currency', v_profile.currency,
      'transfer_method', v_profile.transfer_method,
      'status', v_profile.status
    )
  );
end;
$$;

create or replace function
affiliate_private.partners_service_airwallex_beneficiary_unknown(
  p_user_id uuid,
  p_reservation_key text,
  p_error_code text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := lower(btrim(coalesce(p_reservation_key, '')));
  v_error text := lower(btrim(coalesce(p_error_code, '')));
begin
  if p_user_id is null
    or v_key !~ '^pbr_[0-9a-f]{24}$'
    or v_error !~ '^[a-z0-9][a-z0-9._-]{1,63}$'
  then
    raise exception 'invalid Airwallex beneficiary failure'
      using errcode = '22023';
  end if;
  update affiliate_private.affiliate_airwallex_beneficiary_reservations r
  set
    status = 'unknown',
    last_error_code = v_error,
    completed_at = now(),
    updated_at = now()
  from affiliate_private.affiliate_accounts a
  where r.reservation_key = v_key
    and r.account_id = a.id
    and a.user_id = p_user_id
    and r.status = 'calling';
  if not found then
    raise exception 'Airwallex beneficiary reservation is unavailable'
      using errcode = 'P0004';
  end if;
  return jsonb_build_object(
    'schema_version', 1,
    'action', 'airwallex_beneficiary_unknown',
    'status', 'manual_review_required'
  );
end;
$$;

create or replace function
affiliate_private.partners_payout_dispatch_transition_allowed(
  p_previous text,
  p_next text
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when p_next not in (
      'SCHEDULED', 'PROCESSING', 'SENT', 'PAID',
      'FAILED', 'CANCELLED', 'REVERSED'
    ) then false
    when p_previous is null then true
    when p_previous = 'SCHEDULED' then p_next in (
      'SCHEDULED', 'PROCESSING', 'SENT', 'PAID',
      'FAILED', 'CANCELLED', 'REVERSED'
    )
    when p_previous = 'PROCESSING' then p_next in (
      'PROCESSING', 'SENT', 'PAID', 'FAILED', 'CANCELLED', 'REVERSED'
    )
    when p_previous = 'SENT' then p_next in (
      'SENT', 'PAID', 'FAILED', 'CANCELLED', 'REVERSED'
    )
    when p_previous = 'PAID' then p_next in (
      'PAID', 'FAILED', 'CANCELLED', 'REVERSED'
    )
    when p_previous = 'FAILED' then p_next in (
      'FAILED', 'CANCELLED', 'REVERSED'
    )
    when p_previous = 'CANCELLED' then p_next in (
      'CANCELLED', 'REVERSED'
    )
    when p_previous = 'REVERSED' then p_next = 'REVERSED'
    else false
  end;
$$;

create or replace function
affiliate_private.partners_worker_airwallex_dispatch_lease(
  p_worker_id text,
  p_lease_token_hash text,
  p_limit integer,
  p_lease_seconds integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_worker text := btrim(coalesce(p_worker_id, ''));
  v_lease text := lower(btrim(coalesce(p_lease_token_hash, '')));
  v_jobs jsonb;
  v_until timestamptz;
begin
  if v_worker !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$'
    or v_lease !~ '^[0-9a-f]{64}$'
    or p_limit not between 1 and 25
    or p_lease_seconds not between 30 and 300
  then
    raise exception 'invalid payout dispatch lease'
      using errcode = '22023';
  end if;
  if not coalesce((
    select f.enabled
    from public.admin_feature_flags f
    where f.key = 'partners_payouts_live'
  ), false) or not affiliate_private.release_gates_satisfied(
    array[
      'legal_and_tax_approved',
      'financial_data_contract_approved',
      'individual_payout_coverage_confirmed',
      'shadow_reconciliation_clean',
      'backup_restore_verified',
      'payout_execution_adapter_verified'
    ]::text[]
  ) then
    raise exception 'live payouts are not released'
      using errcode = 'P0001';
  end if;

  insert into affiliate_private.affiliate_payout_dispatches (
    payout_item_id
  )
  select item.id
  from affiliate_private.affiliate_payout_items item
  join affiliate_private.affiliate_payout_cycles cycle
    on cycle.id = item.cycle_id
  join affiliate_private.affiliate_payout_profiles profile
    on profile.id = item.payout_profile_id
  join affiliate_private.affiliate_accounts account
    on account.id = item.account_id
  join affiliate_private.affiliate_payout_provider_configs config
    on config.provider = 'airwallex'
    and config.country_code = account.country_code
    and config.currency = item.currency
    and config.status = 'active'
  where cycle.live_execution
    and cycle.status in ('approved', 'submitted')
    and cycle.approved_at is not null
    and item.status = 'pending'
    and item.amount_minor > 0
    and item.allocation_entry_id is not null
    and profile.provider = 'airwallex'
    and profile.status = 'active'
    and profile.transfer_method in ('LOCAL', 'SWIFT')
  order by cycle.approved_at, item.created_at, item.id
  on conflict (payout_item_id) do nothing;

  v_until := now() + make_interval(secs => p_lease_seconds);
  with candidates as (
    select d.id
    from affiliate_private.affiliate_payout_dispatches d
    join affiliate_private.affiliate_payout_items item
      on item.id = d.payout_item_id
    join affiliate_private.affiliate_payout_cycles cycle
      on cycle.id = item.cycle_id
    where d.provider_state is null
      and d.attempts < 8
      and d.next_attempt_at <= now()
      and (
        d.job_status = 'pending'
        or (
          d.job_status = 'leased'
          and d.leased_until < now()
        )
      )
      and cycle.live_execution
      and cycle.status in ('approved', 'submitted')
      and cycle.approved_at is not null
    order by cycle.approved_at, d.created_at, d.id
    for update of d skip locked
    limit p_limit
  ),
  leased as (
    update affiliate_private.affiliate_payout_dispatches d
    set
      job_status = 'leased',
      worker_id = v_worker,
      lease_token_hash = v_lease,
      leased_until = v_until,
      attempts = d.attempts + 1,
      updated_at = now()
    from candidates c
    where d.id = c.id
    returning d.*
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'key', d.dispatch_key,
      'request_id', d.request_id,
      'beneficiary_token_ref', profile.beneficiary_token_ref,
      'amount_minor', item.amount_minor,
      'currency', item.currency,
      'currency_exponent', cycle.currency_exponent,
      'transfer_method', profile.transfer_method
    )
    order by d.created_at, d.id
  ), '[]'::jsonb)
  into v_jobs
  from leased d
  join affiliate_private.affiliate_payout_items item
    on item.id = d.payout_item_id
  join affiliate_private.affiliate_payout_cycles cycle
    on cycle.id = item.cycle_id
  join affiliate_private.affiliate_payout_profiles profile
    on profile.id = item.payout_profile_id;
  return jsonb_build_object(
    'schema_version', 1,
    'leased_until', v_until,
    'jobs', v_jobs
  );
end;
$$;

create or replace function
affiliate_private.partners_worker_airwallex_dispatch_retry(
  p_dispatch_key text,
  p_worker_id text,
  p_lease_token_hash text,
  p_error_code text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := lower(btrim(coalesce(p_dispatch_key, '')));
  v_worker text := btrim(coalesce(p_worker_id, ''));
  v_lease text := lower(btrim(coalesce(p_lease_token_hash, '')));
  v_error text := lower(btrim(coalesce(p_error_code, '')));
  v_dispatch affiliate_private.affiliate_payout_dispatches%rowtype;
begin
  if v_key !~ '^pds_[0-9a-f]{24}$'
    or v_worker !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$'
    or v_lease !~ '^[0-9a-f]{64}$'
    or v_error !~ '^[a-z0-9][a-z0-9._-]{1,63}$'
  then
    raise exception 'invalid payout retry'
      using errcode = '22023';
  end if;
  update affiliate_private.affiliate_payout_dispatches d
  set
    job_status = case
      when d.attempts >= 8 then 'dead_letter'
      else 'pending'
    end,
    worker_id = null,
    lease_token_hash = null,
    leased_until = null,
    next_attempt_at = now() + case
      when d.attempts >= 8 then interval '100 years'
      else make_interval(secs => least(3600, 30 * (2 ^ d.attempts)::integer))
    end,
    last_error_code = v_error,
    updated_at = now()
  where d.dispatch_key = v_key
    and d.job_status = 'leased'
    and d.worker_id = v_worker
    and d.lease_token_hash = v_lease
    and d.leased_until >= now()
    and d.provider_state is null
  returning d.* into v_dispatch;
  if not found then
    raise exception 'payout dispatch lease was lost'
      using errcode = 'P0004';
  end if;
  return jsonb_build_object(
    'schema_version', 1,
    'action', 'airwallex_dispatch_retried',
    'dispatch', jsonb_build_object(
      'key', v_dispatch.dispatch_key,
      'status', v_dispatch.job_status
    )
  );
end;
$$;

create or replace function
affiliate_private.partners_worker_airwallex_reconcile_lease(
  p_worker_id text,
  p_lease_token_hash text,
  p_limit integer,
  p_lease_seconds integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_worker text := btrim(coalesce(p_worker_id, ''));
  v_lease text := lower(btrim(coalesce(p_lease_token_hash, '')));
  v_jobs jsonb;
  v_until timestamptz;
begin
  if v_worker !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$'
    or v_lease !~ '^[0-9a-f]{64}$'
    or p_limit not between 1 and 25
    or p_lease_seconds not between 30 and 300
  then
    raise exception 'invalid payout reconcile lease'
      using errcode = '22023';
  end if;
  v_until := now() + make_interval(secs => p_lease_seconds);
  with candidates as (
    select d.id
    from affiliate_private.affiliate_payout_dispatches d
    where d.provider_transfer_id is not null
      and d.provider_state in ('SCHEDULED', 'PROCESSING', 'SENT', 'PAID')
      and d.reconciliation_status <> 'confirmed'
      and d.next_attempt_at <= now()
      and (
        d.job_status = 'observing'
        or (
          d.job_status = 'leased'
          and d.leased_until < now()
        )
      )
    order by d.next_attempt_at, d.created_at, d.id
    for update of d skip locked
    limit p_limit
  ),
  leased as (
    update affiliate_private.affiliate_payout_dispatches d
    set
      job_status = 'leased',
      worker_id = v_worker,
      lease_token_hash = v_lease,
      leased_until = v_until,
      attempts = least(d.attempts + 1, 20),
      updated_at = now()
    from candidates c
    where d.id = c.id
    returning d.*
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'key', d.dispatch_key,
      'provider_transfer_id', d.provider_transfer_id
    )
    order by d.next_attempt_at, d.id
  ), '[]'::jsonb)
  into v_jobs
  from leased d;
  return jsonb_build_object(
    'schema_version', 1,
    'leased_until', v_until,
    'jobs', v_jobs
  );
end;
$$;

create or replace function
affiliate_private.partners_worker_airwallex_observation_record(
  p_dispatch_key text,
  p_provider_transfer_id text,
  p_provider_state text,
  p_provider_status text,
  p_funding_status text,
  p_provider_event_hash text,
  p_observed_at timestamptz,
  p_worker_id text,
  p_lease_token_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := nullif(lower(btrim(coalesce(p_dispatch_key, ''))), '');
  v_provider_id text := btrim(coalesce(p_provider_transfer_id, ''));
  v_provider_hash text;
  v_state text := upper(btrim(coalesce(p_provider_state, '')));
  v_status text := upper(btrim(coalesce(p_provider_status, '')));
  v_funding text := nullif(upper(btrim(coalesce(p_funding_status, ''))), '');
  v_event_hash text := nullif(
    lower(btrim(coalesce(p_provider_event_hash, ''))),
    ''
  );
  v_worker text := nullif(btrim(coalesce(p_worker_id, '')), '');
  v_lease text := nullif(
    lower(btrim(coalesce(p_lease_token_hash, ''))),
    ''
  );
  v_dispatch affiliate_private.affiliate_payout_dispatches%rowtype;
  v_item affiliate_private.affiliate_payout_items%rowtype;
  v_replayed boolean := false;
begin
  if (v_key is not null and v_key !~ '^pds_[0-9a-f]{24}$')
    or length(v_provider_id) not between 8 and 128
    or v_provider_id ~ '[[:space:][:cntrl:]]'
    or v_state not in (
      'SCHEDULED', 'PROCESSING', 'SENT', 'PAID',
      'FAILED', 'CANCELLED', 'REVERSED'
    )
    or v_status !~ '^[A-Z][A-Z_]{2,47}$'
    or (v_funding is not null and v_funding !~ '^[A-Z][A-Z_]{2,47}$')
    or (v_event_hash is not null and v_event_hash !~ '^[0-9a-f]{64}$')
    or p_observed_at is null
    or p_observed_at > now() + interval '5 minutes'
    or (
      (v_worker is null) <> (v_lease is null)
    )
    or (
      v_worker is not null
      and (
        v_worker !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$'
        or v_lease !~ '^[0-9a-f]{64}$'
      )
    )
    or (v_worker is null and v_event_hash is null)
  then
    raise exception 'invalid Airwallex payout observation'
      using errcode = '22023';
  end if;
  v_provider_hash := encode(
    extensions.digest(v_provider_id, 'sha256'),
    'hex'
  );
  select d.*
  into v_dispatch
  from affiliate_private.affiliate_payout_dispatches d
  where (
      v_key is not null
      and d.dispatch_key = v_key
      and (
        d.provider_transfer_hash is null
        or d.provider_transfer_hash = v_provider_hash
      )
    )
    or (
      v_key is null
      and d.provider_transfer_hash = v_provider_hash
    )
  for update;
  if not found
    or (
      v_dispatch.provider_transfer_id is not null
      and v_dispatch.provider_transfer_id <> v_provider_id
    )
  then
    raise exception 'Airwallex payout dispatch is unavailable'
      using errcode = 'P0002';
  end if;
  if v_worker is not null and (
    v_dispatch.job_status <> 'leased'
    or v_dispatch.worker_id <> v_worker
    or v_dispatch.lease_token_hash <> v_lease
    or v_dispatch.leased_until < now()
  ) then
    raise exception 'payout dispatch lease was lost'
      using errcode = 'P0004';
  end if;
  if v_event_hash is not null and exists (
    select 1
    from affiliate_private.affiliate_payout_provider_events e
    where e.provider_event_hash = v_event_hash
  ) then
    v_replayed := true;
  elsif not affiliate_private.partners_payout_dispatch_transition_allowed(
    v_dispatch.provider_state,
    v_state
  ) then
    raise exception 'invalid Airwallex payout state transition'
      using errcode = 'P0006';
  end if;
  if v_replayed then
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'airwallex_observation_recorded',
      'replayed', true,
      'dispatch', jsonb_build_object(
        'key', v_dispatch.dispatch_key,
        'state', v_dispatch.provider_state,
        'reconciliation_status', v_dispatch.reconciliation_status
      )
    );
  end if;

  update affiliate_private.affiliate_payout_dispatches d
  set
    provider_state = v_state,
    provider_status = v_status,
    funding_status = v_funding,
    provider_transfer_id = v_provider_id,
    provider_transfer_hash = v_provider_hash,
    reconciliation_status = case
      when v_state = 'PAID' then 'pending'
      when v_state = 'REVERSED' then 'reversed'
      when v_state in ('FAILED', 'CANCELLED') then 'exception'
      else 'not_ready'
    end,
    job_status = case
      when v_state in ('FAILED', 'CANCELLED', 'REVERSED') then 'exception'
      else 'observing'
    end,
    worker_id = null,
    lease_token_hash = null,
    leased_until = null,
    next_attempt_at = now() + case
      when v_state = 'PROCESSING' then interval '5 minutes'
      when v_state = 'PAID' then interval '6 hours'
      when v_state in ('FAILED', 'CANCELLED', 'REVERSED')
        then interval '100 years'
      else interval '15 minutes'
    end,
    last_error_code = case
      when v_state in ('FAILED', 'CANCELLED', 'REVERSED')
        then lower(v_state)
      else null
    end,
    provider_updated_at = coalesce(p_observed_at, d.provider_updated_at),
    submitted_at = coalesce(d.submitted_at, now()),
    paid_observed_at = case
      when v_state = 'PAID' then coalesce(d.paid_observed_at, now())
      else d.paid_observed_at
    end,
    updated_at = now()
  where d.id = v_dispatch.id
  returning d.* into v_dispatch;

  if v_event_hash is not null then
    insert into affiliate_private.affiliate_payout_provider_events (
      dispatch_id,
      provider_event_hash,
      provider_state,
      observed_at
    )
    values (
      v_dispatch.id,
      v_event_hash,
      v_state,
      p_observed_at
    );
  end if;

  select item.*
  into v_item
  from affiliate_private.affiliate_payout_items item
  where item.id = v_dispatch.payout_item_id
  for update;
  update affiliate_private.affiliate_payout_items item
  set
    status = case
      when v_state in ('FAILED', 'CANCELLED', 'REVERSED') then 'failed'
      else 'submitted'
    end,
    provider_transfer_hash = v_provider_hash,
    updated_at = now()
  where item.id = v_item.id;
  update affiliate_private.affiliate_payout_cycles cycle
  set
    status = case
      when cycle.status = 'approved' then 'submitted'
      else cycle.status
    end,
    submitted_at = coalesce(cycle.submitted_at, now()),
    updated_at = now()
  where cycle.id = v_item.cycle_id;

  insert into affiliate_private.affiliate_events (
    aggregate_type,
    aggregate_key,
    action,
    actor_type,
    actor_pseudonym,
    justification,
    after_state
  )
  values (
    'payout',
    v_dispatch.dispatch_key,
    'airwallex_state_observed',
    'service',
    encode(
      extensions.digest('airwallex-payout-worker', 'sha256'),
      'hex'
    ),
    'Authoritative Airwallex transfer state was recorded.',
    jsonb_build_object(
      'state', v_state,
      'reconciliation_status', v_dispatch.reconciliation_status
    )
  );
  return jsonb_build_object(
    'schema_version', 1,
    'action', 'airwallex_observation_recorded',
    'replayed', false,
    'dispatch', jsonb_build_object(
      'key', v_dispatch.dispatch_key,
      'state', v_dispatch.provider_state,
      'reconciliation_status', v_dispatch.reconciliation_status
    )
  );
end;
$$;

create or replace function
public.partners_service_airwallex_beneficiary_prepare(
  p_user_id uuid,
  p_idempotency_key text,
  p_currency text,
  p_transfer_method text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select
    affiliate_private.partners_service_airwallex_beneficiary_prepare(
      p_user_id,
      p_idempotency_key,
      p_currency,
      p_transfer_method
    );
$$;

create or replace function
public.partners_service_airwallex_beneficiary_start(
  p_user_id uuid,
  p_reservation_key text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select
    affiliate_private.partners_service_airwallex_beneficiary_start(
      p_user_id,
      p_reservation_key
    );
$$;

create or replace function
public.partners_service_airwallex_beneficiary_record(
  p_user_id uuid,
  p_reservation_key text,
  p_provider_beneficiary_id text,
  p_display_masked text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select
    affiliate_private.partners_service_airwallex_beneficiary_record(
      p_user_id,
      p_reservation_key,
      p_provider_beneficiary_id,
      p_display_masked
    );
$$;

create or replace function
public.partners_service_airwallex_beneficiary_unknown(
  p_user_id uuid,
  p_reservation_key text,
  p_error_code text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select
    affiliate_private.partners_service_airwallex_beneficiary_unknown(
      p_user_id,
      p_reservation_key,
      p_error_code
    );
$$;

create or replace function
public.partners_worker_airwallex_dispatch_lease(
  p_worker_id text,
  p_lease_token_hash text,
  p_limit integer,
  p_lease_seconds integer
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_worker_airwallex_dispatch_lease(
    p_worker_id,
    p_lease_token_hash,
    p_limit,
    p_lease_seconds
  );
$$;

create or replace function
public.partners_worker_airwallex_dispatch_retry(
  p_dispatch_key text,
  p_worker_id text,
  p_lease_token_hash text,
  p_error_code text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_worker_airwallex_dispatch_retry(
    p_dispatch_key,
    p_worker_id,
    p_lease_token_hash,
    p_error_code
  );
$$;

create or replace function
public.partners_worker_airwallex_reconcile_lease(
  p_worker_id text,
  p_lease_token_hash text,
  p_limit integer,
  p_lease_seconds integer
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_worker_airwallex_reconcile_lease(
    p_worker_id,
    p_lease_token_hash,
    p_limit,
    p_lease_seconds
  );
$$;

create or replace function
public.partners_worker_airwallex_observation_record(
  p_dispatch_key text,
  p_provider_transfer_id text,
  p_provider_state text,
  p_provider_status text,
  p_funding_status text,
  p_provider_event_hash text,
  p_observed_at timestamptz,
  p_worker_id text,
  p_lease_token_hash text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_worker_airwallex_observation_record(
    p_dispatch_key,
    p_provider_transfer_id,
    p_provider_state,
    p_provider_status,
    p_funding_status,
    p_provider_event_hash,
    p_observed_at,
    p_worker_id,
    p_lease_token_hash
  );
$$;

revoke all on function
  affiliate_private.partners_payout_dispatch_transition_allowed(text, text)
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_service_airwallex_beneficiary_prepare(
    uuid, text, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_service_airwallex_beneficiary_prepare(
    uuid, text, text, text
  )
to service_role;
revoke all on function
  affiliate_private.partners_service_airwallex_beneficiary_start(uuid, text)
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_service_airwallex_beneficiary_start(uuid, text)
to service_role;
revoke all on function
  affiliate_private.partners_service_airwallex_beneficiary_record(
    uuid, text, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_service_airwallex_beneficiary_record(
    uuid, text, text, text
  )
to service_role;
revoke all on function
  affiliate_private.partners_service_airwallex_beneficiary_unknown(
    uuid, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_service_airwallex_beneficiary_unknown(
    uuid, text, text
  )
to service_role;
revoke all on function
  affiliate_private.partners_worker_airwallex_dispatch_lease(
    text, text, integer, integer
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_worker_airwallex_dispatch_lease(
    text, text, integer, integer
  )
to service_role;
revoke all on function
  affiliate_private.partners_worker_airwallex_dispatch_retry(
    text, text, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_worker_airwallex_dispatch_retry(
    text, text, text, text
  )
to service_role;
revoke all on function
  affiliate_private.partners_worker_airwallex_reconcile_lease(
    text, text, integer, integer
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_worker_airwallex_reconcile_lease(
    text, text, integer, integer
  )
to service_role;
revoke all on function
  affiliate_private.partners_worker_airwallex_observation_record(
    text, text, text, text, text, text, timestamptz, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_worker_airwallex_observation_record(
    text, text, text, text, text, text, timestamptz, text, text
  )
to service_role;

revoke all on function
  public.partners_service_airwallex_beneficiary_prepare(
    uuid, text, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  public.partners_service_airwallex_beneficiary_prepare(
    uuid, text, text, text
  )
to service_role;
revoke all on function
  public.partners_service_airwallex_beneficiary_start(uuid, text)
from public, anon, authenticated, service_role;
grant execute on function
  public.partners_service_airwallex_beneficiary_start(uuid, text)
to service_role;
revoke all on function
  public.partners_service_airwallex_beneficiary_record(
    uuid, text, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  public.partners_service_airwallex_beneficiary_record(
    uuid, text, text, text
  )
to service_role;
revoke all on function
  public.partners_service_airwallex_beneficiary_unknown(uuid, text, text)
from public, anon, authenticated, service_role;
grant execute on function
  public.partners_service_airwallex_beneficiary_unknown(uuid, text, text)
to service_role;
revoke all on function
  public.partners_worker_airwallex_dispatch_lease(
    text, text, integer, integer
  )
from public, anon, authenticated, service_role;
grant execute on function
  public.partners_worker_airwallex_dispatch_lease(
    text, text, integer, integer
  )
to service_role;
revoke all on function
  public.partners_worker_airwallex_dispatch_retry(text, text, text, text)
from public, anon, authenticated, service_role;
grant execute on function
  public.partners_worker_airwallex_dispatch_retry(text, text, text, text)
to service_role;
revoke all on function
  public.partners_worker_airwallex_reconcile_lease(
    text, text, integer, integer
  )
from public, anon, authenticated, service_role;
grant execute on function
  public.partners_worker_airwallex_reconcile_lease(
    text, text, integer, integer
  )
to service_role;
revoke all on function
  public.partners_worker_airwallex_observation_record(
    text, text, text, text, text, text, timestamptz, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  public.partners_worker_airwallex_observation_record(
    text, text, text, text, text, text, timestamptz, text, text
  )
to service_role;
