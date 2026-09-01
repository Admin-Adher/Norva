'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const watch = read('public/js/pages/WatchPage.js');
const api = read('public/js/api.js');
const cloud = read('public/js/cloudApi.js');
const edge = read('supabase/functions/norva-playback/index.ts');
const gateway = read('services/media-gateway/src/index.js');

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return source.slice(start, end);
}

test('Watch owns one AbortController per playback attempt and cancels it on teardown', () => {
  const attempt = section(watch, 'beginPlaybackAttempt() {', '\n    noteCloudPlaybackLaneForAttempt(');
  const stop = section(
    watch,
    'stop({ enqueueStoryboard = true, preservePlaybackResolutionAttempt = false } = {}) {',
    '\n    // === Playback Controls ===',
  );
  const timer = section(watch, 'schedulePlaybackErrorRefresh(', '\n    /**\n     * Restart the stream pipeline');

  assert.match(attempt, /this\.abortPlaybackResolution\(\)/);
  assert.match(attempt, /new AbortControllerCtor\(\)/);
  assert.match(attempt, /controller\.abort\(\)/);
  assert.match(stop, /this\.clearPlaybackErrorRefreshTimer\(\)/);
  assert.match(stop, /if \(!preservePlaybackResolutionAttempt\) this\.abortPlaybackResolution\(\)/);
  assert.ok(stop.indexOf('this.abortPlaybackResolution()') < stop.indexOf('if (this._stopPromise)'));
  assert.match(timer, /const scheduledAttemptId = this\._playbackAttemptId/);
  assert.match(timer, /this\.isStalePlaybackAttempt\(scheduledAttemptId\)/);
  assert.match(timer, /this\.app\?\.currentPage && this\.app\.currentPage !== 'watch'/);
});

test('the initial resolver and every network layer carry the same AbortSignal to Gateway creation', () => {
  const play = section(watch, 'async play(content, streamUrl, playback = {}) {', '\n    async ');
  const getStream = section(api, 'getStreamUrl: (', '\n        },\n\n        // EPG');
  const cloudWrapper = section(api, 'function cloudPlaybackApi() {', '\n    return {');
  const edgeGateway = section(edge, 'async function createGatewaySession(', '\nasync function requestGatewaySession(');
  const edgeRequest = section(edge, 'async function requestGatewaySession(', '\nfunction gatewayModeForPlayback(');
  const gatewayCreate = section(gateway, "app.post('/sessions'", "app.get('/sessions/:id'");

  assert.match(play, /streamUrlResolver\(\{\s*signal: playbackResolveSignal/);
  assert.match(getStream, /requestOptions = \{\}/);
  assert.match(getStream, /API\.request\([\s\S]*requestOptions/);
  assert.match(cloudWrapper, /createSession: async \(session, requestOptions = \{\}\)/);
  assert.match(cloudWrapper, /api\.createSession\(session, requestOptions\)/);
  assert.match(cloud, /createSession: \(session, options = \{\}\) => playbackRequest\(session, options\)/);
  assert.match(edge, /resolvedContainerObservation,\s*req\.signal,/);
  assert.match(edge, /if \(req\.signal\.aborted\) throw playbackRequestAbortError\(\)/);
  assert.match(edge, /if \(req\.signal\.aborted\) \{\s*try \{\s*await expirePlaybackSession/);
  assert.match(edge, /await gateway\.cleanupCreatedSession\?\.\(\)\.catch/);
  assert.match(edgeGateway, /requestSignal: AbortSignal \| null = null/);
  assert.match(edgeGateway, /requestGatewaySession\([\s\S]*requestSignal/);
  assert.match(edgeRequest, /\.\.\.\(signal \? \{ signal \} : \{\}\)/);
  assert.match(gatewayCreate, /req\.once\('aborted', abortSessionRequest\)/);
  assert.match(gatewayCreate, /if \(createdSession\) stopSession\(createdSession\)/);
});

test('in-place retry revalidates route and attempt after both teardown waits', () => {
  const retry = section(
    watch,
    'async retryPlaybackInPlace(positionOverride = null) {',
    '\n    clearPlaybackErrorRefreshTimer()',
  );
  assert.match(retry, /const contentAtStart = this\.content/);
  assert.equal((retry.match(/playbackResolveSignal\?\.aborted/g) || []).length >= 4, true);
  assert.equal((retry.match(/currentPage !== 'watch'/g) || []).length >= 4, true);
  assert.match(retry, /\{ signal: playbackResolveSignal \}/);
  assert.match(retry, /error\?\.name === 'AbortError'/);
});
