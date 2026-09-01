const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadHideMethod() {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'pages', 'WatchPage.js'),
    'utf8'
  ).replace(/\r\n/g, '\n');
  const start = source.indexOf('    hide() {');
  const end = source.indexOf('\n    // ============================================================', start);
  assert.ok(start >= 0 && end > start, 'WatchPage.hide not found');
  const method = source.slice(start, end);
  const open = method.indexOf('{');
  const close = method.lastIndexOf('\n    }');
  assert.ok(open >= 0 && close > open, 'WatchPage.hide body not found');
  return new Function(method.slice(open + 1, close));
}

const hide = loadHideMethod();
const source = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'pages', 'WatchPage.js'),
  'utf8'
).replace(/\r\n/g, '\n');

test('leaving Watch outside goBack saves progress and stops background playback', async () => {
  const calls = [];
  const page = {
    _goingBack: false,
    _suspendResumeSnapshotSave: false,
    cancelNextEpisode() { calls.push('cancel'); },
    beginPlaybackAttempt() { calls.push('invalidate'); },
    persistPlaybackStateForExit() { calls.push('persist'); },
    deactivateHistoryPersistence() { calls.push('deactivate'); },
    stop() { calls.push('stop'); },
    clearResumeSnapshot() { calls.push('clear'); },
  };

  hide.call(page);
  await Promise.resolve();

  assert.equal(calls.filter((call) => call === 'stop').length, 1);
  assert.ok(calls.indexOf('invalidate') < calls.indexOf('stop'),
    'route exit must invalidate a pending resolver before teardown');
  assert.ok(calls.indexOf('persist') < calls.indexOf('deactivate'));
  assert.ok(calls.indexOf('deactivate') < calls.indexOf('stop'));
  assert.equal(page._suspendResumeSnapshotSave, false);
});

test('goBack remains the single teardown owner during its own navigation', () => {
  const calls = [];
  hide.call({
    _goingBack: true,
    cancelNextEpisode() { calls.push('cancel'); },
    stop() { calls.push('stop'); },
  });
  assert.deepEqual(calls, ['cancel']);
});

test('page teardown persists progress and expires cloud sessions with keepalive', () => {
  const calls = [];
  const page = {
    persistPlaybackStateForExit() { calls.push(['progress']); },
    stopCloudPlaybackSessions(options) {
      calls.push(['expire', options]);
      return Promise.resolve();
    },
  };
  const start = source.indexOf('    persistPlaybackStateAndSessionsForExit() {');
  const end = source.indexOf('\n    }', start);
  const method = source.slice(start, end + 6);
  const open = method.indexOf('{');
  const close = method.lastIndexOf('\n    }');
  const run = new Function(method.slice(open + 1, close));

  run.call(page);

  assert.deepEqual(calls, [
    ['progress'],
    ['expire', { keepalive: true }],
  ]);
  assert.ok(source.includes('expireSession(sessionId, options)'));
});

test('same-route episode handoff saves the outgoing identity without hiding Watch', () => {
  const playStart = source.indexOf('    async play(content, streamUrl, playback = {}) {');
  const playBody = source.slice(playStart, source.indexOf('\n    async ', playStart + 20));
  const assignContent = playBody.indexOf('this.content = content');
  const outgoingSave = playBody.indexOf('this.persistPlaybackStateForExit()');
  const outgoingDeactivate = playBody.indexOf('this.deactivateHistoryPersistence()');
  const outgoingStop = playBody.indexOf('await this.stop({ preservePlaybackResolutionAttempt: true })');
  assert.ok(outgoingSave >= 0 && outgoingSave < assignContent,
    'the old episode must be saved before the new content id is assigned');
  assert.ok(outgoingStop > outgoingSave && outgoingStop < assignContent,
    'the old media clock and history timer must be stopped before the new identity is assigned');
  assert.ok(outgoingDeactivate > outgoingSave && outgoingDeactivate < outgoingStop,
    'the outgoing identity must become inactive before its media clock is reset');
  assert.ok(playBody.includes("if (this.app?.currentPage !== 'watch')"));
  assert.ok(!playBody.includes("this.app.navigateTo('watch', true);\n        document"),
    'same-page handoff must not invoke WatchPage.hide');
});

