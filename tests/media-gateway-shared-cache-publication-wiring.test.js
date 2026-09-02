'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const gateway = fs.readFileSync(path.join(
  __dirname,
  '../services/media-gateway/src/index.js',
), 'utf8');

test('Gateway v146 keeps global R2 publication dark and behind private dedicated credentials', () => {
  assert.match(gateway, /NORVA_SHARED_MEDIA_CACHE_ENABLED === 'true'/);
  assert.match(gateway, /NORVA_MEDIA_CACHE_WORKER_URL/);
  assert.match(gateway, /NORVA_MEDIA_CACHE_WORKER_TOKEN/);
  assert.match(gateway, /NORVA_MEDIA_CACHE_MANIFEST_HMAC_KEY/);
  assert.match(gateway, /const GATEWAY_VERSION = 146/);
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
  assert.match(publication, /registerPublication: registerSharedMediaCachePublication/);
  assert.match(publication, /\/media-cache\/publication/);
  assert.match(publication, /AbortSignal\.timeout\(SHARED_MEDIA_CACHE_CALLBACK_TIMEOUT_MS\)/);
  assert.match(publication, /const delays = \[0, 1_000, 5_000\]/);
  assert.match(publication, /64 \* 1024/);
  assert.doesNotMatch(publication, /sourceUrl|providerPassword|password/);
});
