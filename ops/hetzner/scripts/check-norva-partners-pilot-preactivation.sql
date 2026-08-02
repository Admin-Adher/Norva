-- Read-only database preflight for one explicitly selected pilot corridor.
--
-- This file intentionally checks the state immediately before the final
-- Partners/TV flag promotion. It never enables a flag, satisfies a gate,
-- creates an allowlist entry or schedules a cron. Provider and human evidence
-- remains governed by docs/NORVA-PARTNERS-RELEASE-EVIDENCE.md.

begin transaction read only;

with
expected_flags(flag_key, expected_enabled) as (
  values
    ('partners_enabled'::text, false),
    ('partners_invite_only', true),
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
        and user_row.email_confirmed_at is not null
    )::integer as confirmed_pilot_country_count
  from affiliate_private.affiliate_pilot_allowlist entry
  join auth.users user_row on user_row.id = entry.user_id
),
operator_stats as (
  select
    count(distinct user_row.id) filter (
      where capability.capability = 'finance'
        and capability.enabled
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
      where user_row.raw_app_meta_data ->> 'role' = 'admin'
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
      and bool_and(gate.satisfied = expected.expected_satisfied),
    format(
      'expected=%s;actual=%s;rows=%s',
      expected.expected_satisfied,
      coalesce(bool_or(gate.satisfied)::text, 'missing'),
      count(gate.gate_key)
    )
  from required_gates expected
  left join affiliate_private.affiliate_release_gates gate
    on gate.gate_key = expected.gate_key
  group by expected.gate_key, expected.expected_satisfied

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
    stats.active_count between 20 and 50
      and stats.active_count = stats.pilot_country_count
      and stats.active_count = stats.confirmed_pilot_country_count,
    format(
      'country=%s;active=%s;country_scoped=%s;confirmed=%s',
      :'pilot_country',
      stats.active_count,
      stats.pilot_country_count,
      stats.confirmed_pilot_country_count
    )
  from allowlist_stats stats

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
