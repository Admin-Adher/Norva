'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const cloudSource = read('public/js/cloudApi.js');
const pageSource = read('public/js/pages/PartnersPage.js');
const settingsSource = read('public/js/pages/Settings.js');
const appSource = read('public/js/app.js');
const cssSource = read('public/css/main.css');

const relayToken = `v1.${'A'.repeat(43)}.${'a'.repeat(64)}`;
const handoffUrl = `https://norva.tv/app.html#relay=${relayToken}`;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function envelope(data) {
  return {
    version: '2026-07-29',
    correlationId: 'ptv_0123456789abcdef01234567',
    data,
  };
}

function loadCloudApi({ device = true, responder }) {
  const requests = [];
  const deviceToken = `nv_dev_${'D'.repeat(43)}`;
  const values = new Map(device
    ? [['norva-cloud-device-token', deviceToken]]
    : [
      ['norva-cloud-token', 'user-access-token'],
      ['norva-cloud-session', JSON.stringify({
        access_token: 'user-access-token',
        user: { id: '11111111-2222-4333-8444-555555555555' },
      })],
    ]);
  const localStorage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  const window = {
    NORVA_PARTNERS_API_URL: 'https://api.norva.tv/functions/v1/norva-partners',
    NORVA_PARTNERS_DEVICE_API_URL:
      'https://api.norva.tv/functions/v1/norva-partners-device',
    location: { origin: 'https://norva.tv', search: '', replace() {} },
  };
  const context = vm.createContext({
    window,
    localStorage,
    navigator: {
      userAgent: device ? 'NorvaTV-AndroidTV' : 'Norva web contract test',
      language: 'en-US',
      languages: ['en-US'],
    },
    document: { readyState: 'loading', addEventListener() {} },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 200,
        headers: {
          get: (name) => name.toLowerCase() === 'content-type'
            ? 'application/json'
            : null,
        },
        json: async () => clone(responder(url, options)),
        text: async () => '',
      };
    },
    URL,
    URLSearchParams,
    AbortController,
    Intl,
    Date,
    Map,
    Set,
    WeakMap,
    Promise,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    JSON,
    Math,
    console: { log() {}, warn() {}, debug() {}, error() {} },
    performance: { now: () => 0 },
    setTimeout,
    clearTimeout,
  });
  window.window = window;
  vm.runInContext(cloudSource, context, { filename: 'public/js/cloudApi.js' });
  return { cloud: window.NorvaCloud, requests, deviceToken };
}

test('paired TV uses the isolated device API with strict relay envelopes', async () => {
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  const responder = (url) => {
    if (url.endsWith('/availability')) {
      return envelope({
        schema_version: 1,
        availability: { enabled: true, reason: 'available' },
      });
    }
    if (url.endsWith('/relays')) {
      return envelope({
        schema_version: 1,
        action: 'tv_relay_created',
        relay: {
          status: 'pending',
          relay_token: relayToken,
          handoff_url: handoffUrl,
          expires_at: expiresAt,
          poll_after_seconds: 3,
        },
      });
    }
    if (url.endsWith('/relays/status')) {
      return envelope({
        schema_version: 1,
        relay: {
          status: 'consumed',
          destination: 'partners',
          poll_after_seconds: 3,
        },
      });
    }
    throw new Error(`unexpected request ${url}`);
  };
  const { cloud, requests, deviceToken } = loadCloudApi({
    device: true,
    responder,
  });

  const availability = await cloud.partners.device.availability();
  const created = await cloud.partners.device.createRelay({
    idempotencyKey: 'norva.tv-relay.0123456789abcdef',
  });
  const status = await cloud.partners.device.relayStatus({ relayToken });

  assert.equal(availability.data.availability.enabled, true);
  assert.equal(created.data.relay.handoff_url, handoffUrl);
  assert.equal(status.data.relay.status, 'consumed');
  assert.equal(Object.isFrozen(created.data.relay), true);
  assert.equal(requests.length, 3);
  assert.equal(
    requests[0].url,
    'https://api.norva.tv/functions/v1/norva-partners-device/availability',
  );
  for (const request of requests) {
    assert.equal(request.options.headers.Authorization, `Bearer ${deviceToken}`);
    assert.equal(request.options.headers['x-norva-profile-id'], undefined);
  }
  assert.equal(requests[1].options.headers['Idempotency-Key'],
    'norva.tv-relay.0123456789abcdef');
  assert.deepEqual(JSON.parse(requests[1].options.body), {});
  assert.deepEqual(JSON.parse(requests[2].options.body), { relayToken });
});

