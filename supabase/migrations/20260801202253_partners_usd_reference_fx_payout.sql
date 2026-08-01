-- Norva Partners: USD commercial reference, exact local ledgers and
-- fail-closed FX/cost observations.
--
-- This migration does not convert, allocate or settle money. Existing payout
-- cycles remain exact-currency only. It adds the versioned reference contract
-- (10 USD), conservative integer reference valuation alongside authoritative
-- exact-settlement-currency eligibility, and
-- append-only evidence showing every payout/FX cost borne by Norva.

alter default privileges in schema affiliate_private
  revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- Program contract: USD is a reference, never an implicit ledger conversion.
-- ---------------------------------------------------------------------------

alter table affiliate_private.affiliate_program_versions
  add column threshold_reference_currency text,
  add column threshold_reference_minor bigint,
  add column payout_fee_policy text;

-- Fail closed instead of silently reinterpreting a published legacy programme.
-- Production has no programme rows at rollout time; any restored environment
-- with an incompatible row must version/remediate it explicitly first.
do $preflight$
begin
  if exists (
    select 1
    from affiliate_private.affiliate_program_versions program
    where not (program.payout_thresholds ? 'USD')
      or (program.payout_thresholds ->> 'USD')::numeric <> 1000
  ) then
    raise exception
      'legacy Partners programmes must explicitly define USD=1000 before migration'
      using errcode = '55000';
  end if;
end;
$preflight$;

update affiliate_private.affiliate_program_versions program
set
  threshold_reference_currency = 'USD',
  threshold_reference_minor = 1000,
  payout_fee_policy = 'platform_absorbed'
where program.threshold_reference_currency is null;

alter table affiliate_private.affiliate_program_versions
  alter column threshold_reference_currency set default 'USD',
  alter column threshold_reference_currency set not null,
  alter column threshold_reference_minor set default 1000,
  alter column threshold_reference_minor set not null,
  alter column payout_fee_policy set default 'platform_absorbed',
  alter column payout_fee_policy set not null;

alter table affiliate_private.affiliate_program_versions
  add constraint affiliate_program_versions_threshold_reference_currency
    check (threshold_reference_currency = 'USD') not valid,
  add constraint affiliate_program_versions_threshold_reference_minor
    check (threshold_reference_minor = 1000) not valid,
  add constraint affiliate_program_versions_threshold_reference_exact
    check (
      payout_thresholds ? 'USD'
      and (payout_thresholds ->> 'USD')::numeric = 1000
    ) not valid,
  add constraint affiliate_program_versions_payout_fee_policy
    check (payout_fee_policy = 'platform_absorbed') not valid;

alter table affiliate_private.affiliate_program_versions
  validate constraint affiliate_program_versions_threshold_reference_currency;
alter table affiliate_private.affiliate_program_versions
  validate constraint affiliate_program_versions_threshold_reference_minor;
alter table affiliate_private.affiliate_program_versions
  validate constraint affiliate_program_versions_threshold_reference_exact;
alter table affiliate_private.affiliate_program_versions
  validate constraint affiliate_program_versions_payout_fee_policy;

comment on column
  affiliate_private.affiliate_program_versions.threshold_reference_currency
is
  'Commercial threshold reference only. Ledger, payout profile, cycle and settlement currencies remain authoritative and exact.';
comment on column
  affiliate_private.affiliate_program_versions.threshold_reference_minor
is
  'Reference threshold in minor units. Norva P0 uses 1000 USD cents; every other enabled payout currency keeps an exact frozen threshold in payout_thresholds.';
comment on column
  affiliate_private.affiliate_program_versions.payout_fee_policy
is
  'Payout transfer and FX costs are platform expenses and never reduce partner principal.';

