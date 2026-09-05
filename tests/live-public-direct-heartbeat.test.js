const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/js/components/VideoPlayer.js'), 'utf8');
const payload = id => ({ sessionId: id, playback: { mode: 'direct', transport: 'public-hls-direct' } });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function harness(heartbeat = async () => ({})) {
  let now = 0, serial = 0;
  const timers = new Map(), calls = [], errors = [], releases = [], events = [];
  const element = () => ({ classList: { add() {}, remove() {} }, querySelector: () => ({ innerHTML: '' }) });
  const window = { NorvaCloud: { token: 'test', playback: {
    heartbeatSession: id => { calls.push({ id, at: now }); return heartbeat(id); },
    expireSession: async id => { releases.push(id); },
  } } };
  const context = vm.createContext({ window, document: { getElementById: () => null }, navigator: {},
    Date: { now: () => now }, Math: { random: () => 0.5, floor: Math.floor, max: Math.max },
    setTimeout: (fn, delay) => { const id = ++serial; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id), console: { log() {}, error() {}, warn() {} },
  });
  vm.runInContext(source, context);
  const player = Object.create(window.VideoPlayer.prototype);
  Object.assign(player, {
    _playRequestSeq: 1, currentCloudPlaybackSessionId: 'a', activeCloudPlaybackSessionIds: new Set(['a']),
    currentChannel: {}, currentUrl: 'https://example.test/live.m3u8',
    overlay: element(), controlsOverlay: element(), nowPlaying: element(),
    video: { pause: () => events.push('pause'), load: () => events.push('load') },
    hls: { destroy: () => events.push('destroy') },
    _clearVariantFallbackTimer() {}, _clearMediaElementErrorTimer() {}, resetGatewayHlsRetries() {},
    stopLiveSyncMonitor() {}, clearExternalSubtitleTracks() {}, stopTranscodeSession: async () => {},
    showError: message => { errors.push(message); },
  });
  async function advance(ms) {
    const end = now + ms;
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at; timers.delete(due[0]); due[1].fn(); await flush();
    }
    now = end; await flush();
  }
  return { player, window, calls, timers, errors, releases, events, advance, context };
}

function prepareStartup(h) {
  Object.assign(h.player, {
    settings: {}, _showChannelSplash() {}, applyQualityGroup() {}, updateTranscodeStatus() {},
    _sendLiveEvent() {}, shouldAutoFallbackVariants: () => false, _hasLocalTranscoder: () => false,
    getHlsConfig: () => ({}), updateNowPlaying() {}, showNowPlayingOverlay() {}, fetchEpgData() {},
    handlePlaybackError: () => assert.fail('unexpected startup error'),
  });
  return () => {
    class Hls {
      static isSupported() { return true; }
      static Events = { MANIFEST_PARSED: 'manifest', ERROR: 'error', FRAG_CHANGED: 'fragment' };
      loadSource(url) { h.events.push(['source', url]); }
      attachMedia() { h.events.push('attach'); }
      on() {}
      destroy() { h.events.push('destroy'); }
    }
    h.context.Hls = Hls;
  };
}

test('only a matching server-marked public direct session starts the monitor', async () => {
  const h = harness();
  for (const value of [null, { mode: 'direct', transport: 'public-hls-direct', sessionId: 'a' },
    { sessionId: 'a', playback: { mode: 'direct' } },
    { sessionId: 'a', playback: { mode: 'relay', transport: 'public-hls-direct' } }, payload('other')]) {
    h.player.startPublicHlsDirectSessionGuard(value);
  }
  assert.equal(h.calls.length, 0);
  assert.equal(h.timers.size, 0);
  h.player.startPublicHlsDirectSessionGuard(payload('a'));
  await flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.player.supportsPublicHlsDirectSessionGuard, true);
  await h.advance(10999);
  assert.equal(h.calls.length, 1);
  await h.advance(1);
  assert.equal(h.calls.length, 2);
});

test('slow heartbeats never overlap and an unanswered pulse stops media within the grace bound', async () => {
  const pending = deferred(), h = harness(() => pending.promise);
  h.player.startPublicHlsDirectSessionGuard(payload('a'));
  await h.advance(29999);
  assert.equal(h.calls.length, 1);
  assert.equal(h.errors.length, 0);
  await h.advance(1);
  assert.deepEqual(h.events.slice(0, 3), ['destroy', 'pause', 'load']);
  assert.deepEqual(h.releases, ['a']);
  assert.equal(h.errors.length, 1);
  assert.equal(h.timers.size, 0);
  pending.resolve({}); await flush();
  await h.advance(60000);
  assert.equal(h.calls.length, 1);
  assert.equal(h.timers.size, 0);
});

