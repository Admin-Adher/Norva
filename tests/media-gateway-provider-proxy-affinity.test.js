'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const gatewayPath = path.join(root, 'services/media-gateway/src/index.js');
const gateway = fs.readFileSync(gatewayPath, 'utf8');
const proxyPool = require('../services/media-gateway/src/providerProxyPool.js');
const providerFailure = require('../services/media-gateway/src/providerFailure.js');

test('every Xtream route derives one decoded provider-account affinity key', () => {
  const expected = 'panel.example/alice+tv';
  const urls = [
    'https://PANEL.EXAMPLE:443/movie/alice%2Btv/movie-secret/42.mkv',
    'https://panel.example/series/alice%2Btv/series-secret/99.mp4',
    'https://panel.example/live/alice%2Btv/live-secret/7.ts',
    'https://panel.example/player_api.php?username=alice%2Btv&password=api-secret&action=get_series_info',
  ];

  for (const url of urls) {
    assert.equal(proxyPool.providerAccountAffinityKey(url), expected);
  }
  assert.equal(
    proxyPool.providerAccountAffinityKeyFromCredentials('https://PANEL.EXAMPLE:443/', 'alice+tv'),
    expected,
  );
});

test('password, media id, and Norva user identity cannot change proxy affinity', () => {
  const first = proxyPool.providerAccountAffinityKey(
    'http://panel.example:8080/movie/bob/first-secret/1.mkv',
  );
  const second = proxyPool.providerAccountAffinityKey(
    'http://panel.example:8080/series/bob/rotated-secret/999.mp4',
  );

  assert.equal(first, 'panel.example:8080/bob');
  assert.equal(second, first);
  assert.equal(proxyPool.providerAccountAffinityKey('https://panel.example/catalog.json'), 'panel.example');
});

test('literal percent sequences are decoded exactly once across path, query, and source credentials', () => {
  for (const literalUsername of ['%20alice', 'alice%2Fbob', '100%25', 'plus%2Buser']) {
    const encodedUsername = encodeURIComponent(literalUsername);
    const expected = `panel.example/${literalUsername}`;
    assert.equal(
      proxyPool.providerAccountAffinityKey(
        `https://panel.example/movie/${encodedUsername}/movie-secret/42.mkv`,
      ),
      expected,
    );
    assert.equal(
      proxyPool.providerAccountAffinityKey(
        `https://panel.example/player_api.php?username=${encodedUsername}&password=api-secret`,
      ),
      expected,
    );
    assert.equal(
      proxyPool.providerAccountAffinityKeyFromCredentials(
        'https://panel.example',
        literalUsername,
      ),
      expected,
    );
  }
});

test('the static pool accepts backward-compatible one-slot or the complete five-slot shape only', () => {
  assert.deepEqual(
    proxyPool.parseProviderProxyUrls('http://u:p@proxy-one.example:1000'),
    ['http://u:p@proxy-one.example:1000/'],
  );

  const five = Array.from(
    { length: proxyPool.STATIC_PROXY_SLOT_COUNT },
    (_, index) => `http://u:p@proxy-${index + 1}.example:1000`,
  ).join(',\n');
  assert.equal(proxyPool.parseProviderProxyUrls(five).length, 5);

  assert.throws(
    () => proxyPool.parseProviderProxyUrls(
      'http://u:p@proxy-one.example:1000,http://u:p@proxy-two.example:1000',
    ),
    /exactly 5 static proxy slots/i,
  );
});

test('legacy singular host:port:user:pass is normalized without exposing raw credential delimiters', () => {
  const [url] = proxyPool.parseProviderProxyUrls(
    'gateway.evomi.example:1000:static-user:p@ss:with/slash',
  );
  assert.equal(
    url,
    'http://static-user:p%40ss%3Awith%2Fslash@gateway.evomi.example:1000/',
  );
});

test('the five-entry pool preserves already percent-encoded proxy URLs', () => {
  const raw = Array.from(
    { length: 5 },
    (_, index) => `http://static-${index + 1}:p%40ss%3A${index + 1}@gateway.evomi.example:1000`,
  ).join('\n');
  const parsed = proxyPool.parseProviderProxyUrls(raw);

  assert.equal(parsed.length, 5);
  assert.equal(
    parsed[0],
    'http://static-1:p%40ss%3A1@gateway.evomi.example:1000/',
  );
  assert.equal(parsed.some((url) => url.includes('p@ss')), false);
});

