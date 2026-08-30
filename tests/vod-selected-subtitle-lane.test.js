'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

function loadMediaUtils() {
  const source = read('public/js/utils/mediaUtils.js');
  const window = {};
  vm.runInNewContext(source, {
    window,
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    URL,
    URLSearchParams,
    console,
  });
  return window.MediaUtils;
}

test('playback hints make Gateway subtitle extraction explicit and single-lane', () => {
  const mediaUtils = loadMediaUtils();

  const selected = mediaUtils.applyPlaybackPreferencesToHint(
    { container: 'mkv' },
    {
      audio: { streamIndex: 2 },
      subtitle: { source: 'probe', streamIndex: 17 },
    },
  );
  assert.equal(selected.audioStreamIndex, 2);
  assert.equal(selected.subtitleStreamIndex, 17);

  const off = mediaUtils.applyPlaybackPreferencesToHint(
    { container: 'mkv', subtitleStreamIndex: 17, subtitle_stream_index: 17 },
    { subtitle: { source: 'off' } },
  );
  assert.equal(Object.hasOwn(off, 'subtitleStreamIndex'), false);
  assert.equal(Object.hasOwn(off, 'subtitle_stream_index'), false);

  const unset = mediaUtils.applyPlaybackPreferencesToHint(
    { container: 'mkv', subtitleStreamIndex: 17 },
    null,
  );
  assert.equal(Object.hasOwn(unset, 'subtitleStreamIndex'), false);
});

test('Gateway extracts no subtitle by default and at most the exact selected text track', () => {
  const gateway = read('services/media-gateway/src/index.js');
  const subtitleSelection = section(
    gateway,
    'function subtitleTracksForSession(session) {',
    'function mappedSubtitleStreamIndexForSession(session) {',
  );

  assert.match(gateway, /const GATEWAY_VERSION = 126;/);
  assert.match(subtitleSelection, /if \(!Number\.isInteger\(requestedIndex\)\) return \[\];/);
  assert.match(subtitleSelection, /\.find\(\(track\) => normalizeAudioStreamIndex\(track\.index\) === requestedIndex\)/);
  assert.match(subtitleSelection, /return selected \? \[selected\] : \[\];/);
  assert.doesNotMatch(subtitleSelection, /return tracks;/);
});

test('Edge binds the requested subtitle index to the actual Gateway mapping', () => {
  const edge = read('supabase/functions/norva-playback/index.ts');
  const gatewaySession = section(
    edge,
    'async function createGatewaySession(',
    'async function requestGatewaySession(',
  );

  assert.match(gatewaySession, /requestedSubtitleStreamIndex/);
  assert.match(gatewaySession, /actualSubtitleStreamIndex/);
  assert.match(gatewaySession, /SUBTITLE_STREAM_MAP_MISMATCH/);
  assert.match(gatewaySession, /const cleanup = await cleanupCreatedSession\(\)/);
});

test('Watch clears stale title UI and serializes safe subtitle lane restarts', () => {
  const watch = read('public/js/pages/WatchPage.js');
  const app = read('public/app.html');
  const playSetup = section(
    watch,
    'async play(content, streamUrl, playback = {}) {',
    '    async loadVideo(url, options = {}) {',
  );
  const subtitleRestart = section(
    watch,
    'queueSelectedSubtitleTrackRestart(preference) {',
    '    _isManagedTextTrack(textTrack) {',
  );
  const extractionTracks = section(
    watch,
    'getSubtitleExtractionTracks() {',
    'attachProbeSubtitles(',
  );
  const subtitleAttach = section(
    watch,
    'waitForManagedSubtitleTrack(trackEl, timeoutMs = 2000) {',
    'attachProbeSubtitles(',
  );
  const engineTracks = section(
    watch,
    'applyEngineSubtitleTracks(tracks, playbackAttemptId) {',
    'async enrichEngineSubtitleTracks()',
  );
  const subtitlePolling = section(
    watch,
    'startSubtitleSessionPolling(engine) {',
    '    async subtitleWindowTick(engine, force = false) {',
  );
  const captionSelection = section(
    watch,
    'async selectCaptionTrack(source, index, streamIndex = null) {',
    '// === Overlay Auto-Hide ===',
  );

  assert.match(app, /id="watch-subtitle-status"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.match(playSetup, /recommendedGrid\.replaceChildren\(\)/);
  assert.match(playSetup, /seasonsContainer\.replaceChildren\(\)/);
  assert.match(playSetup, /episodesNavList\.replaceChildren\(\)/);
  assert.match(subtitleRestart, /_subtitleSwitchPromise/);
  assert.match(subtitleRestart, /restartCloudGatewayStreamAt\(position/);
  assert.match(subtitleRestart, /await this\.stopTranscodeSession\(\)/);
  assert.match(subtitleRestart, /waitForSelectedSubtitleActivation/);
  assert.match(watch, /resetSubtitleSwitchFeedback\(\)/);
  assert.match(captionSelection, /setSubtitleSwitchFeedback\('applying'/);
  assert.match(extractionTracks, /return selected \? \[selected\] : \[\];/);
  assert.match(subtitleAttach, /new Blob\(\['WEBVTT\\n\\n'\], \{ type: 'text\/vtt' \}\)/);
  assert.match(subtitleAttach, /trackEl\.src = bootstrapUrl/);
  assert.match(subtitlePolling, /await this\.subtitleSessionTick\(engine\)/);
  assert.match(subtitleAttach, /lastSuccessfulFetchAt/);
  assert.match(subtitlePolling, /\? 500 : 150/);
  assert.doesNotMatch(engineTracks, /5000/);
});
