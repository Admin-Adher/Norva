'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const moduleUrl = pathToFileURL(path.join(
  __dirname,
  '..',
  'supabase',
  'functions',
  '_shared',
  'media-cache-canary.mjs',
)).href;

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const root = path.join(__dirname, '..');

test('media cache canary parser is fail closed and bounded', async () => {
  const { buildMediaCacheCanaryConfig } = await import(moduleUrl);
  assert.deepEqual(buildMediaCacheCanaryConfig(), {
    protocol: 1,
    state: 'off',
    stage: 'off',
    userHashes: [],
  });
  assert.equal(buildMediaCacheCanaryConfig({ userHashes: 'not-a-hash', stage: 'read' }).state, 'invalid');
  assert.equal(buildMediaCacheCanaryConfig({ userHashes: HASH_A, stage: 'unknown' }).state, 'invalid');
  assert.equal(buildMediaCacheCanaryConfig({ userHashes: HASH_A, stage: 'off' }).state, 'standby');
  const ready = buildMediaCacheCanaryConfig({ userHashes: `${HASH_A}, ${HASH_A} ${HASH_B}`, stage: 'read' });
  assert.equal(ready.state, 'ready');
  assert.deepEqual(ready.userHashes, [HASH_A, HASH_B]);
});

test('media cache canary stages only elevate selected users', async () => {
  const { buildMediaCacheCanaryConfig, mediaCacheFlagsForUser } = await import(moduleUrl);
  const stages = [
    ['read', { enabled: true, singleflight: false, liveJoin: false }],
    ['singleflight', { enabled: true, singleflight: true, liveJoin: false }],
    ['live-join', { enabled: true, singleflight: true, liveJoin: true }],
  ];
  for (const [stage, expected] of stages) {
    const config = buildMediaCacheCanaryConfig({ userHashes: HASH_A, stage });
    assert.deepEqual(mediaCacheFlagsForUser(config, HASH_A), { ...expected, selected: true });
    assert.deepEqual(mediaCacheFlagsForUser(config, HASH_B), {
      enabled: false,
      singleflight: false,
      liveJoin: false,
      selected: false,
    });
  }
});

test('global media cache rollout remains monotonic beside a canary', async () => {
  const {
    buildMediaCacheCanaryConfig,
    mediaCacheFlagsForUser,
    mediaCacheServiceFlags,
  } = await import(moduleUrl);
  const config = buildMediaCacheCanaryConfig({ userHashes: HASH_A, stage: 'read' });
  const global = { enabled: true, singleflight: true, liveJoin: true };
  assert.deepEqual(mediaCacheFlagsForUser(config, HASH_B, global), {
    enabled: true,
    singleflight: true,
    liveJoin: true,
    selected: false,
  });
  assert.deepEqual(mediaCacheServiceFlags(config), {
    enabled: true,
    singleflight: false,
    liveJoin: false,
  });
});

test('Edge and Hetzner wire the operator cohort without weakening Gateway authentication', () => {
  const edge = fs.readFileSync(path.join(root, 'supabase', 'functions', 'norva-playback', 'index.ts'), 'utf8');
  const compose = fs.readFileSync(path.join(root, 'ops', 'hetzner', 'docker-compose.supabase.yml'), 'utf8');
  for (const key of [
    'NORVA_MEDIA_CACHE_CANARY_USER_HASHES',
    'NORVA_MEDIA_CACHE_CANARY_STAGE',
  ]) {
    assert.match(edge, new RegExp(`"${key}"`));
    assert.match(compose, new RegExp(`${key}:`));
  }
  assert.match(compose, /NORVA_MEDIA_CACHE_CANARY_STAGE: \$\{NORVA_MEDIA_CACHE_CANARY_STAGE:-\}/);
  assert.match(edge, /mediaCacheRuntimeConfigForUser\([\s\S]*?sha256Hex\(userId\)/);
  assert.match(edge, /\.select\("gateway_id,user_id"\)[\s\S]*?mediaCacheRuntimeConfigForUser\(baseRuntimeConfig, userId\)[\s\S]*?MEDIA_CACHE_SINGLEFLIGHT_DISABLED/);
  assert.match(edge, /runMediaCachePublicationCallback[\s\S]*?requireConfiguredMediaGatewayCallback\(req, baseRuntimeConfig\)[\s\S]*?\.select\("id,user_id,playback_session_id,gateway_id,external_session_id,status"\)[\s\S]*?mediaCacheRuntimeConfigForUser\(baseRuntimeConfig, userId\)[\s\S]*?MEDIA_CACHE_DISABLED/);
  assert.match(edge, /privateMediaCacheDelivery:[\s\S]*?canary:[\s\S]*?selectedUsers:/);
});
