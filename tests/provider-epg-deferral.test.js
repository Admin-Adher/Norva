'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('supabase/functions/norva-cloud/index.ts', 'utf8');
const start = source.indexOf('async function requestGatewayXtreamEpg(');
const end = source.indexOf('\nasync function requestGatewayXmltv', start);
const gatewayFunction = source.slice(start, end).replace(/^async function requestGatewayXtreamEpg\([\s\S]*?\) \{/, 'async function requestGatewayXtreamEpg(runtimeConfig, body) {');

function gateway(status, payload) {
  class HttpError extends Error { constructor(status, message, details) { super(message); Object.assign(this, { status, details }); } }
  const context = { HttpError, stringOr: (s, fallback) => typeof s === 'string' ? s : fallback,
    recordOrEmpty: value => value && typeof value === 'object' ? value : {},
    fetch: async () => ({ status, ok: status === 200, json: async () => payload }) };
  vm.runInNewContext(gatewayFunction + '\nthis.call = requestGatewayXtreamEpg;', context);
  return () => context.call({ mediaGatewayUrl: 'https://gateway.example', mediaGatewayToken: 'fixture' }, {});
}

test('local admission conflicts become a safe deferred guide signal, not a provider rate limit', async () => {
  const { sanitizeCloudErrorDetails } = await import('../supabase/functions/_shared/cloud-public-view.mjs');
  for (const [status, code] of [[429, 'background_busy'], [409, 'account_busy'], [409, 'viewer_preempted']]) {
    await assert.rejects(gateway(status, { code, details: { serverUrl: 'secret.example', password: 'secret' } })(), error => {
      assert.equal(error.status, 409);
      assert.deepEqual(JSON.parse(JSON.stringify(error.details)), { code: 'GUIDE_DEFERRED' });
      assert.deepEqual(sanitizeCloudErrorDetails(error.details), { code: 'GUIDE_DEFERRED', retryable: true });
      return true;
    });
  }
});

test('real provider throttling remains terminal for the guide queue and success is unchanged', async () => {
  for (const code of ['PROVIDER_BUSY', 'user_multi_ip', 'unknown']) {
    await assert.rejects(gateway(429, { code })(), error => error.status === 429);
  }
  const guide = { epg_listings: [{ title: 'Programme' }] };
  assert.equal(await gateway(200, guide)(), guide);
});
