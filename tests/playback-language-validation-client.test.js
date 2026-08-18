'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const cloudSource = fs.readFileSync(path.join(ROOT, 'public/js/cloudApi.js'), 'utf8');

function loadCloudClient(fetchImpl) {
  const accessToken = 'test-user-access-token-that-must-not-enter-json';
  const values = new Map([['norva-cloud-token', accessToken]]);
  const window = {
    location: { origin: 'https://norva.tv', search: '' },
    NORVA_PLAYBACK_URL: 'https://playback.test/functions/v1/norva-playback',
  };
  const context = vm.createContext({
    window,
    localStorage: {
      getItem: (key) => values.get(key) || null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
    },
    navigator: { userAgent: 'NorvaWeb', language: 'fr-FR', languages: ['fr-FR'] },
    document: { readyState: 'loading', addEventListener() {} },
    fetch: fetchImpl,
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
    Error,
    console: { log() {}, warn() {}, debug() {}, error() {} },
    performance: { now: () => 0 },
    setTimeout,
    clearTimeout,
  });
  window.window = window;
  vm.runInContext(cloudSource, context, { filename: 'public/js/cloudApi.js' });
  return { accessToken, window };
}

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'application/json' : null },
    json: async () => payload,
    text: async () => '',
  };
}

const body = {
  sourceId: 'source-public-id',
  itemType: 'movie',
  itemId: '90843',
  expectedAudioIndices: [1, 2],
};
const jobId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test('watched-file priority queues exactly one job without keeping the page in a poll loop', async () => {
  const requests = [];
  const { accessToken, window } = loadCloudClient(async (url, options) => {
    requests.push({ url, options });
    return jsonResponse(202, { protocol: 2, status: 'pending', jobId, retryAfter: 3 });
  });

  const result = await window.NorvaCloud.playback.queueLanguageValidation(body);

  assert.equal(result.status, 'pending');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.headers.Authorization, `Bearer ${accessToken}`);
  assert.deepEqual(JSON.parse(requests[0].options.body), body);
});

test('cached verification returns after one opaque POST without credentials in JSON', async () => {
  const requests = [];
  const { accessToken, window } = loadCloudClient(async (url, options) => {
    requests.push({ url, options });
    return jsonResponse(200, { protocol: 2, status: 'verified', audioTracks: [{ index: 1, language: 'fr' }] });
  });

  const result = await window.NorvaCloud.playback.validateLanguages(body);

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    'https://playback.test/functions/v1/norva-playback/playback/language-validation',
  );
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.headers.Authorization, `Bearer ${accessToken}`);
  assert.deepEqual(JSON.parse(requests[0].options.body), body);
  assert.equal(requests[0].options.body.includes(accessToken), false);
  assert.equal(requests[0].options.body.includes('providerToken'), false);
  assert.equal(result.status, 'verified');
});

test('202 job is polled on the playback route until verified', async () => {
  const requests = [];
  const replies = [
    [202, { protocol: 2, status: 'pending', jobId, retryAfter: 1 }],
    [202, { protocol: 2, status: 'pending', jobId, retryAfter: 1, completedTracks: 1, trackCount: 2 }],
    [200, { protocol: 2, status: 'verified', jobId, audioTracks: [{ index: 1, language: 'fr' }, { index: 2, language: 'en' }] }],
  ];
  const { accessToken, window } = loadCloudClient(async (url, options) => {
    requests.push({ url, options });
    const [status, payload] = replies.shift();
    return jsonResponse(status, payload);
  });

  const result = await window.NorvaCloud.playback.validateLanguages(body, {
    pollIntervalMs: 0,
    timeoutMs: 5000,
  });

  assert.equal(result.status, 'verified');
  assert.equal(requests.length, 3);
  assert.equal(requests[0].options.method, 'POST');
  for (const request of requests.slice(1)) {
    assert.equal(request.options.method, 'GET');
    assert.equal(
      request.url,
      `https://playback.test/functions/v1/norva-playback/playback/language-validation/${jobId}`,
    );
    assert.equal(request.options.headers.Authorization, `Bearer ${accessToken}`);
    assert.equal(request.options.body, undefined);
  }
});

test('terminal job status fails closed with its sanitized code', async () => {
  const replies = [
    [202, { protocol: 2, status: 'pending', jobId, retryAfter: 1 }],
    [200, { protocol: 2, status: 'failed', jobId, errorCode: 'PROVIDER_ACCOUNT_BUSY' }],
  ];
  const { window } = loadCloudClient(async () => {
    const [status, payload] = replies.shift();
    return jsonResponse(status, payload);
  });

  await assert.rejects(
    window.NorvaCloud.playback.validateLanguages(body, {
      pollIntervalMs: 0,
      timeoutMs: 5000,
    }),
    (error) => error?.code === 'PROVIDER_ACCOUNT_BUSY',
  );
});

test('a retry cursor beyond the bounded client deadline fails without unbounded polling', async () => {
  const requests = [];
  const retryAt = new Date(Date.now() + 60_000).toISOString();
  const { window } = loadCloudClient(async (url, options) => {
    requests.push({ url, options });
    return jsonResponse(202, { protocol: 2, status: 'pending', jobId, retryAfter: 30, retryAt });
  });

  await assert.rejects(
    window.NorvaCloud.playback.validateLanguages(body, {
      pollIntervalMs: 0,
      timeoutMs: 1000,
    }),
    (error) => error?.code === 'LANGUAGE_VALIDATION_RETRY_LATER',
  );
  assert.equal(requests.length, 1);
});

test('undeployed playback route fails closed without legacy fallback', async () => {
  const requests = [];
  const { window } = loadCloudClient(async (url, options) => {
    requests.push({ url, options });
    return jsonResponse(404, { error: 'not found' });
  });

  await assert.rejects(
    window.NorvaCloud.playback.validateLanguages(body),
    (error) => error?.code === 'LANGUAGE_VALIDATION_PROTOCOL_INVALID',
  );
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/norva-playback\/playback\/language-validation$/);
});

test('every success, pending and failed payload must use protocol 2 exactly', async () => {
  for (const payload of [
    { status: 'verified', audioTracks: [] },
    { protocol: 1, status: 'verified', audioTracks: [] },
    { protocol: '2', status: 'pending', jobId, retryAfter: 1 },
  ]) {
    const { window } = loadCloudClient(async () => jsonResponse(200, payload));
    await assert.rejects(
      window.NorvaCloud.playback.validateLanguages(body),
      (error) => error?.code === 'LANGUAGE_VALIDATION_PROTOCOL_INVALID',
    );
  }
});

test('sanitized protocol-2 quota rejection preserves only its bounded public code', async () => {
  const payload = {
    protocol: 2,
    status: 'failed',
    errorCode: 'LANGUAGE_VALIDATION_RATE_LIMITED',
    retryAfter: 30,
  };
  const { window } = loadCloudClient(async () => jsonResponse(429, payload));
  await assert.rejects(
    window.NorvaCloud.playback.validateLanguages(body),
    (error) => (
      error?.code === 'LANGUAGE_VALIDATION_RATE_LIMITED' &&
      error?.status === 429 &&
      error?.payload === payload
    ),
  );
});
