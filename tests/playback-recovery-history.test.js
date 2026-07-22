const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function loadWatchPage() {
  const source = fs.readFileSync(path.join(ROOT, 'public', 'js', 'pages', 'WatchPage.js'), 'utf8');
  const context = { window: {}, console, setTimeout, clearTimeout, URL, Promise };
  vm.runInNewContext(source, context, { filename: 'WatchPage.js' });
  return { WatchPage: context.window.WatchPage, window: context.window };
}

function loadNorvaEngine() {
  const source = fs.readFileSync(path.join(ROOT, 'public', 'js', 'norvaEngine.js'), 'utf8');
  const context = {
    window: {},
    document: { createElement: () => ({}) },
    navigator: { userAgent: 'node-test' },
    performance,
    console,
    URL,
    fetch,
    AbortController,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    TextDecoder,
    crypto,
  };
  context.self = context.window;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'norvaEngine.js' });
  return context.window.NorvaEngine;
}

test('a recovery MSE duration cannot shrink the authoritative VOD duration', () => {
  const { WatchPage } = loadWatchPage();
  const page = Object.create(WatchPage.prototype);
  page.contentType = 'movie';
  page.content = { type: 'movie' };
  page.video = { duration: 89, currentTime: 89 };
  page.durationHint = null;
  page.probeDuration = null;
  page._diagCodecProfile = { durationSeconds: 6529 };
  page._lastKnownPlaybackDuration = 6529;
  page._lastKnownPlaybackPosition = 83;
  page.streamStartOffset = 0;
  page.currentPlaybackMode = null;

  assert.equal(page.getStablePlaybackDuration(), 6529);
  page.trackPlaybackPosition({ position: 89, force: true });
  assert.equal(page._lastKnownPlaybackDuration, 6529);
  assert.equal(page._lastKnownPlaybackPosition, 89);
});

test('synthetic ended during engine recovery preserves resume and never marks completion', async () => {
  const { WatchPage } = loadWatchPage();
  const calls = [];
  const page = Object.create(WatchPage.prototype);
  page.contentType = 'movie';
  page.content = { id: '1003536', sourceId: 'ferran', type: 'movie' };
  page.video = { duration: 89, currentTime: 89 };
  page.durationHint = null;
  page.probeDuration = null;
  page._diagCodecProfile = { durationSeconds: 6529 };
  page._lastKnownPlaybackDuration = 6529;
  page._lastKnownPlaybackPosition = 83;
  page.streamStartOffset = 0;
  page.currentPlaybackMode = 'engine';
  page.norvaEngine = null;
  page._playbackEnded = false;
  page.playbackTelemetry = { ended: false };
  page.sendPlaybackEvent = (type) => calls.push(['event', type]);
  page.saveResumeSnapshotThrottled = (force) => calls.push(['resume', force]);
  page.saveProgress = (options) => { calls.push(['save', options]); return Promise.resolve(); };
  page.clearResumeSnapshot = () => calls.push(['clear-resume']);
  page._clearResumePosition = () => calls.push(['clear-position']);

  page.onEnded();
  await Promise.resolve();

  assert.equal(page._playbackEnded, false);
  assert.equal(page.playbackTelemetry.ended, false);
  assert.equal(page._lastKnownPlaybackDuration, 6529);
  assert.equal(page._lastKnownPlaybackPosition, 89);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ['resume', true]);
  assert.equal(calls[1][0], 'save');
  assert.equal(calls[1][1].force, true);
});

test('history keeps exact-file duration while a recovery element exposes only its short buffer', async () => {
  const { WatchPage, window } = loadWatchPage();
  let request = null;
  window.API = {
    request: async (method, route, payload) => { request = { method, route, payload }; },
  };
  window.app = { pages: {} };

  const page = Object.create(WatchPage.prototype);
  page.contentType = 'movie';
  page.content = {
    id: '1003536', sourceId: 'ferran', type: 'movie', title: 'Kartavya', poster: null,
  };
  page.video = { paused: false, duration: 89, currentTime: 89 };
  page.durationHint = null;
  page.probeDuration = null;
  page._diagCodecProfile = { durationSeconds: 6529 };
  page._lastKnownPlaybackDuration = 6529;
  page._lastKnownPlaybackPosition = 89;
  page.streamStartOffset = 0;
  page.currentPlaybackMode = null;
  page.currentSeason = null;
  page.currentEpisode = null;
  page.containerExtension = 'mkv';
  page._historyMetaSentFor = null;
  page.getResumeSnapshotPosition = () => 89;
  page.saveResumeSnapshot = () => {};
  page.getPlaybackPreferences = () => ({ audio: { language: 'fr', streamIndex: 6 } });

  await page.saveProgress({ force: true });

  assert.equal(request.method, 'POST');
  assert.equal(request.route, '/history');
  assert.equal(request.payload.progress, 89);
  assert.equal(request.payload.duration, 6529);
  assert.equal(request.payload.data.durationHint, 6529);
});

test('engine destroy does not finalise MediaSource during a recovery hand-off', () => {
  const NorvaEngine = loadNorvaEngine();
  let endOfStreamCalls = 0;
  const video = { removeEventListener() {} };
  const engine = new NorvaEngine(video, {});
  engine.ms = {
    readyState: 'open',
    endOfStream() { endOfStreamCalls += 1; },
  };
  engine.lib = { terminate() {} };

  engine.destroy();

  assert.equal(endOfStreamCalls, 0);
  assert.equal(engine.destroyed, true);
  assert.equal(engine._stopRequested, true);
});
