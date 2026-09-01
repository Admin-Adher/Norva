const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const watchSource = fs.readFileSync(
  path.join(ROOT, 'public', 'js', 'pages', 'WatchPage.js'),
  'utf8'
).replace(/\r\n/g, '\n');

function loadWatchPage({ setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  const context = {
    window: {},
    console,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
  };
  vm.runInNewContext(watchSource, context, { filename: 'WatchPage.js' });
  return context.window.WatchPage;
}

function makeTelemetryPage(video) {
  const WatchPage = loadWatchPage();
  const page = Object.create(WatchPage.prototype);
  const events = [];

  Object.assign(page, {
    video,
    content: { id: 'movie-1', sourceId: 'source-1', type: 'movie', title: 'Test movie' },
    contentType: 'movie',
    _playbackAttemptId: 4,
    _firstFrameReported: false,
    _playStartedReported: false,
    _playbackEnded: false,
    _playbackStatusOkReported: false,
    _firstFrameCallbackId: null,
    _firstFrameObserverAttemptId: null,
    _deferredEngineTrackEnrichment: null,
    _deferredEngineTrackEnrichmentTimer: null,
    _aiActiveVtt: null,
    playbackTelemetry: {
      playbackAttemptId: 4,
      requestedAt: Date.now() - 25,
      startupPhases: {},
      firstFrameReported: false,
    },
    sendPlaybackEvent(type, extra) { events.push({ type, extra }); },
    hideLoading() {},
    hidePlaybackError() {},
    reportPlaybackStatus() { return Promise.resolve(); },
    reportObservedAudioLanguages() {},
  });

  return { page, events };
}

test('TTFF clock is captured at play intent before resume, teardown and session resolution', () => {
  const start = watchSource.indexOf('    async play(content, streamUrl, playback = {}) {');
  const end = watchSource.indexOf('\n    durationFrom', start + 20) >= 0
    ? watchSource.indexOf('\n    durationFrom', start + 20)
    : watchSource.indexOf('\n    get', start + 20);
  const playBody = watchSource.slice(start, end > start ? end : start + 18000);
  const intent = playBody.indexOf('const playbackRequestedAt = Date.now()');

  assert.ok(intent >= 0, 'play() must capture the user intent timestamp');
  for (const marker of [
    'await this.stop()',
    'await this._fetchServerResumeInfo(content)',
    'await streamUrlResolver()',
    'await this.loadVideo(streamUrl',
  ]) {
    const index = playBody.indexOf(marker);
    assert.ok(index > intent, `${marker} must happen after the TTFF clock starts`);
  }
  assert.match(playBody, /beginPlaybackTelemetry\([\s\S]*requestedAt:\s*playbackRequestedAt/);
});

test('loadedmetadata cannot report first_frame', () => {
  const start = watchSource.indexOf("this.video?.addEventListener('loadedmetadata'");
  const end = watchSource.indexOf("this.video?.addEventListener('seeking'", start);
  const handler = watchSource.slice(start, end);
  assert.ok(start >= 0 && end > start, 'loadedmetadata handler must exist');
  assert.doesNotMatch(handler, /markPlaybackUsable|reportFirstRenderedFrame|first_frame/);
});

test('media re-attachment cannot reset telemetry within one playback attempt', () => {
  const start = watchSource.indexOf('    async loadVideo(url, options = {}) {');
  const end = watchSource.indexOf('\n    /**\n     * Play HLS stream', start);
  const body = watchSource.slice(start, end);
  assert.ok(start >= 0 && end > start, 'loadVideo must exist');
  assert.doesNotMatch(body, /beginPlaybackTelemetry\(/);
  assert.match(body, /updatePlaybackTelemetrySession\(options\.cloudPlaybackSessionId, playbackAttemptId\)/);
  assert.match(body, /recordPlaybackStartupPhase\('teardownComplete', playbackAttemptId\)/);
  assert.match(body, /recordPlaybackStartupPhase\('mediaAttach', playbackAttemptId\)/);
});

test('requestVideoFrameCallback is authoritative and first_frame is emitted exactly once', () => {
  let frameCallback = null;
  const video = {
    readyState: 2,
    paused: false,
    ended: false,
    error: null,
    src: 'https://media.example/movie.mp4',
    currentSrc: 'https://media.example/movie.mp4',
    currentTime: 0,
    duration: 120,
    videoWidth: 1920,
    videoHeight: 1080,
    requestVideoFrameCallback(callback) {
      frameCallback = callback;
      return 71;
    },
    cancelVideoFrameCallback() {},
  };
  const { page, events } = makeTelemetryPage(video);

  page.armFirstFrameTelemetry(4);
  page.markPlaybackUsable({ allowFirstFrameFallback: true });
  assert.equal(events.length, 0, 'playing must not bypass an available frame callback');

  frameCallback(101, { mediaTime: 0, presentedFrames: 1 });
  frameCallback(102, { mediaTime: 0.04, presentedFrames: 2 });
  page.markPlaybackUsable({ allowFirstFrameFallback: true });

  assert.equal(events.filter(({ type }) => type === 'first_frame').length, 1);
  assert.equal(page.playbackTelemetry.firstFrameReported, true);
  assert.equal(events[0].extra.metadata.frameEvidence, 'video-frame-callback');
});

test('advancing playback recovers when an armed video-frame callback is lost during HLS re-attachment', () => {
  const video = {
    readyState: 3,
    paused: false,
    seeking: false,
    ended: false,
    error: null,
    src: 'blob:https://norva.tv/recovered-media-source',
    currentSrc: 'blob:https://norva.tv/recovered-media-source',
    currentTime: 15,
    duration: 7200,
    videoWidth: 1920,
    videoHeight: 1080,
  };
  const { page, events } = makeTelemetryPage(video);
  let hiddenErrors = 0;
  page._firstFrameObserverAvailable = true;
  page._firstFrameObserverAttemptId = 4;
  page.hidePlaybackError = () => { hiddenErrors += 1; };

  page.markPlaybackUsable({ allowPlaybackProgressFallback: true });
  assert.equal(events.length, 0, 'one post-seek timeupdate only establishes the media baseline');
  video.currentTime = 15.25;
  page.markPlaybackUsable({ allowPlaybackProgressFallback: true });

  assert.equal(events.filter(({ type }) => type === 'first_frame').length, 1);
  assert.equal(events[0].extra.metadata.frameEvidence, 'playback-progress-fallback');
  assert.equal(hiddenErrors, 1, 'real playback progress retires a stale failure banner');
});

test('autoplay policy rejection keeps the prepared media and exposes an explicit Play action without an error', () => {
  const WatchPage = loadWatchPage();
  const page = Object.create(WatchPage.prototype);
  const classes = new Set();
  let hiddenErrors = 0;
  let hiddenLoading = 0;
  let overlayShown = 0;
  Object.assign(page, {
    centerPlayBtn: {
      classList: {
        add(value) { classes.add(value); },
      },
    },
    overlayTimeout: null,
    hidePlaybackError() { hiddenErrors += 1; },
    hideLoading() { hiddenLoading += 1; },
    showOverlay() { overlayShown += 1; },
  });

  page.handleAutoplayError({ name: 'NotAllowedError' });

  assert.equal(hiddenErrors, 1);
  assert.equal(hiddenLoading, 1);
  assert.equal(classes.has('show'), true);
  assert.equal(overlayShown, 1);
});

test('gateway HLS telemetry keeps Gateway authority when hls.js exposes a blob media source', () => {
  const WatchPage = loadWatchPage();
  const page = Object.create(WatchPage.prototype);
  Object.assign(page, {
    video: {
      currentSrc: 'blob:https://norva.tv/active-media-source',
      src: 'blob:https://norva.tv/active-media-source',
    },
    currentPlaybackMode: 'gateway-session',
    currentUrl: 'https://media.norva.tv/sessions/session-1/playlist.m3u8?token=redacted',
    baseStreamUrl: null,
    hls: null,
  });

  assert.equal(page.getTelemetryCurrentSrcType(), 'gateway');

  page.currentPlaybackMode = 'direct-hls';
  page.currentUrl = 'https://provider.example/movie.m3u8';
  assert.equal(page.getTelemetryCurrentSrcType(), 'direct');

  page.currentPlaybackMode = 'gateway-session';
  assert.equal(
    page.getTelemetryCurrentSrcType(),
    'direct',
    'mode alone must not promote an unbound blob to Gateway evidence'
  );
});

test('fallback requires playing media with readyState >= 2 and remains exactly once', () => {
  const video = {
    readyState: 1,
    paused: false,
    ended: false,
    error: null,
    src: 'https://media.example/movie.mp4',
    currentSrc: 'https://media.example/movie.mp4',
    currentTime: 0,
    duration: 120,
    videoWidth: 1920,
    videoHeight: 1080,
  };
  const { page, events } = makeTelemetryPage(video);

  page.markPlaybackUsable();
  page.markPlaybackUsable({ allowFirstFrameFallback: true });
  assert.equal(events.length, 0, 'metadata-only readiness is not rendered-frame evidence');

  video.readyState = 2;
  page.markPlaybackUsable();
  assert.equal(events.length, 0, 'loadeddata/canplay readiness must not emit first_frame');
  page.markPlaybackUsable({ allowFirstFrameFallback: true });
  page.markPlaybackUsable({ allowFirstFrameFallback: true });

  assert.equal(events.filter(({ type }) => type === 'first_frame').length, 1);
  assert.equal(events[0].extra.metadata.frameEvidence, 'playing-ready-state');
});

test('engine audio enrichment is deferred until after first frame', async () => {
  const engineStart = watchSource.indexOf("if (options.mode === 'engine'");
  const engineEnd = watchSource.indexOf('// Get settings for proxy/transcode', engineStart);
  const engineBranch = watchSource.slice(engineStart, engineEnd);
  assert.doesNotMatch(engineBranch, /await this\.enrichCloudPlaybackTracks\(url\)/);
  assert.match(engineBranch, /deferEngineTrackEnrichment\(url, playbackAttemptId\)/);
  assert.ok(
    engineBranch.indexOf('this.getContentAudioTracks().length')
      < engineBranch.indexOf('this.deferEngineTrackEnrichment(url, playbackAttemptId)'),
    'file-scoped cached languages must be applied before live enrichment is deferred'
  );

  const callbacks = [];
  const WatchPage = loadWatchPage({
    setTimeoutImpl(callback) { callbacks.push(callback); return callbacks.length; },
    clearTimeoutImpl() {},
  });
  const page = Object.create(WatchPage.prototype);
  const calls = [];
  Object.assign(page, {
    _playbackAttemptId: 8,
    _firstFrameReported: false,
    _deferredEngineTrackEnrichment: null,
    _deferredEngineTrackEnrichmentTimer: null,
    norvaEngine: {},
    content: { id: 'movie-8', sourceId: 'source-8', type: 'movie' },
    enrichCloudPlaybackTracks(url) { calls.push(url); return Promise.resolve(); },
  });

  page.deferEngineTrackEnrichment('https://media.example/raw/token', 8);
  assert.deepEqual(calls, []);
  page._firstFrameReported = true;
  page.flushDeferredEngineTrackEnrichment(8);
  assert.deepEqual(calls, []);
  assert.equal(callbacks.length, 1);
  callbacks[0]();
  await Promise.resolve();
  assert.deepEqual(calls, ['https://media.example/raw/token']);
});