test('authorization failures stop immediately without switching variants or creating sessions', async () => {
  for (const status of [401, 403, 404, 410, 409]) {
    const h = harness(async () => { throw { status, payload: { details: { code: 'PLAYBACK_SUPERSEDED' } } }; });
    h.player.startPublicHlsDirectSessionGuard(payload('a'));
    await flush();
    assert.equal(h.errors.length, 1, `status ${status}`);
    assert.ok(h.events.includes('pause'));
    assert.equal(h.timers.size, 0);
    await h.advance(60000);
    assert.equal(h.calls.length, 1);
  }
});

test('network failures use one cadence and stop after 30 seconds without a success', async () => {
  const h = harness(async () => { throw new TypeError('offline'); });
  h.player.startPublicHlsDirectSessionGuard(payload('a'));
  await flush(); await h.advance(29999);
  assert.deepEqual(h.calls.map(c => c.at), [0, 11000, 22000]);
  assert.equal(h.errors.length, 0);
  await h.advance(1);
  assert.equal(h.errors.length, 1);
  assert.equal(h.timers.size, 0);
});

test('a successful heartbeat resets the grace period after a transient failure', async () => {
  let count = 0;
  const h = harness(async () => { if (++count !== 2) throw new Error('offline'); return {}; });
  h.player.startPublicHlsDirectSessionGuard(payload('a'));
  await flush(); await h.advance(40999);
  assert.equal(h.errors.length, 0);
  await h.advance(1);
  assert.equal(h.errors.length, 1);
});

test('a stale rejection cannot stop a replacement session or schedule old work', async () => {
  const old = deferred(), h = harness(id => id === 'a' ? old.promise : Promise.resolve({}));
  h.player.startPublicHlsDirectSessionGuard(payload('a'));
  h.player.stopPublicHlsDirectSessionGuard();
  h.player._playRequestSeq++;
  h.player.currentCloudPlaybackSessionId = 'b';
  h.player.startPublicHlsDirectSessionGuard(payload('b'));
  await flush();
  old.reject({ status: 403 }); await flush();
  await h.advance(11000);
  assert.deepEqual(h.calls.map(c => c.id), ['a', 'b', 'b']);
  assert.equal(h.errors.length, 0);
  assert.equal(h.player.currentCloudPlaybackSessionId, 'b');
});

test('stop and prepareLiveSwitch synchronously cancel monitor timers before release finishes', async () => {
  for (const action of ['stop', 'prepareLiveSwitch']) {
    const pending = deferred(), h = harness(() => pending.promise);
    h.player.startPublicHlsDirectSessionGuard(payload('a'));
    const result = h.player[action]();
    assert.equal(h.timers.size, 0, action);
    pending.reject({ status: 410 }); await result; await flush();
    assert.equal(h.errors.length, 0, action);
    await h.advance(60000);
    assert.equal(h.calls.length, 1, action);
  }
});

test('a new queued play cancels the old monitor before its predecessor resolves', async () => {
  const previous = deferred(), old = deferred(), h = harness(() => old.promise);
  h.player._playQueue = previous.promise;
  h.player.startPublicHlsDirectSessionGuard(payload('a'));
  let received;
  h.player._playInternal = async (...args) => { received = args; };
  const next = payload('b');
  const playing = h.player.play({ cloudPlaybackSessionId: 'b' }, 'https://example.test/b.m3u8', next);
  assert.equal(h.timers.size, 0);
  old.reject({ status: 403 }); await flush();
  assert.equal(h.errors.length, 0);
  previous.resolve(); await playing;
  assert.equal(received[3], next, 'the server decision must survive the play queue');
});

