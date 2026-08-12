'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const EVIDENCE_TYPE = 'partners_financial_canary';
const REPOSITORY = 'Admin-Adher/Norva';
const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const MAX_MONEY_MINOR = 1_000_000_000_000;
const COMMISSION_RATE_BPS = 2_000;
const MATURATION_DAYS = 45;

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const CANARY_KEY = /^financial-canary-[a-z0-9][a-z0-9-]{7,95}$/;
const DEPLOYMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{7,127}$/;
const EVIDENCE_RUN_ID =
  /^[a-z][a-z0-9_-]{1,31}:[A-Za-z0-9][A-Za-z0-9._/-]{7,127}$/;
const FAILURE_CODE = /^[a-z][a-z0-9_]{2,63}$/;
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const UUID =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;
const IBAN = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
const SECRET_LIKE =
  /(?:-----BEGIN [A-Z ]+PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._-]+|\b(?:api|secret)[_-]?key\s*[:=]\s*[A-Za-z0-9._-]{12,}|\b(?:sk|rk)_[A-Za-z0-9_-]{16,})/i;
const PLACEHOLDER_EVIDENCE =
  /(?:replace[-_.]?me|placeholder|example|sample|dummy|todo|tbd|proof[-_.]?here|run[-_.:]?123(?:\D|$))/i;

const TOP_LEVEL_KEYS = [
  'schema_version',
  'evidence_type',
  'status',
  'canary_key',
  'repository',
  'target_environment',
  'contains_personal_data',
  'scope',
  'outcome_path',
  'authorization',
  'deployments',
  'preflight',
  'lineage',
  'outcome',
  'supervision',
  'safety_closure',
  'failure',
];
const EVIDENCE_REFERENCE_KEYS = [
  'run_id',
  'sha256',
  'url',
  'verified_at',
];
const SAFE_FLAG_KEYS = [
  'partners_enabled',
  'partners_invite_only',
  'partners_cash_pilot_allowlist_only',
  'partners_earnings_enabled',
  'partners_credit_redemptions_enabled',
  'partners_shadow_mode',
  'partners_payouts_live',
  'partners_tv_relay_enabled',
  'partners_revolut_api_enabled',
  'edge_revolut_api_enabled',
  'business_api_credentials_present',
  'forbidden_provider_crons_active',
];
const FORBIDDEN_KEYS = new Set([
  'name',
  'display_name',
  'legal_name',
  'email',
  'email_address',
  'full_name',
  'first_name',
  'last_name',
  'given_name',
  'family_name',
  'phone',
  'phone_number',
  'date_of_birth',
  'iban',
  'bic',
  'swift',
  'bank_account',
  'bank_account_number',
  'account_number',
  'routing_number',
  'card_number',
  'beneficiary_id',
  'tax_id',
  'user_id',
  'customer_id',
  'account_id',
  'person_id',
  'profile_id',
  'payment_id',
  'transaction_id',
  'transfer_id',
  'order_id',
  'purchase_token',
  'session_id',
  'provider_id',
  'provider_reference',
  'provider_payload',
  'token',
  'secret',
  'referral_code',
  'totp',
  'otp',
  'authenticator_code',
  'vault_value',
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isPlainObject(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value);
}

function assertExactKeys(value, expectedKeys, trail) {
  assert(isPlainObject(value), trail + ' must be an object');
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  assert(
    actual.length === expected.length
      && actual.every((key, index) => key === expected[index]),
    trail + ' must contain exactly: ' + expected.join(', '),
  );
}

function normalizeKey(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function assertNoSensitiveData(value, trail) {
  const currentTrail = trail || '$';
  if (Array.isArray(value)) {
    value.forEach(function inspect(item, index) {
      assertNoSensitiveData(item, currentTrail + '[' + index + ']');
    });
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      assert(
        !FORBIDDEN_KEYS.has(normalizeKey(key)),
        'forbidden evidence key at ' + currentTrail + '.' + key,
      );
      assertNoSensitiveData(child, currentTrail + '.' + key);
    }
    return;
  }
  if (typeof value !== 'string') return;
  assert(!EMAIL.test(value), 'email-like value found at ' + currentTrail);
  assert(!UUID.test(value), 'UUID-like value found at ' + currentTrail);
  assert(!IBAN.test(value), 'IBAN-like value found at ' + currentTrail);
  assert(!IPV4.test(value), 'IP-like value found at ' + currentTrail);
  assert(!SECRET_LIKE.test(value), 'secret-like value found at ' + currentTrail);
}

function parseIsoTimestamp(value) {
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value)) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const canonical = new Date(parsed).toISOString();
  const normalized = value.includes('.')
    ? value
    : value.slice(0, -1) + '.000Z';
  return canonical === normalized ? parsed : null;
}

function assertNullableTimestamp(value, trail) {
  assert(
    value === null || parseIsoTimestamp(value) !== null,
    trail + ' must be null or a valid ISO UTC timestamp',
  );
}

function assertNullableHash(value, trail) {
  assert(
    value === null || SHA256.test(value),
    trail + ' must be null or a lowercase SHA-256',
  );
}

function assertNullableInteger(value, minimum, maximum, trail) {
  assert(
    value === null
      || (Number.isSafeInteger(value) && value >= minimum && value <= maximum),
    trail + ' must be null or a safe integer between '
      + minimum + ' and ' + maximum,
  );
}

function isPrivateIpv4(hostname) {
  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some(function invalid(value) {
    return !Number.isInteger(value) || value < 0 || value > 255;
  })) return true;
  return octets[0] === 10
    || octets[0] === 127
    || octets[0] === 0
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127);
}

function isPrivateHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (
    host === 'localhost'
    || host === 'metadata.google.internal'
    || host === 'instance-data.ec2.internal'
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || host.endsWith('.localhost')
  ) return true;
  const ipVersion = net.isIP(host);
  if (ipVersion === 4) return isPrivateIpv4(host);
  if (ipVersion === 6) {
    const normalized = host.toLowerCase();
    return normalized === '::1'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || normalized.startsWith('fe8')
      || normalized.startsWith('fe9')
      || normalized.startsWith('fea')
      || normalized.startsWith('feb')
      || normalized.startsWith('::ffff:10.')
      || normalized.startsWith('::ffff:127.')
      || normalized.startsWith('::ffff:169.254.')
      || normalized.startsWith('::ffff:192.168.');
  }
  return false;
}

