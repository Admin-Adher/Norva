-- Norva Partners: atomically bind the one-account production financial canary
-- to the exact matured transaction and to one immutable authorization.  This
-- migration deliberately does not broaden the ordinary payout RPCs.  A canary
-- cycle can only be created and approved through the dedicated AAL2 entry
-- points below; every failure rolls the cycle and the one-shot consumption back.

set statement_timeout = '120s';
set lock_timeout = '10s';

create table affiliate_private.affiliate_financial_canary_runs (
  id                         uuid primary key
    default extensions.gen_random_uuid(),
  run_key                    text not null unique default (
    'fcr_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  authorization_sha256       text not null unique,
  transaction_hash           text not null unique,
  subject_pseudonym          text not null,
  account_id                 uuid not null
    references affiliate_private.affiliate_accounts(id) on delete restrict,
  program_version_id         uuid not null
    references affiliate_private.affiliate_program_versions(id)
    on delete restrict,
  fact_id                    uuid not null unique
    references affiliate_private.affiliate_financial_facts(id)
    on delete restrict,
  accrual_entry_id           uuid not null unique
    references affiliate_private.affiliate_commission_entries(id)
    on delete restrict,
  release_entry_id           uuid not null unique
    references affiliate_private.affiliate_commission_entries(id)
    on delete restrict,
  cycle_id                   uuid not null unique
    references affiliate_private.affiliate_payout_cycles(id)
    on delete restrict,
  country_code               text not null,
  currency                   text not null,
  currency_exponent          integer not null,
  amount_minor               bigint not null,
  period_start               date not null,
  period_end                 date not null,
  source_commit_sha          text not null,
  state                      text not null default 'draft',
  created_by_pseudonym       text not null,
  created_at                 timestamptz not null default now(),
  approved_by_pseudonym      text,
  approved_at                timestamptz,
  constraint affiliate_financial_canary_runs_key
    check (run_key ~ '^fcr_[0-9a-f]{24}$'),
  constraint affiliate_financial_canary_runs_hashes
    check (
      authorization_sha256 ~ '^[0-9a-f]{64}$'
      and transaction_hash ~ '^[0-9a-f]{64}$'
      and subject_pseudonym ~ '^[0-9a-f]{64}$'
      and source_commit_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'
    ),
  constraint affiliate_financial_canary_runs_scope
    check (
      country_code ~ '^[A-Z]{2}$'
      and currency ~ '^[A-Z]{3}$'
      and currency_exponent between 0 and 6
      and amount_minor between 1 and 1000
      and period_end >= period_start
      and period_end <= period_start + 35
    ),
  constraint affiliate_financial_canary_runs_actors
    check (
      created_by_pseudonym ~ '^[0-9a-f]{64}$'
      and (
        approved_by_pseudonym is null
        or approved_by_pseudonym ~ '^[0-9a-f]{64}$'
      )
    ),
  constraint affiliate_financial_canary_runs_state
    check (
      (
        state = 'draft'
        and approved_by_pseudonym is null
        and approved_at is null
      )
      or (
        state = 'approved'
        and approved_by_pseudonym is not null
        and approved_by_pseudonym <> created_by_pseudonym
        and approved_at is not null
        and approved_at >= created_at
      )
    )
);

alter table affiliate_private.affiliate_financial_canary_runs
  enable row level security;
revoke all on table affiliate_private.affiliate_financial_canary_runs
  from public, anon, authenticated, service_role;

create function
affiliate_private.guard_financial_canary_run_mutation()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'financial canary authorization is immutable'
      using errcode = '55000';
  end if;

  if tg_op = 'INSERT' then
    if current_setting(
      'norva.partners_financial_canary_control', true
    ) is distinct from 'create' then
      raise exception 'financial canary authorization is private'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if current_setting(
      'norva.partners_financial_canary_control', true
    ) is distinct from 'approve'
    or old.state <> 'draft'
    or new.state <> 'approved'
    or old.id is distinct from new.id
    or old.run_key is distinct from new.run_key
    or old.authorization_sha256 is distinct from new.authorization_sha256
    or old.transaction_hash is distinct from new.transaction_hash
    or old.subject_pseudonym is distinct from new.subject_pseudonym
    or old.account_id is distinct from new.account_id
    or old.program_version_id is distinct from new.program_version_id
    or old.fact_id is distinct from new.fact_id
    or old.accrual_entry_id is distinct from new.accrual_entry_id
    or old.release_entry_id is distinct from new.release_entry_id
    or old.cycle_id is distinct from new.cycle_id
    or old.country_code is distinct from new.country_code
    or old.currency is distinct from new.currency
    or old.currency_exponent is distinct from new.currency_exponent
    or old.amount_minor is distinct from new.amount_minor
    or old.period_start is distinct from new.period_start
    or old.period_end is distinct from new.period_end
    or old.source_commit_sha is distinct from new.source_commit_sha
    or old.created_by_pseudonym is distinct from new.created_by_pseudonym
    or old.created_at is distinct from new.created_at
    or new.approved_by_pseudonym is null
    or new.approved_at is null
  then
    raise exception 'financial canary authorization is immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger affiliate_financial_canary_runs_guard
before insert or update or delete
on affiliate_private.affiliate_financial_canary_runs
for each row execute function
  affiliate_private.guard_financial_canary_run_mutation();

-- Approval packages are re-read at both the maker and checker boundaries.  The
-- authorization digest is never returned or copied to an audit event.
create function
affiliate_private.partners_financial_canary_authorization_current(
  p_authorization_sha256 text,
  p_program_version_id uuid,
  p_country_code text,
  p_source_commit_sha text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with required(gate_key) as (
    values
      ('legal_and_tax_approved'::text),
      ('privacy_approved'::text),
      ('country_policy_approved'::text),
      ('manual_payout_workflow_verified'::text)
  )
  select coalesce(
    count(package.id) = 4
    and bool_and(
      gate.satisfied
      and package.program_version_id = p_program_version_id
      and package.deployment_environment = 'production'
      and package.source_commit_sha = lower(btrim(p_source_commit_sha))
      and package.document_hashes ->> 'financial_canary_authorization' =
        lower(btrim(p_authorization_sha256))
      and jsonb_array_length(package.jurisdiction_scope) = 1
      and exists (
        select 1
        from jsonb_array_elements(package.jurisdiction_scope) scope(item)
        where scope.item ->> 'country_code' = upper(btrim(p_country_code))
          and nullif(scope.item ->> 'subdivision_code', '') is null
      )
      and affiliate_private.partners_approval_package_is_current(
        package.id,
        required.gate_key,
        'production'
      )
    ),
    false
  )
  from required
  left join affiliate_private.affiliate_release_gates gate
    on gate.gate_key = required.gate_key
  left join affiliate_private.affiliate_release_gate_approval_bindings binding
    on binding.gate_key = required.gate_key
  left join affiliate_private.affiliate_approval_packages package
    on package.id = binding.approval_package_id;
$$;

-- This predicate proves a single immutable production fact led to the exact
-- accrual, J+45 maturation and release that funds the canary.  It also excludes
-- reversals and any second available-balance posting for the account/currency.
create function
affiliate_private.partners_financial_canary_lineage_current(
  p_run_id uuid,
  p_require_available boolean
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select
      fact.transaction_hash = run.transaction_hash
      and fact.environment = 'production'
      and fact.facts_status = 'complete'
      and fact.event_type in ('capture', 'renewal')
      and fact.currency = run.currency
      and fact.currency_exponent = run.currency_exponent
      and attribution.referrer_account_id = run.account_id
      and attribution.program_version_id = run.program_version_id
      and attribution.status in ('attributed', 'qualified')
      and program.maturation_days = 45
      and affiliate_private.partners_commission_minor(
        fact.eligible_minor,
        attribution.commission_rate_bps
      ) = run.amount_minor
      and commission_job.job_kind = 'accrual'
      and commission_job.status = 'succeeded'
      and commission_job.completed_at is not null
      and accrual.entry_kind = 'accrual'
      and accrual.account_id = run.account_id
      and accrual.fact_id = run.fact_id
      and accrual.currency = run.currency
      and accrual.currency_exponent = run.currency_exponent
      and accrual.amount_minor = run.amount_minor
      and accrual.matures_at = fact.occurred_at + interval '45 days'
      and maturation_job.status = 'succeeded'
      and maturation_job.available_at = accrual.matures_at
      and maturation_job.completed_at is not null
      and maturation_job.completed_at >= maturation_job.available_at
      and maturation_job.available_at <= statement_timestamp()
      and release.entry_kind = 'release'
      and release.fact_id = run.fact_id
      and release.related_entry_id = run.accrual_entry_id
      and release.account_id = run.account_id
      and release.currency = run.currency
      and release.currency_exponent = run.currency_exponent
      and release.amount_minor = run.amount_minor
      and release.created_at >= accrual.matures_at
      and (
        select count(*) = 2
          and count(*) filter (
            where posting.ledger_account = 'platform_commission_expense'
              and posting.direction = 'debit'
              and posting.amount_minor = run.amount_minor
              and posting.currency = run.currency
          ) = 1
          and count(*) filter (
            where posting.ledger_account = 'partner_commission_pending'
              and posting.direction = 'credit'
              and posting.amount_minor = run.amount_minor
              and posting.currency = run.currency
          ) = 1
        from affiliate_private.affiliate_commission_postings posting
        where posting.entry_id = run.accrual_entry_id
      )
      and (
        select count(*) = 2
          and count(*) filter (
            where posting.ledger_account = 'partner_commission_pending'
              and posting.direction = 'debit'
              and posting.amount_minor = run.amount_minor
              and posting.currency = run.currency
          ) = 1
          and count(*) filter (
            where posting.ledger_account = 'partner_commission_available'
              and posting.direction = 'credit'
              and posting.amount_minor = run.amount_minor
              and posting.currency = run.currency
          ) = 1
        from affiliate_private.affiliate_commission_postings posting
        where posting.entry_id = run.release_entry_id
      )
      and not exists (
        select 1
        from affiliate_private.affiliate_commission_entries reversal
        where reversal.related_entry_id = run.accrual_entry_id
          and reversal.entry_kind in ('reversal', 'manual_reversal')
      )
      and not exists (
        select 1
        from affiliate_private.affiliate_financial_facts other
        where other.id <> run.fact_id
          and other.environment = 'production'
          and other.event_type in ('capture', 'renewal')
          and other.transaction_hash = run.transaction_hash
      )
      and not exists (
        select 1
        from affiliate_private.affiliate_financial_facts child_fact
        where child_fact.environment = 'production'
          and child_fact.rail = fact.rail
          and child_fact.parent_transaction_hash = run.transaction_hash
          and child_fact.event_type in ('refund', 'chargeback')
      )
      and not exists (
        select 1
        from affiliate_private.affiliate_commission_postings posting
        join affiliate_private.affiliate_commission_entries entry
          on entry.id = posting.entry_id
        where entry.account_id = run.account_id
          and entry.currency = run.currency
          and posting.ledger_account = 'partner_commission_available'
          and posting.entry_id <> run.release_entry_id
          and (
            p_require_available
            or posting.entry_id is distinct from item.allocation_entry_id
          )
      )
      and affiliate_private.partners_payout_balance_authoritative(
        run.account_id,
        run.currency
      )
      and (
        (
          p_require_available
          and
          item.allocation_entry_id is null
          and balance.available_minor = run.amount_minor
          and balance.recovery_due_minor = 0
        )
        or (
          not p_require_available
          and item.allocation_entry_id is not null
          and exists (
            select 1
            from affiliate_private.affiliate_commission_entries allocation
            where allocation.id = item.allocation_entry_id
              and allocation.entry_kind = 'payout_allocation'
              and allocation.account_id = run.account_id
              and allocation.currency = run.currency
              and allocation.currency_exponent = run.currency_exponent
              and allocation.amount_minor = run.amount_minor
              and (
                select count(*) = 2
                  and count(*) filter (
                    where posting.ledger_account =
                        'partner_commission_available'
                      and posting.direction = 'debit'
                      and posting.amount_minor = run.amount_minor
                      and posting.currency = run.currency
                  ) = 1
                  and count(*) filter (
                    where posting.ledger_account = 'partner_payout_clearing'
                      and posting.direction = 'credit'
                      and posting.amount_minor = run.amount_minor
                      and posting.currency = run.currency
                  ) = 1
                from affiliate_private.affiliate_commission_postings posting
                where posting.entry_id = allocation.id
              )
          )
        )
      )
    from affiliate_private.affiliate_financial_canary_runs run
    join affiliate_private.affiliate_financial_facts fact
      on fact.id = run.fact_id
    join affiliate_private.affiliate_attributions attribution
      on attribution.id = fact.attribution_id
    join affiliate_private.affiliate_program_versions program
      on program.id = run.program_version_id
    join affiliate_private.affiliate_commission_jobs commission_job
      on commission_job.fact_id = run.fact_id
    join affiliate_private.affiliate_commission_entries accrual
      on accrual.id = run.accrual_entry_id
    join affiliate_private.affiliate_maturation_jobs maturation_job
      on maturation_job.accrual_entry_id = run.accrual_entry_id
    join affiliate_private.affiliate_commission_entries release
      on release.id = run.release_entry_id
    join affiliate_private.affiliate_payout_items item
      on item.cycle_id = run.cycle_id
      and item.account_id = run.account_id
      and item.currency = run.currency
      and item.amount_minor = run.amount_minor
    join affiliate_private.affiliate_accounts account
      on account.id = run.account_id
    join auth.users user_row
      on user_row.id = account.user_id
    join affiliate_private.affiliate_pilot_allowlist allowlist_row
      on allowlist_row.user_id = account.user_id
    join affiliate_private.affiliate_fiscal_profiles fiscal
      on fiscal.account_id = account.id
      and fiscal.status = 'verified'
      and fiscal.residence_country_code = account.country_code
      and fiscal.declaration_version =
        'partners-tax-self-certification-v1'
      and fiscal.self_attested_at is not null
      and fiscal.reviewed_at is not null
    join affiliate_private.affiliate_payout_profiles profile
      on profile.id = item.payout_profile_id
      and profile.account_id = account.id
      and profile.provider = 'revolut'
      and profile.currency = run.currency
      and profile.status = 'active'
    join affiliate_private.affiliate_revolut_beneficiary_bindings binding
      on binding.id = profile.revolut_binding_id
      and binding.binding_version = profile.revolut_binding_version
      and binding.account_id = profile.account_id
      and binding.currency = profile.currency
      and binding.status = 'active'
      and binding.beneficiary_token_ref = profile.beneficiary_token_ref
      and binding.beneficiary_payment_method_ref is not distinct from
        profile.beneficiary_payment_method_ref
      and binding.destination_masked = profile.display_masked
    join affiliate_private.affiliate_payout_provider_configs route
      on route.provider = 'revolut'
      and route.execution_adapter = 'revolut_manual'
      and route.country_code = account.country_code
      and route.currency = run.currency
      and route.status = 'active'
    left join lateral (
      select balance_row.*
      from jsonb_to_recordset(
        affiliate_private.partners_account_balances(run.account_id)
      ) as balance_row(
        currency text,
        currency_exponent integer,
        pending_minor bigint,
        available_minor bigint,
        recovery_due_minor bigint,
        redeemed_minor bigint
      )
      where balance_row.currency = run.currency
    ) balance on true
    where run.id = p_run_id
      and account.user_pseudonym = run.subject_pseudonym
      and account.status = 'active'
      and account.member_status = 'active'
      and account.program_version_id = run.program_version_id
      and account.member_program_version_id = run.program_version_id
      and account.country_code = run.country_code
      and account.subdivision_code is null
      and account.verification_status = 'verified'
      and account.verification_provider = 'didit'
      and nullif(btrim(account.verification_reference), '') is not null
      and account.age_verified
      and account.capacity_verified
      and account.contract_status = 'accepted'
      and account.terms_version_accepted = program.terms_version
      and account.disclosure_version_accepted = program.disclosure_version
      and account.member_terms_version_accepted = program.terms_version
      and account.member_disclosure_version_accepted =
        program.disclosure_version
      and user_row.deleted_at is null
      and (
        user_row.banned_until is null
        or user_row.banned_until < clock_timestamp()
      )
      and user_row.email_confirmed_at is not null
      and allowlist_row.status = 'active'
      and (
        allowlist_row.expires_at is null
        or allowlist_row.expires_at > statement_timestamp()
      )
      and allowlist_row.country_code = run.country_code
      and allowlist_row.subdivision_code is null
      and program.status = 'active'
      and program.maturation_days = 45
      and program.payout_thresholds ? run.currency
      and (program.payout_thresholds ->> run.currency)::bigint =
        run.amount_minor
      and attribution.commission_rate_bps = program.commission_rate_bps
      and balance.currency = run.currency
      and balance.currency_exponent = run.currency_exponent
      and affiliate_private.partners_cash_readiness(account.id) ->> 'ready' =
        'true'
      and exists (
        select 1
        from affiliate_private.affiliate_kyc_sessions kyc_session
        where kyc_session.account_id = account.id
          and kyc_session.provider_session_hash =
            account.verification_reference
          and kyc_session.provider = 'didit'
          and kyc_session.provider_status = 'approved'
          and kyc_session.provider_environment = 'live'
          and kyc_session.provider_config_fingerprint ~ '^[0-9a-f]{64}$'
          and kyc_session.provider_config_fingerprint <> repeat('0', 64)
          and kyc_session.status = 'verified'
          and kyc_session.provider_purge_status = 'purged'
          and kyc_session.provider_purged_at is not null
          and kyc_session.verified_at is not null
          and kyc_session.provider_purged_at >= kyc_session.verified_at
          and not exists (
            select 1
            from affiliate_private.affiliate_kyc_sessions newer_kyc_session
            where newer_kyc_session.account_id = kyc_session.account_id
              and newer_kyc_session.id <> kyc_session.id
              and newer_kyc_session.provider_environment = 'live'
              and newer_kyc_session.status <> 'superseded'
              and newer_kyc_session.created_at > kyc_session.created_at
          )
          and exists (
            select 1
            from affiliate_private.affiliate_kyc_webhook_events webhook_event
            where webhook_event.session_id = kyc_session.id
              and webhook_event.processing_outcome = 'verified'
              and webhook_event.provider_environment = 'live'
              and webhook_event.provider_config_fingerprint =
                kyc_session.provider_config_fingerprint
              and webhook_event.provider_event_at = kyc_session.verified_at
          )
      )
      and exists (
        select 1
        from affiliate_private.affiliate_payout_onboarding_requests request
        where request.account_id = account.id
          and request.currency = run.currency
          and request.execution_adapter = 'revolut_manual'
          and request.status = 'completed'
          and request.completed_at is not null
          and request.completed_by_pseudonym is not null
          and not exists (
            select 1
            from affiliate_private.affiliate_payout_onboarding_requests newer
            where newer.account_id = request.account_id
              and newer.currency = request.currency
              and newer.revision > request.revision
          )
      )
      and not exists (
        select 1
        from affiliate_private.affiliate_revolut_beneficiary_revocations revoked
        where revoked.binding_id = binding.id
      )
      and not exists (
        select 1
        from affiliate_private.affiliate_financial_facts child_fact
        where child_fact.environment = 'production'
          and child_fact.rail = fact.rail
          and child_fact.parent_transaction_hash = fact.transaction_hash
          and child_fact.event_type in ('refund', 'chargeback')
      )
  ), false);
$$;

-- Serialize every payout-cycle mutation with the release-control boundary used
-- by the dedicated canary RPC.  Otherwise an ordinary cycle for a different
-- period could be inserted after the canary's global exclusivity checks but
-- before its run row is recorded.  While the one-shot run is active, only its
-- bound cycle may be mutated.
create function
affiliate_private.guard_financial_canary_cycle_exclusivity()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:release-control', 0)
  );

  if exists (
    select 1
    from affiliate_private.affiliate_financial_canary_runs active_run
    join affiliate_private.affiliate_payout_cycles active_cycle
      on active_cycle.id = active_run.cycle_id
    where active_run.state in ('draft', 'approved')
      and active_cycle.status not in ('settled', 'failed', 'cancelled')
  ) and not exists (
    select 1
    from affiliate_private.affiliate_financial_canary_runs linked_run
    join affiliate_private.affiliate_payout_cycles linked_cycle
      on linked_cycle.id = linked_run.cycle_id
    where linked_run.cycle_id = new.id
      and linked_run.state in ('draft', 'approved')
      and linked_cycle.status not in ('settled', 'failed', 'cancelled')
  ) then
    raise exception 'financial canary release control is active'
      using errcode = 'P0004';
  end if;

  return new;
