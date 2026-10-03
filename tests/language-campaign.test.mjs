import test from 'node:test';
import assert from 'node:assert/strict';
import { safeResult, delayFor, recoverState, chooseSource, intakeWindowOpen } from '../ops/hetzner/services/language-campaign.mjs';
const sources = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
test('logs discard arbitrary bodies, URLs, identities and negative counters', () => {
  assert.deepEqual(safeResult({ processed: 3, failed: -1, sourceId: 'secret', code: 'https://secret', skipped: 'provider-account-busy', details: 'secret' }), {
    processed: 3, attempted: 0, queued: 0, identified: 0, verified: 0, inconclusive: 0, deferred: 0, failed: 0, scanned: 0, skipped: 'provider-account-busy' });
});
test('restart preserves progress and waits for uncertain server lease expiry', () => {
  const state = recoverState(null, sources, 1000); state.sources.a.inFlight = 1200; state.sources.a.calls = 81;
  const recovered = recoverState(JSON.parse(JSON.stringify(state)), sources, 2000);
  assert.equal(recovered.sources.a.calls, 81); assert.equal(recovered.sources.a.nextAt, 1200 + 1260000);
  assert.equal(chooseSource(recovered, sources, new Set(['b']), 3000).id, 'c');
});
test('selection excludes occupied or delayed providers while other sources progress', () => {
  const state = recoverState(null, sources, 1000); state.sources.a.nextAt = 60000;
  assert.equal(chooseSource(state, sources, new Set(['b']), 1001).id, 'c');
  assert.equal(chooseSource(state, sources, new Set(['b', 'c']), 1001), undefined);
});
test('viewer/provider occupancy and unavailable capacity back off', () => {
  assert.equal(delayFor({ skipped: 'provider-account-busy' }), 180000);
  assert.equal(delayFor({ skipped: 'server-capacity' }), 30000);
  assert.equal(delayFor({ skipped: 'automatic-queue-full' }), 180000);
  assert.equal(delayFor({ processed: 1, code: 'strict-analysis-deferred' }), 180000);
  assert.equal(delayFor({ skipped: 'source-not-visible' }), 900000);
});
test('intake leaves a recurring quiet interval for the existing strict worker', () => {
  for (const t of [0, 19000, 50000, 119999, 120000, 139999]) assert.equal(intakeWindowOpen(t), false);
  for (const t of [20000, 49999, 140000, 169999]) assert.equal(intakeWindowOpen(t), true);
});
test('progress above 100 is retained without a campaign batch cutoff', () => {
  const state = recoverState(null, sources); state.sources.a.calls = 10000;
  assert.equal(recoverState(state, sources).sources.a.calls, 10000);
  assert.equal(delayFor({ processed: 4 }), 1500);
  assert.equal(delayFor({ processed: 0, hasMore: false }), 900000);
});
