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

function makeStoppingPage({ firstFrameReported }) {
  const WatchPage = loadWatchPage();
  const page = Object.create(WatchPage.prototype);
  let storyboardCalls = 0;

  Object.assign(page, {
    _firstFrameReported: firstFrameReported,
    _suspendResumeSnapshotSave: true,
    _gatewaySeekRequestId: 0,
    _seekDebounceTimer: null,
    _pendingLocalSeekTimer: null,
    qualityBadgeEl: null,
    hls: null,
    video: null,
    cancelFirstFrameTelemetryObserver() {},
    cancelDeferredEngineTrackEnrichment() {},
    enqueueStoryboardForCache() { storyboardCalls += 1; },
    destroyEngine() {},
    stopSubtitleEngine() {},
    stopHistoryTracking() {},
    updateTranscodeStatus() {},
    clearExternalSubtitleTracks() {},
    updateDurationState() {},
    stopTranscodeSession() { return Promise.resolve(); },
    stopCloudPlaybackSessions() { return Promise.resolve(); },
  });

  return { page, storyboardCalls: () => storyboardCalls };
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
