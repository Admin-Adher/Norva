const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { stripTypeScriptTypes } = require('node:module');

const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/norva-playback/index.ts'), 'utf8');
const start = source.indexOf('async function createBytePipeCapability(');
const end = source.indexOf('function exactJsonKeys(', start);
assert.ok(start > 0 && end > start);
const code = stripTypeScriptTypes(source.slice(start, end));
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const routes = {
  main: { kind: 'default', url: 'http://gateway-main.internal:8080', token: 'main-test-secret' },
  pilot: { kind: 'canary', url: 'http://gateway-pilot.internal:8080', token: 'pilot-test-secret' },
};
const publicBases = { main: 'https://media.example.invalid', pilot: 'https://media.example.invalid/resume-cache-pilot/' };
const exactSession = '12345678-1234-4234-8234-123456789abc';
const target = 'https://provider.invalid/live/owned/channel.ts';
const expiry = '2026-09-30T20:00:00.000Z';

function harness(routeName, configuredPublic = publicBases[routeName]) {
  const selected = routes[routeName];
  const context = {
    URL, TextEncoder, encoder: new TextEncoder(),
    HttpError: class extends Error { constructor(status, message, details) { super(message); this.status = status; this.details = details; } },
    getRuntimeConfig: async () => ({ mediaGatewayRouting: { defaultRoute: selected } }),
    mediaGatewayRouteForPlaybackUser: async () => selected,
    sha256Hex: async value => digest(value),
    hmacBase64Url: async (secret, payload) => crypto.createHmac('sha256', secret).update(payload).digest('base64url'),
    base64Url: value => Buffer.from(value).toString('base64url'),
    Deno: { env: { get: name => ({
      NORVA_NATIVE_MP4_PUBLIC_BASE_URL: routeName === 'main' ? configuredPublic : 'https://wrong-main.invalid',
      NORVA_NATIVE_MP4_PILOT_PUBLIC_BASE_URL: routeName === 'pilot' ? configuredPublic : 'https://wrong-pilot.invalid',
    })[name] } },
  };
  return vm.runInNewContext(`${code}\n({createBytePipeAccess,createBytePipeCapability})`, context);
}

for (const routeName of ['main', 'pilot']) for (const prepared of [false, true]) {
  test(`client raw uses ${routeName} public ingress with ${prepared ? 'exact prepared' : 'legacy'} capability`, async () => {
    const api = harness(routeName);
    const generation = '11111111-1111-4111-8111-111111111111';
    const preparation = prepared ? { gatewayGenerations: { [digest(routes[routeName].url)]: generation } } : null;
    const args = [exactSession, 'owner', target, expiry, {}, 'native-agent', null, null, true, preparation];
    const internal = await api.createBytePipeAccess(...args);
    const external = await api.createBytePipeAccess(...args, true);
    assert.equal(new URL(external.url).origin, new URL(publicBases[routeName]).origin);
    assert.equal(new URL(internal.url).origin, routes[routeName].url);
    const ticket = external.url.split('/raw/')[1];
    assert.equal(external.url, publicBases[routeName].replace(/\/+$/, '') + '/raw/' + ticket,
      'the pilot public prefix must be preserved, not collapsed to the main origin');
    assert.equal(ticket, internal.url.split('/raw/')[1], 'only delivery ingress changes, never signed claims');
    const [encoded, signature] = ticket.split('.');
    const payload = Buffer.from(encoded, 'base64url').toString();
    assert.equal(signature, crypto.createHmac('sha256', routes[routeName].token).update(payload).digest('base64url'));
    const claims = JSON.parse(payload);
    assert.equal(claims.uid, 'owner'); assert.equal(claims.sid, exactSession);
    assert.equal(claims.url, target); assert.equal(claims.exp, Date.parse(expiry) / 1000);
    assert.equal(claims.preparationProtocol, prepared ? 1 : undefined);
    assert.equal(claims.preparationGatewayGeneration, prepared ? generation : undefined);
  });
}

test('internal worker URL stays private even without public ingress configuration', async () => {
  const api = harness('main', '');
  for (const job of ['transcribe-job','ocr-job','storyboard-job','transcribe-bench']) {
    const result = await api.createBytePipeAccess(job, 'owner', target, expiry, {}, null);
    assert.equal(new URL(result.url).origin, routes.main.url);
    assert.equal(JSON.parse(Buffer.from(result.url.split('/raw/')[1].split('.')[0], 'base64url')).sid, job);
  }
});

test('client URL fails closed on absent or invalid public ingress rather than exposing internal route', async () => {
  for (const invalid of ['', 'not a URL', 'http://media.example.invalid',
    'https://user:password@media.example.invalid', 'https://media.example.invalid?token=x',
    'https://media.example.invalid#fragment']) {
    const api = harness('pilot', invalid);
    await assert.rejects(api.createBytePipeAccess(exactSession, 'owner', target, expiry, {}, null, null, null, true, null, true),
      error => error.status === 503 && error.details.code === 'MEDIA_GATEWAY_PUBLIC_ROUTE_UNAVAILABLE'
        && !error.message.includes(routes.pilot.url));
  }
});

test('public delivery never bypasses exact preparation route-generation binding', async () => {
  const api = harness('pilot');
  const preparation = { gatewayGenerations: { [digest(routes.main.url)]: '11111111-1111-4111-8111-111111111111' } };
  await assert.rejects(api.createBytePipeAccess(exactSession, 'owner', target, expiry, {}, null, null, null, true, preparation, true),
    error => error.status === 409 && error.message === 'Live preparation route changed');
});

test('health advertises the loaded public raw delivery contract without changing existing version', () => {
  const healthStart = source.indexOf('version: 85,');
  assert.ok(healthStart >= 0);
  assert.match(source.slice(healthStart, healthStart + 120), /version:\s*85,\s*publicRawPlaybackProtocol:\s*1,/);
});
