'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  REQUIRED_PROOFS,
  canonicalize,
  validateCompletionEvidence,
  validateCompletionEvidenceFile,
} = require('../scripts/validate-behavioral-lifecycle-completion-evidence.js');

const PROOF_TIMES = {
  real_schema_and_data_staging_scenarios: '2026-09-05T12:00:00Z',
  internal_fcm_delivery_and_open: '2026-09-06T12:00:00Z',
  internal_email_delivery_and_unsubscribe: '2026-09-06T14:00:00Z',
  physical_android_permission_deep_link_and_receipts: '2026-09-07T12:00:00Z',
  hetzner_firebase_ga4_reconciliation: '2026-09-07T15:00:00Z',
  authorized_ten_percent_pilot: '2026-09-08T08:00:00Z',
  mature_j7_and_j14_outcomes: '2026-09-22T10:00:00Z',
};

function outcome(journeyKey, primaryMetric, treatmentConverted, holdoutConverted) {
  const treatmentAssigned = 90;
  const holdoutAssigned = 10;
  const treatmentRate = (100 * treatmentConverted) / treatmentAssigned;
  const holdoutRate = (100 * holdoutConverted) / holdoutAssigned;
  const absoluteLift = treatmentRate - holdoutRate;
  return {
    journey_key: journeyKey,
    primary_metric: primaryMetric,
    window_hours: 72,
    treatment_assigned: treatmentAssigned,
    treatment_converted: treatmentConverted,
    holdout_assigned: holdoutAssigned,
    holdout_converted: holdoutConverted,
    treatment_rate_pct: Number(treatmentRate.toFixed(2)),
    holdout_rate_pct: Number(holdoutRate.toFixed(2)),
    absolute_lift_pp: Number(absoluteLift.toFixed(2)),
    relative_uplift_pct: holdoutRate === 0 ? null : Number(((100 * absoluteLift) / holdoutRate).toFixed(2)),
    sample_mature: true,
    analysis_complete: true,
    measurable_gain: true,
  };
}

function validCompletionEvidence() {
  return {
    schema_version: 1,
    artifact_type: 'norva_behavioral_lifecycle_completion_claim',
    evidence_scope: 'verification_only_no_action_authority',
    captured_at: '2026-09-22T12:00:00Z',
    repository: 'Admin-Adher/Norva',
    production_commit: 'b'.repeat(40),
    deployment_id: 'production:lifecycle-20260908',
    contains_personal_data: false,
    contains_secrets: false,
    dormant_evidence_sha256: 'a'.repeat(64),
    required_proofs: Object.fromEntries(
      REQUIRED_PROOFS.map((proofName, index) => [proofName, {
        status: 'passed',
        observed_at: PROOF_TIMES[proofName],
        artifact_id: `evidence:${proofName}`,
        artifact_sha256: `${index + 1}`.repeat(64),
      }]),
    ),
    reconciliation: {
      canonical_ledger: 'hetzner_postgresql',
      canonical_lifecycle_event_count: 16,
      canonical_lifecycle_events_complete: true,
      ga4_reconciliation_mode: 'semantic_product_event_mapping',
      mapped_client_milestones_complete: true,
      unexplained_material_differences: 0,
      contains_personal_data: false,
    },
    pilot: {
      rollout_percent: 10,
      holdout_percent: 10,
      countries: ['BD', 'IN'],
      internal_accounts_excluded: true,
      started_at: '2026-09-08T09:00:00Z',
      ended_at: '2026-09-22T09:00:00Z',
      authorization_artifact_sha256: '8'.repeat(64),
      emergency_stop_tested: true,
      rollback_tested: true,
    },
    safety: {
      duplicate_sends: 0,
      post_conversion_sends: 0,
      pii_leaks: 0,
      consent_violations: 0,
      frequency_cap_violations: 0,
      quiet_hours_violations: 0,
      unsubscribe_rate_delta_pp: 0.1,
      provider_rejection_rate_delta_pp: 0.2,
    },
    priority_journey_outcomes: [
      outcome('no_source', 'source_attempted', 45, 4),
      outcome('import_unresolved', 'import_success', 36, 3),
      outcome('catalog_ready_no_first_play', 'first_play', 54, 5),
    ],
    release_assertion: {
      completion_claim_validated: true,
      reason: 'all_required_evidence_verified',
      missing_required_proofs: [],
      does_not_authorize_deployment_activation_or_messages: true,
    },
  };
}

test('completion evidence validator accepts a mature, safe and positive three-journey proof', () => {
  const evidence = validateCompletionEvidence(validCompletionEvidence());
  assert.equal(evidence.priority_journey_outcomes.length, 3);
  assert.equal(evidence.pilot.holdout_percent, 10);
});

test('completion evidence validator rejects incomplete, unsafe or fabricated claims', () => {
  const cases = [
    ['unexpected personal field', (value) => { value.email = 'user@example.test'; }],
    ['personal data declaration', (value) => { value.contains_personal_data = true; }],
    ['missing proof', (value) => { delete value.required_proofs.internal_fcm_delivery_and_open; }],
    ['failed proof', (value) => { value.required_proofs.internal_email_delivery_and_unsubscribe.status = 'failed'; }],
    ['pilot without permanent holdout', (value) => { value.pilot.holdout_percent = 9; }],
    ['pilot shorter than J+14', (value) => { value.pilot.ended_at = '2026-09-21T08:59:59Z'; }],
    ['mature proof before pilot end', (value) => { value.required_proofs.mature_j7_and_j14_outcomes.observed_at = '2026-09-21T10:00:00Z'; }],
    ['duplicate send', (value) => { value.safety.duplicate_sends = 1; }],
    ['message after conversion', (value) => { value.safety.post_conversion_sends = 1; }],
    ['unsubscribe guardrail breach', (value) => { value.safety.unsubscribe_rate_delta_pp = 0.51; }],
    ['provider rejection guardrail breach', (value) => { value.safety.provider_rejection_rate_delta_pp = 0.51; }],
    ['incomplete canonical registry', (value) => { value.reconciliation.canonical_lifecycle_event_count = 15; }],
    ['fabricated rate', (value) => { value.priority_journey_outcomes[0].treatment_rate_pct = 99; }],
    ['no positive treatment gain', (value) => {
      value.priority_journey_outcomes[1] = outcome('import_unresolved', 'import_success', 18, 3);
    }],
    ['artifact grants action authority', (value) => {
      value.release_assertion.does_not_authorize_deployment_activation_or_messages = false;
    }],
  ];

  for (const [label, mutate] of cases) {
    const evidence = validCompletionEvidence();
    mutate(evidence);
    assert.throws(() => validateCompletionEvidence(evidence), undefined, label);
  }
});

test('completion evidence file validation requires canonical immutable bytes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'norva-lifecycle-completion-'));
  const validPath = path.join(directory, 'valid.json');
  const nonCanonicalPath = path.join(directory, 'non-canonical.json');
  try {
    const evidence = validCompletionEvidence();
    const canonical = `${JSON.stringify(canonicalize(evidence), null, 2)}\n`;
    fs.writeFileSync(validPath, canonical, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.writeFileSync(nonCanonicalPath, JSON.stringify(evidence), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.chmodSync(validPath, 0o600);
    fs.chmodSync(nonCanonicalPath, 0o600);

    const result = validateCompletionEvidenceFile(validPath);
    assert.equal(result.productionCommit, 'b'.repeat(40));
    assert.throws(
      () => validateCompletionEvidenceFile(nonCanonicalPath),
      /canonical JSON encoding/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