function isStrictEvidenceUrl(value) {
  if (typeof value !== 'string' || value.includes('\\')) return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (parsed.port && parsed.port !== '443')
    || isPrivateHost(parsed.hostname)
  ) return false;
  const host = parsed.hostname.toLowerCase();
  if (
    host === 'example.com'
    || host.endsWith('.example.com')
    || host.endsWith('.example')
    || host.endsWith('.invalid')
  ) return false;
  const rawPath = value.slice(value.indexOf(parsed.host) + parsed.host.length);
  if (/\/(?:\.|%2e)(?:\/|$)/i.test(rawPath)) return false;
  if (/\/(?:\.\.|%2e%2e)(?:\/|$)/i.test(rawPath)) return false;
  return !parsed.pathname.includes('//');
}

function validateEvidenceReference(value, trail, nowMs) {
  if (value === null) return;
  assertExactKeys(value, EVIDENCE_REFERENCE_KEYS, trail);
  assert(
    EVIDENCE_RUN_ID.test(value.run_id)
      && !value.run_id.includes('..')
      && !value.run_id.includes('//')
      && !value.run_id.includes('\\')
      && !PLACEHOLDER_EVIDENCE.test(value.run_id),
    trail + '.run_id must identify a non-placeholder immutable run',
  );
  assert(
    SHA256.test(value.sha256)
      && !/^([a-f0-9])\1{63}$/.test(value.sha256),
    trail + '.sha256 must be a strong lowercase SHA-256',
  );
  assert(
    isStrictEvidenceUrl(value.url)
      && !PLACEHOLDER_EVIDENCE.test(value.url),
    trail + '.url must be a public immutable HTTPS evidence URL',
  );
  const verifiedAt = parseIsoTimestamp(value.verified_at);
  assert(
    verifiedAt !== null && verifiedAt <= nowMs + MAX_CLOCK_SKEW_MS,
    trail + '.verified_at must be a non-future ISO UTC timestamp',
  );
}

function collectEvidenceReferences(value, refs) {
  if (Array.isArray(value)) {
    value.forEach(function visit(item) {
      collectEvidenceReferences(item, refs);
    });
    return;
  }
  if (!isPlainObject(value)) return;
  const keys = Object.keys(value).sort();
  const referenceKeys = [...EVIDENCE_REFERENCE_KEYS].sort();
  if (
    keys.length === referenceKeys.length
    && keys.every(function same(key, index) {
      return key === referenceKeys[index];
    })
  ) {
    refs.push(value);
    return;
  }
  Object.values(value).forEach(function visit(child) {
    collectEvidenceReferences(child, refs);
  });
}

function assertEvidenceReferencesAreDistinct(evidence) {
  const refs = [];
  collectEvidenceReferences(evidence, refs);
  for (const field of ['run_id', 'sha256', 'url']) {
    const values = refs.map(function getValue(ref) { return ref[field]; });
    assert(
      new Set(values).size === values.length,
      'evidence references must not reuse ' + field,
    );
  }
}

function validateSafeFlags(value, trail) {
  assertExactKeys(value, SAFE_FLAG_KEYS, trail);
  for (const key of SAFE_FLAG_KEYS) {
    if (key === 'forbidden_provider_crons_active') {
      assert(
        Number.isSafeInteger(value[key]) && value[key] >= 0,
        trail + '.' + key + ' must be a non-negative integer',
      );
    } else {
      assert(typeof value[key] === 'boolean', trail + '.' + key + ' must be boolean');
    }
  }
}

function validateDeployment(value, trail, nowMs) {
  assertExactKeys(value, [
    'commit_sha',
    'deployment_id',
    'deployed_at',
    'evidence',
  ], trail);
  assert(
    value.commit_sha === null || COMMIT_SHA.test(value.commit_sha),
    trail + '.commit_sha must be null or a lowercase 40-character Git SHA',
  );
  assert(
    value.deployment_id === null || DEPLOYMENT_ID.test(value.deployment_id),
    trail + '.deployment_id must be null or an immutable deployment ID',
  );
  assertNullableTimestamp(value.deployed_at, trail + '.deployed_at');
  validateEvidenceReference(value.evidence, trail + '.evidence', nowMs);
  const present = [
    value.commit_sha,
    value.deployment_id,
    value.deployed_at,
    value.evidence,
  ].filter(function nonNull(item) { return item !== null; }).length;
  assert(
    present === 0 || present === 4,
    trail + ' must be wholly empty or wholly populated',
  );
}

function validateAuthorization(value, nowMs) {
  assertExactKeys(value, [
    'authorization_binding_sha256',
    'lineage_binding_sha256',
    'country_code',
    'currency',
    'currency_exponent',
    'ceiling_minor',
    'authorized_at',
    'expires_at',
    'gate_package_sha256s',
    'evidence',
  ], 'authorization');
  assertNullableHash(
    value.authorization_binding_sha256,
    'authorization.authorization_binding_sha256',
  );
  assertNullableHash(
    value.lineage_binding_sha256,
    'authorization.lineage_binding_sha256',
  );
  assert(
    value.country_code === null || /^[A-Z]{2}$/.test(value.country_code),
    'authorization.country_code must be null or an ISO alpha-2 code',
  );
  assert(
    value.currency === null || /^[A-Z]{3}$/.test(value.currency),
    'authorization.currency must be null or an ISO currency code',
  );
  assertNullableInteger(
    value.currency_exponent,
    0,
    3,
    'authorization.currency_exponent',
  );
  assertNullableInteger(
    value.ceiling_minor,
    1,
    MAX_MONEY_MINOR,
    'authorization.ceiling_minor',
  );
  assertNullableTimestamp(value.authorized_at, 'authorization.authorized_at');
  assertNullableTimestamp(value.expires_at, 'authorization.expires_at');
  assertExactKeys(value.gate_package_sha256s, [
    'legal_and_tax_approved',
    'privacy_approved',
    'country_policy_approved',
    'manual_payout_workflow_verified',
  ], 'authorization.gate_package_sha256s');
  for (const [key, hash] of Object.entries(value.gate_package_sha256s)) {
    assertNullableHash(hash, 'authorization.gate_package_sha256s.' + key);
  }
  validateEvidenceReference(value.evidence, 'authorization.evidence', nowMs);
}

