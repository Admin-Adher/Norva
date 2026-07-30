-- Norva Partners P0 phase 2: hosted individual KYC and durable referral
-- attribution. No document, selfie, biometric template, raw claim, public code,
-- provider payload, IP address or user-agent string is stored.

-- Extend the phase-1 idempotency registry without weakening existing rows.
alter table affiliate_private.affiliate_service_idempotency
  drop constraint affiliate_service_idempotency_operation;
alter table affiliate_private.affiliate_service_idempotency
  add constraint affiliate_service_idempotency_operation
  check (
    operation in (
      'application',
      'terms_acceptance',
      'link_rotation',
      'kyc_prepare',
      'kyc_session_record',
      'referral_claim',
      'payout_profile'
    )
  );

alter table affiliate_private.affiliate_events
  drop constraint affiliate_events_aggregate_type;
alter table affiliate_private.affiliate_events
  add constraint affiliate_events_aggregate_type
  check (
    aggregate_type in (
      'release_gate',
      'feature_flag',
      'pilot_allowlist',
      'program_version',
      'country_policy',
      'account',
      'link',
      'kyc',
      'attribution',
      'financial_fact',
      'commission',
      'payout',
      'tv_relay'
    )
  );

-- The foundation already uses 24 random bytes encoded as unpadded base64url,
-- which is exactly 32 URL-safe characters. Reassert the default and validate
-- the existing constraint before referral resolution becomes callable.
alter table affiliate_private.affiliate_links
  alter column public_code set default translate(
    rtrim(
      encode(extensions.gen_random_bytes(24), 'base64'),
      '='
    ),
    '+/',
    '-_'
  );
alter table affiliate_private.affiliate_links
  validate constraint affiliate_links_public_code;

create table affiliate_private.affiliate_country_code_mappings (
  iso3                    text primary key,
  country_code            text not null unique,
  status                  text not null default 'disabled',
  configured_by_pseudonym text not null,
  justification           text not null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint affiliate_country_code_mappings_iso3
    check (iso3 ~ '^[A-Z]{3}$'),
  constraint affiliate_country_code_mappings_iso2
    check (country_code ~ '^[A-Z]{2}$'),
  constraint affiliate_country_code_mappings_status
    check (status in ('active', 'disabled')),
  constraint affiliate_country_code_mappings_actor
    check (configured_by_pseudonym ~ '^[0-9a-f]{64}$'),
  constraint affiliate_country_code_mappings_justification
    check (length(btrim(justification)) between 12 and 1000)
);

