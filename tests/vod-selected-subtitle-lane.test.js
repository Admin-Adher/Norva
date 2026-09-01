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

function loadWatchPage() {
  const window = {
    location: {
      href: 'https://norva.tv/app#watch',
      hostname: 'norva.tv',
    },
  };
  vm.runInNewContext(read('public/js/pages/WatchPage.js'), {
    window,
    console,
    Intl,
    setTimeout,
    clearTimeout,
    Promise,
    URL,
  }, { filename: 'WatchPage.js' });
  return window.WatchPage;
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

  assert.match(gateway, /const GATEWAY_VERSION = 143;/);
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

test('Edge returns a ready Gateway session before best-effort catalog telemetry', () => {
  const edge = read('supabase/functions/norva-playback/index.ts');
  const createSession = section(
    edge,
    'async function createPlaybackSession(',
    'type StrictLanguageValidationEvidence',
  );

  assert.match(createSession, /runBackground\(recordPlaybackStartupObservation\(db,/);
  assert.doesNotMatch(createSession, /await recordPlaybackStartupObservation\(db,/);
});

test('Watch immediately restores the exact subtitle lane acknowledged by Gateway', () => {
  const WatchPage = loadWatchPage();
  const page = Object.create(WatchPage.prototype);
  page.subtitleTracks = [];
  page.currentStreamInfo = { subtitles: [] };
  page.pendingPlaybackPreferences = {
    subtitle: {
      source: 'probe',
      streamIndex: 17,
      label: 'French - SDH',
      language: 'fr',
      offsetSeconds: 0.35,
    },
  };
  page._pendingSubtitlePreferenceApplied = false;
  page.updateCaptionsTracks = () => {};
  page.loadSubtitleOffset = () => 0;

  const tracks = page.applyAcknowledgedSubtitleSessionMetadata({
    subtitleStreamIndex: 17,
    subtitleTracks: [],
  });

  assert.equal(page.selectedSubtitleStreamIndex, 17);
  assert.equal(page.selectedSubtitleTrackUserChoice, true);
  assert.equal(page._pendingSubtitlePreferenceApplied, true);
  assert.equal(page.subtitleOffsetSeconds, 0.4);
  assert.equal(tracks.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(tracks[0])), {
    index: 17,
    title: 'French - SDH',
    language: 'fr',
    codec: null,
    subtitleType: 'text',
    extractable: true,
    sessionAcknowledged: true,
  });
  assert.equal(page.currentStreamInfo.subtitles[0].index, 17);
});

test('Watch keeps an explicit Off choice ahead of stale acknowledged session metadata', () => {
  const WatchPage = loadWatchPage();
  const page = Object.create(WatchPage.prototype);
  page.subtitleTracks = [];
  page.currentStreamInfo = { subtitles: [] };
  page.pendingPlaybackPreferences = { subtitle: { source: 'off', mode: 'off' } };
  page.selectedSubtitleStreamIndex = 17;
  page.selectedSubtitleTrackUserChoice = false;
  page.subtitleOffsetSeconds = 0.8;
  page._pendingSubtitlePreferenceApplied = false;
  page.updateCaptionsTracks = () => {};

  page.applyAcknowledgedSubtitleSessionMetadata({
    subtitleStreamIndex: 17,
    subtitleTracks: [],
  });

  assert.equal(page.selectedSubtitleStreamIndex, null);
  assert.equal(page.selectedSubtitleTrackUserChoice, true);
  assert.equal(page.subtitleOffsetSeconds, 0);
  assert.equal(page._pendingSubtitlePreferenceApplied, true);
  assert.equal(page.subtitleTracks.length, 0);
});

test('Watch never fabricates subtitle stream zero from absent Gateway metadata', () => {
  const WatchPage = loadWatchPage();
  const page = Object.create(WatchPage.prototype);
  page.subtitleTracks = [{ index: 3, language: 'fr', subtitleType: 'text', extractable: true }];
  page.currentStreamInfo = { subtitles: [...page.subtitleTracks] };
  page.pendingPlaybackPreferences = {
    subtitle: { source: 'probe', streamIndex: 3, language: 'fr' },
  };
  page.selectedSubtitleStreamIndex = null;
  page.selectedSubtitleTrackUserChoice = false;
  page._pendingSubtitlePreferenceApplied = false;
  page.restorePendingSubtitlePreference = () => false;
  page.updateCaptionsTracks = () => {};

  const metadata = page.playbackMetadataFromResult({
    gatewaySession: {
      audio_stream_index: null,
      subtitle_stream_index: null,
    },
  });
  const tracks = page.applyAcknowledgedSubtitleSessionMetadata({
    subtitleStreamIndex: null,
    subtitleTracks: page.subtitleTracks,
  });

  assert.equal(metadata.audioStreamIndex, null);
  assert.equal(metadata.subtitleStreamIndex, null);
  assert.equal(page.selectedSubtitleStreamIndex, null);
  assert.equal(tracks.some(track => Number(track?.index) === 0), false);
});

test('Watch derives the selected subtitle VTT from every Gateway session playlist shape', () => {
  const WatchPage = loadWatchPage();
  const cases = [
    'playlist.m3u8',
    'video.m3u8',
    'audio_0.m3u8',
  ];

  for (const playlist of cases) {
    const page = Object.create(WatchPage.prototype);
    page.subtitleSourceUrl = `https://gateway.test/sessions/session-1/${playlist}?token=secret`;
    const url = new URL(page.gatewaySubtitleUrlForTrack(3));
    assert.equal(url.pathname, '/sessions/session-1/sub_3.vtt');
    assert.equal(url.searchParams.get('token'), 'secret');
  }

  const invalid = Object.create(WatchPage.prototype);
  invalid.subtitleSourceUrl = 'https://gateway.test/not-a-session/playlist.m3u8?token=secret';
  assert.equal(invalid.gatewaySubtitleUrlForTrack(3), '');
});

test('Watch carries the selected subtitle lane through the serialized Gateway restart', async () => {
  const WatchPage = loadWatchPage();
  const page = Object.create(WatchPage.prototype);
  const preference = { source: 'probe', streamIndex: 17, language: 'fr' };
  let captured = null;
  page._subtitleSwitchRequestId = 9;
  page.currentPlaybackMode = 'gateway-session';
  page.content = { sourceId: 'source', id: 'episode' };
  page.getPlaybackPosition = () => 42;
  page.subtitleTrackLabel = () => 'French';
  page.getMergedPlaybackPreferences = (overrides) => ({ audio: { streamIndex: 2 }, ...overrides });
  page.savePlaybackPreferences = (value) => value;
  page.restartCloudGatewayStreamAt = async (position, options) => { captured = { position, options }; };
  page.waitForSelectedSubtitleActivation = async () => true;
  page.setSubtitleSwitchFeedback = () => {};

  const activated = await page.restartWithSelectedSubtitleTrack(preference, 9);

  assert.equal(activated, true);
  assert.equal(captured.position, 42);
  assert.equal(captured.options.subtitleSwitchRequestId, 9);
  assert.deepEqual(JSON.parse(JSON.stringify(captured.options.playbackPreferences)), {
    audio: { streamIndex: 2 },
    subtitle: preference,
  });
});

test('Watch canonicalizes a Continue Watching episode and freezes its exact provider identity', () => {
  const WatchPage = loadWatchPage();
  const page = Object.create(WatchPage.prototype);
  page.containerExtension = 'mkv';
  const content = {
    id: '1701192',
    type: 'episode',
    sourceId: 'source-1',
    seriesId: '42142',
    currentSeason: 4,
    currentEpisode: 1,
    containerExtension: 'mkv',
  };

  page.canonicalizeVodPlaybackContent(content);
  page.content = content;
  const identity = page.captureVodPlaybackIdentity();

  assert.equal(content.type, 'series');
  assert.equal(content.itemType, 'episode');
  assert.equal(content.streamType, 'series');
  assert.equal(identity.itemType, 'series');
  assert.equal(identity.itemId, '1701192');
  assert.equal(identity.sourceId, 'source-1');
  assert.equal(identity.container, 'mkv');
  assert.equal(identity.playbackItem.type, 'episode');
  assert.equal(identity.playbackItem.streamType, 'series');
  assert.equal(identity.playbackItem.seriesId, '42142');
  assert.equal(Object.isFrozen(identity), true);
  assert.equal(Object.isFrozen(identity.playbackItem), true);
});

test('Watch freezes episode identity before every serialized subtitle or audio lane teardown', () => {
  const watch = read('public/js/pages/WatchPage.js');
  const play = section(
    watch,
    '    async play(content, streamUrl, playback = {}) {',
    '    async loadVideo(url, options = {}) {',
  );
  const subtitleRestart = section(
    watch,
    '    async restartCloudGatewayStreamAt(targetTime, options = {}) {',
    '    retryGatewaySeekAfterFatalPlayback(',
  );
  const audioRestart = section(
    watch,
    '    async restartCloudGatewayWithSelectedAudioTrack(requestId = this._audioSwitchRequestId) {',
    '    updateGatewayAudioSwitchMetrics(',
  );

  assert.ok(
    play.indexOf('this.canonicalizeVodPlaybackContent(content);') < play.indexOf('this.content = content;'),
    'content type must be canonical before Watch publishes the incoming identity',
  );
  assert.ok(
    subtitleRestart.indexOf('const playbackIdentity =')
      < subtitleRestart.indexOf('await this.releasePlaybackPipelineForRetry();'),
    'subtitle restart must capture identity before releasing the old lane',
  );
  assert.match(subtitleRestart, /getStreamUrl\(\s*playbackIdentity\.sourceId,\s*playbackIdentity\.itemId,\s*itemType,/);
  assert.match(subtitleRestart, /playbackIdentity,\s*\}\);/);
  assert.ok(
    audioRestart.indexOf('const playbackIdentity = this.captureVodPlaybackIdentity();')
      < audioRestart.indexOf('await this.releasePlaybackPipelineForRetry();'),
    'audio restart must capture identity before releasing the old lane',
  );
  assert.match(audioRestart, /requestAudioSwitchGatewayUrl\([\s\S]*playbackIdentity\s*\)/);
});

test('Watch does not announce a selected subtitle lane before its first real cue', async () => {
  const WatchPage = loadWatchPage();
  const page = Object.create(WatchPage.prototype);
  const cues = [];
  page._subtitleSwitchRequestId = 3;
  page._subEngineReadyPromise = Promise.resolve(true);
  page._subEngine = {
    streamIndex: 17,
    trackReady: true,
    mode: 'gateway-session',
    lastSuccessfulFetchAt: Date.now(),
    trackEl: { track: { mode: 'showing', cues } },
  };

  assert.equal(await page.waitForSelectedSubtitleActivation(17, 3, 20), false);
  cues.push({ startTime: 0, endTime: 2, text: 'Bonjour' });
  assert.equal(await page.waitForSelectedSubtitleActivation(17, 3, 20), true);
});

test('Gateway never caches a growing selected WebVTT subtitle artifact', () => {
  const gateway = read('services/media-gateway/src/index.js');
  const artifactRoute = section(
    gateway,
    "app.get('/sessions/:id/:file'",
    'function failMkvCompleteHlsCacheSession(',
  );

  assert.match(artifactRoute, /const isGrowingSubtitle = requested\.toLowerCase\(\)\.endsWith\('\.vtt'\)/);
  assert.match(artifactRoute, /isGrowingSubtitle \? 'no-store' : 'private, max-age=30'/);
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
    'applyEngineSubtitleTracks(tracks, playbackAttemptId, evidence = {}) {',
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
  const loadVideo = section(
    watch,
    '    async loadVideo(url, options = {}) {',
    '    gatewayBufferedAheadSeconds() {',
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
  assert.match(loadVideo, /setPendingPlaybackPreferences\(incomingPlaybackPreferences\)/);
  assert.match(loadVideo, /applyAcknowledgedSubtitleSessionMetadata\(options\)/);
  assert.match(loadVideo, /attachProbeSubtitles\(url, this\.subtitleTracks, startOffset\)/);
  assert.doesNotMatch(engineTracks, /5000/);
});
