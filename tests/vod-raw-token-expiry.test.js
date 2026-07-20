const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const expiryModuleUrl = pathToFileURL(path.join(
  root,
  'supabase',
  'functions',
  '_shared',
  'playback-expiry.mjs',
)).href;

test('VOD engine raw token survives the first post-15-minute range', async () => {
  const expiry = await import(expiryModuleUrl);
  const ttl = expiry.engineRawTokenTtlSeconds({
    itemType: 'movie',
    playbackHint: { codecProfile: { durationSeconds: 100 * 60 } },
    sessionTtlSeconds: 15 * 60,
  });

  assert.equal(ttl, 160 * 60);
  assert.ok(ttl > 15 * 60);
});

test('long VOD gets its full duration plus pause margin', async () => {
  const expiry = await import(expiryModuleUrl);
  const movieTtl = expiry.engineRawTokenTtlSeconds({
    itemType: 'movie',
    playbackHint: { codec_profile: { duration_seconds: 4 * 60 * 60 } },
    sessionTtlSeconds: 15 * 60,
  });
  const seriesTtl = expiry.engineRawTokenTtlSeconds({
    itemType: 'series',
    playbackHint: { codecProfile: { durationSeconds: 3 * 60 * 60 } },
    sessionTtlSeconds: 15 * 60,
  });

  assert.equal(movieTtl, 5 * 60 * 60);
  assert.equal(seriesTtl, 4 * 60 * 60);
});

test('unknown-duration VOD is usable but raw credential lifetime stays bounded', async () => {
  const expiry = await import(expiryModuleUrl);

  assert.equal(
    expiry.engineRawTokenTtlSeconds({
      itemType: 'series',
      playbackHint: {},
      sessionTtlSeconds: 15 * 60,
    }),
    4 * 60 * 60,
  );
  assert.equal(
    expiry.engineRawTokenTtlSeconds({
      itemType: 'movie',
      playbackHint: { durationSeconds: 20 * 60 * 60 },
      sessionTtlSeconds: 15 * 60,
    }),
    8 * 60 * 60,
  );
});

test('raw lifetime extension is restricted to VOD engine callers', async () => {
  const expiry = await import(expiryModuleUrl);
  assert.equal(
    expiry.engineRawTokenTtlSeconds({
      itemType: 'live',
      playbackHint: { durationSeconds: 6 * 60 * 60 },
      sessionTtlSeconds: 15 * 60,
    }),
    15 * 60,
  );
});

test('gateway VOD transport shares the bounded duration-aware policy', async () => {
  const expiry = await import(expiryModuleUrl);
  const nowMs = Date.parse('2026-07-20T12:00:00.000Z');

  assert.equal(
    expiry.vodTransportExpiresAt({
      nowMs,
      itemType: 'movie',
      playbackHint: { durationSeconds: 100 * 60 },
      sessionTtlSeconds: 15 * 60,
    }),
    '2026-07-20T14:40:00.000Z',
  );
  assert.equal(
    expiry.vodTransportTtlSeconds({
      itemType: 'live',
      playbackHint: { durationSeconds: 100 * 60 },
      sessionTtlSeconds: 15 * 60,
    }),
    15 * 60,
  );
});

test('edge keeps session expiry short while signing VOD engine raw URL with its own expiry', () => {
  const source = fs.readFileSync(
    path.join(root, 'supabase', 'functions', 'norva-playback', 'index.ts'),
    'utf8',
  );
  const engineStart = source.indexOf('if (body.enginePipe === true || body.engine_pipe === true)');
  const engineEnd = source.indexOf('\n    const relay = await createRelayAccess(', engineStart);
  assert.notEqual(engineStart, -1);
  assert.notEqual(engineEnd, -1);
  const engineBranch = source.slice(engineStart, engineEnd);

  assert.match(engineBranch, /const rawTokenExpiresAt = engineRawTokenExpiresAt\(\{/);
  assert.match(
    engineBranch,
    /createBytePipeAccess\(\s*session\.id,\s*userId,\s*targetUrl,\s*rawTokenExpiresAt,/,
  );
  assert.match(engineBranch, /tokenExpiresAt: rawTokenExpiresAt/);
  assert.match(engineBranch, /sessionExpiresAt: expiresAt/);
  assert.match(
    engineBranch,
    /prepareEdgeSessionCoordinator\(\{[\s\S]*?expiresAt:\s*rawTokenExpiresAt,/,
  );
  assert.match(
    engineBranch,
    /commitEdgeSessionCoordinator\([\s\S]*?expiresAt:\s*rawTokenExpiresAt,/,
  );
  assert.match(source, /const ttlSeconds = boundedInt\([^;]+900,\s*60,\s*7200\)/);
  assert.match(source, /expires_at: expiresAt/);
});

test('gateway /raw accepts a valid duration-aware expiration beyond 15 minutes', () => {
  const gateway = fs.readFileSync(
    path.join(root, 'services', 'media-gateway', 'src', 'index.js'),
    'utf8',
  );
  const rawStart = gateway.indexOf("app.get('/raw/:token'");
  const rawEnd = gateway.indexOf("\n// Subtitle support", rawStart);
  assert.notEqual(rawStart, -1);
  assert.notEqual(rawEnd, -1);
  const rawRoute = gateway.slice(rawStart, rawEnd);

  assert.match(rawRoute, /verifyRawToken\(req\.params\.token, GATEWAY_TOKEN\)/);
  assert.match(
    rawRoute,
    /Number\(claims\.exp\) \* 1000 < Date\.now\(\)/,
  );
  assert.doesNotMatch(rawRoute, /claims\.exp[^;\n]*(?:900|15\s*\*\s*60)/);

  const now = Date.now();
  const durationAwareClaims = { exp: Math.floor((now + 5 * 60 * 60 * 1000) / 1000) };
  assert.equal(Number(durationAwareClaims.exp) * 1000 < now, false);
});

for (const edgeFile of ['norva-playback', 'norva-cloud']) {
  test(`${edgeFile} keeps entitlement short and gives VOD gateway/coordinator the transport expiry`, () => {
    const source = fs.readFileSync(
      path.join(root, 'supabase', 'functions', edgeFile, 'index.ts'),
      'utf8',
    );
    const start = source.indexOf('const gatewayTransportExpiresAt = mode === "transcode"');
    assert.notEqual(start, -1);
    const branch = source.slice(start, source.indexOf('\n  if (sourceId && gateway.startupMs)', start));

    assert.match(branch, /vodTransportExpiresAt\(\{/);
    assert.match(branch, /playbackHint:\s*requestedPlaybackHint/);
    assert.match(branch, /expires_at:\s*expiresAt/);
    assert.match(branch, /prepareEdgeSessionCoordinator\(\{[\s\S]*?expiresAt:\s*gatewayTransportExpiresAt/);
    assert.match(branch, /createGatewaySession\([\s\S]*?gatewayTransportExpiresAt/);
    assert.match(branch, /commitEdgeSessionCoordinator\([\s\S]*?expiresAt:\s*gatewayTransportExpiresAt/);
  });
}