function validatePayment(value, nowMs) {
  assertExactKeys(value, [
    'lineage_binding_sha256',
    'transaction_binding_sha256',
    'fact_binding_sha256',
    'attribution_binding_sha256',
    'environment',
    'rail',
    'event_type',
    'facts_status',
    'occurred_at',
    'currency',
    'currency_exponent',
    'gross_minor',
    'tax_minor',
    'eligible_minor',
    'evidence',
  ], 'lineage.payment');
  for (const key of [
    'lineage_binding_sha256',
    'transaction_binding_sha256',
    'fact_binding_sha256',
    'attribution_binding_sha256',
  ]) assertNullableHash(value[key], 'lineage.payment.' + key);
  assert(
    value.environment === null || ['production', 'sandbox'].includes(value.environment),
    'lineage.payment.environment is invalid',
  );
  assert(
    value.rail === null || ['web', 'google_play', 'revenuecat'].includes(value.rail),
    'lineage.payment.rail is invalid',
  );
  assert(
    value.event_type === null
      || ['capture', 'renewal', 'refund', 'chargeback', 'transfer'].includes(value.event_type),
    'lineage.payment.event_type is invalid',
  );
  assert(
    value.facts_status === null || ['complete', 'incomplete'].includes(value.facts_status),
    'lineage.payment.facts_status is invalid',
  );
  assertNullableTimestamp(value.occurred_at, 'lineage.payment.occurred_at');
  assert(
    value.currency === null || /^[A-Z]{3}$/.test(value.currency),
    'lineage.payment.currency must be null or an ISO currency code',
  );
  assertNullableInteger(
    value.currency_exponent,
    0,
    3,
    'lineage.payment.currency_exponent',
  );
  for (const key of ['gross_minor', 'tax_minor', 'eligible_minor']) {
    assertNullableInteger(value[key], 0, MAX_MONEY_MINOR, 'lineage.payment.' + key);
  }
  validateEvidenceReference(value.evidence, 'lineage.payment.evidence', nowMs);
}

function validateAccrual(value, nowMs) {
  assertExactKeys(value, [
    'lineage_binding_sha256',
    'entry_binding_sha256',
    'commission_rate_bps',
    'amount_minor',
    'created_at',
    'matures_at',
    'pending_balanced',
    'evidence',
  ], 'lineage.accrual');
  assertNullableHash(value.lineage_binding_sha256, 'lineage.accrual.lineage_binding_sha256');
  assertNullableHash(value.entry_binding_sha256, 'lineage.accrual.entry_binding_sha256');
  assertNullableInteger(
    value.commission_rate_bps,
    0,
    10_000,
    'lineage.accrual.commission_rate_bps',
  );
  assertNullableInteger(value.amount_minor, 0, MAX_MONEY_MINOR, 'lineage.accrual.amount_minor');
  assertNullableTimestamp(value.created_at, 'lineage.accrual.created_at');
  assertNullableTimestamp(value.matures_at, 'lineage.accrual.matures_at');
  assert(typeof value.pending_balanced === 'boolean', 'lineage.accrual.pending_balanced must be boolean');
  validateEvidenceReference(value.evidence, 'lineage.accrual.evidence', nowMs);
}

function validateMaturation(value, nowMs) {
  assertExactKeys(value, [
    'lineage_binding_sha256',
    'job_binding_sha256',
    'release_entry_binding_sha256',
    'status',
    'available_at',
    'completed_at',
    'release_amount_minor',
    'reversed_minor',
    'recovery_due_minor',
    'available_balanced',
    'shadow_reconciliation_clean',
    'evidence',
  ], 'lineage.maturation');
  for (const key of [
    'lineage_binding_sha256',
    'job_binding_sha256',
    'release_entry_binding_sha256',
  ]) assertNullableHash(value[key], 'lineage.maturation.' + key);
  assert(
    value.status === null || ['succeeded', 'failed'].includes(value.status),
    'lineage.maturation.status is invalid',
  );
  assertNullableTimestamp(value.available_at, 'lineage.maturation.available_at');
  assertNullableTimestamp(value.completed_at, 'lineage.maturation.completed_at');
  for (const key of ['release_amount_minor', 'reversed_minor', 'recovery_due_minor']) {
    assertNullableInteger(value[key], 0, MAX_MONEY_MINOR, 'lineage.maturation.' + key);
  }
  assert(typeof value.available_balanced === 'boolean', 'lineage.maturation.available_balanced must be boolean');
  assert(
    typeof value.shadow_reconciliation_clean === 'boolean',
    'lineage.maturation.shadow_reconciliation_clean must be boolean',
  );
  validateEvidenceReference(value.evidence, 'lineage.maturation.evidence', nowMs);
}

function validateCashOutcome(value, nowMs) {
  assertExactKeys(value, [
    'provider',
    'execution_adapter',
    'business_api_enabled',
    'request_binding_sha256',
    'allocation_binding_sha256',
    'cycle_binding_sha256',
    'batch_binding_sha256',
    'execution_binding_sha256',
    'maker_binding_sha256',
    'checker_binding_sha256',
    'maker_mfa_aal2',
    'checker_mfa_aal2',
    'currency',
    'amount_minor',
    'item_count',
    'batch_status',
    'execution_state',
    'reconciliation_status',
    'reference_contract',
    'statement_contract',
    'beneficiary_binding_contract',
    'prepared_at',
    'maker_approved_at',
    'checker_approved_at',
    'exported_at',
    'submitted_at',
    'paid_observed_at',
    'statement_imported_at',
    'reconciled_at',
    'open_incidents',
    'evidence',
  ], 'outcome.cash_manual_payout');
  assert(value.provider === 'revolut', 'cash outcome provider must equal revolut');
  assert(
    value.execution_adapter === 'revolut_manual',
    'cash outcome execution_adapter must equal revolut_manual',
  );
  assert(value.business_api_enabled === false, 'cash outcome Business API must remain false');
  for (const key of [
    'request_binding_sha256',
    'allocation_binding_sha256',
    'cycle_binding_sha256',
    'batch_binding_sha256',
    'execution_binding_sha256',
    'maker_binding_sha256',
    'checker_binding_sha256',
  ]) assertNullableHash(value[key], 'outcome.cash_manual_payout.' + key);
  assert(typeof value.maker_mfa_aal2 === 'boolean', 'cash maker_mfa_aal2 must be boolean');
  assert(typeof value.checker_mfa_aal2 === 'boolean', 'cash checker_mfa_aal2 must be boolean');
  assert(
    value.currency === null || /^[A-Z]{3}$/.test(value.currency),
    'cash outcome currency must be null or an ISO currency code',
  );
  assertNullableInteger(value.amount_minor, 0, MAX_MONEY_MINOR, 'cash outcome amount_minor');
  assertNullableInteger(value.item_count, 0, 1, 'cash outcome item_count');
  assert(
    value.batch_status === null
      || ['prepared', 'exported', 'submitted', 'settled', 'exception'].includes(value.batch_status),
    'cash outcome batch_status is invalid',
  );
  assert(
    value.execution_state === null
      || ['prepared', 'exported', 'submitted', 'processing', 'paid', 'failed', 'exception'].includes(value.execution_state),
    'cash outcome execution_state is invalid',
  );
  assert(
    value.reconciliation_status === null
      || ['not_ready', 'pending', 'confirmed', 'exception'].includes(value.reconciliation_status),
    'cash outcome reconciliation_status is invalid',
  );
  assert(
    value.reference_contract === 'norva-payout-reference-v1',
    'cash outcome reference_contract is invalid',
  );
  assert(
    value.statement_contract === 'revolut-manual-statement-v2',
    'cash outcome statement_contract is invalid',
  );
  assert(
    value.beneficiary_binding_contract === 'revolut-beneficiary-binding-v1',
    'cash outcome beneficiary_binding_contract is invalid',
  );
  for (const key of [
    'prepared_at',
    'maker_approved_at',
    'checker_approved_at',
    'exported_at',
    'submitted_at',
    'paid_observed_at',
    'statement_imported_at',
    'reconciled_at',
  ]) assertNullableTimestamp(value[key], 'outcome.cash_manual_payout.' + key);
  assertNullableInteger(value.open_incidents, 0, 1_000, 'cash outcome open_incidents');
  assertExactKeys(value.evidence, [
    'batch_prepare',
    'maker_approval',
    'checker_approval',
    'export',
    'manual_transfer',
    'statement_import',
    'reconciliation',
  ], 'outcome.cash_manual_payout.evidence');
  for (const [key, ref] of Object.entries(value.evidence)) {
    validateEvidenceReference(ref, 'outcome.cash_manual_payout.evidence.' + key, nowMs);
  }
}

