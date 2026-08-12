'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');

const read = (path) => readFileSync(path, 'utf8');

const shell = read(
  'ops/hetzner/scripts/check-norva-partners-pilot-preactivation.sh',
);
const sql = read(
  'ops/hetzner/scripts/check-norva-partners-pilot-preactivation.sql',
);
const runbook = read('docs/NORVA-PARTNERS-RUNBOOK.md');
const workflow = read('.github/workflows/partners-integration.yml');
const releaseControls = read(
  'supabase/migrations/20260804174000_partners_frictionless_release_controls.sql',
);

test('the pilot database preflight is read-only and models the safe preactivation state', () => {
  assert.match(sql, /begin transaction read only;/i);
  assert.match(sql, /commit;/i);
  assert.doesNotMatch(
    sql,
    /\b(?:insert|update|delete|alter|create|drop|truncate)\b/i,
  );
  assert.doesNotMatch(sql, /cron\.schedule\s*\(/i);

  for (const contract of [
    ["'partners_enabled'::text, true", 'public membership is already live'],
    ["'partners_invite_only', false", 'membership remains public'],
    ["'partners_cash_pilot_allowlist_only', true", 'cash remains allowlisted'],
    ["'partners_earnings_enabled', true", 'earnings are active in shadow'],
    ["'partners_credit_redemptions_enabled', true", 'credits are pilot-ready'],
    ["'partners_shadow_mode', true", 'financial processing stays shadowed'],
    ["'partners_payouts_live', false", 'live payouts stay closed'],
    ["'partners_tv_relay_enabled', false", 'TV is promoted only after evidence'],
    ["'partners_revolut_api_enabled', false", 'Business API stays disabled'],
  ]) {
    assert.ok(sql.includes(contract[0]), contract[1]);
  }
  assert.match(sql, /'general_release_approved', false/);
  assert.match(sql, /'revolut_api_adapter_verified', false/);
  assert.match(sql, /'manual_payout_workflow_verified', true/);
});

test('the cash preflight state follows the only reachable audited activation order', () => {
  assert.match(
    releaseControls,
    /where flag\.key = 'partners_enabled'[\s\S]*and flag\.enabled[\s\S]*Partners must be enabled before economic features/,
  );
  assert.match(
    releaseControls,
    /elsif not p_enabled and v_key = 'partners_enabled'[\s\S]*'partners_earnings_enabled'[\s\S]*'partners_credit_redemptions_enabled'[\s\S]*disable dependent Partners flags first/,
  );
  assert.match(
    runbook,
    /activer d'abord[\s\S]{0,120}`partners_enabled=true`[\s\S]{0,120}`partners_earnings_enabled=true`[\s\S]{0,120}`partners_credit_redemptions_enabled=true`/,
  );
});

test('the selected pilot corridor has exact programme, jurisdiction and payout invariants', () => {
  assert.match(sql, /commission_rate_bps = 2000/);
  assert.match(sql, /attribution_window_days = 30/);
  assert.match(sql, /maturation_days = 45/);
  assert.match(sql, /threshold_reference_currency = 'USD'/);
  assert.match(sql, /threshold_reference_minor = 1000/);
  assert.match(sql, /payout_fee_policy = 'platform_absorbed'/);
  assert.match(sql, /payout_thresholds -> 'USD'/);
  assert.match(sql, /payout_thresholds -> :'pilot_currency'/);
  assert.match(sql, /:pilot_threshold_minor::numeric/);
  assert.match(sql, /mapping\.iso3 = :'pilot_country_iso3'/);
  assert.match(sql, /mapping\.country_code = :'pilot_country'/);
  assert.match(sql, /policy\.verification_provider = 'didit'/);
  assert.match(
    sql,
    /policy\.payout_currencies = array\[:'pilot_currency'\]::text\[\]/,
  );
  assert.match(sql, /route\.execution_adapter = 'revolut_manual'/);
  assert.match(sql, /route\.country_code = :'pilot_country'/);
  assert.match(sql, /route\.currency = :'pilot_currency'/);
  assert.match(sql, /active_count between 20 and 50/);
  assert.match(sql, /finance_totp_count >= 2/);
  assert.match(sql, /release_manager_totp_count >= 1/);
  assert.doesNotMatch(sql, /\b(?:France|FRA|FR|EUR)\b/);
});

test('operator readiness excludes deleted, banned and unconfirmed admins', () => {
  const start = sql.indexOf('operator_stats as (');
  const end = sql.indexOf('checks(check_name, passed, detail) as (', start);
  assert.notEqual(start, -1, 'operator_stats CTE must remain present');
  assert.notEqual(end, -1, 'checks CTE must follow operator_stats');
  const operatorStats = sql.slice(start, end);
  assert.equal(
    (operatorStats.match(/user_row\.deleted_at is null/g) || []).length,
    2,
  );
  assert.equal(
    (operatorStats.match(/user_row\.banned_until < clock_timestamp\(\)/g) || [])
      .length,
    2,
  );
  assert.equal(
    (operatorStats.match(/user_row\.email_confirmed_at is not null/g) || [])
      .length,
    2,
  );
});

test('pilot and canary allowlists fail closed for non-live users', () => {
  const allowlistStart = sql.indexOf('allowlist_stats as (');
  const allowlistEnd = sql.indexOf('canary_subject_secret as (', allowlistStart);
  const boundStart = sql.indexOf('canary_bound_accounts as (');
  const boundEnd = sql.indexOf('canary_ready_accounts as (', boundStart);
  assert.notEqual(allowlistStart, -1);
  assert.notEqual(allowlistEnd, -1);
  assert.notEqual(boundStart, -1);
  assert.notEqual(boundEnd, -1);

  for (const section of [
    sql.slice(allowlistStart, allowlistEnd),
    sql.slice(boundStart, boundEnd),
  ]) {
    assert.match(section, /user_row\.deleted_at is null/);
    assert.match(section, /user_row\.banned_until is null/);
    assert.match(section, /user_row\.banned_until < clock_timestamp\(\)/);
    assert.match(section, /user_row\.email_confirmed_at is not null/);
  }
});

test('financial canary is explicit, production-only and never weakens the 20-50 pilot', () => {
  assert.match(
    shell,
    /NORVA_PARTNERS_PREACTIVATION_MODE:-pilot/,
  );
  assert.match(shell, /pilot_or_financial_canary_required/);
  assert.match(shell, /production_environment_required/);
  assert.match(shell, /-v preactivation_mode=/);
  assert.match(sql, /mode_key in \('pilot', 'financial_canary'\)/);
  assert.match(sql, /mode\.mode_key <> 'pilot'[\s\S]*active_count between 20 and 50/);
  assert.match(
    sql,
    /mode\.mode_key <> 'financial_canary'[\s\S]*stats\.active_count = 1[\s\S]*stats\.pilot_country_count = 1[\s\S]*stats\.confirmed_pilot_country_count = 1/,
  );
  assert.match(shell, /does not satisfy pilot_ready or the 20-50 pilot cohort/);
  assert.doesNotMatch(
    shell,
    /NORVA_PARTNERS_(?:FINANCIAL_CANARY|CANARY)_(?:USER|EMAIL|ACCOUNT|SUBJECT)/,
  );
});

test('financial canary identity, authorization and transaction stay in fixed Vault entries', () => {
  assert.match(
    sql,
    /norva_partners_financial_canary_subject_pseudonym_v1/,
  );
  assert.match(
    sql,
    /norva_partners_financial_canary_authorization_sha256_v1/,
  );
  assert.match(
    sql,
    /norva_partners_financial_canary_transaction_hash_v1/,
  );
  assert.match(sql, /account\.user_pseudonym = secret\.subject_pseudonym/);
  assert.match(sql, /fact\.transaction_hash = secret\.transaction_hash/);
  assert.match(sql, /package\.document_hashes ->> 'financial_canary_authorization'/);
  for (const gate of [
    'legal_and_tax_approved',
    'privacy_approved',
    'country_policy_approved',
    'manual_payout_workflow_verified',
  ]) {
    assert.ok(sql.includes(`('${gate}'`), `${gate} must authorize the canary`);
  }
  assert.match(sql, /stats\.binding_count = 4/);
  assert.match(sql, /stats\.matching_count = 4/);
  assert.doesNotMatch(sql, /format\([^)]*subject_pseudonym/is);
  assert.doesNotMatch(sql, /format\([^)]*authorization_sha256/is);
  assert.doesNotMatch(sql, /format\([^)]*transaction_hash/is);
});

test('financial canary requires an exact manual-payout-ready account and matured balance', () => {
  for (const contract of [
    /account\.verification_status = 'verified'/,
    /account\.verification_provider = 'didit'/,
    /session\.provider_session_hash = account\.verification_reference/,
    /session\.provider_environment = 'live'/,
    /session\.provider_config_fingerprint <> repeat\('0', 64\)/,
    /event\.processing_outcome = 'verified'/,
    /event\.provider_event_at = session\.verified_at/,
    /session\.provider_purge_status = 'purged'/,
    /newer_session\.provider_environment = 'live'/,
    /newer_session\.status <> 'superseded'/,
    /newer_session\.created_at > session\.created_at/,
    /account\.member_status = 'active'/,
    /account\.member_program_version_id = account\.program_version_id/,
    /program\.terms_version = account\.member_terms_version_accepted/,
    /program\.disclosure_version =\s*account\.member_disclosure_version_accepted/,
    /account\.age_verified/,
    /account\.capacity_verified/,
    /account\.contract_status = 'accepted'/,
    /fiscal\.status = 'verified'/,
    /fiscal\.declaration_version = 'partners-tax-self-certification-v1'/,
    /request\.execution_adapter = 'revolut_manual'/,
    /request\.status = 'completed'/,
    /profile\.provider = 'revolut'/,
    /profile\.status = 'active'/,
    /binding\.status = 'active'/,
    /binding\.destination_masked = profile\.display_masked/,
    /affiliate_revolut_beneficiary_revocations/,
    /partners_cash_readiness\(account\.id\)/,
    /partners_payout_balance_authoritative\(/,
    /partners_account_balances\(account\.id\)/,
    /balance\.available_minor = :pilot_threshold_minor::bigint/,
    /balance\.recovery_due_minor = 0/,
    /canary_cycle_candidates as/,
    /stats\.item_count = 1/,
    /stats\.exact_canary_item_count = 1/,
  ]) {
    assert.match(sql, contract);
  }
  assert.doesNotMatch(sql, /session\.expires_at/);
  assert.match(sql, /stats\.balance_row_count = 1/);
  assert.match(sql, /stats\.eligible_balance_count = 1/);
});

test('financial canary preflight binds the exact production fact through J+45 release', () => {
  for (const contract of [
    /canary_lineage_candidates as/,
    /fact\.transaction_hash = secret\.transaction_hash/,
    /fact\.environment = 'production'/,
    /fact\.facts_status = 'complete'/,
    /fact\.event_type in \('capture', 'renewal'\)/,
    /attribution\.referrer_account_id = account\.id/,
    /commission_job\.status = 'succeeded'/,
    /accrual\.matures_at = fact\.occurred_at \+ interval '45 days'/,
    /maturation_job\.available_at <= clock_timestamp\(\)/,
    /release\.related_entry_id = accrual\.id/,
    /partners_commission_minor\([\s\S]*\) = :pilot_threshold_minor::bigint/,
    /platform_commission_expense/,
    /partner_commission_pending/,
    /partner_commission_available/,
    /child_fact\.event_type in \('refund', 'chargeback'\)/,
    /reversal\.entry_kind in \('reversal', 'manual_reversal'\)/,
    /stats\.exact_lineage_count = 1/,
  ]) {
    assert.match(sql, contract);
  }
});

test('the operator must select every geographic and monetary pilot input explicitly', () => {
  for (const name of [
    'NORVA_PARTNERS_PILOT_COUNTRY',
    'NORVA_PARTNERS_PILOT_COUNTRY_ISO3',
    'NORVA_PARTNERS_PILOT_CURRENCY',
    'NORVA_PARTNERS_PILOT_CURRENCY_EXPONENT',
    'NORVA_PARTNERS_PILOT_THRESHOLD_MINOR',
    'NORVA_PARTNERS_PILOT_MINIMUM_AGE',
    'NORVA_PARTNERS_CANDIDATE_COMMIT_SHA',
    'NORVA_PARTNERS_DEPLOYMENT_ENVIRONMENT',
  ]) {
    assert.match(shell, new RegExp(`${name}:-}`), `${name} must have no default`);
    assert.ok(runbook.includes(name), `${name} must be documented`);
  }
  assert.match(shell, /No geography or payout currency is selected implicitly/);
  assert.match(shell, /usd_requires_exponent_2_and_threshold_1000/);
  for (const variable of [
    'pilot_country',
    'pilot_country_iso3',
    'pilot_currency',
    'pilot_currency_exponent',
    'pilot_threshold_minor',
    'pilot_minimum_age',
    'candidate_commit_sha',
    'deployment_environment',
    'preactivation_mode',
  ]) {
    assert.match(shell, new RegExp(`-v ${variable}=`));
    assert.match(sql, new RegExp(`:'?${variable}'?`));
  }
  assert.match(
    sql,
    /package\.deployment_environment = :'deployment_environment'/,
  );
  assert.match(
    sql,
    /jsonb_array_length\(package\.jurisdiction_scope\) = 1/,
  );
});

test('runtime validation inspects both healthy Edge replicas without printing secrets', () => {
  assert.match(shell, /set -euo pipefail/);
  assert.match(shell, /set \+x/);
  assert.match(shell, /norva-edge-functions norva-edge-functions-2/);
  assert.match(shell, /\.Config\.Env/);
  assert.match(shell, /true\|healthy/);
  assert.doesNotMatch(shell, /(?:^|\s)(?:source|\.)\s+[^\n]*\.env/m);
  assert.doesNotMatch(shell, /printenv|env\s*\|/);
  assert.match(shell, /Secret values are inspected in memory and are never printed/);

  for (const name of [
    'NORVA_REVENUECAT_WEBHOOK_AUTH',
    'NORVA_REVENUECAT_WEBHOOK_HMAC_SECRET',
    'NORVA_REVENUECAT_ALLOWED_APP_IDS',
    'NORVA_REVENUECAT_SECRET_API_KEY',
    'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON',
    'GOOGLE_PLAY_PACKAGE_NAME',
    'NORVA_REFERRAL_EDGE_HMAC_SECRET',
    'NORVA_REFERRAL_COOKIE_SECRET',
    'NORVA_PARTNERS_TV_RELAY_SECRET',
    'NORVA_PARTNERS_REVOLUT_BENEFICIARY_HMAC_KEYS_JSON',
    'NORVA_PARTNERS_REVOLUT_BENEFICIARY_HMAC_ACTIVE_VERSION',
    'DIDIT_API_KEY',
    'DIDIT_WORKFLOW_ID',
    'DIDIT_APPLICATION_ID',
    'DIDIT_WEBHOOK_SECRET',
  ]) {
    assert.ok(shell.includes(name), `${name} must be checked`);
  }

  assert.match(
    shell,
    /require_exact "\$container" NORVA_RC_ACCEPT_SANDBOX false/,
  );
  assert.match(
    shell,
    /require_exact "\$container" GOOGLE_PLAY_PACKAGE_NAME tv\.norva\.phone/,
  );
  assert.match(
    shell,
    /require_exact "\$container" NORVA_PARTNERS_REVOLUT_API_ENABLED false/,
  );
  assert.match(shell, /must_remain_empty_under_revolut_basic/);
});

test('the preflight executes the SQL through the local database container and is wired into CI', () => {
  assert.match(shell, /NORVA_PARTNERS_DB_CONTAINER:-norva-db/);
  assert.match(shell, /psql -X -v ON_ERROR_STOP=1/);
  assert.match(shell, /-qAt -F '\|'/);
  assert.match(shell, /< "\$SQL_FILE"/);
  assert.match(shell, /No flag, gate, route, cron or provider configuration was changed/);
  assert.match(
    workflow,
    /ops\/hetzner\/scripts\/check-norva-partners-pilot-preactivation\.sh/,
  );
});

test('the runbook separates local preflight from protected external evidence', () => {
  assert.match(
    runbook,
    /Préflight payout pilote : corridor explicite, sans activation/,
  );
  assert.match(runbook, /check-norva-partners-pilot-preactivation\.sh/);
  assert.match(runbook, /référence commerciale immuable[\s\S]*`USD=1000`/);
  assert.match(runbook, /aucune conversion USD implicite/);
  assert.match(runbook, /20 à 50 comptes/);
  assert.match(runbook, /App Link signé par Google Play/);
  assert.match(runbook, /ne crée aucune preuve fournisseur/);
  assert.match(runbook, /préflight cash s'exécute après la mise en service/);
  assert.match(runbook, /partners_payouts_live=false/);
  assert.match(runbook, /Canari financier supervisé : un compte, jamais `pilot_ready`/);
  assert.match(runbook, /NORVA_PARTNERS_PREACTIVATION_MODE='financial_canary'/);
  assert.match(runbook, /norva_partners_financial_canary_subject_pseudonym_v1/);
  assert.match(runbook, /norva_partners_financial_canary_transaction_hash_v1/);
  assert.match(runbook, /financial_canary_authorization/);
  assert.match(runbook, /admin_partners_financial_canary_cycle_create/);
  assert.match(runbook, /admin_partners_financial_canary_cycle_approve/);
});