end;
$$;

-- The numeric prefix makes this lock-taking trigger run before the checker
-- trigger below (PostgreSQL orders same-event triggers by name).
create trigger affiliate_payout_cycles_00_financial_canary_exclusivity_guard
before insert or update on affiliate_private.affiliate_payout_cycles
for each row execute function
  affiliate_private.guard_financial_canary_cycle_exclusivity();

create function
affiliate_private.guard_financial_canary_cycle_approval()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if new.status = 'approved'
    and old.status is distinct from new.status
    and exists (
      select 1
      from affiliate_private.affiliate_financial_canary_runs run
      where run.cycle_id = new.id
    )
    and not exists (
      select 1
      from affiliate_private.affiliate_financial_canary_runs run
      where run.cycle_id = new.id
        and run.state = 'approved'
        and run.approved_at = transaction_timestamp()
        and run.approved_by_pseudonym = new.approved_by_pseudonym
        and run.approved_by_pseudonym =
          affiliate_private.partners_admin_actor_pseudonym()
    )
  then
    raise exception 'financial canary requires its dedicated checker RPC'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger affiliate_payout_cycles_financial_canary_approval_guard
before update on affiliate_private.affiliate_payout_cycles
for each row execute function
  affiliate_private.guard_financial_canary_cycle_approval();

