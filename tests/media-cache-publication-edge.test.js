'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const edge = fs.readFileSync(path.join(
  __dirname,
  '../supabase/functions/norva-playback/index.ts',
), 'utf8');

test('Edge v75 exposes only an authenticated Gateway publication route', () => {
  assert.match(edge, /version: 75,[\s\S]*sharedMediaCachePublicationProtocol: 1/);
  assert.match(edge, /segments\[0\] === "media-cache" && segments\[1\] === "publication"/);
  const callback = edge.slice(
    edge.indexOf('async function runMediaCachePublicationCallback('),
    edge.indexOf('async function runCompleteHlsCacheCallback('),
  );
  assert.match(callback, /requireConfiguredMediaGatewayCallback\(req, runtimeConfig\)/);
  assert.match(callback, /cloud_gateway_sessions/);
  assert.match(callback, /authorizedGatewayIds\.has/);
  assert.doesNotMatch(callback, /requireIdentity\(/);
});

test('callback accepts only global object evidence and delegates binding authority to SQL', () => {
  const callback = edge.slice(
    edge.indexOf('async function runMediaCachePublicationCallback('),
    edge.indexOf('async function runCompleteHlsCacheCallback('),
  );
  assert.match(callback, /exactJsonKeys\(body,[\s\S]*"gatewaySessionId", "object", "playbackSessionId", "protocol", "status"/);
  assert.match(callback, /exactJsonKeys\(object,[\s\S]*"contentSha256"[\s\S]*"subtitleTopologySha256"/);
  assert.match(callback, /object\.storageBackend !== "r2"/);
  assert.match(callback, /norva_commit_media_cache_publication/);
  assert.match(callback, /p_playback_session_id: playbackSessionId/);
  assert.match(callback, /p_gateway_session_id: gatewaySessionId/);
  assert.match(callback, /p_user_id: userId/);
  assert.doesNotMatch(callback, /sourceId|itemId|variantId|targetUrl/);
});

test('callback response contains no storage credential or raw provider coordinate', () => {
  const callback = edge.slice(
    edge.indexOf('async function runMediaCachePublicationCallback('),
    edge.indexOf('async function runCompleteHlsCacheCallback('),
  );
  assert.match(callback, /return \{ ok: true, protocol: 1, objectKey, bindingId, producerState \}/);
  assert.doesNotMatch(callback, /accessKey|secretKey|bucket|providerUrl|targetUrl/);
});
