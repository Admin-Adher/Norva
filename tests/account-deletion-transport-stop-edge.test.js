const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
const edge = read('supabase', 'functions', 'norva-account-delete', 'index.ts');
const migration = read('supabase', 'migrations', '20260823182793_account_deletion_transport_stop_revalidate.sql');
const scopeMigration = read('supabase', 'migrations', '20260823182794_account_deletion_transport_stop_scope.sql');

test('transport stop revalidates every durable fence immediately before gateway fetch', () => {
  const start = edge.indexOf('async function drainProviderTransportStop');
  const end = edge.indexOf('\n// Drive exactly one durable', start);
  const worker = edge.slice(start, end);
  const revalidateAt = worker.indexOf('norva_revalidate_account_deletion_transport_stop');
  const fetchAt = worker.indexOf('fetch(`${MEDIA_GATEWAY_URL}/sessions/stop-provider-affinities`');
  assert.ok(revalidateAt > 0 && revalidateAt < fetchAt, 'revalidation must precede gateway fetch');
  assert.match(worker, /revalidateError\?\.code === "40001"\) return "stale"/);
  assert.match(worker, /revalidated\.deletionEpoch !== epoch/);
  assert.match(worker, /revalidated\.leaseSequence !== leaseSequence/);
  assert.match(worker, /revalidated\.revision !== revision/);
  assert.match(worker, /body: JSON\.stringify\(\{ affinityHashes: revalidatedAffinities \}\)/);
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