create function
affiliate_private.admin_partners_financial_canary_cycle_create(
  p_period_start date,
  p_period_end date,
  p_currency text,
  p_currency_exponent integer,
  p_amount_minor bigint,
  p_source_commit_sha text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_currency text := upper(btrim(coalesce(p_currency, '')));
  v_commit text := lower(btrim(coalesce(p_source_commit_sha, '')));
  v_confirmation text := btrim(coalesce(p_confirmation, ''));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_subject text;
  v_authorization text;
  v_transaction text;
  v_secret_rows integer;
  v_candidate record;
  v_candidate_count integer := 0;
  v_actor text;
  v_result jsonb;
  v_cycle affiliate_private.affiliate_payout_cycles%rowtype;
  v_run affiliate_private.affiliate_financial_canary_runs%rowtype;
begin
  perform affiliate_private.partners_require_capability('finance');
  perform affiliate_private.partners_require_aal2(
    'Partners financial canary creation'
  );

  if p_period_start is null
    or p_period_end is null
    or p_period_end < p_period_start
    or p_period_end > p_period_start + 35
    or p_period_end >= current_date
    or v_currency !~ '^[A-Z]{3}$'
    or p_currency_exponent not between 0 and 6
    or p_amount_minor not between 1 and 1000
    or v_commit !~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'
    or v_confirmation <> concat_ws(
      ':',
      'CREATE_FINANCIAL_CANARY',
      p_period_start::text,
      p_period_end::text,
      v_currency,
      p_amount_minor::text
    )
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid financial canary request'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:release-control', 0)
  );
  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:financial-canary', 0)
  );

  select count(*)::integer, min(secret.decrypted_secret)
  into v_secret_rows, v_subject
  from vault.decrypted_secrets secret
  where secret.name =
      'norva_partners_financial_canary_subject_pseudonym_v1'
    and secret.decrypted_secret ~ '^[0-9a-f]{64}$';
  if v_secret_rows <> 1 then
    raise exception 'financial canary subject binding is unavailable'
      using errcode = 'P0001';
  end if;

  select count(*)::integer, min(secret.decrypted_secret)
  into v_secret_rows, v_authorization
  from vault.decrypted_secrets secret
  where secret.name =
      'norva_partners_financial_canary_authorization_sha256_v1'
    and secret.decrypted_secret ~ '^[0-9a-f]{64}$';
  if v_secret_rows <> 1 then
    raise exception 'financial canary authorization is unavailable'
      using errcode = 'P0001';
  end if;

  select count(*)::integer, min(secret.decrypted_secret)
  into v_secret_rows, v_transaction
  from vault.decrypted_secrets secret
  where secret.name =
      'norva_partners_financial_canary_transaction_hash_v1'
    and secret.decrypted_secret ~ '^[0-9a-f]{64}$';
  if v_secret_rows <> 1 then
    raise exception 'financial canary transaction binding is unavailable'
      using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:financial-canary:'
        || v_authorization || ':' || v_transaction,
      0
    )
  );

  if exists (
    select 1
    from affiliate_private.affiliate_financial_canary_runs run
    where run.authorization_sha256 = v_authorization
       or run.transaction_hash = v_transaction
  ) then
    raise exception 'financial canary authorization was already consumed'
      using errcode = 'P0004';
  end if;

  if exists (
    select 1
    from affiliate_private.affiliate_payout_cycles cycle
    where cycle.period_start = p_period_start
      and cycle.period_end = p_period_end
      and cycle.currency = v_currency
  ) or exists (
    select 1
    from affiliate_private.affiliate_payout_cycles cycle
    where cycle.live_execution
      and cycle.status not in ('settled', 'failed', 'cancelled')
  ) or exists (
    select 1
    from affiliate_private.affiliate_revolut_manual_batches batch
    where batch.status not in ('settled', 'cancelled')
  ) then
    raise exception 'another payout cycle or manual batch is open'
      using errcode = 'P0001';
  end if;

  if not coalesce((
      select flag.enabled from public.admin_feature_flags flag
      where flag.key = 'partners_payouts_live'
    ), false)
    or coalesce((
      select flag.enabled from public.admin_feature_flags flag
      where flag.key = 'partners_shadow_mode'
    ), true)
    or not coalesce((
      select flag.enabled from public.admin_feature_flags flag
      where flag.key = 'partners_cash_pilot_allowlist_only'
    ), false)
    or coalesce((
      select flag.enabled from public.admin_feature_flags flag
      where flag.key = 'partners_revolut_api_enabled'
    ), true)
  then
    raise exception 'financial canary feature flags are not fail-closed'
      using errcode = 'P0001';
  end if;

  for v_candidate in
    select
      account.id as account_id,
      account.country_code,
      program.id as program_version_id,
      fact.id as fact_id,
      accrual.id as accrual_entry_id,
      release.id as release_entry_id,
      profile.id as payout_profile_id
    from affiliate_private.affiliate_accounts account
    join auth.users user_row on user_row.id = account.user_id
    join affiliate_private.affiliate_pilot_allowlist allowlist_row
      on allowlist_row.user_id = account.user_id
    join affiliate_private.affiliate_program_versions program
      on program.id = account.program_version_id
    join affiliate_private.affiliate_financial_facts fact
      on fact.transaction_hash = v_transaction
      and fact.environment = 'production'
      and fact.facts_status = 'complete'
      and fact.event_type in ('capture', 'renewal')
      and fact.currency = v_currency
      and fact.currency_exponent = p_currency_exponent
    join affiliate_private.affiliate_attributions attribution
      on attribution.id = fact.attribution_id
      and attribution.referrer_account_id = account.id
      and attribution.program_version_id = program.id
      and attribution.status in ('attributed', 'qualified')
    join affiliate_private.affiliate_commission_jobs commission_job
      on commission_job.fact_id = fact.id
      and commission_job.job_kind = 'accrual'
      and commission_job.status = 'succeeded'
      and commission_job.completed_at is not null
    join affiliate_private.affiliate_commission_entries accrual
      on accrual.fact_id = fact.id
      and accrual.entry_kind = 'accrual'
      and accrual.account_id = account.id
      and accrual.currency = v_currency
      and accrual.currency_exponent = p_currency_exponent
      and accrual.amount_minor = p_amount_minor
      and accrual.matures_at = fact.occurred_at + interval '45 days'
    join affiliate_private.affiliate_maturation_jobs maturation_job
      on maturation_job.accrual_entry_id = accrual.id
      and maturation_job.status = 'succeeded'
      and maturation_job.available_at = accrual.matures_at
      and maturation_job.completed_at is not null
      and maturation_job.completed_at >= maturation_job.available_at
      and maturation_job.available_at <= statement_timestamp()
    join affiliate_private.affiliate_commission_entries release
      on release.fact_id = fact.id
      and release.entry_kind = 'release'
      and release.related_entry_id = accrual.id
      and release.account_id = account.id
      and release.currency = v_currency
      and release.currency_exponent = p_currency_exponent
      and release.amount_minor = p_amount_minor
      and release.created_at >= accrual.matures_at
    join affiliate_private.affiliate_fiscal_profiles fiscal
      on fiscal.account_id = account.id
      and fiscal.status = 'verified'
      and fiscal.residence_country_code = account.country_code
      and fiscal.declaration_version =
        'partners-tax-self-certification-v1'
      and fiscal.self_attested_at is not null
      and fiscal.reviewed_at is not null
    join affiliate_private.affiliate_payout_profiles profile
      on profile.account_id = account.id
      and profile.provider = 'revolut'
      and profile.currency = v_currency
      and profile.status = 'active'
    join affiliate_private.affiliate_revolut_beneficiary_bindings binding
      on binding.id = profile.revolut_binding_id
      and binding.binding_version = profile.revolut_binding_version
      and binding.account_id = profile.account_id
      and binding.currency = profile.currency
      and binding.status = 'active'
      and binding.beneficiary_token_ref = profile.beneficiary_token_ref
      and binding.beneficiary_payment_method_ref is not distinct from
        profile.beneficiary_payment_method_ref
      and binding.destination_masked = profile.display_masked
    join affiliate_private.affiliate_payout_provider_configs route
      on route.provider = 'revolut'
      and route.execution_adapter = 'revolut_manual'
      and route.country_code = account.country_code
      and route.currency = v_currency
      and route.status = 'active'
    cross join lateral (
      select balance_row.*
      from jsonb_to_recordset(
        affiliate_private.partners_account_balances(account.id)
      ) as balance_row(
        currency text,
        currency_exponent integer,
        pending_minor bigint,
        available_minor bigint,
        recovery_due_minor bigint,
        redeemed_minor bigint
      )
      where balance_row.currency = v_currency
    ) balance
    where account.user_pseudonym = v_subject
      and account.status = 'active'
      and account.member_status = 'active'
      and account.member_program_version_id = program.id
      and account.country_code ~ '^[A-Z]{2}$'
      and account.subdivision_code is null
      and account.verification_status = 'verified'
      and account.verification_provider = 'didit'
      and nullif(btrim(account.verification_reference), '') is not null
      and account.age_verified
      and account.capacity_verified
      and account.contract_status = 'accepted'
      and account.terms_version_accepted = program.terms_version
      and account.disclosure_version_accepted = program.disclosure_version
      and account.member_terms_version_accepted = program.terms_version
      and account.member_disclosure_version_accepted =
        program.disclosure_version
      and user_row.deleted_at is null
      and (
        user_row.banned_until is null
        or user_row.banned_until < clock_timestamp()
      )
      and user_row.email_confirmed_at is not null
      and allowlist_row.status = 'active'
      and (allowlist_row.expires_at is null
        or allowlist_row.expires_at > statement_timestamp())
      and allowlist_row.country_code = account.country_code
      and allowlist_row.subdivision_code is null
      and program.status = 'active'
      and program.maturation_days = 45
      and attribution.commission_rate_bps = program.commission_rate_bps
      and program.payout_thresholds ? v_currency
      and (program.payout_thresholds ->> v_currency)::bigint = p_amount_minor
      and affiliate_private.partners_commission_minor(
        fact.eligible_minor,
        attribution.commission_rate_bps
      ) = p_amount_minor
      and balance.currency_exponent = p_currency_exponent
      and balance.available_minor = p_amount_minor
      and balance.recovery_due_minor = 0
      and affiliate_private.partners_cash_readiness(account.id) ->> 'ready' =
        'true'
      and affiliate_private.partners_payout_balance_authoritative(
        account.id,
        v_currency
      )
      and exists (
        select 1
        from affiliate_private.affiliate_kyc_sessions kyc_session
        where kyc_session.account_id = account.id
          and kyc_session.provider_session_hash =
            account.verification_reference
          and kyc_session.provider = 'didit'
          and kyc_session.provider_status = 'approved'
          and kyc_session.provider_environment = 'live'
          and kyc_session.provider_config_fingerprint ~ '^[0-9a-f]{64}$'
          and kyc_session.provider_config_fingerprint <> repeat('0', 64)
          and kyc_session.status = 'verified'
          and kyc_session.provider_purge_status = 'purged'
          and kyc_session.provider_purged_at is not null
          and kyc_session.verified_at is not null
          and kyc_session.provider_purged_at >= kyc_session.verified_at
          and not exists (
            select 1
            from affiliate_private.affiliate_kyc_sessions newer_kyc_session
            where newer_kyc_session.account_id = kyc_session.account_id
              and newer_kyc_session.id <> kyc_session.id
              and newer_kyc_session.provider_environment = 'live'
              and newer_kyc_session.status <> 'superseded'
              and newer_kyc_session.created_at > kyc_session.created_at
          )
          and exists (
            select 1
            from affiliate_private.affiliate_kyc_webhook_events webhook_event
            where webhook_event.session_id = kyc_session.id
              and webhook_event.processing_outcome = 'verified'
              and webhook_event.provider_environment = 'live'
              and webhook_event.provider_config_fingerprint =
                kyc_session.provider_config_fingerprint
              and webhook_event.provider_event_at = kyc_session.verified_at
          )
      )
      and exists (
        select 1
        from affiliate_private.affiliate_payout_onboarding_requests request
        where request.account_id = account.id
          and request.currency = v_currency
          and request.execution_adapter = 'revolut_manual'
          and request.status = 'completed'
          and request.completed_at is not null
          and request.completed_by_pseudonym is not null
          and not exists (
            select 1
            from affiliate_private.affiliate_payout_onboarding_requests newer
            where newer.account_id = request.account_id
              and newer.currency = request.currency
              and newer.revision > request.revision
          )
      )
      and not exists (
        select 1
        from affiliate_private.affiliate_revolut_beneficiary_revocations revoked
        where revoked.binding_id = binding.id
      )
      and not exists (
        select 1
        from affiliate_private.affiliate_commission_entries reversal
        where reversal.related_entry_id = accrual.id
          and reversal.entry_kind in ('reversal', 'manual_reversal')
      )
      and not exists (
        select 1
        from affiliate_private.affiliate_financial_facts other
        where other.id <> fact.id
          and other.environment = 'production'
          and other.event_type in ('capture', 'renewal')
          and other.transaction_hash = v_transaction
      )
      and not exists (
        select 1
        from affiliate_private.affiliate_financial_facts child_fact
        where child_fact.environment = 'production'
          and child_fact.rail = fact.rail
          and child_fact.parent_transaction_hash = fact.transaction_hash
          and child_fact.event_type in ('refund', 'chargeback')
      )
      and not exists (
        select 1
        from affiliate_private.affiliate_commission_postings posting
        join affiliate_private.affiliate_commission_entries entry
          on entry.id = posting.entry_id
        where entry.account_id = account.id
          and entry.currency = v_currency
          and posting.ledger_account = 'partner_commission_available'
          and posting.entry_id <> release.id
      )
    order by account.id, profile.id
  loop
    v_candidate_count := v_candidate_count + 1;
    exit when v_candidate_count > 1;
  end loop;

  if v_candidate_count <> 1 then
    raise exception 'financial canary must resolve to exactly one payout item'
      using errcode = 'P0001';
  end if;

  if not affiliate_private.partners_financial_canary_authorization_current(
    v_authorization,
    v_candidate.program_version_id,
    v_candidate.country_code,
    v_commit
  ) then
    raise exception 'financial canary approval packages are not current'
      using errcode = 'P0001';
  end if;

  perform affiliate_private.partners_balance_lock(
    v_candidate.account_id,
    v_currency
  );

  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  v_result :=
    affiliate_private.admin_partners_payout_cycle_create_pre_aal2_20260802(
      p_period_start,
      p_period_end,
      v_currency,
      true,
      concat_ws(
        ':',
        'CREATE',
        p_period_start::text,
        p_period_end::text,
        v_currency,
        'LIVE'
      ),
      v_justification
    );

  select cycle.*
  into v_cycle
  from affiliate_private.affiliate_payout_cycles cycle
  where cycle.cycle_key = v_result #>> '{cycle,key}'
  for update;

  if not found
    or v_cycle.status <> 'draft'
    or not v_cycle.live_execution
    or v_cycle.period_start <> p_period_start
    or v_cycle.period_end <> p_period_end
    or v_cycle.currency <> v_currency
    or v_cycle.currency_exponent <> p_currency_exponent
    or v_cycle.item_count <> 1
    or v_cycle.total_minor <> p_amount_minor
    or (
      select count(*)
      from affiliate_private.affiliate_payout_items item
      where item.cycle_id = v_cycle.id
        and item.account_id = v_candidate.account_id
        and item.currency = v_currency
        and item.payout_profile_id = v_candidate.payout_profile_id
        and item.original_amount_minor = p_amount_minor
        and item.amount_minor = p_amount_minor
        and item.recovered_minor = 0
        and item.status = 'pending'
        and item.allocation_entry_id is null
    ) <> 1
  then
    raise exception 'created payout cycle differs from canary authorization'
      using errcode = 'P0004';
  end if;

  perform set_config(
    'norva.partners_financial_canary_control', 'create', true
  );
  insert into affiliate_private.affiliate_financial_canary_runs (
    authorization_sha256,
    transaction_hash,
    subject_pseudonym,
    account_id,
    program_version_id,
    fact_id,
    accrual_entry_id,
    release_entry_id,
    cycle_id,
    country_code,
    currency,
    currency_exponent,
    amount_minor,
    period_start,
    period_end,
    source_commit_sha,
    created_by_pseudonym
  ) values (
    v_authorization,
    v_transaction,
    v_subject,
    v_candidate.account_id,
    v_candidate.program_version_id,
    v_candidate.fact_id,
    v_candidate.accrual_entry_id,
    v_candidate.release_entry_id,
    v_cycle.id,
    v_candidate.country_code,
    v_currency,
    p_currency_exponent,
    p_amount_minor,
    p_period_start,
    p_period_end,
    v_commit,
    v_actor
  ) returning * into v_run;
  perform set_config(
    'norva.partners_financial_canary_control', '', true
  );

  if not affiliate_private.partners_financial_canary_lineage_current(
    v_run.id,
    true
  ) then
    raise exception 'financial canary lineage changed during cycle creation'
      using errcode = 'P0004';
  end if;

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
    v_cycle.cycle_key,
    'financial_canary_cycle_created',
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object(
      'state', 'draft',
      'live_execution', true,
      'country_code', v_run.country_code,
      'currency', v_run.currency,
      'currency_exponent', v_run.currency_exponent,
      'amount_minor', v_run.amount_minor,
      'period_start', v_run.period_start,
      'period_end', v_run.period_end
    )
  );

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'financial_canary_cycle_created',
    'run', jsonb_build_object(
      'key', v_run.run_key,
      'state', v_run.state
    ),
    'cycle', jsonb_build_object(
      'key', v_cycle.cycle_key,
      'status', v_cycle.status,
      'live_execution', v_cycle.live_execution,
      'currency', v_cycle.currency,
      'item_count', v_cycle.item_count,
      'total_minor', v_cycle.total_minor
    )
  );
