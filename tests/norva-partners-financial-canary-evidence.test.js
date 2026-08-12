'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const validatorPath = path.join(
  root,
  'scripts',
  'validate-partners-financial-canary-evidence.js',
);
const templatePath = path.join(
  root,
  'ops',
  'partners',
  'financial-canary-evidence.example.json',
);
const schemaPath = path.join(
  root,
  'ops',
  'partners',
  'financial-canary-evidence.schema.json',
);
const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
const releaseValidator = require('../scripts/validate-partners-release-evidence.js');
const {
  evaluateEvidence,
  parseCliArgs,
  validateEvidence,
} = require('../scripts/validate-partners-financial-canary-evidence.js');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function binding(key) {
  return sha256('financial-canary-binding:' + key);
}

function evidenceRef(key, verifiedAt) {
  return {
    run_id: 'ops:' + key + '-20260615-0001',
    sha256: sha256('financial-canary-evidence:' + key),
    url: 'https://evidence.norva.tv/partners/financial-canary/'
      + key + '.json',
    verified_at: verifiedAt,
  };
}

function deployment(key, deployedAt, proofAt) {
  return {
    commit_sha: sha256('financial-canary-commit:' + key).slice(0, 40),
    deployment_id: 'hetzner:financial-canary-' + key + '-20260615',
    deployed_at: deployedAt,
    evidence: evidenceRef('deployment-' + key, proofAt),
  };
}

