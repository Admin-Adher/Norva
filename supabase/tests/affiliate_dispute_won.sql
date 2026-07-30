begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(32);

create temporary table dispute_won_test_state (
  scenario text primary key,
  job_key text not null
) on commit drop;
grant select, insert, update on table dispute_won_test_state to service_role;

select extensions.ok(
  not has_function_privilege(
    'anon',
    'public.partners_worker_revolut_dispute_won_enqueue(text,text,text,text,uuid,text,bigint,timestamp with time zone)',
    'EXECUTE'
  ),
  'anon cannot enqueue a financial correction'
);
select extensions.ok(
  not has_function_privilege(
    'authenticated',
    'public.partners_worker_revolut_dispute_won_enqueue(text,text,text,text,uuid,text,bigint,timestamp with time zone)',
    'EXECUTE'
  ),
  'authenticated clients cannot enqueue a financial correction'
);
select extensions.ok(
  has_function_privilege(
    'service_role',
    'public.partners_worker_revolut_dispute_won_enqueue(text,text,text,text,uuid,text,bigint,timestamp with time zone)',
    'EXECUTE'
  ),
  'service_role can enqueue a financial correction'
);
select extensions.ok(
  (
    select relation.relrowsecurity
    from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'affiliate_private'
      and relation.relname = 'affiliate_revolut_dispute_won_jobs'
  ),
  'the dispute-won inbox has RLS enabled'
);

