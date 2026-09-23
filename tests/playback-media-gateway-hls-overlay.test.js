const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const esbuild = require('esbuild');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const edgePath = path.join(root, 'supabase/functions/norva-playback/index.ts');
const production = fs.readFileSync(edgePath, 'utf8');
const sharedRoot = path.join(root, 'supabase/functions/_shared');
function productionFunction(name) {
  const start = production.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm'));
  assert.ok(start >= 0, `missing production function ${name}`);
  const rest = production.slice(start);
  const next = rest.slice(1).search(/^(?:async )?function /m);
  return next < 0 ? rest : rest.slice(0, next + 1);
}
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const GATEWAY_ID = 'a7250ec1-171b-4bcf-ad7d-41bac56130ec';
const env = {
  ENV_MEDIA_GATEWAY_URL: 'https://main.example',
  ENV_MEDIA_GATEWAY_TOKEN: 'd'.repeat(40),
  ENV_MEDIA_GATEWAY_CANARY_URL: 'https://pilot.example',
  ENV_MEDIA_GATEWAY_CANARY_TOKEN: 'c'.repeat(40),
  ENV_MEDIA_GATEWAY_CANARY_ID: GATEWAY_ID,
  ENV_MEDIA_GATEWAY_CANARY_USER_HASHES: '',
  ENV_MEDIA_GATEWAY_HLS_CANARY_BPS: null,
};

function region(source, start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `cannot extract ${start}`);
  return source.slice(a, b);
}

async function harness(overrides = {}) {
  const legacy = await import(pathToFileURL(path.join(sharedRoot, 'media-gateway-canary-routing.mjs')));
  const hls = await import(pathToFileURL(path.join(sharedRoot, 'media-gateway-hls-routing.mjs')));
  let now = 1000;
  const source = [
    ...['getRuntimeConfig', 'mediaGatewayRouteForPlaybackUser', 'mediaGatewayRouteForHlsPlaybackUser', 'mediaGatewayRouteForStoredSession'].map(productionFunction),
    'globalThis.functions = {getRuntimeConfig, mediaGatewayRouteForPlaybackUser, mediaGatewayRouteForHlsPlaybackUser, mediaGatewayRouteForStoredSession};',
  ].join('\n');
  const context = {
    ...Object.fromEntries([...source.matchAll(/\b(ENV_[A-Z_0-9]+)\b/g)].map(([name]) => [name, ''])),
    ...env, ...overrides, ...legacy, ...hls,
    runtimeConfigCache: null,
    RUNTIME_CONFIG_KEYS: ['NORVA_MEDIA_GATEWAY_HLS_CANARY_BPS'],
    Date: { now: () => now },
    console: { warn() {} },
    buildMediaCacheCanaryConfig: () => ({}),
    trimTrailingSlash: (value) => value.replace(/\/+$/, ''),
    boundedInt: (_value, fallback) => fallback,
    stringOrNull: (value) => typeof value === 'string' ? value : null,
    sha256Hex: async (value) => hash(value),
    HttpError: class HttpError extends Error {
      constructor(status, message, details) { super(message); this.status = status; this.details = details; }
    },
  };
  vm.runInNewContext(esbuild.transformSync(source, { loader: 'ts', target: 'es2022' }).code, context);
  return { ...context.functions, advance: (ms) => { now += ms; } };
}

function database(bps, unavailable = false) {
  let calls = 0;
  const api = {
    from(table) {
      assert.equal(table, 'cloud_runtime_config');
      return { select: () => ({ in: async (_key, keys) => {
        calls++;
        assert.ok(keys.includes('NORVA_MEDIA_GATEWAY_HLS_CANARY_BPS'));
        return { data: bps == null ? [] : [{ key: 'NORVA_MEDIA_GATEWAY_HLS_CANARY_BPS', value: bps }],
          error: unavailable ? { message: 'synthetic unavailable' } : null };
      } }) };
    },
    calls: () => calls,
  };
  return api;
}

