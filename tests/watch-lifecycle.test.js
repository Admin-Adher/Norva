const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
    trackPlaybackPosition(options) { calls.push(['track', options]); },
    saveResumeSnapshotThrottled(force) { calls.push(['snapshot', force]); },
    saveProgress(options) { calls.push(['save', options]); return Promise.resolve(); },
    stop() { calls.push('stop'); },
    clearResumeSnapshot() { calls.push('clear'); },
  };

  hide.call(page);
  await Promise.resolve();

  assert.equal(calls.filter((call) => call === 'stop').length, 1);
  assert.deepEqual(calls.find((call) => Array.isArray(call) && call[0] === 'save'), ['save', { force: true }]);
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
  const outgoingSave = playBody.indexOf('this.saveProgress({ force: true })');
  const outgoingStop = playBody.indexOf('await this.stop()');
  assert.ok(outgoingSave >= 0 && outgoingSave < assignContent,
    'the old episode must be saved before the new content id is assigned');
  assert.ok(outgoingStop > outgoingSave && outgoingStop < assignContent,
    'the old media clock and history timer must be stopped before the new identity is assigned');
  assert.ok(playBody.includes("if (this.app?.currentPage !== 'watch')"));
  assert.ok(!playBody.includes("this.app.navigateTo('watch', true);\n        document"),
    'same-page handoff must not invoke WatchPage.hide');
});
