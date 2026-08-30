const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
const edge = read('supabase', 'functions', 'norva-account-delete', 'index.ts');
const migration = read('supabase', 'migrations', '20260823182793_account_deletion_transport_stop_revalidate.sql');
const scopeMigration = read('supabase', 'migrations', '20260823182794_account_deletion_transport_stop_scope.sql');
const conflictHelper = read('supabase', 'functions', '_shared', 'database-conflict.ts');

test('transport stop revalidates every durable fence immediately before gateway fetch', () => {
  const start = edge.indexOf('async function drainProviderTransportStop');
  const end = edge.indexOf('\n// Drive exactly one durable', start);
  const worker = edge.slice(start, end);
  const revalidateAt = worker.indexOf('norva_revalidate_account_deletion_transport_stop');
  const fetchAt = worker.indexOf('fetch(`${mediaGateway.url}/sessions/stop-provider-affinities`');
  assert.ok(revalidateAt > 0 && revalidateAt < fetchAt, 'revalidation must precede gateway fetch');
  assert.match(worker, /isStaleDatabaseConflict\(revalidateError\)\) return "stale"/);
  assert.match(worker, /revalidated\.deletionEpoch !== epoch/);
  assert.match(worker, /revalidated\.leaseSequence !== leaseSequence/);
  assert.match(worker, /revalidated\.revision !== revision/);
  assert.match(worker, /body: JSON\.stringify\(\{ affinityHashes: revalidatedAffinities \}\)/);
});

test('transport stop resolves the established database runtime config before claiming work', () => {
  const resolverStart = edge.indexOf('async function resolveMediaGatewayConfig');
  const resolverEnd = edge.indexOf('\nfunction stringOrNull', resolverStart);
  const resolver = edge.slice(resolverStart, resolverEnd);
  assert.match(resolver, /ENV_MEDIA_GATEWAY_URL && ENV_MEDIA_GATEWAY_TOKEN/);
  assert.match(resolver, /\.from\("cloud_runtime_config"\)/);
  assert.match(resolver, /\.select\("key,value"\)/);
  assert.match(
    resolver,
    /\.in\("key", \["NORVA_MEDIA_GATEWAY_URL", "NORVA_MEDIA_GATEWAY_TOKEN"\]\)/,
  );
  assert.match(resolver, /expiresAt: Date\.now\(\) \+ 30_000/);

  const workerStart = edge.indexOf('async function drainProviderTransportStop');
  const workerEnd = edge.indexOf('\n// Drive exactly one durable', workerStart);
  const worker = edge.slice(workerStart, workerEnd);
  const resolveAt = worker.indexOf('resolveMediaGatewayConfig(db)');
  const claimAt = worker.indexOf('norva_claim_account_deletion_transport_stop');
  assert.ok(resolveAt >= 0 && resolveAt < claimAt, 'config resolution must precede the durable claim');
  assert.match(worker, /Authorization: `Bearer \$\{mediaGateway\.token\}`/);
});

test('provider cleanup is one claimed bounded batch followed by a resumable checkpoint', () => {
  const start = edge.indexOf('async function drainProviderAccountDeletionPreparation');
  const end = edge.indexOf('\n// Drive exactly one durable', start);
  const preparation = edge.slice(start, end);
  assert.match(preparation, /norva_claim_provider_account_deletion_prepare/);
  assert.match(preparation, /p_lease_seconds: 120/);
  assert.match(preparation, /norva_run_provider_account_deletion_prepare_batch/);
  assert.match(preparation, /p_expected_lease_sequence: leaseSequence/);
  assert.match(preparation, /p_expected_revision: revision/);
  assert.match(preparation, /p_limit: 500/);
  assert.match(preparation, /norva_checkpoint_provider_account_deletion_prepare/);
  assert.match(preparation, /p_expected_revision: nextRevision/);
  assert.match(preparation, /p_retry_after_seconds: 0/);
  assert.match(preparation, /isStaleDatabaseConflict\(batchError\)/);
  assert.match(preparation, /isStaleDatabaseConflict\(checkpointError\)/);
});

test('provider cleanup starts only after a durable transport-stop receipt', () => {
  const start = edge.indexOf('async function drainAccountDeletionWorkflows');
  const end = edge.indexOf('\nasync function cronAuthorized', start);
  const workflow = edge.slice(start, end);
  const transportAt = workflow.indexOf('drainProviderTransportStop(db, userId)');
  const completedAt = workflow.indexOf('if (transport === "completed")', transportAt);
  const preparationAt = workflow.indexOf('drainProviderAccountDeletionPreparation(db, userId)', completedAt);
  assert.ok(transportAt >= 0 && completedAt > transportAt && preparationAt > completedAt);
  assert.match(workflow, /providerBatches/);
});

test('transport stop treats PT409 as stale while retaining rolling 40001 compatibility', () => {
  assert.match(conflictHelper, /code === "PT409" \|\| code === "40001"/);
  assert.match(edge, /isStaleDatabaseConflict\(error\)/);
  assert.match(edge, /isStaleDatabaseConflict\(settleError\)/);
});

test('revalidation is a server-only CAS over account epoch, workflow state, lease, and revision', () => {
  assert.match(migration, /perform public\.norva_credential_require_service_role\(\)/);
  assert.match(migration, /v_workflow\.state not in \('stopping','draining'\)/);
  assert.match(migration, /v_action\.deletion_epoch <> p_expected_deletion_epoch/);
  assert.match(migration, /v_action\.lease_owner is distinct from btrim\(p_worker\)/);
  assert.match(migration, /v_action\.lease_sequence <> p_expected_lease_sequence/);
  assert.match(migration, /v_action\.revision <> p_expected_revision/);
  assert.match(migration, /v_action\.lease_until <= clock_timestamp\(\)/);
  assert.match(migration, /using errcode = '40001'/);
  assert.match(migration, /revoke all on function[\s\S]*from public,anon,authenticated/);
  assert.match(scopeMigration, /gateway_affinity_hashes jsonb/);
  assert.match(scopeMigration, /gateway_affinity_epoch bigint/);
  assert.match(scopeMigration, /v_action\.gateway_affinity_epoch <> v_action\.deletion_epoch/);
  assert.match(scopeMigration, /'affinityHashes',v_action\.gateway_affinity_hashes/);
  assert.doesNotMatch(
    scopeMigration.slice(scopeMigration.indexOf('create or replace function public.norva_revalidate_account_deletion_transport_stop')),
    /cloud_source_provider_account_affinities affinity/,
  );
});

test('an empty gateway scope can complete only through the existing SQL capability proof', () => {
  const start = edge.indexOf('if (revalidatedAffinities.length === 0)');
  const end = edge.indexOf('const response = await fetch', start);
  const noScope = edge.slice(start, end);
  assert.match(noScope, /norva_settle_provider_transport_stop_action/);
  assert.match(noScope, /p_outcome: "completed"/);
  assert.doesNotMatch(noScope, /fetch\(/);
});
