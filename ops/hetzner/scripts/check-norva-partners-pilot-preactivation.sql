-- Read-only database preflight for one explicitly selected pilot corridor.
--
-- This file intentionally checks the state immediately before the final
-- Partners/TV flag promotion. It never enables a flag, satisfies a gate,
-- creates an allowlist entry or schedules a cron. Provider and human evidence
-- remains governed by docs/NORVA-PARTNERS-RELEASE-EVIDENCE.md.

begin transaction read only;

with
preactivation_mode(mode_key) as (
  select :'preactivation_mode'::text
),
required_canary_authorization_gates(gate_key) as (
  values
    ('legal_and_tax_approved'::text),
    ('privacy_approved'),
    ('country_policy_approved'),
    ('manual_payout_workflow_verified')
),
expected_flags(flag_key, expected_enabled) as (
  values
    ('partners_enabled'::text, true),
    ('partners_invite_only', false),
    ('partners_cash_pilot_allowlist_only', true),
    ('partners_earnings_enabled', true),
    ('partners_credit_redemptions_enabled', true),
    ('partners_shadow_mode', true),
    ('partners_payouts_live', false),
    ('partners_tv_relay_enabled', false),
    ('partners_revolut_api_enabled', false)
),
required_gates(gate_key, expected_satisfied) as (
  values
    ('legal_and_tax_approved'::text, true),
    ('privacy_approved', true),
    ('individual_verification_coverage_confirmed', true),
    ('individual_payout_coverage_confirmed', true),
    ('country_policy_approved', true),
    ('financial_data_contract_approved', true),
    ('shadow_reconciliation_clean', true),
    ('backup_restore_verified', true),
    ('payout_execution_adapter_verified', true),
    ('tv_relay_security_verified', true),
    ('manual_payout_workflow_verified', true),
    ('general_release_approved', false),
    ('revolut_api_adapter_verified', false)
),
expected_currencies(currency_code, exponent) as (
  select 'USD'::text, 2
  union
  select :'pilot_currency'::text, :pilot_currency_exponent::integer
),
expected_workers(worker_name) as (
  values
    ('commission'::text),
    ('correction'),
    ('maturation'),
    ('reconciliation'),
    ('revenuecat_transfer')
),
matching_programs as (
  select program.id
  from affiliate_private.affiliate_program_versions program
  where program.status = 'active'
    and program.account_type = 'individual'
    and program.commission_rate_bps = 2000
    and program.attribution_window_days = 30
    and program.maturation_days = 45
    and program.threshold_reference_currency = 'USD'
    and program.threshold_reference_minor = 1000
    and program.payout_fee_policy = 'platform_absorbed'
    and case
      when jsonb_typeof(program.payout_thresholds -> 'USD') = 'number'
        then (program.payout_thresholds ->> 'USD')::numeric = 1000
      else false
    end
    and case
      when jsonb_typeof(
        program.payout_thresholds -> :'pilot_currency'
      ) = 'number'
        then (program.payout_thresholds ->> :'pilot_currency')::numeric =
          :pilot_threshold_minor::numeric
      else false
    end
    and program.effective_from <= clock_timestamp()
    and (
      program.effective_until is null
      or program.effective_until > clock_timestamp()
    )
),
pilot_policies as (
  select policy.id
  from affiliate_private.affiliate_country_policies policy
  join matching_programs program on program.id = policy.program_version_id
  where policy.country_code = :'pilot_country'
    and policy.subdivision_code is null
    and policy.individual_available
    and policy.minimum_age = :pilot_minimum_age::integer
    and policy.capacity_required
    and policy.verification_level = 'identity_age_country_capacity'
    and policy.verification_provider = 'didit'
    and policy.payout_currencies = array[:'pilot_currency']::text[]
    and coalesce(policy.effective_from, clock_timestamp()) <= clock_timestamp()
    and (
      policy.effective_until is null
      or policy.effective_until > clock_timestamp()
    )
),
allowlist_stats as (
  select
    count(*) filter (
      where entry.status = 'active'
        and (entry.expires_at is null or entry.expires_at > clock_timestamp())
    )::integer as active_count,
    count(*) filter (
      where entry.status = 'active'
        and (entry.expires_at is null or entry.expires_at > clock_timestamp())
        and entry.country_code = :'pilot_country'
    )::integer as pilot_country_count,
    count(*) filter (
      where entry.status = 'active'
        and (entry.expires_at is null or entry.expires_at > clock_timestamp())
        and entry.country_code = :'pilot_country'
        and user_row.deleted_at is null
        and (
          user_row.banned_until is null
          or user_row.banned_until < clock_timestamp()
        )
        and user_row.email_confirmed_at is not null
    )::integer as confirmed_pilot_country_count
  from affiliate_private.affiliate_pilot_allowlist entry
  join auth.users user_row on user_row.id = entry.user_id
),
canary_subject_secret as (
  select
    count(*)::integer as row_count,
    count(*) filter (
      where secret.decrypted_secret ~ '^[0-9a-f]{64}$'
    )::integer as valid_count,
    min(secret.decrypted_secret) filter (
      where secret.decrypted_secret ~ '^[0-9a-f]{64}$'
    ) as subject_pseudonym
  from vault.decrypted_secrets secret
  where secret.name =
    'norva_partners_financial_canary_subject_pseudonym_v1'
),
canary_authorization_secret as (
  select
    count(*)::integer as row_count,
    count(*) filter (
      where secret.decrypted_secret ~ '^[0-9a-f]{64}$'
    )::integer as valid_count,
    min(secret.decrypted_secret) filter (
      where secret.decrypted_secret ~ '^[0-9a-f]{64}$'
    ) as authorization_sha256
  from vault.decrypted_secrets secret
  where secret.name =
    'norva_partners_financial_canary_authorization_sha256_v1'
),
canary_transaction_secret as (
  select
    count(*)::integer as row_count,
    count(*) filter (
      where secret.decrypted_secret ~ '^[0-9a-f]{64}$'
    )::integer as valid_count,
    min(secret.decrypted_secret) filter (
      where secret.decrypted_secret ~ '^[0-9a-f]{64}$'
    ) as transaction_hash
  from vault.decrypted_secrets secret
  where secret.name =
    'norva_partners_financial_canary_transaction_hash_v1'
),
canary_bound_accounts as (
  select account.*
  from canary_subject_secret secret
  join affiliate_private.affiliate_accounts account
    on account.user_pseudonym = secret.subject_pseudonym
  join affiliate_private.affiliate_pilot_allowlist entry
    on entry.user_id = account.user_id
  join auth.users user_row on user_row.id = entry.user_id
  where secret.row_count = 1
    and secret.valid_count = 1
    and entry.status = 'active'
    and (entry.expires_at is null or entry.expires_at > clock_timestamp())
    and entry.country_code = :'pilot_country'
    and user_row.deleted_at is null
    and (
      user_row.banned_until is null
      or user_row.banned_until < clock_timestamp()
    )
    and user_row.email_confirmed_at is not null
),
canary_ready_accounts as (
  select account.id
  from canary_bound_accounts account
  join affiliate_private.affiliate_fiscal_profiles fiscal
    on fiscal.account_id = account.id
  where account.member_status = 'active'
    and account.status = 'active'
    and account.program_version_id in (select id from matching_programs)
    and account.member_program_version_id = account.program_version_id
    and account.country_policy_id in (select id from pilot_policies)
    and account.country_code = :'pilot_country'
    and account.subdivision_code is null
    and account.verification_status = 'verified'
    and account.verification_provider = 'didit'
    and nullif(btrim(account.verification_reference), '') is not null
    and account.age_verified
    and account.capacity_verified
    and exists (
      select 1
      from affiliate_private.affiliate_kyc_sessions session
      where session.account_id = account.id
        and session.provider_session_hash = account.verification_reference
        and session.provider = 'didit'
        and session.provider_status = 'approved'
        and session.provider_environment = 'live'
        and session.provider_config_fingerprint ~ '^[0-9a-f]{64}$'
        and session.provider_config_fingerprint <> repeat('0', 64)
        and session.status = 'verified'
        and session.provider_purge_status = 'purged'
        and session.provider_purged_at is not null
        and session.verified_at is not null
        and session.provider_purged_at >= session.verified_at
        and not exists (
          select 1
          from affiliate_private.affiliate_kyc_sessions newer_session
          where newer_session.account_id = session.account_id
            and newer_session.id <> session.id
            and newer_session.provider_environment = 'live'
            and newer_session.status <> 'superseded'
            and newer_session.created_at > session.created_at
        )
        and exists (
          select 1
          from affiliate_private.affiliate_kyc_webhook_events event
          where event.session_id = session.id
            and event.processing_outcome = 'verified'
            and event.provider_environment = 'live'
            and event.provider_config_fingerprint =
              session.provider_config_fingerprint
            and event.provider_event_at = session.verified_at
        )
    )
    and account.contract_status = 'accepted'
    and nullif(btrim(account.terms_version_accepted), '') is not null
    and account.contract_accepted_at is not null
    and nullif(btrim(account.disclosure_version_accepted), '') is not null
    and account.disclosure_accepted_at is not null
    and exists (
      select 1
      from matching_programs matching
      join affiliate_private.affiliate_program_versions program
        on program.id = matching.id
      where program.id = account.member_program_version_id
        and program.terms_version = account.member_terms_version_accepted
        and program.disclosure_version =
          account.member_disclosure_version_accepted
        and program.terms_version = account.terms_version_accepted
        and program.disclosure_version = account.disclosure_version_accepted
    )
    and fiscal.residence_country_code = :'pilot_country'
    and fiscal.status = 'verified'
    and fiscal.declaration_version = 'partners-tax-self-certification-v1'
    and fiscal.self_attested_at is not null
    and fiscal.reviewed_at is not null
    and exists (
      select 1
      from affiliate_private.affiliate_payout_onboarding_requests request
      where request.account_id = account.id
        and request.currency = :'pilot_currency'
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
    and exists (
      select 1
      from affiliate_private.affiliate_payout_profiles profile
      join affiliate_private.affiliate_revolut_beneficiary_bindings binding
        on binding.id = profile.revolut_binding_id
        and binding.binding_version = profile.revolut_binding_version
        and binding.account_id = profile.account_id
        and binding.currency = profile.currency
      where profile.account_id = account.id
        and profile.provider = 'revolut'
        and profile.currency = :'pilot_currency'
        and profile.status = 'active'
        and binding.status = 'active'
        and binding.beneficiary_token_ref = profile.beneficiary_token_ref
        and binding.beneficiary_payment_method_ref is not distinct from
          profile.beneficiary_payment_method_ref
        and binding.destination_masked = profile.display_masked
        and not exists (
          select 1
          from affiliate_private.affiliate_revolut_beneficiary_revocations
            revocation
          where revocation.binding_id = binding.id
        )
    )
    and affiliate_private.partners_cash_readiness(account.id) ->> 'ready' =
      'true'
    and affiliate_private.partners_payout_balance_authoritative(
      account.id,
      :'pilot_currency'
    )
),
canary_balance_stats as (
  select
    count(*) filter (
      where balance.currency = :'pilot_currency'
    )::integer as balance_row_count,
    count(*) filter (
      where balance.currency = :'pilot_currency'
        and balance.currency_exponent = :pilot_currency_exponent::integer
        and balance.available_minor = :pilot_threshold_minor::bigint
        and balance.recovery_due_minor = 0
    )::integer as eligible_balance_count
  from canary_ready_accounts account
  cross join lateral jsonb_to_recordset(
    affiliate_private.partners_account_balances(account.id)
  ) as balance(
    currency text,
    currency_exponent integer,
    pending_minor bigint,
    available_minor bigint,
    recovery_due_minor bigint,
    redeemed_minor bigint
  )
),
canary_lineage_candidates as (
  select
    account.id as account_id,
    fact.id as fact_id,
    accrual.id as accrual_entry_id,
    release.id as release_entry_id
  from canary_ready_accounts ready
  join affiliate_private.affiliate_accounts account
    on account.id = ready.id
  join affiliate_private.affiliate_program_versions program
    on program.id = account.program_version_id
  cross join canary_transaction_secret secret
  join affiliate_private.affiliate_financial_facts fact
    on fact.transaction_hash = secret.transaction_hash
    and fact.environment = 'production'
    and fact.facts_status = 'complete'
    and fact.event_type in ('capture', 'renewal')
    and fact.currency = :'pilot_currency'
    and fact.currency_exponent = :pilot_currency_exponent::integer
  join affiliate_private.affiliate_attributions attribution
    on attribution.id = fact.attribution_id
    and attribution.referrer_account_id = account.id
    and attribution.program_version_id = program.id
    and attribution.status in ('attributed', 'qualified')
    and attribution.commission_rate_bps = program.commission_rate_bps
  join affiliate_private.affiliate_commission_jobs commission_job
    on commission_job.fact_id = fact.id
    and commission_job.job_kind = 'accrual'
    and commission_job.status = 'succeeded'
    and commission_job.completed_at is not null
  join affiliate_private.affiliate_commission_entries accrual
    on accrual.fact_id = fact.id
    and accrual.entry_kind = 'accrual'
    and accrual.account_id = account.id
    and accrual.currency = :'pilot_currency'
    and accrual.currency_exponent = :pilot_currency_exponent::integer
    and accrual.amount_minor = :pilot_threshold_minor::bigint
    and accrual.matures_at = fact.occurred_at + interval '45 days'
  join affiliate_private.affiliate_maturation_jobs maturation_job
    on maturation_job.accrual_entry_id = accrual.id
    and maturation_job.status = 'succeeded'
    and maturation_job.available_at = accrual.matures_at
    and maturation_job.completed_at is not null
    and maturation_job.completed_at >= maturation_job.available_at
    and maturation_job.available_at <= clock_timestamp()
  join affiliate_private.affiliate_commission_entries release
    on release.fact_id = fact.id
    and release.entry_kind = 'release'
    and release.related_entry_id = accrual.id
    and release.account_id = account.id
    and release.currency = :'pilot_currency'
    and release.currency_exponent = :pilot_currency_exponent::integer
    and release.amount_minor = :pilot_threshold_minor::bigint
    and release.created_at >= accrual.matures_at
  where secret.row_count = 1
    and secret.valid_count = 1
    and program.maturation_days = 45
    and program.payout_thresholds ? :'pilot_currency'
    and (program.payout_thresholds ->> :'pilot_currency')::bigint =
      :pilot_threshold_minor::bigint
    and affiliate_private.partners_commission_minor(
      fact.eligible_minor,
      attribution.commission_rate_bps
    ) = :pilot_threshold_minor::bigint
    and (
      select count(*) = 2
        and count(*) filter (
          where posting.ledger_account = 'platform_commission_expense'
            and posting.direction = 'debit'
            and posting.amount_minor = :pilot_threshold_minor::bigint
            and posting.currency = :'pilot_currency'
        ) = 1
        and count(*) filter (
          where posting.ledger_account = 'partner_commission_pending'
            and posting.direction = 'credit'
            and posting.amount_minor = :pilot_threshold_minor::bigint
            and posting.currency = :'pilot_currency'
        ) = 1
      from affiliate_private.affiliate_commission_postings posting
      where posting.entry_id = accrual.id
    )
    and (
      select count(*) = 2
        and count(*) filter (
          where posting.ledger_account = 'partner_commission_pending'
            and posting.direction = 'debit'
            and posting.amount_minor = :pilot_threshold_minor::bigint
            and posting.currency = :'pilot_currency'
        ) = 1
        and count(*) filter (
          where posting.ledger_account = 'partner_commission_available'
            and posting.direction = 'credit'
            and posting.amount_minor = :pilot_threshold_minor::bigint
            and posting.currency = :'pilot_currency'
        ) = 1
      from affiliate_private.affiliate_commission_postings posting
      where posting.entry_id = release.id
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
        and other.transaction_hash = secret.transaction_hash
    )
    and not exists (
      select 1
      from affiliate_private.affiliate_financial_facts child_fact
      where child_fact.environment = 'production'
        and child_fact.rail = fact.rail
        and child_fact.parent_transaction_hash = secret.transaction_hash
        and child_fact.event_type in ('refund', 'chargeback')
    )
    and not exists (
      select 1
      from affiliate_private.affiliate_commission_postings posting
      join affiliate_private.affiliate_commission_entries entry
        on entry.id = posting.entry_id
      where entry.account_id = account.id
        and entry.currency = :'pilot_currency'
        and posting.ledger_account = 'partner_commission_available'
        and posting.entry_id <> release.id
    )
),
canary_lineage_stats as (
  select count(*)::integer as exact_lineage_count
  from canary_lineage_candidates
),
canary_cycle_candidates as (
  select
    balance.account_id,
    profile.id as payout_profile_id,
    balance.available_minor
  from (
    select
      entry.account_id,
      greatest(
        sum(case
          when posting.ledger_account = 'partner_commission_available'
            and posting.direction = 'credit'
            then posting.amount_minor
          when posting.ledger_account = 'partner_commission_available'
            and posting.direction = 'debit'
            then -posting.amount_minor
          else 0
        end)
        - greatest(sum(case
          when posting.ledger_account = 'partner_recovery_due'
            and posting.direction = 'debit'
            then posting.amount_minor
          when posting.ledger_account = 'partner_recovery_due'
            and posting.direction = 'credit'
            then -posting.amount_minor
          else 0
        end), 0),
        0
      )::bigint as available_minor
    from affiliate_private.affiliate_commission_postings posting
    join affiliate_private.affiliate_commission_entries entry
      on entry.id = posting.entry_id
    where posting.ledger_account in (
        'partner_commission_available',
        'partner_recovery_due'
      )
      and posting.currency = :'pilot_currency'
    group by entry.account_id
  ) balance
  join affiliate_private.affiliate_accounts account
    on account.id = balance.account_id
    and account.status = 'active'
  join affiliate_private.affiliate_program_versions program
    on program.id = account.program_version_id
  join affiliate_private.affiliate_fiscal_profiles fiscal
    on fiscal.account_id = account.id
    and fiscal.status = 'verified'
  join affiliate_private.affiliate_payout_profiles profile
    on profile.account_id = account.id
    and profile.status = 'active'
    and profile.currency = :'pilot_currency'
  join affiliate_private.affiliate_payout_provider_configs provider
    on provider.provider = profile.provider
    and provider.country_code = account.country_code
    and provider.currency = profile.currency
    and provider.status = 'active'
  where balance.available_minor >=
      (program.payout_thresholds ->> :'pilot_currency')::bigint
    and program.payout_thresholds ? :'pilot_currency'
),
canary_cycle_candidate_stats as (
  select
    count(*)::integer as item_count,
    count(*) filter (
      where candidate.account_id in (select id from canary_ready_accounts)
        and candidate.available_minor = :pilot_threshold_minor::bigint
        and affiliate_private.partners_payout_balance_authoritative(
          candidate.account_id,
          :'pilot_currency'
        )
        and exists (
          select 1
          from affiliate_private.affiliate_payout_profiles profile
          join affiliate_private.affiliate_revolut_beneficiary_bindings binding
            on binding.id = profile.revolut_binding_id
            and binding.binding_version = profile.revolut_binding_version
            and binding.account_id = profile.account_id
            and binding.currency = profile.currency
          where profile.id = candidate.payout_profile_id
            and profile.provider = 'revolut'
            and profile.status = 'active'
            and binding.status = 'active'
            and binding.beneficiary_token_ref =
              profile.beneficiary_token_ref
            and binding.beneficiary_payment_method_ref is not distinct from
              profile.beneficiary_payment_method_ref
            and binding.destination_masked = profile.display_masked
            and not exists (
              select 1
              from affiliate_private.affiliate_revolut_beneficiary_revocations
                revocation
              where revocation.binding_id = binding.id
            )
        )
    )::integer as exact_canary_item_count
  from canary_cycle_candidates candidate
),
canary_authorization_stats as (
  select
    count(binding.gate_key)::integer as binding_count,
    count(binding.gate_key) filter (
      where secret.row_count = 1
        and secret.valid_count = 1
        and package.program_version_id in (select id from matching_programs)
        and package.deployment_environment = :'deployment_environment'
        and package.source_commit_sha = lower(:'candidate_commit_sha')
        and package.document_hashes ->> 'financial_canary_authorization' =
          secret.authorization_sha256
        and jsonb_array_length(package.jurisdiction_scope) = 1
        and exists (
          select 1
          from jsonb_array_elements(package.jurisdiction_scope) scope(item)
          where scope.item ->> 'country_code' = :'pilot_country'
            and nullif(scope.item ->> 'subdivision_code', '') is null
        )
        and affiliate_private.partners_approval_package_is_current(
          package.id,
          expected.gate_key,
          :'deployment_environment'
        )
    )::integer as matching_count
  from required_canary_authorization_gates expected
  left join affiliate_private.affiliate_release_gate_approval_bindings binding
    on binding.gate_key = expected.gate_key
  left join affiliate_private.affiliate_approval_packages package
    on package.id = binding.approval_package_id
  cross join canary_authorization_secret secret
),
operator_stats as (
  select
    count(distinct user_row.id) filter (
      where capability.capability = 'finance'
        and capability.enabled
        and user_row.deleted_at is null
        and (
          user_row.banned_until is null
          or user_row.banned_until < clock_timestamp()
        )
        and user_row.email_confirmed_at is not null
        and user_row.raw_app_meta_data ->> 'role' = 'admin'
        and exists (
          select 1
          from auth.mfa_factors factor
          where factor.user_id = user_row.id
            and factor.factor_type = 'totp'
            and factor.status = 'verified'
        )
    )::integer as finance_totp_count,
    count(distinct user_row.id) filter (
      where user_row.deleted_at is null
        and (
          user_row.banned_until is null
          or user_row.banned_until < clock_timestamp()
        )
        and user_row.email_confirmed_at is not null
        and user_row.raw_app_meta_data ->> 'role' = 'admin'
        and coalesce(
          (user_row.raw_app_meta_data -> 'partners_release_manager') =
            'true'::jsonb,
          false
        )
        and exists (
          select 1
          from auth.mfa_factors factor
          where factor.user_id = user_row.id
            and factor.factor_type = 'totp'
            and factor.status = 'verified'
        )
    )::integer as release_manager_totp_count
  from auth.users user_row
  left join affiliate_private.affiliate_admin_capabilities capability
    on capability.user_id = user_row.id
),
checks(check_name, passed, detail) as (
  select
    'mode.explicit_supported',
    mode.mode_key in ('pilot', 'financial_canary'),
    format('mode=%s', mode.mode_key)
  from preactivation_mode mode

  union all

  select
    'mode.financial_canary_production_only',
    mode.mode_key <> 'financial_canary'
      or :'deployment_environment' = 'production',
    format(
      'mode=%s;environment=%s',
      mode.mode_key,
      :'deployment_environment'
    )
  from preactivation_mode mode

  union all

  select
    'flag.' || expected.flag_key,
    count(flag.key) = 1
      and bool_and(flag.enabled = expected.expected_enabled),
    format(
      'expected=%s;actual=%s;rows=%s',
      expected.expected_enabled,
      coalesce(bool_or(flag.enabled)::text, 'missing'),
      count(flag.key)
    )
  from expected_flags expected
  left join public.admin_feature_flags flag on flag.key = expected.flag_key
  group by expected.flag_key, expected.expected_enabled

  union all

  select
    'gate.' || expected.gate_key,
    count(gate.gate_key) = 1
      and bool_and(gate.satisfied = expected.expected_satisfied)
      and bool_and(
        case
          when expected.expected_satisfied then
            affiliate_private.partners_release_gate_approval_is_current(
              expected.gate_key,
              :'deployment_environment'
            )
          else not gate.satisfied
        end
      ),
    format(
      'expected=%s;recorded=%s;approval_current=%s;rows=%s',
      expected.expected_satisfied,
      coalesce(bool_or(gate.satisfied)::text, 'missing'),
      coalesce(
        bool_or(
          affiliate_private.partners_release_gate_approval_is_current(
            expected.gate_key,
            :'deployment_environment'
          )
        )::text,
        'false'
      ),
      count(gate.gate_key)
    )
  from required_gates expected
  left join affiliate_private.affiliate_release_gates gate
    on gate.gate_key = expected.gate_key
  group by expected.gate_key, expected.expected_satisfied

  union all

  select
    'gate.approval_registry_exact_pilot_scope',
    count(*) = (
      select count(*)
      from required_gates expected
      where expected.expected_satisfied
      )
      and bool_and(
        package.program_version_id in (select id from matching_programs)
        and package.deployment_environment = :'deployment_environment'
        and package.source_commit_sha = lower(:'candidate_commit_sha')
        and package.deployment_evidence_sha256 ~ '^[0-9a-f]{64}$'
        and package.document_hashes ? 'approval_record'
        and package.document_hashes ? 'deployment_proof'
        and jsonb_array_length(package.jurisdiction_scope) = 1
        and exists (
          select 1
          from jsonb_array_elements(package.jurisdiction_scope) scope(item)
          where scope.item ->> 'country_code' = :'pilot_country'
            and nullif(scope.item ->> 'subdivision_code', '') is null
        )
        and affiliate_private.partners_approval_package_is_current(
          package.id,
          gate.gate_key,
          :'deployment_environment'
        )
      ),
    format(
      'current_exact_packages=%s;required=%s;environment=%s;country=%s',
      count(*),
      (
        select count(*)
        from required_gates expected
        where expected.expected_satisfied
      ),
      :'deployment_environment',
      :'pilot_country'
    )
  from required_gates expected
  join affiliate_private.affiliate_release_gates gate
    on gate.gate_key = expected.gate_key
  join affiliate_private.affiliate_release_gate_approval_bindings binding
    on binding.gate_key = gate.gate_key
  join affiliate_private.affiliate_approval_packages package
    on package.id = binding.approval_package_id
  where expected.expected_satisfied

  union all

  select
    'program.individual_20pct_30d_j45_usd10_exact_payout',
    (select count(*) from matching_programs) = 1
      and (
        select count(*)
        from affiliate_private.affiliate_program_versions
        where status = 'active'
      ) = 1,
    format(
      'matching=%s;all_active=%s',
      (select count(*) from matching_programs),
      (
        select count(*)
        from affiliate_private.affiliate_program_versions
        where status = 'active'
      )
    )

  union all

  select
    'policy.pilot_country_individual_didit',
    (select count(*) from pilot_policies) = 1,
    format(
      'country=%s;currency=%s;matching=%s',
      :'pilot_country',
      :'pilot_currency',
      (select count(*) from pilot_policies)
    )

  union all

  select
    'policy.pilot_country_iso_mapping',
    count(*) = 1,
    format('matching=%s', count(*))
  from affiliate_private.affiliate_country_code_mappings mapping
  where mapping.iso3 = :'pilot_country_iso3'
    and mapping.country_code = :'pilot_country'
    and mapping.status = 'active'

  union all

  select
    'policy.pilot_country_kyc_attempts',
    count(*) = 1,
    format('matching=%s', count(*))
  from affiliate_private.affiliate_kyc_attempt_policies policy
  join pilot_policies pilot on pilot.id = policy.country_policy_id
  where policy.status = 'active'

  union all

  select
    'currency.' || expected.currency_code,
    count(metadata.currency_code) = 1
      and bool_and(metadata.status = 'active')
      and bool_and(metadata.exponent = expected.exponent),
    format(
      'expected_exponent=%s;actual_status=%s;actual_exponent=%s;rows=%s',
      expected.exponent,
      coalesce(min(metadata.status), 'missing'),
      coalesce(min(metadata.exponent)::text, 'missing'),
      count(metadata.currency_code)
    )
  from expected_currencies expected
  left join affiliate_private.affiliate_currency_metadata metadata
    on metadata.currency_code = expected.currency_code
  group by expected.currency_code, expected.exponent

  union all

  select
    'payout.pilot_route_revolut_manual',
    count(*) = 1,
    format('matching=%s', count(*))
  from affiliate_private.affiliate_payout_provider_configs route
  where route.provider = 'revolut'
    and route.execution_adapter = 'revolut_manual'
    and route.country_code = :'pilot_country'
    and route.currency = :'pilot_currency'
    and route.status = 'active'

  union all

  select
    'payout.no_other_active_route',
    count(*) = 0,
    format('unexpected_active=%s', count(*))
  from affiliate_private.affiliate_payout_provider_configs route
  where route.status = 'active'
    and not (
      route.provider = 'revolut'
      and route.execution_adapter = 'revolut_manual'
      and route.country_code = :'pilot_country'
      and route.currency = :'pilot_currency'
    )

  union all

  select
    'pilot.allowlist_20_to_50_confirmed_country',
    mode.mode_key <> 'pilot'
      or (
        stats.active_count between 20 and 50
        and stats.active_count = stats.pilot_country_count
        and stats.active_count = stats.confirmed_pilot_country_count
      ),
    format(
      'mode=%s;country=%s;active=%s;country_scoped=%s;confirmed=%s',
      mode.mode_key,
      :'pilot_country',
      stats.active_count,
      stats.pilot_country_count,
      stats.confirmed_pilot_country_count
    )
  from allowlist_stats stats
  cross join preactivation_mode mode

  union all

  select
    'financial_canary.single_confirmed_country_account',
    mode.mode_key <> 'financial_canary'
      or (
        stats.active_count = 1
        and stats.pilot_country_count = 1
        and stats.confirmed_pilot_country_count = 1
      ),
    format(
      'mode=%s;active=%s;country_scoped=%s;confirmed=%s',
      mode.mode_key,
      stats.active_count,
      stats.pilot_country_count,
      stats.confirmed_pilot_country_count
    )
  from allowlist_stats stats
  cross join preactivation_mode mode

  union all

  select
    'financial_canary.fixed_vault_binding',
    mode.mode_key <> 'financial_canary'
      or (
        subject.row_count = 1
        and subject.valid_count = 1
        and authorization_binding.row_count = 1
        and authorization_binding.valid_count = 1
        and transaction_binding.row_count = 1
        and transaction_binding.valid_count = 1
      ),
    format(
      'mode=%s;subject=%s/%s;authorization=%s/%s;transaction=%s/%s',
      mode.mode_key,
      subject.valid_count,
      subject.row_count,
      authorization_binding.valid_count,
      authorization_binding.row_count,
      transaction_binding.valid_count,
      transaction_binding.row_count
    )
  from canary_subject_secret subject
  cross join canary_authorization_secret authorization_binding
  cross join canary_transaction_secret transaction_binding
  cross join preactivation_mode mode

  union all

  select
    'financial_canary.exact_account_ready',
    mode.mode_key <> 'financial_canary'
      or (
        (select count(*) from canary_bound_accounts) = 1
        and (select count(*) from canary_ready_accounts) = 1
      ),
    format(
      'mode=%s;bound_accounts=%s;ready_accounts=%s',
      mode.mode_key,
      (select count(*) from canary_bound_accounts),
      (select count(*) from canary_ready_accounts)
    )
  from preactivation_mode mode

  union all

  select
    'financial_canary.matured_threshold_balance',
    mode.mode_key <> 'financial_canary'
      or (
        stats.balance_row_count = 1
        and stats.eligible_balance_count = 1
      ),
    format(
      'mode=%s;balance_rows=%s;eligible_rows=%s',
      mode.mode_key,
      stats.balance_row_count,
      stats.eligible_balance_count
    )
  from canary_balance_stats stats
  cross join preactivation_mode mode

  union all

  select
    'financial_canary.exact_transaction_lineage',
    mode.mode_key <> 'financial_canary'
      or stats.exact_lineage_count = 1,
    format(
      'mode=%s;exact_production_fact_accrual_j45_release=%s',
      mode.mode_key,
      stats.exact_lineage_count
    )
  from canary_lineage_stats stats
  cross join preactivation_mode mode

  union all

  select
    'financial_canary.exact_cycle_selection',
    mode.mode_key <> 'financial_canary'
      or (
        stats.item_count = 1
        and stats.exact_canary_item_count = 1
      ),
    format(
      'mode=%s;cycle_items=%s;exact_canary_items=%s;amount_minor=%s',
      mode.mode_key,
      stats.item_count,
      stats.exact_canary_item_count,
      :pilot_threshold_minor::bigint
    )
  from canary_cycle_candidate_stats stats
  cross join preactivation_mode mode

  union all

  select
    'financial_canary.authorization_packages',
    mode.mode_key <> 'financial_canary'
      or (
        secret.row_count = 1
        and secret.valid_count = 1
        and stats.binding_count = 4
        and stats.matching_count = 4
      ),
    format(
      'mode=%s;secret_entries=%s;valid_secret_entries=%s;bindings=%s;matching=%s',
      mode.mode_key,
      secret.row_count,
      secret.valid_count,
      stats.binding_count,
      stats.matching_count
    )
  from canary_authorization_stats stats
  cross join canary_authorization_secret secret
  cross join preactivation_mode mode

  union all

  select
    'operators.finance_maker_checker_totp',
    stats.finance_totp_count >= 2,
    format('ready_operators=%s;required=2', stats.finance_totp_count)
  from operator_stats stats

  union all

  select
    'operators.release_manager_totp',
    stats.release_manager_totp_count >= 1,
    format('ready_operators=%s;required=1', stats.release_manager_totp_count)
  from operator_stats stats

  union all

  select
    'didit.pending_member_purge_coverage',
    count(*) = 0,
    format('pending_without_outbox=%s', count(*))
  from affiliate_private.affiliate_kyc_sessions session
  where session.status = 'pending'
    and session.provider_session_hash is not null
    and not exists (
      select 1
      from affiliate_private.affiliate_didit_purge_outbox outbox
      where outbox.provider_session_hash = session.provider_session_hash
        and outbox.session_purpose = 'member_kyc'
        and outbox.source_record_id = session.id
        and outbox.provider_environment = session.provider_environment
    )

  union all

  select
    'didit.purge_coverage_ready',
    affiliate_private.partners_didit_purge_coverage_ready(),
    format(
      'coverage_ready=%s',
      affiliate_private.partners_didit_purge_coverage_ready()
    )

  union all

  select
    'didit.purge_outbox_clear',
    count(*) = 0,
    format('unresolved=%s', count(*))
  from affiliate_private.affiliate_didit_purge_outbox outbox
  where outbox.status in ('pending', 'leased', 'retry', 'dead_letter')

  union all

  select
    'didit.purge_sources_clear',
    count(*) = 0,
    format('unresolved_terminal_sources=%s', count(*))
  from (
    select session.id
    from affiliate_private.affiliate_kyc_sessions session
    where session.status <> 'pending'
      and session.provider_purge_status <> 'purged'
    union all
    select session.id
    from affiliate_private.affiliate_didit_certification_sessions session
    where session.provider_session_hash is not null
      and session.status in ('approved', 'declined', 'expired', 'quarantined')
      and session.provider_purge_status <> 'purged'
  ) unresolved

  union all

  select
    'didit.orphaned_source_dead_letter',
    coalesce(
      (status.snapshot ->> 'orphaned_source_dead_letter')::bigint,
      -1
    ) = 0,
    format(
      'orphaned_source_dead_letter=%s',
      coalesce(
        status.snapshot ->> 'orphaned_source_dead_letter',
        'missing'
      )
    )
  from (
    select affiliate_private.partners_service_didit_purge_status() snapshot
  ) status

  union all

  select
    'didit.purge_worker_heartbeat',
    state.last_outcome in ('ok', 'partial')
      and state.last_completed_at >= clock_timestamp() - interval '5 minutes',
    format(
      'outcome=%s;last_completed_at=%s',
      coalesce(state.last_outcome, 'missing'),
      coalesce(state.last_completed_at::text, 'missing')
    )
  from affiliate_private.affiliate_didit_purge_worker_state state
  where state.worker_name = 'didit_purge'

  union all

  select
    'cron.partners_didit_purge_worker',
    count(*) = 1
      and bool_and(job.schedule = '* * * * *')
      and bool_and(job.active),
    format('matching=%s', count(*))
  from cron.job job
  where job.jobname = 'norva-partners-didit-purge-worker'

  union all

  select
    'cron.partners_worker',
    count(*) = 1
      and bool_and(job.schedule = '*/5 * * * *')
      and bool_and(job.active),
    format('matching=%s', count(*))
  from cron.job job
  where job.jobname = 'norva-partners-worker'

  union all

  select
    'cron.revenuecat_transfer_worker',
    count(*) = 1
      and bool_and(job.schedule = '*/2 * * * *')
      and bool_and(job.active),
    format('matching=%s', count(*))
  from cron.job job
  where job.jobname = 'norva-revenuecat-transfer-worker'

  union all

  select
    'cron.no_live_payout_or_revolut_api',
    count(*) = 0,
    format('unexpected_active=%s', count(*))
  from cron.job job
  where job.active
    and job.jobname in ('norva-partners-payout', 'norva-partners-revolut-api')

  union all

  select
    'vault.partners_cron_shared_secret',
    count(*) = 1,
    format('valid_entries=%s', count(*))
  from vault.decrypted_secrets secret
  where secret.name = 'norva_cron_shared_secret'
    and length(secret.decrypted_secret) >= 32

  union all

  select
    'worker.' || expected.worker_name,
    count(heartbeat.worker_name) = 1
      and bool_and(heartbeat.status = 'healthy')
      and bool_and(
        heartbeat.last_seen_at >= clock_timestamp() - interval '15 minutes'
      ),
    format(
      'status=%s;fresh=%s;rows=%s',
      coalesce(min(heartbeat.status), 'missing'),
      coalesce(
        bool_or(
          heartbeat.last_seen_at >= clock_timestamp() - interval '15 minutes'
        )::text,
        'false'
      ),
      count(heartbeat.worker_name)
    )
  from expected_workers expected
  left join affiliate_private.affiliate_worker_heartbeats heartbeat
    on heartbeat.worker_name = expected.worker_name
  group by expected.worker_name
)
select
  check_name,
  case when passed then 'PASS' else 'FAIL' end as status,
  detail
from checks
order by check_name;

commit;