-- Keep the existing RPC signature so Web/Admin clients remain compatible. New
-- drafts must carry the agreed USD 10 reference and the platform fee policy.
create or replace function affiliate_private.admin_partners_program_create(
  p_version_key text,
  p_payout_thresholds jsonb,
  p_terms_version text,
  p_disclosure_version text,
  p_effective_from timestamptz,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := lower(btrim(coalesce(p_version_key, '')));
  v_terms text := lower(btrim(coalesce(p_terms_version, '')));
  v_disclosure text := lower(btrim(coalesce(p_disclosure_version, '')));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_actor text;
begin
  perform affiliate_private.partners_require_capability('support');
  perform affiliate_private.partners_require_capability('finance');
  if v_key !~ '^[a-z0-9][a-z0-9._-]{2,63}$'
    or v_terms !~ '^[a-z0-9][a-z0-9._-]{2,63}$'
    or v_disclosure !~ '^[a-z0-9][a-z0-9._-]{2,63}$'
    or not affiliate_private.valid_payout_thresholds(p_payout_thresholds)
    or not (p_payout_thresholds ? 'USD')
    or (p_payout_thresholds ->> 'USD')::numeric <> 1000
    or p_effective_from is null
    or p_effective_from < now() - interval '5 minutes'
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid Partners program draft'
      using errcode = '22023';
  end if;
  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  insert into affiliate_private.affiliate_program_versions (
    version_key,
    status,
    commission_rate_bps,
    attribution_window_days,
    maturation_days,
    payout_thresholds,
    threshold_reference_currency,
    threshold_reference_minor,
    payout_fee_policy,
    terms_version,
    disclosure_version,
    effective_from
  )
  values (
    v_key,
    'draft',
    2000,
    30,
    45,
    p_payout_thresholds,
    'USD',
    1000,
    'platform_absorbed',
    v_terms,
    v_disclosure,
    p_effective_from
  );
  insert into affiliate_private.affiliate_events (
    aggregate_type, aggregate_key, action, actor_type,
    actor_pseudonym, justification, after_state
  )
  values (
    'program_version',
    v_key,
    'program_draft_created',
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object(
      'status', 'draft',
      'commission_rate_bps', 2000,
      'attribution_window_days', 30,
      'maturation_days', 45,
      'threshold_reference_currency', 'USD',
      'threshold_reference_minor', 1000,
      'payout_fee_policy', 'platform_absorbed'
    )
  );
  return jsonb_build_object(
    'schema_version', 1,
    'action', 'program_draft_created',
    'program', jsonb_build_object(
      'version_key', v_key,
      'status', 'draft',
      'threshold_reference_currency', 'USD',
      'threshold_reference_minor', 1000,
      'payout_fee_policy', 'platform_absorbed'
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Append-only FX, eligibility and payout-cost evidence.
-- ---------------------------------------------------------------------------

create table affiliate_private.affiliate_fx_rate_snapshots (
  id                      uuid primary key default gen_random_uuid(),
  snapshot_key            text not null unique default (
    'fxr_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  source_currency         text not null,
  source_exponent         integer not null,
  source_units_minor      bigint not null,
  target_currency         text not null,
  target_exponent         integer not null,
  target_units_minor      bigint not null,
  rate_source             text not null,
  observed_at             timestamptz not null,
  valid_until             timestamptz not null,
  evidence_sha256         text not null,
  idempotency_key         text not null unique,
  payload_sha256          text not null,
  recorded_by_pseudonym   text not null,
  justification           text not null,
  created_at              timestamptz not null default now(),
  constraint affiliate_fx_rate_snapshots_key
    check (snapshot_key ~ '^fxr_[0-9a-f]{24}$'),
  constraint affiliate_fx_rate_snapshots_currencies
    check (
      source_currency ~ '^[A-Z]{3}$'
      and target_currency ~ '^[A-Z]{3}$'
      and source_currency <> target_currency
    ),
  constraint affiliate_fx_rate_snapshots_exponents
    check (
      source_exponent between 0 and 6
      and target_exponent between 0 and 6
    ),
  constraint affiliate_fx_rate_snapshots_units
    check (
      source_units_minor between 1 and 9007199254740991
      and target_units_minor between 1 and 9007199254740991
    ),
  constraint affiliate_fx_rate_snapshots_source
    check (rate_source in ('ecb_reference', 'revolut_quote', 'finance_manual')),
  constraint affiliate_fx_rate_snapshots_window
    check (
      valid_until > observed_at
      and valid_until <= observed_at + interval '7 days'
    ),
  constraint affiliate_fx_rate_snapshots_hashes
    check (
      evidence_sha256 ~ '^[0-9a-f]{64}$'
      and payload_sha256 ~ '^[0-9a-f]{64}$'
    ),
  constraint affiliate_fx_rate_snapshots_idempotency
    check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  constraint affiliate_fx_rate_snapshots_actor
    check (recorded_by_pseudonym ~ '^[0-9a-f]{64}$'),
  constraint affiliate_fx_rate_snapshots_justification
    check (length(btrim(justification)) between 12 and 1000)
);

create index affiliate_fx_rate_snapshots_lookup_idx
  on affiliate_private.affiliate_fx_rate_snapshots (
    source_currency,
    target_currency,
    observed_at desc
  );

create table affiliate_private.affiliate_payout_eligibility_snapshots (
  id                        uuid primary key default gen_random_uuid(),
  snapshot_key              text not null unique default (
    'pel_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  account_id                uuid not null
    references affiliate_private.affiliate_accounts(id)
    on delete restrict,
  program_version_id        uuid not null
    references affiliate_private.affiliate_program_versions(id)
    on delete restrict,
  balance_currency          text not null,
  balance_exponent          integer not null,
  balance_minor             bigint not null,
  reference_currency        text not null,
  reference_exponent        integer not null,
  reference_value_minor     bigint not null,
  reference_threshold_minor bigint not null,
  settlement_threshold_minor bigint not null,
  eligible                  boolean not null,
  fx_rate_snapshot_id       uuid
    references affiliate_private.affiliate_fx_rate_snapshots(id)
    on delete restrict,
  posting_count             bigint not null,
  last_posting_at           timestamptz,
  idempotency_key           text not null unique,
  payload_sha256            text not null,
  observed_at               timestamptz not null,
  recorded_by_pseudonym     text not null,
  justification             text not null,
  created_at                timestamptz not null default now(),
  constraint affiliate_payout_eligibility_snapshots_key
    check (snapshot_key ~ '^pel_[0-9a-f]{24}$'),
  constraint affiliate_payout_eligibility_snapshots_currencies
    check (
      balance_currency ~ '^[A-Z]{3}$'
      and reference_currency ~ '^[A-Z]{3}$'
    ),
  constraint affiliate_payout_eligibility_snapshots_exponents
    check (
      balance_exponent between 0 and 6
      and reference_exponent between 0 and 6
    ),
  constraint affiliate_payout_eligibility_snapshots_amounts
    check (
      balance_minor between 0 and 9007199254740991
      and reference_value_minor between 0 and 9007199254740991
      and reference_threshold_minor between 1 and 9007199254740991
      and settlement_threshold_minor between 1 and 9007199254740991
      and posting_count between 0 and 9007199254740991
    ),
  constraint affiliate_payout_eligibility_snapshots_result
    check (eligible = (balance_minor >= settlement_threshold_minor)),
  constraint affiliate_payout_eligibility_snapshots_rate
    check (
      (balance_currency = reference_currency and fx_rate_snapshot_id is null)
      or
      (balance_currency <> reference_currency and fx_rate_snapshot_id is not null)
    ),
  constraint affiliate_payout_eligibility_snapshots_idempotency
    check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  constraint affiliate_payout_eligibility_snapshots_hash
    check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  constraint affiliate_payout_eligibility_snapshots_actor
    check (recorded_by_pseudonym ~ '^[0-9a-f]{64}$'),
  constraint affiliate_payout_eligibility_snapshots_justification
    check (length(btrim(justification)) between 12 and 1000)
);

create index affiliate_payout_eligibility_account_idx
  on affiliate_private.affiliate_payout_eligibility_snapshots (
    account_id,
    balance_currency,
    observed_at desc
  );

create table affiliate_private.affiliate_payout_cost_facts (
  id                      uuid primary key default gen_random_uuid(),
  fact_key                text not null unique default (
    'pcf_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  provider                text not null,
  execution_adapter       text not null,
  country_code            text not null,
  payout_currency         text not null,
  payout_exponent         integer not null,
  principal_minor         bigint not null,
  cost_kind               text not null,
  cost_currency           text not null,
  cost_exponent           integer not null,
  cost_minor              bigint not null,
  borne_by                text not null default 'platform',
  payout_item_id          uuid
    references affiliate_private.affiliate_payout_items(id)
    on delete restrict,
  fx_rate_snapshot_id     uuid
    references affiliate_private.affiliate_fx_rate_snapshots(id)
    on delete restrict,
  evidence_sha256         text not null,
  idempotency_key         text not null unique,
  payload_sha256          text not null,
  observed_at             timestamptz not null,
  recorded_by_pseudonym   text not null,
  justification           text not null,
  created_at              timestamptz not null default now(),
  constraint affiliate_payout_cost_facts_key
    check (fact_key ~ '^pcf_[0-9a-f]{24}$'),
  constraint affiliate_payout_cost_facts_route
    check (
      provider = 'revolut'
      and execution_adapter in ('revolut_manual', 'revolut_api')
      and country_code ~ '^[A-Z]{2}$'
    ),
  constraint affiliate_payout_cost_facts_currencies
    check (
      payout_currency ~ '^[A-Z]{3}$'
      and cost_currency ~ '^[A-Z]{3}$'
      and payout_exponent between 0 and 6
      and cost_exponent between 0 and 6
    ),
  constraint affiliate_payout_cost_facts_amounts
    check (
      principal_minor between 1 and 9007199254740991
      and cost_minor between 0 and 9007199254740991
    ),
  constraint affiliate_payout_cost_facts_kind
    check (
      cost_kind in (
        'transfer_fee',
        'fx_fee',
        'correspondent_fee',
        'fx_spread'
      )
    ),
  constraint affiliate_payout_cost_facts_platform_only
    check (borne_by = 'platform'),
  constraint affiliate_payout_cost_facts_hashes
    check (
      evidence_sha256 ~ '^[0-9a-f]{64}$'
      and payload_sha256 ~ '^[0-9a-f]{64}$'
    ),
  constraint affiliate_payout_cost_facts_idempotency
    check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  constraint affiliate_payout_cost_facts_actor
    check (recorded_by_pseudonym ~ '^[0-9a-f]{64}$'),
  constraint affiliate_payout_cost_facts_justification
    check (length(btrim(justification)) between 12 and 1000)
);

create index affiliate_payout_cost_facts_route_idx
  on affiliate_private.affiliate_payout_cost_facts (
    provider,
    country_code,
    payout_currency,
    observed_at desc
  );

alter table affiliate_private.affiliate_fx_rate_snapshots
  enable row level security;
alter table affiliate_private.affiliate_payout_eligibility_snapshots
  enable row level security;
alter table affiliate_private.affiliate_payout_cost_facts
  enable row level security;

revoke all on table
  affiliate_private.affiliate_fx_rate_snapshots,
  affiliate_private.affiliate_payout_eligibility_snapshots,
  affiliate_private.affiliate_payout_cost_facts
from public, anon, authenticated, service_role;

create trigger affiliate_fx_rate_snapshots_append_only
before update or delete
on affiliate_private.affiliate_fx_rate_snapshots
for each row execute function
  affiliate_private.reject_partners_finance_mutation();

create trigger affiliate_payout_eligibility_snapshots_append_only
before update or delete
on affiliate_private.affiliate_payout_eligibility_snapshots
for each row execute function
  affiliate_private.reject_partners_finance_mutation();

create trigger affiliate_payout_cost_facts_append_only
before update or delete
on affiliate_private.affiliate_payout_cost_facts
for each row execute function
  affiliate_private.reject_partners_finance_mutation();

-- A minor-unit exponent is part of every immutable money fact. Status can be
-- changed, but reinterpreting an existing ISO currency row would silently
-- rewrite programme thresholds, ledger entries and recorded FX evidence.
create or replace function
affiliate_private.guard_affiliate_currency_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.currency_code is distinct from old.currency_code
    or new.exponent is distinct from old.exponent
  then
    raise exception
      'currency code and minor-unit exponent are immutable; add a new versioned currency contract'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger affiliate_currency_metadata_identity_immutable
before update of currency_code, exponent
on affiliate_private.affiliate_currency_metadata
for each row execute function
  affiliate_private.guard_affiliate_currency_identity();

create or replace function affiliate_private.partners_fx_value_floor(
  p_source_amount_minor bigint,
  p_source_units_minor bigint,
  p_target_units_minor bigint
)
returns bigint
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  v_result numeric;
begin
  if p_source_amount_minor is null
    or p_source_amount_minor < 0
    or p_source_amount_minor > 9007199254740991
    or p_source_units_minor is null
    or p_source_units_minor < 1
    or p_source_units_minor > 9007199254740991
    or p_target_units_minor is null
    or p_target_units_minor < 1
    or p_target_units_minor > 9007199254740991
  then
    raise exception 'invalid exact-money FX valuation input'
      using errcode = '22023';
  end if;
  v_result := floor(
    p_source_amount_minor::numeric
      * p_target_units_minor::numeric
      / p_source_units_minor::numeric
  );
  if v_result > 9007199254740991 then
    raise exception 'exact-money FX valuation exceeds safe range'
      using errcode = '22003';
  end if;
  return v_result::bigint;
end;
$$;

-- ---------------------------------------------------------------------------
-- AAL2 Finance recording RPCs. These record evidence only; no RPC below can
-- create a payout, move ledger balances or call Revolut.
-- ---------------------------------------------------------------------------

create or replace function affiliate_private.admin_partners_fx_rate_record(
  p_source_currency text,
  p_source_units_minor bigint,
  p_target_currency text,
  p_target_units_minor bigint,
  p_rate_source text,
  p_observed_at timestamptz,
  p_valid_until timestamptz,
  p_evidence_sha256 text,
  p_idempotency_key text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_source text := upper(btrim(coalesce(p_source_currency, '')));
  v_target text := upper(btrim(coalesce(p_target_currency, '')));
  v_rate_source text := lower(btrim(coalesce(p_rate_source, '')));
  v_evidence text := lower(btrim(coalesce(p_evidence_sha256, '')));
  v_idempotency text := btrim(coalesce(p_idempotency_key, ''));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_source_exponent integer;
  v_target_exponent integer;
  v_actor text;
  v_payload jsonb;
  v_payload_sha256 text;
  v_existing affiliate_private.affiliate_fx_rate_snapshots%rowtype;
  v_inserted affiliate_private.affiliate_fx_rate_snapshots%rowtype;
begin
  perform affiliate_private.partners_require_capability('finance');
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'FX evidence requires AAL2'
      using errcode = '42501';
  end if;
  if v_source !~ '^[A-Z]{3}$'
    or v_target !~ '^[A-Z]{3}$'
    or v_source = v_target
    or p_source_units_minor is null
    or p_source_units_minor not between 1 and 9007199254740991
    or p_target_units_minor is null
    or p_target_units_minor not between 1 and 9007199254740991
    or v_rate_source not in (
      'ecb_reference', 'revolut_quote', 'finance_manual'
    )
    or p_observed_at is null
    or p_observed_at > now() + interval '5 minutes'
    or p_valid_until is null
    or p_valid_until <= p_observed_at
    or p_valid_until > p_observed_at + interval '7 days'
    or v_evidence !~ '^[0-9a-f]{64}$'
    or v_idempotency !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid FX evidence'
      using errcode = '22023';
  end if;

  select metadata.exponent
  into v_source_exponent
  from affiliate_private.affiliate_currency_metadata metadata
  where metadata.currency_code = v_source
    and metadata.status = 'active';
  if not found then
    raise exception 'source currency metadata is unavailable'
      using errcode = 'P0001';
  end if;
  select metadata.exponent
  into v_target_exponent
  from affiliate_private.affiliate_currency_metadata metadata
  where metadata.currency_code = v_target
    and metadata.status = 'active';
  if not found then
    raise exception 'target currency metadata is unavailable'
      using errcode = 'P0001';
  end if;

  v_payload := jsonb_build_object(
    'source_currency', v_source,
    'source_exponent', v_source_exponent,
    'source_units_minor', p_source_units_minor,
    'target_currency', v_target,
    'target_exponent', v_target_exponent,
    'target_units_minor', p_target_units_minor,
    'rate_source', v_rate_source,
    'observed_at', p_observed_at,
    'valid_until', p_valid_until,
    'evidence_sha256', v_evidence
  );
  v_payload_sha256 := encode(
    extensions.digest(convert_to(v_payload::text, 'UTF8'), 'sha256'),
    'hex'
  );
  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:fx-rate:' || v_idempotency, 0)
  );
  select snapshot.*
  into v_existing
  from affiliate_private.affiliate_fx_rate_snapshots snapshot
  where snapshot.idempotency_key = v_idempotency;
  if found then
    if v_existing.payload_sha256 <> v_payload_sha256 then
      raise exception 'FX evidence idempotency conflict'
        using errcode = 'P0003';
    end if;
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'fx_rate_recorded',
      'replayed', true,
      'snapshot', jsonb_build_object(
        'key', v_existing.snapshot_key,
        'source_currency', v_existing.source_currency,
        'target_currency', v_existing.target_currency,
        'valid_until', v_existing.valid_until
      )
    );
  end if;

  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  insert into affiliate_private.affiliate_fx_rate_snapshots (
    source_currency,
    source_exponent,
    source_units_minor,
    target_currency,
    target_exponent,
    target_units_minor,
    rate_source,
    observed_at,
    valid_until,
    evidence_sha256,
    idempotency_key,
    payload_sha256,
    recorded_by_pseudonym,
    justification
  )
  values (
    v_source,
    v_source_exponent,
    p_source_units_minor,
    v_target,
    v_target_exponent,
    p_target_units_minor,
    v_rate_source,
    p_observed_at,
    p_valid_until,
    v_evidence,
    v_idempotency,
    v_payload_sha256,
    v_actor,
    v_justification
  )
  returning * into v_inserted;

  insert into affiliate_private.affiliate_events (
    aggregate_type, aggregate_key, action, actor_type,
    actor_pseudonym, justification, after_state
  )
  values (
    'payout',
    v_inserted.snapshot_key,
    'fx_rate_recorded',
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object(
      'source_currency', v_source,
      'target_currency', v_target,
      'rate_source', v_rate_source,
      'observed_at', p_observed_at,
      'valid_until', p_valid_until
    )
  );
  return jsonb_build_object(
    'schema_version', 1,
    'action', 'fx_rate_recorded',
    'replayed', false,
    'snapshot', jsonb_build_object(
      'key', v_inserted.snapshot_key,
      'source_currency', v_source,
      'target_currency', v_target,
      'valid_until', p_valid_until
    )
  );
end;
$$;

create or replace function
affiliate_private.admin_partners_payout_eligibility_record(
  p_account_id uuid,
  p_balance_currency text,
  p_fx_rate_snapshot_key text,
  p_observed_at timestamptz,
  p_idempotency_key text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_currency text := upper(btrim(coalesce(p_balance_currency, '')));
  v_rate_key text := nullif(
    lower(btrim(coalesce(p_fx_rate_snapshot_key, ''))),
    ''
  );
  v_idempotency text := btrim(coalesce(p_idempotency_key, ''));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_program affiliate_private.affiliate_program_versions%rowtype;
  v_rate affiliate_private.affiliate_fx_rate_snapshots%rowtype;
  v_balance_exponent integer;
  v_reference_exponent integer;
  v_balance_minor bigint;
  v_posting_count bigint;
  v_exponent_mismatch_count bigint;
  v_last_posting_at timestamptz;
  v_reference_value bigint;
  v_settlement_threshold_minor bigint;
  v_actor text;
  v_payload jsonb;
  v_payload_sha256 text;
  v_existing affiliate_private.affiliate_payout_eligibility_snapshots%rowtype;
  v_inserted affiliate_private.affiliate_payout_eligibility_snapshots%rowtype;
begin
  perform affiliate_private.partners_require_capability('finance');
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'payout eligibility evidence requires AAL2'
      using errcode = '42501';
  end if;
  if p_account_id is null
    or v_currency !~ '^[A-Z]{3}$'
    or (v_rate_key is not null and v_rate_key !~ '^fxr_[0-9a-f]{24}$')
    or p_observed_at is null
    or p_observed_at > now() + interval '5 minutes'
    or v_idempotency !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid payout eligibility evidence'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:payout-eligibility:' || v_idempotency,
      0
    )
  );
  select snapshot.*
  into v_existing
  from affiliate_private.affiliate_payout_eligibility_snapshots snapshot
  where snapshot.idempotency_key = v_idempotency;
  if found then
    if v_existing.account_id is distinct from p_account_id
      or v_existing.balance_currency is distinct from v_currency
      or v_existing.observed_at is distinct from p_observed_at
      or coalesce(v_rate_key, '') is distinct from coalesce(
        (
          select rate.snapshot_key
          from affiliate_private.affiliate_fx_rate_snapshots rate
          where rate.id = v_existing.fx_rate_snapshot_id
        ),
        ''
      )
    then
      raise exception 'payout eligibility idempotency conflict'
        using errcode = 'P0003';
    end if;
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'payout_eligibility_recorded',
      'replayed', true,
      'snapshot', jsonb_build_object(
        'key', v_existing.snapshot_key,
        'eligible', v_existing.eligible,
        'reference_value_minor', v_existing.reference_value_minor,
        'reference_threshold_minor',
          v_existing.reference_threshold_minor,
        'settlement_threshold_minor',
          v_existing.settlement_threshold_minor
      )
    );
  end if;

  if p_observed_at < now() - interval '5 minutes' then
    raise exception 'new payout eligibility evidence must be current'
      using errcode = '22023';
  end if;

  select account.*
  into v_account
  from affiliate_private.affiliate_accounts account
  where account.id = p_account_id;
  if not found then
    raise exception 'Partners account is unavailable'
      using errcode = 'P0002';
  end if;

  select program.*
  into v_program
  from affiliate_private.affiliate_program_versions program
  where program.id = v_account.program_version_id;
  if not found then
    raise exception 'Partners program is unavailable'
      using errcode = 'P0002';
  end if;

  select metadata.exponent
  into v_balance_exponent
  from affiliate_private.affiliate_currency_metadata metadata
  where metadata.currency_code = v_currency
    and metadata.status = 'active';
  if not found then
    raise exception 'balance currency metadata is unavailable'
      using errcode = 'P0001';
  end if;
  select metadata.exponent
  into v_reference_exponent
  from affiliate_private.affiliate_currency_metadata metadata
  where metadata.currency_code = v_program.threshold_reference_currency
    and metadata.status = 'active';
  if not found then
    raise exception 'reference currency metadata is unavailable'
      using errcode = 'P0001';
  end if;

  if not (v_program.payout_thresholds ? v_currency) then
    raise exception 'settlement currency threshold is unavailable'
      using errcode = 'P0001';
  end if;
  v_settlement_threshold_minor :=
    (v_program.payout_thresholds ->> v_currency)::bigint;

  select
    greatest(
      coalesce(sum(case
        when posting.ledger_account = 'partner_commission_available'
          and posting.direction = 'credit'
          then posting.amount_minor
        when posting.ledger_account = 'partner_commission_available'
          and posting.direction = 'debit'
          then -posting.amount_minor
        else 0
      end), 0)
      - greatest(coalesce(sum(case
        when posting.ledger_account = 'partner_recovery_due'
          and posting.direction = 'debit'
          then posting.amount_minor
        when posting.ledger_account = 'partner_recovery_due'
          and posting.direction = 'credit'
          then -posting.amount_minor
        else 0
      end), 0), 0),
      0
    )::bigint,
    count(posting.id)::bigint,
    count(posting.id) filter (
      where entry.currency_exponent is distinct from v_balance_exponent
    )::bigint,
    max(posting.created_at)
  into
    v_balance_minor,
    v_posting_count,
    v_exponent_mismatch_count,
    v_last_posting_at
  from affiliate_private.affiliate_commission_postings posting
  join affiliate_private.affiliate_commission_entries entry
    on entry.id = posting.entry_id
  where entry.account_id = p_account_id
    and posting.currency = v_currency
    and posting.ledger_account in (
      'partner_commission_available',
      'partner_recovery_due'
    )
    and posting.created_at <= p_observed_at;

  if v_exponent_mismatch_count <> 0 then
    raise exception 'ledger currency exponent conflicts with currency metadata'
      using errcode = 'P0003';
  end if;

  if v_currency = v_program.threshold_reference_currency then
    if v_rate_key is not null then
      raise exception 'same-currency eligibility cannot use an FX rate'
        using errcode = '22023';
    end if;
    v_reference_value := v_balance_minor;
  else
    if v_rate_key is null then
      raise exception 'cross-currency eligibility requires exact FX evidence'
        using errcode = 'P0001';
    end if;
    select rate.*
    into v_rate
    from affiliate_private.affiliate_fx_rate_snapshots rate
    where rate.snapshot_key = v_rate_key
      and rate.source_currency = v_currency
      and rate.target_currency = v_program.threshold_reference_currency
      and rate.source_exponent = v_balance_exponent
      and rate.target_exponent = v_reference_exponent
      and rate.observed_at <= p_observed_at
      and rate.valid_until >= p_observed_at;
    if not found then
      raise exception 'FX evidence is unavailable or stale'
        using errcode = 'P0001';
    end if;
    v_reference_value := affiliate_private.partners_fx_value_floor(
      v_balance_minor,
      v_rate.source_units_minor,
      v_rate.target_units_minor
    );
  end if;

  v_payload := jsonb_build_object(
    'account_id', p_account_id,
    'program_version_id', v_program.id,
    'balance_currency', v_currency,
    'balance_exponent', v_balance_exponent,
    'balance_minor', v_balance_minor,
    'reference_currency', v_program.threshold_reference_currency,
    'reference_exponent', v_reference_exponent,
    'reference_value_minor', v_reference_value,
    'reference_threshold_minor', v_program.threshold_reference_minor,
    'settlement_threshold_minor', v_settlement_threshold_minor,
    'fx_rate_snapshot_id', v_rate.id,
    'posting_count', v_posting_count,
    'last_posting_at', v_last_posting_at,
    'observed_at', p_observed_at
  );
  v_payload_sha256 := encode(
    extensions.digest(convert_to(v_payload::text, 'UTF8'), 'sha256'),
    'hex'
  );

  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  insert into affiliate_private.affiliate_payout_eligibility_snapshots (
    account_id,
    program_version_id,
    balance_currency,
    balance_exponent,
    balance_minor,
    reference_currency,
    reference_exponent,
    reference_value_minor,
    reference_threshold_minor,
    settlement_threshold_minor,
    eligible,
    fx_rate_snapshot_id,
    posting_count,
    last_posting_at,
    idempotency_key,
    payload_sha256,
    observed_at,
    recorded_by_pseudonym,
    justification
  )
  values (
    p_account_id,
    v_program.id,
    v_currency,
    v_balance_exponent,
    v_balance_minor,
    v_program.threshold_reference_currency,
    v_reference_exponent,
    v_reference_value,
    v_program.threshold_reference_minor,
    v_settlement_threshold_minor,
    v_balance_minor >= v_settlement_threshold_minor,
    v_rate.id,
    v_posting_count,
    v_last_posting_at,
    v_idempotency,
    v_payload_sha256,
    p_observed_at,
    v_actor,
    v_justification
  )
  returning * into v_inserted;

  insert into affiliate_private.affiliate_events (
    aggregate_type, aggregate_key, action, actor_type,
    actor_pseudonym, justification, after_state
  )
  values (
    'payout',
    v_inserted.snapshot_key,
    'payout_eligibility_recorded',
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object(
      'account_pseudonym', v_account.user_pseudonym,
      'balance_currency', v_currency,
      'settlement_threshold_minor', v_settlement_threshold_minor,
      'reference_currency', v_program.threshold_reference_currency,
      'eligible', v_inserted.eligible,
      'observed_at', p_observed_at
    )
  );
  return jsonb_build_object(
    'schema_version', 1,
    'action', 'payout_eligibility_recorded',
    'replayed', false,
    'snapshot', jsonb_build_object(
      'key', v_inserted.snapshot_key,
      'eligible', v_inserted.eligible,
      'reference_value_minor', v_inserted.reference_value_minor,
      'reference_threshold_minor', v_inserted.reference_threshold_minor,
      'settlement_threshold_minor',
        v_inserted.settlement_threshold_minor
    )
  );
end;
$$;

create or replace function affiliate_private.admin_partners_payout_cost_record(
  p_provider text,
  p_execution_adapter text,
  p_country_code text,
  p_payout_currency text,
  p_principal_minor bigint,
  p_cost_kind text,
  p_cost_currency text,
  p_cost_minor bigint,
  p_payout_item_id uuid,
  p_fx_rate_snapshot_key text,
  p_evidence_sha256 text,
  p_observed_at timestamptz,
  p_idempotency_key text,
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
  v_adapter text := lower(btrim(coalesce(p_execution_adapter, '')));
  v_country text := upper(btrim(coalesce(p_country_code, '')));
  v_payout_currency text := upper(btrim(coalesce(p_payout_currency, '')));
  v_cost_kind text := lower(btrim(coalesce(p_cost_kind, '')));
  v_cost_currency text := upper(btrim(coalesce(p_cost_currency, '')));
  v_rate_key text := nullif(
    lower(btrim(coalesce(p_fx_rate_snapshot_key, ''))),
    ''
  );
  v_evidence text := lower(btrim(coalesce(p_evidence_sha256, '')));
  v_idempotency text := btrim(coalesce(p_idempotency_key, ''));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_payout_exponent integer;
  v_cost_exponent integer;
  v_rate affiliate_private.affiliate_fx_rate_snapshots%rowtype;
  v_actor text;
  v_payload jsonb;
  v_payload_sha256 text;
  v_existing affiliate_private.affiliate_payout_cost_facts%rowtype;
  v_inserted affiliate_private.affiliate_payout_cost_facts%rowtype;
begin
  perform affiliate_private.partners_require_capability('finance');
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'payout cost evidence requires AAL2'
      using errcode = '42501';
  end if;
  if v_provider <> 'revolut'
    or v_adapter not in ('revolut_manual', 'revolut_api')
    or v_country !~ '^[A-Z]{2}$'
    or v_payout_currency !~ '^[A-Z]{3}$'
    or p_principal_minor is null
    or p_principal_minor not between 1 and 9007199254740991
    or v_cost_kind not in (
      'transfer_fee', 'fx_fee', 'correspondent_fee', 'fx_spread'
    )
    or v_cost_currency !~ '^[A-Z]{3}$'
    or p_cost_minor is null
    or p_cost_minor not between 0 and 9007199254740991
    or (v_rate_key is not null and v_rate_key !~ '^fxr_[0-9a-f]{24}$')
    or v_evidence !~ '^[0-9a-f]{64}$'
    or p_observed_at is null
    or p_observed_at > now() + interval '5 minutes'
    or v_idempotency !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid payout cost evidence'
      using errcode = '22023';
  end if;

  select metadata.exponent
  into v_payout_exponent
  from affiliate_private.affiliate_currency_metadata metadata
  where metadata.currency_code = v_payout_currency
    and metadata.status = 'active';
  if not found then
    raise exception 'payout currency metadata is unavailable'
      using errcode = 'P0001';
  end if;
  select metadata.exponent
  into v_cost_exponent
  from affiliate_private.affiliate_currency_metadata metadata
  where metadata.currency_code = v_cost_currency
    and metadata.status = 'active';
  if not found then
    raise exception 'cost currency metadata is unavailable'
      using errcode = 'P0001';
  end if;

  if v_rate_key is not null then
    select rate.*
    into v_rate
    from affiliate_private.affiliate_fx_rate_snapshots rate
    where rate.snapshot_key = v_rate_key
      and rate.source_currency = v_payout_currency
      and rate.target_currency = v_cost_currency
      and rate.source_exponent = v_payout_exponent
      and rate.target_exponent = v_cost_exponent
      and rate.observed_at <= p_observed_at
      and rate.valid_until >= p_observed_at;
    if not found then
      raise exception 'FX evidence is unavailable, stale or mismatched'
        using errcode = 'P0001';
    end if;
  end if;
  if v_cost_kind in ('fx_fee', 'fx_spread')
    and (
      v_rate_key is null
      or v_payout_currency = v_cost_currency
    )
  then
    raise exception 'FX payout costs require exact FX evidence'
      using errcode = 'P0001';
  end if;

  if p_payout_item_id is not null and not exists (
    select 1
    from affiliate_private.affiliate_payout_items item
    join affiliate_private.affiliate_payout_cycles cycle
      on cycle.id = item.cycle_id
    join affiliate_private.affiliate_accounts account
      on account.id = item.account_id
    where item.id = p_payout_item_id
      and item.currency = v_payout_currency
      and item.amount_minor = p_principal_minor
      and account.country_code = v_country
  ) then
    raise exception 'payout item does not match the cost fact'
      using errcode = 'P0003';
  end if;

  v_payload := jsonb_build_object(
    'provider', v_provider,
    'execution_adapter', v_adapter,
    'country_code', v_country,
    'payout_currency', v_payout_currency,
    'payout_exponent', v_payout_exponent,
    'principal_minor', p_principal_minor,
    'cost_kind', v_cost_kind,
    'cost_currency', v_cost_currency,
    'cost_exponent', v_cost_exponent,
    'cost_minor', p_cost_minor,
    'borne_by', 'platform',
    'payout_item_id', p_payout_item_id,
    'fx_rate_snapshot_id', v_rate.id,
    'evidence_sha256', v_evidence,
    'observed_at', p_observed_at
  );
  v_payload_sha256 := encode(
    extensions.digest(convert_to(v_payload::text, 'UTF8'), 'sha256'),
    'hex'
  );
  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:payout-cost:' || v_idempotency, 0)
  );
  select fact.*
  into v_existing
  from affiliate_private.affiliate_payout_cost_facts fact
  where fact.idempotency_key = v_idempotency;
  if found then
    if v_existing.payload_sha256 <> v_payload_sha256 then
      raise exception 'payout cost idempotency conflict'
        using errcode = 'P0003';
    end if;
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'payout_cost_recorded',
      'replayed', true,
      'cost', jsonb_build_object(
        'key', v_existing.fact_key,
        'kind', v_existing.cost_kind,
        'currency', v_existing.cost_currency,
        'amount_minor', v_existing.cost_minor,
        'borne_by', v_existing.borne_by
      )
    );
  end if;

  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  insert into affiliate_private.affiliate_payout_cost_facts (
    provider,
    execution_adapter,
    country_code,
    payout_currency,
    payout_exponent,
    principal_minor,
    cost_kind,
    cost_currency,
    cost_exponent,
    cost_minor,
    borne_by,
    payout_item_id,
    fx_rate_snapshot_id,
    evidence_sha256,
    idempotency_key,
    payload_sha256,
    observed_at,
    recorded_by_pseudonym,
    justification
  )
  values (
    v_provider,
    v_adapter,
    v_country,
    v_payout_currency,
    v_payout_exponent,
    p_principal_minor,
    v_cost_kind,
    v_cost_currency,
    v_cost_exponent,
    p_cost_minor,
    'platform',
    p_payout_item_id,
    v_rate.id,
    v_evidence,
    v_idempotency,
    v_payload_sha256,
    p_observed_at,
    v_actor,
    v_justification
  )
  returning * into v_inserted;

  insert into affiliate_private.affiliate_events (
    aggregate_type, aggregate_key, action, actor_type,
    actor_pseudonym, justification, after_state
  )
  values (
    'payout',
    v_inserted.fact_key,
    'payout_cost_recorded',
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object(
      'provider', v_provider,
      'execution_adapter', v_adapter,
      'country_code', v_country,
      'payout_currency', v_payout_currency,
      'cost_kind', v_cost_kind,
      'cost_currency', v_cost_currency,
      'cost_minor', p_cost_minor,
      'borne_by', 'platform',
      'observed_at', p_observed_at
    )
  );
  return jsonb_build_object(
    'schema_version', 1,
    'action', 'payout_cost_recorded',
    'replayed', false,
    'cost', jsonb_build_object(
      'key', v_inserted.fact_key,
      'kind', v_cost_kind,
      'currency', v_cost_currency,
      'amount_minor', p_cost_minor,
      'borne_by', 'platform'
    )
  );
end;
$$;

-- Public wrappers expose only AAL2/capability-checked functions. The tables
-- remain private and have no PostgREST policy.
create or replace function public.admin_partners_fx_rate_record(
  p_source_currency text,
  p_source_units_minor bigint,
  p_target_currency text,
  p_target_units_minor bigint,
  p_rate_source text,
  p_observed_at timestamptz,
  p_valid_until timestamptz,
  p_evidence_sha256 text,
  p_idempotency_key text,
  p_justification text
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select affiliate_private.admin_partners_fx_rate_record(
    p_source_currency,
    p_source_units_minor,
    p_target_currency,
    p_target_units_minor,
    p_rate_source,
    p_observed_at,
    p_valid_until,
    p_evidence_sha256,
    p_idempotency_key,
    p_justification
  );
$$;

create or replace function public.admin_partners_payout_eligibility_record(
  p_account_id uuid,
  p_balance_currency text,
  p_fx_rate_snapshot_key text,
  p_observed_at timestamptz,
  p_idempotency_key text,
  p_justification text
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select affiliate_private.admin_partners_payout_eligibility_record(
    p_account_id,
    p_balance_currency,
    p_fx_rate_snapshot_key,
    p_observed_at,
    p_idempotency_key,
    p_justification
  );
$$;

create or replace function public.admin_partners_payout_cost_record(
  p_provider text,
  p_execution_adapter text,
  p_country_code text,
  p_payout_currency text,
  p_principal_minor bigint,
  p_cost_kind text,
  p_cost_currency text,
  p_cost_minor bigint,
  p_payout_item_id uuid,
  p_fx_rate_snapshot_key text,
  p_evidence_sha256 text,
  p_observed_at timestamptz,
  p_idempotency_key text,
  p_justification text
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select affiliate_private.admin_partners_payout_cost_record(
    p_provider,
    p_execution_adapter,
    p_country_code,
    p_payout_currency,
    p_principal_minor,
    p_cost_kind,
    p_cost_currency,
    p_cost_minor,
    p_payout_item_id,
    p_fx_rate_snapshot_key,
    p_evidence_sha256,
    p_observed_at,
    p_idempotency_key,
    p_justification
  );
$$;

revoke all on function
  affiliate_private.guard_affiliate_currency_identity(),
  affiliate_private.partners_fx_value_floor(bigint,bigint,bigint),
  affiliate_private.admin_partners_fx_rate_record(
    text,bigint,text,bigint,text,timestamptz,timestamptz,text,text,text
  ),
  affiliate_private.admin_partners_payout_eligibility_record(
    uuid,text,text,timestamptz,text,text
  ),
  affiliate_private.admin_partners_payout_cost_record(
    text,text,text,text,bigint,text,text,bigint,uuid,text,text,
    timestamptz,text,text
  )
from public, anon, authenticated, service_role;

revoke all on function
  public.admin_partners_fx_rate_record(
    text,bigint,text,bigint,text,timestamptz,timestamptz,text,text,text
  ),
  public.admin_partners_payout_eligibility_record(
    uuid,text,text,timestamptz,text,text
  ),
  public.admin_partners_payout_cost_record(
    text,text,text,text,bigint,text,text,bigint,uuid,text,text,
    timestamptz,text,text
  )
from public, anon, authenticated, service_role;

grant execute on function
  public.admin_partners_fx_rate_record(
    text,bigint,text,bigint,text,timestamptz,timestamptz,text,text,text
  ),
  public.admin_partners_payout_eligibility_record(
    uuid,text,text,timestamptz,text,text
  ),
  public.admin_partners_payout_cost_record(
    text,text,text,text,bigint,text,text,bigint,uuid,text,text,
    timestamptz,text,text
  )
to authenticated;

comment on table affiliate_private.affiliate_fx_rate_snapshots is
  'Append-only exact rational FX evidence for threshold valuation; never authority to convert or move ledger money.';
comment on table affiliate_private.affiliate_payout_eligibility_snapshots is
  'Append-only authoritative exact-settlement-threshold eligibility with a separate informational USD reference valuation.';
comment on table affiliate_private.affiliate_payout_cost_facts is
  'Append-only payout and FX costs borne by Norva; partner principal is never reduced by these facts.';