end;
$$;

create function
affiliate_private.admin_partners_financial_canary_cycle_approve(
  p_cycle_key text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_cycle_key text := lower(btrim(coalesce(p_cycle_key, '')));
  v_confirmation text := btrim(coalesce(p_confirmation, ''));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_run affiliate_private.affiliate_financial_canary_runs%rowtype;
  v_cycle affiliate_private.affiliate_payout_cycles%rowtype;
  v_subject text;
  v_authorization text;
  v_transaction text;
  v_secret_rows integer;
  v_actor text;
  v_result jsonb;
  v_batch_result jsonb;
  v_batch affiliate_private.affiliate_revolut_manual_batches%rowtype;
begin
  perform affiliate_private.partners_require_capability('finance');
  perform affiliate_private.partners_require_aal2(
    'Partners financial canary approval'
  );
  if v_cycle_key !~ '^pay_[0-9a-f]{24}$'
    or v_confirmation <> 'APPROVE_FINANCIAL_CANARY:' || v_cycle_key
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid financial canary approval'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:release-control', 0)
  );
  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:financial-canary', 0)
  );

  select run.*
  into v_run
  from affiliate_private.affiliate_financial_canary_runs run
  join affiliate_private.affiliate_payout_cycles cycle
    on cycle.id = run.cycle_id
  where cycle.cycle_key = v_cycle_key
  for update of run;
  if not found or v_run.state <> 'draft' then
    raise exception 'financial canary draft is unavailable'
      using errcode = 'P0002';
  end if;

  select cycle.*
  into v_cycle
  from affiliate_private.affiliate_payout_cycles cycle
  where cycle.id = v_run.cycle_id
  for update;
  if not found
    or v_cycle.status <> 'draft'
    or not v_cycle.live_execution
    or v_cycle.item_count <> 1
    or v_cycle.total_minor <> v_run.amount_minor
  then
    raise exception 'financial canary cycle changed before approval'
      using errcode = 'P0004';
  end if;

  if exists (
    select 1
    from affiliate_private.affiliate_payout_cycles other_cycle
    where other_cycle.id <> v_cycle.id
      and other_cycle.live_execution
      and other_cycle.status not in ('settled', 'failed', 'cancelled')
  ) or exists (
    select 1
    from affiliate_private.affiliate_revolut_manual_batches batch
    where batch.status not in ('settled', 'cancelled')
  ) then
    raise exception 'another payout cycle or manual batch became open'
      using errcode = 'P0004';
  end if;

  select count(*)::integer, min(secret.decrypted_secret)
  into v_secret_rows, v_subject
  from vault.decrypted_secrets secret
  where secret.name =
      'norva_partners_financial_canary_subject_pseudonym_v1'
    and secret.decrypted_secret ~ '^[0-9a-f]{64}$';
  if v_secret_rows <> 1 or v_subject <> v_run.subject_pseudonym then
    raise exception 'financial canary subject binding changed'
      using errcode = 'P0004';
  end if;

  select count(*)::integer, min(secret.decrypted_secret)
  into v_secret_rows, v_authorization
  from vault.decrypted_secrets secret
  where secret.name =
      'norva_partners_financial_canary_authorization_sha256_v1'
    and secret.decrypted_secret ~ '^[0-9a-f]{64}$';
  if v_secret_rows <> 1
    or v_authorization <> v_run.authorization_sha256
  then
    raise exception 'financial canary authorization changed'
      using errcode = 'P0004';
  end if;

  select count(*)::integer, min(secret.decrypted_secret)
  into v_secret_rows, v_transaction
  from vault.decrypted_secrets secret
  where secret.name =
      'norva_partners_financial_canary_transaction_hash_v1'
    and secret.decrypted_secret ~ '^[0-9a-f]{64}$';
  if v_secret_rows <> 1 or v_transaction <> v_run.transaction_hash then
    raise exception 'financial canary transaction binding changed'
      using errcode = 'P0004';
  end if;

  if not affiliate_private.partners_financial_canary_authorization_current(
      v_run.authorization_sha256,
      v_run.program_version_id,
      v_run.country_code,
      v_run.source_commit_sha
    )
    or not affiliate_private.partners_financial_canary_lineage_current(
      v_run.id,
      true
    )
  then
    raise exception 'financial canary evidence is no longer current'
      using errcode = 'P0004';
  end if;

  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  if v_actor = v_run.created_by_pseudonym then
    raise exception 'financial canary maker and checker must be distinct'
      using errcode = 'P0001';
  end if;

  perform set_config(
    'norva.partners_financial_canary_control', 'approve', true
  );
  update affiliate_private.affiliate_financial_canary_runs run
  set
    state = 'approved',
    approved_by_pseudonym = v_actor,
    approved_at = now()
  where run.id = v_run.id
    and run.state = 'draft'
  returning * into v_run;
  if not found then
    raise exception 'financial canary authorization was already consumed'
      using errcode = 'P0004';
  end if;

  -- Marking the private authorization approved first is safe because this
  -- whole function is one transaction: any failure in the delegated approval
  -- rolls the state transition back.  The payout-cycle trigger requires this
  -- same-transaction state and actor, so an authenticated caller cannot bypass
  -- the dedicated checker path by setting a custom GUC.
  v_result :=
    affiliate_private.admin_partners_payout_cycle_approve_pre_aal2_20260802(
      v_cycle_key,
      'APPROVE:' || v_cycle_key,
      v_justification
    );

  -- Never commit the high-risk intermediate state "approved without batch".
  -- Preparation uses the established manual-payout contract in this same
  -- transaction; any preparation failure rolls the run, allocation and cycle
  -- approval back to their draft state, where the dedicated abort remains safe.
  v_batch_result :=
    affiliate_private.admin_partners_revolut_manual_batch_prepare(
      v_cycle_key,
      'PREPARE:' || v_cycle_key,
      v_justification
    );
  select batch.*
  into v_batch
  from affiliate_private.affiliate_revolut_manual_batches batch
  where batch.cycle_id = v_run.cycle_id
  for update;
  if not found
    or v_batch.status <> 'prepared'
    or v_batch.prepared_by_pseudonym is distinct from v_actor
    or v_batch.currency <> v_run.currency
    or v_batch.currency_exponent <> v_run.currency_exponent
    or v_batch.total_minor <> v_run.amount_minor
    or v_batch.item_count <> 1
    or (v_batch_result ->> 'action')
      is distinct from 'revolut_manual_batch_prepared'
    or (v_batch_result ->> 'replayed')::boolean is distinct from false
    or (v_batch_result #>> '{batch,key}') is distinct from v_batch.batch_key
    or (v_batch_result #>> '{batch,status}') is distinct from 'prepared'
    or (v_batch_result #>> '{batch,item_count}')::integer
      is distinct from 1
    or (v_batch_result #>> '{batch,total_minor}')::bigint
      is distinct from
      v_run.amount_minor
    or (v_batch_result #>> '{batch,currency}')
      is distinct from v_run.currency
    or (
      select count(*)
      from affiliate_private.affiliate_revolut_payout_executions execution
      join affiliate_private.affiliate_payout_items execution_item
        on execution_item.id = execution.payout_item_id
      where execution.manual_batch_id = v_batch.id
        and execution_item.cycle_id = v_run.cycle_id
        and execution_item.account_id = v_run.account_id
        and execution_item.allocation_entry_id is not null
        and execution.adapter = 'revolut_manual'
        and execution.state = 'prepared'
        and execution.prepared_by_pseudonym = v_actor
        and execution.amount_minor = v_run.amount_minor
        and execution.currency = v_run.currency
        and execution.currency_exponent = v_run.currency_exponent
    ) <> 1
  then
    raise exception 'financial canary manual batch is not exact'
      using errcode = 'P0004';
  end if;

  select cycle.*
  into v_cycle
  from affiliate_private.affiliate_payout_cycles cycle
  where cycle.id = v_run.cycle_id;
  if not found
    or v_cycle.status <> 'approved'
    or v_cycle.approved_by_pseudonym <> v_actor
    or v_cycle.approved_at <> transaction_timestamp()
    or v_cycle.item_count <> 1
    or v_cycle.total_minor <> v_run.amount_minor
    or (v_result #>> '{cycle,key}') is distinct from v_cycle_key
    or (v_result #>> '{cycle,status}') is distinct from 'approved'
    or not affiliate_private.partners_financial_canary_lineage_current(
      v_run.id,
      false
    )
  then
    raise exception 'financial canary approval did not preserve exact lineage'
      using errcode = 'P0004';
  end if;
  perform set_config(
    'norva.partners_financial_canary_control', '', true
  );

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'financial_canary_cycle_approved',
    'run', jsonb_build_object(
      'key', v_run.run_key,
      'state', v_run.state
    ),
    'cycle', v_result -> 'cycle',
    'batch', v_batch_result -> 'batch'
  );
end;
$$;

-- Emergency operator exit for the one-shot canary.  It deliberately refuses
-- to touch a cycle once a manual batch or payout execution exists: from that
-- point onward the normal evidence-backed cancellation/reconciliation RPCs are
-- authoritative.  It only closes an unallocated draft cycle; an approved
-- allocation must go through the existing two-person manual-batch cancellation
-- contract and is never released by this single-actor emergency RPC.
create function
affiliate_private.admin_partners_financial_canary_cycle_abort(
  p_cycle_key text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_cycle_key text := lower(btrim(coalesce(p_cycle_key, '')));
  v_confirmation text := btrim(coalesce(p_confirmation, ''));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_run affiliate_private.affiliate_financial_canary_runs%rowtype;
  v_cycle affiliate_private.affiliate_payout_cycles%rowtype;
  v_item affiliate_private.affiliate_payout_items%rowtype;
  v_item_count integer;
  v_actor text;
  v_stage text;
begin
  perform affiliate_private.partners_require_capability('finance');
  perform affiliate_private.partners_require_aal2(
    'Partners financial canary abort'
  );
  if v_cycle_key !~ '^pay_[0-9a-f]{24}$'
    or v_confirmation <> 'ABORT_FINANCIAL_CANARY:' || v_cycle_key
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid financial canary abort'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:release-control', 0)
  );
  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:financial-canary', 0)
  );
  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:financial-canary-abort:' || v_cycle_key,
      0
    )
  );

  select run.*
  into v_run
  from affiliate_private.affiliate_financial_canary_runs run
  join affiliate_private.affiliate_payout_cycles cycle
    on cycle.id = run.cycle_id
  where cycle.cycle_key = v_cycle_key
  for update of run;
  if not found then
    raise exception 'financial canary is unavailable'
      using errcode = 'P0002';
  end if;
  select cycle.*
  into v_cycle
  from affiliate_private.affiliate_payout_cycles cycle
  where cycle.id = v_run.cycle_id
  for update;
  if not found or v_cycle.cycle_key <> v_cycle_key then
    raise exception 'financial canary cycle changed during abort'
      using errcode = 'P0004';
  end if;

  -- A batch means export/submission evidence may already exist.  The canary
  -- abort must not bypass the normal two-person cancellation or reconciliation
  -- workflows, even when that batch currently appears prepared or cancelled.
  if exists (
    select 1
    from affiliate_private.affiliate_revolut_manual_batches batch
    where batch.cycle_id = v_cycle.id
  ) or exists (
    select 1
    from affiliate_private.affiliate_revolut_payout_executions execution
    join affiliate_private.affiliate_payout_items execution_item
      on execution_item.id = execution.payout_item_id
    where execution_item.cycle_id = v_cycle.id
  ) then
    raise exception
      'financial canary has a batch; use normal cancellation or reconciliation'
      using errcode = 'P0003';
  end if;

  select count(*)::integer
  into v_item_count
  from affiliate_private.affiliate_payout_items item
  where item.cycle_id = v_cycle.id;
  if v_item_count <> 1 then
    raise exception 'financial canary item cardinality changed during abort'
      using errcode = 'P0004';
  end if;
  select item.*
  into v_item
  from affiliate_private.affiliate_payout_items item
  where item.cycle_id = v_cycle.id
  for update;

  if v_cycle.item_count <> 1
    or v_cycle.total_minor <> v_run.amount_minor
    or v_item.account_id <> v_run.account_id
    or v_item.currency <> v_run.currency
    or v_item.original_amount_minor <> v_run.amount_minor
    or v_item.amount_minor <> v_run.amount_minor
    or v_item.recovered_minor <> 0
    or v_item.status <> 'pending'
    or v_item.provider_transfer_hash is not null
  then
    raise exception 'financial canary item changed during abort'
      using errcode = 'P0004';
  end if;

  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  if v_run.state = 'draft'
    and v_cycle.status = 'draft'
    and v_item.allocation_entry_id is null
  then
    v_stage := 'before_approval';
    update affiliate_private.affiliate_payout_cycles cycle
    set status = 'cancelled', updated_at = now()
    where cycle.id = v_cycle.id
      and cycle.status = 'draft';
    if not found then
      raise exception 'financial canary cycle changed during abort'
        using errcode = 'P0004';
    end if;
  else
    raise exception
      'approved financial canary requires normal batch cancellation workflow'
      using errcode = 'P0003';
  end if;

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
    v_cycle.cycle_key,
    'financial_canary_cycle_aborted',
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object(
      'run_state', v_run.state,
      'cycle_status', v_cycle.status,
      'item_status', v_item.status,
      'allocation_present', v_item.allocation_entry_id is not null
    ),
    jsonb_build_object(
      'abort_stage', v_stage,
      'cycle_status', 'cancelled',
      'item_status', 'pending',
      'released_minor', 0,
      'currency', v_run.currency
    )
  );

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'financial_canary_cycle_aborted',
    'run', jsonb_build_object(
      'key', v_run.run_key,
      'state', v_run.state
    ),
    'cycle', jsonb_build_object(
      'key', v_cycle.cycle_key,
      'status', 'cancelled'
    ),
    'abort_stage', v_stage,
    'released_minor', 0,
    'currency', v_run.currency
  );
