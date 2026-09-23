const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const GATEWAY_ID = 'a7250ec1-171b-4bcf-ad7d-41bac56130ec';
const hashForBucket = (bucket) => bucket.toString(16).padStart(8, '0') + '0'.repeat(56);
const hashForOwner = (owner) => createHash('sha256').update(owner).digest('hex');
const UNAVAILABLE = { code: 'MEDIA_GATEWAY_HLS_ROUTING_UNAVAILABLE' };

async function fixture(overrides = {}) {
  const legacy = await import('../supabase/functions/_shared/media-gateway-canary-routing.mjs');
  const hls = await import('../supabase/functions/_shared/media-gateway-hls-routing.mjs');
  const input = {
    defaultRoute: { url: 'https://main.example', token: 'd'.repeat(40) },
    canaryRoute: { url: 'https://pilot.example', token: 'c'.repeat(40), gatewayId: GATEWAY_ID },
    canaryUserHashes: '',
    ...overrides,
  };
  const routing = legacy.buildMediaGatewayRoutingConfig(input);
  const policy = (basisPoints) => hls.buildMediaGatewayHlsRoutingConfig({ basisPoints, routing });
  return { ...legacy, ...hls, routing, policy };
}

test('HLS balancing is opt-in and the policy contains no gateway credentials', async () => {
  const f = await fixture();
  for (const value of [undefined, null, '', '0', ' 0 ']) {
    const policy = f.policy(value);
    assert.deepEqual(policy, { protocol: 1, state: 'off', basisPoints: 0 });
    assert.equal(f.selectMediaGatewayHlsRoute(f.routing, policy, hashForBucket(0)), f.routing.defaultRoute);
    assert.ok(Object.isFrozen(policy));
  }
  assert.deepEqual(f.policy('5000'), { protocol: 1, state: 'ready', basisPoints: 5000 });
});

test('malformed HLS percentages fail closed without changing generic transport selection', async () => {
  const f = await fixture();
  for (const value of ['-1', '10001', '05000', '5e3', '5000x', 'NaN', '0.5', '+5000', true, 5000, {}, new String('5000')]) {
    const policy = f.policy(value);
    assert.equal(policy.state, 'invalid');
    assert.throws(() => f.selectMediaGatewayHlsRoute(f.routing, policy, hashForBucket(0)), UNAVAILABLE);
    assert.equal(f.selectMediaGatewayRouteForUserHash(f.routing, hashForBucket(0)), f.routing.defaultRoute);
  }
});

test('enabled balancing requires two complete and distinct gateway routes', async () => {
  for (const overrides of [
    { defaultRoute: null }, { canaryRoute: null },
    { canaryRoute: { url: 'https://pilot.example', token: 'short', gatewayId: GATEWAY_ID } },
    { canaryRoute: { url: 'https://pilot.example', token: 'c'.repeat(40), gatewayId: 'bad-id' } },
    { canaryRoute: { url: 'https://main.example/', token: 'c'.repeat(40), gatewayId: GATEWAY_ID } },
    { canaryUserHashes: 'not-a-hash' },
  ]) {
    const f = await fixture(overrides);
    assert.equal(f.policy('5000').state, 'invalid');
    assert.throws(() => f.selectMediaGatewayHlsRoute(f.routing, f.policy('5000'), hashForBucket(0)), UNAVAILABLE);
  }
});

test('5000 basis points selects exactly half the bucket space with a stable boundary', async () => {
  const f = await fixture();
  const policy = f.policy('5000');
  let pilot = 0;
  for (let bucket = 0; bucket < 10000; bucket++) {
    const route = f.selectMediaGatewayHlsRoute(f.routing, policy, hashForBucket(bucket));
    assert.equal(route.kind, bucket < 5000 ? 'canary' : 'default');
    pilot += Number(route.kind === 'canary');
  }
  assert.equal(pilot, 5000);
  assert.equal(f.selectMediaGatewayHlsRoute(f.routing, policy, hashForBucket(14999)).kind, 'canary');
  assert.equal(f.selectMediaGatewayHlsRoute(f.routing, policy, hashForBucket(15000)).kind, 'default');
});