create table affiliate_private.affiliate_capacity_attestations (
  id                uuid primary key default gen_random_uuid(),
  account_id        uuid not null
    references affiliate_private.affiliate_accounts(id)
    on delete restrict,
  consent_version   text not null,
  capacity_attested boolean not null,
  attested_at       timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  constraint affiliate_capacity_attestations_consent
    check (consent_version ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
  constraint affiliate_capacity_attestations_affirmative
    check (capacity_attested)
);

create unique index affiliate_capacity_attestations_version_idx
  on affiliate_private.affiliate_capacity_attestations (
    account_id,
    consent_version
  );
create index affiliate_capacity_attestations_account_idx
  on affiliate_private.affiliate_capacity_attestations (
    account_id,
    attested_at desc
  );

create table affiliate_private.affiliate_kyc_attempt_policies (
  country_policy_id        uuid primary key
    references affiliate_private.affiliate_country_policies(id)
    on delete restrict,
  max_attempts             integer not null,
  window_seconds           integer not null,
  cooldown_seconds         integer not null,
  status                   text not null default 'disabled',
  configured_by_pseudonym  text not null,
  justification            text not null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint affiliate_kyc_attempt_policies_attempts
    check (max_attempts between 1 and 20),
  constraint affiliate_kyc_attempt_policies_window
    check (window_seconds between 3600 and 2592000),
  constraint affiliate_kyc_attempt_policies_cooldown
    check (cooldown_seconds between 60 and 604800),
  constraint affiliate_kyc_attempt_policies_status
    check (status in ('active', 'disabled')),
  constraint affiliate_kyc_attempt_policies_actor
    check (configured_by_pseudonym ~ '^[0-9a-f]{64}$'),
  constraint affiliate_kyc_attempt_policies_justification
    check (length(btrim(justification)) between 12 and 1000)
);

create table affiliate_private.affiliate_kyc_sessions (
  id                       uuid primary key default gen_random_uuid(),
  account_id               uuid not null
    references affiliate_private.affiliate_accounts(id)
    on delete restrict,
  provider                 text not null,
  provider_session_hash    text not null unique,
  provider_workflow_hash   text not null,
  provider_workflow_version integer not null,
  provider_status          text not null,
  status                   text not null default 'pending',
  consent_version          text not null,
  age_over_minimum         boolean,
  country_policy_match     boolean,
  identity_checks_approved boolean,
  capacity_attested        boolean,
  last_event_created_at    timestamptz,
  verified_at              timestamptz,
  expires_at               timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint affiliate_kyc_sessions_provider
    check (provider = 'didit'),
  constraint affiliate_kyc_sessions_hashes
    check (
      provider_session_hash ~ '^[0-9a-f]{64}$'
      and provider_workflow_hash ~ '^[0-9a-f]{64}$'
    ),
  constraint affiliate_kyc_sessions_workflow_version
    check (provider_workflow_version between 1 and 2147483647),
  constraint affiliate_kyc_sessions_provider_status
    check (
      provider_status in (
        'not_started',
        'in_progress',
        'approved',
        'declined',
        'in_review',
        'expired',
        'abandoned',
        'kyc_expired',
        'resubmitted',
        'awaiting_user'
      )
    ),
  constraint affiliate_kyc_sessions_status
    check (
      status in (
        'pending',
        'verified',
        'failed',
        'expired',
        'superseded'
      )
    ),
  constraint affiliate_kyc_sessions_consent
    check (consent_version ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
  constraint affiliate_kyc_sessions_expiry
    check (expires_at is null or expires_at > created_at),
  constraint affiliate_kyc_sessions_verified
    check (
      status <> 'verified'
      or (
        age_over_minimum
        and country_policy_match
        and identity_checks_approved
        and capacity_attested
        and verified_at is not null
      )
    )
);

create index affiliate_kyc_sessions_account_idx
  on affiliate_private.affiliate_kyc_sessions (
    account_id,
    created_at desc
  );
create index affiliate_kyc_sessions_pending_idx
  on affiliate_private.affiliate_kyc_sessions (
    account_id,
    updated_at desc
  )
  where status = 'pending';

create table affiliate_private.affiliate_kyc_session_reservations (
  id                uuid primary key default gen_random_uuid(),
  reservation_key   text not null unique default (
    'kyr_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  account_id        uuid not null
    references affiliate_private.affiliate_accounts(id)
    on delete restrict,
  status            text not null default 'reserved',
  bound_session_id  uuid unique
    references affiliate_private.affiliate_kyc_sessions(id)
    on delete restrict,
  expires_at        timestamptz not null default (
    now() + interval '30 minutes'
  ),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint affiliate_kyc_session_reservations_key
    check (reservation_key ~ '^kyr_[0-9a-f]{24}$'),
  constraint affiliate_kyc_session_reservations_status
    check (status in ('reserved', 'recorded', 'expired')),
  constraint affiliate_kyc_session_reservations_expiry
    check (
      expires_at > created_at
      and expires_at <= created_at + interval '30 minutes'
    ),
  constraint affiliate_kyc_session_reservations_binding
    check (
      (status = 'recorded') = (bound_session_id is not null)
    )
);

create unique index affiliate_kyc_session_reservations_active_idx
  on affiliate_private.affiliate_kyc_session_reservations (account_id)
  where status = 'reserved';
create index affiliate_kyc_session_reservations_expiry_idx
  on affiliate_private.affiliate_kyc_session_reservations (expires_at)
  where status = 'reserved';

create table affiliate_private.affiliate_kyc_webhook_events (
  id                    uuid primary key default gen_random_uuid(),
  provider_event_hash   text not null unique,
  session_id            uuid not null
    references affiliate_private.affiliate_kyc_sessions(id)
    on delete restrict,
  provider_status       text not null,
  provider_event_at     timestamptz not null,
  payload_hash          text not null,
  processing_outcome    text not null,
  decision_reason       text,
  response              jsonb not null,
  created_at            timestamptz not null default now(),
  constraint affiliate_kyc_webhook_events_hashes
    check (
      provider_event_hash ~ '^[0-9a-f]{64}$'
      and payload_hash ~ '^[0-9a-f]{64}$'
    ),
  constraint affiliate_kyc_webhook_events_provider_status
    check (
      provider_status in (
        'not_started',
        'in_progress',
        'approved',
        'declined',
        'in_review',
        'expired',
        'abandoned',
        'kyc_expired',
        'resubmitted',
        'awaiting_user'
      )
    ),
  constraint affiliate_kyc_webhook_events_outcome
    check (
      processing_outcome in (
        'pending',
        'verified',
        'failed',
        'expired',
        'ignored_stale',
        'ignored_superseded',
        'ignored_terminal'
      )
    ),
  constraint affiliate_kyc_webhook_events_reason
    check (
      decision_reason is null
      or decision_reason in (
        'provider_pending',
        'provider_declined',
        'provider_expired',
        'identity_checks_failed',
        'age_policy_failed',
        'country_policy_failed',
        'capacity_attestation_missing',
        'stale_event',
        'superseded_session',
        'terminal_session'
      )
    ),
  constraint affiliate_kyc_webhook_events_response
    check (jsonb_typeof(response) = 'object')
);

create index affiliate_kyc_webhook_events_session_idx
  on affiliate_private.affiliate_kyc_webhook_events (
    session_id,
    provider_event_at desc
  );

create table affiliate_private.affiliate_referral_request_nonces (
  nonce_hash       text primary key,
  claim_hash       text not null,
  network_hash     text not null,
  user_agent_hash  text not null,
  outcome          text not null,
  expires_at       timestamptz not null,
  created_at       timestamptz not null default now(),
  constraint affiliate_referral_request_nonces_hashes
    check (
      nonce_hash ~ '^[0-9a-f]{64}$'
      and claim_hash ~ '^[0-9a-f]{64}$'
      and network_hash ~ '^[0-9a-f]{64}$'
      and user_agent_hash ~ '^[0-9a-f]{64}$'
    ),
  constraint affiliate_referral_request_nonces_outcome
    check (outcome in ('accepted', 'rate_limited', 'invalid')),
  constraint affiliate_referral_request_nonces_expiry
    check (expires_at > created_at)
);

create index affiliate_referral_request_nonces_expiry_idx
  on affiliate_private.affiliate_referral_request_nonces (expires_at);

create table affiliate_private.affiliate_referral_rate_buckets (
  dimension_key  text not null,
  subject_hash   text not null,
  bucket_start   timestamptz not null,
  request_count  integer not null default 1,
  updated_at     timestamptz not null default now(),
  primary key (dimension_key, subject_hash, bucket_start),
  constraint affiliate_referral_rate_buckets_dimension
    check (dimension_key in ('network', 'user_agent')),
  constraint affiliate_referral_rate_buckets_hash
    check (subject_hash ~ '^[0-9a-f]{64}$'),
  constraint affiliate_referral_rate_buckets_count
    check (request_count between 1 and 1000000)
);

create index affiliate_referral_rate_buckets_retention_idx
  on affiliate_private.affiliate_referral_rate_buckets (bucket_start);

create table affiliate_private.affiliate_link_claims (
  id                     uuid primary key default gen_random_uuid(),
  claim_hash             text not null unique,
  link_id                uuid not null
    references affiliate_private.affiliate_links(id)
    on delete restrict,
  referrer_account_id    uuid not null
    references affiliate_private.affiliate_accounts(id)
    on delete restrict,
  program_version_id     uuid not null
    references affiliate_private.affiliate_program_versions(id)
    on delete restrict,
  commission_rate_bps    integer not null,
  attribution_window_days integer not null,
  network_hash           text not null,
  user_agent_hash        text not null,
  campaign_key           text,
  status                 text not null default 'pending',
  rejection_reason       text,
  issued_at              timestamptz not null default now(),
  expires_at             timestamptz not null,
  consumed_at            timestamptz,
  consumed_by_user_id    uuid
    references auth.users(id)
    on delete restrict,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint affiliate_link_claims_hash
    check (claim_hash ~ '^[0-9a-f]{64}$'),
  constraint affiliate_link_claims_program
    check (
      commission_rate_bps = 2000
      and attribution_window_days = 30
    ),
  constraint affiliate_link_claims_fingerprints
    check (
      network_hash ~ '^[0-9a-f]{64}$'
      and user_agent_hash ~ '^[0-9a-f]{64}$'
    ),
  constraint affiliate_link_claims_campaign
    check (
      campaign_key is null
      or campaign_key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
    ),
  constraint affiliate_link_claims_status
    check (
      status in ('pending', 'consumed', 'expired', 'rejected')
    ),
  constraint affiliate_link_claims_rejection
    check (
      rejection_reason is null
      or rejection_reason in (
        'invalid',
        'expired',
        'existing_account',
        'self_referral',
        'already_attributed',
        'superseded_last_click',
        'account_unavailable'
      )
    ),
  constraint affiliate_link_claims_expiry
    check (
      expires_at > issued_at
      and expires_at <= issued_at + interval '30 days'
    ),
  constraint affiliate_link_claims_consumption
    check (
      (status = 'consumed') = (
        consumed_at is not null
        and consumed_by_user_id is not null
      )
    ),
  constraint affiliate_link_claims_rejected_consistency
    check (
      (status in ('expired', 'rejected')) =
      (rejection_reason is not null)
    )
);

create index affiliate_link_claims_link_idx
  on affiliate_private.affiliate_link_claims (link_id, issued_at desc);
create index affiliate_link_claims_referrer_idx
  on affiliate_private.affiliate_link_claims (
    referrer_account_id,
    issued_at desc
  );
create index affiliate_link_claims_pending_expiry_idx
  on affiliate_private.affiliate_link_claims (
    expires_at,
    issued_at desc
  )
  where status = 'pending';
create index affiliate_link_claims_fingerprint_idx
  on affiliate_private.affiliate_link_claims (
    network_hash,
    user_agent_hash,
    issued_at desc
  );
create index affiliate_link_claims_consumed_user_idx
  on affiliate_private.affiliate_link_claims (consumed_by_user_id)
  where consumed_by_user_id is not null;

create table affiliate_private.affiliate_attributions (
  id                      uuid primary key default gen_random_uuid(),
  referred_user_id        uuid not null unique
    references auth.users(id)
    on delete restrict,
  referrer_account_id     uuid not null
    references affiliate_private.affiliate_accounts(id)
    on delete restrict,
  link_id                 uuid not null
    references affiliate_private.affiliate_links(id)
    on delete restrict,
  claim_id                uuid not null unique
    references affiliate_private.affiliate_link_claims(id)
    on delete restrict,
  program_version_id      uuid not null
    references affiliate_private.affiliate_program_versions(id)
    on delete restrict,
  commission_rate_bps     integer not null,
  attribution_window_days integer not null,
  status                  text not null default 'attributed',
  decision_reason         text not null default 'valid_pre_signup_last_click',
  attributed_at           timestamptz not null default now(),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint affiliate_attributions_program
    check (
      commission_rate_bps = 2000
      and attribution_window_days = 30
    ),
  constraint affiliate_attributions_status
    check (
      status in (
        'attributed',
        'qualified',
        'held',
        'blocked',
        'reversed'
      )
    ),
  constraint affiliate_attributions_reason
    check (
      decision_reason in (
        'valid_pre_signup_last_click',
        'billing_identity_conflict',
        'transfer_quarantine',
        'risk_review',
        'refund_reversal',
        'chargeback_reversal'
      )
    )
);

create index affiliate_attributions_referrer_idx
  on affiliate_private.affiliate_attributions (
    referrer_account_id,
    attributed_at desc
  );
create index affiliate_attributions_link_idx
  on affiliate_private.affiliate_attributions (link_id);
create index affiliate_attributions_program_idx
  on affiliate_private.affiliate_attributions (program_version_id);

alter table affiliate_private.affiliate_country_code_mappings
  enable row level security;
alter table affiliate_private.affiliate_capacity_attestations
  enable row level security;
alter table affiliate_private.affiliate_kyc_attempt_policies
  enable row level security;
alter table affiliate_private.affiliate_kyc_sessions
  enable row level security;
alter table affiliate_private.affiliate_kyc_session_reservations
  enable row level security;
alter table affiliate_private.affiliate_kyc_webhook_events
  enable row level security;
alter table affiliate_private.affiliate_referral_request_nonces
  enable row level security;
alter table affiliate_private.affiliate_referral_rate_buckets
  enable row level security;
alter table affiliate_private.affiliate_link_claims
  enable row level security;
alter table affiliate_private.affiliate_attributions
  enable row level security;

revoke all on table
  affiliate_private.affiliate_country_code_mappings,
  affiliate_private.affiliate_capacity_attestations,
  affiliate_private.affiliate_kyc_attempt_policies,
  affiliate_private.affiliate_kyc_sessions,
  affiliate_private.affiliate_kyc_session_reservations,
  affiliate_private.affiliate_kyc_webhook_events,
  affiliate_private.affiliate_referral_request_nonces,
  affiliate_private.affiliate_referral_rate_buckets,
  affiliate_private.affiliate_link_claims,
  affiliate_private.affiliate_attributions
from public, anon, authenticated, service_role;

create or replace function affiliate_private.reject_partners_append_only_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Partners append-only record cannot be changed'
    using errcode = '55000';
end;
$$;

create trigger affiliate_capacity_attestations_append_only
before update or delete
on affiliate_private.affiliate_capacity_attestations
for each row
execute function affiliate_private.reject_partners_append_only_mutation();

create trigger affiliate_kyc_webhook_events_append_only
before update or delete
on affiliate_private.affiliate_kyc_webhook_events
for each row
execute function affiliate_private.reject_partners_append_only_mutation();

create trigger affiliate_attributions_no_delete
before delete
on affiliate_private.affiliate_attributions
for each row
execute function affiliate_private.reject_partners_append_only_mutation();

create or replace function affiliate_private.guard_kyc_session_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'KYC sessions are retained'
      using errcode = '55000';
  elsif tg_op = 'UPDATE' then
    if new.id is distinct from old.id
      or new.account_id is distinct from old.account_id
      or new.provider is distinct from old.provider
      or new.provider_session_hash is distinct from old.provider_session_hash
      or new.provider_workflow_hash is distinct from old.provider_workflow_hash
      or new.provider_workflow_version
        is distinct from old.provider_workflow_version
      or new.consent_version is distinct from old.consent_version
      or new.created_at is distinct from old.created_at
    then
      raise exception 'KYC session identity is immutable'
        using errcode = '55000';
    end if;

    if old.status <> new.status
      and not (
        old.status = 'pending'
        and new.status in (
          'verified',
          'failed',
          'expired',
          'superseded'
        )
      )
    then
      raise exception 'invalid KYC session transition'
        using errcode = '55000';
    end if;

    if old.status <> 'pending'
      and (
        new.status is distinct from old.status
        or new.verified_at is distinct from old.verified_at
        or new.age_over_minimum is distinct from old.age_over_minimum
        or new.country_policy_match is distinct from old.country_policy_match
        or new.identity_checks_approved
          is distinct from old.identity_checks_approved
        or new.capacity_attested is distinct from old.capacity_attested
      )
    then
      raise exception 'terminal KYC decision is immutable'
        using errcode = '55000';
    end if;
  elsif new.status <> 'pending' then
    raise exception 'new KYC sessions must start pending'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger affiliate_kyc_sessions_validate
before insert or update or delete
on affiliate_private.affiliate_kyc_sessions
for each row
execute function affiliate_private.guard_kyc_session_transition();

create or replace function
affiliate_private.guard_kyc_session_reservation_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'KYC reservations are retained'
      using errcode = '55000';
  end if;
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id
      or new.reservation_key is distinct from old.reservation_key
      or new.account_id is distinct from old.account_id
      or new.expires_at is distinct from old.expires_at
      or new.created_at is distinct from old.created_at
    then
      raise exception 'KYC reservation identity is immutable'
        using errcode = '55000';
    end if;
    if old.status <> 'reserved'
      or new.status not in ('recorded', 'expired')
    then
      raise exception 'KYC reservation is terminal'
        using errcode = '55000';
    end if;
  elsif new.status <> 'reserved' or new.bound_session_id is not null then
    raise exception 'new KYC reservation must start unbound'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger affiliate_kyc_session_reservations_validate
before insert or update or delete
on affiliate_private.affiliate_kyc_session_reservations
for each row execute function
  affiliate_private.guard_kyc_session_reservation_transition();

create or replace function affiliate_private.guard_link_claim_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'referral claims are retained'
      using errcode = '55000';
  end if;

  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id
      or new.claim_hash is distinct from old.claim_hash
      or new.link_id is distinct from old.link_id
      or new.referrer_account_id is distinct from old.referrer_account_id
      or new.program_version_id is distinct from old.program_version_id
      or new.commission_rate_bps is distinct from old.commission_rate_bps
      or new.attribution_window_days
        is distinct from old.attribution_window_days
      or new.network_hash is distinct from old.network_hash
      or new.user_agent_hash is distinct from old.user_agent_hash
      or new.campaign_key is distinct from old.campaign_key
      or new.issued_at is distinct from old.issued_at
      or new.expires_at is distinct from old.expires_at
      or new.created_at is distinct from old.created_at
    then
      raise exception 'referral claim identity is immutable'
        using errcode = '55000';
    end if;

    if old.status <> 'pending'
      and (
        new.status is distinct from old.status
        or new.rejection_reason is distinct from old.rejection_reason
        or new.consumed_at is distinct from old.consumed_at
        or new.consumed_by_user_id is distinct from old.consumed_by_user_id
      )
    then
      raise exception 'terminal referral claim is immutable'
        using errcode = '55000';
    end if;
    if old.status = 'pending'
      and new.status not in (
        'pending',
        'consumed',
        'expired',
        'rejected'
      )
    then
      raise exception 'invalid referral claim transition'
        using errcode = '55000';
    end if;
  elsif new.status <> 'pending' then
    raise exception 'new referral claims must start pending'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger affiliate_link_claims_validate
before insert or update or delete
on affiliate_private.affiliate_link_claims
for each row
execute function affiliate_private.guard_link_claim_transition();

create or replace function affiliate_private.guard_attribution_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
    or new.referred_user_id is distinct from old.referred_user_id
    or new.referrer_account_id is distinct from old.referrer_account_id
    or new.link_id is distinct from old.link_id
    or new.claim_id is distinct from old.claim_id
    or new.program_version_id is distinct from old.program_version_id
    or new.commission_rate_bps is distinct from old.commission_rate_bps
    or new.attribution_window_days
      is distinct from old.attribution_window_days
    or new.attributed_at is distinct from old.attributed_at
    or new.created_at is distinct from old.created_at
  then
    raise exception 'affiliate attribution identity is immutable'
      using errcode = '55000';
  end if;

  if old.status <> new.status
    and not (
      (old.status = 'attributed'
        and new.status in ('qualified', 'held', 'blocked', 'reversed'))
      or (old.status = 'qualified'
        and new.status in ('held', 'blocked', 'reversed'))
      or (old.status = 'held'
        and new.status in ('qualified', 'blocked', 'reversed'))
      or (old.status = 'blocked' and new.status = 'reversed')
    )
  then
    raise exception 'invalid attribution transition'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

create trigger affiliate_attributions_validate
before update
on affiliate_private.affiliate_attributions
for each row
execute function affiliate_private.guard_attribution_transition();

create or replace function affiliate_private.partners_public_account_id(
  p_account affiliate_private.affiliate_accounts
)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select 'prt_' || left(p_account.user_pseudonym, 24);
$$;

create or replace function affiliate_private.partners_valid_didit_status(
  p_status text
)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select p_status = any (
    array[
      'not_started',
      'in_progress',
      'approved',
      'declined',
      'in_review',
      'expired',
      'abandoned',
      'kyc_expired',
      'resubmitted',
      'awaiting_user'
    ]::text[]
  );
$$;

create or replace function affiliate_private.partners_service_kyc_prepare(
  p_user_id uuid,
  p_idempotency_key text,
  p_consent_version text,
  p_capacity_attested boolean,
  p_language text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_consent text := lower(btrim(coalesce(p_consent_version, '')));
  v_language text := lower(btrim(coalesce(p_language, '')));
  v_request_hash text;
  v_replay jsonb;
  v_response jsonb;
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_program affiliate_private.affiliate_program_versions%rowtype;
  v_policy affiliate_private.affiliate_country_policies%rowtype;
  v_attempt_policy
    affiliate_private.affiliate_kyc_attempt_policies%rowtype;
  v_attempt_count integer := 0;
  v_last_terminal_at timestamptz;
  v_has_pending boolean := false;
  v_reservation
    affiliate_private.affiliate_kyc_session_reservations%rowtype;
begin
  if p_user_id is null then
    raise exception 'user id is required' using errcode = '22023';
  end if;
  if p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
  then
    raise exception 'invalid idempotency key' using errcode = '22023';
  end if;
  if v_consent !~ '^[a-z0-9][a-z0-9._-]{2,63}$' then
    raise exception 'invalid capacity consent version'
      using errcode = '22023';
  end if;
  if v_language !~ '^[a-z]{2}$' then
    raise exception 'invalid KYC language'
      using errcode = '22023';
  end if;
  if p_capacity_attested is distinct from true then
    raise exception 'affirmative legal-capacity attestation is required'
      using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:user:' || p_user_id::text, 0)
  );

  v_request_hash := encode(
    extensions.digest(
      concat_ws(
        chr(31),
        'kyc_prepare:v1',
        p_user_id::text,
        v_consent,
        p_capacity_attested::text,
        v_language
      ),
      'sha256'
    ),
    'hex'
  );
  v_replay := affiliate_private.partners_replayed_response(
    'kyc_prepare',
    p_user_id,
    p_idempotency_key,
    v_request_hash
  );
  if v_replay is not null then
    return v_replay;
  end if;

  select a.*
  into v_account
  from affiliate_private.affiliate_accounts a
  where a.user_id = p_user_id
    and a.status <> 'closed'
  for update;
  if not found
    or v_account.status <> 'pending_verification'
    or v_account.account_type <> 'individual'
    or v_account.contract_status <> 'accepted'
  then
    raise exception 'Partners account is not ready for KYC'
      using errcode = 'P0001';
  end if;

  select p.*
  into v_program
  from affiliate_private.affiliate_program_versions p
  where p.id = v_account.program_version_id
  for share;
  select cp.*
  into v_policy
  from affiliate_private.affiliate_country_policies cp
  where cp.id = v_account.country_policy_id
  for share;

  if v_program.id is null
    or v_policy.id is null
    or v_program.status <> 'active'
    or v_program.account_type <> 'individual'
    or v_program.commission_rate_bps <> 2000
    or v_program.attribution_window_days <> 30
    or v_program.maturation_days <> 45
    or v_program.effective_from is null
    or v_program.effective_from > now()
    or (
      v_program.effective_until is not null
      and v_program.effective_until <= now()
    )
    or v_policy.program_version_id <> v_program.id
    or not v_policy.individual_available
    or v_policy.minimum_age not between 18 and 99
    or v_policy.verification_provider <> 'didit'
    or v_policy.verification_level not in (
      'identity_age_country',
      'identity_age_country_capacity'
    )
    or (v_policy.effective_from is not null and v_policy.effective_from > now())
    or (
      v_policy.effective_until is not null
      and v_policy.effective_until <= now()
    )
  then
    raise exception 'Didit KYC policy is unavailable'
      using errcode = 'P0001';
  end if;
  if v_consent is distinct from v_policy.disclosure_version then
    raise exception 'capacity consent version is not current'
      using errcode = 'P0001';
  end if;
  if v_account.terms_version_accepted
      is distinct from v_policy.terms_version
    or v_account.disclosure_version_accepted
      is distinct from v_policy.disclosure_version
  then
    raise exception 'accepted Partners terms are not current'
      using errcode = 'P0001';
  end if;

  select ap.*
  into v_attempt_policy
  from affiliate_private.affiliate_kyc_attempt_policies ap
  where ap.country_policy_id = v_policy.id
    and ap.status = 'active';
  if not found then
    raise exception 'KYC attempt policy is unavailable'
      using errcode = 'P0001';
  end if;

  select exists (
    select 1
    from affiliate_private.affiliate_kyc_sessions s
    where s.account_id = v_account.id
      and s.status = 'pending'
      and (s.expires_at is null or s.expires_at > now())
  )
  into v_has_pending;

  update affiliate_private.affiliate_kyc_session_reservations
  set
    status = 'expired',
    updated_at = now()
  where account_id = v_account.id
    and status = 'reserved'
    and expires_at <= now();

  if v_has_pending or exists (
    select 1
    from affiliate_private.affiliate_kyc_session_reservations r
    where r.account_id = v_account.id
      and r.status = 'reserved'
      and r.expires_at > now()
  ) then
    raise exception 'KYC session creation is already in progress'
      using errcode = 'P0004';
  end if;

  select
    (
      select count(*)
      from affiliate_private.affiliate_kyc_session_reservations r
      where r.account_id = v_account.id
        and r.created_at >= now()
          - make_interval(secs => v_attempt_policy.window_seconds)
    ) + (
      select count(*)
      from affiliate_private.affiliate_kyc_sessions s
      where s.account_id = v_account.id
        and s.created_at >= now()
          - make_interval(secs => v_attempt_policy.window_seconds)
        and not exists (
          select 1
          from affiliate_private.affiliate_kyc_session_reservations r
          where r.bound_session_id = s.id
        )
    ),
    (
      select max(s.updated_at)
      from affiliate_private.affiliate_kyc_sessions s
      where s.account_id = v_account.id
        and s.status in (
          'verified', 'failed', 'expired', 'superseded'
        )
    )
  into v_attempt_count, v_last_terminal_at;

  if v_attempt_count >= v_attempt_policy.max_attempts then
    raise exception 'KYC attempt policy denied this request'
      using errcode = 'P0001';
  end if;
  if v_last_terminal_at is not null
    and v_last_terminal_at
      + make_interval(secs => v_attempt_policy.cooldown_seconds) > now()
  then
    raise exception 'KYC attempt cooldown is active'
      using errcode = 'P0004';
  end if;

  if not coalesce((
    select f.enabled
    from public.admin_feature_flags f
    where f.key = 'partners_enabled'
  ), false)
    or not affiliate_private.release_gates_satisfied(
      array[
        'legal_and_tax_approved',
        'privacy_approved',
        'individual_verification_coverage_confirmed',
        'country_policy_approved'
      ]::text[]
    )
  then
    raise exception 'KYC release gates are incomplete'
      using errcode = 'P0001';
  end if;

  insert into affiliate_private.affiliate_capacity_attestations (
    account_id,
    consent_version,
    capacity_attested
  )
  values (
    v_account.id,
    v_consent,
    true
  )
  on conflict (account_id, consent_version) do nothing;

  insert into affiliate_private.affiliate_kyc_session_reservations (
    account_id
  )
  values (v_account.id)
  returning * into v_reservation;

  v_response := jsonb_build_object(
    'schema_version', 1,
    'action', 'kyc_ready',
    'replayed', false,
    'account', jsonb_build_object(
      'id', affiliate_private.partners_public_account_id(v_account),
      'status', v_account.status
    ),
    'kyc', jsonb_build_object(
      'provider', 'didit',
      'readiness', 'ready',
      'minimum_age', v_policy.minimum_age,
      'country_code', v_policy.country_code,
      'capacity_required', v_policy.capacity_required,
      'reservation_key', v_reservation.reservation_key,
      'reservation_expires_at', v_reservation.expires_at
    )
  );

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
    'kyc',
    v_account.id::text,
    'kyc_capacity_attested',
    'service',
    v_account.user_pseudonym,
    'User affirmed the versioned individual-capacity statement.',
    jsonb_build_object(
      'capacity_attested', true,
      'consent_version', v_consent
    )
  );

  perform affiliate_private.partners_store_response(
    'kyc_prepare',
    p_user_id,
    p_idempotency_key,
    v_request_hash,
    v_response
  );
  return v_response;
end;
$$;

create or replace function affiliate_private.partners_service_kyc_session_record(
  p_user_id uuid,
  p_idempotency_key text,
  p_provider_session_id text,
  p_provider_workflow_id text,
  p_provider_workflow_version integer,
  p_provider_status text,
  p_expires_at timestamptz,
  p_reservation_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_provider_status text := lower(
    replace(btrim(coalesce(p_provider_status, '')), ' ', '_')
  );
  v_reservation_key text := lower(
    btrim(coalesce(p_reservation_key, ''))
  );
  v_session_hash text;
  v_workflow_hash text;
  v_request_hash text;
  v_replay jsonb;
  v_response jsonb;
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_policy affiliate_private.affiliate_country_policies%rowtype;
  v_attestation affiliate_private.affiliate_capacity_attestations%rowtype;
  v_attempt_policy
    affiliate_private.affiliate_kyc_attempt_policies%rowtype;
  v_existing affiliate_private.affiliate_kyc_sessions%rowtype;
  v_session affiliate_private.affiliate_kyc_sessions%rowtype;
  v_reservation
    affiliate_private.affiliate_kyc_session_reservations%rowtype;
begin
  if p_user_id is null then
    raise exception 'user id is required' using errcode = '22023';
  end if;
  if p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
  then
    raise exception 'invalid idempotency key' using errcode = '22023';
  end if;
  if p_provider_session_id is null
    or length(p_provider_session_id) not between 8 and 255
    or p_provider_session_id ~ '[[:space:][:cntrl:]]'
    or p_provider_workflow_id is null
    or length(p_provider_workflow_id) not between 3 and 255
    or p_provider_workflow_id ~ '[[:space:][:cntrl:]]'
    or p_provider_workflow_version is null
    or p_provider_workflow_version < 1
    or not affiliate_private.partners_valid_didit_status(v_provider_status)
    or v_reservation_key !~ '^kyr_[0-9a-f]{24}$'
  then
    raise exception 'invalid Didit session response'
      using errcode = '22023';
  end if;
  if p_expires_at is not null
    and (
      p_expires_at <= now()
      or p_expires_at > now() + interval '30 days'
    )
  then
    raise exception 'invalid KYC session expiry'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:user:' || p_user_id::text, 0)
  );

  v_session_hash := encode(
    extensions.digest(
      'norva:didit:session:v1:' || p_provider_session_id,
      'sha256'
    ),
    'hex'
  );
  v_workflow_hash := encode(
    extensions.digest(
      'norva:didit:workflow:v1:' || p_provider_workflow_id,
      'sha256'
    ),
    'hex'
  );
  v_request_hash := encode(
    extensions.digest(
      concat_ws(
        chr(31),
        'kyc_session_record:v1',
        p_user_id::text,
        v_session_hash,
        v_workflow_hash,
        p_provider_workflow_version::text,
        v_provider_status,
        coalesce(p_expires_at::text, ''),
        v_reservation_key
      ),
      'sha256'
    ),
    'hex'
  );
  v_replay := affiliate_private.partners_replayed_response(
    'kyc_session_record',
    p_user_id,
    p_idempotency_key,
    v_request_hash
  );
  if v_replay is not null then
    return v_replay;
  end if;

  select a.*
  into v_account
  from affiliate_private.affiliate_accounts a
  where a.user_id = p_user_id
    and a.status = 'pending_verification'
  for update;
  if not found then
    raise exception 'Partners account is not ready for KYC'
      using errcode = 'P0001';
  end if;

  select r.*
  into v_reservation
  from affiliate_private.affiliate_kyc_session_reservations r
  where r.reservation_key = v_reservation_key
  for update;
  if not found
    or v_reservation.account_id <> v_account.id
    or (
      v_reservation.status = 'reserved'
      and v_reservation.expires_at <= now()
    )
    or v_reservation.status = 'expired'
  then
    raise exception 'KYC reservation is unavailable'
      using errcode = 'P0006';
  end if;

  select cp.*
  into v_policy
  from affiliate_private.affiliate_country_policies cp
  where cp.id = v_account.country_policy_id
    and cp.verification_provider = 'didit'
    and cp.individual_available
  for share;
  if not found then
    raise exception 'Didit KYC policy is unavailable'
      using errcode = 'P0001';
  end if;

  select ap.*
  into v_attempt_policy
  from affiliate_private.affiliate_kyc_attempt_policies ap
  where ap.country_policy_id = v_policy.id
    and ap.status = 'active';
  if not found then
    raise exception 'KYC attempt policy is unavailable'
      using errcode = 'P0001';
  end if;

  select ca.*
  into v_attestation
  from affiliate_private.affiliate_capacity_attestations ca
  where ca.account_id = v_account.id
    and ca.consent_version = v_policy.disclosure_version
    and ca.capacity_attested
  order by ca.attested_at desc
  limit 1;
  if not found then
    raise exception 'capacity attestation is required'
      using errcode = 'P0001';
  end if;

  select s.*
  into v_existing
  from affiliate_private.affiliate_kyc_sessions s
  where s.provider_session_hash = v_session_hash
  for update;
  if found then
    if v_existing.account_id <> v_account.id
      or v_existing.provider_workflow_hash <> v_workflow_hash
      or v_existing.provider_workflow_version
        <> p_provider_workflow_version
    then
      raise exception 'provider session identity conflict'
        using errcode = 'P0003';
    end if;
    if (
      v_reservation.status = 'recorded'
      and v_reservation.bound_session_id <> v_existing.id
    ) or exists (
      select 1
      from affiliate_private.affiliate_kyc_session_reservations other
      where other.bound_session_id = v_existing.id
        and other.id <> v_reservation.id
    ) then
      raise exception 'KYC reservation binding conflict'
        using errcode = 'P0003';
    end if;
    if v_reservation.status = 'reserved' then
      update affiliate_private.affiliate_kyc_session_reservations
      set
        status = 'recorded',
        bound_session_id = v_existing.id,
        updated_at = now()
      where id = v_reservation.id;
    end if;

    v_response := jsonb_build_object(
      'schema_version', 1,
      'action', 'kyc_session_recorded',
      'replayed', false,
      'kyc', jsonb_build_object(
        'status', 'pending',
        'expires_at', v_existing.expires_at
      )
    );
    perform affiliate_private.partners_store_response(
      'kyc_session_record',
      p_user_id,
      p_idempotency_key,
      v_request_hash,
      v_response
    );
    return v_response;
  end if;

  if exists (
    select 1
    from affiliate_private.affiliate_kyc_sessions s
    where s.account_id = v_account.id
      and s.status = 'pending'
      and (s.expires_at is null or s.expires_at > now())
  ) then
    raise exception 'another KYC session is already pending'
      using errcode = 'P0004';
  end if;

  if v_reservation.status <> 'reserved' then
    raise exception 'KYC reservation is already bound'
      using errcode = 'P0003';
  end if;

  update affiliate_private.affiliate_kyc_sessions
  set
    status = 'expired',
    provider_status = case
      when provider_status in ('expired', 'kyc_expired') then provider_status
      else 'expired'
    end,
    updated_at = now()
  where account_id = v_account.id
    and status = 'pending'
    and expires_at is not null
    and expires_at <= now();

  insert into affiliate_private.affiliate_kyc_sessions (
    account_id,
    provider,
    provider_session_hash,
    provider_workflow_hash,
    provider_workflow_version,
    provider_status,
    status,
    consent_version,
    capacity_attested,
    expires_at
  )
  values (
    v_account.id,
    'didit',
    v_session_hash,
    v_workflow_hash,
    p_provider_workflow_version,
    v_provider_status,
    'pending',
    v_attestation.consent_version,
    true,
    p_expires_at
  )
  returning * into v_session;

  update affiliate_private.affiliate_kyc_session_reservations
  set
    status = 'recorded',
    bound_session_id = v_session.id,
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
  values (
    'kyc',
    v_account.id::text,
    'kyc_session_recorded',
    'service',
    v_account.user_pseudonym,
    'Hosted individual KYC session was recorded without provider payload.',
    jsonb_build_object(
      'provider', 'didit',
      'status', 'pending'
    )
  );

  v_response := jsonb_build_object(
    'schema_version', 1,
    'action', 'kyc_session_recorded',
    'replayed', false,
    'kyc', jsonb_build_object(
      'status', 'pending',
      'expires_at', v_session.expires_at
    )
  );
  perform affiliate_private.partners_store_response(
    'kyc_session_record',
    p_user_id,
    p_idempotency_key,
    v_request_hash,
    v_response
  );
  return v_response;
end;
$$;

create or replace function affiliate_private.partners_service_kyc_webhook_apply(
  p_provider_event_id text,
  p_provider_session_id text,
  p_provider_workflow_id text,
  p_provider_workflow_version integer,
  p_provider_status text,
  p_event_created_at timestamptz,
  p_document_age integer,
  p_document_country_iso3 text,
  p_id_check_approved boolean,
  p_liveness_approved boolean,
  p_face_match_approved boolean,
  p_payload_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_provider_status text := lower(
    replace(btrim(coalesce(p_provider_status, '')), ' ', '_')
  );
  v_iso3 text := nullif(upper(btrim(
    coalesce(p_document_country_iso3, '')
  )), '');
  v_event_hash text;
  v_session_hash text;
  v_workflow_hash text;
  v_payload_hash text := lower(btrim(coalesce(p_payload_hash, '')));
  v_existing_event affiliate_private.affiliate_kyc_webhook_events%rowtype;
  v_session affiliate_private.affiliate_kyc_sessions%rowtype;
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_program affiliate_private.affiliate_program_versions%rowtype;
  v_policy affiliate_private.affiliate_country_policies%rowtype;
  v_mapping_country text;
  v_capacity_attested boolean := false;
  v_identity_approved boolean := false;
  v_age_approved boolean := false;
  v_country_approved boolean := false;
  v_target_status text := 'pending';
  v_outcome text := 'pending';
  v_reason text := 'provider_pending';
  v_response jsonb;
  v_invite_only boolean := true;
  v_allowlisted boolean := false;
  v_activation_ready boolean := false;
  v_activated boolean := false;
begin
  if p_provider_event_id is null
    or length(p_provider_event_id) not between 8 and 255
    or p_provider_event_id ~ '[[:space:][:cntrl:]]'
    or p_provider_session_id is null
    or length(p_provider_session_id) not between 8 and 255
    or p_provider_session_id ~ '[[:space:][:cntrl:]]'
    or p_provider_workflow_id is null
    or length(p_provider_workflow_id) not between 3 and 255
    or p_provider_workflow_id ~ '[[:space:][:cntrl:]]'
    or p_provider_workflow_version is null
    or p_provider_workflow_version < 1
    or not affiliate_private.partners_valid_didit_status(v_provider_status)
    or p_event_created_at is null
    or p_event_created_at > now() + interval '5 minutes'
    or v_payload_hash !~ '^[0-9a-f]{64}$'
  then
    raise exception 'invalid Didit webhook envelope'
      using errcode = '22023';
  end if;

  if v_provider_status = 'approved' then
    if p_id_check_approved is null
      or p_liveness_approved is null
      or p_face_match_approved is null
    then
      raise exception 'approved Didit result lacks required checks'
        using errcode = '22023';
    end if;
    if p_id_check_approved
      and (
        p_document_age is null
        or p_document_age not between 0 and 120
        or v_iso3 is null
        or v_iso3 !~ '^[A-Z]{3}$'
      )
    then
      raise exception 'approved identity result lacks policy evidence'
        using errcode = '22023';
    end if;
  end if;

  v_event_hash := encode(
    extensions.digest(
      'norva:didit:event:v1:' || p_provider_event_id,
      'sha256'
    ),
    'hex'
  );
  v_session_hash := encode(
    extensions.digest(
      'norva:didit:session:v1:' || p_provider_session_id,
      'sha256'
    ),
    'hex'
  );
  v_workflow_hash := encode(
    extensions.digest(
      'norva:didit:workflow:v1:' || p_provider_workflow_id,
      'sha256'
    ),
    'hex'
  );

  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:didit:' || v_session_hash, 0)
  );

  select e.*
  into v_existing_event
  from affiliate_private.affiliate_kyc_webhook_events e
  where e.provider_event_hash = v_event_hash;
  if found then
    if v_existing_event.payload_hash <> v_payload_hash
      or v_existing_event.provider_status <> v_provider_status
    then
      raise exception 'Didit event replay payload conflict'
        using errcode = 'P0003';
    end if;
    return v_existing_event.response
      || jsonb_build_object('replayed', true);
  end if;

  select s.*
  into v_session
  from affiliate_private.affiliate_kyc_sessions s
  where s.provider_session_hash = v_session_hash
  for update;
  if not found
    or v_session.provider_workflow_hash <> v_workflow_hash
    or v_session.provider_workflow_version <> p_provider_workflow_version
  then
    raise exception 'Didit session is unavailable'
      using errcode = 'P0006';
  end if;

  select a.*
  into v_account
  from affiliate_private.affiliate_accounts a
  where a.id = v_session.account_id
  for update;
  if not found then
    raise exception 'Partners account is unavailable'
      using errcode = 'P0002';
  end if;

  select p.*
  into v_program
  from affiliate_private.affiliate_program_versions p
  where p.id = v_account.program_version_id
  for share;
  select cp.*
  into v_policy
  from affiliate_private.affiliate_country_policies cp
  where cp.id = v_account.country_policy_id
  for share;
  if v_program.id is null
    or v_policy.id is null
    or v_policy.program_version_id <> v_program.id
    or v_policy.verification_provider <> 'didit'
    or v_policy.minimum_age not between 18 and 99
  then
    raise exception 'Didit policy snapshot is unavailable'
      using errcode = '55000';
  end if;

  if p_event_created_at < v_session.created_at - interval '5 minutes'
    or (
      v_session.last_event_created_at is not null
      and p_event_created_at < v_session.last_event_created_at
    )
  then
    v_target_status := v_session.status;
    v_outcome := 'ignored_stale';
    v_reason := 'stale_event';
  elsif v_session.status = 'superseded' then
    v_target_status := 'superseded';
    v_outcome := 'ignored_superseded';
    v_reason := 'superseded_session';
  elsif v_session.status <> 'pending' then
    v_target_status := v_session.status;
    v_outcome := 'ignored_terminal';
    v_reason := 'terminal_session';
  elsif v_provider_status = 'approved' then
    v_identity_approved :=
      p_id_check_approved
      and p_liveness_approved
      and p_face_match_approved;
    v_age_approved := p_document_age >= v_policy.minimum_age;

    select m.country_code
    into v_mapping_country
    from affiliate_private.affiliate_country_code_mappings m
    where m.iso3 = v_iso3
      and m.status = 'active';
    v_country_approved :=
      found
      and v_mapping_country = v_account.country_code;

    select exists (
      select 1
      from affiliate_private.affiliate_capacity_attestations ca
      where ca.account_id = v_account.id
        and ca.consent_version = v_session.consent_version
        and ca.capacity_attested
    )
    into v_capacity_attested;

    if not v_identity_approved then
      v_target_status := 'failed';
      v_outcome := 'failed';
      v_reason := 'identity_checks_failed';
    elsif not v_age_approved then
      v_target_status := 'failed';
      v_outcome := 'failed';
      v_reason := 'age_policy_failed';
    elsif not v_country_approved then
      v_target_status := 'failed';
      v_outcome := 'failed';
      v_reason := 'country_policy_failed';
    elsif not v_capacity_attested then
      v_target_status := 'failed';
      v_outcome := 'failed';
      v_reason := 'capacity_attestation_missing';
    else
      v_target_status := 'verified';
      v_outcome := 'verified';
      v_reason := null;
    end if;
  elsif v_provider_status in ('declined', 'abandoned') then
    v_target_status := 'failed';
    v_outcome := 'failed';
    v_reason := 'provider_declined';
  elsif v_provider_status in ('expired', 'kyc_expired') then
    v_target_status := 'expired';
    v_outcome := 'expired';
    v_reason := 'provider_expired';
  else
    v_target_status := 'pending';
    v_outcome := 'pending';
    v_reason := 'provider_pending';
  end if;

  if v_outcome not in (
    'ignored_stale',
    'ignored_superseded',
    'ignored_terminal'
  ) then
    update affiliate_private.affiliate_kyc_sessions
    set
      provider_status = v_provider_status,
      status = v_target_status,
      age_over_minimum = case
        when v_provider_status = 'approved' then v_age_approved
        else age_over_minimum
      end,
      country_policy_match = case
        when v_provider_status = 'approved' then v_country_approved
        else country_policy_match
      end,
      identity_checks_approved = case
        when v_provider_status = 'approved' then v_identity_approved
        else identity_checks_approved
      end,
      capacity_attested = case
        when v_provider_status = 'approved' then v_capacity_attested
        else capacity_attested
      end,
      last_event_created_at = p_event_created_at,
      verified_at = case
        when v_target_status = 'verified' then p_event_created_at
        else null
      end,
      updated_at = now()
    where id = v_session.id
    returning * into v_session;

    if v_target_status = 'verified' then
      update affiliate_private.affiliate_accounts
      set
        verification_status = 'verified',
        verification_provider = 'didit',
        verification_reference = v_session.provider_session_hash,
        age_verified = true,
        capacity_verified = true,
        updated_at = now()
      where id = v_account.id
      returning * into v_account;

      select coalesce(f.enabled, true)
      into v_invite_only
      from public.admin_feature_flags f
      where f.key = 'partners_invite_only';
      v_invite_only := coalesce(v_invite_only, true);

      select exists (
        select 1
        from affiliate_private.affiliate_pilot_allowlist a
        where a.user_id = v_account.user_id
          and a.status = 'active'
          and (a.expires_at is null or a.expires_at > now())
          and (
            a.country_code is null
            or a.country_code = v_account.country_code
          )
          and (
            a.subdivision_code is null
            or a.subdivision_code = v_account.subdivision_code
          )
      )
      into v_allowlisted;

      v_activation_ready :=
        v_account.status = 'pending_verification'
        and v_account.contract_status = 'accepted'
        and v_account.terms_version_accepted
          is not distinct from v_policy.terms_version
        and v_account.disclosure_version_accepted
          is not distinct from v_policy.disclosure_version
        and v_program.status = 'active'
        and v_program.effective_from <= now()
        and (
          v_program.effective_until is null
          or v_program.effective_until > now()
        )
        and v_policy.individual_available
        and (
          v_policy.effective_from is null
          or v_policy.effective_from <= now()
        )
        and (
          v_policy.effective_until is null
          or v_policy.effective_until > now()
        )
        and coalesce((
          select f.enabled
          from public.admin_feature_flags f
          where f.key = 'partners_enabled'
        ), false)
        and affiliate_private.release_gates_satisfied(
          array[
            'legal_and_tax_approved',
            'privacy_approved',
            'individual_verification_coverage_confirmed',
            'individual_payout_coverage_confirmed',
            'country_policy_approved'
          ]::text[]
        )
        and (
          (v_invite_only and v_allowlisted)
          or (
            not v_invite_only
            and affiliate_private.release_gates_satisfied(
              array['general_release_approved']::text[]
            )
          )
        )
        and exists (
          select 1
          from auth.users u
          where u.id = v_account.user_id
            and u.email_confirmed_at is not null
        );

      if v_activation_ready then
        update affiliate_private.affiliate_accounts
        set
          status = 'active',
          updated_at = now()
        where id = v_account.id
        returning * into v_account;
        v_activated := true;

        insert into affiliate_private.affiliate_events (
          aggregate_type,
          aggregate_key,
          action,
          actor_type,
          actor_pseudonym,
          justification,
          before_state,
          after_state
        )
        values (
          'account',
          v_account.id::text,
          'account_activated',
          'system',
          v_account.user_pseudonym,
          'Signed KYC result passed every server-side activation gate.',
          jsonb_build_object('status', 'pending_verification'),
          jsonb_build_object('status', 'active')
        );
      end if;
    elsif v_target_status in ('failed', 'expired') then
      update affiliate_private.affiliate_accounts
      set
        verification_status = case
          when v_target_status = 'expired' then 'expired'
          else 'failed'
        end,
        verification_provider = 'didit',
        verification_reference = null,
        age_verified = false,
        capacity_verified = false,
        updated_at = now()
      where id = v_account.id
        and status = 'pending_verification'
      returning * into v_account;
    end if;
  end if;

  v_response := jsonb_build_object(
    'schema_version', 1,
    'action', 'kyc_result_applied',
    'replayed', false,
    'account', jsonb_build_object(
      'id', affiliate_private.partners_public_account_id(v_account),
      'status', v_account.status
    ),
    'kyc', jsonb_build_object(
      'status',
        case
          when v_session.status = 'verified' then 'verified'
          when v_session.status = 'failed' then 'failed'
          when v_session.status in ('expired', 'superseded') then 'expired'
          else 'pending'
        end,
      'verified_at', v_session.verified_at
    )
  );

  insert into affiliate_private.affiliate_kyc_webhook_events (
    provider_event_hash,
    session_id,
    provider_status,
    provider_event_at,
    payload_hash,
    processing_outcome,
    decision_reason,
    response
  )
  values (
    v_event_hash,
    v_session.id,
    v_provider_status,
    p_event_created_at,
    v_payload_hash,
    v_outcome,
    v_reason,
    v_response
  );

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
    'kyc',
    v_account.id::text,
    'kyc_result_applied',
    'service',
    v_account.user_pseudonym,
    'Signed Didit result was reduced to policy decision booleans.',
    jsonb_build_object(
      'status',
        case
          when v_session.status = 'superseded' then 'expired'
          else v_session.status
        end,
      'activated', v_activated,
      'decision_reason', v_reason
    )
  );

  return v_response;
end;
$$;

create or replace function affiliate_private.partners_service_referral_resolve(
  p_code_hash text,
  p_claim_hash text,
  p_expires_at timestamptz,
  p_request_nonce_hash text,
  p_network_hash text,
  p_user_agent_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_code_hash text := lower(btrim(coalesce(p_code_hash, '')));
  v_claim_hash text := lower(btrim(coalesce(p_claim_hash, '')));
  v_nonce_hash text := lower(btrim(coalesce(p_request_nonce_hash, '')));
  v_network_hash text := lower(btrim(coalesce(p_network_hash, '')));
  v_user_agent_hash text := lower(btrim(coalesce(p_user_agent_hash, '')));
  v_nonce affiliate_private.affiliate_referral_request_nonces%rowtype;
  v_claim affiliate_private.affiliate_link_claims%rowtype;
  v_link affiliate_private.affiliate_links%rowtype;
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_program affiliate_private.affiliate_program_versions%rowtype;
  v_network_count integer;
  v_user_agent_count integer;
  v_bucket timestamptz := date_trunc('hour', now());
  v_accepted boolean := false;
begin
  if v_code_hash !~ '^[0-9a-f]{64}$'
    or v_claim_hash !~ '^[0-9a-f]{64}$'
    or v_nonce_hash !~ '^[0-9a-f]{64}$'
    or v_network_hash !~ '^[0-9a-f]{64}$'
    or v_user_agent_hash !~ '^[0-9a-f]{64}$'
    or p_expires_at is null
    or p_expires_at <= now()
    or p_expires_at > now() + interval '30 days'
  then
    raise exception 'invalid referral resolution envelope'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:referral:' || v_nonce_hash, 0)
  );

  select n.*
  into v_nonce
  from affiliate_private.affiliate_referral_request_nonces n
  where n.nonce_hash = v_nonce_hash;
  if found then
    if v_nonce.claim_hash <> v_claim_hash
      or v_nonce.network_hash <> v_network_hash
      or v_nonce.user_agent_hash <> v_user_agent_hash
      or v_nonce.expires_at is distinct from p_expires_at
    then
      raise exception 'referral request nonce payload conflict'
        using errcode = 'P0003';
    end if;
    return jsonb_build_object(
      'schema_version', 1,
      'accepted', v_nonce.outcome = 'accepted',
      'claim', case
        when v_nonce.outcome = 'accepted'
          then jsonb_build_object('expires_at', v_nonce.expires_at)
        else null
      end
    );
  end if;

  insert into affiliate_private.affiliate_referral_rate_buckets (
    dimension_key,
    subject_hash,
    bucket_start,
    request_count,
    updated_at
  )
  values ('network', v_network_hash, v_bucket, 1, now())
  on conflict (dimension_key, subject_hash, bucket_start)
  do update set
    request_count =
      affiliate_private.affiliate_referral_rate_buckets.request_count + 1,
    updated_at = now()
  returning request_count into v_network_count;

  insert into affiliate_private.affiliate_referral_rate_buckets (
    dimension_key,
    subject_hash,
    bucket_start,
    request_count,
    updated_at
  )
  values ('user_agent', v_user_agent_hash, v_bucket, 1, now())
  on conflict (dimension_key, subject_hash, bucket_start)
  do update set
    request_count =
      affiliate_private.affiliate_referral_rate_buckets.request_count + 1,
    updated_at = now()
  returning request_count into v_user_agent_count;

  if v_network_count > 60 or v_user_agent_count > 120 then
    insert into affiliate_private.affiliate_referral_request_nonces (
      nonce_hash,
      claim_hash,
      network_hash,
      user_agent_hash,
      outcome,
      expires_at
    )
    values (
      v_nonce_hash,
      v_claim_hash,
      v_network_hash,
      v_user_agent_hash,
      'rate_limited',
      p_expires_at
    );
    return jsonb_build_object(
      'schema_version', 1,
      'accepted', false,
      'claim', null
    );
  end if;

  select l.*
  into v_link
  from affiliate_private.affiliate_links l
  where l.code_hash = v_code_hash
    and l.status = 'active';

  if found then
    select a.*
    into v_account
    from affiliate_private.affiliate_accounts a
    where a.id = v_link.account_id
      and a.status = 'active';
  end if;

  if v_account.id is not null then
    select p.*
    into v_program
    from affiliate_private.affiliate_program_versions p
    where p.id = v_account.program_version_id
      and p.status = 'active'
      and p.effective_from <= now()
      and (p.effective_until is null or p.effective_until > now())
      and p.commission_rate_bps = 2000
      and p.attribution_window_days = 30
      and p.maturation_days = 45;
  end if;

  if v_link.id is not null
    and v_account.id is not null
    and v_program.id is not null
  then
    select c.*
    into v_claim
    from affiliate_private.affiliate_link_claims c
    where c.claim_hash = v_claim_hash;

    if found then
      if v_claim.link_id <> v_link.id
        or v_claim.network_hash <> v_network_hash
        or v_claim.user_agent_hash <> v_user_agent_hash
        or v_claim.expires_at is distinct from p_expires_at
      then
        raise exception 'referral claim payload conflict'
          using errcode = 'P0003';
      end if;
      v_accepted := v_claim.status = 'pending'
        and v_claim.expires_at > now();
    else
      insert into affiliate_private.affiliate_link_claims (
        claim_hash,
        link_id,
        referrer_account_id,
        program_version_id,
        commission_rate_bps,
        attribution_window_days,
        network_hash,
        user_agent_hash,
        campaign_key,
        expires_at
      )
      values (
        v_claim_hash,
        v_link.id,
        v_account.id,
        v_program.id,
        v_program.commission_rate_bps,
        v_program.attribution_window_days,
        v_network_hash,
        v_user_agent_hash,
        v_link.campaign_key,
        p_expires_at
      );
      v_accepted := true;
    end if;
  end if;

  insert into affiliate_private.affiliate_referral_request_nonces (
    nonce_hash,
    claim_hash,
    network_hash,
    user_agent_hash,
    outcome,
    expires_at
  )
  values (
    v_nonce_hash,
    v_claim_hash,
    v_network_hash,
    v_user_agent_hash,
    case when v_accepted then 'accepted' else 'invalid' end,
    p_expires_at
  );

  return jsonb_build_object(
    'schema_version', 1,
    'accepted', v_accepted,
    'claim', case
      when v_accepted
        then jsonb_build_object('expires_at', p_expires_at)
      else null
    end
  );
end;
$$;

create or replace function affiliate_private.partners_service_referral_claim(
  p_user_id uuid,
  p_claim_hash text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_claim_hash text := lower(btrim(coalesce(p_claim_hash, '')));
  v_request_hash text;
  v_replay jsonb;
  v_user_created_at timestamptz;
  v_claim affiliate_private.affiliate_link_claims%rowtype;
  v_existing affiliate_private.affiliate_attributions%rowtype;
  v_attribution affiliate_private.affiliate_attributions%rowtype;
  v_referrer affiliate_private.affiliate_accounts%rowtype;
  v_outcome text;
  v_terminal boolean := true;
  v_response jsonb;
  v_rejection text;
begin
  if p_user_id is null or v_claim_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid referral claim request'
      using errcode = '22023';
  end if;
  if p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
  then
    raise exception 'invalid idempotency key'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:referred-user:' || p_user_id::text, 0)
  );

  v_request_hash := encode(
    extensions.digest(
      concat_ws(
        chr(31),
        'referral_claim:v1',
        p_user_id::text,
        v_claim_hash
      ),
      'sha256'
    ),
    'hex'
  );
  v_replay := affiliate_private.partners_replayed_response(
    'referral_claim',
    p_user_id,
    p_idempotency_key,
    v_request_hash
  );
  if v_replay is not null then
    return v_replay;
  end if;

  select u.created_at
  into v_user_created_at
  from auth.users u
  where u.id = p_user_id;
  if not found then
    raise exception 'authenticated user is unavailable'
      using errcode = 'P0002';
  end if;

  select a.*
  into v_existing
  from affiliate_private.affiliate_attributions a
  where a.referred_user_id = p_user_id;

  select c.*
  into v_claim
  from affiliate_private.affiliate_link_claims c
  where c.claim_hash = v_claim_hash
  for update;

  if v_existing.id is not null then
    v_outcome := 'already_attributed';
    if v_claim.id is not null
      and v_claim.status = 'pending'
      and v_claim.id <> v_existing.claim_id
    then
      update affiliate_private.affiliate_link_claims
      set
        status = 'rejected',
        rejection_reason = 'already_attributed',
        updated_at = now()
      where id = v_claim.id;
    end if;
  elsif v_claim.id is null then
    v_outcome := 'invalid';
  elsif v_claim.status = 'consumed' then
    v_outcome := 'already_attributed';
  elsif v_claim.status in ('expired', 'rejected') then
    v_outcome := case
      when v_claim.rejection_reason = 'expired' then 'expired'
      else 'ineligible'
    end;
  elsif v_claim.expires_at <= now() then
    update affiliate_private.affiliate_link_claims
    set
      status = 'expired',
      rejection_reason = 'expired',
      updated_at = now()
    where id = v_claim.id;
    v_outcome := 'expired';
  elsif v_claim.issued_at >= v_user_created_at then
    v_rejection := 'existing_account';
    v_outcome := 'ineligible';
  else
    select a.*
    into v_referrer
    from affiliate_private.affiliate_accounts a
    where a.id = v_claim.referrer_account_id
    for share;

    if v_referrer.id is null or v_referrer.status <> 'active' then
      v_rejection := 'account_unavailable';
      v_outcome := 'ineligible';
    elsif v_referrer.user_id = p_user_id then
      v_rejection := 'self_referral';
      v_outcome := 'ineligible';
    elsif exists (
      select 1
      from affiliate_private.affiliate_link_claims newer
      where newer.id <> v_claim.id
        and newer.network_hash = v_claim.network_hash
        and newer.user_agent_hash = v_claim.user_agent_hash
        and newer.status = 'pending'
        and newer.issued_at > v_claim.issued_at
        and newer.issued_at <= v_user_created_at
        and newer.expires_at > v_user_created_at
    ) then
      v_rejection := 'superseded_last_click';
      v_outcome := 'ineligible';
    else
      insert into affiliate_private.affiliate_attributions (
        referred_user_id,
        referrer_account_id,
        link_id,
        claim_id,
        program_version_id,
        commission_rate_bps,
        attribution_window_days
      )
      values (
        p_user_id,
        v_claim.referrer_account_id,
        v_claim.link_id,
        v_claim.id,
        v_claim.program_version_id,
        v_claim.commission_rate_bps,
        v_claim.attribution_window_days
      )
      returning * into v_attribution;

      update affiliate_private.affiliate_link_claims
      set
        status = 'consumed',
        consumed_at = now(),
        consumed_by_user_id = p_user_id,
        updated_at = now()
      where id = v_claim.id;

      v_outcome := 'attributed';
    end if;
  end if;

  if v_rejection is not null then
    update affiliate_private.affiliate_link_claims
    set
      status = 'rejected',
      rejection_reason = v_rejection,
      updated_at = now()
    where id = v_claim.id
      and status = 'pending';
  end if;

  v_response := jsonb_build_object(
    'schema_version', 1,
    'action', 'referral_claimed',
    'replayed', false,
    'outcome', v_outcome,
    'terminal', v_terminal,
    'attribution', case
      when v_outcome = 'attributed'
        then jsonb_build_object(
          'status', 'attributed',
          'attributed_at', v_attribution.attributed_at
        )
      when v_outcome = 'already_attributed'
        and v_existing.id is not null
        then jsonb_build_object(
          'status', v_existing.status,
          'attributed_at', v_existing.attributed_at
        )
      else null
    end
  );

  perform affiliate_private.partners_store_response(
    'referral_claim',
    p_user_id,
    p_idempotency_key,
    v_request_hash,
    v_response
  );

  if v_outcome = 'attributed' then
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
      'attribution',
      v_attribution.id::text,
      'referral_attributed',
      'service',
      v_referrer.user_pseudonym,
      'Eligible pre-signup last-click referral was consumed once.',
      jsonb_build_object(
        'status', 'attributed',
        'commission_rate_bps', v_attribution.commission_rate_bps,
        'attribution_window_days',
          v_attribution.attribution_window_days
      )
    );
  end if;

  return v_response;