insert into auth.users (
  id,
  instance_id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values
  (
    '20000000-0000-4000-8000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'dispute-won-referrer@example.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'dispute-won-referred@example.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

insert into affiliate_private.affiliate_program_versions (
  id,
  version_key,
  status,
  commission_rate_bps,
  attribution_window_days,
  maturation_days,
  payout_thresholds,
  terms_version,
  disclosure_version,
  effective_from
)
values (
  '21000000-0000-4000-8000-000000000001',
  'dispute-won-pgtap-v1',
  'active',
  2000,
  30,
  45,
  '{"USD":1000}'::jsonb,
  'partners-terms-v1',
  'partners-disclosure-v1',
  now() - interval '1 day'
);

insert into affiliate_private.affiliate_country_policies (
  id,
  program_version_id,
  country_code,
  individual_available,
  minimum_age,
  capacity_required,
  verification_level,
  verification_provider,
  payout_currencies,
  terms_version,
  disclosure_version,
  effective_from
)
values (
  '22000000-0000-4000-8000-000000000001',
  '21000000-0000-4000-8000-000000000001',
  'US',
  true,
  18,
  false,
  'identity_age_country',
  'didit',
  array['USD']::text[],
  'partners-terms-v1',
  'partners-disclosure-v1',
  now() - interval '1 day'
);

insert into affiliate_private.affiliate_accounts (
  id,
  user_id,
  user_pseudonym,
  status,
  program_version_id,
  country_policy_id,
  country_code,
  verification_status,
  verification_provider,
  verification_reference,
  age_verified,
  contract_status,
  terms_version_accepted,
  contract_accepted_at,
  disclosure_version_accepted,
  disclosure_accepted_at
)
values (
  '23000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  repeat('a', 64),
  'active',
  '21000000-0000-4000-8000-000000000001',
  '22000000-0000-4000-8000-000000000001',
  'US',
  'verified',
  'didit',
  'didit-pgtap-reference',
  true,
  'accepted',
  'partners-terms-v1',
  now() - interval '1 day',
  'partners-disclosure-v1',
  now() - interval '1 day'
);

insert into affiliate_private.affiliate_links (
  id,
  account_id,
  public_code
)
values (
  '24000000-0000-4000-8000-000000000001',
  '23000000-0000-4000-8000-000000000001',
  'DisputeWonPgTapCode0000000000000'
);

insert into affiliate_private.affiliate_link_claims (
  id,
  claim_hash,
  link_id,
  referrer_account_id,
  program_version_id,
  commission_rate_bps,
  attribution_window_days,
  network_hash,
  user_agent_hash,
  expires_at
)
values (
  '25000000-0000-4000-8000-000000000001',
  repeat('b', 64),
  '24000000-0000-4000-8000-000000000001',
  '23000000-0000-4000-8000-000000000001',
  '21000000-0000-4000-8000-000000000001',
  2000,
  30,
  repeat('c', 64),
  repeat('d', 64),
  now() + interval '1 day'
);

insert into affiliate_private.affiliate_attributions (
  id,
  referred_user_id,
  referrer_account_id,
  link_id,
  claim_id,
  program_version_id,
  commission_rate_bps,
  attribution_window_days
)
values (
  '26000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  '23000000-0000-4000-8000-000000000001',
  '24000000-0000-4000-8000-000000000001',
  '25000000-0000-4000-8000-000000000001',
  '21000000-0000-4000-8000-000000000001',
  2000,
  30
);

insert into affiliate_private.affiliate_currency_metadata (
  currency_code,
  exponent,
  status,
  configured_by_pseudonym,
  justification
)
values (
  'USD',
  2,
  'active',
  repeat('a', 64),
  'DISPUTE_WON pgTAP authoritative currency fixture.'
);

insert into affiliate_private.affiliate_financial_facts (
  id,
  transaction_hash,
  referred_user_id,
  attribution_id,
  rail,
  event_type,
  environment,
  facts_status,
  currency,
  currency_exponent,
  gross_minor,
  tax_minor,
  eligible_minor,
  occurred_at
)
values (
  '30000000-0000-4000-8000-000000000001',
  encode(extensions.digest('dispute-won-order', 'sha256'), 'hex'),
  '20000000-0000-4000-8000-000000000002',
  '26000000-0000-4000-8000-000000000001',
  'web',
  'capture',
  'production',
  'complete',
  'USD',
  2,
  500,
  0,
  500,
  now() - interval '60 days'
);

insert into affiliate_private.affiliate_financial_facts (
  id,
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
  tax_minor,
  eligible_minor,
  occurred_at
)
values (
  '30000000-0000-4000-8000-000000000002',
  encode(extensions.digest('dispute-won-id', 'sha256'), 'hex'),
  encode(extensions.digest('dispute-won-order', 'sha256'), 'hex'),
  '20000000-0000-4000-8000-000000000002',
  '26000000-0000-4000-8000-000000000001',
  'web',
  'chargeback',
  'production',
  'complete',
  'USD',
  2,
  500,
  0,
  500,
  now() - interval '2 days'
);

insert into affiliate_private.affiliate_financial_fact_lineage_links (
  child_fact_id,
  parent_fact_id,
  attribution_id
)
values (
  '30000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000001',
  '26000000-0000-4000-8000-000000000001'
);

insert into affiliate_private.affiliate_commission_entries (
  id,
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
  '40000000-0000-4000-8000-000000000001',
  '23000000-0000-4000-8000-000000000001',
  '26000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001',
  'accrual',
  'USD',
  2,
  100,
  now() - interval '15 days'
);
insert into affiliate_private.affiliate_commission_postings (
  entry_id, ledger_account, direction, amount_minor, currency
)
values
  (
    '40000000-0000-4000-8000-000000000001',
    'platform_commission_expense',
    'debit',
    100,
    'USD'
  ),
  (
    '40000000-0000-4000-8000-000000000001',
    'partner_commission_pending',
    'credit',
    100,
    'USD'
  );

insert into affiliate_private.affiliate_commission_entries (
  id,
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
  '40000000-0000-4000-8000-000000000002',
  '23000000-0000-4000-8000-000000000001',
  '26000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001',
  'release',
  '40000000-0000-4000-8000-000000000001',
  'USD',
  2,
  100
);
insert into affiliate_private.affiliate_commission_postings (
  entry_id, ledger_account, direction, amount_minor, currency
)
values
  (
    '40000000-0000-4000-8000-000000000002',
    'partner_commission_pending',
    'debit',
    100,
    'USD'
  ),
  (
    '40000000-0000-4000-8000-000000000002',
    'partner_commission_available',
    'credit',
    100,
    'USD'
  );

insert into affiliate_private.affiliate_commission_entries (
  id,
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
  '40000000-0000-4000-8000-000000000003',
  '23000000-0000-4000-8000-000000000001',
  '26000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000002',
  'reversal',
  '40000000-0000-4000-8000-000000000001',
  'USD',
  2,
  100
);
insert into affiliate_private.affiliate_commission_postings (
  entry_id, ledger_account, direction, amount_minor, currency
)
values
  (
    '40000000-0000-4000-8000-000000000003',
    'partner_commission_available',
    'debit',
    100,
    'USD'
  ),
  (
    '40000000-0000-4000-8000-000000000003',
    'platform_commission_recovery',
    'credit',
    100,
    'USD'
  );

select extensions.throws_ok(
  format(
    $call$
      select affiliate_private.partners_worker_revolut_dispute_won_ingest(
        %L, %L, %L, %L, %L::uuid, 'USD', 500, now() - interval '3 days'
      )
    $call$,
    encode(
      extensions.digest(
        'billing:economic:v1:production:web:chargeback_reversal:'
          || encode(extensions.digest('dispute-won-id', 'sha256'), 'hex'),
        'sha256'
      ),
      'hex'
    ),
    repeat('f', 64),
    encode(extensions.digest('dispute-won-id', 'sha256'), 'hex'),
    encode(extensions.digest('dispute-won-order', 'sha256'), 'hex'),
    '20000000-0000-4000-8000-000000000002'
  ),
  'P0003',
  'prior Revolut chargeback proof conflicts',
  'a correction timestamp cannot precede the authoritative loss'
);

set local role service_role;

with queued as (
  select public.partners_worker_revolut_dispute_won_enqueue(
    encode(
      extensions.digest(
        'billing:economic:v1:production:web:chargeback_reversal:'
          || encode(extensions.digest('dispute-won-id', 'sha256'), 'hex'),
        'sha256'
      ),
      'hex'
    ),
    repeat('1', 64),
    encode(extensions.digest('dispute-won-id', 'sha256'), 'hex'),
    encode(extensions.digest('dispute-won-order', 'sha256'), 'hex'),
    '20000000-0000-4000-8000-000000000002',
    'USD',
    500,
    now()
  ) as response
),
saved as (
  insert into dispute_won_test_state (scenario, job_key)
  select 'nominal', queued.response #>> '{job,key}'
  from queued
  returning job_key
)
select extensions.is(
  (select queued.response ->> 'action' from queued),
  'chargeback_reversal_queued',
  'the authoritative delivery is durably queued'
)
from saved;

select extensions.is(
  jsonb_array_length(
    public.partners_worker_revolut_dispute_won_jobs_lease(
      'pgtap-correction-worker',
      repeat('e', 64),
      10,
      90
    ) -> 'jobs'
  ),
  1,
  'the correction worker leases the durable job'
);

select extensions.is(
  public.partners_worker_revolut_dispute_won_job_complete(
    (
      select job_key
      from dispute_won_test_state
      where scenario = 'nominal'
    ),
    'pgtap-correction-worker',
    repeat('e', 64),
    'succeeded',
    null
  ) #>> '{job,status}',
  'succeeded',
  'the leased correction applies atomically'
);

reset role;

select extensions.is(
  (
    select status
    from affiliate_private.affiliate_revolut_dispute_won_jobs
    limit 1
  ),
  'succeeded',
  'the durable inbox records terminal success'
);
select extensions.is(
  affiliate_private.partners_net_reversed_minor(
    '40000000-0000-4000-8000-000000000001'
  ),
  0::bigint,
  'a reinstatement cancels its exact automated reversal'
);
select extensions.is(
  (
    select count(*)
    from affiliate_private.affiliate_commission_entries
    where entry_kind = 'reinstatement'
  ),
  1::bigint,
  'exactly one immutable reinstatement is appended'
);
select extensions.is(
  affiliate_private.partners_account_payable_balance(
    '23000000-0000-4000-8000-000000000001',
    'USD'
  ),
  100::bigint,
  'the restored matured commission becomes payable again'
);

set local role service_role;

select extensions.is(
  public.partners_worker_revolut_dispute_won_enqueue(
    encode(
      extensions.digest(
        'billing:economic:v1:production:web:chargeback_reversal:'
          || encode(extensions.digest('dispute-won-id', 'sha256'), 'hex'),
        'sha256'
      ),
      'hex'
    ),
    repeat('1', 64),
    encode(extensions.digest('dispute-won-id', 'sha256'), 'hex'),
    encode(extensions.digest('dispute-won-order', 'sha256'), 'hex'),
    '20000000-0000-4000-8000-000000000002',
    'USD',
    500,
    now()
  ) ->> 'replayed',
  'true',
  'an identical provider replay reuses the durable job'
);

reset role;

select extensions.is(
  (
    select count(*)
    from affiliate_private.affiliate_commission_entries
    where entry_kind = 'reinstatement'
  ),
  1::bigint,
  'a provider replay cannot append a second correction'
);

-- Partial pending reversal -> partial release -> DISPUTE_WON. The restored
-- portion must go straight to available because the immutable release already
-- consumed the remaining pending balance.
insert into affiliate_private.affiliate_financial_facts (
  id,
  transaction_hash,
  referred_user_id,
  attribution_id,
  rail,
  event_type,
  environment,
  facts_status,
  currency,
  currency_exponent,
  gross_minor,
  tax_minor,
  eligible_minor,
  occurred_at
)
values (
  '30000000-0000-4000-8000-000000000010',
  encode(extensions.digest('dispute-won-partial-order', 'sha256'), 'hex'),
  '20000000-0000-4000-8000-000000000002',
  '26000000-0000-4000-8000-000000000001',
  'web',
  'capture',
  'production',
  'complete',
  'USD',
  2,
  500,
  0,
  500,
  now() - interval '20 days'
);
insert into affiliate_private.affiliate_financial_facts (
  id,
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
  tax_minor,
  eligible_minor,
  occurred_at
)
values (
  '30000000-0000-4000-8000-000000000011',
  encode(extensions.digest('dispute-won-partial-id', 'sha256'), 'hex'),
  encode(extensions.digest('dispute-won-partial-order', 'sha256'), 'hex'),
  '20000000-0000-4000-8000-000000000002',
  '26000000-0000-4000-8000-000000000001',
  'web',
  'chargeback',
  'production',
  'complete',
  'USD',
  2,
  150,
  0,
  150,
  now() - interval '4 days'
);
insert into affiliate_private.affiliate_financial_fact_lineage_links (
  child_fact_id,
  parent_fact_id,
  attribution_id
)
values (
  '30000000-0000-4000-8000-000000000011',
  '30000000-0000-4000-8000-000000000010',
  '26000000-0000-4000-8000-000000000001'
);

insert into affiliate_private.affiliate_commission_entries (
  id,
  account_id,
  attribution_id,
  fact_id,
  entry_kind,
  currency,
  currency_exponent,
  amount_minor,
  matures_at,
  created_at
)
values (
  '40000000-0000-4000-8000-000000000010',
  '23000000-0000-4000-8000-000000000001',
  '26000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000010',
  'accrual',
  'USD',
  2,
  100,
  now() - interval '3 days',
  now() - interval '20 days'
);
insert into affiliate_private.affiliate_commission_postings (
  entry_id, ledger_account, direction, amount_minor, currency
)
values
  (
    '40000000-0000-4000-8000-000000000010',
    'platform_commission_expense',
    'debit',
    100,
    'USD'
  ),
  (
    '40000000-0000-4000-8000-000000000010',
    'partner_commission_pending',
    'credit',
    100,
    'USD'
  );

insert into affiliate_private.affiliate_commission_entries (
  id,
  account_id,
  attribution_id,
  fact_id,
  entry_kind,
  related_entry_id,
  currency,
  currency_exponent,
  amount_minor,
  created_at
)
values (
  '40000000-0000-4000-8000-000000000011',
  '23000000-0000-4000-8000-000000000001',
  '26000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000011',
  'reversal',
  '40000000-0000-4000-8000-000000000010',
  'USD',
  2,
  30,
  now() - interval '4 days'
);
insert into affiliate_private.affiliate_commission_postings (
  entry_id, ledger_account, direction, amount_minor, currency
)
values
  (
    '40000000-0000-4000-8000-000000000011',
    'partner_commission_pending',
    'debit',
    30,
    'USD'
  ),
  (
    '40000000-0000-4000-8000-000000000011',
    'platform_commission_recovery',
    'credit',
    30,
    'USD'
  );

insert into affiliate_private.affiliate_commission_entries (
  id,
  account_id,
  attribution_id,
  fact_id,
  entry_kind,
  related_entry_id,
  currency,
  currency_exponent,
  amount_minor,
  created_at
)
values (
  '40000000-0000-4000-8000-000000000012',
  '23000000-0000-4000-8000-000000000001',
  '26000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000010',
  'release',
  '40000000-0000-4000-8000-000000000010',
  'USD',
  2,
  70,
  now() - interval '3 days'
);
insert into affiliate_private.affiliate_commission_postings (
  entry_id, ledger_account, direction, amount_minor, currency
)
values
  (
    '40000000-0000-4000-8000-000000000012',
    'partner_commission_pending',
    'debit',
    70,
    'USD'
  ),
  (
    '40000000-0000-4000-8000-000000000012',
    'partner_commission_available',
    'credit',
    70,
    'USD'
  );

set local role service_role;

with queued as (
  select public.partners_worker_revolut_dispute_won_enqueue(
    encode(
      extensions.digest(
        'billing:economic:v1:production:web:chargeback_reversal:'
          || encode(
            extensions.digest('dispute-won-partial-id', 'sha256'),
            'hex'
          ),
        'sha256'
      ),
      'hex'
    ),
    repeat('4', 64),
    encode(extensions.digest('dispute-won-partial-id', 'sha256'), 'hex'),
    encode(extensions.digest('dispute-won-partial-order', 'sha256'), 'hex'),
    '20000000-0000-4000-8000-000000000002',
    'USD',
    150,
    now() - interval '1 day'
  ) as response
),
saved as (
  insert into dispute_won_test_state (scenario, job_key)
  select 'partial_after_release', queued.response #>> '{job,key}'
  from queued
  returning job_key
)
select extensions.is(
  (select queued.response ->> 'action' from queued),
  'chargeback_reversal_queued',
  'a partial reversal correction is durably queued'
)
from saved;

select extensions.is(
  jsonb_array_length(
    public.partners_worker_revolut_dispute_won_jobs_lease(
      'pgtap-partial-correction-worker',
      repeat('9', 64),
      10,
      90
    ) -> 'jobs'
  ),
  1,
  'the partial correction worker leases only its durable job'
);
select extensions.is(
  public.partners_worker_revolut_dispute_won_job_complete(
    (
      select job_key
      from dispute_won_test_state
      where scenario = 'partial_after_release'
    ),
    'pgtap-partial-correction-worker',
    repeat('9', 64),
    'succeeded',
    null
  ) #>> '{job,status}',
  'succeeded',
  'the partial DISPUTE_WON applies after the partial release'
);

reset role;

select extensions.is(
  (
    select coalesce(sum(posting.amount_minor), 0)
    from affiliate_private.affiliate_commission_postings posting
    join affiliate_private.affiliate_commission_entries reinstatement
      on reinstatement.id = posting.entry_id
    join affiliate_private.affiliate_financial_facts correction
      on correction.id = reinstatement.fact_id
    where reinstatement.entry_kind = 'reinstatement'
      and correction.transaction_hash = encode(
        extensions.digest('dispute-won-partial-id', 'sha256'),
        'hex'
      )
      and posting.ledger_account = 'partner_commission_pending'
      and posting.direction = 'credit'
  ),
  0::numeric,
  'a correction after release never recreates a stranded pending balance'
);
select extensions.is(
  (
    select coalesce(sum(posting.amount_minor), 0)
    from affiliate_private.affiliate_commission_postings posting
    join affiliate_private.affiliate_commission_entries reinstatement
      on reinstatement.id = posting.entry_id
    join affiliate_private.affiliate_financial_facts correction
      on correction.id = reinstatement.fact_id
    where reinstatement.entry_kind = 'reinstatement'
      and correction.transaction_hash = encode(
        extensions.digest('dispute-won-partial-id', 'sha256'),
        'hex'
      )
      and posting.ledger_account = 'partner_commission_available'
      and posting.direction = 'credit'
  ),
  30::numeric,
  'the restored pending portion is routed exactly to available'
);
select extensions.is(
  affiliate_private.partners_account_payable_balance(
    '23000000-0000-4000-8000-000000000001',
    'USD'
  ),
  200::bigint,
  'the partial release and restoration produce the exact payable balance'
);
select extensions.is(
  affiliate_private.partners_worker_shadow_reconcile(
    'pgtap-partial-reconcile',
    now() - interval '30 days',
    now() + interval '1 minute',
    true
  ) #>> '{run,status}',
  'clean',
  'shadow reconciliation accepts the partial release restoration'
);
select extensions.is(
  (
    affiliate_private.partners_worker_shadow_reconcile(
      'pgtap-partial-reconcile-second',
      now() - interval '30 days',
      now() + interval '1 minute',
      true
    ) #>> '{run,mismatches}'
  )::bigint,
  0::bigint,
  'shadow reconciliation reports no mismatch for the restored ledger'
);

set local role service_role;

select extensions.is(
  public.partners_worker_revolut_dispute_won_enqueue(
    encode(
      extensions.digest(
        'billing:economic:v1:production:web:chargeback_reversal:'
          || encode(extensions.digest('dispute-won-id', 'sha256'), 'hex'),
        'sha256'
      ),
      'hex'
    ),
    repeat('2', 64),
    encode(extensions.digest('dispute-won-id', 'sha256'), 'hex'),
    encode(extensions.digest('dispute-won-order', 'sha256'), 'hex'),
    '20000000-0000-4000-8000-000000000002',
    'USD',
    500,
    now()
  ) ->> 'conflict',
  'true',
  'a reused provider identity with another payload is quarantined'
);

reset role;

select extensions.is(
  (
    select count(*)
    from affiliate_private.affiliate_revolut_dispute_won_conflicts
  ),
  1::bigint,
  'the conflicting replay leaves durable sanitized evidence'
);
select extensions.is(
  (
    select status
    from affiliate_private.affiliate_revolut_dispute_won_jobs
    limit 1
  ),
  'succeeded',
  'a late conflicting replay cannot rewrite a successful correction'
);

set local role service_role;

with queued as (
  select public.partners_worker_revolut_dispute_won_enqueue(
    encode(
      extensions.digest(
        'billing:economic:v1:production:web:chargeback_reversal:'
          || encode(
            extensions.digest('dispute-won-out-of-order', 'sha256'),
            'hex'
          ),
        'sha256'
      ),
      'hex'
    ),
    repeat('3', 64),
    encode(
      extensions.digest('dispute-won-out-of-order', 'sha256'),
      'hex'
    ),
    encode(extensions.digest('dispute-won-order', 'sha256'), 'hex'),
    '20000000-0000-4000-8000-000000000002',
    'USD',
    500,
    now()
  ) as response
),
saved as (
  insert into dispute_won_test_state (scenario, job_key)
  select 'out_of_order', queued.response #>> '{job,key}'
  from queued
  returning job_key
)
select extensions.is(
  (select queued.response ->> 'action' from queued),
  'chargeback_reversal_queued',
  'an out-of-order DISPUTE_WON is durably accepted before its loss'
)
from saved;
select extensions.is(
  jsonb_array_length(
    public.partners_worker_revolut_dispute_won_jobs_lease(
      'pgtap-out-of-order-worker',
      repeat('c', 64),
      10,
      90
    ) -> 'jobs'
  ),
  1,
  'the out-of-order correction remains leaseable'
);
select extensions.throws_ok(
  format(
    $call$
      select public.partners_worker_revolut_dispute_won_job_complete(
        %L,
        'pgtap-out-of-order-worker',
        %L,
        'succeeded',
        null
      )
    $call$,
    (
      select job_key
      from dispute_won_test_state
      where scenario = 'out_of_order'
    ),
    repeat('c', 64)
  ),
  'P0006',
  'prior Revolut chargeback fact is unavailable',
  'apply fails retryably while the authoritative loss is absent'
);
select extensions.is(
  public.partners_worker_revolut_dispute_won_job_complete(
    (
      select job_key
      from dispute_won_test_state
      where scenario = 'out_of_order'
    ),
    'pgtap-out-of-order-worker',
    repeat('c', 64),
    'retry',
    'worker_rpc_retry'
  ) #>> '{job,status}',
  'retry',
  'the durable job is retained with retry backoff and no lost delivery'
);

reset role;

insert into affiliate_private.affiliate_financial_facts (
  id,
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
  tax_minor,
  eligible_minor,
  occurred_at
)
values (
  '30000000-0000-4000-8000-000000000003',
  encode(
    extensions.digest('dispute-won-out-of-order', 'sha256'),
    'hex'
  ),
  encode(extensions.digest('dispute-won-order', 'sha256'), 'hex'),
  '20000000-0000-4000-8000-000000000002',
  '26000000-0000-4000-8000-000000000001',
  'web',
  'chargeback',
  'production',
  'complete',
  'USD',
  2,
  500,
  0,
  500,
  now() - interval '1 day'
);
insert into affiliate_private.affiliate_financial_fact_lineage_links (
  child_fact_id,
  parent_fact_id,
  attribution_id
)
values (
  '30000000-0000-4000-8000-000000000003',
  '30000000-0000-4000-8000-000000000001',
  '26000000-0000-4000-8000-000000000001'
);
insert into affiliate_private.affiliate_commission_entries (
  id,
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
  '40000000-0000-4000-8000-000000000005',
  '23000000-0000-4000-8000-000000000001',
  '26000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000003',
  'reversal',
  '40000000-0000-4000-8000-000000000001',
  'USD',
  2,
  100
);
insert into affiliate_private.affiliate_commission_postings (
  entry_id,
  ledger_account,
  direction,
  amount_minor,
  currency
)
values
  (
    '40000000-0000-4000-8000-000000000005',
    'partner_commission_available',
    'debit',
    100,
    'USD'
  ),
  (
    '40000000-0000-4000-8000-000000000005',
    'platform_commission_recovery',
    'credit',
    100,
    'USD'
  );
update affiliate_private.affiliate_revolut_dispute_won_jobs
set next_attempt_at = now()
where dispute_hash = encode(
  extensions.digest('dispute-won-out-of-order', 'sha256'),
  'hex'
);

set local role service_role;

select extensions.is(
  jsonb_array_length(
    public.partners_worker_revolut_dispute_won_jobs_lease(
      'pgtap-out-of-order-worker',
      repeat('d', 64),
      10,
      90
    ) -> 'jobs'
  ),
  1,
  'the retained correction is leased after its lineage appears'
);
select extensions.is(
  public.partners_worker_revolut_dispute_won_job_complete(
    (
      select job_key
      from dispute_won_test_state
      where scenario = 'out_of_order'
    ),
    'pgtap-out-of-order-worker',
    repeat('d', 64),
    'succeeded',
    null
  ) #>> '{job,status}',
  'succeeded',
  'the exact retained correction succeeds once the loss lineage exists'
);

reset role;

select extensions.is(
  (
    select count(*)
    from affiliate_private.affiliate_commission_entries
    where entry_kind = 'reinstatement'
  ),
  3::bigint,
  'out-of-order recovery still appends exactly one reinstatement per loss'
);

select * from extensions.finish();
rollback;
