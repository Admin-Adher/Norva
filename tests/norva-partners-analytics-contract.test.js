'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const migration = fs.readFileSync(
  path.join(
    root,
    'supabase/migrations/20260729201447_partners_tv_admin_analytics.sql',
  ),
  'utf8',
);

const analyticsStart = migration.indexOf(
  'create or replace function affiliate_private.admin_partners_analytics(',
);
const analyticsEnd = migration.indexOf(
  'create or replace function affiliate_private.partners_ops_alert_snapshot()',
);
const analytics = migration.slice(analyticsStart, analyticsEnd);

const monitoringStart = analyticsEnd;
const monitoringEnd = migration.indexOf(
  'create or replace function affiliate_private.admin_partners_monitoring()',
);
const monitoring = migration.slice(monitoringStart, monitoringEnd);

test('analytics scans use bounded indexes aligned with their predicates', () => {
  for (const indexName of [
    'affiliate_link_claims_analytics_issued_idx',
    'affiliate_attributions_analytics_attributed_idx',
    'affiliate_kyc_sessions_analytics_verified_idx',
    'affiliate_kyc_sessions_analytics_terminal_idx',
    'affiliate_events_analytics_activation_idx',
    'affiliate_commission_entries_analytics_accrual_idx',
    'affiliate_financial_facts_analytics_complete_idx',
    'affiliate_financial_facts_analytics_first_paid_idx',
    'affiliate_financial_facts_analytics_quarantined_idx',
    'affiliate_financial_facts_transfer_quarantine_idx',
    'affiliate_payout_items_analytics_settled_idx',
    'affiliate_payout_cycles_analytics_settled_idx',
  ]) {
    assert.match(migration, new RegExp(`create index ${indexName}`));
  }
  assert.match(
    migration,
    /affiliate_financial_facts_analytics_complete_idx[\s\S]*?where environment = 'production'[\s\S]*?facts_status = 'complete'[\s\S]*?attribution_id is not null/,
  );
  assert.match(
    migration,
    /affiliate_financial_facts_transfer_quarantine_idx[\s\S]*?event_type = 'transfer'[\s\S]*?facts_status = 'quarantined'/,
  );
});

test('Partners analytics keeps the v1 daily envelope and uses a bounded UTC window', () => {
  assert.ok(analyticsStart >= 0);
  assert.ok(analyticsEnd > analyticsStart);
  assert.match(analytics, /'schema_version', 1/);
  assert.match(analytics, /'window_days', v_days/);
  assert.match(analytics, /'daily', v_daily/);
  assert.match(analytics, /v_days not between 1 and 365/);
  assert.match(analytics, /'timezone', 'UTC'/);
  assert.match(analytics, /'end_exclusive', v_window_end/);
});

