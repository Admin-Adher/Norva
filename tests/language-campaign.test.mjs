import test from 'node:test';
import assert from 'node:assert/strict';
import { safeResult, delayFor, recoverState, chooseWork, recordResult, intakeWindowOpen, discoverSources, reconcileSources } from '../ops/hetzner/services/language-campaign.mjs';
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

test('live-session receipts with processed deferrals wait three minutes on both lanes', () => {
  for (const field of ['skipped', 'code']) {
    for (const lane of ['metadata', 'exact']) {
      const state = recoverState(null, sources, 0);
      const result = { [field]: 'live-session', processed: 1, attempted: 0, deferred: 1, hasMore: true };
      recordResult(state.sources.a, lane, result, 2000);
      // A processed receipt can record only a deferral, with no provider I/O.
      assert.equal(chooseWork(state, [sources[0]], new Set(), 4000), undefined);
      assert.equal(chooseWork(state, [sources[0]], new Set(), 181999), undefined);
      assert.equal(state.sources.a.blockedUntil, 182000);
      assert.equal(chooseWork(state, [sources[0]], new Set(), 182000).lane, 'metadata');
      assert.equal(chooseWork(state, [sources[1]], new Set(), 4000).source.id, 'b');
      assert.equal(state.sources.a.totals.attempted, 0);
    }
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

const sourceUuid = n => `10000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const ownerUuid = n => `20000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

test('restart protects uncertain requests of sources outside the original cohort', () => {
  const initial = { id: sourceUuid(1), userId: ownerUuid(1), xtream: false };
  const added = { id: sourceUuid(2), userId: ownerUuid(2), xtream: true };
  const state = recoverState(null, [initial, added], 0);
  state.sources[added.id].inFlight = 1000;
  state.sources[added.id].calls = 23;
  recoverState(state, [initial], 30000);
  assert.equal(state.sources[added.id].blockedUntil, 1261000);
  assert.equal(state.sources[added.id].calls, 23);
  assert.equal(chooseWork(state, [added], new Set(), 60000), undefined);
});
test('discovery paginates every eligible owner without a pilot list and sends no media request', async () => {
  const rows = Array.from({ length: 131 }, (_, n) => ({ id: sourceUuid(n + 1), userId: ownerUuid(n + 1), xtream: n % 2 === 0 }));
  const calls = [];
  const found = await discoverSources('http://internal/rpc/discovery', 'fixture', async (url, options) => {
    calls.push(JSON.parse(options.body)); assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify(calls.length === 1 ? rows.slice(0, 128) : rows.slice(128)));
  });
  assert.deepEqual(found, rows); assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], { p_after: sourceUuid(128), p_limit: 128 });
});
test('failed or malformed discovery never returns a partial fleet', async () => {
  for (const value of [{}, [{ id: sourceUuid(1), userId: 'invalid', xtream: true }],
    [{ id: sourceUuid(2), userId: ownerUuid(1), xtream: true }, { id: sourceUuid(1), userId: ownerUuid(1), xtream: true }]]) {
    await assert.rejects(discoverSources('http://internal/rpc/discovery', 'fixture', async () => new Response(JSON.stringify(value))));
  }
  await assert.rejects(discoverSources('http://internal/rpc/discovery', 'fixture', async () => new Response('', { status: 503 })));
  await assert.rejects(discoverSources('http://internal/rpc/discovery', '', async () => { throw new Error('must not fetch'); }));
});
test('new owners join, removed sources stop scheduling, old attempts and uncertain leases remain', () => {
  const first = { id: sourceUuid(1), userId: ownerUuid(1), xtream: true, label: 'Pilot' };
  const next = { id: sourceUuid(2), userId: ownerUuid(2), xtream: false };
  const state = recoverState(null, [first], 1000);
  const original = state.sources[first.id]; original.calls = 57; original.blockedUntil = 900000;
  original.inFlight = 5000; original.inFlightLane = 'metadata';
  let selected = reconcileSources(state, [first, next], [first], 10000);
  assert.equal(selected.length, 2); assert.equal(state.sources[first.id], original);
  assert.equal(original.inFlight, 5000); assert.equal(original.blockedUntil, 900000);
  assert.equal(original.calls, 57); assert.equal(selected[0].label, 'Pilot');
  selected = reconcileSources(state, [next], [first], 20000);
  assert.equal(chooseWork(state, selected, new Set(), 30000).source.id, next.id);
  assert.equal(state.sources[first.id].calls, 57);
  assert.throws(() => reconcileSources(state, [{ ...first, userId: ownerUuid(3) }], [first]));
});