end;
$$;

-- Any later manual-batch preparation for the canary is also fail-closed: the
-- three fixed Vault bindings and the current approval packages must still match
-- the immutable run.  Ordinary non-canary batches are unchanged.
create function
affiliate_private.guard_financial_canary_manual_batch()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run affiliate_private.affiliate_financial_canary_runs%rowtype;
  v_value text;
  v_rows integer;
begin
  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:release-control', 0)
  );

  if exists (
    select 1
    from affiliate_private.affiliate_financial_canary_runs active_run
    join affiliate_private.affiliate_payout_cycles active_cycle
      on active_cycle.id = active_run.cycle_id
    where active_run.state in ('draft', 'approved')
      and active_cycle.status not in ('settled', 'failed', 'cancelled')
  ) and not exists (
    select 1
    from affiliate_private.affiliate_financial_canary_runs linked_run
    join affiliate_private.affiliate_payout_cycles linked_cycle
      on linked_cycle.id = linked_run.cycle_id
    where linked_run.cycle_id = new.cycle_id
      and linked_run.state in ('draft', 'approved')
      and linked_cycle.status not in ('settled', 'failed', 'cancelled')
  ) then
    raise exception 'financial canary release control is active'
      using errcode = 'P0004';
  end if;

  select run.*
  into v_run
  from affiliate_private.affiliate_financial_canary_runs run
  where run.cycle_id = new.cycle_id;
  if not found then
    return new;
  end if;
  if v_run.state <> 'approved'
    or new.status <> 'prepared'
    or new.currency <> v_run.currency
    or new.currency_exponent <> v_run.currency_exponent
    or new.total_minor <> v_run.amount_minor
    or new.item_count <> 1
  then
    raise exception 'manual batch differs from financial canary authorization'
      using errcode = 'P0004';
  end if;

  select count(*)::integer, min(secret.decrypted_secret)
  into v_rows, v_value
  from vault.decrypted_secrets secret
  where secret.name =
      'norva_partners_financial_canary_subject_pseudonym_v1'
    and secret.decrypted_secret ~ '^[0-9a-f]{64}$';
  if v_rows <> 1 or v_value <> v_run.subject_pseudonym then
    raise exception 'financial canary subject binding is unavailable'
      using errcode = 'P0004';
  end if;

  select count(*)::integer, min(secret.decrypted_secret)
  into v_rows, v_value
  from vault.decrypted_secrets secret
  where secret.name =
      'norva_partners_financial_canary_authorization_sha256_v1'
    and secret.decrypted_secret ~ '^[0-9a-f]{64}$';
  if v_rows <> 1 or v_value <> v_run.authorization_sha256 then
    raise exception 'financial canary authorization is unavailable'
      using errcode = 'P0004';
  end if;

  select count(*)::integer, min(secret.decrypted_secret)
  into v_rows, v_value
  from vault.decrypted_secrets secret
  where secret.name =
      'norva_partners_financial_canary_transaction_hash_v1'
    and secret.decrypted_secret ~ '^[0-9a-f]{64}$';
  if v_rows <> 1 or v_value <> v_run.transaction_hash then
    raise exception 'financial canary transaction binding is unavailable'
      using errcode = 'P0004';
  end if;

  if not affiliate_private.partners_financial_canary_authorization_current(
    v_run.authorization_sha256,
    v_run.program_version_id,
    v_run.country_code,
    v_run.source_commit_sha
  ) or not affiliate_private.partners_financial_canary_lineage_current(
    v_run.id,
    false
  ) or exists (
    select 1
    from affiliate_private.affiliate_revolut_manual_batches other_batch
    where other_batch.status not in ('settled', 'cancelled')
  ) or exists (
    select 1
    from affiliate_private.affiliate_payout_cycles other_cycle
    where other_cycle.id <> v_run.cycle_id
      and other_cycle.live_execution
      and other_cycle.status not in ('settled', 'failed', 'cancelled')
  ) then
    raise exception 'financial canary approval packages are no longer current'
      using errcode = 'P0004';
  end if;
  return new;
