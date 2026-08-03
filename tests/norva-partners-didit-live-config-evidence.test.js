'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  validateArtifact,
  parseCli,
} = require('../scripts/validate-partners-didit-live-config-evidence.js');

const root = path.resolve(__dirname, '..');
const captureScript = path.join(
  root,
  'ops',
  'hetzner',
  'scripts',
  'capture-norva-partners-didit-live-config-evidence.sh',
);
const validatorScript = path.join(
  root,
  'scripts',
  'validate-partners-didit-live-config-evidence.js',
);

function sha(seed) {
  return require('node:crypto').createHash('sha256').update(seed).digest('hex');
}

function isoAgo(milliseconds) {
  return new Date(Date.now() - milliseconds).toISOString().replace('.000Z', 'Z');
}

function artifact() {
  const commit = '94b43e7ca01b290c843d2c5759fc1c55f51dc993';
  return {
    schema_version: 1,
    artifact_type: 'norva_partners_didit_live_config_snapshot',
    evidence_scope: 'configuration_only',
    captured_at: isoAgo(60_000),
    repository: 'Admin-Adher/Norva',
    candidate_commit_sha: commit,
    server_checkout_sha: commit,
    deployment_id: 'hetzner:partners/94b43e7ca01b',
    target_environment: 'production',
    contains_personal_data: false,
    contains_secrets: false,
    provider: {
      name: 'didit',
      environment: 'live',
      workflow_type: 'kyc',
      workflow_status: 'published',
      workflow_version: 1,
      workflow_published_at: isoAgo(86_400_000),
      workflow_archived: false,
      features: ['FACE_MATCH', 'IP_ANALYSIS', 'LIVENESS', 'OCR'],
      kyb_enabled: false,
      aml_enabled: false,
      aml_ongoing_monitoring_enabled: false,
      callback_url: 'https://norva.tv/partners-kyc-return',
      session_expiration_seconds: 604800,
      config_fingerprint_sha256: sha('config'),
      workflow_config_sha256: sha('workflow'),
      workflow_id_sha256: sha('workflow-id'),
      application_id_sha256: sha('application-id'),
    },
    runtime: {
      edge_replicas: [
        {
          name: 'norva-edge-functions',
          running: true,
          health: 'healthy',
          image_id_sha256: sha('image-one'),
          started_at: isoAgo(7_200_000),
        },
        {
          name: 'norva-edge-functions-2',
          running: true,
          health: 'healthy',
          image_id_sha256: sha('image-two'),
          started_at: isoAgo(7_100_000),
        },
      ],
      replica_count: 2,
      configuration_parity: true,
      workflow_matches_management_api: true,
      callback_matches_management_api: true,
      session_expiration_matches_management_api: true,
      node_ids_distinct: true,
      management_api_http_status: 200,
      tracked_worktree_clean: false,
      tracked_worktree_change_count: 1,
    },
    release_assertion: {
      gate_eligible: false,
      reason: 'configuration_snapshot_only',
      missing_required_proofs: [
        'sandbox_non_authoritative_session',
        'live_signed_decision',
        'environment_and_fingerprint_quarantine',
      ],
    },
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('sanitized Didit configuration snapshot is strict and explicitly not gate evidence', () => {
  const value = artifact();
  assert.equal(validateArtifact(value), value);
  assert.equal(value.release_assertion.gate_eligible, false);
  assert.equal(value.evidence_scope, 'configuration_only');
  assert.deepEqual(value.release_assertion.missing_required_proofs, [
    'sandbox_non_authoritative_session',
    'live_signed_decision',
    'environment_and_fingerprint_quarantine',
  ]);
});

test('validator rejects attempts to promote configuration into a false release proof', () => {
  for (const mutate of [
    (value) => { value.release_assertion.gate_eligible = true; },
    (value) => { value.evidence_scope = 'live_decision'; },
    (value) => { value.release_assertion.missing_required_proofs.pop(); },
    (value) => { value.provider.workflow_status = 'draft'; },
    (value) => { value.provider.environment = 'sandbox'; },
  ]) {
    const value = clone(artifact());
    mutate(value);
    assert.throws(() => validateArtifact(value));
  }
});

test('validator rejects KYB, AML, missing decision coverage and runtime drift', () => {
  for (const mutate of [
    (value) => { value.provider.kyb_enabled = true; },
    (value) => { value.provider.aml_enabled = true; },
    (value) => { value.provider.features = ['OCR', 'LIVENESS']; },
    (value) => { value.runtime.configuration_parity = false; },
    (value) => { value.runtime.edge_replicas[1].health = 'unhealthy'; },
    (value) => { value.provider.session_expiration_seconds = 3600; },
  ]) {
    const value = clone(artifact());
    mutate(value);
    assert.throws(() => validateArtifact(value));
  }
});

test('schema is closed and candidate commit binding is exact', () => {
  const expanded = artifact();
  expanded.provider.api_key = 'must-never-appear';
  assert.throws(() => validateArtifact(expanded), /missing or unknown fields/);

  assert.throws(
    () => validateArtifact(artifact(), { expectedCommitSha: 'a'.repeat(40) }),
    /candidate commit does not match/,
  );
  assert.doesNotThrow(() => validateArtifact(artifact(), {
    expectedCommitSha: artifact().candidate_commit_sha,
  }));
});

test('CLI accepts one private artifact and never claims the gate is ready', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'norva-didit-evidence-'));
  const file = path.join(directory, 'snapshot.json');
  fs.writeFileSync(file, JSON.stringify(artifact()), { mode: 0o600 });
  try {
    const result = spawnSync(
      process.execPath,
      [
        validatorScript,
        file,
        `--expected-commit-sha=${artifact().candidate_commit_sha}`,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.valid, true);
    assert.equal(output.gate_eligible, false);
    assert.equal(output.workflow_version, 1);
    assert.equal(output.config_fingerprint_sha256, artifact().provider.config_fingerprint_sha256);
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test('CLI parsing rejects typos, duplicate commits and multiple artifacts', () => {
  assert.throws(() => parseCli([]), /evidence file is required/);
  assert.throws(() => parseCli(['a.json', 'b.json']), /only one/);
  assert.throws(() => parseCli(['--require-ready', 'a.json']), /unknown option/);
  assert.throws(
    () => parseCli([
      '--expected-commit-sha=' + 'a'.repeat(40),
      '--expected-commit-sha=' + 'b'.repeat(40),
      'a.json',
    ]),
    /supplied twice/,
  );
});

test('capture script is read-only, secret-safe and writes only outside Git', () => {
  const source = fs.readFileSync(captureScript, 'utf8');
  const workflow = fs.readFileSync(
    path.join(root, '.github', 'workflows', 'partners-integration.yml'),
    'utf8',
  );
  assert.match(source, /set -Eeuo pipefail/);
  assert.match(source, /set \+x/);
  assert.match(source, /evidence must be written outside the Git checkout/);
  assert.match(source, /output directory must have mode 700/);
  assert.match(source, /method="GET"/);
  assert.match(source, /DIDIT_RELEASE_GATE_ELIGIBLE=false/);
  assert.match(source, /"gate_eligible": False/);
  assert.match(source, /os\.fchmod\(fd, 0o600\)/);
  assert.doesNotMatch(source, /admin_partners_control|set_gate|set_flag|psql|docker exec/);
  assert.doesNotMatch(source, /method="(?:POST|PATCH|PUT|DELETE)"/);
  assert.doesNotMatch(source, /print\([^\n]*(?:API_KEY|WEBHOOK_SECRET)/);
  assert.match(
    workflow,
    /capture-norva-partners-\*\.sh[\s\S]*bash -n[\s\S]*capture-norva-partners-didit-live-config-evidence\.sh/,
  );
});