function validateConversionOutcome(value, nowMs) {
  assertExactKeys(value, [
    'catalog_binding_sha256',
    'quote_binding_sha256',
    'redemption_binding_sha256',
    'grant_binding_sha256',
    'plan_code',
    'months',
    'currency',
    'currency_exponent',
    'source_amount_minor',
    'ledger_debit_minor',
    'quoted_at',
    'quote_expires_at',
    'redeemed_at',
    'grant_observed_at',
    'grant_status',
    'entitlement_visible',
    'kyc_required',
    'payout_tables_unchanged',
    'evidence',
  ], 'outcome.subscription_conversion');
  for (const key of [
    'catalog_binding_sha256',
    'quote_binding_sha256',
    'redemption_binding_sha256',
    'grant_binding_sha256',
  ]) assertNullableHash(value[key], 'outcome.subscription_conversion.' + key);
  assert(
    value.plan_code === null || ['plus', 'family', 'premium'].includes(value.plan_code),
    'subscription conversion plan_code is invalid',
  );
  assertNullableInteger(value.months, 1, 12, 'subscription conversion months');
  assert(
    value.currency === null || /^[A-Z]{3}$/.test(value.currency),
    'subscription conversion currency must be null or an ISO currency code',
  );
  assertNullableInteger(value.currency_exponent, 0, 3, 'subscription conversion currency_exponent');
  assertNullableInteger(value.source_amount_minor, 0, MAX_MONEY_MINOR, 'subscription conversion source_amount_minor');
  assertNullableInteger(value.ledger_debit_minor, 0, MAX_MONEY_MINOR, 'subscription conversion ledger_debit_minor');
  for (const key of ['quoted_at', 'quote_expires_at', 'redeemed_at', 'grant_observed_at']) {
    assertNullableTimestamp(value[key], 'outcome.subscription_conversion.' + key);
  }
  assert(
    value.grant_status === null || ['active', 'consumed'].includes(value.grant_status),
    'subscription conversion grant_status is invalid',
  );
  for (const key of ['entitlement_visible', 'kyc_required', 'payout_tables_unchanged']) {
    assert(typeof value[key] === 'boolean', 'subscription conversion ' + key + ' must be boolean');
  }
  assertExactKeys(value.evidence, [
    'quote',
    'redemption',
    'access_projection',
  ], 'outcome.subscription_conversion.evidence');
  for (const [key, ref] of Object.entries(value.evidence)) {
    validateEvidenceReference(ref, 'outcome.subscription_conversion.evidence.' + key, nowMs);
  }
}