function verifiedCashEvidence() {
  const evidence = clone(template);
  const lineageBinding = binding('lineage-cash-001');
  evidence.status = 'verified';
  evidence.canary_key = 'financial-canary-20260615-cash-001';
  evidence.authorization = {
    authorization_binding_sha256: binding('authorization-cash-001'),
    lineage_binding_sha256: lineageBinding,
    country_code: 'FR',
    currency: 'USD',
    currency_exponent: 2,
    ceiling_minor: 1_000,
    authorized_at: '2026-04-30T08:00:00Z',
    expires_at: '2026-06-30T23:59:59Z',
    gate_package_sha256s: {
      legal_and_tax_approved: binding('gate-legal'),
      privacy_approved: binding('gate-privacy'),
      country_policy_approved: binding('gate-country'),
      manual_payout_workflow_verified: binding('gate-manual-payout'),
    },
    evidence: evidenceRef('authorization-cash', '2026-04-30T08:05:00Z'),
  };
  evidence.deployments = {
    payment_ingest: deployment(
      'payment-ingest',
      '2026-04-29T10:00:00Z',
      '2026-04-29T10:05:00Z',
    ),
    maturation_release: deployment(
      'maturation-release',
      '2026-06-14T10:00:00Z',
      '2026-06-14T10:05:00Z',
    ),
    outcome: deployment(
      'cash-outcome',
      '2026-06-14T11:00:00Z',
      '2026-06-14T11:05:00Z',
    ),
  };
  evidence.lineage.payment = {
    lineage_binding_sha256: lineageBinding,
    transaction_binding_sha256: binding('transaction-cash'),
    fact_binding_sha256: binding('fact-cash'),
    attribution_binding_sha256: binding('attribution-cash'),
    environment: 'production',
    rail: 'web',
    event_type: 'capture',
    facts_status: 'complete',
    occurred_at: '2026-05-01T00:00:00Z',
    currency: 'USD',
    currency_exponent: 2,
    gross_minor: 5_000,
    tax_minor: 0,
    eligible_minor: 5_000,
    evidence: evidenceRef('payment-cash', '2026-05-01T00:05:00Z'),
  };
  evidence.lineage.accrual = {
    lineage_binding_sha256: lineageBinding,
    entry_binding_sha256: binding('accrual-entry-cash'),
    commission_rate_bps: 2_000,
    amount_minor: 1_000,
    created_at: '2026-05-01T00:10:00Z',
    matures_at: '2026-06-15T00:00:00Z',
    pending_balanced: true,
    evidence: evidenceRef('accrual-cash', '2026-05-01T00:15:00Z'),
  };
  evidence.lineage.maturation = {
    lineage_binding_sha256: lineageBinding,
    job_binding_sha256: binding('maturation-job-cash'),
    release_entry_binding_sha256: binding('release-entry-cash'),
    status: 'succeeded',
    available_at: '2026-06-15T00:00:00Z',
    completed_at: '2026-06-15T01:00:00Z',
    release_amount_minor: 1_000,
    reversed_minor: 0,
    recovery_due_minor: 0,
    available_balanced: true,
    shadow_reconciliation_clean: true,
    evidence: evidenceRef('maturation-cash', '2026-06-15T01:05:00Z'),
  };
  evidence.supervision = {
    release_manager_binding_sha256: binding('release-manager-cash'),
    aal2_verified: true,
    approved_at: '2026-06-15T01:20:00Z',
    evidence: evidenceRef('release-manager-cash', '2026-06-15T01:25:00Z'),
  };
  evidence.preflight.failed_checks = 0;
  evidence.preflight.active_allowlist_count = 1;
  evidence.preflight.bound_account_count = 1;
  evidence.preflight.passed_at = '2026-06-15T02:00:00Z';
  evidence.preflight.evidence = evidenceRef(
    'preflight-cash',
    '2026-06-15T02:05:00Z',
  );
  evidence.outcome.cash_manual_payout = {
    provider: 'revolut',
    execution_adapter: 'revolut_manual',
    business_api_enabled: false,
    request_binding_sha256: binding('payout-request-cash'),
    allocation_binding_sha256: binding('payout-allocation-cash'),
    cycle_binding_sha256: binding('payout-cycle-cash'),
    batch_binding_sha256: binding('payout-batch-cash'),
    execution_binding_sha256: binding('payout-execution-cash'),
    maker_binding_sha256: binding('maker-cash'),
    checker_binding_sha256: binding('checker-cash'),
    maker_mfa_aal2: true,
    checker_mfa_aal2: true,
    currency: 'USD',
    amount_minor: 1_000,
    item_count: 1,
    batch_status: 'settled',
    execution_state: 'paid',
    reconciliation_status: 'confirmed',
    reference_contract: 'norva-payout-reference-v1',
    statement_contract: 'revolut-manual-statement-v2',
    beneficiary_binding_contract: 'revolut-beneficiary-binding-v1',
    prepared_at: '2026-06-15T03:00:00Z',
    maker_approved_at: '2026-06-15T04:00:00Z',
    checker_approved_at: '2026-06-15T05:00:00Z',
    exported_at: '2026-06-15T06:00:00Z',
    submitted_at: '2026-06-15T07:00:00Z',
    paid_observed_at: '2026-06-15T08:00:00Z',
    statement_imported_at: '2026-06-15T09:00:00Z',
    reconciled_at: '2026-06-15T10:00:00Z',
    open_incidents: 0,
    evidence: {
      batch_prepare: evidenceRef('cash-batch-prepare', '2026-06-15T03:05:00Z'),
      maker_approval: evidenceRef('cash-maker-approval', '2026-06-15T04:05:00Z'),
      checker_approval: evidenceRef('cash-checker-approval', '2026-06-15T05:05:00Z'),
      export: evidenceRef('cash-export', '2026-06-15T06:05:00Z'),
      manual_transfer: evidenceRef('cash-manual-transfer', '2026-06-15T08:05:00Z'),
      statement_import: evidenceRef('cash-statement-import', '2026-06-15T09:05:00Z'),
      reconciliation: evidenceRef('cash-reconciliation', '2026-06-15T10:05:00Z'),
    },
  };
  evidence.safety_closure = {
    closed_at: '2026-06-15T11:00:00Z',
    payout_window_opened: true,
    flags_after: clone(evidence.preflight.safe_flags_before),
    open_canary_batches: 0,
    open_canary_incidents: 0,
    subject_vault_entry_present: false,
    authorization_vault_entry_present: false,
    evidence: evidenceRef('cash-safe-closure', '2026-06-15T11:05:00Z'),
  };
  return evidence;
}

function verifiedConversionEvidence() {
  const evidence = verifiedCashEvidence();
  evidence.canary_key = 'financial-canary-20260615-conversion-001';
  evidence.outcome_path = 'subscription_conversion';
  evidence.authorization.authorization_binding_sha256 =
    binding('authorization-conversion-001');
  evidence.authorization.evidence = evidenceRef(
    'authorization-conversion',
    '2026-04-30T08:06:00Z',
  );
  evidence.deployments.outcome = deployment(
    'conversion-outcome',
    '2026-06-14T11:30:00Z',
    '2026-06-14T11:35:00Z',
  );
  evidence.outcome.cash_manual_payout = null;
  evidence.outcome.subscription_conversion = {
    catalog_binding_sha256: binding('catalog-conversion'),
    quote_binding_sha256: binding('quote-conversion'),
    redemption_binding_sha256: binding('redemption-conversion'),
    grant_binding_sha256: binding('grant-conversion'),
    plan_code: 'plus',
    months: 1,
    currency: 'USD',
    currency_exponent: 2,
    source_amount_minor: 499,
    ledger_debit_minor: 499,
    quoted_at: '2026-06-15T03:00:00Z',
    quote_expires_at: '2026-06-15T04:00:00Z',
    redeemed_at: '2026-06-15T03:10:00Z',
    grant_observed_at: '2026-06-15T03:20:00Z',
    grant_status: 'active',
    entitlement_visible: true,
    kyc_required: false,
    payout_tables_unchanged: true,
    evidence: {
      quote: evidenceRef('conversion-quote', '2026-06-15T03:05:00Z'),
      redemption: evidenceRef('conversion-redemption', '2026-06-15T03:15:00Z'),
      access_projection: evidenceRef('conversion-access', '2026-06-15T03:25:00Z'),
    },
  };
  evidence.safety_closure.closed_at = '2026-06-15T04:10:00Z';
  evidence.safety_closure.payout_window_opened = false;
  evidence.safety_closure.evidence = evidenceRef(
    'conversion-safe-closure',
    '2026-06-15T04:15:00Z',
  );
  return evidence;
}

