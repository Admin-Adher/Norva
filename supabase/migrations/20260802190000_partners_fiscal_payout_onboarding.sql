-- Norva Partners P0: user fiscal self-attestation and privacy-minimized
-- Revolut manual payout onboarding.
--
-- The public member API never accepts a tax identifier, bank coordinate,
-- beneficiary token, masked destination or provider object. Fiscal
-- self-attestation can only create a pending review. A Finance operator may
-- complete payout onboarding only after the existing maker-checker Revolut
-- registry has produced an active binding and payout profile.

alter default privileges in schema affiliate_private
  revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- Fiscal self-attestation provenance
-- ---------------------------------------------------------------------------

alter table affiliate_private.affiliate_fiscal_profiles
  add column declaration_version text,
  add column self_attested_at timestamptz;

-- NOT VALID permits the deterministic legacy rewrite below, while PostgreSQL
-- still enforces the new invariant for every concurrent INSERT or UPDATE.
alter table affiliate_private.affiliate_fiscal_profiles
  add constraint affiliate_fiscal_profiles_self_attestation
  check (
    (
      (
        declaration_version is null
        and self_attested_at is null
        and status in ('missing', 'rejected', 'expired')
      )
      or (
        declaration_version = 'partners-tax-self-certification-v1'
        and self_attested_at is not null
        and status in ('pending', 'verified', 'rejected', 'expired')
      )
    )
    and (
      status <> 'verified'
      or (
        declaration_version = 'partners-tax-self-certification-v1'
        and self_attested_at is not null
      )
    )
  ) not valid;

-- No legacy row may inherit an attestation that was never collected. Every
-- previously verified profile is therefore closed fail-safe until the member
-- submits the fixed declaration and Finance reviews it again. No attestation
-- timestamp or declaration is synthesized from provider provenance.
with legacy_candidates as materialized (
  select profile.account_id, profile.status as previous_status
  from affiliate_private.affiliate_fiscal_profiles profile
  where profile.status in ('pending', 'verified', 'rejected')
    and (
      profile.declaration_version is distinct from
        'partners-tax-self-certification-v1'
      or profile.self_attested_at is null
    )
),
legacy_without_attestation as (
  update affiliate_private.affiliate_fiscal_profiles profile
  set
    status = 'expired',
    updated_at = now()
  from legacy_candidates candidate
  where profile.account_id = candidate.account_id
  returning profile.account_id, candidate.previous_status
)
insert into affiliate_private.affiliate_events (
  aggregate_type,
  aggregate_key,
  action,
  actor_type,
  justification,
  before_state,
  after_state
)
select
  'payout',
  affiliate_private.partners_public_account_id(account),
  'fiscal_legacy_attestation_missing',
  'system',
  'Legacy fiscal state expired because no user self-attestation was recorded.',
  jsonb_build_object('status', legacy.previous_status),
  jsonb_build_object(
    'status', 'expired',
    'reason', 'missing_self_attestation'
  )
from legacy_without_attestation legacy
join affiliate_private.affiliate_accounts account
  on account.id = legacy.account_id;

alter table affiliate_private.affiliate_fiscal_profiles
  validate constraint affiliate_fiscal_profiles_self_attestation;

comment on column
  affiliate_private.affiliate_fiscal_profiles.declaration_version
is
  'Immutable public declaration version; never a tax identifier or tax form value.';
comment on column
  affiliate_private.affiliate_fiscal_profiles.self_attested_at
is
  'Timestamp proving acceptance of the fixed self-certification declaration.';

create index if not exists affiliate_fiscal_profiles_review_queue_idx
  on affiliate_private.affiliate_fiscal_profiles (
    status,
    self_attested_at desc,
    account_id
  );

-- ---------------------------------------------------------------------------
-- Payout onboarding request and append-only transition evidence
-- ---------------------------------------------------------------------------