function validateStructure(evidence, options) {
  const nowMs = options.nowMs === undefined ? Date.now() : options.nowMs;
  assertNoSensitiveData(evidence);
  assertExactKeys(evidence, TOP_LEVEL_KEYS, 'evidence');
  assert(evidence.schema_version === SCHEMA_VERSION, 'schema_version must equal 1');
  assert(evidence.evidence_type === EVIDENCE_TYPE, 'evidence_type must equal partners_financial_canary');
  assert(
    ['draft', 'verified', 'failed_closed'].includes(evidence.status),
    'status must be draft, verified or failed_closed',
  );
  assert(CANARY_KEY.test(evidence.canary_key), 'canary_key has an invalid format');
  assert(evidence.repository === REPOSITORY, 'repository must equal Admin-Adher/Norva');
  assert(evidence.target_environment === 'production', 'target_environment must equal production');
  assert(evidence.contains_personal_data === false, 'contains_personal_data must remain false');

  assertExactKeys(evidence.scope, [
    'account_count',
    'synthetic_data',
    'pilot_ready_eligible',
    'generalization_ready_eligible',
  ], 'scope');
  assert(evidence.scope.account_count === 1, 'scope.account_count must equal 1');
  assert(evidence.scope.synthetic_data === false, 'scope.synthetic_data must remain false');
  assert(evidence.scope.pilot_ready_eligible === false, 'financial canary can never satisfy pilot_ready');
  assert(
    evidence.scope.generalization_ready_eligible === false,
    'financial canary can never satisfy generalization_ready',
  );
  assert(
    ['cash_manual_payout', 'subscription_conversion'].includes(evidence.outcome_path),
    'outcome_path is invalid',
  );

  validateAuthorization(evidence.authorization, nowMs);
  assertExactKeys(evidence.deployments, [
    'payment_ingest',
    'maturation_release',
    'outcome',
  ], 'deployments');
  for (const [key, value] of Object.entries(evidence.deployments)) {
    validateDeployment(value, 'deployments.' + key, nowMs);
  }

  assertExactKeys(evidence.preflight, [
    'mode',
    'passed_at',
    'failed_checks',
    'active_allowlist_count',
    'bound_account_count',
    'lineage_contract',
    'safe_flags_before',
    'evidence',
  ], 'preflight');
  assert(evidence.preflight.mode === 'financial_canary', 'preflight.mode must equal financial_canary');
  assertNullableTimestamp(evidence.preflight.passed_at, 'preflight.passed_at');
  assertNullableInteger(evidence.preflight.failed_checks, 0, 1_000, 'preflight.failed_checks');
  assertNullableInteger(evidence.preflight.active_allowlist_count, 0, 1, 'preflight.active_allowlist_count');
  assertNullableInteger(evidence.preflight.bound_account_count, 0, 1, 'preflight.bound_account_count');
  assert(
    evidence.preflight.lineage_contract === 'partners-financial-canary-lineage-v1',
    'preflight.lineage_contract is invalid',
  );
  validateSafeFlags(evidence.preflight.safe_flags_before, 'preflight.safe_flags_before');
  validateEvidenceReference(evidence.preflight.evidence, 'preflight.evidence', nowMs);

  assertExactKeys(evidence.lineage, ['payment', 'accrual', 'maturation'], 'lineage');
  validatePayment(evidence.lineage.payment, nowMs);
  validateAccrual(evidence.lineage.accrual, nowMs);
  validateMaturation(evidence.lineage.maturation, nowMs);

  assertExactKeys(evidence.outcome, [
    'cash_manual_payout',
    'subscription_conversion',
  ], 'outcome');
  if (evidence.outcome_path === 'cash_manual_payout') {
    assert(isPlainObject(evidence.outcome.cash_manual_payout), 'cash outcome must be present');
    assert(evidence.outcome.subscription_conversion === null, 'conversion outcome must be null for cash');
    validateCashOutcome(evidence.outcome.cash_manual_payout, nowMs);
  } else {
    assert(evidence.outcome.cash_manual_payout === null, 'cash outcome must be null for conversion');
    assert(isPlainObject(evidence.outcome.subscription_conversion), 'conversion outcome must be present');
    validateConversionOutcome(evidence.outcome.subscription_conversion, nowMs);
  }

  assertExactKeys(evidence.supervision, [
    'release_manager_binding_sha256',
    'aal2_verified',
    'approved_at',
    'evidence',
  ], 'supervision');
  assertNullableHash(
    evidence.supervision.release_manager_binding_sha256,
    'supervision.release_manager_binding_sha256',
  );
  assert(typeof evidence.supervision.aal2_verified === 'boolean', 'supervision.aal2_verified must be boolean');
  assertNullableTimestamp(evidence.supervision.approved_at, 'supervision.approved_at');
  validateEvidenceReference(evidence.supervision.evidence, 'supervision.evidence', nowMs);

  assertExactKeys(evidence.safety_closure, [
    'closed_at',
    'payout_window_opened',
    'flags_after',
    'open_canary_batches',
    'open_canary_incidents',
    'subject_vault_entry_present',
    'authorization_vault_entry_present',
    'evidence',
  ], 'safety_closure');
  assertNullableTimestamp(evidence.safety_closure.closed_at, 'safety_closure.closed_at');
  assert(
    typeof evidence.safety_closure.payout_window_opened === 'boolean',
    'safety_closure.payout_window_opened must be boolean',
  );
  validateSafeFlags(evidence.safety_closure.flags_after, 'safety_closure.flags_after');
  assertNullableInteger(evidence.safety_closure.open_canary_batches, 0, 1_000, 'safety_closure.open_canary_batches');
  assertNullableInteger(evidence.safety_closure.open_canary_incidents, 0, 1_000, 'safety_closure.open_canary_incidents');
  assert(
    typeof evidence.safety_closure.subject_vault_entry_present === 'boolean',
    'safety_closure.subject_vault_entry_present must be boolean',
  );
  assert(
    typeof evidence.safety_closure.authorization_vault_entry_present === 'boolean',
    'safety_closure.authorization_vault_entry_present must be boolean',
  );
  validateEvidenceReference(evidence.safety_closure.evidence, 'safety_closure.evidence', nowMs);

  assertExactKeys(evidence.failure, ['failed_at', 'phase', 'code', 'evidence'], 'failure');
  assertNullableTimestamp(evidence.failure.failed_at, 'failure.failed_at');
  assert(
    evidence.failure.phase === null
      || ['authorization', 'preflight', 'payment', 'accrual', 'maturation', 'outcome', 'closure'].includes(evidence.failure.phase),
    'failure.phase is invalid',
  );
  assert(
    evidence.failure.code === null || FAILURE_CODE.test(evidence.failure.code),
    'failure.code is invalid',
  );
  validateEvidenceReference(evidence.failure.evidence, 'failure.evidence', nowMs);
  assertEvidenceReferencesAreDistinct(evidence);
}

function isHash(value) {
  return typeof value === 'string' && SHA256.test(value);
}

function isTimestamp(value) {
  return parseIsoTimestamp(value) !== null;
}

function evidenceAtOrAfter(ref, timestamp) {
  const eventAt = parseIsoTimestamp(timestamp);
  return ref !== null
    && eventAt !== null
    && parseIsoTimestamp(ref.verified_at) >= eventAt;
}

function deploymentIsComplete(value) {
  return COMMIT_SHA.test(value.commit_sha || '')
    && DEPLOYMENT_ID.test(value.deployment_id || '')
    && isTimestamp(value.deployed_at)
    && value.evidence !== null
    && evidenceAtOrAfter(value.evidence, value.deployed_at);
}

function flagsAreSafe(flags) {
  return flags.partners_enabled === true
    && flags.partners_invite_only === false
    && flags.partners_cash_pilot_allowlist_only === true
    && flags.partners_earnings_enabled === true
    && flags.partners_credit_redemptions_enabled === true
    && flags.partners_shadow_mode === true
    && flags.partners_payouts_live === false
    && flags.partners_tv_relay_enabled === false
    && flags.partners_revolut_api_enabled === false
    && flags.edge_revolut_api_enabled === false
    && flags.business_api_credentials_present === false
    && flags.forbidden_provider_crons_active === 0;
}

function closureBlockers(evidence) {
  const blockers = [];
  const closure = evidence.safety_closure;
  if (!isTimestamp(closure.closed_at)) blockers.push('safe_closure_not_timestamped');
  if (!flagsAreSafe(closure.flags_after)) blockers.push('safe_flags_not_restored');
  if (closure.open_canary_batches !== 0) blockers.push('canary_batches_still_open');
  if (closure.open_canary_incidents !== 0) blockers.push('canary_incidents_still_open');
  if (closure.subject_vault_entry_present !== false) blockers.push('subject_vault_entry_not_revoked');
  if (closure.authorization_vault_entry_present !== false) blockers.push('authorization_vault_entry_not_revoked');
  if (!evidenceAtOrAfter(closure.evidence, closure.closed_at)) blockers.push('safe_closure_not_proven');
  if (
    evidence.status === 'verified'
    && evidence.outcome_path === 'cash_manual_payout'
    && closure.payout_window_opened !== true
  ) blockers.push('cash_payout_window_not_recorded');
  if (
    evidence.outcome_path === 'subscription_conversion'
    && closure.payout_window_opened !== false
  ) blockers.push('conversion_must_not_open_payout_window');
  return blockers;
}