test('routing remains stable across request ordering, replicas and restarts', async () => {
  const a = await fixture();
  const b = await fixture();
  const hashes = Array.from({ length: 250 }, (_, i) => hashForOwner(`synthetic-owner-${i}`));
  const selected = new Map(hashes.map((hash) => [hash, a.selectMediaGatewayHlsRoute(a.routing, a.policy('5000'), hash).kind]));
  for (const hash of hashes.reverse()) {
    assert.equal(b.selectMediaGatewayHlsRoute(b.routing, b.policy('5000'), hash).kind, selected.get(hash));
  }
});

test('increasing the percentage only moves newly covered buckets to the pilot', async () => {
  const f = await fixture();
  for (let bucket = 0; bucket < 10000; bucket++) {
    const hash = hashForBucket(bucket);
    const lower = f.selectMediaGatewayHlsRoute(f.routing, f.policy('2500'), hash);
    const higher = f.selectMediaGatewayHlsRoute(f.routing, f.policy('5000'), hash);
    if (lower.kind === 'canary') assert.equal(higher.kind, 'canary');
    assert.equal(f.selectMediaGatewayHlsRoute(f.routing, f.policy('10000'), hash).kind, 'canary');
  }
});

test('the existing private allowlist retains precedence, including after percentage rollback', async () => {
  const selected = hashForBucket(9999);
  const f = await fixture({ canaryUserHashes: selected });
  for (const bps of ['0', '5000']) {
    assert.equal(f.selectMediaGatewayHlsRoute(f.routing, f.policy(bps), selected).kind, 'canary');
    assert.equal(f.selectMediaGatewayRouteForUserHash(f.routing, selected).kind, 'canary');
  }
});

test('a broken explicit allowlist binding still fails closed even with balancing off', async () => {
  const selected = hashForBucket(9999);
  const f = await fixture({ canaryUserHashes: selected, canaryRoute: null });
  assert.equal(f.policy('0').state, 'off');
  assert.throws(() => f.selectMediaGatewayHlsRoute(f.routing, f.policy('0'), selected), UNAVAILABLE);
});

test('enabled balancing rejects missing or malformed authenticated hashes', async () => {
  const f = await fixture();
  for (const value of [null, undefined, '', '0'.repeat(63), 'g'.repeat(64), {}, 0]) {
    assert.throws(() => f.selectMediaGatewayHlsRoute(f.routing, f.policy('5000'), value), UNAVAILABLE);
  }
});

test('malformed policy objects cannot bypass the fail-closed selector', async () => {
  const f = await fixture();
  for (const policy of [null, {}, { state: 'ready', basisPoints: 5000 },
    { protocol: 1, state: 'ready', basisPoints: null },
    { protocol: 1, state: 'ready', basisPoints: 5000.1 },
    { protocol: 1, state: 'ready', basisPoints: 10001 },
    { protocol: 1, state: 'off', basisPoints: 5000 }]) {
    assert.throws(() => f.selectMediaGatewayHlsRoute(f.routing, policy, hashForBucket(0)), UNAVAILABLE);
  }
});

test('HLS percentage routing leaves native and raw legacy selections unchanged', async () => {
  const f = await fixture();
  const owner = hashForBucket(0);
  assert.equal(f.selectMediaGatewayHlsRoute(f.routing, f.policy('5000'), owner).kind, 'canary');
  assert.equal(f.selectMediaGatewayRouteForUserHash(f.routing, owner).kind, 'default');
  assert.equal(f.routing.defaultRoute.gatewayId, null);
  assert.equal(f.routing.canaryRoute.gatewayId, GATEWAY_ID);
});

test('rollback changes new HLS producers while existing sessions stay bound to their stored gateway', async () => {
  const f = await fixture();
  const owner = hashForBucket(0);
  const selected = f.selectMediaGatewayHlsRoute(f.routing, f.policy('5000'), owner);
  const storedSession = { gateway_id: selected.gatewayId, hls_url: `${selected.url}/hls/synthetic/index.m3u8` };
  assert.equal(f.selectMediaGatewayHlsRoute(f.routing, f.policy('0'), owner).kind, 'default');
  assert.equal(f.selectMediaGatewayRouteForGatewayId(f.routing, storedSession.gateway_id), selected);
  assert.ok(storedSession.hls_url.startsWith(selected.url));
  assert.equal(f.selectMediaGatewayRouteForGatewayId(f.routing, null), f.routing.defaultRoute);
  assert.equal(f.selectMediaGatewayRouteForGatewayId(f.routing, 'bad-id'), null);
});