create table affiliate_private.affiliate_payout_onboarding_requests (
  id                       uuid primary key default gen_random_uuid(),
  request_key              text not null unique default (
    'por_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  account_id               uuid not null
    references affiliate_private.affiliate_accounts(id)
    on delete restrict,
  currency                 text not null,
  revision                 integer not null,
  execution_adapter        text not null default 'revolut_manual',
  contact_consent          boolean not null,
  status                   text not null default 'pending',
  reason_code              text,
  handled_by_pseudonym     text,
  completed_by_pseudonym   text,
  requested_at             timestamptz not null default now(),
  started_at               timestamptz,
  rejected_at              timestamptz,
  completed_at             timestamptz,
  updated_at               timestamptz not null default now(),
  constraint affiliate_payout_onboarding_requests_key
    check (request_key ~ '^por_[0-9a-f]{24}$'),
  constraint affiliate_payout_onboarding_requests_currency
    check (currency ~ '^[A-Z]{3}$'),
  constraint affiliate_payout_onboarding_requests_revision
    check (revision between 1 and 2147483646),
  constraint affiliate_payout_onboarding_requests_adapter
    check (execution_adapter = 'revolut_manual'),
  constraint affiliate_payout_onboarding_requests_status
    check (status in ('pending', 'in_progress', 'rejected', 'completed')),
  constraint affiliate_payout_onboarding_requests_reason
    check (
      reason_code is null
      or reason_code in (
        'route_unavailable',
        'beneficiary_setup_required',
        'identity_mismatch',
        'unsupported_destination',
        'compliance_review',
        'duplicate_request'
      )
    ),
  constraint affiliate_payout_onboarding_requests_actors
    check (
      (
        handled_by_pseudonym is null
        or handled_by_pseudonym ~ '^[0-9a-f]{64}$'
      )
      and (
        completed_by_pseudonym is null
        or completed_by_pseudonym ~ '^[0-9a-f]{64}$'
      )
    ),
  constraint affiliate_payout_onboarding_requests_lifecycle
    check (
      contact_consent
      and updated_at >= requested_at
      and (
        (
          status = 'pending'
          and reason_code is null
          and handled_by_pseudonym is null
          and completed_by_pseudonym is null
          and started_at is null
          and rejected_at is null
          and completed_at is null
        )
        or (
          status = 'in_progress'
          and reason_code is null
          and handled_by_pseudonym is not null
          and completed_by_pseudonym is null
          and started_at is not null
          and started_at >= requested_at
          and rejected_at is null
          and completed_at is null
        )
        or (
          status = 'rejected'
          and reason_code is not null
          and handled_by_pseudonym is not null
          and completed_by_pseudonym is null
          and started_at is not null
          and rejected_at is not null
          and rejected_at >= started_at
          and completed_at is null
        )
        or (
          status = 'completed'
          and reason_code is null
          and handled_by_pseudonym is not null
          and completed_by_pseudonym is not null
          and started_at is not null
          and completed_at is not null
          and completed_at >= started_at
          and rejected_at is null
        )
      )
    ),
  unique (account_id, currency, revision)
);

create unique index affiliate_payout_onboarding_one_open_idx
  on affiliate_private.affiliate_payout_onboarding_requests (account_id)
  where status in ('pending', 'in_progress');

create index affiliate_payout_onboarding_queue_idx
  on affiliate_private.affiliate_payout_onboarding_requests (
    status,
    requested_at desc,
    request_key
  );

create table affiliate_private.affiliate_payout_onboarding_transitions (
  id                       bigint generated always as identity primary key,
  request_id               uuid not null
    references affiliate_private.affiliate_payout_onboarding_requests(id)
    on delete restrict,
  from_status              text,
  to_status                text not null,
  actor_type               text not null,
  actor_pseudonym          text not null,
  reason_code              text,
  justification            text not null,
  created_at               timestamptz not null default now(),
  constraint affiliate_payout_onboarding_transitions_statuses
    check (
      (from_status is null or from_status in (
        'pending', 'in_progress', 'rejected', 'completed'
      ))
      and to_status in ('pending', 'in_progress', 'rejected', 'completed')
    ),
  constraint affiliate_payout_onboarding_transitions_actor
    check (
      actor_type in ('service', 'admin')
      and actor_pseudonym ~ '^[0-9a-f]{64}$'
    ),
  constraint affiliate_payout_onboarding_transitions_reason
    check (
      reason_code is null
      or reason_code in (
        'route_unavailable',
        'beneficiary_setup_required',
        'identity_mismatch',
        'unsupported_destination',
        'compliance_review',
        'duplicate_request'
      )
    ),
  constraint affiliate_payout_onboarding_transitions_justification
    check (length(btrim(justification)) between 12 and 1000)
);

create index affiliate_payout_onboarding_transitions_request_idx
  on affiliate_private.affiliate_payout_onboarding_transitions (
    request_id,
    created_at,
    id
  );

alter table affiliate_private.affiliate_payout_onboarding_requests
  enable row level security;
alter table affiliate_private.affiliate_payout_onboarding_transitions
  enable row level security;

revoke all on table
  affiliate_private.affiliate_payout_onboarding_requests,
  affiliate_private.affiliate_payout_onboarding_transitions
from public, anon, authenticated, service_role;
revoke all on sequence
  affiliate_private.affiliate_payout_onboarding_transitions_id_seq
from public, anon, authenticated, service_role;

create trigger affiliate_payout_onboarding_transitions_append_only
before update or delete
on affiliate_private.affiliate_payout_onboarding_transitions
for each row execute function
  affiliate_private.reject_affiliate_event_mutation();

create or replace function
affiliate_private.guard_payout_onboarding_request_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'payout onboarding requests cannot be deleted'
      using errcode = '55000';
  end if;
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id
      or new.request_key is distinct from old.request_key
      or new.account_id is distinct from old.account_id
      or new.currency is distinct from old.currency
      or new.revision is distinct from old.revision
      or new.execution_adapter is distinct from old.execution_adapter
    then
      raise exception 'payout onboarding request identity is immutable'
        using errcode = '55000';
    end if;
    if new.status is distinct from old.status
      and not (
        (old.status = 'pending'
          and new.status in ('in_progress', 'rejected'))
        or (old.status = 'in_progress'
          and new.status in ('rejected', 'completed'))
      )
    then
      raise exception 'invalid payout onboarding transition'
        using errcode = '55000';
    end if;
  elsif new.status <> 'pending' then
    raise exception 'payout onboarding must start pending'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger affiliate_payout_onboarding_requests_validate
before insert or update or delete
on affiliate_private.affiliate_payout_onboarding_requests
for each row execute function
  affiliate_private.guard_payout_onboarding_request_transition();

-- Extend the existing idempotency allowlist without weakening prior entries.
alter table affiliate_private.affiliate_service_idempotency
  add constraint affiliate_service_idempotency_operation_v3
  check (
    operation in (
      'application',
      'terms_acceptance',
      'link_rotation',
      'kyc_prepare',
      'kyc_session_record',
      'referral_claim',
      'payout_profile',
      'tv_relay_consume',
      'access_request',
      'fiscal_profile_self_attestation',
      'payout_onboarding'
    )
  ) not valid;
alter table affiliate_private.affiliate_service_idempotency
  validate constraint affiliate_service_idempotency_operation_v3;
alter table affiliate_private.affiliate_service_idempotency
  drop constraint affiliate_service_idempotency_operation;
alter table affiliate_private.affiliate_service_idempotency
  rename constraint affiliate_service_idempotency_operation_v3
  to affiliate_service_idempotency_operation;

create index affiliate_service_idempotency_fiscal_onboarding_idx
  on affiliate_private.affiliate_service_idempotency (
    operation,
    created_at,
    user_id
  )
  where operation in (
    'fiscal_profile_self_attestation',
    'payout_onboarding'
  );

create index affiliate_service_idempotency_fiscal_onboarding_rate_idx
  on affiliate_private.affiliate_service_idempotency (
    operation,
    user_id,
    created_at desc
  )
  where operation in (
    'fiscal_profile_self_attestation',
    'payout_onboarding'
  );

-- This helper is called only after exact-key replay has been checked while the
-- caller owns the per-user advisory lock. It therefore limits new keys without
-- charging a legitimate retry, and opportunistically bounds idempotency data.
create or replace function
affiliate_private.partners_enforce_fiscal_onboarding_write_limit(
  p_operation text,
  p_user_id uuid
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_recent_attempts integer := 0;
begin
  if p_user_id is null
    or p_operation not in (
      'fiscal_profile_self_attestation',
      'payout_onboarding'
    )
  then
    raise exception 'invalid Partners mutation limit scope'
      using errcode = '22023';
  end if;

  delete from affiliate_private.affiliate_service_idempotency old_request
  where old_request.ctid in (
    select candidate.ctid
    from affiliate_private.affiliate_service_idempotency candidate
    where candidate.operation = p_operation
      and candidate.created_at < now() - interval '30 days'
    order by candidate.created_at
    limit 200
  );

  select count(*)::integer
  into v_recent_attempts
  from affiliate_private.affiliate_service_idempotency recent_request
  where recent_request.operation = p_operation
    and recent_request.user_id = p_user_id
    and recent_request.created_at >= now() - interval '24 hours';

  if v_recent_attempts >= 8
    or exists (
      select 1
      from affiliate_private.affiliate_service_idempotency recent_request
      where recent_request.operation = p_operation
        and recent_request.user_id = p_user_id
        and recent_request.created_at >= now() - interval '60 seconds'
    )
  then
    raise exception 'Partners fiscal or payout onboarding rate limit exceeded'
      using errcode = 'P0008';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Strict state builders
-- ---------------------------------------------------------------------------

create or replace function affiliate_private.partners_fiscal_profile_state(
  p_profile affiliate_private.affiliate_fiscal_profiles
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'exists', true,
    'status', p_profile.status,
    'country_code', p_profile.residence_country_code,
    'declaration_version', p_profile.declaration_version,
    'submitted_at', p_profile.self_attested_at,
    'reviewed_at', p_profile.reviewed_at
  );
$$;

create or replace function
affiliate_private.partners_payout_onboarding_state(
  p_request affiliate_private.affiliate_payout_onboarding_requests
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'exists', true,
    'status', p_request.status,
    'currency', p_request.currency,
    'execution_adapter', 'revolut_manual',
    'reconfiguration_required', false,
    'requested_at', p_request.requested_at,
    'updated_at', p_request.updated_at,
    'reason_code', p_request.reason_code
  );
$$;

create or replace function
affiliate_private.partners_payout_account_evidence_is_current(
  p_account affiliate_private.affiliate_accounts,
  p_program affiliate_private.affiliate_program_versions,
  p_policy affiliate_private.affiliate_country_policies
)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(
    p_account.account_type = 'individual'
    and p_account.status = 'active'
    and p_account.program_version_id = p_program.id
    and p_account.country_policy_id = p_policy.id
    and p_account.country_code = p_policy.country_code
    and (
      p_policy.subdivision_code is null
      or p_policy.subdivision_code = p_account.subdivision_code
    )
    and p_account.verification_status = 'verified'
    and p_account.verification_provider = p_policy.verification_provider
    and nullif(btrim(p_account.verification_reference), '') is not null
    and p_account.age_verified
    and (not p_policy.capacity_required or p_account.capacity_verified)
    and p_account.contract_status = 'accepted'
    and p_account.terms_version_accepted = p_policy.terms_version
    and p_account.disclosure_version_accepted = p_policy.disclosure_version
    and p_program.status = 'active'
    and p_program.account_type = 'individual'
    and p_program.commission_rate_bps = 2000
    and p_program.attribution_window_days = 30
    and p_program.maturation_days = 45
    and p_program.effective_from is not null
    and p_program.effective_from <= now()
    and (
      p_program.effective_until is null
      or p_program.effective_until > now()
    )
    and p_policy.program_version_id = p_program.id
    and p_policy.individual_available
    and p_policy.minimum_age between 18 and 99
    and p_policy.verification_level in (
      'identity_age_country',
      'identity_age_country_capacity'
    )
    and p_policy.verification_provider is not null
    and (
      p_policy.effective_from is null
      or p_policy.effective_from <= now()
    )
    and (
      p_policy.effective_until is null
      or p_policy.effective_until > now()
    )
    and affiliate_private.payout_currencies_covered(
      p_program.payout_thresholds,
      p_policy.payout_currencies
    ),
    false
  );
$$;

create or replace function
affiliate_private.partners_payout_onboarding_allowed_currencies(
  p_account affiliate_private.affiliate_accounts
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(route.currency order by route.currency), '[]'::jsonb)
  from affiliate_private.affiliate_payout_provider_configs route
  join affiliate_private.affiliate_currency_metadata currency_meta
    on currency_meta.currency_code = route.currency
    and currency_meta.status = 'active'
  join affiliate_private.affiliate_country_policies policy
    on policy.id = p_account.country_policy_id
    and route.currency = any (policy.payout_currencies)
  join affiliate_private.affiliate_program_versions program
    on program.id = p_account.program_version_id
    and program.id = policy.program_version_id
  join affiliate_private.affiliate_fiscal_profiles fiscal_profile
    on fiscal_profile.account_id = p_account.id
    and fiscal_profile.status = 'verified'
    and fiscal_profile.residence_country_code = p_account.country_code
    and fiscal_profile.declaration_version =
      'partners-tax-self-certification-v1'
    and fiscal_profile.self_attested_at is not null
    and fiscal_profile.reviewed_at is not null
    and fiscal_profile.verification_provider is not null
    and fiscal_profile.verification_reference_hash is not null
  where route.provider = 'revolut'
    and route.execution_adapter = 'revolut_manual'
    and route.status = 'active'
    and route.country_code = p_account.country_code
    and affiliate_private.partners_payout_account_evidence_is_current(
      p_account,
      program,
      policy
    );
$$;

-- A completed onboarding row is immutable evidence that Finance finished the
-- setup at that point in time. Its live usability is derived separately so a
-- later route, fiscal, contract/policy or beneficiary drift cannot leave the
-- member or Finance with a contradictory "completed and ready" state.
create or replace function
affiliate_private.partners_payout_onboarding_reconfiguration_required(
  p_account affiliate_private.affiliate_accounts,
  p_request affiliate_private.affiliate_payout_onboarding_requests
)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(
    p_request.status = 'completed'
    and (
      not (
        affiliate_private.partners_payout_onboarding_allowed_currencies(
          p_account
        ) ? p_request.currency
      )
      or not exists (
        select 1
        from affiliate_private.affiliate_payout_profiles profile
        join affiliate_private.affiliate_revolut_beneficiary_bindings binding
          on binding.id = profile.revolut_binding_id
          and binding.binding_version = profile.revolut_binding_version
          and binding.account_id = profile.account_id
          and binding.currency = profile.currency
          and binding.status = 'active'
        where profile.account_id = p_account.id
          and profile.currency = p_request.currency
          and profile.provider = 'revolut'
          and profile.status = 'active'
      )
    ),
    false
  );
$$;

-- ---------------------------------------------------------------------------
-- Authenticated member RPCs (called only by the service-role Edge boundary)
-- ---------------------------------------------------------------------------

create or replace function
affiliate_private.partners_service_fiscal_profile_get(
  p_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_profile affiliate_private.affiliate_fiscal_profiles%rowtype;
  v_exists boolean := false;
begin
  if p_user_id is null then
    raise exception 'user id is required' using errcode = '22023';
  end if;
  select account.*
  into v_account
  from affiliate_private.affiliate_accounts account
  where account.user_id = p_user_id
    and account.account_type = 'individual'
    and account.status <> 'closed';
  if not found then
    raise exception 'Partners account is unavailable'
      using errcode = 'P0002';
  end if;

  select profile.*
  into v_profile
  from affiliate_private.affiliate_fiscal_profiles profile
  where profile.account_id = v_account.id;
  v_exists := found;

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'fiscal_profile_loaded',
    'fiscal_profile', case
      when v_exists and v_profile.status <> 'missing'
        then affiliate_private.partners_fiscal_profile_state(v_profile)
      else jsonb_build_object(
        'exists', false,
        'status', 'missing',
        'country_code', null,
        'declaration_version', null,
        'submitted_at', null,
        'reviewed_at', null
      )
    end
  );
end;
$$;

create or replace function
affiliate_private.partners_service_fiscal_profile_self_attest(
  p_user_id uuid,
  p_country_code text,
  p_declaration_version text,
  p_declaration_accepted boolean,
  p_idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_country text := upper(btrim(coalesce(p_country_code, '')));
  v_declaration text := lower(btrim(coalesce(p_declaration_version, '')));
  v_request_hash text;
  v_replay jsonb;
  v_response jsonb;
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_profile affiliate_private.affiliate_fiscal_profiles%rowtype;
  v_actor text;
  v_changed boolean := false;
begin
  if p_user_id is null
    or v_country !~ '^[A-Z]{2}$'
    or v_declaration <> 'partners-tax-self-certification-v1'
    or p_declaration_accepted is distinct from true
    or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
  then
    raise exception 'invalid fiscal self-attestation'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:user:' || p_user_id::text, 0)
  );
  v_request_hash := encode(
    extensions.digest(
      concat_ws(
        chr(31),
        'fiscal-self-attestation:v1',
        p_user_id::text,
        v_country,
        v_declaration,
        'accepted'
      ),
      'sha256'
    ),
    'hex'
  );
  v_replay := affiliate_private.partners_replayed_response(
    'fiscal_profile_self_attestation',
    p_user_id,
    p_idempotency_key,
    v_request_hash
  );
  if v_replay is not null then
    return v_replay;
  end if;
  select account.*
  into v_account
  from affiliate_private.affiliate_accounts account
  where account.user_id = p_user_id
    and account.account_type = 'individual'
    and account.status = 'active'
    and account.verification_status = 'verified'
    and account.contract_status = 'accepted'
  for update;
  if not found then
    raise exception 'active verified Partners account is required'
      using errcode = 'P0001';
  end if;
  if v_account.country_code is distinct from v_country then
    raise exception 'fiscal residence conflicts with account country'
      using errcode = 'P0001';
  end if;

  select profile.*
  into v_profile
  from affiliate_private.affiliate_fiscal_profiles profile
  where profile.account_id = v_account.id
  for update;

  if found and v_profile.status = 'verified' then
    raise exception 'verified fiscal profile cannot be self-attested again'
      using errcode = 'P0001';
  elsif found
    and v_profile.status = 'pending'
    and (
      v_profile.declaration_version is distinct from v_declaration
      or v_profile.self_attested_at is null
      or v_profile.residence_country_code is distinct from v_country
    )
  then
    raise exception 'authoritative fiscal review is already pending'
      using errcode = 'P0001';
  elsif found and v_profile.status = 'pending' then
    null;
  elsif found then
    update affiliate_private.affiliate_fiscal_profiles profile
    set
      residence_country_code = v_country,
      status = 'pending',
      verification_provider = null,
      verification_reference_hash = null,
      tax_form_type = null,
      reviewed_at = null,
      declaration_version = v_declaration,
      self_attested_at = now(),
      updated_at = now()
    where profile.account_id = v_account.id
    returning profile.* into v_profile;
    v_changed := true;
  else
    insert into affiliate_private.affiliate_fiscal_profiles (
      account_id,
      residence_country_code,
      status,
      declaration_version,
      self_attested_at,
      updated_at
    )
    values (
      v_account.id,
      v_country,
      'pending',
      v_declaration,
      now(),
      now()
    )
    returning * into v_profile;
    v_changed := true;
  end if;

  v_actor := encode(
    extensions.digest(
      'norva-partners-subject:v1:' || p_user_id::text,
      'sha256'
    ),
    'hex'
  );
  if v_changed then
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
      affiliate_private.partners_public_account_id(v_account),
      'fiscal_profile_self_attested',
      'service',
      v_actor,
      'Authenticated partner accepted the fixed fiscal self-certification declaration.',
      jsonb_build_object(
        'status', 'pending',
        'country_code', v_country,
        'declaration_version', v_declaration
      )
    );
  end if;

  v_response := jsonb_build_object(
    'schema_version', 1,
    'action', 'fiscal_profile_submitted',
    'replayed', not v_changed,
    'fiscal_profile',
      affiliate_private.partners_fiscal_profile_state(v_profile)
  );
  perform affiliate_private.partners_store_response(
    'fiscal_profile_self_attestation',
    p_user_id,
    p_idempotency_key,
    v_request_hash,
    v_response
  );
  return v_response;
end;
$$;

-- The legacy provider-result RPC used to upsert `verified` directly. Keep its
-- signature for controlled callers, but make it incapable of creating a
-- profile or crossing the user declaration plus Finance/AAL2 boundary.
create or replace function
affiliate_private.partners_service_fiscal_profile_record(
  p_user_id uuid,
  p_provider text,
  p_provider_reference_hash text,
  p_residence_country_code text,
  p_tax_form_type text,
  p_status text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_provider text := lower(btrim(coalesce(p_provider, '')));
  v_reference text := lower(
    btrim(coalesce(p_provider_reference_hash, ''))
  );
  v_country text := upper(
    btrim(coalesce(p_residence_country_code, ''))
  );
  v_form text := nullif(btrim(coalesce(p_tax_form_type, '')), '');
  v_status text := lower(btrim(coalesce(p_status, '')));
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_profile affiliate_private.affiliate_fiscal_profiles%rowtype;
begin
  if p_user_id is null
    or v_provider !~ '^[a-z0-9][a-z0-9._-]{1,63}$'
    or v_reference !~ '^[0-9a-f]{64}$'
    or v_country !~ '^[A-Z]{2}$'
    or (
      v_form is not null
      and v_form !~ '^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$'
    )
    or v_status not in ('pending', 'rejected', 'expired')
  then
    if v_status = 'verified' then
      raise exception 'direct service fiscal verification is forbidden'
        using errcode = 'P0001';
    end if;
    raise exception 'invalid tokenized fiscal result'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:user:' || p_user_id::text, 0)
  );
  select account.*
  into v_account
  from affiliate_private.affiliate_accounts account
  where account.user_id = p_user_id
    and account.account_type = 'individual'
    and account.status = 'active'
    and account.verification_status = 'verified'
    and account.contract_status = 'accepted'
  for update;
  if not found then
    raise exception 'active verified Partners account is required'
      using errcode = 'P0001';
  end if;
  if v_account.country_code is distinct from v_country then
    raise exception 'fiscal residence conflicts with account policy'
      using errcode = 'P0001';
  end if;

  select profile.*
  into v_profile
  from affiliate_private.affiliate_fiscal_profiles profile
  where profile.account_id = v_account.id
  for update;
  if not found
    or v_profile.status <> 'pending'
    or v_profile.residence_country_code is distinct from v_country
    or v_profile.declaration_version <>
      'partners-tax-self-certification-v1'
    or v_profile.self_attested_at is null
  then
    raise exception 'pending fiscal self-attestation is required'
      using errcode = 'P0001';
  end if;

  update affiliate_private.affiliate_fiscal_profiles profile
  set
    status = v_status,
    verification_provider = v_provider,
    verification_reference_hash = v_reference,
    tax_form_type = v_form,
    reviewed_at = case
      when v_status = 'pending' then null
      else now()
    end,
    updated_at = now()
  where profile.account_id = v_account.id
  returning profile.* into v_profile;

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'fiscal_profile_recorded',
    'fiscal', jsonb_build_object(
      'status', v_profile.status,
      'country_code', v_profile.residence_country_code
    )
  );