end;
$$;

create trigger affiliate_revolut_manual_batches_financial_canary_guard
before insert on affiliate_private.affiliate_revolut_manual_batches
for each row execute function
  affiliate_private.guard_financial_canary_manual_batch();

create or replace function
public.admin_partners_financial_canary_cycle_create(
  p_period_start date,
  p_period_end date,
  p_currency text,
  p_currency_exponent integer,
  p_amount_minor bigint,
  p_source_commit_sha text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.admin_partners_financial_canary_cycle_create(
    p_period_start,
    p_period_end,
    p_currency,
    p_currency_exponent,
    p_amount_minor,
    p_source_commit_sha,
    p_confirmation,
    p_justification
  );
$$;

create or replace function
public.admin_partners_financial_canary_cycle_approve(
  p_cycle_key text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.admin_partners_financial_canary_cycle_approve(
    p_cycle_key,
    p_confirmation,
    p_justification
  );
$$;

create or replace function
public.admin_partners_financial_canary_cycle_abort(
  p_cycle_key text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.admin_partners_financial_canary_cycle_abort(
    p_cycle_key,
    p_confirmation,
    p_justification
  );
$$;

revoke all on function
  affiliate_private.guard_financial_canary_run_mutation()
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_financial_canary_authorization_current(
    text, uuid, text, text
  )
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_financial_canary_lineage_current(uuid, boolean)
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.guard_financial_canary_cycle_exclusivity()
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.guard_financial_canary_cycle_approval()
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.guard_financial_canary_manual_batch()
  from public, anon, authenticated, service_role;

revoke all on function
  affiliate_private.admin_partners_financial_canary_cycle_create(
    date, date, text, integer, bigint, text, text, text
  )
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.admin_partners_financial_canary_cycle_approve(
    text, text, text
  )
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.admin_partners_financial_canary_cycle_abort(
    text, text, text
  )
  from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_financial_canary_cycle_create(
    date, date, text, integer, bigint, text, text, text
  )
  to authenticated;
grant execute on function
  affiliate_private.admin_partners_financial_canary_cycle_approve(
    text, text, text
  )
  to authenticated;
grant execute on function
  affiliate_private.admin_partners_financial_canary_cycle_abort(
    text, text, text
  )
  to authenticated;

revoke all on function
  public.admin_partners_financial_canary_cycle_create(
    date, date, text, integer, bigint, text, text, text
  )
  from public, anon, service_role;
revoke all on function
  public.admin_partners_financial_canary_cycle_approve(text, text, text)
  from public, anon, service_role;
revoke all on function
  public.admin_partners_financial_canary_cycle_abort(text, text, text)
  from public, anon, service_role;
grant execute on function
  public.admin_partners_financial_canary_cycle_create(
    date, date, text, integer, bigint, text, text, text
  )
  to authenticated;
grant execute on function
  public.admin_partners_financial_canary_cycle_approve(text, text, text)
  to authenticated;
grant execute on function
  public.admin_partners_financial_canary_cycle_abort(text, text, text)
  to authenticated;

comment on table affiliate_private.affiliate_financial_canary_runs is
  'Private immutable one-shot binding between financial canary authorization, exact production transaction, payout cycle and maker-checker evidence.';
comment on function
  public.admin_partners_financial_canary_cycle_create(
    date, date, text, integer, bigint, text, text, text
  ) is
  'Finance+AAL2 maker entry point. Atomically creates one exact live manual-payout canary cycle and consumes the bound authorization+transaction once.';
comment on function
  public.admin_partners_financial_canary_cycle_approve(text, text, text) is
  'Finance+AAL2 checker entry point. Revalidates Vault, authorization packages and exact J+45 lineage, then atomically approves the cycle and prepares its exact manual batch.';
comment on function
  public.admin_partners_financial_canary_cycle_abort(text, text, text) is
  'Finance+AAL2 fail-closed exit for an unallocated draft canary only. Cancels the draft cycle, preserves its pending item snapshot, records an audit event, and rejects every approved or batched cycle.';
