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

test('engine raw helper stays VOD-specific while live transport gets a 12-hour credential', async () => {
  const expiry = await import(expiryModuleUrl);
  assert.equal(
    expiry.engineRawTokenTtlSeconds({
      itemType: 'live',
      playbackHint: { durationSeconds: 6 * 60 * 60 },
      sessionTtlSeconds: 15 * 60,
    }),
    15 * 60,
  );

  for (const itemType of ['live', 'channel']) {
    assert.ok(
      expiry.playbackTransportTtlSeconds({
        itemType,
        sessionTtlSeconds: 15 * 60,
      }) >= 12 * 60 * 60,
      `${itemType} transport must survive a long viewing session`,
    );
  }
});

test('playback transport keeps VOD duration-aware and live independent from entitlement expiry', async () => {
  const expiry = await import(expiryModuleUrl);
  const nowMs = Date.parse('2026-07-20T12:00:00.000Z');

  assert.equal(expiry.DEFAULT_PLAYBACK_SESSION_TTL_SECONDS, 15 * 60);
  assert.equal(
    expiry.playbackTransportExpiresAt({
      nowMs,
      itemType: 'movie',
      playbackHint: { durationSeconds: 100 * 60 },
      sessionTtlSeconds: 15 * 60,
    }),
    '2026-07-20T14:40:00.000Z',
  );
  assert.ok(
    expiry.playbackTransportTtlSeconds({
      itemType: 'live',
      playbackHint: { durationSeconds: 100 * 60 },
      sessionTtlSeconds: 15 * 60,
    }) >= 12 * 60 * 60,
  );
  const channelTransportExpiry = expiry.playbackTransportExpiresAt({
    nowMs,
    itemType: 'channel',
    sessionTtlSeconds: 15 * 60,
  });
  assert.ok(
    Date.parse(channelTransportExpiry) - nowMs >= 12 * 60 * 60 * 1000,
  );
});

test('native fallback survives long live playback and remains duration-aware for VOD', async () => {
  const expiry = await import(expiryModuleUrl);
  const nowMs = Date.parse('2026-07-20T12:00:00.000Z');

  for (const itemType of ['live', 'channel']) {
    assert.ok(
      expiry.nativeFallbackTokenTtlSeconds({
        itemType,
        sessionTtlSeconds: 15 * 60,
      }) >= 12 * 60 * 60,
      `${itemType} native fallback must still be valid when a late direct-stream failure occurs`,
    );
  }
  assert.equal(
    expiry.nativeFallbackTokenExpiresAt({
      nowMs,
      itemType: 'movie',
      playbackHint: { codecProfile: { durationSeconds: 100 * 60 } },
      sessionTtlSeconds: 15 * 60,
    }),
    '2026-07-20T14:40:00.000Z',
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

test('norva-playback signs the dormant native fallback with its own transport expiry', () => {
  const source = fs.readFileSync(
    path.join(root, 'supabase', 'functions', 'norva-playback', 'index.ts'),
    'utf8',
  );
  const directStart = source.indexOf('if (mode === "direct")');
  const directEnd = source.indexOf('\n  if (mode === "relay")', directStart);
  assert.notEqual(directStart, -1);
  assert.notEqual(directEnd, -1);
  const directBranch = source.slice(directStart, directEnd);

  assert.match(
    source,
    /nativeFallbackTokenExpiresAt[\s\S]{0,160}from\s+["']\.\.\/_shared\/playback-expiry\.mjs["']/,
  );
  assert.match(directBranch, /fallbackExpiresAt = nativeFallbackTokenExpiresAt\(\{/);
  assert.match(directBranch, /playbackHint:\s*requestedPlaybackHint/);
  assert.match(directBranch, /sessionTtlSeconds:\s*ttlSeconds/);
  assert.match(
    directBranch,
    /createBytePipeAccess\(\s*session\.id,\s*userId,\s*targetUrl,\s*fallbackExpiresAt,/,
  );
  assert.match(directBranch, /fallbackUrl,\s*fallbackExpiresAt,\s*expiresAt,/);
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
  test(`${edgeFile} keeps entitlement and relay short while gateway gets the media transport expiry`, () => {
    const source = fs.readFileSync(
      path.join(root, 'supabase', 'functions', edgeFile, 'index.ts'),
      'utf8',
    );
    const start = source.indexOf('const ttlSeconds = boundedInt(');
    assert.notEqual(start, -1);
    const branch = source.slice(start, source.indexOf('\n  if (sourceId && gateway.startupMs)', start));

    assert.match(
      source,
      /playbackTransportExpiresAt[\s\S]{0,160}from\s+["']\.\.\/_shared\/playback-expiry\.mjs["']/,
    );
    assert.match(branch, /boundedInt\([^;]+900,\s*60,\s*7200\)/);
    assert.match(branch, /const expiresAt = new Date\(Date\.now\(\) \+ ttlSeconds \* 1000\)\.toISOString\(\)/);
    assert.match(
      branch,
      /const transportExpiresAt = playbackTransportExpiresAt\(\{\s*itemType,\s*playbackHint:\s*requestedPlaybackHint,\s*sessionTtlSeconds:\s*ttlSeconds,\s*\}\)/,
    );
    assert.match(branch, /expires_at:\s*expiresAt/);
    assert.match(
      branch,
      /const gatewayTransportExpiresAt = mode === "transcode"\s*\? transportExpiresAt\s*:\s*expiresAt/,
    );
    assert.match(
      branch,
      /createRelayAccess\(session\.id,\s*userId,\s*targetUrl,\s*expiresAt,/,
    );
    assert.match(branch, /tokenExpiresAt:\s*expiresAt/);
    assert.match(branch, /prepareEdgeSessionCoordinator\(\{[\s\S]*?expiresAt:\s*gatewayTransportExpiresAt/);
    assert.match(branch, /createGatewaySession\([\s\S]*?gatewayTransportExpiresAt/);
    assert.match(branch, /commitEdgeSessionCoordinator\([\s\S]*?expiresAt:\s*gatewayTransportExpiresAt/);
  });
}