test('relay handoff and destination are exact; drift fails closed', async () => {
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  for (const mutate of [
    (payload) => { payload.data.relay.handoff_url = `https://evil.example/#relay=${relayToken}`; },
    (payload) => { payload.data.relay.handoff_url = 'https://norva.tv/app.html'; },
    (payload) => { payload.data.relay.relay_token = `v1.${'B'.repeat(43)}.${'b'.repeat(64)}`; },
    (payload) => { payload.data.relay.poll_after_seconds = 30; },
    (payload) => { payload.data.extra = true; },
  ]) {
    const payload = envelope({
      schema_version: 1,
      action: 'tv_relay_created',
      relay: {
        status: 'pending',
        relay_token: relayToken,
        handoff_url: handoffUrl,
        expires_at: expiresAt,
        poll_after_seconds: 3,
      },
    });
    mutate(payload);
    const { cloud } = loadCloudApi({
      device: true,
      responder: () => payload,
    });
    await assert.rejects(
      cloud.partners.device.createRelay({
        idempotencyKey: 'norva.tv-relay.0123456789abcdef',
      }),
      (error) => error?.code === 'partners_contract_invalid',
    );
  }
});

test('authenticated phone consumes one relay through the user boundary', async () => {
  const { cloud, requests } = loadCloudApi({
    device: false,
    responder: () => envelope({
      schema_version: 1,
      action: 'tv_relay_consumed',
      replayed: false,
      relay: { status: 'consumed', destination: 'partners' },
    }),
  });
  const result = await cloud.partners.consumeTvRelay({
    relayToken,
    idempotencyKey: 'norva.tv-relay.0123456789abcdef',
  });

  assert.equal(result.data.action, 'tv_relay_consumed');
  assert.equal(
    requests[0].url,
    'https://api.norva.tv/functions/v1/norva-partners/tv-relays/consume',
  );
  assert.equal(requests[0].options.headers.Authorization, 'Bearer user-access-token');
  assert.equal(requests[0].options.headers['Idempotency-Key'],
    'norva.tv-relay.0123456789abcdef');
  assert.deepEqual(JSON.parse(requests[0].options.body), { relayToken });
});

test('TV Partners journey is feature-gated, temporary, QR-only and D-pad ready', () => {
  assert.match(pageSource, /canUseTvPartners\(\)/);
  assert.match(pageSource, /partners\.device\.availability/);
  assert.match(pageSource, /partners\.device\.createRelay/);
  assert.match(pageSource, /partners\.device\.relayStatus/);
  assert.match(pageSource, /data-partners-tv-qr/);
  assert.match(pageSource, /qr\.addData\(relay\.handoff_url\)/);
  assert.match(pageSource, /poll_after_seconds/);
  assert.match(pageSource, /renderTvRelayConnected/);
  assert.match(pageSource, /renderTvRelayExpired/);
  assert.doesNotMatch(pageSource, /relay_token[\s\S]{0,120}<code>/);
  assert.match(settingsSource, /if \(!user\.cloud\)/);
  assert.match(appSource, /page\?\.canUsePartners\?\.\(\)/);
  assert.match(cssSource, /html\.tv-mode \.partners-tv-shell button:focus/);
  assert.match(cssSource, /\.partners-tv-shell \.btn\s*\{[\s\S]{0,100}min-height:\s*52px/);
});

test('phone captures a fragment relay before auth redirect and never persists it locally', () => {
  assert.match(appSource, /this\._pendingPartnersTvRelay = this\.capturePartnersTvRelay\(\)/);
  assert.match(appSource, /sessionStorage\.setItem\([\s\S]{0,160}NORVA_PARTNERS_TV_RELAY_SESSION_KEY/);
  assert.match(appSource, /window\.history\.replaceState\([\s\S]{0,180}#partners/);
  assert.match(appSource, /void this\.consumePendingPartnersTvRelay\(\)/);
  assert.match(appSource, /NorvaCloud\.partners\.consumeTvRelay/);
  assert.doesNotMatch(
    appSource,
    /localStorage\.setItem\([^,\n]*(?:RELAY|relay)[^,\n]*,/,
  );
  assert.match(appSource, /Date\.now\(\) - capturedAt > NORVA_PARTNERS_TV_RELAY_CLIENT_TTL_MS/);
});