function assertVerifiedMutationBlocked(mutate, expected) {
  const evidence = verifiedCashEvidence();
  mutate(evidence);
  assert.throws(function validate() {
    validateEvidence(evidence);
  }, expected);
}

test('committed canary template is valid, draft and permanently non-pilot', function () {
  const result = evaluateEvidence(template);
  assert.equal(result.financialCanaryVerified, false);
  assert.equal(result.pilotReady, false);
  assert.equal(result.generalizationReady, false);
  assert.ok(result.financialCanaryBlockers.length > 0);
  assert.equal(template.scope.pilot_ready_eligible, false);
  assert.equal(template.scope.generalization_ready_eligible, false);
});

test('JSON schema fixes the separate evidence identity and readiness exclusions', function () {
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.schema_version.const, 1);
  assert.equal(
    schema.properties.evidence_type.const,
    'partners_financial_canary',
  );
  assert.deepEqual(
    schema.properties.status.enum,
    ['draft', 'verified', 'failed_closed'],
  );
  assert.equal(
    schema.properties.scope.properties.pilot_ready_eligible.const,
    false,
  );
  assert.equal(
    schema.properties.scope.properties.generalization_ready_eligible.const,
    false,
  );
});

test('verified manual payout proves the exact financial lineage and closure', function () {
  const evidence = verifiedCashEvidence();
  const result = evaluateEvidence(evidence);
  assert.deepEqual(result.financialCanaryBlockers, []);
  assert.equal(result.financialCanaryVerified, true);
  assert.equal(result.pilotReady, false);
  assert.equal(result.generalizationReady, false);
});

test('verified subscription conversion proves access without opening cash', function () {
  const evidence = verifiedConversionEvidence();
  const result = evaluateEvidence(evidence);
  assert.deepEqual(result.financialCanaryBlockers, []);
  assert.equal(result.financialCanaryVerified, true);
  assert.equal(evidence.safety_closure.payout_window_opened, false);
  assert.equal(result.pilotReady, false);
});

test('the release evidence validator cannot accept a financial canary', function () {
  const evidence = verifiedCashEvidence();
  assert.throws(function validateAsRelease() {
    releaseValidator.validateEvidence(evidence);
  }, /evidence must contain exactly|schema_version must equal 8/);
  assert.throws(function parsePilotOption() {
    parseCliArgs(['canary.json', '--require-pilot-ready']);
  }, /unknown option: --require-pilot-ready/);
});

test('canary status and scope cannot impersonate release readiness', function () {
  for (const status of ['pilot_ready', 'generalization_ready']) {
    const evidence = clone(template);
    evidence.status = status;
    assert.throws(function validateStatus() {
      validateEvidence(evidence);
    }, /status must be draft, verified or failed_closed/);
  }
  const pilotEligible = clone(template);
  pilotEligible.scope.pilot_ready_eligible = true;
  assert.throws(function validatePilotEligible() {
    validateEvidence(pilotEligible);
  }, /can never satisfy pilot_ready/);
});

test('CLI rejects draft under require-verified and emits explicit false readiness', function () {
  const run = spawnSync(process.execPath, [
    validatorPath,
    templatePath,
    '--require-verified',
  ], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /requires status=verified/);

  const inspect = spawnSync(process.execPath, [validatorPath, templatePath], {
    encoding: 'utf8',
  });
  assert.equal(inspect.status, 0);
  const output = JSON.parse(inspect.stdout);
  assert.equal(output.financial_canary_verified, false);
  assert.equal(output.pilot_ready, false);
  assert.equal(output.generalization_ready, false);
});

