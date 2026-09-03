'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  MISSING_PROOFS,
  RUNTIME_PATHS,
  canonicalize,
  validateEvidence,
  validateEvidenceFile,
} = require('../scripts/validate-behavioral-lifecycle-dormant-evidence.js');

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function validEvidence(targetEnvironment = 'staging') {
  const services = targetEnvironment === 'production' ? ['functions', 'functions2'] : ['functions'];
  const sourceDigests = Object.fromEntries(
    RUNTIME_PATHS.map((runtimePath) => [
      runtimePath,
      Object.fromEntries(services.map((service) => [service, DIGEST_A])),
    ]),
  );
  return {
    schema_version: 2,
    artifact_type: 'norva_behavioral_lifecycle_dormant_installation',
    evidence_scope: 'dormant_installation_only',
    captured_at: '2026-09-03T12:00:00Z',
    target_environment: targetEnvironment,
    deployment_id: `${targetEnvironment}:release-20260903`,
    repository: 'Admin-Adher/Norva',
    server_checkout_sha: 'c'.repeat(40),
    contains_personal_data: false,
    contains_secrets: false,
    migration_sha256s: {
      engine_v1: DIGEST_B,
      import_readiness_append_only: DIGEST_A,
    },
    database_read_only_gate: {
      status: 'BEHAVIORAL_LIFECYCLE_PRE_ACTIVATION_READY',
      relations: 10,
      rpcs: 15,
      triggers: 12,
      journeys: 4,
      steps: 11,
      emergency_stop: true,
      audience_mode: 'internal_test',
      projected_accounts: 129,
    },
    edge_runtime: {
      replica_count: services.length,
      replicas: services.map((service, index) => ({
        service,
        running: true,
        health: 'healthy',
        image_id_sha256: `${index + 1}`.repeat(64),
        container_id_fingerprint_sha256: `${index + 3}`.repeat(64),
        started_at: '2026-09-03T11:55:00Z',
      })),
      source_digests_by_replica: sourceDigests,
      source_parity: true,
    },
    release_assertion: {
      pilot_eligible: false,
      reason: 'dormant_installation_configuration_only',
      missing_required_proofs: [...MISSING_PROOFS],
    },
  };
}

test('dormant evidence validator accepts staging and multi-replica production proofs', () => {
  assert.equal(validateEvidence(validEvidence('staging')).target_environment, 'staging');
  assert.equal(validateEvidence(validEvidence('production')).edge_runtime.replica_count, 2);
});

test('dormant evidence validator rejects privilege escalation, leakage and parity tampering', () => {
  const cases = [
    ['pilot eligibility', (value) => { value.release_assertion.pilot_eligible = true; }],
    ['unexpected PII key', (value) => { value.email = 'user@example.test'; }],
    ['open runtime', (value) => { value.database_read_only_gate.emergency_stop = false; }],
    ['missing shared source', (value) => { delete value.edge_runtime.source_digests_by_replica['_shared/fcm.ts']; }],
    ['replica source drift', (value) => {
      value.target_environment = 'production';
      value.deployment_id = 'production:release-20260903';
      value.edge_runtime.replicas.push({
        ...value.edge_runtime.replicas[0],
        service: 'functions2',
        image_id_sha256: '2'.repeat(64),
        container_id_fingerprint_sha256: '4'.repeat(64),
      });
      value.edge_runtime.replica_count = 2;
      for (const runtimePath of RUNTIME_PATHS) {
        value.edge_runtime.source_digests_by_replica[runtimePath].functions2 = DIGEST_A;
      }
      value.edge_runtime.source_digests_by_replica['norva-lifecycle/index.ts'].functions2 = DIGEST_B;
    }],
    ['incomplete release gates', (value) => { value.release_assertion.missing_required_proofs.pop(); }],
  ];

  for (const [label, mutate] of cases) {
    const value = validEvidence('staging');
    mutate(value);
    assert.throws(() => validateEvidence(value), undefined, label);
  }
});

test('dormant evidence file validation requires canonical immutable bytes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'norva-lifecycle-evidence-'));
  const validPath = path.join(directory, 'valid.json');
  const nonCanonicalPath = path.join(directory, 'non-canonical.json');
  try {
    const evidence = validEvidence('staging');
    const canonical = `${JSON.stringify(canonicalize(evidence), null, 2)}\n`;
    fs.writeFileSync(validPath, canonical, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.writeFileSync(nonCanonicalPath, JSON.stringify(evidence), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.chmodSync(validPath, 0o600);
    fs.chmodSync(nonCanonicalPath, 0o600);

    assert.equal(validateEvidenceFile(validPath).targetEnvironment, 'staging');
    assert.throws(
      () => validateEvidenceFile(nonCanonicalPath),
      /canonical JSON encoding/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
