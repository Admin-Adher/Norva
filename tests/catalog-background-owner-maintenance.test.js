const { test } = require('node:test');
const assert = require('node:assert/strict');

const modulePath = '../supabase/functions/_shared/catalog-background-owner-workflow.mjs';
function database(replies) {
  const calls = [];
  return { calls, async rpc(name, args) {
    calls.push({ name, args });
    assert.ok(replies.length, `Unexpected RPC ${name}`);
    const next = replies.shift();
    return next.error ? next : { data: next, error: null };
  } };
}
const claim = { job_id: 'owner-job', lease_sequence: 3, checkpoint_revision: '9007199254740993' };
const step = (revision, complete = false) => ({
  contract: 'catalog-background-owner-workflow-v1', jobId: claim.job_id,
  checkpointRevision: revision, complete,
});
test('new catalogues are discovered and completed through the durable owner workflow', async () => {
  const { maintainCatalogBackgroundOwners } = await import(modulePath);
  const db = database([[claim], step('9007199254740994'), step('9007199254740995', true), []]);
  const result = await maintainCatalogBackgroundOwners(db, { worker: 'test-worker' });
  assert.deepEqual(result, { claimed: 1, slices: 2, completed: 1, deferred: 0, idle: true });
  assert.equal(db.calls[0].name, 'norva_claim_catalog_background_owner_build_jobs');
  assert.equal(db.calls[2].args.p_expected_checkpoint_revision, '9007199254740994');
  assert.equal(db.calls[2].args.p_expected_lease_sequence, 3);
});
test('bounded runs checkpoint exact progress and release the lease for the next tick', async () => {
  const { maintainCatalogBackgroundOwners } = await import(modulePath);
  const db = database([[claim], step('9007199254740994'), {}]);
  const result = await maintainCatalogBackgroundOwners(db, { maxSlices: 1, worker: 'test-worker' });
  assert.equal(result.deferred, 1);
  assert.equal(db.calls.at(-1).name, 'norva_checkpoint_catalog_background_owner_build_job');
  assert.equal(db.calls.at(-1).args.p_expected_checkpoint_revision, '9007199254740994');
  assert.equal(db.calls.at(-1).args.p_retry_after_seconds, 5);
});
test('a failed slice retains its last confirmed checkpoint for recovery', async () => {
  const { maintainCatalogBackgroundOwners } = await import(modulePath);
  const failure = { code: '40001', message: 'generation changed' };
  const db = database([[claim], { error: failure }, {}]);
  await assert.rejects(maintainCatalogBackgroundOwners(db, { worker: 'test-worker' }), error => error === failure);
  assert.equal(db.calls.at(-1).args.p_expected_checkpoint_revision, claim.checkpoint_revision);
});
test('an idle queue and invalid bounds never create unbounded work', async () => {
  const { maintainCatalogBackgroundOwners } = await import(modulePath);
  const db = database([[]]);
  assert.equal((await maintainCatalogBackgroundOwners(db)).idle, true);
  await assert.rejects(maintainCatalogBackgroundOwners(db, { maxSlices: 1000 }), /bounds/);
  assert.equal(db.calls.length, 1);
});