end;
$$;

create or replace function
affiliate_private.partners_service_payout_onboarding_get(
  p_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_request affiliate_private.affiliate_payout_onboarding_requests%rowtype;
  v_exists boolean := false;
  v_reconfiguration_required boolean := false;
begin
  if p_user_id is null then
    raise exception 'user id is required' using errcode = '22023';
  end if;
  select account.*
  into v_account
  from affiliate_private.affiliate_accounts account
  where account.user_id = p_user_id
    and account.account_type = 'individual'
    and account.status <> 'closed';
  if not found then
    raise exception 'Partners account is unavailable'
      using errcode = 'P0002';
  end if;

  select request_row.*
  into v_request
  from affiliate_private.affiliate_payout_onboarding_requests request_row
  where request_row.account_id = v_account.id
  order by
    request_row.requested_at desc,
    request_row.revision desc,
    request_row.request_key
  limit 1;
  v_exists := found;
  if v_exists then
    v_reconfiguration_required :=
      affiliate_private
        .partners_payout_onboarding_reconfiguration_required(
          v_account,
          v_request
        );
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'payout_onboarding_loaded',
    'payout_onboarding', case
      when v_exists then
        affiliate_private.partners_payout_onboarding_state(v_request)
        || jsonb_build_object(
          'reconfiguration_required', v_reconfiguration_required
        )
      else jsonb_build_object(
        'exists', false,
        'status', 'not_started',
        'currency', null,
        'execution_adapter', 'revolut_manual',
        'reconfiguration_required', false,
        'requested_at', null,
        'updated_at', null,
        'reason_code', null
      )
    end,
    'allowed_currencies',
      affiliate_private.partners_payout_onboarding_allowed_currencies(
        v_account
      )
  );
end;
$$;

create or replace function
affiliate_private.partners_service_payout_onboarding_request(
  p_user_id uuid,
  p_currency text,
  p_contact_consent boolean,
  p_idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_currency text := upper(btrim(coalesce(p_currency, '')));
  v_request_hash text;
  v_replay jsonb;
  v_response jsonb;
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_program affiliate_private.affiliate_program_versions%rowtype;
  v_policy affiliate_private.affiliate_country_policies%rowtype;
  v_request affiliate_private.affiliate_payout_onboarding_requests%rowtype;
  v_other_open boolean := false;
  v_actor text;
  v_previous_status text;
  v_next_revision integer := 1;
  v_binding_ready boolean := false;
  v_request_exists boolean := false;
  v_changed boolean := false;
begin
  if p_user_id is null
    or v_currency !~ '^[A-Z]{3}$'
    or p_contact_consent is distinct from true
    or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
  then
    raise exception 'invalid payout onboarding request'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:user:' || p_user_id::text, 0)
  );
  v_request_hash := encode(
    extensions.digest(
      concat_ws(
        chr(31),
        'payout-onboarding:v1',
        p_user_id::text,
        v_currency,
        'revolut_manual',
        'contact-consent'
      ),
      'sha256'
    ),
    'hex'
  );
  v_replay := affiliate_private.partners_replayed_response(
    'payout_onboarding',
    p_user_id,
    p_idempotency_key,
    v_request_hash
  );
  if v_replay is not null then
    return v_replay;
  end if;
  -- All payout-registry writers acquire the global configuration lock before
  -- any account/request row lock. Keeping one lock hierarchy prevents the
  -- member reconfiguration path from deadlocking with beneficiary proposal or
  -- revocation, which already use global -> account.
  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:payout-approval-configuration',
      0
    )
  );

  select account.*
  into v_account
  from affiliate_private.affiliate_accounts account
  where account.user_id = p_user_id
    and account.account_type = 'individual'
    and account.status = 'active'
    and account.verification_status = 'verified'
    and account.contract_status = 'accepted'
  for update;
  if not found then
    raise exception 'active verified Partners account is required'
      using errcode = 'P0001';
  end if;

  select program.*
  into v_program
  from affiliate_private.affiliate_program_versions program
  where program.id = v_account.program_version_id
  for share;
  select policy.*
  into v_policy
  from affiliate_private.affiliate_country_policies policy
  where policy.id = v_account.country_policy_id
  for share;
  if not affiliate_private.partners_payout_account_evidence_is_current(
    v_account,
    v_program,
    v_policy
  )
    or not (v_currency = any (v_policy.payout_currencies))
  then
    raise exception 'current Partners payout eligibility is required'
      using errcode = 'P0001';
  end if;

  perform 1
    from affiliate_private.affiliate_fiscal_profiles fiscal_profile
    where fiscal_profile.account_id = v_account.id
      and fiscal_profile.status = 'verified'
      and fiscal_profile.residence_country_code = v_account.country_code
      and fiscal_profile.declaration_version =
        'partners-tax-self-certification-v1'
      and fiscal_profile.self_attested_at is not null
      and fiscal_profile.reviewed_at is not null
      and fiscal_profile.verification_provider is not null
      and fiscal_profile.verification_reference_hash is not null
    for share;
  if not found then
    raise exception 'verified fiscal profile is required'
      using errcode = 'P0001';
  end if;

  perform 1
    from affiliate_private.affiliate_payout_provider_configs route
    join affiliate_private.affiliate_currency_metadata currency_meta
      on currency_meta.currency_code = route.currency
      and currency_meta.status = 'active'
    where route.provider = 'revolut'
      and route.execution_adapter = 'revolut_manual'
      and route.status = 'active'
      and route.country_code = v_account.country_code
      and route.currency = v_currency
    for share of route, currency_meta;
  if not found then
    raise exception 'manual Revolut route is unavailable'
      using errcode = 'P0001';
  end if;

  select exists (
    select 1
    from affiliate_private.affiliate_payout_onboarding_requests open_request
    where open_request.account_id = v_account.id
      and open_request.currency <> v_currency
      and open_request.status in ('pending', 'in_progress')
  ) into v_other_open;
  if v_other_open then
    raise exception 'another payout onboarding request is open'
      using errcode = 'P0001';
  end if;

  select request_row.*
  into v_request
  from affiliate_private.affiliate_payout_onboarding_requests request_row
  where request_row.account_id = v_account.id
    and request_row.currency = v_currency
  order by request_row.revision desc
  limit 1
  for update;
  v_request_exists := found;

  if v_request_exists then
    v_previous_status := v_request.status;
    v_next_revision := v_request.revision + 1;
    if v_request.status = 'completed' then
      select exists (
        select 1
        from affiliate_private.affiliate_payout_profiles profile
        join affiliate_private.affiliate_revolut_beneficiary_bindings binding
          on binding.id = profile.revolut_binding_id
          and binding.binding_version = profile.revolut_binding_version
          and binding.account_id = profile.account_id
          and binding.currency = profile.currency
          and binding.status = 'active'
        where profile.account_id = v_account.id
          and profile.currency = v_currency
          and profile.provider = 'revolut'
          and profile.status = 'active'
      ) into v_binding_ready;
    end if;
  end if;

  if not v_request_exists
    or v_request.status = 'rejected'
    or (v_request.status = 'completed' and not v_binding_ready)
  then
    insert into affiliate_private.affiliate_payout_onboarding_requests (
      account_id,
      currency,
      revision,
      execution_adapter,
      contact_consent,
      status
    )
    values (
      v_account.id,
      v_currency,
      v_next_revision,
      'revolut_manual',
      true,
      'pending'
    )
    returning * into v_request;
    v_changed := true;
  end if;

  v_actor := encode(
    extensions.digest(
      'norva-partners-subject:v1:' || p_user_id::text,
      'sha256'
    ),
    'hex'
  );
  if v_changed then
    insert into affiliate_private.affiliate_payout_onboarding_transitions (
      request_id,
      from_status,
      to_status,
      actor_type,
      actor_pseudonym,
      justification
    )
    values (
      v_request.id,
      null,
      'pending',
      'service',
      v_actor,
      'Authenticated partner requested contact for manual payout onboarding.'
    );
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
      'payout',
      v_request.request_key,
      'payout_onboarding_requested',
      'service',
      v_actor,
      'Authenticated partner requested contact for manual payout onboarding.',
      case
        when v_previous_status is null then '{}'::jsonb
        else jsonb_build_object('previous_status', v_previous_status)
      end,
      jsonb_build_object(
        'status', 'pending',
        'country_code', v_account.country_code,
        'currency', v_currency,
        'execution_adapter', 'revolut_manual'
      )
    );
  end if;

  v_response := jsonb_build_object(
    'schema_version', 1,
    'action', 'payout_onboarding_requested',
    'replayed', not v_changed,
    'payout_onboarding',
      affiliate_private.partners_payout_onboarding_state(v_request)
  );
  perform affiliate_private.partners_store_response(
    'payout_onboarding',
    p_user_id,
    p_idempotency_key,
    v_request_hash,
    v_response
  );
  return v_response;