test('five-slot assignment is deterministic, non-rotating, and distributes account keys', () => {
  const seen = new Set();
  for (let index = 0; index < 500; index += 1) {
    const key = `panel.example/account-${index}`;
    const first = proxyPool.stableProxySlotIndex(key, 5);
    const repeated = Array.from({ length: 8 }, () => proxyPool.stableProxySlotIndex(key, 5));
    assert.deepEqual(repeated, Array(8).fill(first));
    assert.ok(first >= 0 && first < 5);
    seen.add(first);
  }
  assert.deepEqual([...seen].sort(), [0, 1, 2, 3, 4]);
});

test('service-only slot overrides target one hashed provider account and leave every other account sticky', () => {
  const targetKey = 'panel.example/airysat-account';
  const otherKey = 'panel.example/other-account';
  const targetHash = proxyPool.providerAccountOverrideHash(targetKey);
  const overrides = proxyPool.parseProviderProxySlotOverrides(
    JSON.stringify({ [targetHash]: 4 }),
    proxyPool.STATIC_PROXY_SLOT_COUNT,
  );

  assert.match(targetHash, /^[0-9a-f]{64}$/);
  assert.equal(overrides.size, 1);
  assert.equal(proxyPool.proxySlotIndexForAccount(targetKey, 5, overrides), 3);
  assert.equal(
    proxyPool.proxySlotIndexForAccount(otherKey, 5, overrides),
    proxyPool.stableProxySlotIndex(otherKey, 5),
  );
  assert.equal(
    proxyPool.proxySlotIndexForAccount(targetKey, 5, new Map()),
    proxyPool.stableProxySlotIndex(targetKey, 5),
    'removing the env override must restore the original deterministic slot',
  );
});

test('slot override configuration is bounded and fails closed without leaking entries', () => {
  const validHash = 'a'.repeat(64);
  for (const invalid of [
    '{',
    '[]',
    JSON.stringify({ raw_provider_username: 2 }),
    JSON.stringify({ [validHash]: 0 }),
    JSON.stringify({ [validHash]: 6 }),
    JSON.stringify({ [validHash]: 1.5 }),
    JSON.stringify({ [validHash]: '2' }),
  ]) {
    assert.throws(
      () => proxyPool.parseProviderProxySlotOverrides(invalid, 5),
      (error) => {
        assert.match(String(error?.message || ''), /PROVIDER_PROXY_SLOT_OVERRIDES is invalid/);
        assert.doesNotMatch(String(error?.message || ''), /raw_provider_username|a{16}/);
        return true;
      },
    );
  }
  assert.throws(
    () => proxyPool.parseProviderProxySlotOverrides(JSON.stringify({ [validHash]: 2 }), 1),
    /requires the complete five-slot proxy pool/,
  );

  const tooMany = Object.fromEntries(
    Array.from({ length: 65 }, (_, index) => [index.toString(16).padStart(64, '0'), 1]),
  );
  assert.throws(
    () => proxyPool.parseProviderProxySlotOverrides(JSON.stringify(tooMany), 5),
    /PROVIDER_PROXY_SLOT_OVERRIDES is invalid/,
  );
});

test('proxy authentication failures stay distinct from provider slot-busy HTTP 458', () => {
  const undiciProxy407 = new TypeError('fetch failed', {
    cause: Object.assign(
      new Error('Proxy response (407) !== 200 when HTTP Tunneling'),
      { code: 'UND_ERR_ABORTED' },
    ),
  });

  assert.equal(providerFailure.isProxyAuthenticationFailure(undiciProxy407), true);
  assert.deepEqual(
    providerFailure.classifyProviderFetchFailure(undiciProxy407),
    { code: 'PROXY_AUTH_FAILED', category: 'proxy_auth' },
  );
  assert.deepEqual(
    providerFailure.classifyProviderResponseFailure(
      407,
      { error: 'Proxy Authentication Required' },
      { proxyConfigured: true },
    ),
    {
      status: 502,
      code: 'PROXY_AUTH_FAILED',
      publicMessage: 'The media service is temporarily unavailable.',
    },
  );
  assert.equal(
    providerFailure.classifyProviderResponseFailure(458, {}, { proxyConfigured: true }).code,
    'PROVIDER_BUSY',
  );
  assert.equal(
    providerFailure.isProxyAuthenticationFailure({
      message: 'proxy connect timeout to panel',
      lastError: 'Auth failed',
    }),
    false,
    'unrelated error fields must never combine into a proxy-auth signature',
  );
});

