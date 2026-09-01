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