end;
$$;

-- ---------------------------------------------------------------------------
-- Finance AAL2 queue and audited transitions
-- ---------------------------------------------------------------------------

-- The existing fiscal review remains the sole path to `verified`, now with an
-- explicit AAL2 boundary. User self-attestation above can only write pending.
create or replace function affiliate_private.admin_partners_fiscal_review(
  p_account_id uuid,
  p_status text,
  p_residence_country_code text,
  p_provider text,
  p_reference_hash text,
  p_tax_form_type text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_status text := lower(btrim(coalesce(p_status, '')));
  v_country text := upper(btrim(coalesce(p_residence_country_code, '')));
  v_provider text := nullif(lower(btrim(coalesce(p_provider, ''))), '');
  v_reference text := nullif(
    lower(btrim(coalesce(p_reference_hash, ''))),
    ''
  );
  v_form text := nullif(btrim(coalesce(p_tax_form_type, '')), '');
  v_justification text := btrim(coalesce(p_justification, ''));
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_profile affiliate_private.affiliate_fiscal_profiles%rowtype;
  v_actor text;
begin
  perform affiliate_private.partners_require_capability('support');
  perform affiliate_private.partners_require_capability('finance');
  perform affiliate_private.partners_require_aal2(
    'Partners fiscal review'
  );
  select account.*
  into v_account
  from affiliate_private.affiliate_accounts account
  where account.id = p_account_id
    and account.account_type = 'individual'
    and account.status <> 'closed'
  for update;
  if not found then
    raise exception 'Partner account is unavailable'
      using errcode = 'P0002';
  end if;
  if v_status not in ('verified', 'rejected', 'expired')
    or v_country <> v_account.country_code
    or (
      v_provider is not null
      and v_provider !~ '^[a-z0-9][a-z0-9._-]{1,63}$'
    )
    or (
      v_reference is not null
      and v_reference !~ '^[0-9a-f]{64}$'
    )
    or (
      v_status = 'verified'
      and (v_provider is null or v_reference is null)
    )
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid fiscal review'
      using errcode = '22023';
  end if;
  select profile.*
  into v_profile
  from affiliate_private.affiliate_fiscal_profiles profile
  where profile.account_id = v_account.id
  for update;
  if not found
    or v_profile.residence_country_code <> v_account.country_code
    or v_profile.declaration_version <>
      'partners-tax-self-certification-v1'
    or v_profile.self_attested_at is null
    or v_profile.status <> 'pending'
  then
    raise exception 'pending fiscal self-attestation is required'
      using errcode = 'P0001';
  end if;
  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  update affiliate_private.affiliate_fiscal_profiles profile
  set
    residence_country_code = v_country,
    status = v_status,
    verification_provider = v_provider,
    verification_reference_hash = v_reference,
    tax_form_type = v_form,
    reviewed_at = now(),
    updated_at = now()
  where profile.account_id = v_account.id;
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
    affiliate_private.partners_public_account_id(v_account),
    'fiscal_profile_reviewed',
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object('status', v_status)
  );
  return jsonb_build_object(
    'schema_version', 1,
    'action', 'fiscal_profile_reviewed',
    'status', v_status
  );
end;
$$;

-- Privacy-minimized fiscal work queue. Account UUIDs, user identifiers,
-- emails, provider references and tax form values never cross this boundary.
create or replace function
affiliate_private.admin_partners_fiscal_profiles(
  p_limit integer,
  p_offset integer,
  p_status text,
  p_search text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := coalesce(p_limit, 50);
  v_offset integer := coalesce(p_offset, 0);
  v_status text := lower(btrim(coalesce(p_status, 'pending')));
  v_search text := nullif(lower(btrim(coalesce(p_search, ''))), '');
  v_total bigint := 0;
  v_items jsonb := '[]'::jsonb;
begin
  perform affiliate_private.partners_require_capability('support');
  perform affiliate_private.partners_require_capability('finance');
  perform affiliate_private.partners_require_aal2(
    'Partners fiscal review queue'
  );
  if v_limit not between 1 and 100
    or v_offset not between 0 and 100000
    or v_status not in (
      'all', 'missing', 'pending', 'verified', 'rejected', 'expired'
    )
    or (
      v_search is not null
      and (
        length(v_search) > 64
        or v_search ~ '[[:cntrl:][:space:]]'
      )
    )
  then
    raise exception 'invalid fiscal review queue query'
      using errcode = '22023';
  end if;

  select count(*)
  into v_total
  from affiliate_private.affiliate_fiscal_profiles profile
  join affiliate_private.affiliate_accounts account
    on account.id = profile.account_id
  where (v_status = 'all' or profile.status = v_status)
    and account.account_type = 'individual'
    and account.status <> 'closed'
    and (
      v_search is null
      or affiliate_private.partners_public_account_id(account)
        like v_search || '%'
      or lower(account.country_code) = v_search
    );

  select coalesce(
    jsonb_agg(
      page.row_data
      order by page.priority_order, page.submitted_at desc nulls last,
        page.partner_key
    ),
    '[]'::jsonb
  )
  into v_items
  from (
    select
      case profile.status when 'pending' then 0 else 1 end as priority_order,
      profile.self_attested_at as submitted_at,
      affiliate_private.partners_public_account_id(account) as partner_key,
      jsonb_build_object(
        'partner_key',
          affiliate_private.partners_public_account_id(account),
        'country_code', account.country_code,
        'status', profile.status,
        'submitted_at', profile.self_attested_at,
        'reviewed_at', profile.reviewed_at
      ) as row_data
    from affiliate_private.affiliate_fiscal_profiles profile
    join affiliate_private.affiliate_accounts account
      on account.id = profile.account_id
    where (v_status = 'all' or profile.status = v_status)
      and account.account_type = 'individual'
      and account.status <> 'closed'
      and (
        v_search is null
        or affiliate_private.partners_public_account_id(account)
          like v_search || '%'
        or lower(account.country_code) = v_search
      )
    order by
      case profile.status when 'pending' then 0 else 1 end,
      profile.self_attested_at desc nulls last,
      affiliate_private.partners_public_account_id(account)
    limit v_limit
    offset v_offset
  ) page;

  return jsonb_build_object(
    'schema_version', 1,
    'total', v_total,
    'limit', v_limit,
    'offset', v_offset,
    'items', v_items
  );
end;
$$;

-- Finance reviews by the privacy-safe public partner key. The legacy UUID
-- entrypoint is retained internally for compatibility but is revoked from
-- authenticated callers below.
create or replace function
affiliate_private.admin_partners_fiscal_review_by_public_id(
  p_account_public_id text,
  p_status text,
  p_provider text,
  p_reference_hash text,
  p_tax_form_type text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_public_id text := lower(btrim(coalesce(p_account_public_id, '')));
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_result jsonb;
begin
  perform affiliate_private.partners_require_capability('support');
  perform affiliate_private.partners_require_capability('finance');
  perform affiliate_private.partners_require_aal2(
    'Partners fiscal review'
  );
  if v_public_id !~ '^prt_[0-9a-f]{24}$' then
    raise exception 'invalid Partner public id' using errcode = '22023';
  end if;
  select account.*
  into v_account
  from affiliate_private.affiliate_accounts account
  where affiliate_private.partners_public_account_id(account) = v_public_id
    and account.account_type = 'individual'
    and account.status <> 'closed';
  if not found then
    raise exception 'Partner account is unavailable'
      using errcode = 'P0002';
  end if;
  v_result := affiliate_private.admin_partners_fiscal_review(
    v_account.id,
    p_status,
    v_account.country_code,
    p_provider,
    p_reference_hash,
    p_tax_form_type,
    p_justification
  );
  return v_result || jsonb_build_object(
    'partner_key', v_public_id,
    'country_code', v_account.country_code
  );
end;
$$;

create or replace function
affiliate_private.admin_partners_detail_by_public_id(
  p_account_public_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_public_id text := lower(btrim(coalesce(p_account_public_id, '')));
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_program affiliate_private.affiliate_program_versions%rowtype;
  v_policy affiliate_private.affiliate_country_policies%rowtype;
  v_link affiliate_private.affiliate_links%rowtype;
  v_activity jsonb := '[]'::jsonb;
begin
  perform affiliate_private.partners_require_capability('finance');
  perform affiliate_private.partners_require_aal2(
    'Partners Finance account detail'
  );
  if v_public_id !~ '^prt_[0-9a-f]{24}$' then
    raise exception 'invalid Partner public id' using errcode = '22023';
  end if;
  select account.*
  into v_account
  from affiliate_private.affiliate_accounts account
  where affiliate_private.partners_public_account_id(account) = v_public_id;
  if not found then
    raise exception 'Partners account not found' using errcode = 'P0002';
  end if;
  select program.*
  into v_program
  from affiliate_private.affiliate_program_versions program
  where program.id = v_account.program_version_id;
  select policy.*
  into v_policy
  from affiliate_private.affiliate_country_policies policy
  where policy.id = v_account.country_policy_id;
  select link.*
  into v_link
  from affiliate_private.affiliate_links link
  where link.account_id = v_account.id
  order by
    case when link.status = 'active' then 0 else 1 end,
    link.created_at desc
  limit 1;
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'action', event.action,
        'actor_type', event.actor_type,
        'occurred_at', event.created_at
      )
      order by event.sequence_no desc
    ),
    '[]'::jsonb
  )
  into v_activity
  from (
    select source_event.*
    from affiliate_private.affiliate_events source_event
    where (
      source_event.aggregate_type = 'account'
      and source_event.aggregate_key = v_account.id::text
    ) or (
      source_event.aggregate_type = 'payout'
      and (
        source_event.aggregate_key = v_public_id
        or source_event.aggregate_key in (
          select request_row.request_key
          from affiliate_private.affiliate_payout_onboarding_requests request_row
          where request_row.account_id = v_account.id
        )
      )
    )
    order by source_event.sequence_no desc
    limit 50
  ) event;
  return jsonb_build_object(
    'schema_version', 1,
    'account', jsonb_build_object(
      'account_public_id', v_public_id,
      'partner_key', v_public_id,
      'account_type', v_account.account_type,
      'status', v_account.status,
      'country_code', v_account.country_code,
      'subdivision_code', v_account.subdivision_code,
      'verification_status', v_account.verification_status,
      'age_verified', v_account.age_verified,
      'capacity_verified', v_account.capacity_verified,
      'contract_status', v_account.contract_status,
      'terms_version_accepted', v_account.terms_version_accepted,
      'disclosure_version_accepted',
        v_account.disclosure_version_accepted,
      'created_at', v_account.created_at,
      'updated_at', v_account.updated_at,
      'closed_at', v_account.closed_at
    ),
    'program', case
      when v_program.id is null then null
      else jsonb_build_object(
        'version_key', v_program.version_key,
        'commission_rate_bps', v_program.commission_rate_bps,
        'attribution_window_days', v_program.attribution_window_days,
        'maturation_days', v_program.maturation_days,
        'status', v_program.status
      )
    end,
    'policy', case
      when v_policy.id is null then null
      else jsonb_build_object(
        'country_code', v_policy.country_code,
        'subdivision_code', v_policy.subdivision_code,
        'minimum_age', v_policy.minimum_age,
        'capacity_required', v_policy.capacity_required,
        'verification_level', v_policy.verification_level,
        'payout_currencies', v_policy.payout_currencies,
        'terms_version', v_policy.terms_version,
        'disclosure_version', v_policy.disclosure_version
      )
    end,
    'link', case
      when v_link.id is null then null
      else jsonb_build_object(
        'status', v_link.status,
        'code_preview',
          left(v_link.public_code, 4)
          || '...'
          || right(v_link.public_code, 4),
        'created_at', v_link.created_at,
        'revoked_at', v_link.revoked_at
      )
    end,
    'fiscal', (
      select jsonb_build_object(
        'country_code', profile.residence_country_code,
        'status', profile.status,
        'submitted_at', profile.self_attested_at,
        'reviewed_at', profile.reviewed_at
      )
      from affiliate_private.affiliate_fiscal_profiles profile
      where profile.account_id = v_account.id
    ),
    'activity', v_activity,
    'readiness', jsonb_build_object(
      'financial_ledger', true,
      'fraud_workbench', true,
      'payout_operations',
        affiliate_private.partners_payout_operations_ready(),
      'reason', affiliate_private.partners_payout_operations_reason()
    )
  );