function financialCanaryBlockers(evidence) {
  const blockers = [];
  const authorization = evidence.authorization;
  const payment = evidence.lineage.payment;
  const accrual = evidence.lineage.accrual;
  const maturation = evidence.lineage.maturation;
  const preflight = evidence.preflight;
  const closure = evidence.safety_closure;

  if (
    !isHash(authorization.authorization_binding_sha256)
    || !isHash(authorization.lineage_binding_sha256)
    || !/^[A-Z]{2}$/.test(authorization.country_code || '')
    || !/^[A-Z]{3}$/.test(authorization.currency || '')
    || !Number.isSafeInteger(authorization.currency_exponent)
    || !Number.isSafeInteger(authorization.ceiling_minor)
    || !isTimestamp(authorization.authorized_at)
    || !isTimestamp(authorization.expires_at)
    || !evidenceAtOrAfter(authorization.evidence, authorization.authorized_at)
    || Object.values(authorization.gate_package_sha256s).some(function missing(hash) {
      return !isHash(hash);
    })
    || new Set(Object.values(authorization.gate_package_sha256s)).size !== 4
  ) blockers.push('authorization_not_proven');
  if (
    isTimestamp(authorization.authorized_at)
    && isTimestamp(payment.occurred_at)
    && parseIsoTimestamp(authorization.authorized_at) > parseIsoTimestamp(payment.occurred_at)
  ) blockers.push('authorization_postdates_payment');
  if (
    isTimestamp(authorization.expires_at)
    && isTimestamp(closure.closed_at)
    && parseIsoTimestamp(authorization.expires_at) < parseIsoTimestamp(closure.closed_at)
  ) blockers.push('authorization_expired_before_closure');

  for (const [phase, deployment] of Object.entries(evidence.deployments)) {
    if (!deploymentIsComplete(deployment)) blockers.push('deployment_' + phase + '_not_proven');
  }

  if (
    preflight.failed_checks !== 0
    || preflight.active_allowlist_count !== 1
    || preflight.bound_account_count !== 1
    || !isTimestamp(preflight.passed_at)
    || !flagsAreSafe(preflight.safe_flags_before)
    || !evidenceAtOrAfter(preflight.evidence, preflight.passed_at)
  ) blockers.push('financial_canary_preflight_not_proven');

  if (
    !isHash(payment.lineage_binding_sha256)
    || !isHash(payment.transaction_binding_sha256)
    || !isHash(payment.fact_binding_sha256)
    || !isHash(payment.attribution_binding_sha256)
    || payment.environment !== 'production'
    || !['web', 'google_play', 'revenuecat'].includes(payment.rail)
    || !['capture', 'renewal'].includes(payment.event_type)
    || payment.facts_status !== 'complete'
    || !isTimestamp(payment.occurred_at)
    || !Number.isSafeInteger(payment.gross_minor)
    || !Number.isSafeInteger(payment.tax_minor)
    || !Number.isSafeInteger(payment.eligible_minor)
    || payment.gross_minor <= 0
    || payment.tax_minor < 0
    || payment.eligible_minor <= 0
    || payment.eligible_minor !== payment.gross_minor - payment.tax_minor
    || !evidenceAtOrAfter(payment.evidence, payment.occurred_at)
  ) blockers.push('eligible_production_payment_not_proven');

  if (
    !isHash(accrual.lineage_binding_sha256)
    || !isHash(accrual.entry_binding_sha256)
    || accrual.commission_rate_bps !== COMMISSION_RATE_BPS
    || !Number.isSafeInteger(accrual.amount_minor)
    || accrual.amount_minor <= 0
    || !isTimestamp(accrual.created_at)
    || !isTimestamp(accrual.matures_at)
    || accrual.pending_balanced !== true
    || !evidenceAtOrAfter(accrual.evidence, accrual.created_at)
  ) blockers.push('commission_accrual_not_proven');

  if (
    Number.isSafeInteger(payment.eligible_minor)
    && Number.isSafeInteger(accrual.amount_minor)
  ) {
    const expectedCommission = Math.floor(
      (payment.eligible_minor * COMMISSION_RATE_BPS + 5_000) / 10_000,
    );
    if (accrual.amount_minor !== expectedCommission) {
      blockers.push('commission_amount_does_not_match_20_percent_contract');
    }
  }

  if (
    !isHash(maturation.lineage_binding_sha256)
    || !isHash(maturation.job_binding_sha256)
    || !isHash(maturation.release_entry_binding_sha256)
    || maturation.status !== 'succeeded'
    || !isTimestamp(maturation.available_at)
    || !isTimestamp(maturation.completed_at)
    || !Number.isSafeInteger(maturation.release_amount_minor)
    || maturation.release_amount_minor <= 0
    || maturation.reversed_minor !== 0
    || maturation.recovery_due_minor !== 0
    || maturation.available_balanced !== true
    || maturation.shadow_reconciliation_clean !== true
    || !evidenceAtOrAfter(maturation.evidence, maturation.completed_at)
  ) blockers.push('maturation_release_not_proven');

  const lineageBindings = [
    authorization.lineage_binding_sha256,
    payment.lineage_binding_sha256,
    accrual.lineage_binding_sha256,
    maturation.lineage_binding_sha256,
  ];
  if (
    lineageBindings.some(function missing(value) { return !isHash(value); })
    || new Set(lineageBindings).size !== 1
  ) blockers.push('financial_lineage_binding_mismatch');

  const stageBindings = [
    payment.transaction_binding_sha256,
    payment.fact_binding_sha256,
    payment.attribution_binding_sha256,
    accrual.entry_binding_sha256,
    maturation.job_binding_sha256,
    maturation.release_entry_binding_sha256,
  ];
  if (
    stageBindings.some(function missing(value) { return !isHash(value); })
    || new Set(stageBindings).size !== stageBindings.length
  ) blockers.push('financial_stage_bindings_not_distinct');

  if (
    payment.currency !== authorization.currency
    || payment.currency_exponent !== authorization.currency_exponent
  ) blockers.push('authorized_currency_mismatch');
  if (
    Number.isSafeInteger(accrual.amount_minor)
    && Number.isSafeInteger(maturation.release_amount_minor)
    && accrual.amount_minor !== maturation.release_amount_minor
  ) blockers.push('release_amount_does_not_match_accrual');

  const paymentAt = parseIsoTimestamp(payment.occurred_at);
  const maturesAt = parseIsoTimestamp(accrual.matures_at);
  const availableAt = parseIsoTimestamp(maturation.available_at);
  const completedAt = parseIsoTimestamp(maturation.completed_at);
  if (
    paymentAt === null
    || maturesAt === null
    || maturesAt < paymentAt + MATURATION_DAYS * DAY_MS
  ) blockers.push('j45_maturation_not_elapsed');
  if (
    maturesAt === null
    || availableAt === null
    || completedAt === null
    || availableAt < maturesAt
    || completedAt < availableAt
  ) blockers.push('maturation_timestamps_unordered');
  if (
    completedAt === null
    || parseIsoTimestamp(preflight.passed_at) === null
    || parseIsoTimestamp(preflight.passed_at) < completedAt
  ) blockers.push('preflight_predates_maturation');

  if (
    evidence.supervision.aal2_verified !== true
    || !isHash(evidence.supervision.release_manager_binding_sha256)
    || !isTimestamp(evidence.supervision.approved_at)
    || !evidenceAtOrAfter(evidence.supervision.evidence, evidence.supervision.approved_at)
  ) blockers.push('release_manager_supervision_not_proven');
  if (
    isTimestamp(evidence.supervision.approved_at)
    && isTimestamp(preflight.passed_at)
    && parseIsoTimestamp(evidence.supervision.approved_at) > parseIsoTimestamp(preflight.passed_at)
  ) blockers.push('release_manager_approval_postdates_preflight');

  const paymentDeployment = evidence.deployments.payment_ingest;
  const maturationDeployment = evidence.deployments.maturation_release;
  const outcomeDeployment = evidence.deployments.outcome;
  if (
    isTimestamp(paymentDeployment.deployed_at)
    && paymentAt !== null
    && parseIsoTimestamp(paymentDeployment.deployed_at) > paymentAt
  ) blockers.push('payment_ingest_deployment_postdates_payment');
  if (
    isTimestamp(maturationDeployment.deployed_at)
    && completedAt !== null
    && parseIsoTimestamp(maturationDeployment.deployed_at) > completedAt
  ) blockers.push('maturation_deployment_postdates_release');

  if (evidence.outcome_path === 'cash_manual_payout') {
    const cash = evidence.outcome.cash_manual_payout;
    const hashes = [
      cash.request_binding_sha256,
      cash.allocation_binding_sha256,
      cash.cycle_binding_sha256,
      cash.batch_binding_sha256,
      cash.execution_binding_sha256,
      cash.maker_binding_sha256,
      cash.checker_binding_sha256,
    ];
    if (
      hashes.some(function missing(value) { return !isHash(value); })
      || new Set(hashes).size !== hashes.length
    ) {
      blockers.push('manual_payout_bindings_not_proven');
    }
    if (
      cash.maker_binding_sha256 === cash.checker_binding_sha256
      || cash.maker_mfa_aal2 !== true
      || cash.checker_mfa_aal2 !== true
    ) blockers.push('maker_checker_not_independent_and_aal2');
    if (
      cash.currency !== payment.currency
      || cash.amount_minor !== maturation.release_amount_minor
      || cash.item_count !== 1
      || cash.batch_status !== 'settled'
      || cash.execution_state !== 'paid'
      || cash.reconciliation_status !== 'confirmed'
      || cash.open_incidents !== 0
      || !Number.isSafeInteger(authorization.ceiling_minor)
      || cash.amount_minor !== authorization.ceiling_minor
    ) blockers.push('manual_payout_amount_or_terminal_state_invalid');
    const orderedKeys = [
      'prepared_at',
      'maker_approved_at',
      'checker_approved_at',
      'exported_at',
      'submitted_at',
      'paid_observed_at',
      'statement_imported_at',
      'reconciled_at',
    ];
    const orderedTimes = orderedKeys.map(function getTime(key) {
      return parseIsoTimestamp(cash[key]);
    });
    if (
      orderedTimes.some(function missing(value) { return value === null; })
      || orderedTimes.some(function unordered(value, index) {
        return index > 0 && value < orderedTimes[index - 1];
      })
      || parseIsoTimestamp(preflight.passed_at) > orderedTimes[0]
    ) blockers.push('manual_payout_timestamps_unordered');
    const proofMap = [
      ['batch_prepare', 'prepared_at'],
      ['maker_approval', 'maker_approved_at'],
      ['checker_approval', 'checker_approved_at'],
      ['export', 'exported_at'],
      ['manual_transfer', 'paid_observed_at'],
      ['statement_import', 'statement_imported_at'],
      ['reconciliation', 'reconciled_at'],
    ];
    if (proofMap.some(function unproven(pair) {
      return !evidenceAtOrAfter(cash.evidence[pair[0]], cash[pair[1]]);
    })) blockers.push('manual_payout_stage_evidence_incomplete');
    if (
      isTimestamp(outcomeDeployment.deployed_at)
      && orderedTimes[0] !== null
      && parseIsoTimestamp(outcomeDeployment.deployed_at) > orderedTimes[0]
    ) blockers.push('outcome_deployment_postdates_cash_execution');
    if (
      orderedTimes[7] !== null
      && isTimestamp(closure.closed_at)
      && parseIsoTimestamp(closure.closed_at) < orderedTimes[7]
    ) blockers.push('safe_closure_predates_reconciliation');
  } else {
    const conversion = evidence.outcome.subscription_conversion;
    const hashes = [
      conversion.catalog_binding_sha256,
      conversion.quote_binding_sha256,
      conversion.redemption_binding_sha256,
      conversion.grant_binding_sha256,
    ];
    if (
      hashes.some(function missing(value) { return !isHash(value); })
      || new Set(hashes).size !== hashes.length
    ) {
      blockers.push('subscription_conversion_bindings_not_proven');
    }
    if (
      !['plus', 'family', 'premium'].includes(conversion.plan_code)
      || !Number.isSafeInteger(conversion.months)
      || conversion.currency !== payment.currency
      || conversion.currency_exponent !== payment.currency_exponent
      || !Number.isSafeInteger(conversion.source_amount_minor)
      || conversion.source_amount_minor <= 0
      || conversion.source_amount_minor > maturation.release_amount_minor
      || conversion.ledger_debit_minor !== conversion.source_amount_minor
      || !['active', 'consumed'].includes(conversion.grant_status)
      || conversion.entitlement_visible !== true
      || conversion.kyc_required !== false
      || conversion.payout_tables_unchanged !== true
    ) blockers.push('subscription_conversion_terminal_state_invalid');
    const quotedAt = parseIsoTimestamp(conversion.quoted_at);
    const expiresAt = parseIsoTimestamp(conversion.quote_expires_at);
    const redeemedAt = parseIsoTimestamp(conversion.redeemed_at);
    const grantAt = parseIsoTimestamp(conversion.grant_observed_at);
    if (
      quotedAt === null
      || expiresAt === null
      || redeemedAt === null
      || grantAt === null
      || quotedAt > redeemedAt
      || redeemedAt >= expiresAt
      || grantAt < redeemedAt
      || parseIsoTimestamp(preflight.passed_at) > quotedAt
    ) blockers.push('subscription_conversion_timestamps_unordered');
    if (
      !evidenceAtOrAfter(conversion.evidence.quote, conversion.quoted_at)
      || !evidenceAtOrAfter(conversion.evidence.redemption, conversion.redeemed_at)
      || !evidenceAtOrAfter(conversion.evidence.access_projection, conversion.grant_observed_at)
    ) blockers.push('subscription_conversion_stage_evidence_incomplete');
    if (
      isTimestamp(outcomeDeployment.deployed_at)
      && redeemedAt !== null
      && parseIsoTimestamp(outcomeDeployment.deployed_at) > redeemedAt
    ) blockers.push('outcome_deployment_postdates_conversion');
    if (
      grantAt !== null
      && isTimestamp(closure.closed_at)
      && parseIsoTimestamp(closure.closed_at) < grantAt
    ) blockers.push('safe_closure_predates_access_projection');
  }

  blockers.push(...closureBlockers(evidence));
  return [...new Set(blockers)].sort();
}