test('missing heartbeat capability aborts startup before media can be attached again', async () => {
  const h = harness();
  delete h.window.NorvaCloud.playback.heartbeatSession;
  Object.assign(h.player, {
    _showChannelSplash() {}, applyQualityGroup() {}, updateTranscodeStatus() {},
    _sendLiveEvent() {}, handlePlaybackError: () => assert.fail('startup must return before a second failure'),
  });
  await h.player._playInternal({ cloudPlaybackSessionId: 'b' }, 'https://example.test/b.m3u8', 1, payload('b'));
  assert.equal(h.errors.length, 1);
  assert.equal(h.player._playRequestSeq, 2);
  assert.equal(h.player.video.src, '', 'startup must not attach the URL after its guard stopped it');
  assert.equal(h.timers.size, 0);
});

for (const phase of ['ensureHls', 'watch.stop']) {
  test(`external teardown cancels startup awaiting ${phase} without reattaching a public stream`, async () => {
    for (const action of ['stop', 'prepareLiveSwitch']) {
      const h = harness(), pending = deferred(), entered = deferred();
      const installHls = prepareStartup(h);
      const wait = () => { entered.resolve(); return pending.promise; };
      if (phase === 'ensureHls') h.window.ensureHls = wait;
      else h.window.app = { pages: { watch: { stop: wait } } };
      const starting = h.player.play({ cloudPlaybackSessionId: 'b' }, 'https://example.test/b.m3u8', payload('b'));
      await entered.promise;
      await h.player[action]();
      installHls(); pending.resolve(true);
      await starting;
      assert.equal(h.events.includes('attach'), false, action);
      assert.equal(h.events.some(event => Array.isArray(event) && event[0] === 'source'), false, action);
      assert.equal(h.calls.length, 0, action);
      assert.equal(h.errors.length, 0, action);
      assert.equal(h.timers.size, 0, action);
      assert.ok(h.releases.includes('b'), 'the canceled source session is released');
    }
  });
}

test('internal predecessor teardown preserves a valid startup and starts its public monitor', async () => {
  const h = harness();
  prepareStartup(h)();
  await h.player.play({ cloudPlaybackSessionId: 'b' }, 'https://example.test/b.m3u8', payload('b'));
  assert.equal(h.events.includes('attach'), true);
  assert.deepEqual(h.calls.map(call => call.id), ['b']);
  assert.equal(h.errors.length, 0);
  assert.equal(h.player._playRequestSeq, 2);
  await h.player.stop();
});

test('terminal playback errors cancel the monitor while an outgoing stale overlay cannot cancel its replacement', async () => {
  const h = harness();
  h.player.startPublicHlsDirectSessionGuard(payload('a')); await flush();
  Object.assign(h.player, { hasCurrentMedia: () => false, tryCurrentVariantFallback: () => false,
    shouldReportPlaybackBroken: () => false, isLivePlayback: () => false });
  h.player.handlePlaybackError('fatal media error');
  assert.equal(h.timers.size, 0);
  h.player.startPublicHlsDirectSessionGuard(payload('a')); await flush();
  h.player._pendingLiveSelection = { selectSeq: 2 };
  h.player.currentChannel = { _norvaSelection: { selectSeq: 1 } };
  h.window.VideoPlayer.prototype.showError.call(h.player, 'stale error');
  assert.equal(h.timers.size, 2);
  h.player._pendingLiveSelection = null;
  h.player._hideChannelSplash = () => {};
  h.window.VideoPlayer.prototype.showError.call(h.player, 'failed play');
  assert.equal(h.timers.size, 0);
});

test('API advertises the guard only for live web sessions with a capable loaded player', () => {
  const api = fs.readFileSync(path.join(__dirname, '../public/js/api.js'), 'utf8');
  const start = api.indexOf('const baseSession = {');
  const end = api.indexOf('\n                };', start);
  assert.ok(start > 0 && end > start);
  const build = api.slice(start, end + '\n                };'.length) + '\nbaseSession;';
  for (const [type, nativePlayer, capability, expected] of [
    ['live', false, true, true], ['live', false, false, false], ['live', false, undefined, false],
    ['live', true, true, false], ['movie', false, true, false], ['series', false, true, false],
  ]) {
    const result = vm.runInNewContext(build, { type, nativePlayer, window: { app: { player: { supportsPublicHlsDirectSessionGuard: capability } } },
      cloudSourceId: 'source', streamId: 'item', playbackHint: {}, query: new URLSearchParams(),
      mode: 'transcode', forcedMode: false, userAgent: '', _cloudClientTelemetryMetadata: () => ({}) });
    assert.equal(result.publicHlsDirectSessionGuard, expected);
  }
});
