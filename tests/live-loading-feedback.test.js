const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function element(initial = []) {
  const classes = new Set(initial), attributes = new Map();
  return {
    textContent: '', innerHTML: '', style: {},
    classList: {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name),
    },
    setAttribute: (key, value) => attributes.set(key, value),
    removeAttribute: key => attributes.delete(key),
    getAttribute: key => attributes.get(key),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function harness(resolveStream = async () => ({ url: 'https://example.test/live.m3u8' })) {
  const window = { app: {} };
  const document = { body: { classList: { contains: () => false } }, getElementById: () => null };
  const context = vm.createContext({ window, document, navigator: {}, setTimeout, clearTimeout,
    console: { log() {}, warn() {}, error() {} }, requestAnimationFrame: fn => fn(),
    CustomEvent: function CustomEvent(type, options) { this.type = type; this.detail = options.detail; },
    API: { proxy: { xtream: { getStreamUrl: resolveStream } } },
  });
  for (const file of ['VideoPlayer', 'ChannelList', 'LiveGuideFusion']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/components', `${file}.js`), 'utf8'), context);
  }
  const errorContent = element();
  const player = Object.create(window.VideoPlayer.prototype);
  Object.assign(player, {
    container: element(), overlay: element(), controlsOverlay: element(['hidden']),
    loadingSpinner: element(), _switchSplash: element(['hidden']),
    _switchSplashName: element(), _switchSplashLoading: element(),
    _switchSplashLogo: element(),
    prepareLiveSwitch: async () => {},
    play: async channel => { player.currentChannel = channel; },
  });
  player.overlay.querySelector = () => errorContent;
  const a = { id: 'a', name: 'First channel', sourceId: 'selection', streamId: 'a', sourceType: 'm3u', cloudSourceId: 'owned' };
  const b = { ...a, id: 'b', streamId: 'b', name: 'Second channel' };
  const rows = { a: element(), b: element() };
  const list = Object.create(window.ChannelList.prototype);
  Object.assign(list, {
    channels: [a, b], searchMode: true, _selectRequestSeq: 0, liveHydrationRunId: 1,
    container: {
      querySelectorAll(selector) {
        return Object.values(rows).filter(row =>
          (selector.includes('.pending') && row.classList.contains('pending'))
          || (selector.includes('.active') && row.classList.contains('active')));
      },
      querySelector(selector) { return rows[selector.match(/="([ab])"/)?.[1]] || null; },
    },
    buildDynamicLiveChannel(channel, dataset, selectSeq) {
      return { ...channel, _norvaSelection: { selectSeq, logicalChannelId: channel.id, renderId: dataset.renderId } };
    },
    rememberLastLiveChannel() {}, rememberRecentChannel() {},
  });
  window.app.player = player;
  window.app.channelList = list;
  return { window, player, list, rows, a, b, errorContent };
}

test('a click paints the requested channel before a previous resolver can finish, and only its commit clears it', async () => {
  const { player, list, rows } = harness();
  const previous = deferred();
  list._streamResolveQueue = previous.promise;
  const first = list.selectChannel({ channelId: 'a', renderId: 'a' });
  const second = list.selectChannel({ channelId: 'b', renderId: 'b' });
  assert.equal(player._switchSplashName.textContent, 'Second channel');
  assert.equal(player._switchSplashLoading.textContent, 'Loading…');
  assert.equal(player._switchSplash.classList.contains('hidden'), false);
  assert.equal(player._switchSplash.getAttribute('aria-hidden'), 'false');
  assert.equal(player.overlay.classList.contains('hidden'), true, 'old errors must not cover the pending channel');
  assert.equal(player.controlsOverlay.classList.contains('hidden'), true, 'loading does not need visible controls');
  assert.equal(rows.a.getAttribute('aria-busy'), undefined);
  assert.equal(rows.a.classList.contains('nav-active'), false);
  assert.equal(rows.b.getAttribute('aria-busy'), 'true');
  assert.equal(player.clearPendingChannel(1), false);
  player._hideChannelSplash();
  assert.equal(player._switchSplash.classList.contains('hidden'), false, 'a stale frame/timer cannot end a newer loading state');
  assert.equal(player._switchSplashTimer, undefined, 'provider waits are not hidden by a fixed splash timer');

  previous.resolve();
  await Promise.all([first, second]);
  assert.equal(player._switchSplash.classList.contains('hidden'), false, 'resolver success is not first-frame success');
  assert.equal(list.commitPlaybackChannel({ _norvaSelection: { selectSeq: 1 } }), false);
  assert.equal(list.commitPlaybackChannel(player.currentChannel), true);
  assert.equal(player._switchSplash.classList.contains('hidden'), true);
  assert.equal(player.container.classList.contains('is-channel-pending'), false);
  assert.equal(rows.b.getAttribute('aria-busy'), undefined);
  assert.equal(rows.b.classList.contains('active'), true);
});

test('a resolver failure replaces pending feedback with its terminal error', async () => {
  const { player, list, rows, errorContent } = harness(async () => { throw new Error('HTTP 403'); });
  await list.selectChannel({ channelId: 'a', renderId: 'a' });
  assert.equal(player._switchSplash.classList.contains('hidden'), true);
  assert.equal(player.overlay.classList.contains('hidden'), false);
  assert.match(errorContent.innerHTML, /This channel isn't responding/);
  assert.equal(rows.a.getAttribute('aria-busy'), undefined);
  assert.equal(list._pendingPlaybackSelection, null);
});

test('route exit cancels the visible pending state and never resolves the abandoned channel', async () => {
  let resolved = 0;
  const { player, list, rows } = harness(async () => { resolved++; });
  const previous = deferred();
  list._streamResolveQueue = previous.promise;
  const selection = list.selectChannel({ channelId: 'a', renderId: 'a' });
  list.pauseLiveHydration();
  assert.equal(player._switchSplash.classList.contains('hidden'), true);
  assert.equal(rows.a.getAttribute('aria-busy'), undefined);
  previous.resolve();
  await selection;
  assert.equal(resolved, 0);
});

test('an outgoing player error cannot replace a newer pending channel; its own terminal error can', () => {
  const { player, list, b, errorContent } = harness();
  player.currentChannel = { _norvaSelection: { selectSeq: 1 } };
  list._pendingPlaybackSelection = { selectSeq: 2, requestedChannel: b };
  player.showPendingChannel({ ...b, _norvaSelection: { selectSeq: 2 } }, 2);
  player._showChannelSplash({ name: 'Old channel', _norvaSelection: { selectSeq: 1 } });
  player.showError('Old error');
  assert.equal(player._switchSplashName.textContent, 'Second channel');
  assert.equal(errorContent.innerHTML, '');
  player.currentChannel = { ...b, _norvaSelection: { selectSeq: 2 } };
  player.showError('Current error');
  assert.equal(player._switchSplash.classList.contains('hidden'), true);
  assert.match(errorContent.innerHTML, /Current error/);
  assert.equal(list._pendingPlaybackSelection, null);
});

test('internal media teardown keeps pending feedback visible until release finishes', async () => {
  const { player, a } = harness();
  const release = deferred();
  Object.assign(player, {
    video: { pause() {}, load() {} }, nowPlaying: element(),
    _clearVariantFallbackTimer() {}, _clearMediaElementErrorTimer() {},
    resetGatewayHlsRetries() {}, stopLiveSyncMonitor() {}, clearExternalSubtitleTracks() {},
    stopTranscodeSession: async () => {}, stopCloudPlaybackSessions: () => release.promise,
  });
  player.showPendingChannel(a, 1);
  const stopping = player.stop();
  assert.equal(player.overlay.classList.contains('hidden'), true);
  assert.equal(player._switchSplash.classList.contains('hidden'), false);
  release.resolve();
  await stopping;
  assert.equal(player._switchSplash.classList.contains('hidden'), false);
  player.clearPendingChannel(1);
  await player.stop();
  assert.equal(player.overlay.classList.contains('hidden'), false, 'a normal stop still returns to idle');
});

test('the guide action identifies loading separately from idle and first-frame playback', () => {
  const { window, list, a } = harness();
  const guide = Object.create(window.LiveGuideFusion.prototype);
  Object.assign(guide, {
    app: { channelList: list }, getProgramAt: () => null, getProgress: () => 0,
    getChannelLogoSrc: () => '', getChannelLogoErrorSrc: () => '',
    getUpcoming: () => [], _isTvMode: () => false,
  });
  list.isFavorite = () => false;
  let rendered = guide.renderPreview(a);
  assert.match(rendered, /aria-busy="false"/);
  assert.match(rendered, />Watch<\/span>/);
  list._pendingPlaybackSelection = { requestedChannel: a };
  rendered = guide.renderPreview(a);
  assert.match(rendered, /aria-busy="true"/);
  assert.match(rendered, />Loading…<\/span>/);
  assert.doesNotMatch(rendered, /is-playing/);
  list._pendingPlaybackSelection = null;
  list.currentChannel = a;
  rendered = guide.renderPreview(a);
  assert.match(rendered, /is-playing/);
  assert.match(rendered, />Playing<\/span>/);
});

test('a stale first frame cannot replace the latest guide preview, while current quality and legacy playback still notify', () => {
  const { window, player, list, a, b } = harness();
  const events = [];
  const preview = { channel: b };
  window.dispatchEvent = event => { events.push(event.detail.name); preview.channel = event.detail; };
  Object.assign(player, {
    _variantSwitchSeq: 1, _triedVariants: new Set(), hasCurrentMedia: () => true,
    _clearMediaElementErrorTimer() {}, resetGatewayHlsRetries() {}, _sendLiveEvent() {},
    _clearVariantFallbackTimer() {}, populateQualityMenu() {}, updateQualityBadge() {},
    getPlaybackHealthTarget: () => null, isLivePlayback: () => false,
  });
  list._selectRequestSeq = 2;
  list._pendingPlaybackSelection = { selectSeq: 2, channel: b };
  player.showPendingChannel(b, 2);
  player.currentChannel = { ...a, _norvaSelection: { selectSeq: 1 } };
  player.markPlaybackUsable();
  assert.deepEqual(events, []);
  assert.equal(preview.channel, b);
  assert.equal(player._switchSplashName.textContent, b.name);

  player._playbackStatusOkReported = false;
  player._variantSwitchSeq++;
  player.currentChannel = { ...b, _norvaSelection: { selectSeq: 2, renderId: 'b', logicalChannelId: 'b' } };
  player.markPlaybackUsable();
  assert.deepEqual(events, [b.name]);
  assert.equal(list._pendingPlaybackSelection, null);

  // A quality change after the selection already committed must still notify.
  player._playbackStatusOkReported = false;
  player._variantSwitchSeq++;
  player.markPlaybackUsable();
  assert.deepEqual(events, [b.name, b.name]);

  player._playbackStatusOkReported = false;
  player._variantSwitchSeq++;
  player.currentChannel = { name: 'Legacy direct playback' };
  player.markPlaybackUsable();
  assert.deepEqual(events, [b.name, b.name, 'Legacy direct playback']);
});
