'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const template = JSON.parse(fs.readFileSync(
  path.join(root, 'ops/partners/pilot-release.example.json'),
  'utf8',
));
const {
  evaluateEvidence,
  validateEvidence,
} = require('../scripts/validate-partners-release-evidence.js');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readyEvidence() {
  const evidence = clone(template);
  evidence.status = 'pilot_ready';
  evidence.release_key = 'partners-pilot-v1';
  evidence.program.version_key = 'partners-v1';
  evidence.legal = {
    terms_version: 'partners-terms-v1',
    terms_sha256: 'a'.repeat(64),
    disclosure_version: 'partners-disclosure-v1',
    disclosure_sha256: 'b'.repeat(64),
    privacy_review_evidence: 'legal-review-2026-07',
    public_surfaces: {
      verified_at: '2026-07-30T00:00:00Z',
      deployment_ref: 'production-deploy-123',
      terms_evidence: 'terms-content-check-123',
      privacy_evidence: 'privacy-content-check-123',
      partners_terms_evidence: 'partners-terms-content-check-123',
    },
  };
  evidence.jurisdictions = [{
    country_code: 'US',
    subdivision_code: null,
    policy_key: 'us-individual-v1',
    payout_currencies: ['USD'],
    gates: {
      legal_contract_and_disclosure: true,
      didit_identity_age_country_capacity: true,
      individual_tax: true,
      individual_payout: true,
      exact_financial_data: true,
    },
  }];
  evidence.allowlist.configured_count = 20;
  for (const provider of Object.values(evidence.providers)) {
    provider.status = 'configured_and_verified';
    provider.sandbox_evidence = 'sandbox-run-verified';
  }
  evidence.feature_flags.partners_enabled = true;
  evidence.feature_flags.partners_invite_only = true;
  evidence.feature_flags.partners_shadow_mode = true;
  evidence.quality = {
    partners_ci_run_evidence: 'github-actions-run-123',
    security_advisors_passed: true,
    performance_advisors_passed: true,
    offsite_backup_evidence: 'encrypted-r2-backup-123',
    offsite_backup_encrypted: true,
    restore_drill_evidence: 'isolated-restore-drill-123',
    restore_verifier_passed: true,
  };
  evidence.runtime = {
    worker_cron_evidence: 'cron-heartbeat-run-123',
    shadow_reconciliation_evidence: 'shadow-run-123',
    shadow_reconciliation_clean: true,
    alert_and_recovery_evidence: 'sandbox-alert-cycle-123',
  };
  evidence.approvals = {
    legal: true,
    risk: true,
    finance: true,
    operations: true,
  };
  return evidence;
}

test('the committed release evidence template is valid and fail-closed', () => {
  assert.doesNotThrow(() => validateEvidence(template));
  const result = evaluateEvidence(template);
  assert.ok(result.pilotBlockers.length > 0);
  assert.ok(result.pilotBlockers.includes('no_jurisdiction_configured'));
  assert.ok(result.pilotBlockers.includes('provider_didit_not_verified'));
  assert.ok(
    result.pilotBlockers.includes('legal_public_surfaces_not_verified'),
  );
  assert.equal(template.feature_flags.partners_enabled, false);
  assert.equal(template.feature_flags.partners_payouts_live, false);
  assert.equal(template.contains_personal_data, false);
});

test('pilot readiness requires providers, a jurisdiction, allowlist and runtime proof', () => {
  const evidence = readyEvidence();
  const result = evaluateEvidence(evidence);
  assert.deepEqual(result.pilotBlockers, []);
  assert.deepEqual(result.generalizationBlockers, [
    'payout_cycle_1_not_reconciled',
    'payout_cycle_2_not_reconciled',
  ]);
  assert.equal(evidence.feature_flags.partners_payouts_live, false);
});

test('generalization requires two supervised and reconciled payout cycles', () => {
  const evidence = readyEvidence();
  evidence.status = 'generalization_ready';
  for (const cycle of evidence.payout_cycles) {
    cycle.status = 'supervised_and_reconciled';
    cycle.reconciliation_evidence = `cycle-${cycle.sequence}-reconciled`;
  }
  const result = evaluateEvidence(evidence);
  assert.deepEqual(result.pilotBlockers, []);
  assert.deepEqual(result.generalizationBlockers, []);
});

test('pilot readiness requires content-verified deployed legal surfaces', () => {
  const evidence = readyEvidence();
  evidence.status = 'draft';
  evidence.legal.public_surfaces.partners_terms_evidence = null;
  assert.ok(
    evaluateEvidence(evidence).pilotBlockers.includes(
      'legal_public_surfaces_not_verified',
    ),
  );

  evidence.legal.public_surfaces.partners_terms_evidence =
    'partners-terms-content-check-123';
  evidence.legal.public_surfaces.verified_at = '30/07/2026';
  assert.ok(
    evaluateEvidence(evidence).pilotBlockers.includes(
      'legal_public_surfaces_not_verified',
    ),
  );
});

test('release evidence rejects direct personal identifiers', () => {
  const evidence = clone(template);
  evidence.customer_email = 'person@example.com';
  assert.throws(
    () => validateEvidence(evidence),
    /forbidden evidence key|email-like value/,
  );
});
