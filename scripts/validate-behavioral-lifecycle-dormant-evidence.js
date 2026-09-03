'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const DEPLOYMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{7,199}$/;
const SERVICE = /^functions[0-9]*$/;
const MAX_ARTIFACT_BYTES = 512 * 1024;

const TOP_LEVEL_KEYS = [
  'schema_version',
  'artifact_type',
  'evidence_scope',
  'captured_at',
  'target_environment',
  'deployment_id',
  'repository',
  'server_checkout_sha',
  'contains_personal_data',
  'contains_secrets',
  'migration_sha256',
  'database_read_only_gate',
  'edge_runtime',
  'release_assertion',
];
const GATE_KEYS = [
  'status',
  'relations',
  'rpcs',
  'triggers',
  'journeys',
  'steps',
  'emergency_stop',
  'audience_mode',
  'projected_accounts',
];
const EDGE_KEYS = [
  'replica_count',
  'replicas',
  'source_digests_by_replica',
  'source_parity',
];
const REPLICA_KEYS = [
  'service',
  'running',
  'health',
  'image_id_sha256',
  'container_id_fingerprint_sha256',
  'started_at',
];
const RELEASE_KEYS = ['pilot_eligible', 'reason', 'missing_required_proofs'];
const RUNTIME_PATHS = [
  'norva-cloud/index.ts',
  'norva-lifecycle/index.ts',
  'norva-admin/index.ts',
  'norva-branded-email-worker/index.ts',
  '_shared/cloud-public-view.mjs',
  '_shared/fcm.ts',
  '_shared/lifecycle-email.ts',
  '_shared/fcm-error.mjs',
  '_shared/resend-transport.mjs',
];
const MISSING_PROOFS = [
  'real_schema_and_data_staging_scenarios',
  'internal_fcm_delivery_and_open',
  'internal_email_delivery_and_unsubscribe',
  'physical_android_permission_deep_link_and_receipts',
  'hetzner_firebase_ga4_reconciliation',
  'authorized_ten_percent_pilot',
  'mature_j7_and_j14_outcomes',
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
  assert(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value), `${trail} must be UTC ISO-8601`);
  assert(Number.isFinite(Date.parse(value)), `${trail} must be a real timestamp`);
}