end;
$$;

-- Public service shims remain unavailable to browser roles. Edge Functions
-- authenticate the caller and pass only authoritative, normalized values.
create or replace function public.partners_service_kyc_prepare(
  p_user_id uuid,
  p_idempotency_key text,
  p_consent_version text,
  p_capacity_attested boolean,
  p_language text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_kyc_prepare(
    p_user_id,
    p_idempotency_key,
    p_consent_version,
    p_capacity_attested,
    p_language
  );
$$;

create or replace function public.partners_service_kyc_session_record(
  p_user_id uuid,
  p_idempotency_key text,
  p_provider_session_id text,
  p_provider_workflow_id text,
  p_provider_workflow_version integer,
  p_provider_status text,
  p_expires_at timestamptz,
  p_reservation_key text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_kyc_session_record(
    p_user_id,
    p_idempotency_key,
    p_provider_session_id,
    p_provider_workflow_id,
    p_provider_workflow_version,
    p_provider_status,
    p_expires_at,
    p_reservation_key
  );
$$;

create or replace function public.partners_service_kyc_webhook_apply(
  p_provider_event_id text,
  p_provider_session_id text,
  p_provider_workflow_id text,
  p_provider_workflow_version integer,
  p_provider_status text,
  p_event_created_at timestamptz,
  p_document_age integer,
  p_document_country_iso3 text,
  p_id_check_approved boolean,
  p_liveness_approved boolean,
  p_face_match_approved boolean,
  p_payload_hash text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_kyc_webhook_apply(
    p_provider_event_id,
    p_provider_session_id,
    p_provider_workflow_id,
    p_provider_workflow_version,
    p_provider_status,
    p_event_created_at,
    p_document_age,
    p_document_country_iso3,
    p_id_check_approved,
    p_liveness_approved,
    p_face_match_approved,
    p_payload_hash
  );
$$;

create or replace function public.partners_service_referral_resolve(
  p_code_hash text,
  p_claim_hash text,
  p_expires_at timestamptz,
  p_request_nonce_hash text,
  p_network_hash text,
  p_user_agent_hash text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_referral_resolve(
    p_code_hash,
    p_claim_hash,
    p_expires_at,
    p_request_nonce_hash,
    p_network_hash,
    p_user_agent_hash
  );
$$;

create or replace function public.partners_service_referral_claim(
  p_user_id uuid,
  p_claim_hash text,
  p_idempotency_key text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_referral_claim(
    p_user_id,
    p_claim_hash,
    p_idempotency_key
  );
$$;

revoke all on function
  affiliate_private.reject_partners_append_only_mutation()
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.guard_kyc_session_transition()
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.guard_kyc_session_reservation_transition()
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.guard_link_claim_transition()
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.guard_attribution_transition()
  from public, anon, authenticated, service_role;
revoke all on function affiliate_private.partners_public_account_id(
  affiliate_private.affiliate_accounts
) from public, anon, authenticated, service_role;
revoke all on function affiliate_private.partners_valid_didit_status(text)
  from public, anon, authenticated, service_role;

revoke all on function affiliate_private.partners_service_kyc_prepare(
  uuid, text, text, boolean, text
) from public, anon, authenticated, service_role;
grant execute on function affiliate_private.partners_service_kyc_prepare(
  uuid, text, text, boolean, text
) to service_role;

revoke all on function
  affiliate_private.partners_service_kyc_session_record(
    uuid, text, text, text, integer, text, timestamptz, text
  )
  from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_service_kyc_session_record(
    uuid, text, text, text, integer, text, timestamptz, text
  )
  to service_role;

revoke all on function
  affiliate_private.partners_service_kyc_webhook_apply(
    text, text, text, integer, text, timestamptz, integer, text,
    boolean, boolean, boolean, text
  )
  from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_service_kyc_webhook_apply(
    text, text, text, integer, text, timestamptz, integer, text,
    boolean, boolean, boolean, text
  )
  to service_role;

revoke all on function
  affiliate_private.partners_service_referral_resolve(
    text, text, timestamptz, text, text, text
  )
  from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_service_referral_resolve(
    text, text, timestamptz, text, text, text
  )
  to service_role;

revoke all on function affiliate_private.partners_service_referral_claim(
  uuid, text, text
) from public, anon, authenticated, service_role;
grant execute on function affiliate_private.partners_service_referral_claim(
  uuid, text, text
) to service_role;

revoke all on function public.partners_service_kyc_prepare(
  uuid, text, text, boolean, text
) from public, anon, authenticated, service_role;
grant execute on function public.partners_service_kyc_prepare(
  uuid, text, text, boolean, text
) to service_role;

revoke all on function public.partners_service_kyc_session_record(
  uuid, text, text, text, integer, text, timestamptz, text
) from public, anon, authenticated, service_role;
grant execute on function public.partners_service_kyc_session_record(
  uuid, text, text, text, integer, text, timestamptz, text
) to service_role;

revoke all on function public.partners_service_kyc_webhook_apply(
  text, text, text, integer, text, timestamptz, integer, text,
  boolean, boolean, boolean, text
) from public, anon, authenticated, service_role;
grant execute on function public.partners_service_kyc_webhook_apply(
  text, text, text, integer, text, timestamptz, integer, text,
  boolean, boolean, boolean, text
) to service_role;

revoke all on function public.partners_service_referral_resolve(
  text, text, timestamptz, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.partners_service_referral_resolve(
  text, text, timestamptz, text, text, text
) to service_role;

revoke all on function public.partners_service_referral_claim(
  uuid, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.partners_service_referral_claim(
  uuid, text, text
) to service_role;
