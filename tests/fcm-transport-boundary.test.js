'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const fcmPath = path.join(root, 'supabase', 'functions', '_shared', 'fcm.ts');

function jsonResponse(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fcmError(status, errorCode, message) {
  return jsonResponse({
    error: {
      code: status,
      status: errorCode,
      message,
      details: [{
        '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
        errorCode,
      }],
    },
  }, status);
}

test('FCM HTTP boundary sends the reviewed data-only payload and classifies provider responses', async () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const serviceAccount = JSON.stringify({
    client_email: 'lifecycle-test@norva-test.iam.gserviceaccount.com',
    private_key: privateKey,
    project_id: 'norva-test',
  });
  const calls = [];
  const providerResponses = [
    jsonResponse({ name: 'projects/norva-test/messages/provider-accepted-1' }, 200),
    fcmError(404, 'UNREGISTERED', 'Requested entity was not found.'),
    jsonResponse({
      error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded.' },
    }, 429),
  ];
  const previousDeno = globalThis.Deno;
  const previousFetch = globalThis.fetch;

  globalThis.Deno = {
    env: {
      get(name) {
        return name === 'FCM_SERVICE_ACCOUNT' ? serviceAccount : undefined;
      },
    },
  };
  globalThis.fetch = async (url, init = {}) => {
    const request = { url: String(url), init };
    calls.push(request);
    if (request.url === 'https://oauth2.googleapis.com/token') {
      return jsonResponse({ access_token: 'mock-access-token', expires_in: 3600 }, 200);
    }
    assert.equal(
      request.url,
      'https://fcm.googleapis.com/v1/projects/norva-test/messages:send',
    );
    const response = providerResponses.shift();
    assert.ok(response, 'unexpected extra FCM request');
    return response;
  };

  try {
    const moduleUrl = `${pathToFileURL(fcmPath).href}?transport-boundary=${Date.now()}`;
    const { sendFcmPush } = await import(moduleUrl);
    const deliveryId = '20000000-0000-4000-8000-000000000002';
    const deepLink = `https://norva.tv/app.html?mobile=1&lifecycleDelivery=${deliveryId}#settings/sources`;
    const reviewedMessage = {
      title: 'Connect your source',
      body: 'Add your M3U or Xtream access to continue.',
      dataOnly: true,
      data: {
        kind: 'behavioral_lifecycle',
        deliveryId,
        deepLink,
      },
      ttlSeconds: 30,
      collapseKey: 'lifecycle-no-source',
      analyticsLabel: 'lifecycle_no_source',
    };

    const accepted = await sendFcmPush('device-token-accepted', reviewedMessage);
    assert.deepEqual(accepted, {
      ok: true,
      status: 200,
      messageId: 'projects/norva-test/messages/provider-accepted-1',
    });

    const oauthCalls = calls.filter((call) => call.url === 'https://oauth2.googleapis.com/token');
    assert.equal(oauthCalls.length, 1, 'the OAuth token should be cached across the batch');
    assert.equal(oauthCalls[0].init.method, 'POST');
    assert.match(String(oauthCalls[0].init.body), /^grant_type=[^&]+&assertion=[^.]+\.[^.]+\.[^.]+$/);

    const firstFcm = calls.find((call) => call.url.includes('/messages:send'));
    assert.ok(firstFcm);
    assert.equal(firstFcm.init.method, 'POST');
    assert.equal(firstFcm.init.headers.Authorization, 'Bearer mock-access-token');
    const outbound = JSON.parse(firstFcm.init.body);
    assert.deepEqual(outbound, {
      message: {
        token: 'device-token-accepted',
        data: {
          title: reviewedMessage.title,
          body: reviewedMessage.body,
          kind: 'behavioral_lifecycle',
          deliveryId,
          deepLink,
        },
        android: {
          priority: 'high',
          ttl: '300s',
          collapse_key: 'lifecycle-no-source',
        },
        fcm_options: { analytics_label: 'lifecycle_no_source' },
      },
    });
    assert.equal(Object.hasOwn(outbound.message, 'notification'), false);
    const serialized = JSON.stringify(outbound);
    for (const secret of ['private_key', 'client_email', 'mock-access-token']) {
      assert.equal(serialized.includes(secret), false, `FCM payload leaked ${secret}`);
    }

    const dead = await sendFcmPush('device-token-dead', reviewedMessage);
    assert.equal(dead.ok, false);
    assert.equal(dead.status, 404);
    assert.equal(dead.unregistered, true);

    const throttled = await sendFcmPush('device-token-throttled', reviewedMessage);
    assert.equal(throttled.ok, false);
    assert.equal(throttled.status, 429);
    assert.equal(throttled.unregistered, false);
    assert.equal(
      calls.filter((call) => call.url === 'https://oauth2.googleapis.com/token').length,
      1,
      'provider failures must not force an OAuth exchange per device',
    );
    assert.equal(providerResponses.length, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousDeno === undefined) delete globalThis.Deno;
    else globalThis.Deno = previousDeno;
  }
});
