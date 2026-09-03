'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{7,199}$/;
const MAX_ARTIFACT_BYTES = 512 * 1024;
const RATE_TOLERANCE = 0.01;
const DAY_MS = 24 * 60 * 60 * 1000;

const REQUIRED_PROOFS = [
  'real_schema_and_data_staging_scenarios',
  'internal_fcm_delivery_and_open',
  'internal_email_delivery_and_unsubscribe',
  'physical_android_permission_deep_link_and_receipts',
  'hetzner_firebase_ga4_reconciliation',
  'authorized_ten_percent_pilot',
  'mature_j7_and_j14_outcomes',
];

const PRIORITY_JOURNEYS = Object.freeze({
  no_source: 'source_attempted',
  import_unresolved: 'import_success',
  catalog_ready_no_first_play: 'first_play',
});

const TOP_LEVEL_KEYS = [
  'schema_version',
  'artifact_type',
  'evidence_scope',
  'captured_at',
  'repository',
  'production_commit',
  'deployment_id',
  'contains_personal_data',
  'contains_secrets',
  'dormant_evidence_sha256',
  'required_proofs',
  'reconciliation',
  'pilot',
  'safety',
  'priority_journey_outcomes',
  'release_assertion',
];

const PROOF_KEYS = ['status', 'observed_at', 'artifact_id', 'artifact_sha256'];
const RECONCILIATION_KEYS = [
  'canonical_ledger',
  'canonical_lifecycle_event_count',
  'canonical_lifecycle_events_complete',
  'ga4_reconciliation_mode',
  'mapped_client_milestones_complete',
  'unexplained_material_differences',
  'contains_personal_data',
];
const PILOT_KEYS = [
  'rollout_percent',
  'holdout_percent',
  'countries',
  'internal_accounts_excluded',
  'started_at',
  'ended_at',
  'authorization_artifact_sha256',
  'emergency_stop_tested',
  'rollback_tested',
];
const SAFETY_KEYS = [
  'duplicate_sends',
  'post_conversion_sends',
  'pii_leaks',
  'consent_violations',
  'frequency_cap_violations',
  'quiet_hours_violations',
  'unsubscribe_rate_delta_pp',
  'provider_rejection_rate_delta_pp',
];
const OUTCOME_KEYS = [
  'journey_key',
  'primary_metric',
  'window_hours',
  'treatment_assigned',
  'treatment_converted',
  'holdout_assigned',
  'holdout_converted',
  'treatment_rate_pct',
  'holdout_rate_pct',
  'absolute_lift_pp',
  'relative_uplift_pct',
  'sample_mature',
  'analysis_complete',
  'measurable_gain',
];
const RELEASE_KEYS = [
  'completion_claim_validated',
  'reason',
  'missing_required_proofs',
  'does_not_authorize_deployment_activation_or_messages',
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertExactKeys(value, expected, trail) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${trail} must be an object`);
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  assert(
    actualKeys.length === expectedKeys.length
      && actualKeys.every((key, index) => key === expectedKeys[index]),
    `${trail} must contain exactly: ${expectedKeys.join(', ')}`,
  );
}

function assertIsoTimestamp(value, trail) {
  assert(
    typeof value === 'string'
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value),
    `${trail} must be UTC ISO-8601`,
  );
  assert(Number.isFinite(Date.parse(value)), `${trail} must be a real timestamp`);
}

function assertNonNegativeInteger(value, trail) {
  assert(Number.isSafeInteger(value) && value >= 0, `${trail} must be a non-negative integer`);
}

function assertFiniteRate(value, trail) {
  assert(Number.isFinite(value) && value >= -100 && value <= 100, `${trail} must be between -100 and 100`);
}

function assertRateMatches(actual, expected, trail) {
  assert(Number.isFinite(actual), `${trail} must be finite`);
  assert(Math.abs(actual - expected) <= RATE_TOLERANCE, `${trail} does not match its counts`);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

function validateArtifactId(value, trail) {
  assert(
    typeof value === 'string'
      && ARTIFACT_ID.test(value)
      && !value.includes('..')
      && !value.includes('//'),
    `${trail} is invalid`,
  );
}

function validateCompletionEvidence(value) {
  assertExactKeys(value, TOP_LEVEL_KEYS, 'artifact');
  assert(value.schema_version === 1, 'schema_version must be 1');
  assert(value.artifact_type === 'norva_behavioral_lifecycle_completion_claim', 'artifact_type is invalid');
  assert(value.evidence_scope === 'verification_only_no_action_authority', 'evidence_scope is invalid');
  assertIsoTimestamp(value.captured_at, 'captured_at');
  assert(value.repository === 'Admin-Adher/Norva', 'repository is invalid');
  assert(COMMIT_SHA.test(value.production_commit), 'production_commit is invalid');
  validateArtifactId(value.deployment_id, 'deployment_id');
  assert(value.contains_personal_data === false, 'artifact must declare no personal data');
  assert(value.contains_secrets === false, 'artifact must declare no secrets');
  assert(SHA256.test(value.dormant_evidence_sha256), 'dormant_evidence_sha256 is invalid');

  const capturedAt = Date.parse(value.captured_at);
  assertExactKeys(value.required_proofs, REQUIRED_PROOFS, 'required_proofs');
  const proofTimes = {};
  for (const proofName of REQUIRED_PROOFS) {
    const proof = value.required_proofs[proofName];
    const trail = `required_proofs.${proofName}`;
    assertExactKeys(proof, PROOF_KEYS, trail);
    assert(proof.status === 'passed', `${trail}.status must be passed`);
    assertIsoTimestamp(proof.observed_at, `${trail}.observed_at`);
    proofTimes[proofName] = Date.parse(proof.observed_at);
    assert(proofTimes[proofName] <= capturedAt, `${trail} cannot postdate captured_at`);
    validateArtifactId(proof.artifact_id, `${trail}.artifact_id`);
    assert(SHA256.test(proof.artifact_sha256), `${trail}.artifact_sha256 is invalid`);
  }

  const reconciliation = value.reconciliation;
  assertExactKeys(reconciliation, RECONCILIATION_KEYS, 'reconciliation');
  assert(reconciliation.canonical_ledger === 'hetzner_postgresql', 'Hetzner must remain canonical');
  assert(reconciliation.canonical_lifecycle_event_count === 16, 'all 16 canonical events are required');
  assert(reconciliation.canonical_lifecycle_events_complete === true, 'canonical lifecycle events must be complete');
  assert(
    reconciliation.ga4_reconciliation_mode === 'semantic_product_event_mapping',
    'GA4 reconciliation must use the documented semantic mapping',
  );
  assert(reconciliation.mapped_client_milestones_complete === true, 'mapped client milestones must be complete');
  assert(
    reconciliation.unexplained_material_differences === 0,
    'reconciliation cannot contain unexplained material differences',
  );
  assert(reconciliation.contains_personal_data === false, 'reconciliation must not contain personal data');

  const pilot = value.pilot;
  assertExactKeys(pilot, PILOT_KEYS, 'pilot');
  assert(pilot.rollout_percent === 10, 'initial pilot rollout must be 10 percent');
  assert(pilot.holdout_percent === 10, 'permanent holdout must be 10 percent');
  assert(
    Array.isArray(pilot.countries)
      && pilot.countries.length > 0
      && pilot.countries.every((country, index) => ['BD', 'IN'].includes(country)
        && (index === 0 || pilot.countries[index - 1] < country)),
    'pilot countries must be a unique sorted subset of BD and IN',
  );
  assert(pilot.internal_accounts_excluded === true, 'pilot must exclude internal accounts');
  assertIsoTimestamp(pilot.started_at, 'pilot.started_at');
  assertIsoTimestamp(pilot.ended_at, 'pilot.ended_at');
  const pilotStartedAt = Date.parse(pilot.started_at);
  const pilotEndedAt = Date.parse(pilot.ended_at);
  assert(pilotStartedAt < pilotEndedAt, 'pilot must end after it starts');
  assert(pilotEndedAt - pilotStartedAt >= 14 * DAY_MS, 'pilot must include a mature J+14 window');
  assert(pilotEndedAt <= capturedAt, 'pilot cannot end after captured_at');
  assert(SHA256.test(pilot.authorization_artifact_sha256), 'pilot authorization artifact is invalid');
  assert(pilot.emergency_stop_tested === true, 'emergency stop must be tested');
  assert(pilot.rollback_tested === true, 'rollback must be tested');

  const prerequisiteProofs = REQUIRED_PROOFS.slice(0, 6);
  for (const proofName of prerequisiteProofs) {
    assert(proofTimes[proofName] <= pilotStartedAt, `${proofName} must be proven before the pilot starts`);
  }
  assert(
    proofTimes.mature_j7_and_j14_outcomes >= pilotEndedAt,
    'mature J+7/J+14 outcomes must be observed after the pilot window',
  );

  const safety = value.safety;
  assertExactKeys(safety, SAFETY_KEYS, 'safety');
  for (const key of [
    'duplicate_sends',
    'post_conversion_sends',
    'pii_leaks',
    'consent_violations',
    'frequency_cap_violations',
    'quiet_hours_violations',
  ]) {
    assert(safety[key] === 0, `safety.${key} must be zero`);
  }
  assertFiniteRate(safety.unsubscribe_rate_delta_pp, 'safety.unsubscribe_rate_delta_pp');
  assertFiniteRate(safety.provider_rejection_rate_delta_pp, 'safety.provider_rejection_rate_delta_pp');
  assert(safety.unsubscribe_rate_delta_pp <= 0.5, 'unsubscribe rate increase exceeds 0.5 point');
  assert(safety.provider_rejection_rate_delta_pp <= 0.5, 'provider rejection rate increase exceeds 0.5 point');

  assert(
    Array.isArray(value.priority_journey_outcomes)
      && value.priority_journey_outcomes.length === Object.keys(PRIORITY_JOURNEYS).length,
    'priority_journey_outcomes must contain the three priority journeys',
  );
  const seenJourneys = new Set();
  for (const [index, outcome] of value.priority_journey_outcomes.entries()) {
    const trail = `priority_journey_outcomes[${index}]`;
    assertExactKeys(outcome, OUTCOME_KEYS, trail);
    assert(Object.hasOwn(PRIORITY_JOURNEYS, outcome.journey_key), `${trail}.journey_key is invalid`);
    assert(!seenJourneys.has(outcome.journey_key), `${trail}.journey_key is duplicated`);
    seenJourneys.add(outcome.journey_key);
    assert(
      outcome.primary_metric === PRIORITY_JOURNEYS[outcome.journey_key],
      `${trail}.primary_metric is invalid`,
    );
    assert(outcome.window_hours === 72, `${trail}.window_hours must be 72`);
    for (const key of ['treatment_assigned', 'treatment_converted', 'holdout_assigned', 'holdout_converted']) {
      assertNonNegativeInteger(outcome[key], `${trail}.${key}`);
    }
    assert(outcome.treatment_assigned > 0, `${trail}.treatment_assigned must be positive`);
    assert(outcome.holdout_assigned > 0, `${trail}.holdout_assigned must be positive`);
    assert(outcome.treatment_converted <= outcome.treatment_assigned, `${trail} treatment counts are invalid`);
    assert(outcome.holdout_converted <= outcome.holdout_assigned, `${trail} holdout counts are invalid`);

    const treatmentRate = (100 * outcome.treatment_converted) / outcome.treatment_assigned;
    const holdoutRate = (100 * outcome.holdout_converted) / outcome.holdout_assigned;
    const absoluteLift = treatmentRate - holdoutRate;
    assertRateMatches(outcome.treatment_rate_pct, treatmentRate, `${trail}.treatment_rate_pct`);
    assertRateMatches(outcome.holdout_rate_pct, holdoutRate, `${trail}.holdout_rate_pct`);
    assertRateMatches(outcome.absolute_lift_pp, absoluteLift, `${trail}.absolute_lift_pp`);

    if (holdoutRate === 0) {
      assert(outcome.relative_uplift_pct === null, `${trail}.relative_uplift_pct must be null for a zero holdout rate`);
    } else {
      const relativeUplift = (100 * absoluteLift) / holdoutRate;
      assertRateMatches(outcome.relative_uplift_pct, relativeUplift, `${trail}.relative_uplift_pct`);
    }
    assert(outcome.sample_mature === true, `${trail} sample must be mature`);
    assert(outcome.analysis_complete === true, `${trail} analysis must be complete`);
    assert(outcome.measurable_gain === true, `${trail} must declare a measurable gain`);
    assert(absoluteLift > 0, `${trail} must demonstrate a positive treatment lift`);
  }
  assert(
    Object.keys(PRIORITY_JOURNEYS).every((journey) => seenJourneys.has(journey)),
    'all priority journeys must be represented',
  );

  const release = value.release_assertion;
  assertExactKeys(release, RELEASE_KEYS, 'release_assertion');
  assert(release.completion_claim_validated === true, 'completion claim must be explicitly validated');
  assert(release.reason === 'all_required_evidence_verified', 'release reason is invalid');
  assert(
    Array.isArray(release.missing_required_proofs) && release.missing_required_proofs.length === 0,
    'missing_required_proofs must be empty',
  );
  assert(
    release.does_not_authorize_deployment_activation_or_messages === true,
    'evidence artifact must not grant action authority',
  );

  return value;
}

function validateCompletionEvidenceFile(filePath) {
  const resolved = path.resolve(filePath);
  const stat = fs.lstatSync(resolved);
  assert(stat.isFile() && !stat.isSymbolicLink(), 'evidence path must be a regular non-symlink file');
  assert(stat.size > 0 && stat.size <= MAX_ARTIFACT_BYTES, 'evidence file size is invalid');
  if (process.platform !== 'win32') {
    assert((stat.mode & 0o777) === 0o600, 'evidence file mode must be 600');
  }
  const bytes = fs.readFileSync(resolved);
  const text = bytes.toString('utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('evidence file must contain valid UTF-8 JSON');
  }
  const canonical = `${JSON.stringify(canonicalize(parsed), null, 2)}\n`;
  assert(text === canonical, 'evidence file must use the canonical JSON encoding');
  validateCompletionEvidence(parsed);
  return {
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    deploymentId: parsed.deployment_id,
    productionCommit: parsed.production_commit,
  };
}

if (require.main === module) {
  try {
    assert(
      process.argv.length === 3,
      'usage: node validate-behavioral-lifecycle-completion-evidence.js <artifact.json>',
    );
    const result = validateCompletionEvidenceFile(process.argv[2]);
    process.stdout.write('BEHAVIORAL_LIFECYCLE_COMPLETION_EVIDENCE_VALID=true\n');
    process.stdout.write(`BEHAVIORAL_LIFECYCLE_COMPLETION_EVIDENCE_SHA256=${result.sha256}\n`);
    process.stdout.write(`BEHAVIORAL_LIFECYCLE_DEPLOYMENT_ID=${result.deploymentId}\n`);
    process.stdout.write(`BEHAVIORAL_LIFECYCLE_PRODUCTION_COMMIT=${result.productionCommit}\n`);
    process.stdout.write('BEHAVIORAL_LIFECYCLE_ACTION_AUTHORITY=false\n');
  } catch (error) {
    process.stderr.write(`Behavioral lifecycle completion evidence validation failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  PRIORITY_JOURNEYS,
  REQUIRED_PROOFS,
  canonicalize,
  validateCompletionEvidence,
  validateCompletionEvidenceFile,
};
