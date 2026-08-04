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
  'validate-partners-release-evidence.js',
);
const template = JSON.parse(fs.readFileSync(
  path.join(root, 'ops/partners/pilot-release.example.json'),
  'utf8',
));
const {
  evaluateEvidence,
  parseCliArgs,
  validateEvidence,
} = require('../scripts/validate-partners-release-evidence.js');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function evidenceRef(key, overrides = {}) {
  return {
    url: `https://evidence.norva.tv/partners/${key}.json`,
    run_id: `ops:${key}-20260730-001`,
    sha256: sha256(`partners-evidence:${key}`),
    verified_at: '2026-07-30T08:00:00Z',
    ...overrides,
  };
}

function readyEvidence() {
  const evidence = clone(template);
  evidence.status = 'pilot_ready';
  evidence.release_key = 'partners-pilot-v1';
  evidence.candidate_commit_sha = sha256('candidate').slice(0, 40);
  evidence.target_environment = 'production';
  evidence.deployment_id = 'cloudflare:deploy-20260730-001';
  evidence.program.version_key = 'partners-v1';
  evidence.legal = {
    terms_version: 'partners-terms-v1',
    terms_sha256: sha256('partners-terms-v1'),
    disclosure_version: 'partners-disclosure-v1',
    disclosure_sha256: sha256('partners-disclosure-v1'),
    privacy_pilot_self_assessment_evidence:
      evidenceRef('privacy-pilot-self-assessment'),
    privacy_public_release_review_evidence: null,
    public_surfaces: {
      verified_at: '2026-07-30T07:00:00Z',
      hash_basis: 'normalized_deployment_artifact',
      deployment_evidence: evidenceRef('legal-deployment'),
      terms_evidence: evidenceRef('terms-content'),
      privacy_evidence: evidenceRef('privacy-content'),
      partners_terms_evidence: evidenceRef('partners-terms-content'),
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
  evidence.database_snapshot.status = 'captured_and_reviewed';
  evidence.database_snapshot.evidence = evidenceRef('database-snapshot');
  for (const key of Object.keys(evidence.database_snapshot.includes)) {
    evidence.database_snapshot.includes[key] = true;
  }
  evidence.app_links.android_phone.status = 'play_signed_aab_verified';
  evidence.app_links.android_phone.play_signed_aab = true;
  evidence.app_links.android_phone.evidence =
    evidenceRef('play-signed-app-link');
  for (const [name, provider] of Object.entries(evidence.providers)) {
    provider.status = 'configured_and_verified';
    if (name === 'individual_payout') {
      provider.production_evidence =
        evidenceRef(`${name}-production`);
    } else {
      provider.sandbox_evidence = evidenceRef(`${name}-sandbox`);
    }
  }
  evidence.providers.individual_payout.provider = 'revolut';
  evidence.providers.individual_payout.execution_adapter = 'revolut_manual';
  evidence.providers.didit.environment = 'live';
  evidence.providers.didit.config_fingerprint_sha256 =
    sha256('didit-live-config-fingerprint');
  evidence.providers.didit.workflow_version = 4;
  evidence.providers.didit.live_evidence = evidenceRef('didit-live');
  evidence.providers.didit.environment_isolation_evidence =
    evidenceRef('didit-environment-isolation');
  evidence.feature_flags.partners_enabled = true;
  evidence.feature_flags.partners_invite_only = false;
  evidence.feature_flags.partners_cash_pilot_allowlist_only = true;
  evidence.feature_flags.partners_earnings_enabled = true;
  evidence.feature_flags.partners_credit_redemptions_enabled = true;
  evidence.feature_flags.partners_shadow_mode = true;
  evidence.feature_flags.partners_tv_relay_enabled = true;
  evidence.payout_reconciliation.statement_status =
    'imported_and_reconciled';
  evidence.payout_reconciliation.provider = 'revolut';
  evidence.payout_reconciliation.execution_adapter = 'revolut_manual';
  evidence.payout_reconciliation.manual_route_status = 'active';
  evidence.payout_reconciliation.revolut_api_adapter_verified = false;
  evidence.payout_reconciliation.revolut_api_edge_enabled = false;
  evidence.payout_reconciliation.contract_version =
    'revolut-manual-statement-v2';
  evidence.payout_reconciliation.reference_contract =
    'norva-payout-reference-v1';
  evidence.payout_reconciliation.beneficiary_binding_contract =
    'revolut-beneficiary-binding-v1';
  evidence.payout_reconciliation.beneficiary_registry_status =
    'maker_checker_verified';
  evidence.payout_reconciliation.beneficiary_hmac_key_version = 1;
  evidence.payout_reconciliation.beneficiary_registry_evidence =
    evidenceRef('revolut-beneficiary-registry');
  evidence.payout_reconciliation.statement_completeness_evidence =
    evidenceRef('revolut-statement-completeness');
  evidence.payout_reconciliation.incident_resolution_status =
    'maker_checker_verified';
  evidence.payout_reconciliation.incident_resolution_evidence =
    evidenceRef('revolut-incident-resolution');
  evidence.payout_reconciliation.legacy_provider_crons_status =
    'inactive';
  evidence.payout_reconciliation.legacy_provider_crons_evidence =
    evidenceRef('legacy-provider-crons-inactive');
  evidence.quality = {
    partners_ci_run_evidence: evidenceRef('partners-ci'),
    security_advisors_passed: true,
    performance_advisors_passed: true,
    offsite_backup_evidence: evidenceRef('offsite-backup'),
    offsite_backup_encrypted: true,
    restore_drill_evidence: evidenceRef('restore-drill'),
    restore_verifier_passed: true,
  };
  evidence.runtime = {
    worker_cron_evidence: evidenceRef('worker-cron'),
    shadow_observation: {
      started_at: '2026-07-28T08:00:00Z',
      completed_at: '2026-07-30T07:00:00Z',
      clean: true,
      evidence: evidenceRef('shadow-observation'),
    },
    pilot_observation: {
      started_at: null,
      completed_at: null,
      observed_days: 0,
      evidence: null,
    },
    alert_and_recovery_evidence: evidenceRef('alert-recovery'),
  };
  for (const approver of ['legal', 'risk', 'finance', 'operations']) {
    evidence.approvals[approver] = {
      approved: true,
      evidence: evidenceRef(`${approver}-approval`, {
        verified_at: '2026-07-30T08:01:00Z',
      }),
    };
  }
  return evidence;
}

function generalizationEvidence() {
  const evidence = readyEvidence();
  evidence.status = 'generalization_ready';
  evidence.legal.privacy_public_release_review_evidence = evidenceRef(
    'privacy-public-release-review',
    { verified_at: '2026-07-30T08:01:30Z' },
  );
  evidence.release_gates.general_release_approved = true;
  evidence.release_gates.general_release_evidence =
    evidenceRef('general-release-approval', {
      verified_at: '2026-07-30T08:02:00Z',
    });
  evidence.runtime.pilot_observation = {
    started_at: '2026-06-01T08:00:00Z',
    completed_at: '2026-07-16T08:00:00Z',
    observed_days: 45,
    evidence: evidenceRef('pilot-45-day-observation'),
  };
  const periods = [
    ['2026-06-01T08:00:00Z', '2026-06-20T08:00:00Z'],
    ['2026-06-21T08:00:00Z', '2026-07-15T08:00:00Z'],
  ];
  evidence.payout_cycles.forEach((cycle, index) => {
    cycle.status = 'supervised_and_reconciled';
    cycle.period_started_at = periods[index][0];
    cycle.period_completed_at = periods[index][1];
    cycle.reconciliation_evidence =
      evidenceRef(`payout-cycle-${cycle.sequence}`);
  });
  return evidence;
}

test('the committed release evidence template is valid and fail-closed', () => {
  assert.doesNotThrow(() => validateEvidence(template));
  const result = evaluateEvidence(template);
  assert.ok(result.pilotBlockers.length > 0);
  assert.ok(result.pilotBlockers.includes('candidate_commit_not_recorded'));
  assert.ok(result.pilotBlockers.includes('deployment_not_recorded'));
  assert.ok(result.pilotBlockers.includes('no_jurisdiction_configured'));
  assert.ok(result.pilotBlockers.includes('provider_didit_not_verified'));
  assert.equal(template.repository, 'Admin-Adher/Norva');
  assert.equal(template.target_environment, 'sandbox');
  assert.equal(template.feature_flags.partners_payouts_live, false);
  assert.equal(template.feature_flags.partners_revolut_api_enabled, false);
  assert.equal(template.feature_flags.partners_cash_pilot_allowlist_only, true);
  assert.equal(template.feature_flags.partners_earnings_enabled, false);
  assert.equal(template.feature_flags.partners_credit_redemptions_enabled, false);
  assert.equal(template.contains_personal_data, false);
  assert.equal(template.providers.didit.config_fingerprint_sha256, null);
  assert.equal(template.providers.didit.workflow_version, null);
  assert.equal(template.providers.didit.environment_isolation_evidence, null);
  assert.equal(template.schema_version, 8);
  assert.equal(
    template.legal.privacy_pilot_self_assessment_evidence,
    null,
  );
  assert.equal(
    template.legal.privacy_public_release_review_evidence,
    null,
  );
});

test('legacy free-text evidence journals are rejected', () => {
  const legacy = clone(template);
  legacy.schema_version = 1;
  assert.throws(
    () => validateEvidence(legacy),
    /schema_version must equal 8/,
  );
});

test('pilot readiness requires traceability, live Didit and runtime proof', () => {
  const evidence = readyEvidence();
  const result = evaluateEvidence(evidence);
  assert.deepEqual(result.pilotBlockers, []);
  assert.deepEqual(result.generalizationBlockers, [
    'general_release_not_approved',
    'payout_cycle_1_not_reconciled',
    'payout_cycle_2_not_reconciled',
    'payout_cycle_periods_overlap_or_unordered',
    'payout_cycles_outside_pilot_observation',
    'pilot_45_day_observation_not_proven',
    'privacy_public_release_review_missing',
  ]);
  assert.equal(evidence.feature_flags.partners_payouts_live, false);

  evidence.status = 'draft';
  evidence.providers.didit.environment = 'sandbox';
  evidence.providers.didit.live_evidence = null;
  assert.ok(
    evaluateEvidence(evidence).pilotBlockers.includes(
      'provider_didit_not_verified',
    ),
  );
});

test('pilot Didit proof is bound to a versioned config and environment isolation', () => {
  const scenarios = [
    [
      (evidence) => {
        evidence.providers.didit.config_fingerprint_sha256 = null;
      },
      'missing config fingerprint',
    ],
    [
      (evidence) => {
        evidence.providers.didit.workflow_version = null;
      },
      'missing workflow version',
    ],
    [
      (evidence) => {
        evidence.providers.didit.environment_isolation_evidence = null;
      },
      'missing environment isolation evidence',
    ],
  ];
  for (const [mutate, label] of scenarios) {
    const evidence = readyEvidence();
    evidence.status = 'draft';
    mutate(evidence);
    assert.ok(
      evaluateEvidence(evidence).pilotBlockers.includes(
        'provider_didit_not_verified',
      ),
      label,
    );
  }

  const reused = readyEvidence();
  reused.status = 'draft';
  reused.providers.didit.environment_isolation_evidence =
    clone(reused.providers.didit.live_evidence);
  assert.throws(
    () => validateEvidence(reused),
    /environment-isolation evidence must use distinct/,
  );
});

test('generalization requires ordered non-overlapping reconciled cycles', () => {
  const evidence = generalizationEvidence();
  assert.deepEqual(evaluateEvidence(evidence).generalizationBlockers, []);

  evidence.status = 'draft';
  evidence.payout_cycles[1].period_started_at =
    evidence.payout_cycles[0].period_completed_at;
  assert.ok(
    evaluateEvidence(evidence).generalizationBlockers.includes(
      'payout_cycle_periods_overlap_or_unordered',
    ),
  );
});

test('the pilot self-assessment cannot authorize public generalization', () => {
  const evidence = generalizationEvidence();
  evidence.status = 'draft';
  evidence.legal.privacy_public_release_review_evidence = null;
  const blockers = evaluateEvidence(evidence).generalizationBlockers;
  assert.ok(blockers.includes('privacy_public_release_review_missing'));

  evidence.legal.privacy_public_release_review_evidence = evidenceRef(
    'privacy-public-review-too-early',
    { verified_at: '2026-06-10T08:00:00Z' },
  );
  assert.ok(
    evaluateEvidence(evidence).generalizationBlockers.includes(
      'privacy_public_release_review_predates_pilot_evidence',
    ),
  );
});

test('generalization payout cycles must occur inside the observed pilot', () => {
  const evidence = generalizationEvidence();
  evidence.status = 'draft';
  evidence.payout_cycles[0].period_started_at = '2026-05-01T00:00:00Z';
  evidence.payout_cycles[0].period_completed_at = '2026-05-10T00:00:00Z';
  evidence.payout_cycles[1].period_started_at = '2026-05-11T00:00:00Z';
  evidence.payout_cycles[1].period_completed_at = '2026-05-20T00:00:00Z';
  assert.ok(
    evaluateEvidence(evidence).generalizationBlockers.includes(
      'payout_cycles_outside_pilot_observation',
    ),
  );
});

test('calendar, future and elapsed-time claims are validated exactly', () => {
  const invalidCalendar = readyEvidence();
  invalidCalendar.status = 'draft';
  invalidCalendar.legal.public_surfaces.verified_at =
    '2026-02-30T08:00:00Z';
  assert.throws(() => validateEvidence(invalidCalendar), /valid ISO UTC/);

  const futureReference = readyEvidence();
  futureReference.status = 'draft';
  futureReference.providers.didit.live_evidence.verified_at =
    new Date(Date.now() + 6 * 60 * 1000).toISOString();
  assert.throws(
    () => validateEvidence(futureReference),
    /strict immutable evidence reference/,
  );

  const futureObservation = readyEvidence();
  futureObservation.status = 'draft';
  futureObservation.runtime.shadow_observation.completed_at =
    new Date(Date.now() + 60 * 1000).toISOString();
  assert.throws(
    () => validateEvidence(futureObservation),
    /start <= complete <= now/,
  );

  const falseDuration = generalizationEvidence();
  falseDuration.status = 'draft';
  falseDuration.runtime.pilot_observation.observed_days = 46;
  assert.throws(
    () => validateEvidence(falseDuration),
    /exactly match elapsed UTC days/,
  );
});

test('evidence must be verified after observation or payout completion', () => {
  const observation = readyEvidence();
  observation.status = 'draft';
  observation.runtime.shadow_observation.evidence.verified_at =
    '2026-07-29T08:00:00Z';
  assert.throws(
    () => validateEvidence(observation),
    /verified after completion/,
  );

  const cycle = generalizationEvidence();
  cycle.status = 'draft';
  cycle.payout_cycles[1].reconciliation_evidence.verified_at =
    '2026-07-14T08:00:00Z';
  assert.throws(
    () => validateEvidence(cycle),
    /evidence predates completion/,
  );
});

test('release approvals are causally newer than the evidence they approve', () => {
  const equalPilot = readyEvidence();
  equalPilot.status = 'draft';
  equalPilot.approvals.legal.evidence.verified_at =
    equalPilot.database_snapshot.evidence.verified_at;
  assert.ok(
    evaluateEvidence(equalPilot).pilotBlockers.includes(
      'legal_approval_predates_authoritative_evidence',
    ),
    'an approval timestamp equal to the latest authority proof is not later',
  );

  const oldPilot = readyEvidence();
  oldPilot.status = 'draft';
  oldPilot.approvals.risk.evidence.verified_at = '2026-07-29T08:00:00Z';
  assert.ok(
    evaluateEvidence(oldPilot).pilotBlockers.includes(
      'risk_approval_predates_authoritative_evidence',
    ),
    'an approval from before the final config/runtime proof must be stale',
  );

  const lateManualControl = readyEvidence();
  lateManualControl.status = 'draft';
  lateManualControl.payout_reconciliation
    .incident_resolution_evidence.verified_at = '2026-07-30T08:01:00Z';
  assert.ok(
    evaluateEvidence(lateManualControl).pilotBlockers.includes(
      'finance_approval_predates_authoritative_evidence',
    ),
    'Finance approval must be newer than the final manual incident drill',
  );

  const equalGeneral = generalizationEvidence();
  equalGeneral.status = 'draft';
  equalGeneral.release_gates.general_release_evidence.verified_at =
    equalGeneral.approvals.finance.evidence.verified_at;
  assert.ok(
    evaluateEvidence(equalGeneral).generalizationBlockers.includes(
      'general_release_approval_predates_pilot_or_payout_evidence',
    ),
    'general release approval must be strictly newer than pilot approvals',
  );

  const oldGeneral = generalizationEvidence();
  oldGeneral.status = 'draft';
  oldGeneral.release_gates.general_release_evidence.verified_at =
    '2026-07-15T08:00:00Z';
  assert.ok(
    evaluateEvidence(oldGeneral).generalizationBlockers.includes(
      'general_release_approval_predates_pilot_or_payout_evidence',
    ),
    'general release approval cannot predate pilot completion',
  );
});

test('release schema is recursively closed', () => {
  const top = clone(template);
  top.unexpected_note = false;
  assert.throws(() => validateEvidence(top), /evidence must contain exactly/);

  const nested = clone(template);
  nested.runtime.shadow_observation.manual_override = false;
  assert.throws(
    () => validateEvidence(nested),
    /runtime\.shadow_observation must contain exactly/,
  );

  const provider = clone(template);
  provider.providers.revenuecat.environment = 'sandbox';
  assert.throws(
    () => validateEvidence(provider),
    /providers\.revenuecat must contain exactly/,
  );
});

test('release evidence rejects expanded direct personal identifiers', () => {
  for (const key of [
    'name',
    'customer_email',
    'phone_number',
    'date_of_birth',
    'iban',
    'account_number',
    'payment_id',
    'provider_session_id',
    'ip_address',
    'street',
    'location',
  ]) {
    const evidence = clone(template);
    evidence[key] = key === 'customer_email'
      ? 'person@example.com'
      : 'sensitive';
    assert.throws(
      () => validateEvidence(evidence),
      /forbidden evidence key|email-like value/,
      key,
    );
  }
});

test('only assigned ISO country and currency codes are accepted', () => {
  const invalidCountry = readyEvidence();
  invalidCountry.status = 'draft';
  invalidCountry.jurisdictions[0].country_code = 'ZZ';
  assert.throws(
    () => validateEvidence(invalidCountry),
    /ISO 3166-1/,
  );

  for (const currency of ['ZZZ', 'XXX', 'XTS', 'XAU']) {
    const invalidCurrency = readyEvidence();
    invalidCurrency.status = 'draft';
    invalidCurrency.jurisdictions[0].payout_currencies = [currency];
    assert.throws(
      () => validateEvidence(invalidCurrency),
      /ISO 4217 tender payout currency/,
      currency,
    );
  }
});

test('evidence URLs and run IDs reject private infrastructure and traversal', () => {
  for (const url of [
    'https://10.0.0.1/proof.json',
    'https://169.254.169.254/latest/meta-data',
    'https://metadata.google.internal/computeMetadata/v1',
    'https://instance-data.ec2.internal/latest',
    'https://service.internal/proof.json',
    'https://metadata.google.internal./computeMetadata/v1',
    'https://[fd00::1]/proof.json',
    'https://[fe80::1]/proof.json',
    'https://[::ffff:10.0.0.1]/proof.json',
  ]) {
    const evidence = readyEvidence();
    evidence.status = 'draft';
    evidence.providers.didit.live_evidence.url = url;
    assert.throws(
      () => validateEvidence(evidence),
      /strict immutable evidence reference|IP-like value/,
      url,
    );
  }

  for (const runId of [
    'ops:release/../secret',
    'ops:release//proof-20260730',
    'ops:release\\proof-20260730',
  ]) {
    const evidence = readyEvidence();
    evidence.status = 'draft';
    evidence.providers.didit.live_evidence.run_id = runId;
    assert.throws(
      () => validateEvidence(evidence),
      /strict immutable evidence reference/,
      runId,
    );
  }
});

test('critical gates cannot reuse evidence and approvals/cycles are independent', () => {
  const globalReuse = readyEvidence();
  globalReuse.status = 'draft';
  globalReuse.app_links.android_phone.evidence =
    clone(globalReuse.database_snapshot.evidence);
  assert.throws(
    () => validateEvidence(globalReuse),
    /must not be reused across gates/,
  );

  const approvalReuse = readyEvidence();
  approvalReuse.status = 'draft';
  approvalReuse.approvals.risk.evidence.run_id =
    approvalReuse.approvals.legal.evidence.run_id;
  assert.throws(
    () => validateEvidence(approvalReuse),
    /approval evidence must use distinct run_id/,
  );

  const cycleReuse = generalizationEvidence();
  cycleReuse.status = 'draft';
  cycleReuse.payout_cycles[1].reconciliation_evidence.sha256 =
    cycleReuse.payout_cycles[0].reconciliation_evidence.sha256;
  assert.throws(
    () => validateEvidence(cycleReuse),
    /payout cycle evidence must use distinct sha256/,
  );
});

test('pilot readiness gates Play App Links, DB snapshot, TV, statement and incidents', () => {
  const scenarios = [
    [
      (evidence) => {
        evidence.app_links.android_phone.status = 'not_verified';
        evidence.app_links.android_phone.play_signed_aab = false;
        evidence.app_links.android_phone.evidence = null;
      },
      'play_signed_app_link_not_verified',
    ],
    [
      (evidence) => {
        evidence.database_snapshot.status = 'not_captured';
        evidence.database_snapshot.evidence = null;
      },
      'database_configuration_snapshot_not_verified',
    ],
    [
      (evidence) => {
        evidence.feature_flags.partners_cash_pilot_allowlist_only = false;
      },
      'partners_cash_pilot_allowlist_not_enabled',
    ],
    [
      (evidence) => {
        evidence.feature_flags.partners_earnings_enabled = false;
      },
      'partners_earnings_not_enabled',
    ],
    [
      (evidence) => {
        evidence.feature_flags.partners_credit_redemptions_enabled = false;
      },
      'partners_credit_redemptions_not_enabled',
    ],
    [
      (evidence) => {
        evidence.feature_flags.partners_tv_relay_enabled = false;
      },
      'partners_tv_relay_not_enabled',
    ],
    [
      (evidence) => {
        evidence.providers.individual_payout.provider = null;
        evidence.providers.individual_payout.execution_adapter = null;
        evidence.providers.individual_payout.status = 'not_selected';
        evidence.providers.individual_payout.production_evidence = null;
      },
      'provider_individual_payout_not_verified',
    ],
    [
      (evidence) => {
        evidence.payout_reconciliation.statement_status =
          'not_verified';
        evidence.payout_reconciliation.provider = null;
        evidence.payout_reconciliation.execution_adapter = null;
        evidence.payout_reconciliation.contract_version = null;
        evidence.payout_reconciliation.reference_contract = null;
        evidence.payout_reconciliation
          .statement_completeness_evidence = null;
        evidence.payout_reconciliation.incident_resolution_status =
          'not_verified';
        evidence.payout_reconciliation.incident_resolution_evidence = null;
      },
      'revolut_manual_statement_import_not_verified',
    ],
    [
      (evidence) => {
        evidence.feature_flags.partners_revolut_api_enabled = true;
      },
      'partners_revolut_api_must_remain_false',
    ],
    [
      (evidence) => {
        evidence.payout_reconciliation.manual_route_status = 'not_verified';
      },
      'revolut_manual_route_not_verified',
    ],
    [
      (evidence) => {
        evidence.payout_reconciliation.revolut_api_adapter_verified = true;
      },
      'revolut_api_adapter_gate_must_remain_false',
    ],
    [
      (evidence) => {
        evidence.payout_reconciliation.revolut_api_edge_enabled = true;
      },
      'revolut_api_edge_kill_switch_must_remain_false',
    ],
    [
      (evidence) => {
        evidence.payout_reconciliation.incident_resolution_status =
          'not_verified';
        evidence.payout_reconciliation.incident_resolution_evidence = null;
      },
      'revolut_manual_incident_resolution_not_verified',
    ],
    [
      (evidence) => {
        evidence.payout_reconciliation.legacy_provider_crons_status =
          'not_verified';
        evidence.payout_reconciliation.legacy_provider_crons_evidence = null;
      },
      'legacy_provider_payout_crons_not_disabled',
    ],
  ];
  for (const [mutate, blocker] of scenarios) {
    const evidence = readyEvidence();
    evidence.status = 'draft';
    mutate(evidence);
    assert.ok(evaluateEvidence(evidence).pilotBlockers.includes(blocker));
  }
});

test('payout evidence pins Revolut manual, references and beneficiary registry', () => {
  const unsupportedProvider = readyEvidence();
  unsupportedProvider.status = 'draft';
  unsupportedProvider.providers.individual_payout.provider = 'wise';
  assert.throws(
    () => validateEvidence(unsupportedProvider),
    /individual payout provider must be null or revolut/,
  );

  const apiAdapter = readyEvidence();
  apiAdapter.status = 'draft';
  apiAdapter.providers.individual_payout.execution_adapter = 'revolut_api';
  assert.throws(
    () => validateEvidence(apiAdapter),
    /execution_adapter must be null or revolut_manual/,
  );

  const missingContract = readyEvidence();
  missingContract.status = 'draft';
  missingContract.payout_reconciliation.contract_version = null;
  assert.throws(
    () => validateEvidence(missingContract),
    /reconciled statement must use the Revolut manual and Norva reference contracts/,
  );

  const missingReferenceContract = readyEvidence();
  missingReferenceContract.status = 'draft';
  missingReferenceContract.payout_reconciliation.reference_contract = null;
  assert.throws(
    () => validateEvidence(missingReferenceContract),
    /reconciled statement must use the Revolut manual and Norva reference contracts/,
  );

  const mismatchedProvider = readyEvidence();
  mismatchedProvider.status = 'draft';
  mismatchedProvider.payout_reconciliation.provider = null;
  assert.throws(
    () => validateEvidence(mismatchedProvider),
    /reconciled statement must use the Revolut manual and Norva reference contracts/,
  );

  const missingBindingEvidence = readyEvidence();
  missingBindingEvidence.status = 'draft';
  missingBindingEvidence.payout_reconciliation
    .beneficiary_registry_evidence = null;
  assert.throws(
    () => validateEvidence(missingBindingEvidence),
    /verified beneficiary registry requires its contract, HMAC version and evidence/,
  );

  const unverifiedBinding = readyEvidence();
  unverifiedBinding.status = 'draft';
  unverifiedBinding.payout_reconciliation.beneficiary_registry_status =
    'not_verified';
  assert.ok(
    evaluateEvidence(unverifiedBinding).pilotBlockers.includes(
      'revolut_manual_statement_import_not_verified',
    ),
  );

  const missingIncidentEvidence = readyEvidence();
  missingIncidentEvidence.status = 'draft';
  missingIncidentEvidence.payout_reconciliation
    .incident_resolution_evidence = null;
  assert.throws(
    () => validateEvidence(missingIncidentEvidence),
    /verified Revolut incident resolution requires the manual v2 contract and evidence/,
  );
});

test('candidate commit and deployment traceability are fail-closed', () => {
  const missingCommit = readyEvidence();
  missingCommit.status = 'draft';
  missingCommit.candidate_commit_sha = null;
  assert.ok(
    evaluateEvidence(missingCommit).pilotBlockers.includes(
      'candidate_commit_not_recorded',
    ),
  );

  const placeholderDeploy = readyEvidence();
  placeholderDeploy.status = 'draft';
  placeholderDeploy.deployment_id = 'replace-me-deployment';
  assert.throws(
    () => validateEvidence(placeholderDeploy),
    /deployment_id/,
  );
});

test('CLI parsing is strict, exclusive and commit-bound', () => {
  const commit = sha256('candidate').slice(0, 40);
  assert.deepEqual(
    parseCliArgs([
      'journal.json',
      '--require-pilot-ready',
      `--expected-commit-sha=${commit}`,
    ]),
    {
      file: 'journal.json',
      requirePilot: true,
      requireGeneralization: false,
      expectedCommitSha: commit,
    },
  );
  assert.equal(
    parseCliArgs([
      '--expected-commit-sha',
      commit,
      'journal.json',
    ]).expectedCommitSha,
    commit,
  );
  for (const args of [
    [],
    ['one.json', 'two.json'],
    ['journal.json', '--require-pilot-ready=1'],
    ['journal.json', '--require-pilot-ready', '--require-generalization-ready'],
    ['journal.json', '--expected-commit-sha'],
    ['journal.json', '--expected-commit-sha=ABC'],
    [
      'journal.json',
      `--expected-commit-sha=${commit}`,
      '--expected-commit-sha',
      commit,
    ],
  ]) {
    assert.throws(() => parseCliArgs(args), undefined, args.join(' '));
  }
});

test('CLI subprocess rejects typos and mismatched commits without leaking journal', () => {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'norva-partners-release-'),
  );
  const journal = path.join(temporaryDirectory, 'journal.json');
  const evidence = readyEvidence();
  fs.writeFileSync(journal, JSON.stringify(evidence), { mode: 0o600 });
  try {
    const matching = spawnSync(process.execPath, [
      validatorPath,
      journal,
      '--require-pilot-ready',
      `--expected-commit-sha=${evidence.candidate_commit_sha}`,
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(matching.status, 0, matching.stderr);

    evidence.status = 'draft';
    fs.writeFileSync(journal, JSON.stringify(evidence), { mode: 0o600 });
    const draftPilot = spawnSync(process.execPath, [
      validatorPath,
      journal,
      '--require-pilot-ready',
      `--expected-commit-sha=${evidence.candidate_commit_sha}`,
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(draftPilot.status, 1);
    assert.match(
      draftPilot.stderr,
      /--require-pilot-ready requires status=pilot_ready/,
    );

    const generalization = generalizationEvidence();
    fs.writeFileSync(journal, JSON.stringify(generalization), { mode: 0o600 });
    const matchingGeneralization = spawnSync(process.execPath, [
      validatorPath,
      journal,
      '--require-generalization-ready',
      `--expected-commit-sha=${generalization.candidate_commit_sha}`,
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(
      matchingGeneralization.status,
      0,
      matchingGeneralization.stderr,
    );

    generalization.status = 'pilot_ready';
    fs.writeFileSync(journal, JSON.stringify(generalization), { mode: 0o600 });
    const pilotGeneralization = spawnSync(process.execPath, [
      validatorPath,
      journal,
      '--require-generalization-ready',
      `--expected-commit-sha=${generalization.candidate_commit_sha}`,
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(pilotGeneralization.status, 1);
    assert.match(
      pilotGeneralization.stderr,
      /--require-generalization-ready requires status=generalization_ready/,
    );

    evidence.status = 'pilot_ready';
    fs.writeFileSync(journal, JSON.stringify(evidence), { mode: 0o600 });
    const mismatched = spawnSync(process.execPath, [
      validatorPath,
      journal,
      `--expected-commit-sha=${'b'.repeat(40)}`,
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(mismatched.status, 1);
    assert.match(mismatched.stderr, /does not match/);
    assert.doesNotMatch(mismatched.stderr, /privacy-review|didit-live/);

    const typo = spawnSync(process.execPath, [
      validatorPath,
      journal,
      '--require-pilot-ready=1',
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(typo.status, 1);
    assert.match(typo.stderr, /unknown option/);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