function failureClosureBlockers(evidence) {
  const blockers = closureBlockers(evidence);
  if (
    !isTimestamp(evidence.failure.failed_at)
    || evidence.failure.phase === null
    || evidence.failure.code === null
    || !evidenceAtOrAfter(evidence.failure.evidence, evidence.failure.failed_at)
  ) blockers.push('failed_closed_reason_not_proven');
  if (
    isTimestamp(evidence.failure.failed_at)
    && isTimestamp(evidence.safety_closure.closed_at)
    && parseIsoTimestamp(evidence.safety_closure.closed_at)
      < parseIsoTimestamp(evidence.failure.failed_at)
  ) blockers.push('failed_closed_safety_closure_predates_failure');
  return [...new Set(blockers)].sort();
}

function validateEvidence(evidence, options) {
  const resolved = options || {};
  validateStructure(evidence, resolved);
  const blockers = financialCanaryBlockers(evidence);
  const failureBlockers = evidence.status === 'failed_closed'
    ? failureClosureBlockers(evidence)
    : [];
  if (evidence.status === 'verified' && blockers.length) {
    throw new Error(
      'status verified contradicts blockers: ' + blockers.join(', '),
    );
  }
  if (evidence.status === 'failed_closed' && failureBlockers.length) {
    throw new Error(
      'status failed_closed contradicts blockers: '
        + failureBlockers.join(', '),
    );
  }
  if (evidence.status !== 'failed_closed') {
    assert(
      evidence.failure.failed_at === null
        && evidence.failure.phase === null
        && evidence.failure.code === null
        && evidence.failure.evidence === null,
      'failure must remain empty unless status=failed_closed',
    );
  }
  return { blockers, failureBlockers };
}

