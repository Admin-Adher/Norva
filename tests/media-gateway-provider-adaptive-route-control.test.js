'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ProviderAdaptiveRouteControl,
} = require('../services/media-gateway/src/providerAdaptiveRouteControl.js');

const fingerprintKey = Buffer.alloc(32, 0xa5);
const sourceUrl = 'https://provider.example/movie/raw-user-needle/raw-secret-needle/42.mkv';

function response(payload, ok = true) {
  return {
    ok,
    json: async () => payload,
  };
}

function controller(overrides = {}) {
  return new ProviderAdaptiveRouteControl({
    enabled: true,
    httpProxyUrls: ['http://one', 'http://two'],
    socksProxyUrls: ['socks5://one', 'socks5://two'],
    fingerprintKey,
    edgeBase: 'https://api.example/functions/v1/norva-playback',
    gatewayToken: 'gateway-secret',
    lookupTimeoutMs: 200,
    slotIndexForKey: () => 1,
    ...overrides,
  });
}

test('disabled control preserves the existing sticky slot and preferred transport', async () => {
  let requests = 0;
  const control = controller({
    enabled: false,
    fetchImpl: async () => { requests += 1; },
  });
  const decision = await control.resolveForPlayback(sourceUrl, 'provider/account');

  assert.equal(requests, 0);
  assert.equal(decision.slot, 2);
  assert.equal(decision.nodeTransport, 'socks5');
  assert.equal(decision.ffmpegSlot, 2);
  assert.equal(control.publicStatus().active, false);
});

test('an explicit HTTP fallback keeps SOCKS5 available for adaptive decisions', async () => {
  const control = controller({
    fallbackNodeTransport: 'http',
    fetchImpl: async () => response({
      protocol: 1,
      enabled: true,
      apply: false,
      decision: {
        slot: 1,
        nodeTransport: 'socks5',
        score: 95,
        confidence: 0.95,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        selectionReason: 'host-learned',
      },
    }),
  });
  const decision = await control.resolveForPlayback(sourceUrl, 'provider/account');

  assert.equal(decision.id, '2:http');
  assert.equal(decision.selectionReason, 'shadow-mode');
  assert.equal(control.candidates.some((candidate) => candidate.id === '1:socks5'), true);
  assert.equal(control.publicStatus().fallbackNodeTransport, 'http');
});

test('viewer resolution sends only HMAC identities and non-secret route coordinates', async () => {
  let request = null;
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const control = controller({
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return response({
        protocol: 1,
        enabled: true,
        apply: true,
        decision: {
          slot: 1,
          nodeTransport: 'http',
          score: 88,
          confidence: 0.91,
          expiresAt,
          selectionReason: 'host-learned',
        },
      });
    },
  });
  const decision = await control.resolveForPlayback(sourceUrl, 'provider/account');

  assert.equal(decision.id, '1:http');
  assert.equal(decision.ffmpegSlot, 1);
  assert.equal(request.url.endsWith('/provider-route/resolve'), true);
  assert.equal(request.body.priority, 'viewer');
  assert.match(request.body.accountFingerprint, /^[0-9a-f]{64}$/);
  assert.match(request.body.hostFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(request.body.candidates.length, 4);
  const serialized = request.options.body;
  for (const forbidden of [
    'provider.example',
    'raw-user-needle',
    'raw-secret-needle',
    'http://one',
    'socks5://one',
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('shadow decisions are observed but cannot alter the live route', async () => {
  const control = controller({
    fetchImpl: async () => response({
      protocol: 1,
      enabled: true,
      apply: false,
      decision: {
        slot: 1,
        nodeTransport: 'http',
        score: 95,
        confidence: 0.95,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        selectionReason: 'host-learned',
      },
    }),
  });
  const decision = await control.resolveForPlayback(sourceUrl, 'provider/account');

  assert.equal(decision.id, '2:socks5');
  assert.equal(decision.selectionReason, 'shadow-mode');
  assert.equal(control.publicStatus().shadowAccounts, 1);
  assert.equal(control.publicStatus().appliedAccounts, 0);
});

test('an explicit canary switch applies the observed shadow route without changing the default', async () => {
  const control = controller({
    applyShadowForCanary: true,
    fetchImpl: async () => response({
      protocol: 1,
      enabled: true,
      apply: false,
      decision: {
        slot: 1,
        nodeTransport: 'http',
        score: 95,
        confidence: 0.95,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        selectionReason: 'host-learned',
      },
    }),
  });
  const decision = await control.resolveForPlayback(sourceUrl, 'provider/account');

  assert.equal(decision.id, '1:http');
  assert.equal(decision.controlStatus, 'canary-shadow-applied');
  assert.equal(decision.selectionReason, 'canary-host-learned');
  assert.equal(control.publicStatus().canaryShadowApply, true);
  assert.equal(control.publicStatus().shadowAccounts, 1);
  assert.equal(control.publicStatus().appliedAccounts, 1);
});

test('invalid, expired, unavailable, and timed-out control responses fail to the sticky route', async () => {
  const cases = [
    async () => response({ protocol: 2 }),
    async () => response({
      protocol: 1,
      enabled: true,
      apply: true,
      decision: {
        slot: 99,
        nodeTransport: 'socks5',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    }),
    async () => response({}, false),
    async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }),
  ];

  for (const fetchImpl of cases) {
    const control = controller({ fetchImpl, lookupTimeoutMs: 100 });
    const decision = await control.resolveForPlayback(sourceUrl, 'provider/account');
    assert.equal(decision.id, '2:socks5');
    assert.equal(decision.controlStatus, 'fallback');
  }
});

test('an already aborted viewer never installs a route decision', async () => {
  const abort = new AbortController();
  abort.abort(new Error('viewer left'));
  const control = controller({
    fetchImpl: async (_url, options) => {
      if (options.signal.aborted) throw options.signal.reason;
      return response({ protocol: 1 });
    },
  });
  const decision = await control.resolveForPlayback(sourceUrl, 'provider/account', {
    signal: abort.signal,
  });

  assert.equal(decision.selectionReason, 'playback-aborted');
  assert.equal(control.publicStatus().appliedAccounts, 0);
});

test('benchmark control and activity transmit hashes only, and a viewer preempts locally first', async () => {
  const requests = [];
  let preemptedAffinity = null;
  const control = controller({
    fetchImpl: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      if (url.endsWith('/provider-route/resolve')) {
        return response({ protocol: 1, enabled: true, apply: false, decision: null });
      }
      return response({ protocol: 1, ok: true, touched: 1, granted: false });
    },
  });
  control.setViewerPreemptHandler((affinity) => { preemptedAffinity = affinity; });
  await control.resolveForPlayback(sourceUrl, 'provider/account');
  const fingerprints = control.fingerprintsForAffinity('provider/account');
  await control.requestBenchmark('claim', {
    accountFingerprint: fingerprints.accountFingerprint,
    hostFingerprint: fingerprints.hostFingerprint,
    ownerInstanceFingerprint: 'c'.repeat(64),
  });
  await control.reportViewerActivity([fingerprints.accountFingerprint]);

  assert.equal(preemptedAffinity, 'provider/account');
  assert.equal(control.publicStatus().trackedAccounts, 1);
  assert.equal(requests.some((request) => request.url.endsWith('/provider-route/benchmark')), true);
  assert.equal(requests.some((request) => request.url.endsWith('/provider-route/activity')), true);
  const serialized = JSON.stringify(requests.slice(1));
  for (const forbidden of ['provider.example', 'raw-user-needle', 'raw-secret-needle']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});