test('CLI binds verification to the exact outcome deployment commit', function () {
  const evidence = verifiedCashEvidence();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'norva-canary-'));
  const evidencePath = path.join(tempDir, 'canary.json');
  fs.writeFileSync(evidencePath, JSON.stringify(evidence));
  try {
    const accepted = spawnSync(process.execPath, [
      validatorPath,
      evidencePath,
      '--require-verified',
      '--expected-outcome-path=cash_manual_payout',
      '--expected-commit-sha=' + evidence.deployments.outcome.commit_sha,
    ], { encoding: 'utf8' });
    assert.equal(accepted.status, 0, accepted.stderr);
    const rejected = spawnSync(process.execPath, [
      validatorPath,
      evidencePath,
      '--require-verified',
      '--expected-commit-sha=' + sha256('wrong-commit').slice(0, 40),
    ], { encoding: 'utf8' });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /does not match --expected-commit-sha/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('payment evidence must be production, complete and bound to its fact', function () {
  assertVerifiedMutationBlocked(function mutate(evidence) {
    evidence.lineage.payment.environment = 'sandbox';
  }, /eligible_production_payment_not_proven/);
  assertVerifiedMutationBlocked(function mutate(evidence) {
    evidence.lineage.payment.event_type = 'refund';
  }, /eligible_production_payment_not_proven/);
  assertVerifiedMutationBlocked(function mutate(evidence) {
    evidence.lineage.payment.fact_binding_sha256 = null;
  }, /eligible_production_payment_not_proven/);
});

test('commission amount and J+45 are calculated from the exact payment', function () {
  assertVerifiedMutationBlocked(function mutate(evidence) {
    evidence.lineage.accrual.amount_minor = 999;
  }, /commission_amount_does_not_match_20_percent_contract/);
  assertVerifiedMutationBlocked(function mutate(evidence) {
    evidence.lineage.accrual.matures_at = '2026-06-14T23:59:59Z';
  }, /j45_maturation_not_elapsed/);
  assertVerifiedMutationBlocked(function mutate(evidence) {
    evidence.lineage.maturation.release_amount_minor = 999;
  }, /release_amount_does_not_match_accrual/);
  assertVerifiedMutationBlocked(function mutate(evidence) {
    evidence.lineage.maturation.recovery_due_minor = 1;
  }, /maturation_release_not_proven/);
});

test('manual payout requires independent AAL2 maker-checker and no API', function () {
  assertVerifiedMutationBlocked(function mutate(evidence) {
    evidence.outcome.cash_manual_payout.checker_binding_sha256 =
      evidence.outcome.cash_manual_payout.maker_binding_sha256;
  }, /maker_checker_not_independent_and_aal2/);
  assertVerifiedMutationBlocked(function mutate(evidence) {
    evidence.outcome.cash_manual_payout.business_api_enabled = true;
  }, /Business API must remain false/);
  assertVerifiedMutationBlocked(function mutate(evidence) {
    evidence.outcome.cash_manual_payout.item_count = 0;
  }, /manual_payout_amount_or_terminal_state_invalid/);
  assertVerifiedMutationBlocked(function mutate(evidence) {
    evidence.authorization.ceiling_minor = 2_000;
  }, /manual_payout_amount_or_terminal_state_invalid/);
});

test('opaque bindings distinguish every financial and payout stage', function () {
  assertVerifiedMutationBlocked(function mutate(evidence) {
    evidence.lineage.payment.fact_binding_sha256 =
      evidence.lineage.payment.transaction_binding_sha256;
  }, /financial_stage_bindings_not_distinct/);
  assertVerifiedMutationBlocked(function mutate(evidence) {
    evidence.outcome.cash_manual_payout.batch_binding_sha256 =
      evidence.outcome.cash_manual_payout.cycle_binding_sha256;
  }, /manual_payout_bindings_not_proven/);
});

test('manual payout needs ordered export, transfer, statement and reconciliation proof', function () {
  assertVerifiedMutationBlocked(function mutate(evidence) {
    evidence.outcome.cash_manual_payout.statement_imported_at =
      '2026-06-15T07:30:00Z';
  }, /manual_payout_timestamps_unordered/);
  assertVerifiedMutationBlocked(function mutate(evidence) {
    evidence.outcome.cash_manual_payout.evidence.statement_import = null;
  }, /manual_payout_stage_evidence_incomplete/);
  assertVerifiedMutationBlocked(function mutate(evidence) {
    evidence.outcome.cash_manual_payout.reconciliation_status = 'pending';
  }, /manual_payout_amount_or_terminal_state_invalid/);
});

test('subscription conversion is isolated from payout and linked to its ledger debit', function () {
  const wrongDebit = verifiedConversionEvidence();
  wrongDebit.outcome.subscription_conversion.ledger_debit_minor = 498;
  assert.throws(function validateWrongDebit() {
    validateEvidence(wrongDebit);
  }, /subscription_conversion_terminal_state_invalid/);

  const expiredQuote = verifiedConversionEvidence();
  expiredQuote.outcome.subscription_conversion.quote_expires_at =
    '2026-06-15T03:05:00Z';
  assert.throws(function validateExpiredQuote() {
    validateEvidence(expiredQuote);
  }, /subscription_conversion_timestamps_unordered/);

  const cashLeak = verifiedConversionEvidence();
  cashLeak.outcome.cash_manual_payout = clone(template.outcome.cash_manual_payout);
  assert.throws(function validateCashLeak() {
    validateEvidence(cashLeak);
  }, /cash outcome must be null for conversion/);
});

test('verified canary cannot close with unsafe flags, open work or Vault entries', function () {
  assertVerifiedMutationBlocked(function mutate(evidence) {
    evidence.safety_closure.flags_after.partners_payouts_live = true;
  }, /safe_flags_not_restored/);
  assertVerifiedMutationBlocked(function mutate(evidence) {
    evidence.safety_closure.flags_after.partners_shadow_mode = false;
  }, /safe_flags_not_restored/);
  assertVerifiedMutationBlocked(function mutate(evidence) {
    evidence.safety_closure.open_canary_batches = 1;
  }, /canary_batches_still_open/);
  assertVerifiedMutationBlocked(function mutate(evidence) {
    evidence.safety_closure.authorization_vault_entry_present = true;
  }, /authorization_vault_entry_not_revoked/);
  assertVerifiedMutationBlocked(function mutate(evidence) {
    evidence.safety_closure.subject_vault_entry_present = true;
  }, /subject_vault_entry_not_revoked/);
});

test('failed_closed records the failure and proves safe cleanup without readiness', function () {
  const evidence = clone(template);
  evidence.status = 'failed_closed';
  evidence.failure = {
    failed_at: '2026-05-02T08:00:00Z',
    phase: 'preflight',
    code: 'preflight_contract_failed',
    evidence: evidenceRef('failed-preflight', '2026-05-02T08:05:00Z'),
  };
  evidence.safety_closure.closed_at = '2026-05-02T08:10:00Z';
  evidence.safety_closure.evidence = evidenceRef(
    'failed-safe-closure',
    '2026-05-02T08:15:00Z',
  );
  const result = evaluateEvidence(evidence);
  assert.equal(result.financialCanaryVerified, false);
  assert.ok(result.financialCanaryBlockers.length > 0);
});

test('schema is recursively closed and evidence references are unique', function () {
  const extra = clone(template);
  extra.lineage.payment.raw_provider_payload = {};
  assert.throws(function validateExtra() {
    validateEvidence(extra);
  }, /lineage\.payment must contain exactly/);

  const duplicate = verifiedCashEvidence();
  duplicate.outcome.cash_manual_payout.evidence.export = clone(
    duplicate.outcome.cash_manual_payout.evidence.batch_prepare,
  );
  assert.throws(function validateDuplicate() {
    validateEvidence(duplicate);
  }, /must not reuse run_id/);
});

test('personal data, provider identifiers, private URLs and secrets are rejected', function () {
  const email = clone(template);
  email.canary_key = 'person@example.com';
  assert.throws(function validateEmail() {
    validateEvidence(email);
  }, /email-like value/);

  const providerId = clone(template);
  providerId.lineage.payment.transaction_id = 'provider-value';
  assert.throws(function validateProviderId() {
    validateEvidence(providerId);
  }, /forbidden evidence key/);

  const privateUrl = verifiedCashEvidence();
  privateUrl.preflight.evidence.url = 'https://10.0.0.1/proof.json';
  assert.throws(function validatePrivateUrl() {
    validateEvidence(privateUrl);
  }, /public immutable HTTPS evidence URL|IP-like value/);

  const secret = clone(template);
  secret.canary_key = 'financial-canary-api_key=sk_supersecret00000001';
  assert.throws(function validateSecret() {
    validateEvidence(secret);
  }, /secret-like value/);
});

test('CI validates the separate draft template without invoking pilot readiness', function () {
  const workflow = fs.readFileSync(
    path.join(root, '.github', 'workflows', 'partners-integration.yml'),
    'utf8',
  );
  assert.match(
    workflow,
    /validate-partners-financial-canary-evidence\.js[\s\S]*?financial-canary-evidence\.example\.json/,
  );
  assert.doesNotMatch(
    workflow,
    /validate-partners-financial-canary-evidence\.js[^\n]*--require-pilot-ready/,
  );
});
