const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/js/utils/standalone.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const session = id => `60000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function fixture({ resolveFresh, expire, release } = {}) {
  const launches = [], resolutions = [], expirations = [], timers = [], notices = [];
  const listeners = new Map();
  const renders = [];
  class WatchPage {}
  class VideoPlayer {
    constructor() { this.activeCloudPlaybackSessionIds = new Set(); }
    registerCloudPlaybackSession(id) {
      this.currentCloudPlaybackSessionId = id;
      this.activeCloudPlaybackSessionIds.add(id);
    }
    async prepareLiveSwitch() {
      const ids = Array.from(this.activeCloudPlaybackSessionIds);
      this.currentCloudPlaybackSessionId = null;
      this.activeCloudPlaybackSessionIds.clear();
      if (release) await release();
      for (const id of ids) await window.NorvaCloud.playback.expireSession(id);
    }
  }
  const location = { hash: '#live', origin: 'https://norva.tv', search: '' };
  const document = {
    readyState: 'complete', addEventListener() {}, getElementById() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    body: { classList: { contains() { return false; } } },
  };
  const channelList = { currentChannel: null };
  const window = {
    NorvaTVCloud: { playVideoJson(payload) { launches.push(JSON.parse(payload)); } },
    NorvaCloud: { token: 'fixture-token', playback: { async expireSession(id) {
      expirations.push(id);
      if (expire) await expire(id);
      return { session: { id, status: 'expired' }, gatewayErrors: 0 };
    } } },
    WatchPage, VideoPlayer, __norvaNative: {}, location,
    history: { state: null, back() {} },
    app: { currentPage: 'live', channelList,
      liveGuideFusion: {
        currentChannel: null,
        refreshPreview() { renders.push(['preview', channelList.currentChannel]); },
        refreshRows() { renders.push(['rows', channelList.currentChannel]); },
        updateHighlights() { renders.push(['highlights', channelList.currentChannel]); },
      },
      showToast(...args) { notices.push(args); },
    },
    API: { proxy: { xtream: { async getStreamUrl(...args) {
      resolutions.push(args);
      return resolveFresh ? resolveFresh(...args) : { url: 'https://gateway.example/live.m3u8', sessionId: session(2) };
    } } } },
    addEventListener(name, listener) {
      const entries = listeners.get(name) || [];
      entries.push(listener); listeners.set(name, entries);
    },
    dispatchEvent() {},
  };
  vm.runInNewContext(source, {
    window, document, location, WatchPage, VideoPlayer,
    localStorage: { getItem() { return null; }, setItem() {} },
    navigator: { userAgent: 'NorvaTV-test' }, URL,
    Date: class extends Date { static now() { return 10_000; } }, Map, Set, Promise,
    console: { log() {}, warn() {}, error() {}, info() {} },
    CustomEvent: class CustomEvent {},
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
    clearTimeout() {},
  });
  const player = new VideoPlayer(); window.app.player = player;
  const play = async (id = 1, options = {}) => {
    window.__norvaResetPlayThrottle();
    const channel = {
      id: `channel-${id}`, streamId: String(id), sourceId: options.sourceId || 'fixture-live',
      sourceType: 'xtream', name: 'Test channel', cloudPlaybackSessionId: session(id),
    };
    await player.play(channel, options.resolver || 'https://provider.example/live.ts', { sessionId: session(id) });
    // Mirrors ChannelList's successful native launch commit.
    channelList.currentChannel = channel;
    window.app.liveGuideFusion.currentChannel = channel;
    return channel;
  };
  const retry = (token = 'recovery-token', id = 1, sourceId = 'fixture-live') =>
    window.__norvaNative.retryPlayback(sourceId, 'channel', String(id), 0, 'provider_html_response', token);
  const close = id => window.__norvaNative.onPlaybackClosed(session(id), 'recovery_abandoned');
  const navigate = hash => {
    location.hash = hash;
    for (const fn of listeners.get('hashchange') || []) fn();
  };
  return { window, player, play, retry, close, navigate, timers, launches, resolutions, expirations, notices, renders };
}

test('Live Back before retry timer invalidates the intent and clears only its Playing state', async () => {
  const f = fixture(); const channel = await f.play();
  assert.equal(f.retry(), 'scheduled');
  assert.equal(f.close(1), 'accepted');
  await f.timers[0].callback(); await tick();
  assert.equal(f.retry(), 'cancelled');
  assert.equal(f.resolutions.length, 0);
  assert.equal(f.launches.length, 1);
  assert.equal(f.player.currentChannel, null);
  assert.equal(f.window.app.channelList.currentChannel, null);
  assert.equal(f.window.app.liveGuideFusion.currentChannel, channel, 'preview selection remains available for explicit Play');
  assert.deepEqual(f.renders.map(([kind]) => kind), ['preview', 'rows', 'highlights']);
  assert.deepEqual(f.expirations, [session(1)]);
});

for (const token of ['recovery-token', '']) {
  for (const outcome of ['ready', 'rejected']) {
    test(`Live Back during ${token ? 'token' : 'legacy'} resolution discards a ${outcome} replacement without another retry`, async () => {
      const response = deferred();
      const f = fixture({ resolveFresh: () => response.promise }); await f.play();
      assert.equal(f.retry(token), 'scheduled');
      const running = f.timers[0].callback(); await tick();
      assert.equal(f.resolutions.length, 1);
      assert.equal(f.player.currentCloudPlaybackSessionId, null, 'recovery already removed old registry entry');
      f.close(1);
      if (outcome === 'ready') response.resolve({ url: 'https://gateway.example/late.m3u8', sessionId: session(2) });
      else response.reject(new Error('late resolver failure'));
      await running; await tick();
      assert.equal(f.launches.length, 1);
      assert.equal(f.timers.length, 1, 'a closed intent must not schedule another timer, even without a token');
      assert.equal(f.notices.length, 0);
      assert.equal(f.expirations.filter(id => id === session(2)).length, outcome === 'ready' ? 1 : 0);
      assert.equal(f.player.activeCloudPlaybackSessionIds.has(session(2)), false);
      assert.equal(f.window.app.channelList.currentChannel, null);
    });
  }
}

test('Live Back while release is pending never calls the provider resolver', async () => {
  const released = deferred();
  const f = fixture({ release: () => released.promise }); await f.play();
  f.retry(); const running = f.timers[0].callback(); await tick();
  f.close(1); released.resolve(); await running; await tick();
  assert.equal(f.resolutions.length, 0);
  assert.equal(f.launches.length, 1);
});

test('Live recovery after an old Activity close still waits for its exact expiry', async () => {
  const released = deferred();
  const f = fixture({ expire: id => id === session(1) ? released.promise : undefined });
  await f.play(); await f.play(3);
  f.close(1);
  assert.equal(f.retry('next-token', 3), 'scheduled');
  const running = f.timers[0].callback(); await tick();
  assert.equal(f.resolutions.length, 0, 'do not create a second provider lane while exact close is pending');
  released.resolve(); await running;
  assert.equal(f.resolutions.length, 1);
  assert.equal(f.launches.length, 3);
});

test('a delayed Live close and resolver cannot clear or launch over a newer source intent', async () => {
  const response = deferred(); const f = fixture({ resolveFresh: () => response.promise });
  await f.play(); f.retry(); const running = f.timers[0].callback(); await tick();
  const next = await f.play(3, { sourceId: 'second-source' });
  f.close(1);
  response.resolve({ url: 'https://gateway.example/late.m3u8', sessionId: session(2) });
  await running; await tick();
  assert.equal(f.launches.length, 2);
  assert.equal(f.window.app.channelList.currentChannel, next);
  assert.equal(f.player.currentChannel, next);
  assert.equal(f.player.currentCloudPlaybackSessionId, session(3));
  assert.equal(f.player.activeCloudPlaybackSessionIds.has(session(3)), true);
  assert.equal(f.expirations.includes(session(3)), false);
  assert.equal(f.expirations.filter(id => id === session(2)).length, 1);
  assert.deepEqual(f.renders, []);
  assert.equal(f.retry('next-token', 3, 'second-source'), 'scheduled');
});

for (const invalidation of ['route', 'token']) {
  test(`Live ${invalidation} change during resolution expires only the stale receipt`, async () => {
    const response = deferred(); const f = fixture({ resolveFresh: () => response.promise });
    await f.play(); f.retry(); const running = f.timers[0].callback(); await tick();
    if (invalidation === 'route') f.navigate('#movies');
    else assert.equal(f.retry('new-token'), 'scheduled');
    response.resolve({ url: 'https://gateway.example/late.m3u8', sessionId: session(2) });
    await running;
    assert.equal(f.launches.length, 1);
    assert.equal(f.expirations.filter(id => id === session(2)).length, 1);
  });
}

test('legacy Live recovery without a close and token remains permitted', async () => {
  const f = fixture(); await f.play();
  assert.equal(f.retry(''), 'scheduled'); await f.timers[0].callback();
  assert.equal(f.launches.length, 2);
  assert.equal(f.launches[1].sessionId, session(2));
});

test('route departure during initial Live resolution expires its receipt without a native launch', async () => {
  const response = deferred(); const f = fixture();
  const list = f.window.app.channelList;
  const listSource = fs.readFileSync(path.join(__dirname, '../public/js/components/ChannelList.js'), 'utf8');
  const start = listSource.indexOf('    commitPlaybackChannel(channel) {');
  const end = listSource.indexOf('    async selectChannel(dataset)', start);
  assert.ok(start > 0 && end > start);
  const methods = vm.runInNewContext(`class Selection { ${listSource.slice(start, end)} }; Selection`, { window: f.window });
  list.commitPlaybackChannel = methods.prototype.commitPlaybackChannel;
  list.failPendingPlaybackSelection = methods.prototype.failPendingPlaybackSelection;
  list._selectRequestSeq = 1;
  list._pendingPlaybackSelection = { selectSeq: 1 };
  const channel = { id: 'channel-1', streamId: '1', sourceId: 'fixture-live', sourceType: 'xtream',
    cloudPlaybackSessionId: session(1), _norvaSelection: { selectSeq: 1 } };
  const running = f.player.play(channel, () => response.promise, { sessionId: session(1) }); await tick();
  f.navigate('#movies');
  response.resolve({ url: 'https://gateway.example/late.m3u8', sessionId: session(1) });
  await running;
  assert.equal(list.commitPlaybackChannel(channel), false, 'real ChannelList cannot commit an abandoned native launch');
  assert.equal(list._pendingPlaybackSelection, null);
  assert.equal(list.currentChannel, null);
  assert.equal(f.launches.length, 0);
  assert.deepEqual(f.expirations, [session(1)]);
});

test('Live close after navigation clears the old Playing state without changing the preview', async () => {
  const f = fixture(); const channel = await f.play();
  f.navigate('#movies'); f.close(1); await tick();
  assert.equal(f.window.app.channelList.currentChannel, null);
  assert.equal(f.player.currentChannel, null);
  assert.equal(f.window.app.liveGuideFusion.currentChannel, channel);
  assert.equal(f.renders.filter(([kind]) => kind === 'rows').length, 1);
});

test('Live close cannot clear a newer intent that reuses the same channel object', async () => {
  const f = fixture(); const channel = await f.play();
  f.navigate('#movies'); f.navigate('#live');
  channel.cloudPlaybackSessionId = session(3);
  f.window.__norvaResetPlayThrottle();
  await f.player.play(channel, 'https://provider.example/new.ts', { sessionId: session(3) });
  f.close(1); await tick();
  assert.equal(f.window.app.channelList.currentChannel, channel);
  assert.equal(f.player.currentChannel, channel);
  assert.equal(f.player.currentCloudPlaybackSessionId, session(3));
  assert.deepEqual(f.renders, []);
});

test('failed exact expiry of a cancelled Live receipt cannot retry or affect a newer session', async () => {
  const response = deferred();
  const f = fixture({ resolveFresh: () => response.promise,
    expire: id => { if (id === session(2)) throw new Error('expiry unavailable'); },
  });
  await f.play(); f.retry(); const running = f.timers[0].callback(); await tick();
  f.close(1); const next = await f.play(3);
  response.resolve({ url: 'https://gateway.example/late.m3u8', sessionId: session(2) });
  await running; await tick();
  assert.equal(f.resolutions.length, 1);
  assert.equal(f.timers.length, 1);
  assert.equal(f.launches.length, 2);
  assert.equal(f.notices.length, 0);
  assert.equal(f.window.app.channelList.currentChannel, next);
  assert.equal(f.player.currentCloudPlaybackSessionId, session(3));
  assert.equal(f.expirations.filter(id => id === session(2)).length, 1);
  assert.equal(f.expirations.includes(session(3)), false);
});

for (const refusal of ['throttled', 'missing-url']) test(`a ${refusal} Live relaunch expires its receipt before any retry`, async () => {
  const expired = deferred();
  const f = fixture({ expire: id => id === session(2) ? expired.promise : undefined,
    ...(refusal === 'missing-url' ? { resolveFresh: async () => ({ sessionId: session(2), url: null }) } : {}),
  });
  const channel = await f.play();
  // Keep the real double-tap guard active at the deterministic same timestamp.
  f.window.__norvaResetPlayThrottle = () => {};
  f.retry(); const running = f.timers[0].callback(); await tick();
  assert.equal(f.expirations.filter(id => id === session(2)).length, 1);
  assert.equal(f.launches.length, 1);
  assert.equal(f.timers.length, 1, 'retry waits for exact close completion');
  assert.equal(channel.cloudPlaybackSessionId, null, 'rejected native relaunch is never registered');
  f.close(1); expired.resolve(); await running; await tick();
  assert.equal(f.timers.length, 1, 'Back during receipt cleanup suppresses the retry too');
  assert.equal(f.player.activeCloudPlaybackSessionIds.has(session(2)), false);
});

test('unconfirmed expiry of a malformed Live replacement prevents another automatic provider session', async () => {
  const f = fixture({
    resolveFresh: async () => ({ url: null, sessionId: session(2) }),
    expire: id => { if (id === session(2)) throw new Error('expiry unavailable'); },
  });
  await f.play(); f.retry(); await f.timers[0].callback(); await tick();
  assert.equal(f.resolutions.length, 1);
  assert.equal(f.expirations.filter(id => id === session(2)).length, 1);
  assert.equal(f.timers.length, 1, 'failed release must not consume another provider lane');
  assert.equal(f.launches.length, 1);
  assert.equal(f.notices.length, 1, 'the still-active viewer receives the existing recovery error');
});
