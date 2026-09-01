'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const CLOUD_PATH = path.join(ROOT, 'supabase/functions/norva-cloud/index.ts');
const CLOUD_PUBLIC_PATH = path.join(ROOT, 'supabase/functions/_shared/cloud-public-view.mjs');
const CLOUD = fs.readFileSync(CLOUD_PATH, 'utf8').replace(/\r\n/g, '\n');
const CLOUD_PUBLIC = fs.readFileSync(CLOUD_PUBLIC_PATH, 'utf8').replace(/\r\n/g, '\n');

function section(start, end) {
  const from = CLOUD.indexOf(start);
  assert.notEqual(from, -1, `missing section: ${start}`);
  const to = end ? CLOUD.indexOf(end, from + start.length) : CLOUD.length;
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return CLOUD.slice(from, to);
}

test('cloud row projections are private-by-default', async () => {
  const publicView = await import(pathToFileURL(CLOUD_PUBLIC_PATH).href);
  const selects = [
    publicView.PROFILE_PUBLIC_SELECT,
    publicView.DEVICE_PUBLIC_SELECT,
    publicView.MEDIA_ITEM_PUBLIC_SELECT,
    publicView.FAVORITE_PUBLIC_SELECT,
    publicView.WATCH_HISTORY_PUBLIC_SELECT,
    publicView.PLAYBACK_EVENT_PUBLIC_SELECT,
    publicView.PAIRING_PUBLIC_SELECT,
    publicView.CAST_COMMAND_PUBLIC_SELECT,
    publicView.PLAYBACK_SESSION_PUBLIC_SELECT,
  ];

  for (const select of selects) {
    assert.doesNotMatch(
      select,
      /(?:^|,)(?:user_id|config_ciphertext|credentials|public_key|error_message|target_url|target_url_hash)(?:,|$)/,
    );
  }
  assert.doesNotMatch(CLOUD_PUBLIC, /select\s*\(\s*['"]\*['"]\s*\)/);

  const listMedia = section('async function listMediaItems(', 'async function getXtreamSeriesInfo(');
  assert.match(listMedia, /\.select\(MEDIA_ITEM_PUBLIC_SELECT\)/);
  assert.match(listMedia, /\.map\(sanitizeMediaItem\)/);
  assert.doesNotMatch(listMedia, /\.select\("\*"\)/);

  const upsertMedia = section('async function upsertMediaItems(', 'async function listFavorites(');
  assert.match(upsertMedia, /\.select\(MEDIA_ITEM_PUBLIC_SELECT\)/);
  assert.match(upsertMedia, /\.map\(sanitizeMediaItem\)/);
  assert.doesNotMatch(upsertMedia, /\.select\("\*"\)/);
});

test('representative cloud payloads strip account ids, credentials, ciphertext and raw errors', async () => {
  const publicView = await import(pathToFileURL(CLOUD_PUBLIC_PATH).href);
  const privateFields = {
    user_id: 'account-secret-id',
    config_ciphertext: 'ciphertext-secret',
    username: 'provider-user-secret',
    password: 'provider-password-secret',
    public_key: 'device-public-key-secret',
    error: 'raw-provider-error-secret',
    error_message: 'raw-database-error-secret',
    credentials: { token: 'nested-credential-secret' },
  };

  const payloads = [
    publicView.sanitizeCloudProfile({ ...privateFields, display_name: 'Living room' }),
    publicView.sanitizeCloudDevice({
      ...privateFields,
      id: 'device-id',
      capabilities: { cast: true, username: 'provider-user-secret', token: 'nested-credential-secret' },
    }),
    publicView.sanitizeMediaItem({
      ...privateFields,
      id: 'media-id',
      title: 'Movie',
      metadata: {
        categoryName: 'Drama',
        username: 'provider-user-secret',
        providerUrl: 'https://provider.example/player_api.php?token=nested-credential-secret',
        error: 'raw-provider-error-secret',
      },
      playback_hint: {
        container: 'mkv',
        targetUrl: 'https://provider.example/private/nested-credential-secret',
        credentials: { password: 'provider-password-secret' },
      },
    }),
    publicView.sanitizeFavorite({
      ...privateFields,
      id: 'favorite-id',
      item_meta: { type: 'movie', username: 'provider-user-secret', error: 'raw-provider-error-secret' },
    }),
    publicView.sanitizeWatchHistory({
      ...privateFields,
      id: 'history-id',
      data: {
        title: 'Movie',
        username: 'provider-user-secret',
        providerResponse: 'raw-provider-error-secret',
        credentials: { password: 'provider-password-secret' },
      },
    }),
    publicView.sanitizePlaybackEvent({ ...privateFields, id: 'event-id', event_type: 'first_frame' }),
    publicView.sanitizePairing({ ...privateFields, id: 'pair-id', code: '123456' }),
    publicView.sanitizeCastCommand({
      ...privateFields,
      id: 'command-id',
      status: 'pending',
      payload: {
        route: '/watch',
        username: 'provider-user-secret',
        credentials: { token: 'nested-credential-secret' },
        error: 'raw-provider-error-secret',
      },
    }),
    publicView.sanitizePlaybackSession({
      ...privateFields,
      id: 'session-id',
      status: 'failed',
      playback_hint: { container: 'mkv', username: 'provider-user-secret' },
      cloud_gateway_sessions: [{
        id: 'gateway-id',
        status: 'failed',
        external_session_id: 'nested-credential-secret',
        error_message: 'raw-provider-error-secret',
      }],
    }),
  ];

  const serialized = JSON.stringify(payloads);
  for (const forbidden of [
    '"user_id"',
    'config_ciphertext',
    'account-secret-id',
    'ciphertext-secret',
    'provider-user-secret',
    'provider-password-secret',
    'device-public-key-secret',
    'nested-credential-secret',
    'raw-provider-error-secret',
    'raw-database-error-secret',
    'player_api.php',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `public payload leaked ${forbidden}`);
  }
});

test('top-level error details and logs reject arbitrary provider codes', async () => {
  const { sanitizeCloudErrorDetails } = await import(pathToFileURL(CLOUD_PUBLIC_PATH).href);
  assert.deepEqual(
    sanitizeCloudErrorDetails({
      code: 'SECRETLOOKINGTOKEN_4D1F01A7',
      correlationId: 'request_123',
      message: 'database body secret',
      provider: { token: 'nested secret' },
    }),
    { correlationId: 'request_123' },
  );
  assert.deepEqual(
    sanitizeCloudErrorDetails({ code: 'PROVIDER_BUSY', correlation_id: 'gateway_42' }),
    { code: 'PROVIDER_BUSY', correlationId: 'gateway_42' },
  );
  assert.deepEqual(sanitizeCloudErrorDetails({ code: 'PROVIDER_BUSY', correlationId: 'x'.repeat(81) }), {
    code: 'PROVIDER_BUSY',
  });

  const payload = section('function publicErrorPayload(', 'function publicErrorLog(');
  const log = section('function publicErrorLog(', 'function copyString(');
  assert.match(payload, /sanitizeCloudErrorDetails\(detailRecord\)/);
  assert.match(payload, /status >= 500[\s\S]*Norva Cloud is temporarily unavailable/);
  assert.doesNotMatch(payload, /detailRecord\.(?:message|details|provider)/);
  assert.match(log, /sanitizeCloudErrorDetails\(rawDetails\)/);
  assert.match(log, /code: safeDetails\.code/);
  assert.doesNotMatch(log, /\^\[A-Za-z0-9_-/);
});

test('source connection checks expose only fixed success and failure contracts', async () => {
  const sourceViewPath = path.join(ROOT, 'supabase/functions/_shared/source-public-view.mjs');
  const { sanitizeSourceConnectionResult } = await import(pathToFileURL(sourceViewPath).href);
  assert.deepEqual(sanitizeSourceConnectionResult({
    success: true,
    status: 'https://provider.example/live/user/password/42.ts?token=secret',
    checkedAt: '2026-08-23T01:02:03Z',
  }), {
    success: true,
    status: 'reachable',
    checkedAt: '2026-08-23T01:02:03.000Z',
  });
  assert.deepEqual(sanitizeSourceConnectionResult({
    success: false,
    status: 599,
    code: 'TOKEN_https_provider_secret',
    checkedAt: '2026-08-23T01:02:03Z',
  }), {
    success: false,
    code: 'PROVIDER_REQUEST_FAILED',
    status: 502,
    error: 'Norva could not reach this TV service.',
    checkedAt: '2026-08-23T01:02:03.000Z',
  });
  assert.deepEqual(sanitizeSourceConnectionResult({
    success: false,
    status: 458,
    code: 'ARBITRARY_PROVIDER_VALUE',
  }), {
    success: false,
    code: 'PROVIDER_BUSY',
    status: 458,
    error: 'This TV service is busy. Wait a few seconds, then try again.',
  });
  assert.deepEqual(sanitizeSourceConnectionResult({
    success: false,
    status: 503,
    code: 'PROVIDER_DIRECT_FALLBACK_RETRYABLE',
    reason: 'transition_active',
    username: 'provider-user',
  }), {
    success: false,
    code: 'PROVIDER_DIRECT_FALLBACK_RETRYABLE',
    status: 503,
    error: 'Norva could not reach this TV service.',
  });
  assert.deepEqual(sanitizeSourceConnectionResult({
    success: false,
    status: 409,
    code: 'SOURCE_CONFIG_REVISION_CHANGED',
    configCiphertextHash: 'secret-proof',
  }), {
    success: false,
    code: 'SOURCE_CONFIG_REVISION_CHANGED',
    status: 409,
    error: 'Norva could not reach this TV service.',
  });

  const connection = section('async function testSourceConnection(', '\n// Per-source sync status');
  assert.match(connection, /sanitizeSourceConnectionResult\(/);
  assert.match(connection, /const assertSourceCurrent = \(\) => assertSourceConfigRevisionCurrent/);
  assert.match(connection, /validateCloudSource[\s\S]*await assertSourceCurrent\(\);[\s\S]*success: true/);
  assert.doesNotMatch(connection, /validation\.status/);
  assert.doesNotMatch(connection, /sourceConnectionPublicMessage/);

  const validation = section('async function validateXtreamAccount(', '\nasync function validateCloudSource(');
  assert.match(validation, /requestGatewayMetadata[\s\S]*await directFallback\?\.assertSourceCurrent\?\.\(\);[\s\S]*return payload/);
  assert.match(validation, /const directFetch = async \(\) => \{[\s\S]*fetchJson[\s\S]*await directFallback\?\.assertSourceCurrent\?\.\(\)/);
});

test('base source mutations return only internal ids or a CAS timestamp before the management projection', () => {
  assert.doesNotMatch(CLOUD, /SOURCE_ROW_PUBLIC_SELECT/);
  assert.doesNotMatch(
    CLOUD,
    /\.from\("cloud_sources"\)[\s\S]{0,300}\.select\(SOURCE_MANAGEMENT_PUBLIC_SELECT\)/,
  );

  const managed = section('async function managedSourceSnapshot(', 'async function createSource(');
  assert.match(managed, /\.from\("cloud_source_management_sources"\)/);
  assert.match(managed, /\.select\(SOURCE_MANAGEMENT_PUBLIC_SELECT\)/);
  assert.match(managed, /\.eq\("user_id", userId\)/);
  assert.match(managed, /\.is\("deleted_at", null\)/);
  assert.match(managed, /return sanitizeSource\(data\)/);

  const cases = [
    ['async function createSource(', 'async function updateSource(', /\.insert\(row\)\.select\("id"\)\.single\(\)/],
    ['async function updateSource(', 'async function syncExistingSource(', /\.update\(\{ display_name: displayName \}\)[\s\S]*\.select\("id"\)/],
    ['async function syncExistingSource(', 'async function setSourceEnabled(', /\.update\(\{ sync_status: "syncing", sync_error: null \}\)[\s\S]*\.select\("id,updated_at"\)/],
    ['async function setSourceEnabled(', 'async function testSourceConnection(', /\.update\(\{ enabled: desired \}\)[\s\S]*\.eq\("enabled", current\)[\s\S]*\.select\("id"\)/],
    ['async function hardSyncSource(', 'function buildSourceConfig(', /\.update\(\{ sync_status: "syncing", sync_error: null, config_hint: compactRecord\(hint\) \}\)[\s\S]*\.select\("id,updated_at"\)/],
  ];

  for (const [start, end, mutation] of cases) {
    const source = section(start, end);
    assert.match(source, mutation);
    assert.match(source, /managedSourceSnapshot\(data\.id, userId, db\)/);
    assert.doesNotMatch(source, /select\([^)]*(?:lifecycle_state|provider_access_|config_revision|catalog_visibility)/);
  }
});
