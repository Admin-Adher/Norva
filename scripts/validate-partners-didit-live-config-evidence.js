#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const DEPLOYMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{7,199}$/;
const REQUIRED_FEATURES = new Set([
  'FACE_MATCH',
  'IP_ANALYSIS',
  'LIVENESS',
  'OCR',
]);
const REQUIRED_MISSING_PROOFS = [
  'sandbox_non_authoritative_session',
  'live_signed_decision',
  'environment_and_fingerprint_quarantine',
];
const ROOT_KEYS = [
  'schema_version',
  'artifact_type',
  'evidence_scope',
  'captured_at',
  'repository',
  'candidate_commit_sha',
  'server_checkout_sha',
  'deployment_id',
  'target_environment',
  'contains_personal_data',
  'contains_secrets',
  'provider',
  'runtime',
  'release_assertion',
];
const PROVIDER_KEYS = [
  'name',
  'environment',
  'workflow_type',
  'workflow_status',
  'workflow_version',
  'workflow_published_at',
  'workflow_archived',
  'features',
  'kyb_enabled',
  'aml_enabled',
  'aml_ongoing_monitoring_enabled',
  'callback_url',
  'session_expiration_seconds',
  'config_fingerprint_sha256',
  'workflow_config_sha256',
  'workflow_id_sha256',
  'application_id_sha256',
];
const RUNTIME_KEYS = [
  'edge_replicas',
  'replica_count',
  'configuration_parity',
  'workflow_matches_management_api',
  'callback_matches_management_api',
  'session_expiration_matches_management_api',
  'node_ids_distinct',
  'management_api_http_status',
  'tracked_worktree_clean',
  'tracked_worktree_change_count',
];
const REPLICA_KEYS = [
  'name',
  'running',
  'health',
  'image_id_sha256',
  'started_at',
];
const ASSERTION_KEYS = [
  'gate_eligible',
  'reason',
  'missing_required_proofs',
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isPlainObject(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertExactKeys(value, expected, trail) {
  assert(isPlainObject(value), `${trail} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  assert(
    actual.length === wanted.length
      && actual.every((key, index) => key === wanted[index]),
    `${trail} contains missing or unknown fields`,
  );
}

function parseUtc(value, trail, nowMs) {
  assert(
    typeof value === 'string'
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value),
    `${trail} must be a canonical UTC timestamp`,
  );
  const parsed = Date.parse(value);
  assert(Number.isFinite(parsed), `${trail} is not a valid timestamp`);
  assert(parsed <= nowMs + 5 * 60_000, `${trail} is too far in the future`);
  return parsed;
}

function scanForbidden(value, trail = 'artifact') {
  if (Array.isArray(value)) {
    value.forEach((child, index) => scanForbidden(child, `${trail}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    assert(
      key === 'contains_secrets'
        || !/(?:api[_-]?key|secret|token|session[_-]?id|document|email|phone|(?:first|last|full)[_-]?name|birth|address|biometric|vendor[_-]?data|user[_-]?id)/i.test(key),
      `${trail}.${key} is forbidden in sanitized evidence`,
    );
    scanForbidden(child, `${trail}.${key}`);
  }
}

function validateArtifact(artifact, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  assertExactKeys(artifact, ROOT_KEYS, 'artifact');
  assert(artifact.schema_version === 1, 'schema_version must equal 1');
  assert(
    artifact.artifact_type === 'norva_partners_didit_live_config_snapshot',
    'artifact_type is invalid',
  );
  assert(
    artifact.evidence_scope === 'configuration_only',
    'evidence_scope must remain configuration_only',
  );
  const capturedAt = parseUtc(artifact.captured_at, 'captured_at', nowMs);
  assert(artifact.repository === 'Admin-Adher/Norva', 'repository is invalid');
  assert(COMMIT_RE.test(artifact.candidate_commit_sha), 'candidate commit is invalid');
  assert(
    artifact.server_checkout_sha === artifact.candidate_commit_sha,
    'server checkout must equal the candidate commit',
  );
  if (options.expectedCommitSha !== undefined) {
    assert(
      artifact.candidate_commit_sha === options.expectedCommitSha,
      'candidate commit does not match --expected-commit-sha',
    );
  }
  assert(
    typeof artifact.deployment_id === 'string'
      && DEPLOYMENT_RE.test(artifact.deployment_id)
      && !artifact.deployment_id.includes('..')
      && !artifact.deployment_id.includes('//'),
    'deployment_id is invalid',
  );
  assert(artifact.target_environment === 'production', 'target must be production');
  assert(artifact.contains_personal_data === false, 'personal data marker must be false');
  assert(artifact.contains_secrets === false, 'secret marker must be false');

  assertExactKeys(artifact.provider, PROVIDER_KEYS, 'provider');
  const provider = artifact.provider;
  assert(provider.name === 'didit', 'provider must be didit');
  assert(provider.environment === 'live', 'Didit environment must be live');
  assert(provider.workflow_type === 'kyc', 'workflow must be KYC');
  assert(provider.workflow_status === 'published', 'workflow must be published');
  assert(
    Number.isSafeInteger(provider.workflow_version)
      && provider.workflow_version >= 1
      && provider.workflow_version <= 1_000_000,
    'workflow version is invalid',
  );
  const publishedAt = parseUtc(
    provider.workflow_published_at,
    'provider.workflow_published_at',
    nowMs,
  );
  assert(publishedAt <= capturedAt, 'workflow publication must precede capture');
  assert(provider.workflow_archived === false, 'workflow must not be archived');
  assert(
    Array.isArray(provider.features)
      && provider.features.length >= REQUIRED_FEATURES.size
      && provider.features.length <= 32
      && provider.features.every((feature) => /^[A-Z][A-Z0-9_]{1,63}$/.test(feature))
      && new Set(provider.features).size === provider.features.length,
    'provider features are invalid',
  );
  for (const feature of REQUIRED_FEATURES) {
    assert(provider.features.includes(feature), `required feature ${feature} is missing`);
  }
  assert(
    provider.features.every((feature) => !feature.includes('KYB')),
    'KYB feature is forbidden',
  );
  assert(provider.kyb_enabled === false, 'KYB must be disabled');
  assert(provider.aml_enabled === false, 'AML must be disabled for P0');
  assert(
    provider.aml_ongoing_monitoring_enabled === false,
    'ongoing AML must be disabled for P0',
  );
  assert(
    provider.callback_url === 'https://norva.tv/partners-kyc-return',
    'callback URL is not canonical',
  );
  assert(
    provider.session_expiration_seconds === 604800,
    'session expiration must equal 604800',
  );
  for (const key of [
    'config_fingerprint_sha256',
    'workflow_config_sha256',
    'workflow_id_sha256',
    'application_id_sha256',
  ]) {
    assert(SHA256_RE.test(provider[key]), `${key} is not a strong SHA-256`);
  }

  assertExactKeys(artifact.runtime, RUNTIME_KEYS, 'runtime');
  const runtime = artifact.runtime;
  assert(runtime.replica_count === 2, 'exactly two Edge replicas are required');
  assert(
    Array.isArray(runtime.edge_replicas)
      && runtime.edge_replicas.length === runtime.replica_count,
    'Edge replica evidence is incomplete',
  );
  const expectedNames = ['norva-edge-functions', 'norva-edge-functions-2'];
  runtime.edge_replicas.forEach((replica, index) => {
    assertExactKeys(replica, REPLICA_KEYS, `runtime.edge_replicas[${index}]`);
    assert(replica.name === expectedNames[index], 'Edge replica name/order is invalid');
    assert(replica.running === true, `${replica.name} is not running`);
    assert(replica.health === 'healthy', `${replica.name} is not healthy`);
    assert(SHA256_RE.test(replica.image_id_sha256), 'Edge image id is invalid');
    parseUtc(replica.started_at, `${replica.name}.started_at`, nowMs);
  });
  for (const key of [
    'configuration_parity',
    'workflow_matches_management_api',
    'callback_matches_management_api',
    'session_expiration_matches_management_api',
    'node_ids_distinct',
  ]) {
    assert(runtime[key] === true, `${key} must be true`);
  }
  assert(runtime.management_api_http_status === 200, 'management API status must be 200');
  assert(typeof runtime.tracked_worktree_clean === 'boolean', 'worktree marker is invalid');
  assert(
    Number.isSafeInteger(runtime.tracked_worktree_change_count)
      && runtime.tracked_worktree_change_count >= 0
      && runtime.tracked_worktree_change_count <= 10_000
      && runtime.tracked_worktree_clean === (runtime.tracked_worktree_change_count === 0),
    'worktree change count is invalid',
  );

  assertExactKeys(artifact.release_assertion, ASSERTION_KEYS, 'release_assertion');
  const assertion = artifact.release_assertion;
  assert(assertion.gate_eligible === false, 'configuration snapshot cannot be gate eligible');
  assert(
    assertion.reason === 'configuration_snapshot_only',
    'release assertion reason is invalid',
  );
  assert(
    Array.isArray(assertion.missing_required_proofs)
      && assertion.missing_required_proofs.length === REQUIRED_MISSING_PROOFS.length
      && REQUIRED_MISSING_PROOFS.every(
        (proof, index) => assertion.missing_required_proofs[index] === proof,
      ),
    'the three missing Didit proofs must remain explicit',
  );

  scanForbidden(artifact);
  return artifact;
}

function parseCli(argv) {
  let file = null;
  let expectedCommitSha;
  for (const arg of argv) {
    if (arg.startsWith('--expected-commit-sha=')) {
      assert(expectedCommitSha === undefined, 'expected commit was supplied twice');
      expectedCommitSha = arg.slice('--expected-commit-sha='.length);
      assert(COMMIT_RE.test(expectedCommitSha), 'expected commit SHA is invalid');
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      assert(file === null, 'only one evidence file is accepted');
      file = arg;
    }
  }
  assert(file !== null, 'an evidence file is required');
  return { file, expectedCommitSha };
}

function main() {
  try {
    const options = parseCli(process.argv.slice(2));
    const resolved = path.resolve(options.file);
    const stat = fs.statSync(resolved);
    assert(stat.isFile(), 'evidence path must be a regular file');
    assert(stat.size > 0 && stat.size <= 256 * 1024, 'evidence file size is invalid');
    const source = fs.readFileSync(resolved, 'utf8');
    const artifact = JSON.parse(source);
    validateArtifact(artifact, { expectedCommitSha: options.expectedCommitSha });
    process.stdout.write(JSON.stringify({
      valid: true,
      artifact_type: artifact.artifact_type,
      evidence_scope: artifact.evidence_scope,
      gate_eligible: false,
      candidate_commit_sha: artifact.candidate_commit_sha,
      config_fingerprint_sha256: artifact.provider.config_fingerprint_sha256,
      workflow_version: artifact.provider.workflow_version,
    }) + '\n');
  } catch (error) {
    process.stderr.write(`Invalid Didit configuration evidence: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  validateArtifact,
  parseCli,
};
