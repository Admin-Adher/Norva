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

function loadWatchPage() {
  const context = {
    window: {},
    console,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(watchSource, context, { filename: 'WatchPage.js' });
  return context.window.WatchPage;
}

function makeStoppingPage({ firstFrameReported, video = null }) {
  const WatchPage = loadWatchPage();
  const page = Object.create(WatchPage.prototype);
  let storyboardCalls = 0;
  let languageIntentCalls = 0;
  let languageQueueCalls = 0;

  Object.assign(page, {
    _firstFrameReported: firstFrameReported,
    _playbackAttemptId: 23,
    _watchedLanguageValidationIntent: null,
    _suspendResumeSnapshotSave: true,
    _gatewaySeekRequestId: 0,
    _seekDebounceTimer: null,
    _pendingLocalSeekTimer: null,
    qualityBadgeEl: null,
    hls: null,
    video,
    cancelFirstFrameTelemetryObserver() {},
    cancelDeferredEngineTrackEnrichment() {},
    enqueueStoryboardForCache() { storyboardCalls += 1; },
    rememberWatchedLanguageValidationIntent(playbackAttemptId) {
      languageIntentCalls += 1;
      this._watchedLanguageValidationIntent = { playbackAttemptId };
      return this._watchedLanguageValidationIntent;
    },
    queueWatchedLanguageValidation() {
      languageQueueCalls += 1;
      return Promise.resolve();
    },
    destroyEngine() {},
    stopSubtitleEngine() {},
    stopHistoryTracking() {},
    updateTranscodeStatus() {},
    clearExternalSubtitleTracks() {},
    updateDurationState() {},
    stopTranscodeSession() { return Promise.resolve(); },
    stopCloudPlaybackSessions() { return Promise.resolve(); },
  });

  return {
    page,
    storyboardCalls: () => storyboardCalls,
    languageIntentCalls: () => languageIntentCalls,
    languageQueueCalls: () => languageQueueCalls,
  };
}

test('stop before a true first frame does not enqueue storyboard generation', async () => {
  const { page, storyboardCalls } = makeStoppingPage({ firstFrameReported: false });

  await page.stop();

  assert.equal(storyboardCalls(), 0);
});

test('a genuine exit after a true first frame may warm the storyboard cache', async () => {
  const { page, storyboardCalls } = makeStoppingPage({ firstFrameReported: true });

  await page.stop();

  assert.equal(storyboardCalls(), 1);
});

test('stop queues watched-file language validation from strict media evidence when frame telemetry was lost', async () => {
  const video = {
    error: null,
    readyState: 4,
    videoWidth: 1280,
    videoHeight: 720,
    currentTime: 17.5,
    currentSrc: 'blob:https://norva.tv/media-source',
    src: '',
    pause() {},
    load() {},
  };
  const { page, storyboardCalls, languageIntentCalls, languageQueueCalls } = makeStoppingPage({
    firstFrameReported: false,
    video,
  });

  await page.stop();
  await Promise.resolve();

  assert.equal(storyboardCalls(), 0, 'lost telemetry must not loosen storyboard authorization');
  assert.equal(languageIntentCalls(), 1);
  assert.equal(languageQueueCalls(), 1);
});

test('internal source replacement never infers watched-file language validation', async () => {
  const video = {
    error: null,
    readyState: 4,
    videoWidth: 1280,
    videoHeight: 720,
    currentTime: 17.5,
    currentSrc: 'blob:https://norva.tv/stale-media-source',
    src: '',
    pause() {},
    load() {},
  };
  const { page, languageIntentCalls, languageQueueCalls } = makeStoppingPage({
    firstFrameReported: false,
    video,
  });

  await page.stop({ enqueueStoryboard: false });
  await Promise.resolve();

  assert.equal(languageIntentCalls(), 0);
  assert.equal(languageQueueCalls(), 0);
});

test('loadVideo teardown explicitly disables storyboard generation for incoming media', async () => {
  const WatchPage = loadWatchPage();
  const page = Object.create(WatchPage.prototype);
  let afterStop = false;
  let stopOptions;

  Object.assign(page, {
    _playbackAttemptId: 17,
    noteCloudPlaybackLaneForAttempt() {},
    isStalePlaybackAttempt() { return afterStop; },
    isLikelyPlaybackUrl() { return true; },
    hidePlaybackError() {},
    stop(options) {
      stopOptions = options;
      afterStop = true;
      return Promise.resolve();
    },
    cleanupStaleCloudPlaybackSession() { return Promise.resolve(); },
  });

  await page.loadVideo('https://media.example/title.mkv', {
    playbackAttemptId: 17,
    cloudPlaybackSessionId: 'session-17',
  });

  assert.equal(stopOptions?.enqueueStoryboard, false);
});
