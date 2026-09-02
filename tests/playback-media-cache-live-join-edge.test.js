'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const edge = fs.readFileSync(path.join(
  __dirname,
  '../supabase/functions/norva-playback/index.ts',
), 'utf8');

test('Edge v78 keeps live join dark behind an independent runtime flag', () => {
  assert.match(edge, /version: 80/);
  assert.match(edge, /NORVA_MEDIA_CACHE_LIVE_JOIN_ENABLED/);
  assert.match(edge, /mediaCacheLiveJoinEnabled/);
  assert.match(edge, /liveJoinRequested: config\.mediaCacheLiveJoinEnabled/);
});

test('a follower receives one server-authorized Gateway attachment without a provider claim', () => {
  const join = edge.slice(
    edge.indexOf('async function tryCreateLiveMediaCachePlayback'),
    edge.indexOf('async function abandonMediaCacheProducerClaim'),
  );
  assert.match(join, /norva_claim_media_cache_live_playback/);
  assert.match(join, /\/viewers`/);
  assert.match(join, /norva_activate_media_cache_live_playback/);
  assert.match(join, /media_cache_live_attachment_state/);
  assert.match(join, /mediaCacheFollowerRegistrationTransferred/);
  assert.match(join, /attachmentCreationAttempted = true/);
  assert.match(join, /revokeMediaCacheLiveGatewayAttachment/);
  assert.match(join, /\[404, 410, 425, 429\]\.includes\(response\.status\)/);
  assert.match(join, /topologyValidated !== true/);
  assert.match(join, /continuityValidated !== true/);
  assert.match(join, /transport: "shared-live-hls"/);
  assert.doesNotMatch(join, /claim_cloud_playback_session|sourceUrl|providerAccountHash/);
});

test('singleflight transfers exactly one follower registration to live join', () => {
  const coordination = edge.slice(
    edge.indexOf('async function coordinateColdMediaCachePlayback'),
    edge.indexOf('async function mediaCacheAccountFingerprintForPlayback'),
  );
  assert.match(coordination, /tryJoin: runtimeConfig\.mediaCacheLiveJoinEnabled/);
  assert.match(coordination, /tryCreateLiveMediaCachePlayback/);
  assert.match(coordination, /outcome\.role === "joined"/);
  assert.match(coordination, /registrationTransferred/);
});

test('Back revokes only the viewer attachment while preserving joined or background producer state', () => {
  const expire = edge.slice(
    edge.indexOf('async function requestDemandDrivenMediaCacheContinuationForLiveAttachment'),
    edge.indexOf('async function recordPlaybackEvent'),
  );
  assert.match(expire, /norva_request_media_cache_continuation_for_live_attachment/);
  assert.match(expire, /\/viewers\/\$\{encodeURIComponent\(liveAttachmentId\)\}/);
  assert.match(expire, /norva_finalize_media_cache_live_attachment_release/);
  assert.match(expire, /preservedGatewayDatabaseIds/);
  assert.match(expire, /\["joined", "running"\]/);
});

test('same-account cleanup detaches live viewers before evaluating producer preservation', () => {
  const cleanup = edge.slice(
    edge.indexOf('async function closeOpenGatewaySessionsForUser'),
    edge.indexOf('async function prepareEdgeSessionCoordinator'),
  );
  const attachmentBatch = cleanup.indexOf(
    'await Promise.allSettled(liveAttachmentGatewaySessions.map(cleanupGatewaySession))',
  );
  const producerBatch = cleanup.indexOf(
    'await Promise.allSettled(producerGatewaySessions.map(cleanupGatewaySession))',
  );
  assert.ok(attachmentBatch >= 0, 'live attachment cleanup batch must exist');
  assert.ok(producerBatch > attachmentBatch, 'producer cleanup must run after live attachment cleanup');
});
