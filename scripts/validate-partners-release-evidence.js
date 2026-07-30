'use strict';

const fs = require('node:fs');
const path = require('node:path');

const READY_PROVIDER_STATUS = 'configured_and_verified';
const PAYOUT_CYCLE_COMPLETE = 'supervised_and_reconciled';
const SHA256 = /^[a-f0-9]{64}$/;
const VERSION_KEY = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const COUNTRY_CODE = /^[A-Z]{2}$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;
const FORBIDDEN_KEY = /(?:^|_)(?:email|full_name|user_id|account_id|document|token|secret|provider_payload|referral_code)(?:_|$)/i;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertNoPersonalData(value, trail = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoPersonalData(item, `${trail}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      assert(!FORBIDDEN_KEY.test(key), `forbidden evidence key at ${trail}.${key}`);
      assertNoPersonalData(child, `${trail}.${key}`);
    }
    return;
  }
  if (typeof value === 'string') {
    assert(!EMAIL.test(value), `email-like value found at ${trail}`);
    assert(!UUID.test(value), `UUID-like value found at ${trail}`);
  }
}

function validateEvidence(evidence) {
  assert(evidence && typeof evidence === 'object', 'evidence must be an object');
  assert(evidence.schema_version === 1, 'schema_version must equal 1');
  assert(
    ['draft', 'pilot_ready', 'generalization_ready'].includes(evidence.status),
    'status must be draft, pilot_ready or generalization_ready',
  );
  assert(
    typeof evidence.release_key === 'string'
      && VERSION_KEY.test(evidence.release_key),
    'release_key must be a version key, never a user identifier',
  );
  assert(
    evidence.contains_personal_data === false,
    'release evidence must declare contains_personal_data=false',
  );
  assertNoPersonalData(evidence);

  assert(evidence.program?.commission_rate_bps === 2000,
    'commission_rate_bps must equal 2000');
  assert(evidence.program?.attribution_window_days === 30,
    'attribution_window_days must equal 30');
  assert(evidence.program?.maturation_days === 45,
    'maturation_days must equal 45');

  assert(Array.isArray(evidence.jurisdictions),
    'jurisdictions must be an array');
  for (const jurisdiction of evidence.jurisdictions) {
    assert(COUNTRY_CODE.test(jurisdiction.country_code || ''),
      'jurisdiction country_code must be ISO alpha-2');
    assert(
      jurisdiction.subdivision_code === null
        || typeof jurisdiction.subdivision_code === 'string',
      'subdivision_code must be null or a string',
    );
    assert(VERSION_KEY.test(jurisdiction.policy_key || ''),
      'jurisdiction policy_key must be versioned');
    assert(
      Array.isArray(jurisdiction.payout_currencies)
        && jurisdiction.payout_currencies.length > 0
        && jurisdiction.payout_currencies.every((code) =>
          CURRENCY_CODE.test(code)),
      'each jurisdiction needs at least one ISO payout currency',
    );
    for (const gate of [
      'legal_contract_and_disclosure',
      'didit_identity_age_country_capacity',
      'individual_tax',
      'individual_payout',
      'exact_financial_data',
    ]) {
      assert(typeof jurisdiction.gates?.[gate] === 'boolean',
        `jurisdiction gate ${gate} must be boolean`);
    }
  }

  assert(evidence.allowlist?.target_min === 20,
    'allowlist target_min must equal 20');
  assert(evidence.allowlist?.target_max === 50,
    'allowlist target_max must equal 50');
  assert(Number.isSafeInteger(evidence.allowlist?.configured_count)
    && evidence.allowlist.configured_count >= 0,
  'allowlist configured_count must be a non-negative integer');
  assert(evidence.allowlist?.identities_stored_in_evidence === false,
    'allowlist identities must not be stored in release evidence');

  const cycles = evidence.payout_cycles;
  assert(Array.isArray(cycles) && cycles.length === 2,
    'exactly two supervised payout cycles must be tracked');
  assert(cycles[0]?.sequence === 1 && cycles[1]?.sequence === 2,
    'payout cycle sequence must be 1 then 2');
  for (const cycle of cycles) {
    assert(
      ['not_started', 'dry_run', 'submitted', PAYOUT_CYCLE_COMPLETE]
        .includes(cycle.status),
      `invalid payout cycle ${cycle.sequence} status`,
    );
  }
  return evidence;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length >= 3;
}

function isIsoTimestamp(value) {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

function pilotReadinessBlockers(evidence) {
  const blockers = [];
  const require = (condition, code) => {
    if (!condition) blockers.push(code);
  };

  require(VERSION_KEY.test(evidence.program.version_key || ''),
    'program_version_not_configured');
  require(VERSION_KEY.test(evidence.legal.terms_version || '')
    && SHA256.test(evidence.legal.terms_sha256 || ''),
  'partner_terms_not_versioned_or_hashed');
  require(VERSION_KEY.test(evidence.legal.disclosure_version || '')
    && SHA256.test(evidence.legal.disclosure_sha256 || ''),
  'partner_disclosure_not_versioned_or_hashed');
  require(nonEmpty(evidence.legal.privacy_review_evidence),
    'privacy_review_evidence_missing');
  const publicSurfaces = evidence.legal.public_surfaces;
  require(
    isIsoTimestamp(publicSurfaces?.verified_at)
      && nonEmpty(publicSurfaces?.deployment_ref)
      && nonEmpty(publicSurfaces?.terms_evidence)
      && nonEmpty(publicSurfaces?.privacy_evidence)
      && nonEmpty(publicSurfaces?.partners_terms_evidence),
    'legal_public_surfaces_not_verified',
  );
  require(evidence.jurisdictions.length > 0,
    'no_jurisdiction_configured');
  for (const jurisdiction of evidence.jurisdictions) {
    require(Object.values(jurisdiction.gates).every(Boolean),
      `jurisdiction_${jurisdiction.country_code}_gates_incomplete`);
  }
  require(evidence.allowlist.configured_count >= evidence.allowlist.target_min
    && evidence.allowlist.configured_count <= evidence.allowlist.target_max,
  'pilot_allowlist_outside_20_50');

  for (const provider of [
    'didit',
    'individual_payout',
    'web_tax',
    'google_play_orders',
    'revenuecat',
    'revolut',
  ]) {
    require(evidence.providers[provider]?.status === READY_PROVIDER_STATUS
      && nonEmpty(evidence.providers[provider]?.sandbox_evidence),
    `provider_${provider}_not_verified`);
  }

  require(evidence.feature_flags.partners_enabled === true,
    'partners_enabled_not_enabled');
  require(evidence.feature_flags.partners_invite_only === true,
    'partners_invite_only_not_enabled');
  require(evidence.feature_flags.partners_shadow_mode === true,
    'partners_shadow_mode_not_enabled');
  require(evidence.feature_flags.partners_payouts_live === false,
    'partners_payouts_live_must_remain_false');

  require(nonEmpty(evidence.quality.partners_ci_run_evidence),
    'partners_ci_evidence_missing');
  require(evidence.quality.security_advisors_passed === true,
    'security_advisors_not_passed');
  require(evidence.quality.performance_advisors_passed === true,
    'performance_advisors_not_passed');
  require(nonEmpty(evidence.quality.offsite_backup_evidence)
    && evidence.quality.offsite_backup_encrypted === true,
  'encrypted_offsite_backup_not_proven');
  require(nonEmpty(evidence.quality.restore_drill_evidence)
    && evidence.quality.restore_verifier_passed === true,
  'restore_drill_not_proven');
  require(nonEmpty(evidence.runtime.worker_cron_evidence),
    'worker_cron_not_proven');
  require(nonEmpty(evidence.runtime.shadow_reconciliation_evidence)
    && evidence.runtime.shadow_reconciliation_clean === true,
  'shadow_reconciliation_not_clean');
  require(nonEmpty(evidence.runtime.alert_and_recovery_evidence),
    'alert_recovery_cycle_not_proven');

  for (const approver of ['legal', 'risk', 'finance', 'operations']) {
    require(evidence.approvals[approver] === true,
      `${approver}_approval_missing`);
  }
  return [...new Set(blockers)].sort();
}

function generalizationReadinessBlockers(evidence) {
  const blockers = pilotReadinessBlockers(evidence);
  for (const cycle of evidence.payout_cycles) {
    if (cycle.status !== PAYOUT_CYCLE_COMPLETE
      || !nonEmpty(cycle.reconciliation_evidence)) {
      blockers.push(`payout_cycle_${cycle.sequence}_not_reconciled`);
    }
  }
  return [...new Set(blockers)].sort();
}

function evaluateEvidence(evidence) {
  validateEvidence(evidence);
  const pilotBlockers = pilotReadinessBlockers(evidence);
  const generalizationBlockers = generalizationReadinessBlockers(evidence);
  if (evidence.status === 'pilot_ready' && pilotBlockers.length) {
    throw new Error(
      `status pilot_ready contradicts blockers: ${pilotBlockers.join(', ')}`,
    );
  }
  if (evidence.status === 'generalization_ready'
    && generalizationBlockers.length) {
    throw new Error(
      'status generalization_ready contradicts blockers: '
        + generalizationBlockers.join(', '),
    );
  }
  return { pilotBlockers, generalizationBlockers };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const fileArg = args.find((arg) => !arg.startsWith('--'));
  if (!fileArg) {
    console.error(
      'Usage: node scripts/validate-partners-release-evidence.js '
        + '<evidence.json> [--require-pilot-ready|--require-generalization-ready]',
    );
    process.exit(2);
  }
  try {
    const file = path.resolve(process.cwd(), fileArg);
    const evidence = JSON.parse(fs.readFileSync(file, 'utf8'));
    const result = evaluateEvidence(evidence);
    const requirePilot = args.includes('--require-pilot-ready');
    const requireGeneralization =
      args.includes('--require-generalization-ready');
    const requiredBlockers = requireGeneralization
      ? result.generalizationBlockers
      : result.pilotBlockers;
    if ((requirePilot || requireGeneralization) && requiredBlockers.length) {
      console.error(JSON.stringify({
        status: 'blocked',
        blockers: requiredBlockers,
      }, null, 2));
      process.exit(1);
    }
    console.log(JSON.stringify({
      status: evidence.status,
      pilot_ready: result.pilotBlockers.length === 0,
      generalization_ready: result.generalizationBlockers.length === 0,
      pilot_blockers: result.pilotBlockers,
      generalization_blockers: result.generalizationBlockers,
    }, null, 2));
  } catch (error) {
    console.error(`Invalid Partners release evidence: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  evaluateEvidence,
  generalizationReadinessBlockers,
  pilotReadinessBlockers,
  validateEvidence,
};