end;
$$;

create or replace function
affiliate_private.admin_partners_payout_onboarding_requests(
  p_limit integer,
  p_offset integer,
  p_status text,
  p_search text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := coalesce(p_limit, 50);
  v_offset integer := coalesce(p_offset, 0);
  v_status text := lower(btrim(coalesce(p_status, 'all')));
  v_search text := nullif(lower(btrim(coalesce(p_search, ''))), '');
  v_total bigint := 0;
  v_items jsonb := '[]'::jsonb;
begin
  perform affiliate_private.partners_require_capability('finance');
  perform affiliate_private.partners_require_aal2(
    'Partners payout onboarding queue'
  );
  if v_limit not between 1 and 100
    or v_offset not between 0 and 100000
    or v_status not in (
      'all', 'pending', 'in_progress', 'rejected', 'completed'
    )
    or (
      v_search is not null
      and (
        length(v_search) > 64
        or v_search ~ '[[:cntrl:][:space:]]'
      )
    )
  then
    raise exception 'invalid payout onboarding queue query'
      using errcode = '22023';
  end if;

  select count(*)
  into v_total
  from affiliate_private.affiliate_payout_onboarding_requests request_row
  join affiliate_private.affiliate_accounts account
    on account.id = request_row.account_id
  where (v_status = 'all' or request_row.status = v_status)
    and not exists (
      select 1
      from affiliate_private.affiliate_payout_onboarding_requests newer
      where newer.account_id = request_row.account_id
        and newer.currency = request_row.currency
        and newer.revision > request_row.revision
    )
    and (
      v_search is null
      or request_row.request_key like v_search || '%'
      or affiliate_private.partners_public_account_id(account)
        like v_search || '%'
      or lower(request_row.currency) = v_search
      or lower(account.country_code) = v_search
    );

  select coalesce(
    jsonb_agg(row_data order by requested_at desc, request_key),
    '[]'::jsonb
  )
  into v_items
  from (
    select
      request_row.requested_at,
      request_row.request_key,
      jsonb_build_object(
        'request_key', request_row.request_key,
        'partner_key',
          affiliate_private.partners_public_account_id(account),
        'country_code', account.country_code,
        'currency', request_row.currency,
        'revision', request_row.revision,
        'execution_adapter', 'revolut_manual',
        'status', request_row.status,
        'reason_code', request_row.reason_code,
        'requested_at', request_row.requested_at,
        'updated_at', request_row.updated_at,
        'started_at', request_row.started_at,
        'rejected_at', request_row.rejected_at,
        'completed_at', request_row.completed_at,
        'binding_ready', exists (
          select 1
          from affiliate_private.affiliate_revolut_beneficiary_bindings binding
          where binding.account_id = request_row.account_id
            and binding.currency = request_row.currency
            and binding.status = 'active'
        ),
        'profile_ready', exists (
          select 1
          from affiliate_private.affiliate_payout_profiles profile
          join affiliate_private.affiliate_revolut_beneficiary_bindings binding
            on binding.id = profile.revolut_binding_id
            and binding.binding_version = profile.revolut_binding_version
            and binding.account_id = profile.account_id
            and binding.currency = profile.currency
            and binding.status = 'active'
          where profile.account_id = request_row.account_id
            and profile.currency = request_row.currency
            and profile.provider = 'revolut'
            and profile.status = 'active'
        ),
        'reconfiguration_required',
          affiliate_private
            .partners_payout_onboarding_reconfiguration_required(
              account,
              request_row
            )
      ) as row_data
    from affiliate_private.affiliate_payout_onboarding_requests request_row
    join affiliate_private.affiliate_accounts account
      on account.id = request_row.account_id
    where (v_status = 'all' or request_row.status = v_status)
      and not exists (
        select 1
        from affiliate_private.affiliate_payout_onboarding_requests newer
        where newer.account_id = request_row.account_id
          and newer.currency = request_row.currency
          and newer.revision > request_row.revision
      )
      and (
        v_search is null
        or request_row.request_key like v_search || '%'
        or affiliate_private.partners_public_account_id(account)
          like v_search || '%'
        or lower(request_row.currency) = v_search
        or lower(account.country_code) = v_search
      )
    order by request_row.requested_at desc, request_row.request_key
    limit v_limit
    offset v_offset
  ) page;

  return jsonb_build_object(
    'schema_version', 1,
    'total', v_total,
    'limit', v_limit,
    'offset', v_offset,
    'items', v_items
  );
end;
$$;

-- Authorize a beneficiary proposal from the public onboarding request key.
-- The browser never supplies an account UUID or currency. The signed mapping
-- payload substitutes the public request key for the internal account UUID.
create or replace function
affiliate_private.admin_partners_revolut_beneficiary_binding_authorize_by_request(
  p_request_key text,
  p_beneficiary_token_ref text,
  p_beneficiary_payment_method_ref text,
  p_display_masked text,
  p_fingerprint_key_version integer,
  p_mapping_evidence_hash text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_request_key text := lower(btrim(coalesce(p_request_key, '')));
  v_account_id uuid;
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_request affiliate_private.affiliate_payout_onboarding_requests%rowtype;
  v_authorization jsonb;
  v_attestation_payload text;
begin
  perform affiliate_private.partners_require_capability('finance');
  perform affiliate_private.partners_require_aal2(
    'Partners beneficiary binding authorization'
  );
  if v_request_key !~ '^por_[0-9a-f]{24}$' then
    raise exception 'invalid payout onboarding request key'
      using errcode = '22023';
  end if;

  -- Resolve an immutable relation without taking a row lock, then follow the
  -- global -> account -> request hierarchy used by every registry mutation.
  select request_row.account_id
  into v_account_id
  from affiliate_private.affiliate_payout_onboarding_requests request_row
  where request_row.request_key = v_request_key;
  if not found then
    raise exception 'payout onboarding request not found'
      using errcode = 'P0002';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:payout-approval-configuration',
      0
    )
  );
  select account.*
  into v_account
  from affiliate_private.affiliate_accounts account
  where account.id = v_account_id
    and account.account_type = 'individual'
    and account.status = 'active'
  for update;
  if not found then
    raise exception 'Partner account is unavailable'
      using errcode = 'P0002';
  end if;
  select request_row.*
  into v_request
  from affiliate_private.affiliate_payout_onboarding_requests request_row
  where request_row.request_key = v_request_key
    and request_row.account_id = v_account.id
    and request_row.status = 'in_progress'
    and request_row.contact_consent
    and request_row.execution_adapter = 'revolut_manual'
    and not exists (
      select 1
      from affiliate_private.affiliate_payout_onboarding_requests newer
      where newer.account_id = request_row.account_id
        and newer.currency = request_row.currency
        and newer.revision > request_row.revision
    )
  for update;
  if not found then
    raise exception 'an active payout onboarding review is required'
      using errcode = 'P0001';
  end if;
  if not (
    v_request.currency = any (
      affiliate_private.partners_payout_onboarding_allowed_currencies(
        v_account
      )
    )
  ) then
    raise exception 'payout onboarding eligibility is no longer valid'
      using errcode = 'P0001';
  end if;

  v_authorization :=
    affiliate_private.admin_partners_revolut_beneficiary_binding_authorize(
      v_account.id,
      v_request.currency,
      p_beneficiary_token_ref,
      p_beneficiary_payment_method_ref,
      p_display_masked,
      p_fingerprint_key_version,
      p_mapping_evidence_hash,
      p_justification
    );
  v_attestation_payload := replace(
    coalesce(v_authorization ->> 'attestation_payload', ''),
    'account_id=' || v_account.id::text,
    'request_key=' || v_request.request_key
  );
  if v_attestation_payload = ''
    or position(v_account.id::text in v_attestation_payload) > 0
  then
    raise exception 'beneficiary authorization response is unsafe'
      using errcode = 'P0004';
  end if;
  return jsonb_set(
    v_authorization,
    '{attestation_payload}',
    to_jsonb(v_attestation_payload),
    false
  ) || jsonb_build_object(
    'request_key', v_request.request_key,
    'partner_key',
      affiliate_private.partners_public_account_id(v_account),
    'currency', v_request.currency
  );
end;
$$;