test('gateway uses the canonical provider key on every provider network lane', () => {
  assert.doesNotMatch(gateway, /pickProxyAgent\(claims\.uid\s*\|\|/);
  assert.doesNotMatch(gateway, /proxyEnvFor\(claims\.uid\s*\|\|/);
  assert.doesNotMatch(gateway, /proxyEnvFor\(proxyKey\s*\|\|/);
  assert.doesNotMatch(gateway, /proxyEnvFor\(session\.userId\s*\|\|/);

  assert.match(gateway, /const rawProxyAgent = pickProxyAgent\(pumpProxyKey\);/);
  assert.match(gateway, /dispatcher: rawProxyAgent \|\| undefined/);
  assert.match(
    gateway,
    /spawn\(FFMPEG_PATH, args, \{ stdio: \['ignore', 'ignore', 'pipe'\], env: proxyEnvFor\(proxyKeyFromUrl\(claims\.url\)\) \}\);/,
    'subtitle extraction must use the provider-account key',
  );
  assert.equal(
    gateway.match(/env: proxyEnvFor\(proxyKeyFromUrl\(url\)\)/g)?.length,
    5,
    'audio, audio chunks, storyboard, PGS OCR and frame OCR must each use the provider-account key',
  );
  assert.match(
    gateway,
    /spawn\(FFMPEG_PATH, args, \{ stdio: \['ignore', 'ignore', 'pipe'\], env: proxyEnvFor\(proxyKeyFromUrl\(session\.sourceUrl\)\) \}\);/,
    'session transcode must use the provider-account key',
  );
  assert.match(
    gateway,
    /spawn\(FFPROBE_PATH, args, \{[\s\S]{0,160}env: proxyEnvFor\(proxyKeyFromUrl\(sourceUrl\)\)/,
    'ffprobe must use the provider-account key',
  );
  assert.match(
    gateway,
    /dispatcher: pickProxyAgent\(proxyKeyFromUrl\(url\)\) \|\| undefined/,
    'metadata must use the provider-account key',
  );
  assert.match(
    gateway,
    /function pickProxyAgent\(key\) \{[\s\S]{0,120}poolIndexForKey\(key\)/,
    'HTTP lanes must resolve their operator override through the shared sticky slot selector',
  );
  assert.match(
    gateway,
    /function proxyEnvFor\(key\) \{[\s\S]{0,160}poolIndexForKey\(key\)/,
    'FFmpeg and FFprobe lanes must resolve the same targeted slot as HTTP',
  );
});

test('account activity reports the exact canonical affinity key without a second decode', () => {
  assert.doesNotMatch(gateway, /function decodeAccountKey\(/);
  assert.match(gateway, /return \[\.\.\.keys\]\.slice\(0, 64\);/);
});

test('gateway fails proxy 407 safely before provider 458 handling', () => {
  const proxyBranch = gateway.indexOf("code: 'PROXY_AUTH_FAILED'");
  const busyBranch = gateway.indexOf("code: 'PROVIDER_BUSY'", proxyBranch);
  assert.ok(proxyBranch >= 0, 'missing typed proxy-auth response');
  assert.ok(busyBranch > proxyBranch, 'proxy auth must be classified before provider busy');
  assert.match(gateway, /if \(isProxyAuthenticationFailure\(session\)\)/);
  assert.match(gateway, /if \(isProxyAuthenticationFailure\(session\)\) return false;/);
  assert.match(gateway, /upstream\.status === 407 && providerProxyAgents\.length/);
});

test('gateway advertises targeted operator override support without identities or secrets', () => {
  assert.match(gateway, /const GATEWAY_VERSION = 85;/);
  assert.match(gateway, /providerProxyAffinityProtocol:\s*1/);
  assert.match(gateway, /providerProxyAffinityKey:\s*'provider-account'/);
  assert.match(gateway, /providerProxySlotOverrideProtocol:\s*1/);
  assert.match(gateway, /providerProxySlotOverrideConfigured:\s*providerProxySlotOverrides\.size > 0/);
  assert.match(gateway, /process\.env\.PROVIDER_PROXY_SLOT_OVERRIDES/);
  assert.match(
    gateway,
    /return proxySlotIndexForAccount\(key, providerProxyAgents\.length, providerProxySlotOverrides\);/,
  );
  assert.doesNotMatch(gateway, /req\.(body|query|params)[\s\S]{0,120}PROVIDER_PROXY_SLOT_OVERRIDES/);
  assert.doesNotMatch(gateway, /console\.(log|warn|error)\([^\n]*providerProxySlotOverrides/);
  assert.doesNotMatch(gateway, /providerProxySlotOverrides[\s\S]{0,100}res\.json/);
  assert.doesNotMatch(gateway, /providerProxyUrls[\s\S]{0,100}res\.json/);
});
