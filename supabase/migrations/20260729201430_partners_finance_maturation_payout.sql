-- Norva Partners P0 phase 2: immutable billing facts, double-entry
-- commissions, J+45 maturation, shadow reconciliation and individual payout
-- control plane. Currency metadata and payout providers intentionally start
-- empty: no tax, exponent, beneficiary or jurisdiction value is guessed.

create table affiliate_private.affiliate_currency_metadata (
  currency_code            text primary key,
  exponent                 integer not null,
  status                   text not null default 'disabled',
  configured_by_pseudonym  text not null,
  justification            text not null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint affiliate_currency_metadata_code
    check (currency_code ~ '^[A-Z]{3}$'),
  constraint affiliate_currency_metadata_exponent
    check (exponent between 0 and 6),
  constraint affiliate_currency_metadata_status
    check (status in ('active', 'disabled')),
  constraint affiliate_currency_metadata_actor
    check (configured_by_pseudonym ~ '^[0-9a-f]{64}$'),
  constraint affiliate_currency_metadata_justification
    check (length(btrim(justification)) between 12 and 1000),
  unique (currency_code, exponent)
);

create table affiliate_private.affiliate_financial_facts (
  id                       uuid primary key default gen_random_uuid(),
  fact_key                 text not null unique default (
    'fac_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  transaction_hash         text not null,
  parent_transaction_hash  text,
  referred_user_id         uuid not null
    references auth.users(id)
    on delete restrict,
  attribution_id           uuid
    references affiliate_private.affiliate_attributions(id)
    on delete restrict,
  rail                     text not null,
  event_type               text not null,
  environment              text not null,
  facts_status             text not null,
  currency                 text,
  currency_exponent        integer,
  gross_minor              bigint,
  discount_minor           bigint,
  tax_minor                bigint,
  eligible_minor           bigint,
  occurred_at              timestamptz not null,
  created_at               timestamptz not null default now(),
  constraint affiliate_financial_facts_key
    check (fact_key ~ '^fac_[0-9a-f]{24}$'),
  constraint affiliate_financial_facts_hashes
    check (
      transaction_hash ~ '^[0-9a-f]{64}$'
      and (
        parent_transaction_hash is null
        or parent_transaction_hash ~ '^[0-9a-f]{64}$'
      )
    ),
  constraint affiliate_financial_facts_rail
    check (rail in ('web', 'google_play', 'revenuecat')),
  constraint affiliate_financial_facts_event
    check (
      event_type in (
        'capture',
        'renewal',
        'refund',
        'chargeback',
        'transfer'
      )
    ),
  constraint affiliate_financial_facts_environment
    check (environment in ('production', 'sandbox')),
  constraint affiliate_financial_facts_status
    check (facts_status in ('complete', 'incomplete', 'quarantined')),
  constraint affiliate_financial_facts_currency
    check (currency is null or currency ~ '^[A-Z]{3}$'),
  constraint affiliate_financial_facts_exponent
    check (
      currency_exponent is null
      or currency_exponent between 0 and 6
    ),
  constraint affiliate_financial_facts_amounts
    check (
      (gross_minor is null or gross_minor between 0 and 9007199254740991)
      and (
        discount_minor is null
        or discount_minor between 0 and 9007199254740991
      )
      and (tax_minor is null or tax_minor between 0 and 9007199254740991)
      and (
        eligible_minor is null
        or eligible_minor between 0 and 9007199254740991
      )
    ),
  constraint affiliate_financial_facts_complete
    check (
      facts_status <> 'complete'
      or (
        event_type <> 'transfer'
        and currency is not null
        and currency_exponent is not null
        and gross_minor is not null
        and tax_minor is not null
        and eligible_minor is not null
        and tax_minor <= gross_minor
        and eligible_minor = gross_minor - tax_minor
      )
    ),
  constraint affiliate_financial_facts_parent
    check (
      (
        event_type in ('capture', 'renewal')
        and parent_transaction_hash is null
      )
      or (
        event_type in ('refund', 'chargeback')
        and parent_transaction_hash is not null
      )
      or event_type = 'transfer'
    ),
  unique (environment, rail, event_type, transaction_hash)
);

create index affiliate_financial_facts_user_idx
  on affiliate_private.affiliate_financial_facts (
    referred_user_id,
    occurred_at desc
  );
create index affiliate_financial_facts_attribution_idx
  on affiliate_private.affiliate_financial_facts (
    attribution_id,
    occurred_at desc
  )
  where attribution_id is not null;
create index affiliate_financial_facts_parent_idx
  on affiliate_private.affiliate_financial_facts (
    environment,
    rail,
    parent_transaction_hash
  )
  where parent_transaction_hash is not null;
create index affiliate_financial_facts_status_idx
  on affiliate_private.affiliate_financial_facts (
    facts_status,
    occurred_at
  );

create table affiliate_private.affiliate_financial_fact_observations (
  id                 uuid primary key default gen_random_uuid(),
  fact_id            uuid not null
    references affiliate_private.affiliate_financial_facts(id)
    on delete restrict,
  source_event_hash  text not null unique,
  payload_hash       text not null,
  observed_at        timestamptz not null,
  created_at         timestamptz not null default now(),
  constraint affiliate_financial_fact_observations_hashes
    check (
      source_event_hash ~ '^[0-9a-f]{64}$'
      and payload_hash ~ '^[0-9a-f]{64}$'
    ),
  constraint affiliate_financial_fact_observations_clock
    check (observed_at <= created_at + interval '5 minutes')
);

create index affiliate_financial_fact_observations_fact_idx
  on affiliate_private.affiliate_financial_fact_observations (
    fact_id,
    observed_at desc
  );

create table affiliate_private.affiliate_financial_fact_conflicts (
  id                  uuid primary key default gen_random_uuid(),
  conflict_key        text not null unique default (
    'con_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  fact_id             uuid not null
    references affiliate_private.affiliate_financial_facts(id)
    on delete restrict,
  source_event_hash   text not null unique,
  payload_hash        text not null,
  mismatched_fields   text[] not null,
  observed_at         timestamptz not null,
  created_at          timestamptz not null default now(),
  constraint affiliate_financial_fact_conflicts_key
    check (conflict_key ~ '^con_[0-9a-f]{24}$'),
  constraint affiliate_financial_fact_conflicts_hashes
    check (
      source_event_hash ~ '^[0-9a-f]{64}$'
      and payload_hash ~ '^[0-9a-f]{64}$'
    ),
  constraint affiliate_financial_fact_conflicts_fields
    check (
      cardinality(mismatched_fields) between 1 and 8
      and mismatched_fields <@ array[
        'parent_transaction',
        'referred_user',
        'currency',
        'currency_exponent',
        'gross',
        'discount',
        'tax',
        'eligible'
      ]::text[]
    ),
  constraint affiliate_financial_fact_conflicts_clock
    check (observed_at <= created_at + interval '5 minutes')
);

create index affiliate_financial_fact_conflicts_fact_idx
  on affiliate_private.affiliate_financial_fact_conflicts (
    fact_id,
    created_at desc
  );

create table affiliate_private.affiliate_financial_fact_lineage_links (
  child_fact_id   uuid primary key
    references affiliate_private.affiliate_financial_facts(id)
    on delete restrict,
  parent_fact_id  uuid not null
    references affiliate_private.affiliate_financial_facts(id)
    on delete restrict,
  attribution_id  uuid not null
    references affiliate_private.affiliate_attributions(id)
    on delete restrict,
  created_at      timestamptz not null default now(),
  constraint affiliate_financial_fact_lineage_not_self
    check (child_fact_id <> parent_fact_id)
);

create index affiliate_financial_fact_lineage_parent_idx
  on affiliate_private.affiliate_financial_fact_lineage_links (
    parent_fact_id
  );

create table affiliate_private.affiliate_commission_jobs (
  id                uuid primary key default gen_random_uuid(),
  job_key           text not null unique default (
    'job_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  fact_id           uuid not null unique
    references affiliate_private.affiliate_financial_facts(id)
    on delete restrict,
  job_kind          text not null,
  status            text not null default 'pending',
  worker_id         text,
  lease_token_hash  text,
  leased_until      timestamptz,
  attempts          integer not null default 0,
  next_attempt_at   timestamptz not null default now(),
  last_error_code   text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  completed_at      timestamptz,
  constraint affiliate_commission_jobs_key
    check (job_key ~ '^job_[0-9a-f]{24}$'),
  constraint affiliate_commission_jobs_kind
    check (job_kind in ('accrual', 'reversal')),
  constraint affiliate_commission_jobs_status
    check (
      status in ('pending', 'leased', 'retry', 'succeeded', 'dead_letter')
    ),
  constraint affiliate_commission_jobs_worker
    check (
      worker_id is null
      or worker_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$'
    ),
  constraint affiliate_commission_jobs_lease_hash
    check (
      lease_token_hash is null
      or lease_token_hash ~ '^[0-9a-f]{64}$'
    ),
  constraint affiliate_commission_jobs_attempts
    check (attempts between 0 and 12),
  constraint affiliate_commission_jobs_error
    check (
      last_error_code is null
      or last_error_code ~ '^[a-z][a-z0-9_]{2,63}$'
    ),
  constraint affiliate_commission_jobs_lease_state
    check (
      (status = 'leased') = (
        worker_id is not null
        and lease_token_hash is not null
        and leased_until is not null
      )
    ),
  constraint affiliate_commission_jobs_completion
    check (
      (status in ('succeeded', 'dead_letter')) =
      (completed_at is not null)
    )
);

create index affiliate_commission_jobs_lease_idx
  on affiliate_private.affiliate_commission_jobs (
    next_attempt_at,
    created_at
  )
  where status in ('pending', 'retry', 'leased');

create table affiliate_private.affiliate_commission_entries (
  id                uuid primary key default gen_random_uuid(),
  sequence_no       bigint generated always as identity unique,
  entry_key         text not null unique default (
    'led_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  account_id        uuid not null
    references affiliate_private.affiliate_accounts(id)
    on delete restrict,
  attribution_id    uuid
    references affiliate_private.affiliate_attributions(id)
    on delete restrict,
  fact_id           uuid
    references affiliate_private.affiliate_financial_facts(id)
    on delete restrict,
  entry_kind        text not null,
  related_entry_id  uuid
    references affiliate_private.affiliate_commission_entries(id)
    on delete restrict,
  currency          text not null,
  currency_exponent integer not null,
  amount_minor      bigint not null,
  matures_at        timestamptz,
  created_at        timestamptz not null default now(),
  constraint affiliate_commission_entries_key
    check (entry_key ~ '^led_[0-9a-f]{24}$'),
  constraint affiliate_commission_entries_kind
    check (
      entry_kind in (
        'accrual',
        'reversal',
        'manual_reversal',
        'release',
        'recovery_offset',
        'payout_allocation',
        'payout_settlement'
      )
    ),
  constraint affiliate_commission_entries_currency
    check (currency ~ '^[A-Z]{3}$'),
  constraint affiliate_commission_entries_exponent
    check (currency_exponent between 0 and 6),
  constraint affiliate_commission_entries_amount
    check (amount_minor between 1 and 9007199254740991),
  constraint affiliate_commission_entries_attribution_scope
    check (
      (
        entry_kind in ('accrual', 'reversal', 'manual_reversal', 'release')
        and attribution_id is not null
      )
      or (
        entry_kind in (
          'recovery_offset',
          'payout_allocation',
          'payout_settlement'
        )
        and attribution_id is null
      )
    ),
  constraint affiliate_commission_entries_relation
    check (
      (entry_kind = 'accrual'
        and fact_id is not null
        and related_entry_id is null
        and matures_at is not null)
      or (entry_kind in ('reversal', 'release')
        and fact_id is not null
        and related_entry_id is not null
        and matures_at is null)
      or (entry_kind = 'manual_reversal'
        and fact_id is null
        and related_entry_id is not null
        and matures_at is null)
      or (entry_kind = 'payout_allocation'
        and fact_id is null
        and related_entry_id is null
        and matures_at is null)
      or (entry_kind = 'recovery_offset'
        and fact_id is null
        and related_entry_id is null
        and matures_at is null)
      or (entry_kind = 'payout_settlement'
        and fact_id is null
        and related_entry_id is not null
        and matures_at is null)
    ),
  constraint affiliate_commission_entries_not_self
    check (related_entry_id is null or related_entry_id <> id),
  unique (entry_kind, fact_id)
);

create index affiliate_commission_entries_account_idx
  on affiliate_private.affiliate_commission_entries (
    account_id,
    currency,
    created_at desc
  );
create index affiliate_commission_entries_history_idx
  on affiliate_private.affiliate_commission_entries (
    account_id,
    sequence_no desc
  );
create index affiliate_commission_entries_maturation_idx
  on affiliate_private.affiliate_commission_entries (matures_at)
  where entry_kind = 'accrual';
create index affiliate_commission_entries_related_idx
  on affiliate_private.affiliate_commission_entries (related_entry_id)
  where related_entry_id is not null;

create table affiliate_private.affiliate_commission_postings (
  id             uuid primary key default gen_random_uuid(),
  entry_id       uuid not null
    references affiliate_private.affiliate_commission_entries(id)
    on delete restrict,
  ledger_account text not null,
  direction      text not null,
  amount_minor   bigint not null,
  currency       text not null,
  created_at     timestamptz not null default now(),
  constraint affiliate_commission_postings_account
    check (
      ledger_account in (
        'platform_commission_expense',
        'platform_commission_recovery',
        'partner_commission_pending',
        'partner_commission_available',
        'partner_payout_clearing',
        'partner_cash_settled',
        'partner_recovery_due'
      )
    ),
  constraint affiliate_commission_postings_direction
    check (direction in ('debit', 'credit')),
  constraint affiliate_commission_postings_amount
    check (amount_minor between 1 and 9007199254740991),
  constraint affiliate_commission_postings_currency
    check (currency ~ '^[A-Z]{3}$'),
  unique (entry_id, ledger_account, direction)
);

create index affiliate_commission_postings_account_idx
  on affiliate_private.affiliate_commission_postings (
    ledger_account,
    currency,
    created_at
  );

create table affiliate_private.affiliate_maturation_jobs (
  id                uuid primary key default gen_random_uuid(),
  job_key           text not null unique default (
    'mat_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  accrual_entry_id  uuid not null unique
    references affiliate_private.affiliate_commission_entries(id)
    on delete restrict,
  status            text not null default 'pending',
  worker_id         text,
  lease_token_hash  text,
  leased_until      timestamptz,
  attempts          integer not null default 0,
  available_at      timestamptz not null,
  next_attempt_at   timestamptz not null,
  last_error_code   text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  completed_at      timestamptz,
  constraint affiliate_maturation_jobs_key
    check (job_key ~ '^mat_[0-9a-f]{24}$'),
  constraint affiliate_maturation_jobs_status
    check (
      status in ('pending', 'leased', 'retry', 'succeeded', 'dead_letter')
    ),
  constraint affiliate_maturation_jobs_worker
    check (
      worker_id is null
      or worker_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$'
    ),
  constraint affiliate_maturation_jobs_lease_hash
    check (
      lease_token_hash is null
      or lease_token_hash ~ '^[0-9a-f]{64}$'
    ),
  constraint affiliate_maturation_jobs_attempts
    check (attempts between 0 and 12),
  constraint affiliate_maturation_jobs_error
    check (
      last_error_code is null
      or last_error_code ~ '^[a-z][a-z0-9_]{2,63}$'
    ),
  constraint affiliate_maturation_jobs_lease_state
    check (
      (status = 'leased') = (
        worker_id is not null
        and lease_token_hash is not null
        and leased_until is not null
      )
    ),
  constraint affiliate_maturation_jobs_completion
    check (
      (status in ('succeeded', 'dead_letter')) =
      (completed_at is not null)
    )
);

create index affiliate_maturation_jobs_lease_idx
  on affiliate_private.affiliate_maturation_jobs (
    next_attempt_at,
    available_at
  )
  where status in ('pending', 'retry', 'leased');

create table affiliate_private.affiliate_fiscal_profiles (
  account_id                   uuid primary key
    references affiliate_private.affiliate_accounts(id)
    on delete restrict,
  residence_country_code       text not null,
  status                       text not null default 'missing',
  verification_provider        text,
  verification_reference_hash text,
  tax_form_type                text,
  reviewed_at                  timestamptz,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  constraint affiliate_fiscal_profiles_country
    check (residence_country_code ~ '^[A-Z]{2}$'),
  constraint affiliate_fiscal_profiles_status
    check (status in ('missing', 'pending', 'verified', 'rejected', 'expired')),
  constraint affiliate_fiscal_profiles_provider
    check (
      verification_provider is null
      or verification_provider ~ '^[a-z0-9][a-z0-9._-]{1,63}$'
    ),
  constraint affiliate_fiscal_profiles_reference
    check (
      verification_reference_hash is null
      or verification_reference_hash ~ '^[0-9a-f]{64}$'
    ),
  constraint affiliate_fiscal_profiles_form
    check (
      tax_form_type is null
      or tax_form_type ~ '^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$'
    ),
  constraint affiliate_fiscal_profiles_verified
    check (
      status <> 'verified'
      or (
        verification_provider is not null
        and verification_reference_hash is not null
        and reviewed_at is not null
      )
    )
);

create table affiliate_private.affiliate_payout_provider_configs (
  provider                 text not null,
  country_code             text not null,
  currency                 text not null,
  status                   text not null default 'disabled',
  configured_by_pseudonym  text not null,
  justification            text not null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  primary key (provider, country_code, currency),
  constraint affiliate_payout_provider_configs_provider
    check (provider in ('wise', 'revolut', 'stripe_connect')),
  constraint affiliate_payout_provider_configs_country
    check (country_code ~ '^[A-Z]{2}$'),
  constraint affiliate_payout_provider_configs_currency
    check (currency ~ '^[A-Z]{3}$'),
  constraint affiliate_payout_provider_configs_status
    check (status in ('active', 'disabled')),
  constraint affiliate_payout_provider_configs_actor
    check (configured_by_pseudonym ~ '^[0-9a-f]{64}$'),
  constraint affiliate_payout_provider_configs_justification
    check (length(btrim(justification)) between 12 and 1000)
);

create table affiliate_private.affiliate_payout_profiles (
  id                     uuid primary key default gen_random_uuid(),
  account_id             uuid not null
    references affiliate_private.affiliate_accounts(id)
    on delete restrict,
  provider               text not null,
  beneficiary_token_ref  text not null,
  display_masked         text not null,
  currency               text not null,
  status                 text not null default 'active',
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint affiliate_payout_profiles_provider
    check (provider in ('wise', 'revolut', 'stripe_connect')),
  constraint affiliate_payout_profiles_token
    check (
      length(beneficiary_token_ref) between 8 and 255
      and beneficiary_token_ref !~ '[[:space:][:cntrl:]]'
    ),
  constraint affiliate_payout_profiles_masked
    check (length(btrim(display_masked)) between 4 and 64),
  constraint affiliate_payout_profiles_currency
    check (currency ~ '^[A-Z]{3}$'),
  constraint affiliate_payout_profiles_status
    check (status in ('active', 'disabled', 'verification_required')),
  unique (id, currency),
  unique (account_id, currency)
);

create table affiliate_private.affiliate_payout_cycles (
  id                   uuid primary key default gen_random_uuid(),
  cycle_key            text not null unique default (
    'pay_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  period_start         date not null,
  period_end           date not null,
  currency             text not null,
  currency_exponent    integer not null,
  status               text not null default 'draft',
  live_execution       boolean not null default false,
  total_minor          bigint not null default 0,
  item_count           integer not null default 0,
  created_by_pseudonym text not null,
  live_promoted_by_pseudonym text,
  live_promoted_at     timestamptz,
  approved_by_pseudonym text,
  approved_at          timestamptz,
  submitted_at         timestamptz,
  settled_at           timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint affiliate_payout_cycles_key
    check (cycle_key ~ '^pay_[0-9a-f]{24}$'),
  constraint affiliate_payout_cycles_period
    check (
      period_end >= period_start
      and period_end <= period_start + 35
    ),
  constraint affiliate_payout_cycles_currency
    check (currency ~ '^[A-Z]{3}$'),
  constraint affiliate_payout_cycles_exponent
    check (currency_exponent between 0 and 6),
  constraint affiliate_payout_cycles_status
    check (
      status in (
        'draft',
        'review',
        'approved',
        'submitted',
        'settled',
        'failed',
        'cancelled'
      )
    ),
  constraint affiliate_payout_cycles_totals
    check (
      total_minor between 0 and 9007199254740991
      and item_count between 0 and 1000000
    ),
  constraint affiliate_payout_cycles_approval
    check (
      status not in ('approved', 'submitted', 'settled')
      or (
        approved_by_pseudonym ~ '^[0-9a-f]{64}$'
        and approved_at is not null
      )
    ),
  constraint affiliate_payout_cycles_creator
    check (created_by_pseudonym ~ '^[0-9a-f]{64}$'),
  constraint affiliate_payout_cycles_promotion
    check (
      (live_promoted_by_pseudonym is null and live_promoted_at is null)
      or (
        live_execution
        and live_promoted_by_pseudonym ~ '^[0-9a-f]{64}$'
        and live_promoted_at is not null
      )
    ),
  unique (id, currency),
  unique (period_start, period_end, currency)
);

create table affiliate_private.affiliate_payout_items (
  id                   uuid primary key default gen_random_uuid(),
  cycle_id             uuid not null
    references affiliate_private.affiliate_payout_cycles(id)
    on delete restrict,
  account_id           uuid not null
    references affiliate_private.affiliate_accounts(id)
    on delete restrict,
  currency             text not null,
  payout_profile_id    uuid not null,
  allocation_entry_id uuid unique
    references affiliate_private.affiliate_commission_entries(id)
    on delete restrict,
  original_amount_minor bigint not null,
  amount_minor         bigint not null,
  recovered_minor      bigint not null default 0,
  status               text not null default 'pending',
  provider_transfer_hash text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint affiliate_payout_items_amount
    check (
      original_amount_minor between 1 and 9007199254740991
      and amount_minor between 0 and original_amount_minor
      and recovered_minor between 0 and original_amount_minor
      and amount_minor + recovered_minor = original_amount_minor
    ),
  constraint affiliate_payout_items_currency
    check (currency ~ '^[A-Z]{3}$'),
  constraint affiliate_payout_items_status
    check (
      status in ('pending', 'submitted', 'settled', 'failed', 'reversed')
    ),
  constraint affiliate_payout_items_transfer
    check (
      provider_transfer_hash is null
      or provider_transfer_hash ~ '^[0-9a-f]{64}$'
    ),
  constraint affiliate_payout_items_recovery
    check (
      (status = 'reversed') = (amount_minor = 0)
    ),
  unique (cycle_id, account_id)
);

alter table affiliate_private.affiliate_payout_items
  add constraint affiliate_payout_items_profile_fk
  foreign key (payout_profile_id)
  references affiliate_private.affiliate_payout_profiles(id)
  on delete restrict;
alter table affiliate_private.affiliate_payout_items
  add constraint affiliate_payout_items_cycle_currency_fk
  foreign key (cycle_id, currency)
  references affiliate_private.affiliate_payout_cycles(id, currency)
  on delete restrict;
alter table affiliate_private.affiliate_payout_items
  add constraint affiliate_payout_items_profile_currency_fk
  foreign key (payout_profile_id, currency)
  references affiliate_private.affiliate_payout_profiles(id, currency)
  on delete restrict;

create index affiliate_payout_items_cycle_idx
  on affiliate_private.affiliate_payout_items (cycle_id, status);
create index affiliate_payout_items_account_idx
  on affiliate_private.affiliate_payout_items (
    account_id,
    created_at desc
  );

create unique index affiliate_fiscal_profiles_reference_idx
  on affiliate_private.affiliate_fiscal_profiles (
    verification_reference_hash
  )
  where verification_reference_hash is not null;

create table affiliate_private.affiliate_shadow_reconciliation_runs (
  id                    uuid primary key default gen_random_uuid(),
  run_key               text not null unique default (
    'rec_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  worker_id             text not null,
  window_start          timestamptz not null,
  window_end            timestamptz not null,
  dry_run               boolean not null default true,
  status                text not null,
  facts_count           bigint not null,
  ledger_entries_count  bigint not null,
  mismatch_count        bigint not null,
  created_at            timestamptz not null default now(),
  constraint affiliate_shadow_reconciliation_runs_key
    check (run_key ~ '^rec_[0-9a-f]{24}$'),
  constraint affiliate_shadow_reconciliation_runs_worker
    check (worker_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$'),
  constraint affiliate_shadow_reconciliation_runs_window
    check (
      window_end > window_start
      and window_end <= window_start + interval '31 days'
    ),
  constraint affiliate_shadow_reconciliation_runs_status
    check (status in ('clean', 'mismatch')),
  constraint affiliate_shadow_reconciliation_runs_counts
    check (
      facts_count >= 0
      and ledger_entries_count >= 0
      and mismatch_count >= 0
    )
);

alter table affiliate_private.affiliate_currency_metadata
  enable row level security;
alter table affiliate_private.affiliate_financial_facts
  enable row level security;
alter table affiliate_private.affiliate_financial_fact_observations
  enable row level security;
alter table affiliate_private.affiliate_financial_fact_conflicts
  enable row level security;
alter table affiliate_private.affiliate_financial_fact_lineage_links
  enable row level security;
alter table affiliate_private.affiliate_commission_jobs
  enable row level security;
alter table affiliate_private.affiliate_commission_entries
  enable row level security;
alter table affiliate_private.affiliate_commission_postings
  enable row level security;
alter table affiliate_private.affiliate_maturation_jobs
  enable row level security;
alter table affiliate_private.affiliate_fiscal_profiles
  enable row level security;
alter table affiliate_private.affiliate_payout_provider_configs
  enable row level security;
alter table affiliate_private.affiliate_payout_profiles
  enable row level security;
alter table affiliate_private.affiliate_payout_cycles
  enable row level security;
alter table affiliate_private.affiliate_payout_items
  enable row level security;
alter table affiliate_private.affiliate_shadow_reconciliation_runs
  enable row level security;

revoke all on table
  affiliate_private.affiliate_currency_metadata,
  affiliate_private.affiliate_financial_facts,
  affiliate_private.affiliate_financial_fact_observations,
  affiliate_private.affiliate_financial_fact_conflicts,
  affiliate_private.affiliate_financial_fact_lineage_links,
  affiliate_private.affiliate_commission_jobs,
  affiliate_private.affiliate_commission_entries,
  affiliate_private.affiliate_commission_postings,
  affiliate_private.affiliate_maturation_jobs,
  affiliate_private.affiliate_fiscal_profiles,
  affiliate_private.affiliate_payout_provider_configs,
  affiliate_private.affiliate_payout_profiles,
  affiliate_private.affiliate_payout_cycles,
  affiliate_private.affiliate_payout_items,
  affiliate_private.affiliate_shadow_reconciliation_runs
from public, anon, authenticated, service_role;

create or replace function affiliate_private.reject_partners_finance_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Partners financial records are append-only'
    using errcode = '55000';
end;
$$;

create trigger affiliate_financial_facts_append_only
before update or delete on affiliate_private.affiliate_financial_facts
for each row execute function
  affiliate_private.reject_partners_finance_mutation();
create trigger affiliate_financial_fact_observations_append_only
before update or delete
on affiliate_private.affiliate_financial_fact_observations
for each row execute function
  affiliate_private.reject_partners_finance_mutation();
create trigger affiliate_financial_fact_conflicts_append_only
before update or delete
on affiliate_private.affiliate_financial_fact_conflicts
for each row execute function
  affiliate_private.reject_partners_finance_mutation();
create trigger affiliate_financial_fact_lineage_links_append_only
before update or delete
on affiliate_private.affiliate_financial_fact_lineage_links
for each row execute function
  affiliate_private.reject_partners_finance_mutation();
create trigger affiliate_commission_entries_append_only
before update or delete on affiliate_private.affiliate_commission_entries
for each row execute function
  affiliate_private.reject_partners_finance_mutation();
create trigger affiliate_commission_postings_append_only
before update or delete on affiliate_private.affiliate_commission_postings
for each row execute function
  affiliate_private.reject_partners_finance_mutation();
create trigger affiliate_shadow_reconciliation_runs_append_only
before update or delete
on affiliate_private.affiliate_shadow_reconciliation_runs
for each row execute function
  affiliate_private.reject_partners_finance_mutation();

create or replace function affiliate_private.assert_commission_entry_balanced()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_entry_id uuid := case
    when tg_table_name = 'affiliate_commission_entries' then new.id
    else new.entry_id
  end;
  v_debits numeric;
  v_credits numeric;
  v_count integer;
  v_entry affiliate_private.affiliate_commission_entries%rowtype;
begin
  select e.*
  into v_entry
  from affiliate_private.affiliate_commission_entries e
  where e.id = v_entry_id;
  if not found then
    return null;
  end if;

  select
    coalesce(sum(p.amount_minor) filter (where p.direction = 'debit'), 0),
    coalesce(sum(p.amount_minor) filter (where p.direction = 'credit'), 0),
    count(*)
  into v_debits, v_credits, v_count
  from affiliate_private.affiliate_commission_postings p
  where p.entry_id = v_entry_id
    and p.currency = v_entry.currency;

  if v_count < 2
    or v_debits <> v_credits
    or v_debits <> v_entry.amount_minor
  then
    raise exception 'commission ledger entry is not balanced'
      using errcode = '23514';
  end if;
  return null;
end;
$$;

create constraint trigger affiliate_commission_entry_balance_on_entry
after insert on affiliate_private.affiliate_commission_entries
deferrable initially deferred
for each row execute function
  affiliate_private.assert_commission_entry_balanced();

create constraint trigger affiliate_commission_entry_balance_on_posting
after insert on affiliate_private.affiliate_commission_postings
deferrable initially deferred
for each row execute function
  affiliate_private.assert_commission_entry_balanced();

create or replace function affiliate_private.partners_commission_minor(
  p_eligible_minor bigint,
  p_commission_rate_bps integer
)
returns bigint
language sql
immutable
parallel safe
set search_path = ''
as $$
  select floor(
    (
      p_eligible_minor::numeric
      * p_commission_rate_bps::numeric
      + 5000
    ) / 10000
  )::bigint;
$$;

create or replace function
affiliate_private.partners_worker_financial_observation_required(
  p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    p_user_id is not null
    and exists (
      select 1
      from affiliate_private.affiliate_attributions attribution
      where attribution.referred_user_id = p_user_id
    );
$$;

create or replace function
affiliate_private.partners_worker_currency_exponent_resolve(
  p_currency text
)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select metadata.exponent
  from affiliate_private.affiliate_currency_metadata metadata
  where metadata.currency_code = upper(btrim(coalesce(p_currency, '')))
    and metadata.status = 'active'
  limit 1;
$$;

-- Every mutation that can move an individual Partner balance shares this
-- transaction-scoped lock. The hash is only a lock namespace; the canonical
-- account UUID and ISO currency remain the authoritative database keys.
create or replace function affiliate_private.partners_balance_lock(
  p_account_id uuid,
  p_currency text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_currency text := upper(btrim(coalesce(p_currency, '')));
begin
  if p_account_id is null or v_currency !~ '^[A-Z]{3}$' then
    raise exception 'invalid Partner balance lock'
      using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:balance:' || p_account_id::text || ':' || v_currency,
      0
    )
  );
end;
$$;

-- A post-settlement recovery is an explicit receivable. It offsets future
-- available commission before another payout can be allocated.
create or replace function affiliate_private.partners_account_payable_balance(
  p_account_id uuid,
  p_currency text
)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  with balances as (
    select
      coalesce(sum(
        case
          when posting.ledger_account = 'partner_commission_available'
            and posting.direction = 'credit'
            then posting.amount_minor
          when posting.ledger_account = 'partner_commission_available'
            and posting.direction = 'debit'
            then -posting.amount_minor
          else 0
        end
      ), 0)::numeric as available_minor,
      coalesce(sum(
        case
          when posting.ledger_account = 'partner_recovery_due'
            and posting.direction = 'debit'
            then posting.amount_minor
          when posting.ledger_account = 'partner_recovery_due'
            and posting.direction = 'credit'
            then -posting.amount_minor
          else 0
        end
      ), 0)::numeric as recovery_due_minor
    from affiliate_private.affiliate_commission_postings posting
    join affiliate_private.affiliate_commission_entries entry
      on entry.id = posting.entry_id
    where entry.account_id = p_account_id
      and posting.currency = upper(btrim(coalesce(p_currency, '')))
  )
  select greatest(
    available_minor - greatest(recovery_due_minor, 0),
    0
  )::bigint
  from balances;
$$;

-- Recovery receivables are not permanent contra-balances. As soon as future
-- commission is available, both balances are reduced by one explicit,
-- balanced ledger entry before any new payout allocation can be created.
create or replace function
affiliate_private.partners_recovery_due_consume(
  p_account_id uuid,
  p_currency text
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_currency text := upper(btrim(coalesce(p_currency, '')));
  v_available_minor bigint := 0;
  v_recovery_due_minor bigint := 0;
  v_amount_minor bigint := 0;
  v_exponent integer;
  v_entry_id uuid;
begin
  perform affiliate_private.partners_balance_lock(
    p_account_id,
    v_currency
  );

  select
    coalesce(sum(
      case
        when posting.ledger_account = 'partner_commission_available'
          and posting.direction = 'credit'
          then posting.amount_minor
        when posting.ledger_account = 'partner_commission_available'
          and posting.direction = 'debit'
          then -posting.amount_minor
        else 0
      end
    ), 0)::bigint,
    coalesce(sum(
      case
        when posting.ledger_account = 'partner_recovery_due'
          and posting.direction = 'debit'
          then posting.amount_minor
        when posting.ledger_account = 'partner_recovery_due'
          and posting.direction = 'credit'
          then -posting.amount_minor
        else 0
      end
    ), 0)::bigint
  into v_available_minor, v_recovery_due_minor
  from affiliate_private.affiliate_commission_postings posting
  join affiliate_private.affiliate_commission_entries entry
    on entry.id = posting.entry_id
  where entry.account_id = p_account_id
    and posting.currency = v_currency;

  v_amount_minor := least(
    greatest(v_available_minor, 0),
    greatest(v_recovery_due_minor, 0)
  );
  if v_amount_minor = 0 then
    return 0;
  end if;

  select entry.currency_exponent
  into v_exponent
  from affiliate_private.affiliate_commission_entries entry
  where entry.account_id = p_account_id
    and entry.currency = v_currency
  order by entry.sequence_no desc
  limit 1;
  if v_exponent is null then
    raise exception 'recovery currency metadata is unavailable'
      using errcode = '55000';
  end if;

  insert into affiliate_private.affiliate_commission_entries (
    account_id,
    entry_kind,
    currency,
    currency_exponent,
    amount_minor
  )
  values (
    p_account_id,
    'recovery_offset',
    v_currency,
    v_exponent,
    v_amount_minor
  )
  returning id into v_entry_id;
  insert into affiliate_private.affiliate_commission_postings (
    entry_id, ledger_account, direction, amount_minor, currency
  )
  values
    (
      v_entry_id,
      'partner_commission_available',
      'debit',
      v_amount_minor,
      v_currency
    ),
    (
      v_entry_id,
      'partner_recovery_due',
      'credit',
      v_amount_minor,
      v_currency
    );
  return v_amount_minor;
end;
$$;

-- Payout approval is fail-closed while any billing observation for the
-- Partner/currency is incomplete, quarantined, conflicted, or still has a
-- commission job that has not reached its terminal success state.
create or replace function
affiliate_private.partners_payout_balance_authoritative(
  p_account_id uuid,
  p_currency text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    p_account_id is not null
    and upper(btrim(coalesce(p_currency, ''))) ~ '^[A-Z]{3}$'
    and not exists (
      select 1
      from affiliate_private.affiliate_financial_facts fact
      where fact.environment = 'production'
        and fact.currency = upper(btrim(coalesce(p_currency, '')))
        and fact.facts_status in ('incomplete', 'quarantined')
        and exists (
          select 1
          from affiliate_private.affiliate_attributions attribution
          where attribution.referrer_account_id = p_account_id
            and (
              attribution.id = fact.attribution_id
              or attribution.referred_user_id = fact.referred_user_id
            )
        )
    )
    and not exists (
      select 1
      from affiliate_private.affiliate_financial_fact_conflicts conflict
      join affiliate_private.affiliate_financial_facts fact
        on fact.id = conflict.fact_id
      where fact.environment = 'production'
        and fact.currency = upper(btrim(coalesce(p_currency, '')))
        and exists (
          select 1
          from affiliate_private.affiliate_attributions attribution
          where attribution.referrer_account_id = p_account_id
            and (
              attribution.id = fact.attribution_id
              or attribution.referred_user_id = fact.referred_user_id
            )
        )
    )
    and not exists (
      select 1
      from affiliate_private.affiliate_commission_jobs job
      join affiliate_private.affiliate_financial_facts fact
        on fact.id = job.fact_id
      where job.status <> 'succeeded'
        and fact.environment = 'production'
        and fact.currency = upper(btrim(coalesce(p_currency, '')))
        and exists (
          select 1
          from affiliate_private.affiliate_attributions attribution
          where attribution.referrer_account_id = p_account_id
            and (
              attribution.id = fact.attribution_id
              or attribution.referred_user_id = fact.referred_user_id
            )
        )
    )
    and not exists (
      select 1
      from affiliate_private.affiliate_financial_facts fact
      join affiliate_private.affiliate_attributions attribution
        on attribution.id = fact.attribution_id
      where fact.environment = 'production'
        and fact.facts_status = 'complete'
        and fact.event_type in ('capture', 'renewal')
        and fact.currency = upper(btrim(coalesce(p_currency, '')))
        and attribution.referrer_account_id = p_account_id
        and affiliate_private.partners_commission_minor(
          fact.eligible_minor,
          attribution.commission_rate_bps
        ) > 0
        and (
          not exists (
            select 1
            from affiliate_private.affiliate_commission_jobs job
            where job.fact_id = fact.id
              and job.job_kind = 'accrual'
              and job.status = 'succeeded'
          )
          or not exists (
            select 1
            from affiliate_private.affiliate_commission_entries entry
            where entry.fact_id = fact.id
              and entry.entry_kind = 'accrual'
          )
        )
    )
    and not exists (
      select 1
      from affiliate_private.affiliate_financial_facts fact
      join affiliate_private.affiliate_financial_fact_lineage_links lineage
        on lineage.child_fact_id = fact.id
      join affiliate_private.affiliate_attributions attribution
        on attribution.id = lineage.attribution_id
      join affiliate_private.affiliate_commission_entries origin_entry
        on origin_entry.fact_id = lineage.parent_fact_id
        and origin_entry.entry_kind = 'accrual'
      where fact.environment = 'production'
        and fact.facts_status = 'complete'
        and fact.event_type in ('refund', 'chargeback')
        and fact.currency = upper(btrim(coalesce(p_currency, '')))
        and attribution.referrer_account_id = p_account_id
        and least(
          affiliate_private.partners_commission_minor(
            fact.eligible_minor,
            attribution.commission_rate_bps
          ),
          greatest(
            origin_entry.amount_minor - coalesce((
              select sum(reversal.amount_minor)
              from affiliate_private.affiliate_commission_entries reversal
              where reversal.related_entry_id = origin_entry.id
                and reversal.entry_kind in (
                  'reversal',
                  'manual_reversal'
                )
            ), 0),
            0
          )
        ) > 0
        and (
          not exists (
            select 1
            from affiliate_private.affiliate_commission_jobs job
            where job.fact_id = fact.id
              and job.job_kind = 'reversal'
              and job.status = 'succeeded'
          )
          or not exists (
            select 1
            from affiliate_private.affiliate_commission_entries reversal
            where reversal.fact_id = fact.id
              and reversal.entry_kind = 'reversal'
          )
        )
    );
$$;

-- Route an immutable refund/chargeback counter-entry against the liability
-- that still exists at commit time. Approved-but-unsubmitted allocations are
-- reduced atomically. Once a transfer is submitted or settled, the remainder
-- becomes an explicit recovery receivable instead of silently making another
-- payout possible.
create or replace function
affiliate_private.partners_route_commission_recovery(
  p_entry_id uuid,
  p_account_id uuid,
  p_currency text,
  p_amount_minor bigint,
  p_pending_only boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_currency text := upper(btrim(coalesce(p_currency, '')));
  v_entry affiliate_private.affiliate_commission_entries%rowtype;
  v_remaining bigint := p_amount_minor;
  v_pending_minor bigint := 0;
  v_available_minor bigint := 0;
  v_clearing_minor bigint := 0;
  v_recovery_due_minor bigint := 0;
  v_available_balance bigint := 0;
  v_take bigint;
  v_item record;
begin
  if p_entry_id is null
    or p_account_id is null
    or v_currency !~ '^[A-Z]{3}$'
    or p_amount_minor is null
    or p_amount_minor not between 1 and 9007199254740991
    or p_pending_only is null
  then
    raise exception 'invalid Partner recovery route'
      using errcode = '22023';
  end if;

  select entry.*
  into v_entry
  from affiliate_private.affiliate_commission_entries entry
  where entry.id = p_entry_id
    and entry.account_id = p_account_id
    and entry.currency = v_currency
    and entry.amount_minor = p_amount_minor
    and entry.entry_kind in ('reversal', 'manual_reversal');
  if not found then
    raise exception 'Partner recovery entry is unavailable'
      using errcode = 'P0002';
  end if;

  perform affiliate_private.partners_balance_lock(
    p_account_id,
    v_currency
  );

  if p_pending_only then
    v_pending_minor := v_remaining;
    v_remaining := 0;
  else
    select coalesce(sum(
      case
        when posting.direction = 'credit' then posting.amount_minor
        else -posting.amount_minor
      end
    ), 0)::bigint
    into v_available_balance
    from affiliate_private.affiliate_commission_postings posting
    join affiliate_private.affiliate_commission_entries entry
      on entry.id = posting.entry_id
    where entry.account_id = p_account_id
      and posting.currency = v_currency
      and posting.ledger_account = 'partner_commission_available';

    v_available_minor := least(
      v_remaining,
      greatest(v_available_balance, 0)
    );
    v_remaining := v_remaining - v_available_minor;

    if v_remaining > 0 then
      for v_item in
        select
          item.id,
          item.original_amount_minor,
          item.amount_minor,
          item.recovered_minor,
          item.status,
          cycle.id as cycle_id,
          cycle.total_minor,
          cycle.item_count
        from affiliate_private.affiliate_payout_items item
        join affiliate_private.affiliate_payout_cycles cycle
          on cycle.id = item.cycle_id
        where item.account_id = p_account_id
          and cycle.currency = v_currency
          and item.allocation_entry_id is not null
          and item.status in ('pending', 'failed')
          and item.amount_minor > 0
          and cycle.status in ('approved', 'failed', 'cancelled')
        order by cycle.approved_at nulls last, item.created_at, item.id
        for update of item, cycle
      loop
        exit when v_remaining = 0;
        v_take := least(
          v_remaining,
          v_item.amount_minor
        );
        if v_item.total_minor < v_take or v_item.item_count < 1 then
          raise exception 'payout recovery totals are inconsistent'
            using errcode = '55000';
        end if;

        update affiliate_private.affiliate_payout_items item
        set
          amount_minor = item.amount_minor - v_take,
          recovered_minor = item.recovered_minor + v_take,
          status = case
            when item.amount_minor - v_take = 0
              then 'reversed'
            else item.status
          end,
          updated_at = now()
        where item.id = v_item.id;

        update affiliate_private.affiliate_payout_cycles cycle
        set
          total_minor = cycle.total_minor - v_take,
          item_count = cycle.item_count - case
            when v_item.amount_minor - v_take = 0
              then 1
            else 0
          end,
          updated_at = now()
        where cycle.id = v_item.cycle_id;

        v_clearing_minor := v_clearing_minor + v_take;
        v_remaining := v_remaining - v_take;
      end loop;
    end if;

    v_recovery_due_minor := v_remaining;
    v_remaining := 0;
  end if;

  if v_pending_minor > 0 then
    insert into affiliate_private.affiliate_commission_postings (
      entry_id, ledger_account, direction, amount_minor, currency
    )
    values (
      p_entry_id,
      'partner_commission_pending',
      'debit',
      v_pending_minor,
      v_currency
    );
  end if;
  if v_available_minor > 0 then
    insert into affiliate_private.affiliate_commission_postings (
      entry_id, ledger_account, direction, amount_minor, currency
    )
    values (
      p_entry_id,
      'partner_commission_available',
      'debit',
      v_available_minor,
      v_currency
    );
  end if;
  if v_clearing_minor > 0 then
    insert into affiliate_private.affiliate_commission_postings (
      entry_id, ledger_account, direction, amount_minor, currency
    )
    values (
      p_entry_id,
      'partner_payout_clearing',
      'debit',
      v_clearing_minor,
      v_currency
    );
  end if;
  if v_recovery_due_minor > 0 then
    insert into affiliate_private.affiliate_commission_postings (
      entry_id, ledger_account, direction, amount_minor, currency
    )
    values (
      p_entry_id,
      'partner_recovery_due',
      'debit',
      v_recovery_due_minor,
      v_currency
    );
  end if;
  insert into affiliate_private.affiliate_commission_postings (
    entry_id, ledger_account, direction, amount_minor, currency
  )
  values (
    p_entry_id,
    'platform_commission_recovery',
    'credit',
    p_amount_minor,
    v_currency
  );

  return jsonb_build_object(
    'pending_minor', v_pending_minor,
    'available_minor', v_available_minor,
    'clearing_minor', v_clearing_minor,
    'recovery_due_minor', v_recovery_due_minor
  );
end;
$$;

create or replace function
affiliate_private.partners_worker_financial_fact_ingest(
  p_source_event_hash text,
  p_payload_hash text,
  p_transaction_hash text,
  p_parent_transaction_hash text,
  p_referred_user_id uuid,
  p_rail text,
  p_event_type text,
  p_environment text,
  p_currency text,
  p_currency_exponent integer,
  p_gross_minor bigint,
  p_discount_minor bigint,
  p_tax_minor bigint,
  p_eligible_minor bigint,
  p_observed_at timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_source_hash text := lower(btrim(coalesce(p_source_event_hash, '')));
  v_payload_hash text := lower(btrim(coalesce(p_payload_hash, '')));
  v_transaction_hash text := lower(btrim(coalesce(p_transaction_hash, '')));
  v_parent_hash text := nullif(
    lower(btrim(coalesce(p_parent_transaction_hash, ''))),
    ''
  );
  v_rail text := lower(btrim(coalesce(p_rail, '')));
  v_event_type text := lower(btrim(coalesce(p_event_type, '')));
  v_environment text := lower(btrim(coalesce(p_environment, '')));
  v_currency text := nullif(upper(btrim(coalesce(p_currency, ''))), '');
  v_fact affiliate_private.affiliate_financial_facts%rowtype;
  v_observed_fact affiliate_private.affiliate_financial_facts%rowtype;
  v_origin affiliate_private.affiliate_financial_facts%rowtype;
  v_attribution affiliate_private.affiliate_attributions%rowtype;
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_facts_status text;
  v_complete boolean := false;
  v_job_status text;
  v_replayed boolean := false;
  v_conflict_fields text[];
begin
  if v_source_hash !~ '^[0-9a-f]{64}$'
    or v_payload_hash !~ '^[0-9a-f]{64}$'
    or v_transaction_hash !~ '^[0-9a-f]{64}$'
    or (v_parent_hash is not null and v_parent_hash !~ '^[0-9a-f]{64}$')
    or p_referred_user_id is null
    or v_rail not in ('web', 'google_play', 'revenuecat')
    or v_event_type not in (
      'capture', 'renewal', 'refund', 'chargeback', 'transfer'
    )
    or v_environment not in ('production', 'sandbox')
    or (v_currency is not null and v_currency !~ '^[A-Z]{3}$')
    or (
      p_currency_exponent is not null
      and p_currency_exponent not between 0 and 6
    )
    or p_observed_at is null
    or p_observed_at > now() + interval '5 minutes'
    or p_observed_at < now() - interval '2 years'
  then
    raise exception 'invalid financial fact envelope'
      using errcode = '22023';
  end if;

  if (
    select bool_or(v < 0 or v > 9007199254740991)
    from unnest(array[
      p_gross_minor,
      p_discount_minor,
      p_tax_minor,
      p_eligible_minor
    ]::bigint[]) values_to_check(v)
    where v is not null
  ) then
    raise exception 'invalid financial amount'
      using errcode = '22023';
  end if;

  if v_event_type in ('capture', 'renewal') and v_parent_hash is not null
    or v_event_type in ('refund', 'chargeback') and v_parent_hash is null
  then
    raise exception 'invalid transaction lineage'
      using errcode = '22023';
  end if;

  if p_gross_minor is not null
    and p_tax_minor is not null
    and p_tax_minor > p_gross_minor
  then
    raise exception 'tax exceeds gross amount'
      using errcode = '22023';
  end if;

  if not exists (
    select 1 from auth.users u where u.id = p_referred_user_id
  ) then
    raise exception 'billing user is unavailable'
      using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      concat_ws(
        ':',
        'norva:partners:economic',
        v_environment,
        v_rail,
        v_event_type,
        v_transaction_hash
      ),
      0
    )
  );

  select f.*
  into v_observed_fact
  from affiliate_private.affiliate_financial_fact_observations o
  join affiliate_private.affiliate_financial_facts f on f.id = o.fact_id
  where o.source_event_hash = v_source_hash;

  select f.*
  into v_fact
  from affiliate_private.affiliate_financial_facts f
  where f.environment = v_environment
    and f.rail = v_rail
    and f.event_type = v_event_type
    and f.transaction_hash = v_transaction_hash;

  if v_observed_fact.id is not null then
    if v_fact.id is null then
      v_fact := v_observed_fact;
    elsif v_fact.id <> v_observed_fact.id then
      raise exception 'source event maps to another economic event'
        using errcode = 'P0003';
    end if;
  end if;

  if v_fact.id is not null then
    v_conflict_fields := array_remove(array[
      case when v_fact.parent_transaction_hash is distinct from v_parent_hash
        then 'parent_transaction' end,
      case when v_fact.referred_user_id is distinct from p_referred_user_id
        then 'referred_user' end,
      case when v_fact.currency is distinct from v_currency
        then 'currency' end,
      case when v_fact.currency_exponent is distinct from p_currency_exponent
        then 'currency_exponent' end,
      case when v_fact.gross_minor is distinct from p_gross_minor
        then 'gross' end,
      case when v_fact.discount_minor is distinct from p_discount_minor
        then 'discount' end,
      case when v_fact.tax_minor is distinct from p_tax_minor
        then 'tax' end,
      case when v_fact.eligible_minor is distinct from p_eligible_minor
        then 'eligible' end
    ]::text[], null);

    if cardinality(v_conflict_fields) > 0 then
      insert into affiliate_private.affiliate_financial_fact_conflicts (
        fact_id,
        source_event_hash,
        payload_hash,
        mismatched_fields,
        observed_at
      )
      values (
        v_fact.id,
        v_source_hash,
        v_payload_hash,
        v_conflict_fields,
        p_observed_at
      )
      on conflict (source_event_hash) do nothing;

      update affiliate_private.affiliate_commission_jobs
      set
        status = 'dead_letter',
        worker_id = null,
        lease_token_hash = null,
        leased_until = null,
        last_error_code = 'financial_fact_conflict',
        completed_at = now(),
        updated_at = now()
      where fact_id = v_fact.id
        and status in ('pending', 'retry', 'leased');

      select j.status
      into v_job_status
      from affiliate_private.affiliate_commission_jobs j
      where j.fact_id = v_fact.id;

      insert into affiliate_private.affiliate_events (
        aggregate_type,
        aggregate_key,
        action,
        actor_type,
        justification,
        after_state
      )
      values (
        'financial_fact',
        v_fact.fact_key,
        'financial_fact_conflict',
        'system',
        'Conflicting observation was quarantined without changing billing rights.',
        jsonb_build_object(
          'mismatched_fields', to_jsonb(v_conflict_fields),
          'job_status', v_job_status
        )
      );

      return jsonb_build_object(
        'schema_version', 1,
        'action', 'financial_fact_ingested',
        'replayed', false,
        'conflict', true,
        'fact', jsonb_build_object(
          'key', v_fact.fact_key,
          'status', 'quarantined',
          'job_status', v_job_status
        )
      );
    end if;

    insert into affiliate_private.affiliate_financial_fact_observations (
      fact_id,
      source_event_hash,
      payload_hash,
      observed_at
    )
    values (v_fact.id, v_source_hash, v_payload_hash, p_observed_at)
    on conflict (source_event_hash) do nothing;
    v_replayed := true;
  else
    if v_event_type in ('refund', 'chargeback') then
      select f.*
      into v_origin
      from affiliate_private.affiliate_financial_facts f
      where f.environment = v_environment
        and f.rail = v_rail
        and f.transaction_hash = v_parent_hash
        and f.event_type in ('capture', 'renewal')
      order by f.created_at
      limit 1;

      if v_event_type in ('refund', 'chargeback')
        and v_origin.id is not null
        and v_origin.referred_user_id <> p_referred_user_id
      then
        raise exception 'transaction lineage user conflict'
          using errcode = 'P0003';
      end if;
    end if;

    if v_event_type = 'transfer'
      or (
        v_origin.id is not null
        and (
          v_origin.currency is distinct from v_currency
          or v_origin.currency_exponent
            is distinct from p_currency_exponent
        )
      )
    then
      v_facts_status := 'quarantined';
    else
      v_complete :=
        v_currency is not null
        and p_currency_exponent is not null
        and p_gross_minor is not null
        and p_tax_minor is not null
        and p_eligible_minor is not null
        and p_tax_minor <= p_gross_minor
        and p_eligible_minor = p_gross_minor - p_tax_minor
        and exists (
          select 1
          from affiliate_private.affiliate_currency_metadata c
          where c.currency_code = v_currency
            and c.exponent = p_currency_exponent
            and c.status = 'active'
        );
      v_facts_status := case
        when v_complete then 'complete'
        else 'incomplete'
      end;
    end if;

    if v_event_type in ('capture', 'renewal') then
      select a.*
      into v_attribution
      from affiliate_private.affiliate_attributions a
      where a.referred_user_id = p_referred_user_id;
    elsif v_origin.id is not null then
      select a.*
      into v_attribution
      from affiliate_private.affiliate_attributions a
      where a.id = v_origin.attribution_id;
    end if;

    insert into affiliate_private.affiliate_financial_facts (
      transaction_hash,
      parent_transaction_hash,
      referred_user_id,
      attribution_id,
      rail,
      event_type,
      environment,
      facts_status,
      currency,
      currency_exponent,
      gross_minor,
      discount_minor,
      tax_minor,
      eligible_minor,
      occurred_at
    )
    values (
      v_transaction_hash,
      v_parent_hash,
      p_referred_user_id,
      v_attribution.id,
      v_rail,
      v_event_type,
      v_environment,
      v_facts_status,
      v_currency,
      p_currency_exponent,
      p_gross_minor,
      p_discount_minor,
      p_tax_minor,
      p_eligible_minor,
      p_observed_at
    )
    returning * into v_fact;

    insert into affiliate_private.affiliate_financial_fact_observations (
      fact_id,
      source_event_hash,
      payload_hash,
      observed_at
    )
    values (v_fact.id, v_source_hash, v_payload_hash, p_observed_at);

    if v_origin.id is not null
      and v_attribution.id is not null
      and v_fact.facts_status = 'complete'
      and v_origin.currency = v_fact.currency
      and v_origin.currency_exponent = v_fact.currency_exponent
    then
      insert into affiliate_private.affiliate_financial_fact_lineage_links (
        child_fact_id,
        parent_fact_id,
        attribution_id
      )
      values (v_fact.id, v_origin.id, v_attribution.id)
      on conflict (child_fact_id) do nothing;
    end if;

    if v_attribution.id is not null then
      select a.*
      into v_account
      from affiliate_private.affiliate_accounts a
      where a.id = v_attribution.referrer_account_id;
    end if;

    if v_event_type in ('capture', 'renewal')
      and v_fact.facts_status = 'complete'
      and v_fact.environment = 'production'
      and v_attribution.id is not null
      and v_attribution.status in ('attributed', 'qualified')
      and v_account.status = 'active'
      and (
        coalesce((
          select f.enabled
          from public.admin_feature_flags f
          where f.key = 'partners_shadow_mode'
        ), false)
        or coalesce((
          select f.enabled
          from public.admin_feature_flags f
          where f.key = 'partners_payouts_live'
        ), false)
      )
      and affiliate_private.release_gates_satisfied(
        array['financial_data_contract_approved']::text[]
      )
    then
      insert into affiliate_private.affiliate_commission_jobs (
        fact_id,
        job_kind
      )
      values (
        v_fact.id,
        'accrual'
      );
      v_job_status := 'pending';
    end if;

    -- Recovery of an existing Partner liability must not depend on the
    -- current account state, feature flags, or release gates. Those controls
    -- apply only when creating a new accrual. A queued origin accrual is
    -- enough; the bounded worker retry policy covers the short race until the
    -- origin ledger entry is appended.
    if v_event_type in ('refund', 'chargeback')
      and v_fact.facts_status = 'complete'
      and v_fact.environment = 'production'
      and v_origin.id is not null
      and v_attribution.id is not null
      and exists (
        select 1
        from affiliate_private.affiliate_financial_fact_lineage_links link
        where link.child_fact_id = v_fact.id
          and link.parent_fact_id = v_origin.id
      )
      and (
        exists (
          select 1
          from affiliate_private.affiliate_commission_entries entry
          where entry.fact_id = v_origin.id
            and entry.entry_kind = 'accrual'
        )
        or exists (
          select 1
          from affiliate_private.affiliate_commission_jobs origin_job
          where origin_job.fact_id = v_origin.id
            and origin_job.job_kind = 'accrual'
        )
      )
    then
      insert into affiliate_private.affiliate_commission_jobs (
        fact_id,
        job_kind
      )
      values (v_fact.id, 'reversal')
      on conflict (fact_id) do nothing;
      select j.status
      into v_job_status
      from affiliate_private.affiliate_commission_jobs j
      where j.fact_id = v_fact.id;
    end if;

    if v_event_type in ('capture', 'renewal')
      and v_fact.facts_status = 'complete'
      and v_fact.environment = 'production'
      and v_attribution.id is not null
    then
      insert into affiliate_private.affiliate_financial_fact_lineage_links (
        child_fact_id,
        parent_fact_id,
        attribution_id
      )
      select
        child.id,
        v_fact.id,
        v_attribution.id
      from affiliate_private.affiliate_financial_facts child
      where child.environment = v_fact.environment
        and child.rail = v_fact.rail
        and child.parent_transaction_hash = v_fact.transaction_hash
        and child.event_type in ('refund', 'chargeback')
        and child.referred_user_id = v_fact.referred_user_id
        and child.facts_status = 'complete'
        and child.currency = v_fact.currency
        and child.currency_exponent = v_fact.currency_exponent
      on conflict (child_fact_id) do nothing;

      insert into affiliate_private.affiliate_commission_jobs (
        fact_id,
        job_kind
      )
      select child.id, 'reversal'
      from affiliate_private.affiliate_financial_facts child
      join affiliate_private.affiliate_financial_fact_lineage_links link
        on link.child_fact_id = child.id
        and link.parent_fact_id = v_fact.id
      where child.event_type in ('refund', 'chargeback')
        and child.facts_status = 'complete'
        and (
          exists (
            select 1
            from affiliate_private.affiliate_commission_entries entry
            where entry.fact_id = v_fact.id
              and entry.entry_kind = 'accrual'
          )
          or exists (
            select 1
            from affiliate_private.affiliate_commission_jobs origin_job
            where origin_job.fact_id = v_fact.id
              and origin_job.job_kind = 'accrual'
          )
        )
      on conflict (fact_id) do nothing;
    end if;

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
      'financial_fact',
      v_fact.fact_key,
      'financial_fact_ingested',
      'service',
      case
        when v_account.id is null then null
        else v_account.user_pseudonym
      end,
      'Canonical billing event was reduced to immutable monetary facts.',
      jsonb_build_object(
        'facts_status', v_fact.facts_status,
        'rail', v_fact.rail,
        'event_type', v_fact.event_type,
        'environment', v_fact.environment,
        'job_status', v_job_status
      )
    );
  end if;

  if v_job_status is null then
    select j.status
    into v_job_status
    from affiliate_private.affiliate_commission_jobs j
    where j.fact_id = v_fact.id;
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'financial_fact_ingested',
    'replayed', v_replayed,
    'conflict', false,
    'fact', jsonb_build_object(
      'key', v_fact.fact_key,
      'status', v_fact.facts_status,
      'job_status', v_job_status
    )
  );
end;
$$;

create or replace function
affiliate_private.partners_worker_commission_jobs_lease(
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
  v_token text := lower(btrim(coalesce(p_lease_token_hash, '')));
  v_until timestamptz;
  v_jobs jsonb;
begin
  if v_worker !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$'
    or v_token !~ '^[0-9a-f]{64}$'
    or p_limit is null
    or p_limit not between 1 and 50
    or p_lease_seconds is null
    or p_lease_seconds not between 15 and 300
  then
    raise exception 'invalid commission lease request'
      using errcode = '22023';
  end if;

  v_until := now() + make_interval(secs => p_lease_seconds);

  update affiliate_private.affiliate_commission_jobs
  set
    status = 'dead_letter',
    worker_id = null,
    lease_token_hash = null,
    leased_until = null,
    last_error_code = 'retry_exhausted',
    completed_at = now(),
    updated_at = now()
  where attempts >= 12
    and (
      status in ('pending', 'retry')
      or (status = 'leased' and leased_until <= now())
    );

  with candidates as (
    select j.id
    from affiliate_private.affiliate_commission_jobs j
    where (
      (
        j.status in ('pending', 'retry')
        and j.next_attempt_at <= now()
      ) or (
        j.status = 'leased'
        and j.leased_until <= now()
      )
    )
      and j.attempts < 12
    order by j.next_attempt_at, j.created_at
    for update skip locked
    limit p_limit
  ),
  leased as (
    update affiliate_private.affiliate_commission_jobs j
    set
      status = 'leased',
      worker_id = v_worker,
      lease_token_hash = v_token,
      leased_until = v_until,
      attempts = j.attempts + 1,
      updated_at = now()
    from candidates c
    where j.id = c.id
    returning j.job_key, j.job_kind, j.fact_id
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'key', l.job_key,
        'kind', l.job_kind,
        'fact_key', f.fact_key
      )
      order by l.job_key
    ),
    '[]'::jsonb
  )
  into v_jobs
  from leased l
  join affiliate_private.affiliate_financial_facts f
    on f.id = l.fact_id;

  return jsonb_build_object(
    'schema_version', 1,
    'leased_until', v_until,
    'jobs', v_jobs
  );
end;
$$;

create or replace function
affiliate_private.partners_worker_commission_job_complete(
  p_job_key text,
  p_worker_id text,
  p_lease_token_hash text,
  p_outcome text,
  p_error_code text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_job_key text := lower(btrim(coalesce(p_job_key, '')));
  v_worker text := btrim(coalesce(p_worker_id, ''));
  v_token text := lower(btrim(coalesce(p_lease_token_hash, '')));
  v_outcome text := lower(btrim(coalesce(p_outcome, '')));
  v_error text := nullif(lower(btrim(coalesce(p_error_code, ''))), '');
  v_job affiliate_private.affiliate_commission_jobs%rowtype;
  v_fact affiliate_private.affiliate_financial_facts%rowtype;
  v_origin_fact affiliate_private.affiliate_financial_facts%rowtype;
  v_attribution affiliate_private.affiliate_attributions%rowtype;
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_program affiliate_private.affiliate_program_versions%rowtype;
  v_origin_entry affiliate_private.affiliate_commission_entries%rowtype;
  v_entry affiliate_private.affiliate_commission_entries%rowtype;
  v_amount bigint;
  v_already_reversed bigint := 0;
  v_recovery_route jsonb;
  v_status text;
  v_delay_seconds integer;
begin
  if v_job_key !~ '^job_[0-9a-f]{24}$'
    or v_worker !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$'
    or v_token !~ '^[0-9a-f]{64}$'
    or v_outcome not in ('succeeded', 'retry', 'dead_letter')
    or (
      v_outcome in ('retry', 'dead_letter')
      and (v_error is null or v_error !~ '^[a-z][a-z0-9_]{2,63}$')
    )
  then
    raise exception 'invalid commission completion request'
      using errcode = '22023';
  end if;

  select j.*
  into v_job
  from affiliate_private.affiliate_commission_jobs j
  where j.job_key = v_job_key
  for update;
  if not found then
    raise exception 'commission job is unavailable'
      using errcode = 'P0006';
  end if;
  if v_job.status <> 'leased'
    or v_job.worker_id <> v_worker
    or v_job.lease_token_hash <> v_token
    or v_job.leased_until <= now()
  then
    raise exception 'commission job lease is unavailable'
      using errcode = 'P0004';
  end if;

  if v_outcome = 'retry' and v_job.attempts >= 12 then
    update affiliate_private.affiliate_commission_jobs
    set
      status = 'dead_letter',
      worker_id = null,
      lease_token_hash = null,
      leased_until = null,
      last_error_code = coalesce(v_error, 'retry_exhausted'),
      completed_at = now(),
      updated_at = now()
    where id = v_job.id
    returning status into v_status;
  elsif v_outcome = 'retry' then
    v_delay_seconds := least(
      3600,
      (30 * power(2::numeric, least(v_job.attempts, 7)))::integer
    );
    update affiliate_private.affiliate_commission_jobs
    set
      status = 'retry',
      worker_id = null,
      lease_token_hash = null,
      leased_until = null,
      next_attempt_at = now() + make_interval(secs => v_delay_seconds),
      last_error_code = v_error,
      updated_at = now()
    where id = v_job.id
    returning status into v_status;
  elsif v_outcome = 'dead_letter' then
    update affiliate_private.affiliate_commission_jobs
    set
      status = 'dead_letter',
      worker_id = null,
      lease_token_hash = null,
      leased_until = null,
      last_error_code = v_error,
      completed_at = now(),
      updated_at = now()
    where id = v_job.id
    returning status into v_status;
  else
    select f.*
    into v_fact
    from affiliate_private.affiliate_financial_facts f
    where f.id = v_job.fact_id;
    if not found
      or v_fact.facts_status <> 'complete'
      or v_fact.environment <> 'production'
      or v_fact.eligible_minor is null
      or v_fact.currency is null
      or v_fact.currency_exponent is null
    then
      raise exception 'commission fact is not executable'
        using errcode = 'P0004';
    end if;

    select a.*
    into v_attribution
    from affiliate_private.affiliate_attributions a
    where a.id = coalesce(
      v_fact.attribution_id,
      (
        select l.attribution_id
        from affiliate_private.affiliate_financial_fact_lineage_links l
        where l.child_fact_id = v_fact.id
      )
    )
    for update;
    if not found
      or (
        v_job.job_kind = 'accrual'
        and v_attribution.status not in ('attributed', 'qualified')
      )
    then
      raise exception 'attribution is not commissionable'
        using errcode = 'P0004';
    end if;

    select a.*
    into v_account
    from affiliate_private.affiliate_accounts a
    where a.id = v_attribution.referrer_account_id
    for update;
    if not found
      or (
        v_job.job_kind = 'accrual'
        and v_account.status <> 'active'
      )
    then
      raise exception 'Partner account is not commissionable'
        using errcode = 'P0004';
    end if;

    select p.*
    into v_program
    from affiliate_private.affiliate_program_versions p
    where p.id = v_attribution.program_version_id;
    if not found
      or v_program.commission_rate_bps
        <> v_attribution.commission_rate_bps
      or v_program.maturation_days <> 45
    then
      raise exception 'commission program snapshot is unavailable'
        using errcode = '55000';
    end if;

    v_amount := affiliate_private.partners_commission_minor(
      v_fact.eligible_minor,
      v_attribution.commission_rate_bps
    );

    if v_job.job_kind = 'accrual' then
      if v_fact.event_type not in ('capture', 'renewal') then
        raise exception 'accrual job has incompatible fact'
          using errcode = '55000';
      end if;

      if v_amount > 0 then
        insert into affiliate_private.affiliate_commission_entries (
          account_id,
          attribution_id,
          fact_id,
          entry_kind,
          currency,
          currency_exponent,
          amount_minor,
          matures_at
        )
        values (
          v_account.id,
          v_attribution.id,
          v_fact.id,
          'accrual',
          v_fact.currency,
          v_fact.currency_exponent,
          v_amount,
          v_fact.occurred_at
            + make_interval(days => v_program.maturation_days)
        )
        on conflict (entry_kind, fact_id) do nothing
        returning * into v_entry;

        if v_entry.id is null then
          select e.*
          into v_entry
          from affiliate_private.affiliate_commission_entries e
          where e.entry_kind = 'accrual'
            and e.fact_id = v_fact.id;
        else
          insert into affiliate_private.affiliate_commission_postings (
            entry_id, ledger_account, direction, amount_minor, currency
          )
          values
            (
              v_entry.id,
              'platform_commission_expense',
              'debit',
              v_amount,
              v_fact.currency
            ),
            (
              v_entry.id,
              'partner_commission_pending',
              'credit',
              v_amount,
              v_fact.currency
            );

          insert into affiliate_private.affiliate_maturation_jobs (
            accrual_entry_id,
            available_at,
            next_attempt_at
          )
          values (
            v_entry.id,
            v_entry.matures_at,
            v_entry.matures_at
          );
        end if;
      end if;
    else
      if v_fact.event_type not in ('refund', 'chargeback') then
        raise exception 'reversal job has incompatible fact'
          using errcode = '55000';
      end if;

      select f.*
      into v_origin_fact
      from affiliate_private.affiliate_financial_facts f
      where f.environment = v_fact.environment
        and f.rail = v_fact.rail
        and f.transaction_hash = v_fact.parent_transaction_hash
        and f.event_type in ('capture', 'renewal')
      order by f.created_at
      limit 1;
      select e.*
      into v_origin_entry
      from affiliate_private.affiliate_commission_entries e
      where e.fact_id = v_origin_fact.id
        and e.entry_kind = 'accrual'
      for update;
      if v_origin_entry.id is null then
        raise exception 'origin accrual is not ready'
          using errcode = 'P0004';
      end if;

      select coalesce(sum(e.amount_minor), 0)
      into v_already_reversed
      from affiliate_private.affiliate_commission_entries e
      where e.related_entry_id = v_origin_entry.id
        and e.entry_kind in ('reversal', 'manual_reversal');
      v_amount := least(
        v_amount,
        greatest(v_origin_entry.amount_minor - v_already_reversed, 0)
      );

      if v_amount > 0 then
        insert into affiliate_private.affiliate_commission_entries (
          account_id,
          attribution_id,
          fact_id,
          entry_kind,
          related_entry_id,
          currency,
          currency_exponent,
          amount_minor
        )
        values (
          v_account.id,
          v_attribution.id,
          v_fact.id,
          'reversal',
          v_origin_entry.id,
          v_fact.currency,
          v_fact.currency_exponent,
          v_amount
        )
        on conflict (entry_kind, fact_id) do nothing
        returning * into v_entry;

        if v_entry.id is not null then
          v_recovery_route :=
            affiliate_private.partners_route_commission_recovery(
              v_entry.id,
              v_account.id,
              v_fact.currency,
              v_amount,
              not exists (
                select 1
                from affiliate_private.affiliate_commission_entries release
                where release.related_entry_id = v_origin_entry.id
                  and release.entry_kind = 'release'
              )
            );
        end if;
      end if;
    end if;

    update affiliate_private.affiliate_commission_jobs
    set
      status = 'succeeded',
      worker_id = null,
      lease_token_hash = null,
      leased_until = null,
      last_error_code = null,
      completed_at = now(),
      updated_at = now()
    where id = v_job.id
    returning status into v_status;

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
      'commission',
      v_job.job_key,
      'commission_job_succeeded',
      'system',
      v_account.user_pseudonym,
      'Commission worker appended a balanced ledger transaction.',
      jsonb_build_object(
        'job_kind', v_job.job_kind,
        'entry_key', v_entry.entry_key,
        'amount_minor', coalesce(v_entry.amount_minor, 0),
        'currency', v_fact.currency,
        'recovery_route', v_recovery_route
      )
    );
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'commission_job_completed',
    'job', jsonb_build_object(
      'key', v_job.job_key,
      'status', v_status
    ),
    'ledger_entry', case
      when v_entry.id is null then null
      else jsonb_build_object(
        'key', v_entry.entry_key,
        'status', case
          when v_entry.entry_kind = 'accrual' then 'pending'
          when v_entry.entry_kind = 'release' then 'available'
          else 'reversed'
        end,
        'matures_at', v_entry.matures_at
      )
    end
  );
end;
$$;

create or replace function
affiliate_private.partners_worker_maturation_lease(
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
  v_token text := lower(btrim(coalesce(p_lease_token_hash, '')));
  v_until timestamptz;
  v_jobs jsonb;
begin
  if v_worker !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$'
    or v_token !~ '^[0-9a-f]{64}$'
    or p_limit is null
    or p_limit not between 1 and 50
    or p_lease_seconds is null
    or p_lease_seconds not between 15 and 300
  then
    raise exception 'invalid maturation lease request'
      using errcode = '22023';
  end if;

  v_until := now() + make_interval(secs => p_lease_seconds);
  update affiliate_private.affiliate_maturation_jobs
  set
    status = 'dead_letter',
    worker_id = null,
    lease_token_hash = null,
    leased_until = null,
    last_error_code = 'retry_exhausted',
    completed_at = now(),
    updated_at = now()
  where attempts >= 12
    and (
      status in ('pending', 'retry')
      or (status = 'leased' and leased_until <= now())
    );

  with candidates as (
    select j.id
    from affiliate_private.affiliate_maturation_jobs j
    where j.available_at <= now()
      and (
        (j.status in ('pending', 'retry') and j.next_attempt_at <= now())
        or (j.status = 'leased' and j.leased_until <= now())
      )
      and j.attempts < 12
    order by j.available_at, j.created_at
    for update skip locked
    limit p_limit
  ),
  leased as (
    update affiliate_private.affiliate_maturation_jobs j
    set
      status = 'leased',
      worker_id = v_worker,
      lease_token_hash = v_token,
      leased_until = v_until,
      attempts = j.attempts + 1,
      updated_at = now()
    from candidates c
    where j.id = c.id
    returning j.job_key, j.accrual_entry_id
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'key', l.job_key,
        'ledger_entry_key', e.entry_key
      )
      order by l.job_key
    ),
    '[]'::jsonb
  )
  into v_jobs
  from leased l
  join affiliate_private.affiliate_commission_entries e
    on e.id = l.accrual_entry_id;

  return jsonb_build_object(
    'schema_version', 1,
    'leased_until', v_until,
    'jobs', v_jobs
  );
end;
$$;

create or replace function
affiliate_private.partners_worker_maturation_complete(
  p_job_key text,
  p_worker_id text,
  p_lease_token_hash text,
  p_outcome text,
  p_error_code text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_job_key text := lower(btrim(coalesce(p_job_key, '')));
  v_worker text := btrim(coalesce(p_worker_id, ''));
  v_token text := lower(btrim(coalesce(p_lease_token_hash, '')));
  v_outcome text := lower(btrim(coalesce(p_outcome, '')));
  v_error text := nullif(lower(btrim(coalesce(p_error_code, ''))), '');
  v_job affiliate_private.affiliate_maturation_jobs%rowtype;
  v_accrual affiliate_private.affiliate_commission_entries%rowtype;
  v_entry affiliate_private.affiliate_commission_entries%rowtype;
  v_attribution affiliate_private.affiliate_attributions%rowtype;
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_reversed bigint := 0;
  v_amount bigint := 0;
  v_status text;
  v_delay_seconds integer;
begin
  if v_job_key !~ '^mat_[0-9a-f]{24}$'
    or v_worker !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$'
    or v_token !~ '^[0-9a-f]{64}$'
    or v_outcome not in ('succeeded', 'retry', 'dead_letter')
    or (
      v_outcome in ('retry', 'dead_letter')
      and (v_error is null or v_error !~ '^[a-z][a-z0-9_]{2,63}$')
    )
  then
    raise exception 'invalid maturation completion request'
      using errcode = '22023';
  end if;

  select j.*
  into v_job
  from affiliate_private.affiliate_maturation_jobs j
  where j.job_key = v_job_key
  for update;
  if not found then
    raise exception 'maturation job is unavailable'
      using errcode = 'P0006';
  end if;
  if v_job.status <> 'leased'
    or v_job.worker_id <> v_worker
    or v_job.lease_token_hash <> v_token
    or v_job.leased_until <= now()
  then
    raise exception 'maturation lease is unavailable'
      using errcode = 'P0004';
  end if;

  if v_outcome = 'retry' and v_job.attempts >= 12 then
    update affiliate_private.affiliate_maturation_jobs
    set
      status = 'dead_letter',
      worker_id = null,
      lease_token_hash = null,
      leased_until = null,
      last_error_code = coalesce(v_error, 'retry_exhausted'),
      completed_at = now(),
      updated_at = now()
    where id = v_job.id
    returning status into v_status;
  elsif v_outcome = 'retry' then
    v_delay_seconds := least(
      3600,
      (30 * power(2::numeric, least(v_job.attempts, 7)))::integer
    );
    update affiliate_private.affiliate_maturation_jobs
    set
      status = 'retry',
      worker_id = null,
      lease_token_hash = null,
      leased_until = null,
      next_attempt_at = now() + make_interval(secs => v_delay_seconds),
      last_error_code = v_error,
      updated_at = now()
    where id = v_job.id
    returning status into v_status;
  elsif v_outcome = 'dead_letter' then
    update affiliate_private.affiliate_maturation_jobs
    set
      status = 'dead_letter',
      worker_id = null,
      lease_token_hash = null,
      leased_until = null,
      last_error_code = v_error,
      completed_at = now(),
      updated_at = now()
    where id = v_job.id
    returning status into v_status;
  else
    select e.*
    into v_accrual
    from affiliate_private.affiliate_commission_entries e
    where e.id = v_job.accrual_entry_id
      and e.entry_kind = 'accrual'
    for update;
    if not found or v_job.available_at > now() then
      raise exception 'accrual has not matured'
        using errcode = 'P0004';
    end if;

    select a.*
    into v_attribution
    from affiliate_private.affiliate_attributions a
    where a.id = v_accrual.attribution_id
    for update;
    select a.*
    into v_account
    from affiliate_private.affiliate_accounts a
    where a.id = v_accrual.account_id
    for update;

    if v_attribution.id is null
      or v_attribution.status not in ('attributed', 'qualified')
      or v_account.id is null
      or v_account.status <> 'active'
    then
      raise exception 'maturation is held for review'
        using errcode = 'P0004';
    end if;

    select coalesce(sum(e.amount_minor), 0)
    into v_reversed
    from affiliate_private.affiliate_commission_entries e
    where e.related_entry_id = v_accrual.id
      and e.entry_kind in ('reversal', 'manual_reversal');
    v_amount := greatest(v_accrual.amount_minor - v_reversed, 0);

    if v_amount > 0 then
      perform affiliate_private.partners_balance_lock(
        v_accrual.account_id,
        v_accrual.currency
      );
      insert into affiliate_private.affiliate_commission_entries (
        account_id,
        attribution_id,
        fact_id,
        entry_kind,
        related_entry_id,
        currency,
        currency_exponent,
        amount_minor
      )
      values (
        v_accrual.account_id,
        v_accrual.attribution_id,
        v_accrual.fact_id,
        'release',
        v_accrual.id,
        v_accrual.currency,
        v_accrual.currency_exponent,
        v_amount
      )
      on conflict (entry_kind, fact_id) do nothing
      returning * into v_entry;

      if v_entry.id is not null then
        insert into affiliate_private.affiliate_commission_postings (
          entry_id, ledger_account, direction, amount_minor, currency
        )
        values
          (
            v_entry.id,
            'partner_commission_pending',
            'debit',
            v_amount,
            v_accrual.currency
          ),
          (
            v_entry.id,
            'partner_commission_available',
            'credit',
            v_amount,
            v_accrual.currency
          );
        perform affiliate_private.partners_recovery_due_consume(
          v_accrual.account_id,
          v_accrual.currency
        );
      end if;
    end if;

    update affiliate_private.affiliate_maturation_jobs
    set
      status = 'succeeded',
      worker_id = null,
      lease_token_hash = null,
      leased_until = null,
      last_error_code = null,
      completed_at = now(),
      updated_at = now()
    where id = v_job.id
    returning status into v_status;
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'maturation_job_completed',
    'job', jsonb_build_object(
      'key', v_job.job_key,
      'status', v_status
    ),
    'ledger_entry', case
      when v_entry.id is null then null
      else jsonb_build_object(
        'key', v_entry.entry_key,
        'status', 'available',
        'matures_at', null
      )
    end
  );
end;
$$;

create or replace function
affiliate_private.partners_worker_shadow_reconcile(
  p_worker_id text,
  p_window_start timestamptz,
  p_window_end timestamptz,
  p_dry_run boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_worker text := btrim(coalesce(p_worker_id, ''));
  v_run affiliate_private.affiliate_shadow_reconciliation_runs%rowtype;
  v_facts bigint := 0;
  v_entries bigint := 0;
  v_missing_entries bigint := 0;
  v_orphan_entries bigint := 0;
  v_amount_mismatches bigint := 0;
  v_missing_reversals bigint := 0;
  v_invalid_reversals bigint := 0;
  v_over_reversed bigint := 0;
  v_missing_releases bigint := 0;
  v_invalid_releases bigint := 0;
  v_conflicted_facts bigint := 0;
  v_mismatches bigint := 0;
begin
  if v_worker !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$'
    or p_window_start is null
    or p_window_end is null
    or p_window_end <= p_window_start
    or p_window_end > p_window_start + interval '31 days'
    or p_window_end > now() + interval '5 minutes'
    or p_dry_run is null
  then
    raise exception 'invalid reconciliation window'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:reconcile:'
        || p_window_start::text
        || ':'
        || p_window_end::text,
      0
    )
  );

  select count(*)
  into v_facts
  from affiliate_private.affiliate_financial_facts f
  where f.environment = 'production'
    and f.facts_status = 'complete'
    and f.event_type in ('capture', 'renewal')
    and f.attribution_id is not null
    and f.occurred_at >= p_window_start
    and f.occurred_at < p_window_end;

  select count(*)
  into v_entries
  from affiliate_private.affiliate_commission_entries e
  join affiliate_private.affiliate_financial_facts f on f.id = e.fact_id
  where e.entry_kind = 'accrual'
    and f.occurred_at >= p_window_start
    and f.occurred_at < p_window_end;

  select count(*)
  into v_missing_entries
  from affiliate_private.affiliate_financial_facts f
  join affiliate_private.affiliate_attributions a
    on a.id = f.attribution_id
  join affiliate_private.affiliate_accounts account
    on account.id = a.referrer_account_id
  where f.environment = 'production'
    and f.facts_status = 'complete'
    and f.event_type in ('capture', 'renewal')
    and f.occurred_at >= p_window_start
    and f.occurred_at < p_window_end
    and a.status in ('attributed', 'qualified')
    and account.status = 'active'
    and affiliate_private.partners_commission_minor(
      f.eligible_minor,
      a.commission_rate_bps
    ) > 0
    and not exists (
      select 1
      from affiliate_private.affiliate_commission_entries e
      where e.fact_id = f.id
        and e.entry_kind = 'accrual'
    );

  select count(*)
  into v_orphan_entries
  from affiliate_private.affiliate_commission_entries e
  left join affiliate_private.affiliate_financial_facts f on f.id = e.fact_id
  where e.entry_kind = 'accrual'
    and e.created_at >= p_window_start
    and e.created_at < p_window_end
    and (
      f.id is null
      or f.environment <> 'production'
      or f.facts_status <> 'complete'
      or f.event_type not in ('capture', 'renewal')
    );

  select count(*)
  into v_amount_mismatches
  from affiliate_private.affiliate_commission_entries e
  join affiliate_private.affiliate_financial_facts f on f.id = e.fact_id
  join affiliate_private.affiliate_attributions a
    on a.id = e.attribution_id
  where e.entry_kind = 'accrual'
    and f.occurred_at >= p_window_start
    and f.occurred_at < p_window_end
    and e.amount_minor <> affiliate_private.partners_commission_minor(
      f.eligible_minor,
      a.commission_rate_bps
    );

  select count(*)
  into v_missing_reversals
  from affiliate_private.affiliate_financial_facts f
  where f.environment = 'production'
    and f.facts_status in ('complete', 'quarantined')
    and f.event_type in ('refund', 'chargeback')
    and f.occurred_at >= p_window_start
    and f.occurred_at < p_window_end
    and (
      f.attribution_id is not null
      or exists (
        select 1
        from affiliate_private.affiliate_financial_fact_lineage_links link
        where link.child_fact_id = f.id
      )
    )
    and exists (
      select 1
      from affiliate_private.affiliate_financial_facts origin
      where origin.environment = f.environment
        and origin.rail = f.rail
        and origin.transaction_hash = f.parent_transaction_hash
        and origin.event_type in ('capture', 'renewal')
        and (
          exists (
            select 1
            from affiliate_private.affiliate_commission_entries origin_entry
            where origin_entry.fact_id = origin.id
              and origin_entry.entry_kind = 'accrual'
          )
          or exists (
            select 1
            from affiliate_private.affiliate_commission_jobs origin_job
            where origin_job.fact_id = origin.id
              and origin_job.job_kind = 'accrual'
          )
        )
    )
    and not exists (
      select 1
      from affiliate_private.affiliate_commission_entries e
      where e.fact_id = f.id
        and e.entry_kind = 'reversal'
    );

  select count(*)
  into v_invalid_reversals
  from affiliate_private.affiliate_commission_entries e
  join affiliate_private.affiliate_financial_facts f on f.id = e.fact_id
  join affiliate_private.affiliate_attributions a
    on a.id = e.attribution_id
  join affiliate_private.affiliate_commission_entries origin
    on origin.id = e.related_entry_id
  where e.entry_kind = 'reversal'
    and e.created_at >= p_window_start
    and e.created_at < p_window_end
    and (
      f.event_type not in ('refund', 'chargeback')
      or origin.entry_kind <> 'accrual'
      or origin.currency <> e.currency
      or origin.currency_exponent <> e.currency_exponent
      or e.amount_minor > affiliate_private.partners_commission_minor(
        f.eligible_minor,
        a.commission_rate_bps
      )
    );

  select count(*)
  into v_over_reversed
  from (
    select origin.id
    from affiliate_private.affiliate_commission_entries origin
    join affiliate_private.affiliate_commission_entries reversal
      on reversal.related_entry_id = origin.id
      and reversal.entry_kind in ('reversal', 'manual_reversal')
    where origin.entry_kind = 'accrual'
      and reversal.created_at >= p_window_start
      and reversal.created_at < p_window_end
    group by origin.id, origin.amount_minor
    having sum(reversal.amount_minor) > origin.amount_minor
  ) excessive;

  select count(*)
  into v_missing_releases
  from affiliate_private.affiliate_commission_entries accrual
  where accrual.entry_kind = 'accrual'
    and accrual.matures_at <= least(now(), p_window_end)
    and accrual.matures_at >= p_window_start
    and greatest(
      accrual.amount_minor - coalesce((
        select sum(r.amount_minor)
        from affiliate_private.affiliate_commission_entries r
        where r.related_entry_id = accrual.id
          and r.entry_kind in ('reversal', 'manual_reversal')
      ), 0),
      0
    ) > 0
    and not exists (
      select 1
      from affiliate_private.affiliate_commission_entries release
      where release.related_entry_id = accrual.id
        and release.entry_kind = 'release'
    );

  select count(*)
  into v_invalid_releases
  from affiliate_private.affiliate_commission_entries release
  join affiliate_private.affiliate_commission_entries accrual
    on accrual.id = release.related_entry_id
  where release.entry_kind = 'release'
    and release.created_at >= p_window_start
    and release.created_at < p_window_end
    and (
      accrual.entry_kind <> 'accrual'
      or release.currency <> accrual.currency
      or release.currency_exponent <> accrual.currency_exponent
      or release.amount_minor <> greatest(
        accrual.amount_minor - coalesce((
          select sum(r.amount_minor)
          from affiliate_private.affiliate_commission_entries r
          where r.related_entry_id = accrual.id
            and r.entry_kind in ('reversal', 'manual_reversal')
            and r.created_at <= release.created_at
        ), 0),
        0
      )
    );

  select count(distinct c.fact_id)
  into v_conflicted_facts
  from affiliate_private.affiliate_financial_fact_conflicts c
  where c.observed_at >= p_window_start
    and c.observed_at < p_window_end;

  v_mismatches :=
    v_missing_entries
    + v_orphan_entries
    + v_amount_mismatches
    + v_missing_reversals
    + v_invalid_reversals
    + v_over_reversed
    + v_missing_releases
    + v_invalid_releases
    + v_conflicted_facts;

  insert into affiliate_private.affiliate_shadow_reconciliation_runs (
    worker_id,
    window_start,
    window_end,
    dry_run,
    status,
    facts_count,
    ledger_entries_count,
    mismatch_count
  )
  values (
    v_worker,
    p_window_start,
    p_window_end,
    p_dry_run,
    case when v_mismatches = 0 then 'clean' else 'mismatch' end,
    v_facts,
    v_entries,
    v_mismatches
  )
  returning * into v_run;

  return jsonb_build_object(
    'schema_version', 1,
    'run', jsonb_build_object(
      'key', v_run.run_key,
      'status', v_run.status,
      'facts', v_run.facts_count,
      'ledger_entries', v_run.ledger_entries_count,
      'mismatches', v_run.mismatch_count,
      'dry_run', v_run.dry_run
    )
  );
end;
$$;

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
    or v_status not in ('pending', 'verified', 'rejected', 'expired')
  then
    raise exception 'invalid tokenized fiscal result'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:fiscal:' || p_user_id::text, 0)
  );
  select a.*
  into v_account
  from affiliate_private.affiliate_accounts a
  where a.user_id = p_user_id
    and a.account_type = 'individual'
    and a.status <> 'closed'
  for update;
  if not found then
    raise exception 'Partners account is unavailable'
      using errcode = 'P0002';
  end if;
  if v_account.country_code <> v_country then
    raise exception 'fiscal residence conflicts with account policy'
      using errcode = 'P0001';
  end if;

  insert into affiliate_private.affiliate_fiscal_profiles (
    account_id,
    residence_country_code,
    status,
    verification_provider,
    verification_reference_hash,
    tax_form_type,
    reviewed_at,
    updated_at
  )
  values (
    v_account.id,
    v_country,
    v_status,
    v_provider,
    v_reference,
    v_form,
    case when v_status = 'verified' then now() else null end,
    now()
  )
  on conflict (account_id) do update
  set
    residence_country_code = excluded.residence_country_code,
    status = excluded.status,
    verification_provider = excluded.verification_provider,
    verification_reference_hash = excluded.verification_reference_hash,
    tax_form_type = excluded.tax_form_type,
    reviewed_at = excluded.reviewed_at,
    updated_at = now()
  returning * into v_profile;

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
affiliate_private.partners_service_payout_profile_get(
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
  v_fiscal affiliate_private.affiliate_fiscal_profiles%rowtype;
  v_profile affiliate_private.affiliate_payout_profiles%rowtype;
  v_profiles jsonb := '[]'::jsonb;
  v_payouts_live boolean := false;
  v_provider_ready boolean := false;
  v_ready boolean := false;
  v_reason text;
begin
  if p_user_id is null then
    raise exception 'user id is required'
      using errcode = '22023';
  end if;
  select a.*
  into v_account
  from affiliate_private.affiliate_accounts a
  where a.user_id = p_user_id
    and a.status <> 'closed';
  if not found then
    raise exception 'Partners account is unavailable'
      using errcode = 'P0002';
  end if;
  select f.*
  into v_fiscal
  from affiliate_private.affiliate_fiscal_profiles f
  where f.account_id = v_account.id;
  select p.*
  into v_profile
  from affiliate_private.affiliate_payout_profiles p
  where p.account_id = v_account.id
  order by
    case
      when p.status = 'active'
        and exists (
          select 1
          from affiliate_private.affiliate_payout_provider_configs c
          where c.provider = p.provider
            and c.country_code = v_account.country_code
            and c.currency = p.currency
            and c.status = 'active'
        )
        then 0
      else 1
    end,
    p.currency,
    p.id
  limit 1;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'provider', p.provider,
        'display_masked', p.display_masked,
        'currency', p.currency,
        'status', p.status
      )
      order by p.currency, p.id
    ),
    '[]'::jsonb
  )
  into v_profiles
  from affiliate_private.affiliate_payout_profiles p
  where p.account_id = v_account.id;

  select coalesce(f.enabled, false)
  into v_payouts_live
  from public.admin_feature_flags f
  where f.key = 'partners_payouts_live';
  v_payouts_live := coalesce(v_payouts_live, false);

  if v_profile.id is not null then
    select exists (
      select 1
      from affiliate_private.affiliate_payout_provider_configs c
      where c.provider = v_profile.provider
        and c.country_code = v_account.country_code
        and c.currency = v_profile.currency
        and c.status = 'active'
    )
    into v_provider_ready;
  end if;

  v_ready :=
    v_account.status = 'active'
    and v_account.verification_status = 'verified'
    and coalesce(v_fiscal.status = 'verified', false)
    and coalesce(v_profile.status = 'active', false)
    and v_provider_ready
    and v_payouts_live;
  v_reason := case
    when v_account.status <> 'active' then 'account_not_active'
    when v_account.verification_status <> 'verified'
      then 'kyc_not_verified'
    when v_fiscal.status is distinct from 'verified'
      then 'fiscal_profile_required'
    when v_profile.id is null or not v_provider_ready
      then 'provider_not_configured'
    when not v_payouts_live then 'payouts_not_live'
    else null
  end;

  return jsonb_build_object(
    'schema_version', 1,
    'account', jsonb_build_object(
      'id', affiliate_private.partners_public_account_id(v_account),
      'status', v_account.status
    ),
    'fiscal', case
      when v_fiscal.account_id is null then null
      else jsonb_build_object(
        'status', v_fiscal.status,
        'country_code', v_fiscal.residence_country_code
      )
    end,
    'profile', case
      when v_profile.id is null then null
      else jsonb_build_object(
        'provider', v_profile.provider,
        'display_masked', v_profile.display_masked,
        'currency', v_profile.currency,
        'status', v_profile.status
      )
    end,
    'profiles', v_profiles,
    'readiness', jsonb_build_object(
      'ready', v_ready,
      'payouts_live', v_payouts_live,
      'reason', v_reason
    )
  );
end;
$$;

create or replace function public.partners_worker_financial_fact_ingest(
  p_source_event_hash text,
  p_payload_hash text,
  p_transaction_hash text,
  p_parent_transaction_hash text,
  p_referred_user_id uuid,
  p_rail text,
  p_event_type text,
  p_environment text,
  p_currency text,
  p_currency_exponent integer,
  p_gross_minor bigint,
  p_discount_minor bigint,
  p_tax_minor bigint,
  p_eligible_minor bigint,
  p_observed_at timestamptz
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_worker_financial_fact_ingest(
    p_source_event_hash,
    p_payload_hash,
    p_transaction_hash,
    p_parent_transaction_hash,
    p_referred_user_id,
    p_rail,
    p_event_type,
    p_environment,
    p_currency,
    p_currency_exponent,
    p_gross_minor,
    p_discount_minor,
    p_tax_minor,
    p_eligible_minor,
    p_observed_at
  );
$$;

create or replace function
public.partners_worker_financial_observation_required(
  p_user_id uuid
)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select
    affiliate_private.partners_worker_financial_observation_required(
      p_user_id
    );
$$;

create or replace function
public.partners_worker_currency_exponent_resolve(
  p_currency text
)
returns integer
language sql
stable
security invoker
set search_path = ''
as $$
  select
    affiliate_private.partners_worker_currency_exponent_resolve(p_currency);
$$;

create or replace function public.partners_worker_commission_jobs_lease(
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
  select affiliate_private.partners_worker_commission_jobs_lease(
    p_worker_id,
    p_lease_token_hash,
    p_limit,
    p_lease_seconds
  );
$$;

create or replace function public.partners_worker_commission_job_complete(
  p_job_key text,
  p_worker_id text,
  p_lease_token_hash text,
  p_outcome text,
  p_error_code text default null
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_worker_commission_job_complete(
    p_job_key,
    p_worker_id,
    p_lease_token_hash,
    p_outcome,
    p_error_code
  );
$$;

create or replace function public.partners_worker_maturation_lease(
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
  select affiliate_private.partners_worker_maturation_lease(
    p_worker_id,
    p_lease_token_hash,
    p_limit,
    p_lease_seconds
  );
$$;

create or replace function public.partners_worker_maturation_complete(
  p_job_key text,
  p_worker_id text,
  p_lease_token_hash text,
  p_outcome text,
  p_error_code text default null
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_worker_maturation_complete(
    p_job_key,
    p_worker_id,
    p_lease_token_hash,
    p_outcome,
    p_error_code
  );
$$;

create or replace function public.partners_worker_shadow_reconcile(
  p_worker_id text,
  p_window_start timestamptz,
  p_window_end timestamptz,
  p_dry_run boolean
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_worker_shadow_reconcile(
    p_worker_id,
    p_window_start,
    p_window_end,
    p_dry_run
  );
$$;

create or replace function public.partners_service_fiscal_profile_record(
  p_user_id uuid,
  p_provider text,
  p_provider_reference_hash text,
  p_residence_country_code text,
  p_tax_form_type text,
  p_status text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_fiscal_profile_record(
    p_user_id,
    p_provider,
    p_provider_reference_hash,
    p_residence_country_code,
    p_tax_form_type,
    p_status
  );
$$;

create or replace function public.partners_service_payout_profile_get(
  p_user_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_payout_profile_get(p_user_id);
$$;

create or replace function public.partners_service_payout_profile_set(
  p_user_id uuid,
  p_idempotency_key text,
  p_provider text,
  p_beneficiary_token_ref text,
  p_display_masked text,
  p_currency text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  execute
    'select affiliate_private.partners_service_payout_profile_set('
      || '$1, $2, $3, $4, $5, $6)'
    into v_result
    using
      p_user_id,
      p_idempotency_key,
      p_provider,
      p_beneficiary_token_ref,
      p_display_masked,
      p_currency;
  return v_result;
end;
$$;

revoke all on function
  affiliate_private.reject_partners_finance_mutation()
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.assert_commission_entry_balanced()
  from public, anon, authenticated, service_role;
revoke all on function affiliate_private.partners_commission_minor(
  bigint, integer
) from public, anon, authenticated, service_role;
revoke all on function affiliate_private.partners_balance_lock(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_account_payable_balance(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_recovery_due_consume(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_payout_balance_authoritative(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_route_commission_recovery(
    uuid, uuid, text, bigint, boolean
  )
  from public, anon, authenticated, service_role;

revoke all on function
  affiliate_private.partners_worker_financial_fact_ingest(
    text, text, text, text, uuid, text, text, text, text, integer,
    bigint, bigint, bigint, bigint, timestamptz
  )
  from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_worker_financial_fact_ingest(
    text, text, text, text, uuid, text, text, text, text, integer,
    bigint, bigint, bigint, bigint, timestamptz
  )
  to service_role;

revoke all on function
  affiliate_private.partners_worker_financial_observation_required(uuid)
  from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_worker_financial_observation_required(uuid)
  to service_role;

revoke all on function
  affiliate_private.partners_worker_currency_exponent_resolve(text)
  from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_worker_currency_exponent_resolve(text)
  to service_role;

revoke all on function
  affiliate_private.partners_worker_commission_jobs_lease(
    text, text, integer, integer
  )
  from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_worker_commission_jobs_lease(
    text, text, integer, integer
  )
  to service_role;

revoke all on function
  affiliate_private.partners_worker_commission_job_complete(
    text, text, text, text, text
  )
  from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_worker_commission_job_complete(
    text, text, text, text, text
  )
  to service_role;

revoke all on function
  affiliate_private.partners_worker_maturation_lease(
    text, text, integer, integer
  )
  from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_worker_maturation_lease(
    text, text, integer, integer
  )
  to service_role;

revoke all on function
  affiliate_private.partners_worker_maturation_complete(
    text, text, text, text, text
  )
  from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_worker_maturation_complete(
    text, text, text, text, text
  )
  to service_role;

revoke all on function
  affiliate_private.partners_worker_shadow_reconcile(
    text, timestamptz, timestamptz, boolean
  )
  from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_worker_shadow_reconcile(
    text, timestamptz, timestamptz, boolean
  )
  to service_role;

revoke all on function
  affiliate_private.partners_service_fiscal_profile_record(
    uuid, text, text, text, text, text
  )
  from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_service_fiscal_profile_record(
    uuid, text, text, text, text, text
  )
  to service_role;

revoke all on function
  affiliate_private.partners_service_payout_profile_get(uuid)
  from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_service_payout_profile_get(uuid)
  to service_role;

revoke all on function public.partners_worker_financial_fact_ingest(
  text, text, text, text, uuid, text, text, text, text, integer,
  bigint, bigint, bigint, bigint, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.partners_worker_financial_fact_ingest(
  text, text, text, text, uuid, text, text, text, text, integer,
  bigint, bigint, bigint, bigint, timestamptz
) to service_role;

revoke all on function
  public.partners_worker_financial_observation_required(uuid)
  from public, anon, authenticated, service_role;
grant execute on function
  public.partners_worker_financial_observation_required(uuid)
  to service_role;

revoke all on function
  public.partners_worker_currency_exponent_resolve(text)
  from public, anon, authenticated, service_role;
grant execute on function
  public.partners_worker_currency_exponent_resolve(text)
  to service_role;

revoke all on function public.partners_worker_commission_jobs_lease(
  text, text, integer, integer
) from public, anon, authenticated, service_role;
grant execute on function public.partners_worker_commission_jobs_lease(
  text, text, integer, integer
) to service_role;

revoke all on function public.partners_worker_commission_job_complete(
  text, text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.partners_worker_commission_job_complete(
  text, text, text, text, text
) to service_role;

revoke all on function public.partners_worker_maturation_lease(
  text, text, integer, integer
) from public, anon, authenticated, service_role;
grant execute on function public.partners_worker_maturation_lease(
  text, text, integer, integer
) to service_role;

revoke all on function public.partners_worker_maturation_complete(
  text, text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.partners_worker_maturation_complete(
  text, text, text, text, text
) to service_role;

revoke all on function public.partners_worker_shadow_reconcile(
  text, timestamptz, timestamptz, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.partners_worker_shadow_reconcile(
  text, timestamptz, timestamptz, boolean
) to service_role;

revoke all on function public.partners_service_fiscal_profile_record(
  uuid, text, text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.partners_service_fiscal_profile_record(
  uuid, text, text, text, text, text
) to service_role;

revoke all on function public.partners_service_payout_profile_get(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.partners_service_payout_profile_get(uuid)
  to service_role;

revoke all on function public.partners_service_payout_profile_set(
  uuid, text, text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.partners_service_payout_profile_set(
  uuid, text, text, text, text, text
) to service_role;

create or replace function
affiliate_private.partners_service_payout_profile_set(
  p_user_id uuid,
  p_idempotency_key text,
  p_provider text,
  p_beneficiary_token_ref text,
  p_display_masked text,
  p_currency text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_provider text := lower(btrim(coalesce(p_provider, '')));
  v_token text := btrim(coalesce(p_beneficiary_token_ref, ''));
  v_masked text := btrim(coalesce(p_display_masked, ''));
  v_currency text := upper(btrim(coalesce(p_currency, '')));
  v_request_hash text;
  v_replay jsonb;
  v_response jsonb;
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_fiscal affiliate_private.affiliate_fiscal_profiles%rowtype;
  v_profile affiliate_private.affiliate_payout_profiles%rowtype;
begin
  if p_user_id is null
    or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
    or v_provider not in ('wise', 'revolut', 'stripe_connect')
    or length(v_token) not between 8 and 255
    or v_token ~ '[[:space:][:cntrl:]]'
    or length(v_masked) not between 4 and 64
    or v_masked ~ '[[:cntrl:]]'
    or v_currency !~ '^[A-Z]{3}$'
  then
    raise exception 'invalid payout profile request'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:payout:' || p_user_id::text, 0)
  );
  v_request_hash := encode(
    extensions.digest(
      concat_ws(
        chr(31),
        'payout_profile:v1',
        p_user_id::text,
        v_provider,
        encode(extensions.digest(v_token, 'sha256'), 'hex'),
        v_masked,
        v_currency
      ),
      'sha256'
    ),
    'hex'
  );
  v_replay := affiliate_private.partners_replayed_response(
    'payout_profile',
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
    and a.account_type = 'individual'
  for update;
  if not found then
    raise exception 'Partners account is unavailable'
      using errcode = 'P0002';
  end if;
  if v_account.status <> 'active'
    or v_account.verification_status <> 'verified'
  then
    raise exception 'Partner is not ready for payout setup'
      using errcode = 'P0001';
  end if;

  select f.*
  into v_fiscal
  from affiliate_private.affiliate_fiscal_profiles f
  where f.account_id = v_account.id;
  if not found or v_fiscal.status <> 'verified' then
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
    where c.provider = v_provider
      and c.country_code = v_account.country_code
      and c.currency = v_currency
      and c.status = 'active'
  ) or not exists (
    select 1
    from affiliate_private.affiliate_country_policies cp
    where cp.id = v_account.country_policy_id
      and v_currency = any (cp.payout_currencies)
  ) then
    raise exception 'payout provider is not configured'
      using errcode = 'P0001';
  end if;

  insert into affiliate_private.affiliate_payout_profiles (
    account_id,
    provider,
    beneficiary_token_ref,
    display_masked,
    currency,
    status,
    updated_at
  )
  values (
    v_account.id,
    v_provider,
    v_token,
    v_masked,
    v_currency,
    'active',
    now()
  )
  on conflict (account_id, currency) do update
  set
    provider = excluded.provider,
    beneficiary_token_ref = excluded.beneficiary_token_ref,
    display_masked = excluded.display_masked,
    status = 'active',
    updated_at = now()
  returning * into v_profile;

  v_response := jsonb_build_object(
    'schema_version', 1,
    'action', 'payout_profile_saved',
    'replayed', false,
    'profile', jsonb_build_object(
      'provider', v_profile.provider,
      'display_masked', v_profile.display_masked,
      'currency', v_profile.currency,
      'status', v_profile.status
    )
  );
  perform affiliate_private.partners_store_response(
    'payout_profile',
    p_user_id,
    p_idempotency_key,
    v_request_hash,
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
    'payout',
    v_account.id::text,
    'payout_profile_saved',
    'service',
    v_account.user_pseudonym,
    'Tokenized individual payout destination was saved.',
    jsonb_build_object(
      'provider', v_profile.provider,
      'currency', v_profile.currency,
      'status', v_profile.status
    )
  );
  return v_response;
end;
$$;

revoke all on function
  affiliate_private.partners_service_payout_profile_set(
    uuid, text, text, text, text, text
  )
  from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_service_payout_profile_set(
    uuid, text, text, text, text, text
  )
  to service_role;