-- Audited, idempotent support contact for a consented onboarding request.
-- The verified account email is resolved internally and never returned.
create or replace function
affiliate_private.admin_partners_payout_onboarding_contact(
  p_request_key text,
  p_template_key text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_request_key text := lower(btrim(coalesce(p_request_key, '')));
  v_template_key text := lower(btrim(coalesce(p_template_key, '')));
  v_body text;
  v_account_id uuid;
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_request affiliate_private.affiliate_payout_onboarding_requests%rowtype;
  v_recipient text;
  v_actor_email text := lower(btrim(coalesce(auth.jwt() ->> 'email', '')));
  v_actor text;
  v_ticket_id uuid;
  v_message_id uuid;
  v_contact_key text;
  v_subject text;
  v_html text;
  v_delivery_state text;
  v_existing record;
begin
  perform affiliate_private.partners_require_capability('support');
  perform affiliate_private.partners_require_capability('finance');
  perform affiliate_private.partners_require_aal2(
    'Partners payout onboarding contact'
  );
  if v_request_key !~ '^por_[0-9a-f]{24}$'
    or p_idempotency_key is null
    or v_template_key not in (
      'secure_setup_invitation',
      'setup_follow_up',
      'reconfiguration_required'
    )
  then
    raise exception 'invalid payout onboarding contact'
      using errcode = '22023';
  end if;
  v_body := case v_template_key
    when 'secure_setup_invitation' then
      'Norva Finance is ready to coordinate your payout setup. Open Partners in Norva to review this request. Reply only to confirm when you are available for the secure setup step. Never send bank details, tax identifiers, identity documents, passwords or authenticator codes by email.'
    when 'setup_follow_up' then
      'Your Norva payout setup is still waiting for the secure coordination step. Open Partners in Norva to review its status. Reply only to coordinate availability. Never send bank details, tax identifiers, identity documents, passwords or authenticator codes by email.'
    else
      'Your Norva payout destination must be configured again before future payouts. Open Partners in Norva to review the request. Reply only to coordinate availability for the secure setup step. Never send bank details, tax identifiers, identity documents, passwords or authenticator codes by email.'
  end;
  v_contact_key := 'poc_' || left(
    encode(
      extensions.digest(
        'norva:partners:payout-contact:v1:' || p_idempotency_key::text,
        'sha256'
      ),
      'hex'
    ),
    24
  );

  -- Resolve only the immutable relation before locking. Contact joins the same
  -- global -> account -> request hierarchy as Finance decisions, followed by
  -- request-key contact serialization and finally support idempotency. Thus two
  -- different idempotency keys for one request cannot both pass the per-request
  -- quota, while an exact replay is still checked before that quota.
  select request_row.account_id
  into v_account_id
  from affiliate_private.affiliate_payout_onboarding_requests request_row
  where request_row.request_key = v_request_key;
  if not found then
    raise exception 'payout onboarding request not found'
      using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:payout-approval-configuration',
      0
    )
  );
  select account.*
  into v_account
  from affiliate_private.affiliate_accounts account
  where account.id = v_account_id
  for share;
  if not found then
    raise exception 'Partner account is unavailable'
      using errcode = 'P0002';
  end if;
  select request_row.*
  into v_request
  from affiliate_private.affiliate_payout_onboarding_requests request_row
  where request_row.request_key = v_request_key
    and request_row.account_id = v_account.id
  for update;
  if not found then
    raise exception 'payout onboarding request not found'
      using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:payout-contact:' || v_request.request_key,
      0
    )
  );
  perform pg_advisory_xact_lock(
    hashtextextended('support-request:' || p_idempotency_key::text, 0)
  );

  select
    message.id as message_id,
    message.body,
    ticket.user_id,
    ticket.channel,
    ticket.subject,
    outbox.state as delivery_state
  into v_existing
  from public.cloud_support_messages message
  join public.cloud_support_tickets ticket on ticket.id = message.ticket_id
  left join public.cloud_support_email_outbox outbox
    on outbox.message_id = message.id
    and outbox.direction = 'support_to_user'
  where message.request_id = p_idempotency_key;
  if found then
    if v_existing.user_id is distinct from v_account.user_id
      or v_existing.channel <> 'partners_payout_onboarding'
      or v_existing.subject <> 'Norva payout setup - ' || v_request_key
      or v_existing.body <> v_body
    then
      raise exception 'payout onboarding contact idempotency conflict'
        using errcode = 'P0003';
    end if;
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'payout_onboarding_contact_sent',
      'changed', false,
      'contact_key', v_contact_key,
      'request_key', v_request_key,
      'partner_key', affiliate_private.partners_public_account_id(v_account),
      'template_key', v_template_key,
      'channel', 'verified_account_email',
      'delivery_state', coalesce(v_existing.delivery_state, 'unavailable')
    );
  end if;

  if v_account.account_type <> 'individual'
    or v_account.status = 'closed'
    or v_account.user_id is null
    or v_request.status not in ('pending', 'in_progress')
    or not v_request.contact_consent
    or v_request.execution_adapter <> 'revolut_manual'
    or exists (
      select 1
      from affiliate_private.affiliate_payout_onboarding_requests newer
      where newer.account_id = v_request.account_id
        and newer.currency = v_request.currency
        and newer.revision > v_request.revision
    )
  then
    raise exception 'an open consented payout onboarding request is required'
      using errcode = 'P0001';
  end if;
  select lower(btrim(users.email))
  into v_recipient
  from auth.users users
  where users.id = v_account.user_id
    and users.email_confirmed_at is not null;
  if v_recipient is null
    or v_recipient !~ '^[^@[:space:]]+@[^@[:space:]]+$'
  then
    raise exception 'verified account email is unavailable'
      using errcode = 'P0001';
  end if;
  if v_actor_email !~ '^[^@[:space:]]+@[^@[:space:]]+$' then
    v_actor_email := 'support@norva.tv';
  end if;
  v_actor := affiliate_private.partners_admin_actor_pseudonym();

  if exists (
    select 1
    from affiliate_private.affiliate_events event
    where event.aggregate_type = 'payout'
      and event.aggregate_key = v_request.request_key
      and event.action = 'payout_onboarding_contact_sent'
      and event.created_at >= clock_timestamp() - interval '60 seconds'
  ) or (
    select count(*)
    from affiliate_private.affiliate_events event
    where event.aggregate_type = 'payout'
      and event.aggregate_key = v_request.request_key
      and event.action = 'payout_onboarding_contact_sent'
      and event.created_at >= clock_timestamp() - interval '24 hours'
  ) >= 3 then
    raise exception 'payout onboarding contact rate limit exceeded'
      using errcode = 'P0008';
  end if;

  v_ticket_id := extensions.gen_random_uuid();
  v_message_id := extensions.gen_random_uuid();
  v_subject := 'Norva payout setup - ' || v_request.request_key;
  v_html := '<!doctype html><html><body style="font-family:Inter,Arial,sans-serif;background:#0b0d16;color:#f4f6ff;padding:32px">'
    || '<div style="max-width:640px;margin:auto;background:#121626;border:1px solid #27304a;border-radius:16px;padding:32px">'
    || '<h1 style="font-size:24px;margin:0 0 20px">Complete your Norva payout setup</h1>'
    || '<p style="line-height:1.6;color:#cbd3ea">'
    || replace(public.norva_html_escape(v_body), E'\n', '<br>')
    || '</p><p style="line-height:1.6;color:#8f9ab8">This email only coordinates the secure setup step. Never reply with bank details, tax identifiers, identity documents, passwords or authenticator codes.</p>'
    || '</div></body></html>';

  insert into public.cloud_support_tickets (
    id,
    user_id,
    subject,
    status,
    priority,
    channel,
    last_from,
    last_message_at,
    created_at,
    updated_at
  ) values (
    v_ticket_id,
    v_account.user_id,
    v_subject,
    'pending',
    'high',
    'partners_payout_onboarding',
    'admin',
    clock_timestamp(),
    clock_timestamp(),
    clock_timestamp()
  );
  insert into public.cloud_support_messages (
    id,
    ticket_id,
    from_admin,
    author_email,
    body,
    request_id,
    created_at
  ) values (
    v_message_id,
    v_ticket_id,
    true,
    v_actor_email,
    v_body,
    p_idempotency_key,
    clock_timestamp()
  );
  v_delivery_state := public.norva_freeze_support_email(
    p_idempotency_key,
    v_message_id,
    v_ticket_id,
    'support_to_user',
    v_recipient,
    'Norva Support <support@norva.tv>',
    'support@norva.tv',
    v_subject,
    v_html,
    v_body || E'\n\nThis email only coordinates the secure setup step. Never reply with bank details, tax identifiers, identity documents, passwords or authenticator codes.',
    jsonb_build_array(
      jsonb_build_object('name', 'app', 'value', 'norva'),
      jsonb_build_object('name', 'category', 'value', 'transactional'),
      jsonb_build_object('name', 'flow', 'value', 'support_agent_reply')
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
  ) values (
    'payout',
    v_request.request_key,
    'payout_onboarding_contact_sent',
    'admin',
    v_actor,
    'Finance contacted the partner through the verified account email channel.',
    jsonb_build_object(
      'contact_key', v_contact_key,
      'template_key', v_template_key,
      'channel', 'verified_account_email',
      'delivery_state', 'ready'
    )
  );
  return jsonb_build_object(
    'schema_version', 1,
    'action', 'payout_onboarding_contact_sent',
    'changed', true,
    'contact_key', v_contact_key,
    'request_key', v_request.request_key,
    'partner_key', affiliate_private.partners_public_account_id(v_account),
    'template_key', v_template_key,
    'channel', 'verified_account_email',
    'delivery_state', 'ready'
  );
end;
$$;

create or replace function
affiliate_private.admin_partners_payout_onboarding_request_decide(
  p_request_key text,
  p_action text,
  p_reason_code text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_request_key text := lower(btrim(coalesce(p_request_key, '')));
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_reason text := nullif(lower(btrim(coalesce(p_reason_code, ''))), '');
  v_justification text := btrim(coalesce(p_justification, ''));
  v_account_id uuid;
  v_request affiliate_private.affiliate_payout_onboarding_requests%rowtype;
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_program affiliate_private.affiliate_program_versions%rowtype;
  v_policy affiliate_private.affiliate_country_policies%rowtype;
  v_actor text;
  v_from_status text;
  v_target_status text;
  v_changed boolean := false;
begin
  perform affiliate_private.partners_require_capability('finance');
  perform affiliate_private.partners_require_aal2(
    'Partners payout onboarding decision'
  );
  if v_request_key !~ '^por_[0-9a-f]{24}$'
    or v_action not in ('start', 'reject', 'complete')
    or length(v_justification) not between 12 and 1000
    or v_justification ~ '[[:cntrl:]]'
    or (
      v_action = 'reject'
      and (
        v_reason is null
        or v_reason not in (
          'route_unavailable',
          'beneficiary_setup_required',
          'identity_mismatch',
          'unsupported_destination',
          'compliance_review',
          'duplicate_request'
        )
      )
    )
    or (v_action <> 'reject' and v_reason is not null)
  then
    raise exception 'invalid payout onboarding decision'
      using errcode = '22023';
  end if;

  -- Match the existing registry hierarchy: global -> account -> request.
  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:payout-approval-configuration',
      0
    )
  );

  -- Resolve the immutable account key first, then lock account -> request.
  -- Member requests use the same order, preventing an account/request cycle.
  select request_row.account_id
  into v_account_id
  from affiliate_private.affiliate_payout_onboarding_requests request_row
  where request_row.request_key = v_request_key;
  if not found then
    raise exception 'payout onboarding request not found'
      using errcode = 'P0002';
  end if;
  select account.*
  into v_account
  from affiliate_private.affiliate_accounts account
  where account.id = v_account_id
  for share;
  if not found then
    raise exception 'Partners account is unavailable'
      using errcode = 'P0002';
  end if;
  select request_row.*
  into v_request
  from affiliate_private.affiliate_payout_onboarding_requests request_row
  where request_row.request_key = v_request_key
    and request_row.account_id = v_account.id
  for update;
  if not found then
    raise exception 'payout onboarding request not found'
      using errcode = 'P0002';
  end if;

  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  v_from_status := v_request.status;
  v_target_status := case v_action
    when 'start' then 'in_progress'
    when 'reject' then 'rejected'
    else 'completed'
  end;

  if v_request.status = v_target_status and v_action <> 'complete' then
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'payout_onboarding_decided',
      'changed', false,
      'request_key', v_request.request_key,
      'partner_key', affiliate_private.partners_public_account_id(v_account),
      'status', v_request.status
    );
  end if;
  if (v_action = 'start' and v_request.status <> 'pending')
    or (
      v_action = 'reject'
      and v_request.status not in ('pending', 'in_progress')
    )
    or (
      v_action = 'complete'
      and v_request.status not in ('in_progress', 'completed')
    )
  then
    raise exception 'invalid payout onboarding status transition'
      using errcode = 'P0001';
  end if;

  if v_action = 'complete' then
    select program.*
    into v_program
    from affiliate_private.affiliate_program_versions program
    where program.id = v_account.program_version_id
    for share;
    select policy.*
    into v_policy
    from affiliate_private.affiliate_country_policies policy
    where policy.id = v_account.country_policy_id
    for share;
    if not affiliate_private.partners_payout_account_evidence_is_current(
      v_account,
      v_program,
      v_policy
    )
      or not (v_request.currency = any (v_policy.payout_currencies))
    then
      raise exception 'payout onboarding eligibility is no longer valid'
        using errcode = 'P0001';
    end if;

    perform 1
    from affiliate_private.affiliate_fiscal_profiles fiscal_profile
    where fiscal_profile.account_id = v_account.id
      and fiscal_profile.status = 'verified'
      and fiscal_profile.residence_country_code = v_account.country_code
      and fiscal_profile.declaration_version =
        'partners-tax-self-certification-v1'
      and fiscal_profile.self_attested_at is not null
      and fiscal_profile.reviewed_at is not null
      and fiscal_profile.verification_provider is not null
      and fiscal_profile.verification_reference_hash is not null
    for share;
    if not found then
      raise exception 'payout onboarding eligibility is no longer valid'
        using errcode = 'P0001';
    end if;

    perform 1
    from affiliate_private.affiliate_payout_provider_configs route
    join affiliate_private.affiliate_currency_metadata currency_meta
      on currency_meta.currency_code = route.currency
      and currency_meta.status = 'active'
    where route.provider = 'revolut'
      and route.execution_adapter = 'revolut_manual'
      and route.status = 'active'
      and route.country_code = v_account.country_code
      and route.currency = v_request.currency
    for share of route, currency_meta;
    if not found then
      raise exception 'payout onboarding eligibility is no longer valid'
        using errcode = 'P0001';
    end if;
  end if;

  if v_action = 'complete' then
    perform 1
    from affiliate_private.affiliate_payout_profiles profile
    join affiliate_private.affiliate_revolut_beneficiary_bindings binding
      on binding.id = profile.revolut_binding_id
      and binding.binding_version = profile.revolut_binding_version
      and binding.account_id = profile.account_id
      and binding.currency = profile.currency
      and binding.status = 'active'
    where profile.account_id = v_request.account_id
      and profile.currency = v_request.currency
      and profile.provider = 'revolut'
      and profile.status = 'active'
    for share of profile, binding;
    if not found then
      raise exception 'active verified Revolut binding and profile are required'
        using errcode = 'P0001';
    end if;
  end if;

  if v_request.status = v_target_status then
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'payout_onboarding_decided',
      'changed', false,
      'request_key', v_request.request_key,
      'partner_key', affiliate_private.partners_public_account_id(v_account),
      'status', v_request.status
    );
  end if;

  update affiliate_private.affiliate_payout_onboarding_requests request_row
  set
    status = v_target_status,
    reason_code = case when v_action = 'reject' then v_reason else null end,
    handled_by_pseudonym = case
      when v_action = 'start' then v_actor
      else coalesce(request_row.handled_by_pseudonym, v_actor)
    end,
    completed_by_pseudonym = case
      when v_action = 'complete' then v_actor
      else null
    end,
    started_at = case
      when v_action = 'start' then now()
      else coalesce(request_row.started_at, now())
    end,
    rejected_at = case when v_action = 'reject' then now() else null end,
    completed_at = case when v_action = 'complete' then now() else null end,
    updated_at = now()
  where request_row.id = v_request.id
  returning request_row.* into v_request;
  v_changed := true;

  insert into affiliate_private.affiliate_payout_onboarding_transitions (
    request_id,
    from_status,
    to_status,
    actor_type,
    actor_pseudonym,
    reason_code,
    justification
  )
  values (
    v_request.id,
    v_from_status,
    v_request.status,
    'admin',
    v_actor,
    v_request.reason_code,
    v_justification
  );
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
    'payout',
    v_request.request_key,
    'payout_onboarding_' || v_request.status,
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object('status', v_from_status),
    jsonb_build_object(
      'status', v_request.status,
      'reason_code', v_request.reason_code,
      'country_code', v_account.country_code,
      'currency', v_request.currency,
      'execution_adapter', 'revolut_manual'
    )
  );

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'payout_onboarding_decided',
    'changed', v_changed,
    'request_key', v_request.request_key,
    'partner_key', affiliate_private.partners_public_account_id(v_account),
    'status', v_request.status
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Public invoker shims and least-privilege grants
-- ---------------------------------------------------------------------------