test('production HLS session creation binds its selected gateway and returned HLS URL', () => {
  esbuild.transformSync(production, { loader: 'ts', target: 'es2022' });
  const create = productionFunction('createGatewaySession');
  assert.equal([...create.matchAll(/await mediaGatewayRouteForHlsPlaybackUser\(/g)].length, 1);
  assert.ok(/gateway_id:\s*gatewayRoute.gatewayId/.test(create));
  assert.ok(/hls_url:\s*stringOrNull\(gatewayBody.hlsUrl \?\? gatewayBody.hls_url\)/.test(create));
});
test('DB percentage activates the real HLS wrapper while the generic route stays unchanged', async () => {
  const h = await harness();
  const config = await h.getRuntimeConfig(database('5000'));
  let owner;
  for (let i = 0; i < 100; i++) {
    const sample = `synthetic-owner-${i}`;
    if (parseInt(hash(sample).slice(0, 8), 16) % 10000 < 5000) { owner = sample; break; }
  }
  assert.ok(owner);
  const selected = await h.mediaGatewayRouteForHlsPlaybackUser(config, owner);
  assert.equal(selected.kind, 'canary');
  assert.equal((await h.mediaGatewayRouteForPlaybackUser(config, owner)).kind, 'default');
  assert.equal(h.mediaGatewayRouteForStoredSession(config, { gateway_id: selected.gatewayId }).kind, 'canary');
});

test('DB read failure fails HLS closed with a sanitized 503 and preserves generic routing', async () => {
  const h = await harness();
  const config = await h.getRuntimeConfig(database(null, true));
  assert.equal(config.mediaGatewayHlsRouting.state, 'invalid');
  await assert.rejects(h.mediaGatewayRouteForHlsPlaybackUser(config, 'synthetic-owner'),
    (error) => error.status === 503 && error.details.code === 'MEDIA_GATEWAY_HLS_ROUTING_UNAVAILABLE');
  assert.equal((await h.mediaGatewayRouteForPlaybackUser(config, 'synthetic-owner')).kind, 'default');
});

test('missing DB key is disabled; explicit environment policy takes precedence', async () => {
  const defaultH = await harness();
  assert.equal((await defaultH.getRuntimeConfig(database(null))).mediaGatewayHlsRouting.state, 'off');
  for (const value of ['', '0', '5000']) {
    const h = await harness({ ENV_MEDIA_GATEWAY_HLS_CANARY_BPS: value });
    const config = await h.getRuntimeConfig(database('10000', true));
    assert.equal(config.mediaGatewayHlsRouting.state, value === '5000' ? 'ready' : 'off');
    assert.equal(config.mediaGatewayHlsRouting.basisPoints, value === '5000' ? 5000 : 0);
  }
});

test('runtime cache settles percentage rollback after 30 seconds without moving stored sessions', async () => {
  const h = await harness();
  const activeDb = database('10000');
  const config = await h.getRuntimeConfig(activeDb);
  const selected = await h.mediaGatewayRouteForHlsPlaybackUser(config, 'synthetic-owner');
  assert.equal(selected.kind, 'canary');
  const rollbackDb = database('0');
  assert.equal((await h.getRuntimeConfig(rollbackDb)).mediaGatewayHlsRouting.basisPoints, 10000);
  assert.equal(rollbackDb.calls(), 0);
  h.advance(30001);
  const reverted = await h.getRuntimeConfig(rollbackDb);
  assert.equal((await h.mediaGatewayRouteForHlsPlaybackUser(reverted, 'synthetic-owner')).kind, 'default');
  assert.equal(h.mediaGatewayRouteForStoredSession(reverted, { gateway_id: selected.gatewayId }).kind, 'canary');
  assert.equal(rollbackDb.calls(), 1);
});

test('invalid database percentage does not silently select a default HLS producer', async () => {
  const h = await harness();
  for (const invalid of ['broken', '10001']) {
    h.advance(30001);
    const config = await h.getRuntimeConfig(database(invalid));
    await assert.rejects(h.mediaGatewayRouteForHlsPlaybackUser(config, 'synthetic-owner'),
      (error) => error.status === 503);
  }
});
