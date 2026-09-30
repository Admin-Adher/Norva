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

function fixture({ resolveFresh, expire, release, abortable = false, userAgent = 'NorvaTV-test', monotonicNow, wallNow = () => 10_000 } = {}) {
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
    navigator: { userAgent }, URL,
    ...(abortable ? { AbortController } : {}),
    ...(monotonicNow ? { performance: { now: monotonicNow } } : {}),
    Date: class extends Date { static now() { return wallNow(); } }, Map, Set, Promise,
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

for (const departure of ['Back', 'navigation', 'new Play', 'new recovery token']) {
  test(`Live ${departure} aborts its exact in-flight preparation signal`, async () => {
    const pending = deferred();
    const f = fixture({ abortable: true, resolveFresh: () => pending.promise });
    await f.play(); f.retry();
    const recovering = f.timers[0].callback(); await tick();
    const signal = f.resolutions[0][5].signal;
    assert.equal(signal.aborted, false);
    if (departure === 'Back') f.close(1);
    if (departure === 'navigation') f.navigate('#movies');
    if (departure === 'new Play') await f.play(3);
    if (departure === 'new recovery token') f.retry('new-token');
    assert.equal(signal.aborted, true);
    pending.reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
    await recovering; await tick();
    assert.equal(f.resolutions.length, 1);
  });
}

test('a delayed old Activity close never aborts the new Live preparation', async () => {
  const pending = deferred();
  const f = fixture({ abortable: true, resolveFresh: () => pending.promise });
  await f.play(1); await f.play(3); f.retry('new-token', 3);
  const recovering = f.timers[0].callback(); await tick();
  const signal = f.resolutions[0][5].signal;
  f.close(1); assert.equal(signal.aborted, false);
  pending.resolve({ url: 'https://gateway.example/live.m3u8', sessionId: session(4) });
  await recovering;
  assert.equal(f.launches.at(-1).sessionId, session(4));
});

test('native recovery deadline actively cancels the pending Live request', async () => {
  const pending = deferred(); let now = 0;
  const f = fixture({ abortable: true, userAgent: 'NorvaTV-AndroidPhone/1.3.27',
    monotonicNow: () => now, resolveFresh: () => pending.promise });
  await f.play(); f.retry();
  const recovering = f.timers[0].callback(); await tick();
  const deadline = f.timers.find(timer => timer.delay === 65_000);
  assert.ok(deadline); now = 65_000; deadline.callback();
  assert.equal(f.resolutions[0][5].signal.aborted, true);
  pending.reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
  await recovering; assert.equal(f.launches.length, 1);
});

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

for (const [platform, ttl] of [['AndroidPhone', 65_000], ['AndroidTV', 30_000]]) {
  const userAgent = `Mozilla/5.0 NorvaTV-${platform}/1.0`;
  test(`${platform} recovery that wakes after its token deadline cannot resolve or show a new error`, async () => {
    let now = 100;
    const f = fixture({ userAgent, monotonicNow: () => now }); await f.play();
    assert.equal(f.retry(), 'scheduled');
    now += ttl;
    await f.timers[0].callback();
    assert.equal(f.retry(), 'expired', 'the same token cannot start another deadline');
    assert.equal(f.resolutions.length, 0);
    assert.equal(f.launches.length, 1);
    assert.equal(f.notices.length, 0);
    assert.equal(f.timers.length, 1);
  });

  test(`${platform} recovery deadline reached during strict release prevents the replacement request`, async () => {
    let now = 0; const released = deferred();
    const f = fixture({ userAgent, monotonicNow: () => now, release: () => released.promise });
    await f.play(); f.retry(); const running = f.timers[0].callback(); await tick();
    now = ttl; released.resolve(); await running;
    assert.equal(f.resolutions.length, 0);
    assert.equal(f.launches.length, 1);
    assert.deepEqual(f.expirations, [session(1)], 'the previous slot still finishes releasing');
  });

  test(`${platform} recovery expires an exact replacement resolved after the token deadline`, async () => {
    let now = 0; const response = deferred();
    const f = fixture({ userAgent, monotonicNow: () => now, resolveFresh: () => response.promise });
    await f.play(); f.retry(); const running = f.timers[0].callback(); await tick();
    now = ttl;
    response.resolve({ url: 'https://gateway.example/late.m3u8', sessionId: session(2) }); await running;
    assert.equal(f.launches.length, 1);
    assert.equal(f.expirations.filter(id => id === session(2)).length, 1);
    assert.equal(f.player.activeCloudPlaybackSessionIds.has(session(2)), false);
    assert.equal(f.timers.length, 1);
    assert.equal(f.notices.length, 0);
  });

  test(`${platform} repeated resolver failures do not renew the same recovery token`, async () => {
    let now = 0;
    const f = fixture({ userAgent, monotonicNow: () => now, resolveFresh: async () => {
      now = ttl - 1; throw new Error('temporary resolver failure');
    } });
    await f.play(); f.retry(); await f.timers[0].callback();
    assert.equal(f.timers.length, 2, 'a still-current token retains its bounded retry');
    now = ttl;
    await f.timers[1].callback();
    assert.equal(f.resolutions.length, 1, 'the second timer cannot extend the first deadline');
    assert.equal(f.retry(), 'expired');
    assert.equal(f.notices.length, 0);
  });

  test(`${platform} replacement before the upper bound is still delivered`, async () => {
    let now = 0;
    const f = fixture({ userAgent, monotonicNow: () => now, resolveFresh: async () => {
      now = ttl - 1;
      return { url: 'https://gateway.example/fresh.m3u8', sessionId: session(2) };
    } });
    await f.play(); f.retry(); await f.timers[0].callback();
    assert.equal(f.launches.length, 2);
    assert.equal(f.launches[1].sessionId, session(2));
    assert.equal(f.expirations.includes(session(2)), false);
  });
}

test('a newer recovery token has its own deadline and cannot receive an old token response', async () => {
  let now = 0; const first = deferred(); let requests = 0;
  const f = fixture({ userAgent: 'NorvaTV-AndroidTV/3.8.22', monotonicNow: () => now,
    resolveFresh: async () => ++requests === 1 ? first.promise
      : { url: 'https://gateway.example/new-token.m3u8', sessionId: session(3) },
  });
  await f.play(); f.retry('old-token'); const old = f.timers[0].callback(); await tick();
  now = 29_000;
  assert.equal(f.retry('new-token'), 'scheduled');
  assert.equal(f.retry('old-token'), 'cancelled', 'a delayed old native dispatch cannot revive its retired budget');
  now = 31_000;
  first.resolve({ url: 'https://gateway.example/old-token.m3u8', sessionId: session(2) }); await old;
  await f.timers[1].callback();
  assert.equal(f.launches.length, 2);
  assert.equal(f.launches[1].recoveryToken, 'new-token');
  assert.equal(f.launches[1].sessionId, session(3));
  assert.equal(f.expirations.filter(id => id === session(2)).length, 1);
  assert.equal(f.expirations.includes(session(3)), false);
});

test('a closed recovery token cannot be reused by a later viewer intent for the same channel', async () => {
  let now = 0, wall = 10_000;
  const f = fixture({ userAgent: 'NorvaTV-AndroidTV/3.8.22', monotonicNow: () => now, wallNow: () => wall });
  await f.play(); f.retry('closed-token'); f.close(1); await tick();
  wall += 2000; now = 40_000; await f.play();
  assert.equal(f.retry('closed-token'), 'cancelled');
  assert.equal(f.retry('new-native-token'), 'scheduled');
  assert.equal(f.timers.length, 2, 'the old dispatch did not create another scheduled attempt');
});

for (const [label, userAgent, token] of [
  ['tokenless legacy', 'NorvaTV-AndroidTV/3.8.22', ''],
  ['unknown platform', 'NorvaTV-test', 'native-token'],
  ['ambiguous platform', 'NorvaTV-AndroidTV/3.8 NorvaTV-AndroidPhone/1.3', 'native-token'],
]) test(`${label} recovery is not assigned an invented native deadline`, async () => {
  let now = 0;
  const f = fixture({ userAgent, monotonicNow: () => now }); await f.play(); f.retry(token);
  now = 120_000; await f.timers[0].callback();
  assert.equal(f.launches.length, 2);
  assert.equal(f.launches[1].sessionId, session(2));
});

test('wall-clock jumps cannot shorten or extend the monotonic recovery token deadline', async () => {
  let now = 0, wall = 10_000;
  const f = fixture({ userAgent: 'NorvaTV-AndroidPhone/1.3.27', monotonicNow: () => now, wallNow: () => wall });
  await f.play(); f.retry();
  wall += 3_600_000; now = 64_999;
  await f.timers[0].callback();
  assert.equal(f.launches.length, 2, 'a wall-clock correction cannot reject a current token');
  wall = -3_600_000; now = 65_000;
  assert.equal(f.retry(), 'expired', 'a wall-clock rollback cannot renew the same token');
});

test('the final native bridge gate rejects a deadline crossed after resolution and expires that receipt', async () => {
  let now = 0;
  const f = fixture({ userAgent: 'NorvaTV-AndroidPhone/1.3.27', monotonicNow: () => now });
  const channel = await f.play();
  Object.defineProperty(channel, 'name', { get() { now = 65_000; return 'Test channel'; } });
  f.retry(); await f.timers[0].callback();
  assert.equal(f.launches.length, 1);
  assert.equal(f.expirations.filter(id => id === session(2)).length, 1);
  assert.equal(f.timers.length, 1);
  assert.equal(f.notices.length, 0);
});

test('a recognized shell without performance.now uses one wall-clock deadline', async () => {
  let now = 10_000;
  const f = fixture({ userAgent: 'NorvaTV-AndroidTV/3.8.22', wallNow: () => now });
  await f.play(); f.retry(); now += 30_000;
  await f.timers[0].callback();
  assert.equal(f.retry(), 'expired');
  assert.equal(f.resolutions.length, 0);
});
