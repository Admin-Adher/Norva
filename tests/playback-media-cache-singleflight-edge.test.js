'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const edge = fs.readFileSync(path.join(
  __dirname,
  '../supabase/functions/norva-playback/index.ts',
), 'utf8');
const gateway = fs.readFileSync(path.join(
  __dirname,
  '../services/media-gateway/src/index.js',
), 'utf8');

test('Edge v77 exposes dark singleflight configuration with a dedicated HMAC key', () => {
  assert.match(edge, /version: 77,[\s\S]*sharedMediaCacheSingleflightProtocol: MEDIA_CACHE_SINGLEFLIGHT_PROTOCOL/);
  assert.match(edge, /NORVA_MEDIA_CACHE_SINGLEFLIGHT_ENABLED/);
  assert.match(edge, /NORVA_MEDIA_CACHE_COORDINATION_HMAC_KEY/);
  assert.match(edge, /NORVA_MEDIA_CACHE_FOLLOWER_WAIT_MS/);
  assert.doesNotMatch(edge, /mediaCacheCoordinationHmacKey:\s*(?:ENV_)?MEDIA_GATEWAY/i);
});

test('cold MKV miss coordinates before provider circuit, capacity and provider claim', () => {
  const create = edge.slice(
    edge.indexOf('async function createPlaybackSessionCore'),
    edge.indexOf('async function createPlaybackSession('),
  );
  const coordinate = create.indexOf('coordinateColdMediaCachePlayback');
  assert.ok(coordinate >= 0);
  assert.ok(coordinate < create.indexOf('assertProviderCircuitClosed'));
  assert.ok(coordinate < create.indexOf('requirePlaybackCapacity'));
  assert.ok(coordinate < create.indexOf('claim_cloud_playback_session'));
  assert.match(create, /authoritativeVodContainer === "mkv" && mode === "transcode"/);
  assert.match(create, /if \(coordinatedPlayback\) return coordinatedPlayback/);
  assert.ok(create.indexOf('preemptBackgroundMediaCacheForViewer') < create.indexOf('assertProviderCircuitClosed'));
});

test('ambiguous coordination and completed-work claims never fall through to provider', () => {
  const coordination = edge.slice(
    edge.indexOf('async function claimReadyMediaCacheWorkPlayback'),
    edge.indexOf('async function createPlaybackSessionCore'),
  );
  assert.match(coordination, /norva_claim_media_cache_producer/);
  assert.match(coordination, /norva_resolve_media_cache_work/);
  assert.match(coordination, /norva_leave_media_cache_follower/);
  assert.match(coordination, /norva_claim_ready_media_cache_work_playback/);
  assert.match(coordination, /Unable to coordinate shared media cache producer/);
  assert.match(coordination, /MEDIA_CACHE_PRODUCER_ACTIVE/);
  assert.doesNotMatch(coordination, /createGatewaySession|claim_cloud_playback_session/);
});

test('leader lease transfers opaquely to Gateway and untransferred claims are abandoned', () => {
  const createGateway = edge.slice(
    edge.indexOf('async function createGatewaySession'),
    edge.indexOf('async function requestGatewaySession'),
  );
  const wrapper = edge.slice(
    edge.indexOf('async function createPlaybackSession('),
    edge.indexOf('type StrictLanguageValidationEvidence'),
  );
  assert.match(createGateway, /mediaCacheProducer: MediaCacheProducerContext \| null/);
  assert.match(createGateway, /media_cache_work_fingerprint/);
  assert.match(createGateway, /media_cache_lease_token/);
  assert.match(createGateway, /completeHlsCachePolicy: "bypass"/);
  assert.match(wrapper, /!mediaCacheLifecycle\.transferredToGateway/);
  assert.match(wrapper, /abandonMediaCacheProducerClaim/);
});

test('producer callback is Gateway-authenticated and completes the work only after publication binding', () => {
  const control = edge.slice(
    edge.indexOf('async function runMediaCacheProducerControl'),
    edge.indexOf('async function runCompleteHlsCacheCallback'),
  );
  assert.match(edge, /segments\[0\] === "media-cache" && segments\[1\] === "producer-control"/);
  assert.match(control, /requireConfiguredMediaGatewayCallback/);
  assert.match(control, /norva_pulse_media_cache_producer_for_gateway/);
  assert.match(control, /norva_pulse_media_cache_continuation_for_gateway/);
  assert.match(control, /norva_abandon_media_cache_producer_for_gateway/);
  const commitIndex = control.indexOf('norva_commit_admitted_media_cache_publication');
  const completeIndex = control.indexOf('norva_complete_media_cache_producer_for_gateway');
  assert.ok(commitIndex >= 0 && completeIndex > commitIndex);
});

test('normal close reserves continuation only for live server-side demand', () => {
  const expire = edge.slice(
    edge.indexOf('async function requestDemandDrivenMediaCacheContinuation'),
    edge.indexOf('async function recordPlaybackEvent'),
  );
  assert.match(expire, /norva_request_media_cache_continuation_for_gateway/);
  assert.match(expire, /if \(continueMediaCache\) cleanupUrl\.searchParams\.set\("completeCache", "continue"\)/);
  assert.doesNotMatch(expire, /cleanupUrl\.searchParams\.set\("completeCache", "continue"\);[\s\S]*requestDemandDrivenMediaCacheContinuation/);
});

test('real viewer preemption is distributed, bounded and excludes its own producer work', () => {
  const preempt = edge.slice(
    edge.indexOf('async function preemptBackgroundMediaCacheForViewer'),
    edge.indexOf('async function createPlaybackSessionCore'),
  );
  assert.match(preempt, /norva_preempt_background_media_cache_producers/);
  assert.match(preempt, /norva_count_background_media_cache_producers/);
  assert.match(preempt, /MEDIA_CACHE_BACKGROUND_PREEMPT_WAIT_MS/);
  assert.match(preempt, /MEDIA_CACHE_BACKGROUND_DRAINING/);
  assert.match(preempt, /p_except_work_fingerprint: exceptWorkFingerprint/);
});

test('Gateway validates, renews, finalizes and abandons one attached producer context', () => {
  const create = gateway.slice(
    gateway.indexOf("app.post('/sessions'"),
    gateway.indexOf("app.get('/sessions/:id'"),
  );
  const stop = gateway.slice(
    gateway.indexOf('async function stopSession('),
    gateway.indexOf('function touchViewerSessionClientAccess('),
  );
  assert.match(create, /normalizeMediaCacheProducerContext\(mediaCacheProducer\)/);
  assert.match(create, /MEDIA_CACHE_PRODUCER_CONTROL_UNAVAILABLE/);
  assert.match(create, /mediaCacheProducerControl\.attach\(session, normalizedMediaCacheProducer\)/);
  assert.match(gateway, /mediaCacheProducerControl\.pulse\(session, 'uploading'\)/);
  assert.match(gateway, /mediaCacheProducerControl\.pulse\(session, 'finalizing'\)/);
  assert.match(gateway, /mediaCacheProducerControl\.markCompleted\(session\)/);
  assert.match(stop, /mediaCacheProducerControl\.abandon\(session\)/);
});
