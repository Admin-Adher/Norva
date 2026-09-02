'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const gateway = fs.readFileSync(path.join(
  __dirname,
  '../services/media-gateway/src/index.js',
), 'utf8');
const producerControl = fs.readFileSync(path.join(
  __dirname,
  '../services/media-gateway/src/mediaCacheProducerControl.js',
), 'utf8');

test('Gateway v153 keeps global R2 publication dark and behind private dedicated credentials', () => {
  assert.match(gateway, /NORVA_SHARED_MEDIA_CACHE_ENABLED === 'true'/);
  assert.match(gateway, /NORVA_MEDIA_CACHE_WORKER_URL/);
  assert.match(gateway, /NORVA_MEDIA_CACHE_WORKER_TOKEN/);
  assert.match(gateway, /NORVA_MEDIA_CACHE_MANIFEST_HMAC_KEY/);
  assert.match(gateway, /const GATEWAY_VERSION = 153/);
  assert.doesNotMatch(gateway, /R2_ACCESS_KEY|R2_SECRET|AWS_ACCESS_KEY/);
});

test('shared publication waits for profile and immutable media barriers then reuses one graph walk', () => {
  const scheduler = gateway.slice(
    gateway.indexOf('function scheduleSharedMediaCachePublication('),
    gateway.indexOf('async function maybePublishMkvCompleteHlsCache('),
  );
  assert.match(scheduler, /completeHlsCacheMediaReady !== true/);
  assert.match(scheduler, /completeHlsCacheProfileReady !== true/);
  assert.match(scheduler, /session\.sharedMediaCachePublicationPromise = publication/);
  assert.match(gateway, /session\.completeHlsGraphPromise = collectCompleteHlsSessionAssets\(session\)/);
  assert.match(gateway, /const graph = await completeHlsGraphForSession\(session\)/);

  const profileBarrier = gateway.indexOf('session.completeHlsCacheProfileReady = true;');
  const profileSchedule = gateway.indexOf('scheduleSharedMediaCachePublication(session);', profileBarrier);
  const mediaBarrier = gateway.indexOf('session.completeHlsCacheMediaReady = true;', profileSchedule);
  const mediaSchedule = gateway.indexOf('scheduleSharedMediaCachePublication(session);', mediaBarrier);
  assert.ok(profileBarrier >= 0 && profileSchedule > profileBarrier);
  assert.ok(mediaBarrier > profileSchedule && mediaSchedule > mediaBarrier);
});

test('Gateway publishes manifest-last graph before one bounded Edge authority callback', () => {
  const publication = gateway.slice(
    gateway.indexOf('async function registerSharedMediaCachePublication('),
    gateway.indexOf('async function maybePublishMkvCompleteHlsCache('),
  );
  assert.match(publication, /publishSharedMediaCacheSession\(/);
  assert.match(publication, /registerPublication: async \(payload\) =>/);
  assert.match(publication, /return registerSharedMediaCachePublication\(payload\)/);
  assert.match(publication, /mediaCacheProducerControl\.pulse\(session, 'finalizing'\)/);
  assert.equal((publication.match(/producerState !== 'renewed'/g) || []).length, 2);
  assert.match(publication, /\/media-cache\/publication/);
  assert.match(publication, /AbortSignal\.timeout\(SHARED_MEDIA_CACHE_CALLBACK_TIMEOUT_MS\)/);
  assert.match(publication, /const delays = \[0, 1_000, 5_000, 15_000\]/);
  assert.match(publication, /64 \* 1024/);
  assert.doesNotMatch(publication, /sourceUrl|providerPassword|password/);
});

test('shared completion after viewer exit is dark, demand-driven and immediately preemptable', () => {
  assert.match(gateway, /NORVA_SHARED_MEDIA_CACHE_BACKGROUND_CONTINUATION_ENABLED === 'true'/);
  const assessment = gateway.slice(
    gateway.indexOf('function mkvCompleteHlsBackgroundContinuationTargets('),
    gateway.indexOf('function settleMkvCompleteHlsBackgroundContinuation('),
  );
  assert.match(assessment, /session\?\.mediaCacheProducer/);
  assert.match(assessment, /providerAccountFreeForBackgroundContinuation/);
  assert.match(assessment, /sharedMediaCacheStaticContext/);

  const finish = gateway.slice(
    gateway.indexOf('function finishMkvCompleteHlsBackgroundContinuation('),
    gateway.indexOf('function needsMkvH264CurrentHeaderAuthority('),
  );
  assert.match(finish, /scheduleSharedMediaCachePublication/);
  assert.match(finish, /session\.mediaCacheProducerCompleted === true/);
  assert.match(finish, /mediaCacheProducerControl\.schedule\(session, 1\)/);
  assert.match(producerControl, /action: continuation \? 'continuation-pulse' : 'pulse'/);
  const controlSetup = gateway.slice(
    gateway.indexOf('const mediaCacheProducerControl = new MediaCacheProducerControl({'),
    gateway.indexOf('const MULTI_AUDIO_HLS_PROTOCOL'),
  );
  assert.match(controlSetup, /onPreempt: \(session\) =>/);
  assert.doesNotMatch(controlSetup, /onPreempt: async/);
  assert.match(controlSetup, /stopSession\(session, \{ reason: 'viewer-preempted' \}\)\.catch/);
});

test('session cleanup returns the cache locator only after any eligible local promotion settles', () => {
  const helper = gateway.slice(
    gateway.indexOf('async function privateFinalCodecProfileAfterPendingCacheWork('),
    gateway.indexOf('function mediaCacheLiveViewerCount('),
  );
  assert.match(helper, /scheduleMkvCompleteHlsCachePromotion\(session\)/);
  assert.match(helper, /await promotion\?\.catch/);
  assert.match(helper, /return privateFinalCodecProfileForSession\(session\)/);

  const deleteRoute = gateway.slice(
    gateway.indexOf("app.delete('/sessions/:id',"),
    gateway.indexOf("app.get('/sessions/:id/playlist.m3u8'"),
  );
  const finalProfile = deleteRoute.lastIndexOf(
    'await privateFinalCodecProfileAfterPendingCacheWork(session)',
  );
  const stop = deleteRoute.lastIndexOf('await stopSession(session)');
  assert.ok(finalProfile >= 0 && stop > finalProfile);
});