create or replace function public.partners_service_fiscal_profile_get(
  p_user_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_fiscal_profile_get(p_user_id);
$$;

create or replace function
public.partners_service_fiscal_profile_self_attest(
  p_user_id uuid,
  p_country_code text,
  p_declaration_version text,
  p_declaration_accepted boolean,
  p_idempotency_key text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_fiscal_profile_self_attest(
    p_user_id,
    p_country_code,
    p_declaration_version,
    p_declaration_accepted,
    p_idempotency_key
  );
$$;

create or replace function public.partners_service_payout_onboarding_get(
  p_user_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_payout_onboarding_get(p_user_id);
$$;

create or replace function
public.partners_service_payout_onboarding_request(
  p_user_id uuid,
  p_currency text,
  p_contact_consent boolean,
  p_idempotency_key text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_payout_onboarding_request(
    p_user_id,
    p_currency,
    p_contact_consent,
    p_idempotency_key
  );
$$;

create or replace function public.admin_partners_payout_onboarding_requests(
  p_limit integer,
  p_offset integer,
  p_status text,
  p_search text
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select affiliate_private.admin_partners_payout_onboarding_requests(
    p_limit,
    p_offset,
    p_status,
    p_search
  );
$$;

create or replace function public.admin_partners_fiscal_profiles(
  p_limit integer,
  p_offset integer,
  p_status text,
  p_search text
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select affiliate_private.admin_partners_fiscal_profiles(
    p_limit,
    p_offset,
    p_status,
    p_search
  );
$$;

create or replace function
public.admin_partners_fiscal_review_by_public_id(
  p_account_public_id text,
  p_status text,
  p_provider text,
  p_reference_hash text,
  p_tax_form_type text,
  p_justification text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.admin_partners_fiscal_review_by_public_id(
    p_account_public_id,
    p_status,
    p_provider,
    p_reference_hash,
    p_tax_form_type,
    p_justification
  );
$$;

create or replace function
public.admin_partners_revolut_beneficiary_binding_authorize_by_request(
  p_request_key text,
  p_beneficiary_token_ref text,
  p_beneficiary_payment_method_ref text,
  p_display_masked text,
  p_fingerprint_key_version integer,
  p_mapping_evidence_hash text,
  p_justification text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private
    .admin_partners_revolut_beneficiary_binding_authorize_by_request(
      p_request_key,
      p_beneficiary_token_ref,
      p_beneficiary_payment_method_ref,
      p_display_masked,
      p_fingerprint_key_version,
      p_mapping_evidence_hash,
      p_justification
    );
$$;

create or replace function
public.admin_partners_payout_onboarding_contact(
  p_request_key text,
  p_template_key text,
  p_idempotency_key uuid
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.admin_partners_payout_onboarding_contact(
    p_request_key,
    p_template_key,
    p_idempotency_key
  );
$$;

create or replace function public.admin_partners_detail_by_public_id(
  p_account_public_id text
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select affiliate_private.admin_partners_detail_by_public_id(
    p_account_public_id
  );
$$;

create or replace function
public.admin_partners_payout_onboarding_request_decide(
  p_request_key text,
  p_action text,
  p_reason_code text,
  p_justification text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.admin_partners_payout_onboarding_request_decide(
    p_request_key,
    p_action,
    p_reason_code,
    p_justification
  );
$$;

revoke all on function affiliate_private.partners_fiscal_profile_state(
  affiliate_private.affiliate_fiscal_profiles
) from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_payout_onboarding_state(
    affiliate_private.affiliate_payout_onboarding_requests
  )
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_payout_account_evidence_is_current(
    affiliate_private.affiliate_accounts,
    affiliate_private.affiliate_program_versions,
    affiliate_private.affiliate_country_policies
  )
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_payout_onboarding_allowed_currencies(
    affiliate_private.affiliate_accounts
  )
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_payout_onboarding_reconfiguration_required(
    affiliate_private.affiliate_accounts,
    affiliate_private.affiliate_payout_onboarding_requests
  )
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_enforce_fiscal_onboarding_write_limit(text, uuid)
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.guard_payout_onboarding_request_transition()
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_service_fiscal_profile_get(uuid)
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_service_fiscal_profile_self_attest(
    uuid, text, text, boolean, text
  )
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_service_payout_onboarding_get(uuid)
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_service_payout_onboarding_request(
    uuid, text, boolean, text
  )
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.admin_partners_payout_onboarding_requests(
    integer, integer, text, text
  )
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.admin_partners_fiscal_profiles(
    integer, integer, text, text
  )
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.admin_partners_fiscal_review_by_public_id(
    text, text, text, text, text, text
  )
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.admin_partners_revolut_beneficiary_binding_authorize_by_request(
    text, text, text, text, integer, text, text
  )
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.admin_partners_payout_onboarding_contact(
    text, text, uuid
  )
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.admin_partners_detail_by_public_id(text)
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.admin_partners_payout_onboarding_request_decide(
    text, text, text, text
  )
from public, anon, authenticated, service_role;

grant execute on function
  affiliate_private.partners_service_fiscal_profile_get(uuid)
to service_role;
grant execute on function
  affiliate_private.partners_service_fiscal_profile_self_attest(
    uuid, text, text, boolean, text
  )
to service_role;
grant execute on function
  affiliate_private.partners_service_payout_onboarding_get(uuid)
to service_role;
grant execute on function
  affiliate_private.partners_service_payout_onboarding_request(
    uuid, text, boolean, text
  )
to service_role;
grant execute on function
  affiliate_private.admin_partners_payout_onboarding_requests(
    integer, integer, text, text
  )
to authenticated;
grant execute on function
  affiliate_private.admin_partners_fiscal_profiles(
    integer, integer, text, text
  )
to authenticated;
grant execute on function
  affiliate_private.admin_partners_fiscal_review_by_public_id(
    text, text, text, text, text, text
  )
to authenticated;
grant execute on function
  affiliate_private.admin_partners_revolut_beneficiary_binding_authorize_by_request(
    text, text, text, text, integer, text, text
  )
to authenticated;
grant execute on function
  affiliate_private.admin_partners_payout_onboarding_contact(
    text, text, uuid
  )
to authenticated;
grant execute on function
  affiliate_private.admin_partners_detail_by_public_id(text)
to authenticated;
grant execute on function
  affiliate_private.admin_partners_payout_onboarding_request_decide(
    text, text, text, text
  )
to authenticated;

revoke all on function public.partners_service_fiscal_profile_get(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.partners_service_fiscal_profile_get(uuid)
  to service_role;
revoke all on function
  public.partners_service_fiscal_profile_self_attest(
    uuid, text, text, boolean, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  public.partners_service_fiscal_profile_self_attest(
    uuid, text, text, boolean, text
  )
to service_role;
revoke all on function public.partners_service_payout_onboarding_get(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.partners_service_payout_onboarding_get(uuid)
  to service_role;
revoke all on function
  public.partners_service_payout_onboarding_request(
    uuid, text, boolean, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  public.partners_service_payout_onboarding_request(
    uuid, text, boolean, text
  )
to service_role;
revoke all on function public.admin_partners_payout_onboarding_requests(
  integer, integer, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.admin_partners_payout_onboarding_requests(
  integer, integer, text, text
) to authenticated;
revoke all on function public.admin_partners_fiscal_profiles(
  integer, integer, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.admin_partners_fiscal_profiles(
  integer, integer, text, text
) to authenticated;
revoke all on function
  public.admin_partners_fiscal_review_by_public_id(
    text, text, text, text, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  public.admin_partners_fiscal_review_by_public_id(
    text, text, text, text, text, text
  )
to authenticated;
revoke all on function
  public.admin_partners_revolut_beneficiary_binding_authorize_by_request(
    text, text, text, text, integer, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  public.admin_partners_revolut_beneficiary_binding_authorize_by_request(
    text, text, text, text, integer, text, text
  )
to authenticated;
revoke all on function
  public.admin_partners_payout_onboarding_contact(text, text, uuid)
from public, anon, authenticated, service_role;
grant execute on function
  public.admin_partners_payout_onboarding_contact(text, text, uuid)
to authenticated;
revoke all on function public.admin_partners_detail_by_public_id(text)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_partners_detail_by_public_id(text)
  to authenticated;
revoke all on function
  public.admin_partners_payout_onboarding_request_decide(
    text, text, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  public.admin_partners_payout_onboarding_request_decide(
    text, text, text, text
  )
to authenticated;

-- Close the two legacy UUID-bearing admin entrypoints. Their internal
-- implementations remain owner-callable by the public-key/request-key
-- wrappers above, but authenticated clients cannot invoke them directly.
revoke all on function
  affiliate_private.admin_partners_fiscal_review(
    uuid, text, text, text, text, text, text
  )
from public, anon, authenticated, service_role;
revoke all on function
  public.admin_partners_fiscal_review(
    uuid, text, text, text, text, text, text
  )
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.admin_partners_revolut_beneficiary_binding_authorize(
    uuid, text, text, text, text, integer, text, text
  )
from public, anon, authenticated, service_role;
revoke all on function
  public.admin_partners_revolut_beneficiary_binding_authorize(
    uuid, text, text, text, text, integer, text, text
  )
from public, anon, authenticated, service_role;

-- The member Edge is read-only for payout profiles. Beneficiary setup must
-- cross the audited Finance maker-checker registry, never this legacy setter.
revoke execute on function
  public.partners_service_payout_profile_set(
    uuid, text, text, text, text, text
  )
from service_role;

comment on table
  affiliate_private.affiliate_payout_onboarding_requests
is
  'Privacy-minimized manual Revolut onboarding state. Contains no IBAN, tax identifier, beneficiary token, name, email or destination mask.';
comment on table
  affiliate_private.affiliate_payout_onboarding_transitions
is
  'Append-only AAL2 Finance audit trail for payout onboarding state transitions.';

-- ---------------------------------------------------------------------------
-- Recoverable member activation after an asynchronous KYC result
-- ---------------------------------------------------------------------------

-- A signed KYC webhook may arrive while the master release flag is closed, an
-- invite has not yet been applied, or a policy/contract revision is in flight.
-- The webhook records the authoritative verification evidence, but it must not
-- be the only opportunity to activate the account. This state-based reconcile
-- is intrinsically idempotent: the account row is locked, the transition is
-- conditional on pending_verification, and the activation event is emitted
-- only by the transaction that actually performs that transition.

create or replace function affiliate_private.partners_next_action(
  p_account affiliate_private.affiliate_accounts
)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p_account.status in ('held', 'suspended', 'closed')
      then 'contact_support'
    when p_account.contract_status <> 'accepted'
      or p_account.contract_accepted_at is null
      or p_account.disclosure_accepted_at is null
      or exists (
        select 1
        from affiliate_private.affiliate_country_policies policy
        where policy.id = p_account.country_policy_id
          and (
            p_account.terms_version_accepted
              is distinct from policy.terms_version
            or p_account.disclosure_version_accepted
              is distinct from policy.disclosure_version
          )
      )
      then 'accept_terms'
    when p_account.verification_status = 'not_started'
      then 'start_verification'
    when p_account.verification_status = 'pending'
      then 'await_verification'
    when p_account.verification_status in ('failed', 'expired')
      then 'start_verification'
    when p_account.verification_status = 'verified'
      and (
        not p_account.age_verified
        or not exists (
          select 1
          from affiliate_private.affiliate_country_policies policy
          where policy.id = p_account.country_policy_id
            and p_account.verification_provider
              is not distinct from policy.verification_provider
            and (
              not policy.capacity_required
              or p_account.capacity_verified
            )
        )
      )
      then 'start_verification'
    when p_account.status <> 'active'
      then 'activate_account'
    else 'share_link'
  end;
$$;

create or replace function
affiliate_private.partners_service_activation_reconcile(
  p_user_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_program affiliate_private.affiliate_program_versions%rowtype;
  v_policy affiliate_private.affiliate_country_policies%rowtype;
  v_program_valid boolean := false;
  v_policy_valid boolean := false;
  v_evidence_valid boolean := false;
  v_email_confirmed boolean := false;
  v_partners_enabled boolean := false;
  v_invite_only boolean := true;
  v_allowlisted boolean := false;
  v_release_ready boolean := false;
  v_changed boolean := false;
begin
  if p_user_id is null then
    raise exception 'user id is required' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:user:' || p_user_id::text, 0)
  );

  select account.*
  into v_account
  from affiliate_private.affiliate_accounts account
  where account.user_id = p_user_id
    and account.status <> 'closed'
  for update;

  if not found then
    raise exception 'Partners account is unavailable'
      using errcode = 'P0001';
  end if;

  -- Terminal/operator-held states are safe no-ops. In particular, a delayed
  -- client retry can never reactivate an account that Risk or Support has
  -- held/suspended. Active accounts continue below so their current immutable
  -- program/policy/evidence contract is checked before returning share_link.
  if v_account.status not in ('pending_verification', 'active') then
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'activation_reconciled',
      'changed', false,
      'account', affiliate_private.partners_account_state(v_account),
      'next_action', affiliate_private.partners_next_action(v_account)
    );
  end if;

  select program.*
  into v_program
  from affiliate_private.affiliate_program_versions program
  where program.id = v_account.program_version_id
  for share;

  v_program_valid := found
    and v_program.status = 'active'
    and v_program.account_type = 'individual'
    and v_program.commission_rate_bps = 2000
    and v_program.attribution_window_days = 30
    and v_program.maturation_days = 45
    and v_program.effective_from is not null
    and v_program.effective_from <= now()
    and (
      v_program.effective_until is null
      or v_program.effective_until > now()
    );

  select policy.*
  into v_policy
  from affiliate_private.affiliate_country_policies policy
  where policy.id = v_account.country_policy_id
  for share;

  v_policy_valid := found
    and v_program_valid
    and v_policy.program_version_id = v_program.id
    and v_policy.country_code = v_account.country_code
    and (
      v_policy.subdivision_code is null
      or v_policy.subdivision_code is not distinct from
        v_account.subdivision_code
    )
    and v_policy.individual_available
    and v_policy.minimum_age between 18 and 99
    and v_policy.verification_level in (
      'identity_age_country',
      'identity_age_country_capacity'
    )
    and nullif(btrim(v_policy.verification_provider), '') is not null
    and (
      v_policy.effective_from is null
      or v_policy.effective_from <= now()
    )
    and (
      v_policy.effective_until is null
      or v_policy.effective_until > now()
    )
    and affiliate_private.payout_currencies_covered(
      v_program.payout_thresholds,
      v_policy.payout_currencies
    );

  v_evidence_valid := v_policy_valid
    and v_account.account_type = 'individual'
    and v_account.verification_status = 'verified'
    and v_account.verification_provider
      is not distinct from v_policy.verification_provider
    and nullif(btrim(v_account.verification_reference), '') is not null
    and v_account.age_verified
    and (
      not v_policy.capacity_required
      or v_account.capacity_verified
    )
    and v_account.contract_status = 'accepted'
    and v_account.terms_version_accepted
      is not distinct from v_policy.terms_version
    and v_account.disclosure_version_accepted
      is not distinct from v_policy.disclosure_version
    and v_account.contract_accepted_at is not null
    and v_account.disclosure_accepted_at is not null;

  select exists (
    select 1
    from auth.users user_row
    where user_row.id = p_user_id
      and user_row.email_confirmed_at is not null
  )
  into v_email_confirmed;

  select coalesce((
    select flag.enabled
    from public.admin_feature_flags flag
    where flag.key = 'partners_enabled'
  ), false)
  into v_partners_enabled;

  select coalesce((
    select flag.enabled
    from public.admin_feature_flags flag
    where flag.key = 'partners_invite_only'
  ), true)
  into v_invite_only;

  select exists (
    select 1
    from affiliate_private.affiliate_pilot_allowlist allowlist_row
    where allowlist_row.user_id = p_user_id
      and allowlist_row.status = 'active'
      and (
        allowlist_row.expires_at is null
        or allowlist_row.expires_at > now()
      )
      and (
        allowlist_row.country_code is null
        or allowlist_row.country_code = v_account.country_code
      )
      and (
        allowlist_row.subdivision_code is null
        or allowlist_row.subdivision_code = v_account.subdivision_code
      )
  )
  into v_allowlisted;

  v_release_ready := v_partners_enabled
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
    );

  -- Closing a launch gate does not retroactively suspend an already active
  -- account. However, an active account whose program, policy, KYC evidence,
  -- consent versions or confirmed-email invariant is no longer current must
  -- never receive a contradictory share_link response. Supported policy writes
  -- already prevent this drift; this branch is a fail-closed corruption/natural
  -- expiry backstop and deliberately requires an operator review.
  if v_account.status = 'active' then
    if not v_program_valid
      or not v_policy_valid
      or not v_evidence_valid
      or not v_email_confirmed
    then
      raise exception 'Partners account requires support'
        using errcode = 'P0001';
    end if;

    return jsonb_build_object(
      'schema_version', 1,
      'action', 'activation_reconciled',
      'changed', false,
      'account', affiliate_private.partners_account_state(v_account),
      'next_action', 'share_link'
    );
  end if;

  if v_evidence_valid and v_email_confirmed and v_release_ready then
    update affiliate_private.affiliate_accounts account
    set status = 'active', updated_at = now()
    where account.id = v_account.id
      and account.status = 'pending_verification'
    returning account.* into v_account;

    v_changed := found;

    if v_changed then
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
        'Verified account passed a fresh server-side activation reconcile.',
        jsonb_build_object('status', 'pending_verification'),
        jsonb_build_object('status', 'active')
      );
    end if;
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'activation_reconciled',
    'changed', v_changed,
    'account', affiliate_private.partners_account_state(v_account),
    'next_action', affiliate_private.partners_next_action(v_account)
  );
end;
$$;

create or replace function public.partners_service_activation_reconcile(
  p_user_id uuid
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_activation_reconcile(p_user_id);
$$;

revoke all on function
  affiliate_private.partners_service_activation_reconcile(uuid)
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_service_activation_reconcile(uuid)
to service_role;

revoke all on function public.partners_service_activation_reconcile(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.partners_service_activation_reconcile(uuid)
  to service_role;