function assertNonNegativeInteger(value, trail) {
  assert(Number.isSafeInteger(value) && value >= 0, `${trail} must be a non-negative integer`);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

function validateEvidence(value) {
  assertExactKeys(value, TOP_LEVEL_KEYS, 'artifact');
  assert(value.schema_version === 1, 'schema_version must be 1');
  assert(value.artifact_type === 'norva_behavioral_lifecycle_dormant_installation', 'artifact_type is invalid');
  assert(value.evidence_scope === 'dormant_installation_only', 'evidence_scope is invalid');
  assertIsoTimestamp(value.captured_at, 'captured_at');
  assert(['staging', 'production'].includes(value.target_environment), 'target_environment is invalid');
  assert(
    typeof value.deployment_id === 'string'
      && DEPLOYMENT_ID.test(value.deployment_id)
      && !value.deployment_id.includes('..')
      && !value.deployment_id.includes('//'),
    'deployment_id is invalid',
  );
  assert(value.repository === 'Admin-Adher/Norva', 'repository is invalid');
  assert(COMMIT_SHA.test(value.server_checkout_sha), 'server_checkout_sha is invalid');
  assert(value.contains_personal_data === false, 'artifact must declare no personal data');
  assert(value.contains_secrets === false, 'artifact must declare no secrets');
  assert(SHA256.test(value.migration_sha256), 'migration_sha256 is invalid');

  const gate = value.database_read_only_gate;
  assertExactKeys(gate, GATE_KEYS, 'database_read_only_gate');
  assert(gate.status === 'BEHAVIORAL_LIFECYCLE_PRE_ACTIVATION_READY', 'database gate status is invalid');
  for (const [key, expected] of Object.entries({ relations: 10, rpcs: 15, triggers: 12, journeys: 4, steps: 11 })) {
    assert(gate[key] === expected, `database gate ${key} must equal ${expected}`);
  }
  assert(gate.emergency_stop === true, 'database gate must prove emergency stop');
  assert(gate.audience_mode === 'internal_test', 'database gate must prove internal_test');
  assertNonNegativeInteger(gate.projected_accounts, 'database gate projected_accounts');

  const edge = value.edge_runtime;
  assertExactKeys(edge, EDGE_KEYS, 'edge_runtime');
  assert(edge.source_parity === true, 'edge source parity must be true');
  assert(Array.isArray(edge.replicas) && edge.replicas.length > 0, 'at least one Edge replica is required');
  assert(edge.replica_count === edge.replicas.length, 'replica_count must match replicas');
  if (value.target_environment === 'production') {
    assert(edge.replica_count >= 2, 'production evidence requires at least two replicas');
  }

  const services = new Set();
  for (const [index, replica] of edge.replicas.entries()) {
    const trail = `edge_runtime.replicas[${index}]`;
    assertExactKeys(replica, REPLICA_KEYS, trail);
    assert(typeof replica.service === 'string' && SERVICE.test(replica.service), `${trail}.service is invalid`);
    assert(!services.has(replica.service), `${trail}.service is duplicated`);
    services.add(replica.service);
    assert(replica.running === true, `${trail} must be running`);
    assert(['healthy', 'not_configured'].includes(replica.health), `${trail}.health is invalid`);
    assert(SHA256.test(replica.image_id_sha256), `${trail}.image_id_sha256 is invalid`);
    assert(SHA256.test(replica.container_id_fingerprint_sha256), `${trail}.container fingerprint is invalid`);
    assertIsoTimestamp(replica.started_at, `${trail}.started_at`);
  }

  const digests = edge.source_digests_by_replica;
  assertExactKeys(digests, RUNTIME_PATHS, 'edge_runtime.source_digests_by_replica');
  const expectedServices = [...services].sort();
  for (const runtimePath of RUNTIME_PATHS) {
    const byService = digests[runtimePath];
    assertExactKeys(byService, expectedServices, `source digest ${runtimePath}`);
    const values = Object.values(byService);
    assert(values.every((digest) => typeof digest === 'string' && SHA256.test(digest)), `source digest ${runtimePath} is invalid`);
    assert(new Set(values).size === 1, `source digest ${runtimePath} differs between replicas`);
  }

  const release = value.release_assertion;
  assertExactKeys(release, RELEASE_KEYS, 'release_assertion');
  assert(release.pilot_eligible === false, 'dormant evidence can never authorize a pilot');
  assert(release.reason === 'dormant_installation_configuration_only', 'release reason is invalid');
  assert(
    Array.isArray(release.missing_required_proofs)
      && release.missing_required_proofs.length === MISSING_PROOFS.length
      && release.missing_required_proofs.every((item, index) => item === MISSING_PROOFS[index]),
    'missing_required_proofs must preserve the complete ordered gate list',
  );

  return value;
}

function validateEvidenceFile(filePath) {
  const resolved = path.resolve(filePath);
  const stat = fs.lstatSync(resolved);
  assert(stat.isFile() && !stat.isSymbolicLink(), 'evidence path must be a regular non-symlink file');
  assert(stat.size > 0 && stat.size <= MAX_ARTIFACT_BYTES, 'evidence file size is invalid');
  if (process.platform !== 'win32') {
    assert((stat.mode & 0o777) === 0o600, 'evidence file mode must be 600');
  }
  const bytes = fs.readFileSync(resolved);
  let parsed;
  const text = bytes.toString('utf8');
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('evidence file must contain valid UTF-8 JSON');
  }
  const canonical = `${JSON.stringify(canonicalize(parsed), null, 2)}\n`;
  assert(text === canonical, 'evidence file must use the canonical JSON encoding');
  validateEvidence(parsed);
  return {
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    targetEnvironment: parsed.target_environment,
    deploymentId: parsed.deployment_id,
  };
}

if (require.main === module) {
  try {
    assert(process.argv.length === 3, 'usage: node validate-behavioral-lifecycle-dormant-evidence.js <artifact.json>');
    const result = validateEvidenceFile(process.argv[2]);
    process.stdout.write(`BEHAVIORAL_LIFECYCLE_DORMANT_EVIDENCE_VALID=true\n`);
    process.stdout.write(`BEHAVIORAL_LIFECYCLE_DORMANT_EVIDENCE_SHA256=${result.sha256}\n`);
    process.stdout.write(`BEHAVIORAL_LIFECYCLE_TARGET_ENVIRONMENT=${result.targetEnvironment}\n`);
    process.stdout.write(`BEHAVIORAL_LIFECYCLE_DEPLOYMENT_ID=${result.deploymentId}\n`);
    process.stdout.write('BEHAVIORAL_LIFECYCLE_PILOT_ELIGIBLE=false\n');
  } catch (error) {
    process.stderr.write(`Behavioral lifecycle evidence validation failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  MISSING_PROOFS,
  RUNTIME_PATHS,
  canonicalize,
  validateEvidence,
  validateEvidenceFile,
};
