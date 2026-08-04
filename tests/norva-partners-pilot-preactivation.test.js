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

test('the pilot database preflight is read-only and models the safe preactivation state', () => {
  assert.match(sql, /begin transaction read only;/i);
  assert.match(sql, /commit;/i);
  assert.doesNotMatch(
    sql,
    /\b(?:insert|update|delete|alter|create|drop|truncate)\b/i,
  );
  assert.doesNotMatch(sql, /cron\.schedule\s*\(/i);

  for (const contract of [
    ["'partners_enabled'::text, false", 'master flag remains closed'],
    ["'partners_invite_only', true", 'pilot remains invite-only'],
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
  assert.match(runbook, /Préflight pilote : corridor explicite, sans activation/);
  assert.match(runbook, /check-norva-partners-pilot-preactivation\.sh/);
  assert.match(runbook, /référence commerciale immuable[\s\S]*`USD=1000`/);
  assert.match(runbook, /aucune conversion USD implicite/);
  assert.match(runbook, /20 à 50 comptes/);
  assert.match(runbook, /App Link signé par Google Play/);
  assert.match(runbook, /ne crée aucune preuve fournisseur/);
  assert.match(runbook, /partners_enabled=false/);
  assert.match(runbook, /partners_payouts_live=false/);
});