test('analytics authorizes any Admin capability and redacts each foreign domain', () => {
  assert.match(
    analytics,
    /if not \(v_has_support or v_has_risk or v_has_finance\) then/,
  );
  assert.match(
    analytics,
    /v_funnel := jsonb_build_object\(\s*'status', 'unavailable',\s*'reason', 'support_capability_required'/,
  );
  assert.match(
    analytics,
    /v_risk := jsonb_build_object\(\s*'status', 'unavailable',\s*'reason', 'risk_capability_required'/,
  );
  assert.match(
    analytics,
    /v_financial := jsonb_build_object\(\s*'status', 'unavailable',\s*'reason', 'finance_capability_required'/,
  );
  assert.doesNotMatch(
    analytics,
    /'(?:email|user_id|account_id|referral_code|transaction_hash|verification_reference|provider_session_hash)'\s*,/,
  );
});

test('funnel is cohort-consistent and never presents unobserved clicks as zero', () => {
  assert.match(analytics, /'cohort_basis', 'claim_issued_at'/);
  assert.match(analytics, /join cohort_claims c on c\.id = a\.claim_id/);
  assert.match(
    analytics,
    /'clicks', jsonb_build_object\(\s*'status', 'unavailable',\s*'reason', 'referral_click_events_not_recorded'/,
  );
  assert.match(
    analytics,
    /first complete production capture or renewal for the referred user/,
  );
  assert.match(analytics, /'claim_to_attribution_percent'/);
  assert.match(analytics, /'attribution_to_first_payment_percent'/);
  assert.match(analytics, /'reason', 'no_claims_in_window'/);
  assert.match(analytics, /'reason', 'no_attributions_in_window'/);
});

test('risk analytics exposes only aggregate blocked and hold states', () => {
  for (const key of [
    'kyc_terminal_sessions_in_window',
    'blocked_activation_accounts_current',
    'account_holds_current',
    'account_suspensions_current',
    'attribution_holds_current',
    'attribution_blocks_current',
    'quarantined_financial_facts_in_window',
    'quarantined_transfer_facts_total',
  ]) {
    assert.match(analytics, new RegExp(`'${key}'`));
  }
  assert.match(
    analytics,
    /'reason', 'authoritative_transfer_entitlement_contract_not_implemented'/,
  );
});

test('financial analytics is exact-money, rail/currency scoped and honest about margin', () => {
  assert.match(analytics, /f\.environment = 'production'/);
  assert.match(analytics, /f\.facts_status = 'complete'/);
  assert.match(
    analytics,
    /f\.event_type in \(\s*'capture',\s*'renewal',\s*'refund',\s*'chargeback'/,
  );
  assert.match(
    analytics,
    /group by p\.rail, p\.currency, p\.currency_exponent/,
  );
  for (const key of [
    'refund_count',
    'chargeback_count',
    'net_eligible_revenue_minor',
    'commission_accrued_minor',
    'commission_reversed_minor',
    'commission_manual_reversed_minor',
    'net_partner_commission_minor',
    'contribution_after_partner_commission_minor',
  ]) {
    assert.match(analytics, new RegExp(`'${key}'`));
  }
  assert.match(analytics, /'reason', 'commission_processing_incomplete'/);
  assert.match(
    analytics,
    /'gross_margin', jsonb_build_object\(\s*'status', 'unavailable'/,
  );
  assert.match(
    analytics,
    /provider_fees_fx_infrastructure_and_other_costs_not_modeled/,
  );
});

test('payout timing is unavailable until the live adapter is proven', () => {
  assert.match(analytics, /flag\.key = 'partners_payouts_live'/);
  assert.match(analytics, /'payout_execution_adapter_verified'/);
  assert.match(analytics, /provider\.status = 'active'/);
  assert.match(analytics, /'cohort_basis', 'first_settled_payout_at'/);
  assert.match(
    analytics,
    /'median_days_activation_to_first_settled_payout'/,
  );
  assert.match(
    analytics,
    /'median_days_first_accrual_to_first_settled_payout'/,
  );
  assert.match(analytics, /'reason', 'payout_operations_not_ready'/);
});

test('retention remains explicitly unavailable without authoritative entitlement history', () => {
  assert.match(
    analytics,
    /'authoritative_entitlement_and_billing_interval_history_not_modeled'/,
  );
  assert.doesNotMatch(
    analytics,
    /'retention'[\s\S]{0,160}'(?:value|percent)',\s*0/,
  );
});

test('recent quarantined transfers raise a bounded stable monitoring alert', () => {
  assert.match(
    monitoring,
    /'financial_transfer_quarantined_recent'/,
  );
  assert.match(monitoring, /event_type = 'transfer'/);
  assert.match(monitoring, /facts_status = 'quarantined'/);
  assert.match(monitoring, /created_at >= now\(\) - interval '24 hours'/);
  assert.doesNotMatch(
    monitoring,
    /'financial_transfer_quarantined_recent'[\s\S]{0,240}referred_user_id/,
  );
});

test('public wrapper remains a stable authenticated RPC envelope', () => {
  assert.match(
    migration,
    /create or replace function public\.admin_partners_analytics\(p_days integer\)[\s\S]*?select affiliate_private\.admin_partners_analytics\(p_days\);/,
  );
  assert.match(
    migration,
    /'public\.admin_partners_analytics\(integer\)'[\s\S]*?execute 'grant execute on function ' \|\| v_signature[\s\S]*?\|\| ' to authenticated';/,
  );
});
