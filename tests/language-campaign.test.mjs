import test from 'node:test';
import assert from 'node:assert/strict';
import { safeResult, delayFor, recoverState, chooseWork, recordResult, intakeWindowOpen } from '../ops/hetzner/services/language-campaign.mjs';
const sources = [{ id: 'a', xtream: true }, { id: 'b', xtream: true }, { id: 'c' }];
test('logs discard arbitrary bodies, URLs, identities and negative counters', () => {
  assert.deepEqual(safeResult({ processed: 3, failed: -1, sourceId: 'secret', code: 'https://secret', skipped: 'provider-account-busy', details: 'secret' }), {
    processed: 3, attempted: 0, queued: 0, identified: 0, verified: 0, inconclusive: 0, deferred: 0, failed: 0, scanned: 0, skipped: 'provider-account-busy' });
});
test('restart preserves progress and waits for uncertain server lease expiry', () => {
  const state = recoverState(null, sources, 1000); state.sources.a.inFlight = 1200; state.sources.a.calls = 81;
  const recovered = recoverState(JSON.parse(JSON.stringify(state)), sources, 2000);
  assert.equal(recovered.sources.a.calls, 81); assert.equal(recovered.sources.a.blockedUntil, 1200 + 1260000);
  assert.equal(chooseWork(recovered, sources, new Set(['b']), 30000).source.id, 'c');
  assert.equal(chooseWork(recovered, sources, new Set(['b']), 3000), undefined);
});
test('selection excludes occupied or delayed providers while other sources progress', () => {
  const state = recoverState(null, sources, 1000); state.sources.a.blockedUntil = 60000;
  assert.equal(chooseWork(state, sources, new Set(['b']), 30000).source.id, 'c');
  assert.equal(chooseWork(state, sources, new Set(['b', 'c']), 30000), undefined);
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

test('metadata progresses while the exact queue is full, including outside its time window', () => {
  const state = recoverState(null, sources, 0);
  recordResult(state.sources.a, 'exact', { processed: 1, code: 'strict-analysis-deferred' }, 30000);
  const work = chooseWork(state, [sources[0]], new Set(), 60000);
  assert.equal(work.lane, 'metadata');
  assert.equal(state.sources.a.lanes.exact.nextAt, 210000);
  assert.equal(chooseWork(state, [sources[2]], new Set(), 60000), undefined);
});

test('both lanes respect a viewer, provider circuit and uncertain HTTP outcome', () => {
  for (const result of [{ skipped: 'live-session' }, { skipped: 'provider-account-busy' }, { httpError: 504 }]) {
    const state = recoverState(null, sources, 0);
    state.sources.a.inFlight = 1000;
    recordResult(state.sources.a, 'exact', result, 2000);
    assert.equal(chooseWork(state, [sources[0]], new Set(), 30000), undefined);
    if (result.httpError) assert.equal(state.sources.a.blockedUntil, 1261000);
  }
});

test('finite metadata batches rotate fairly and exact work has priority in its window', () => {
  const state = recoverState(null, sources, 0);
  assert.equal(chooseWork(state, sources, new Set(), 1000).source.id, 'a');
  recordResult(state.sources.a, 'metadata', { processed: 32, attempted: 32 }, 1000);
  assert.equal(chooseWork(state, sources, new Set(), 3000).source.id, 'b');
  assert.equal(chooseWork(state, sources, new Set(), 30000).lane, 'exact');
  assert.equal(state.sources.a.totals.processed, 32);
  assert.equal(state.sources.a.lanes.metadata.totals.processed, 32);
  assert.equal(state.sources.a.lanes.exact.totals.processed, undefined);
});

test('v1 migration preserves counters, existing delays and unfinished leases for both lanes', () => {
  const old = { schema: 1, sources: {
    a: { calls: 81, turn: 81, totals: { processed: 600 }, nextAt: 90000, failures: 0, inFlight: 1000 },
    b: { calls: 12, turn: 12, totals: { processed: 7 }, nextAt: 90000, failures: 0 },
  }};
  const state = recoverState(old, sources, 30000);
  assert.equal(state.schema, 2);
  assert.equal(state.sources.a.totals.processed, 600);
  assert.equal(state.sources.a.lanes.metadata.nextAt, 1261000);
  assert.equal(state.sources.a.lanes.exact.nextAt, 1261000);
  assert.equal(state.sources.b.lanes.metadata.nextAt, 90000);
  assert.equal(chooseWork(state, [sources[1]], new Set(), 60000), undefined);
});
