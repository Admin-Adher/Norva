const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const edge = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'functions', 'norva-account-delete', 'index.ts'),
  'utf8',
);

test('the public account-delete adapter begins durable work and never deletes Auth inline', () => {
  const route = edge.slice(edge.indexOf('Deno.serve(async (req) => {'));
  assert.match(route, /norva_begin_account_deletion_workflow/);
  assert.doesNotMatch(route, /auth\.admin\.deleteUser\(/);
  assert.match(route, /readyToFinalize: deletion\.readyToFinalize === true,[\s\S]*\}, 202\)/);
});

test('the sole Auth deletion is a claimed, acknowledged durable finalizer', () => {
  const finalizerStart = edge.indexOf('async function drainAccountDeletionFinalizations');
  const finalizerEnd = edge.indexOf('\nasync function sha256Hex', finalizerStart);
  const finalizer = edge.slice(finalizerStart, finalizerEnd);
  const claimAt = finalizer.indexOf('norva_claim_account_deletion_finalizations');
  const deleteAt = finalizer.indexOf('db.auth.admin.deleteUser(userId)');
  const acknowledgeAt = finalizer.indexOf('norva_complete_account_deletion_finalization');
  assert.ok(claimAt >= 0 && claimAt < deleteAt && deleteAt < acknowledgeAt);
  assert.match(finalizer, /norva_reconcile_account_deletion_finalizations/);
});