function evaluateEvidence(evidence, options) {
  const result = validateEvidence(evidence, options);
  return {
    financialCanaryBlockers: result.blockers,
    financialCanaryVerified:
      evidence.status === 'verified' && result.blockers.length === 0,
    pilotReady: false,
    generalizationReady: false,
  };
}

function parseCliArgs(args) {
  assert(Array.isArray(args), 'CLI arguments must be an array');
  let file = null;
  let requireVerified = false;
  let expectedOutcomePath = null;
  let expectedCommitSha = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--require-verified') {
      assert(!requireVerified, 'duplicate --require-verified');
      requireVerified = true;
      continue;
    }
    if (arg === '--expected-outcome-path') {
      assert(expectedOutcomePath === null, 'duplicate --expected-outcome-path');
      expectedOutcomePath = args[index + 1];
      assert(
        ['cash_manual_payout', 'subscription_conversion'].includes(expectedOutcomePath),
        '--expected-outcome-path requires cash_manual_payout or subscription_conversion',
      );
      index += 1;
      continue;
    }
    if (arg.startsWith('--expected-outcome-path=')) {
      assert(expectedOutcomePath === null, 'duplicate --expected-outcome-path');
      expectedOutcomePath = arg.slice('--expected-outcome-path='.length);
      assert(
        ['cash_manual_payout', 'subscription_conversion'].includes(expectedOutcomePath),
        '--expected-outcome-path requires cash_manual_payout or subscription_conversion',
      );
      continue;
    }
    if (arg === '--expected-commit-sha') {
      assert(expectedCommitSha === null, 'duplicate --expected-commit-sha');
      expectedCommitSha = args[index + 1];
      assert(
        COMMIT_SHA.test(expectedCommitSha || ''),
        '--expected-commit-sha requires a lowercase 40-character Git SHA',
      );
      index += 1;
      continue;
    }
    if (arg.startsWith('--expected-commit-sha=')) {
      assert(expectedCommitSha === null, 'duplicate --expected-commit-sha');
      expectedCommitSha = arg.slice('--expected-commit-sha='.length);
      assert(
        COMMIT_SHA.test(expectedCommitSha),
        '--expected-commit-sha requires a lowercase 40-character Git SHA',
      );
      continue;
    }
    assert(!arg.startsWith('--'), 'unknown option: ' + arg);
    assert(file === null, 'exactly one evidence file is required');
    file = arg;
  }
  assert(file !== null, 'exactly one evidence file is required');
  return { file, requireVerified, expectedOutcomePath, expectedCommitSha };
}

if (require.main === module) {
  try {
    const cli = parseCliArgs(process.argv.slice(2));
    const evidencePath = path.resolve(process.cwd(), cli.file);
    const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    if (cli.expectedOutcomePath !== null) {
      assert(
        evidence.outcome_path === cli.expectedOutcomePath,
        'outcome_path does not match --expected-outcome-path',
      );
    }
    if (cli.expectedCommitSha !== null) {
      assert(
        evidence.deployments
          && evidence.deployments.outcome
          && evidence.deployments.outcome.commit_sha === cli.expectedCommitSha,
        'deployments.outcome.commit_sha does not match --expected-commit-sha',
      );
    }
    if (cli.requireVerified) {
      assert(
        evidence.status === 'verified',
        '--require-verified requires status=verified',
      );
    }
    const result = evaluateEvidence(evidence);
    if (cli.requireVerified && !result.financialCanaryVerified) process.exitCode = 1;
    console.log(JSON.stringify({
      status: evidence.status,
      evidence_type: evidence.evidence_type,
      outcome_path: evidence.outcome_path,
      financial_canary_verified: result.financialCanaryVerified,
      pilot_ready: false,
      generalization_ready: false,
      blockers: result.financialCanaryBlockers,
    }, null, 2));
  } catch (error) {
    console.error('Invalid Partners financial canary evidence: ' + error.message);
    console.error(
      'Usage: node scripts/validate-partners-financial-canary-evidence.js '
        + '<evidence.json> [--require-verified] '
        + '[--expected-outcome-path=<cash_manual_payout|subscription_conversion>] '
        + '[--expected-commit-sha=<40-lowercase-hex>]',
    );
    process.exit(1);
  }
}

module.exports = {
  EVIDENCE_TYPE,
  SCHEMA_VERSION,
  evaluateEvidence,
  financialCanaryBlockers,
  parseCliArgs,
  validateEvidence,
};