function loadWatchPage() {
  const context = {
    window: {},
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    Promise,
  };
  vm.runInNewContext(source, context, { filename: 'WatchPage.js' });
  return { WatchPage: context.window.WatchPage, window: context.window };
}

function historyHarness(WatchPage, window, { type = 'movie', position = 2889 } = {}) {
  const writes = [];
  const snapshots = [];
  window.API = {
    request: async (method, route, payload, options = {}) => {
      writes.push({ method, route, payload, options });
      return {};
    },
  };
  window.app = { pages: {} };
  const page = Object.create(WatchPage.prototype);
  Object.assign(page, {
    content: {
      id: type === 'movie' ? 'movie-42' : 'episode-402',
      type,
      sourceId: 'source-7',
      seriesId: type === 'series' ? 'series-4' : null,
      title: type === 'movie' ? 'Santastein' : 'Series',
    },
    contentType: type,
    currentSeason: type === 'series' ? 4 : null,
    currentEpisode: type === 'series' ? 2 : null,
    video: { paused: false, currentTime: position, duration: 5248 },
    durationHint: 5248,
    _lastKnownPlaybackPosition: position,
    _lastKnownPlaybackDuration: 5248,
    _pendingSeekTarget: null,
    _historyPersistenceActive: true,
    _historyPersistenceGeneration: 3,
    _exitHistoryCapture: null,
    _suspendResumeSnapshotSave: false,
    _historyMetaSentFor: null,
    getPlaybackPosition() { return this.video.currentTime; },
    getStablePlaybackDuration() { return 5248; },
    getDisplayDuration() { return 5248; },
    saveResumeSnapshot(value) { snapshots.push(value); },
    getPlaybackPreferences() { return {}; },
    getNextEpisode() { return null; },
    sanitizeNextEpisodeForHistory() { return null; },
    containerExtension: 'mkv',
    resumeTime: 0,
  });
  return { page, writes, snapshots };
}

for (const type of ['movie', 'series']) {
  test(`${type} route exit keeps the final position and rejects a stale zero after teardown`, async () => {
    const { WatchPage, window } = loadWatchPage();
    const { page, writes, snapshots } = historyHarness(WatchPage, window, { type });

    assert.equal(page.persistPlaybackStateForExit(), true);
    page.deactivateHistoryPersistence();
    page.video.currentTime = 0;
    page._lastKnownPlaybackPosition = 0;
    assert.equal(page.persistPlaybackStateForExit(), false);
    await page.saveProgress({ force: true });
    await Promise.resolve();

    assert.equal(writes.length, 1);
    assert.equal(writes[0].payload.progress, 2889);
    assert.equal(writes[0].payload.duration, 5248);
    assert.equal(writes[0].payload.type, type === 'movie' ? 'movie' : 'episode');
    assert.equal(writes[0].options.keepalive, true);
    assert.equal(snapshots.length, 2, 'exit snapshot and history snapshot must carry the same frozen position');
    assert.equal(snapshots.every((entry) => entry.position === 2889), true);
  });
}

test('reload and tab-close events reuse one immutable capture even if the media clock resets', async () => {
  const { WatchPage, window } = loadWatchPage();
  const { page, writes } = historyHarness(WatchPage, window, {});

  page.persistPlaybackStateForExit();
  page.video.currentTime = 0;
  page.persistPlaybackStateForExit();
  await Promise.resolve();

  assert.equal(writes.length, 2);
  assert.deepEqual(writes.map((entry) => entry.payload.progress), [2889, 2889]);
  assert.equal(writes[0].payload.watchedAt, writes[1].payload.watchedAt,
    'duplicate browser exit events must preserve the original causal capture time');
});

test('a deliberate seek to zero remains persistable while the lifecycle is active', async () => {
  const { WatchPage, window } = loadWatchPage();
  const { page, writes } = historyHarness(WatchPage, window, { position: 0 });

  page.trackPlaybackPosition({ position: 0, force: true });
  page.persistPlaybackStateForExit();
  await Promise.resolve();

  assert.equal(writes.length, 1);
  assert.equal(writes[0].payload.progress, 0);
});
