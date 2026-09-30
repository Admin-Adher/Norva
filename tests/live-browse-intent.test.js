'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function harness({ phone = false, tv = false } = {}) {
  const select = { value: 'xtream:1' };
  const element = () => ({ style: {}, innerHTML: '', scrollTop: 0,
    appendChild() {}, setAttribute() {}, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [],
    classList: { contains: () => false, toggle() {}, remove() {}, add() {} } });
  const liveElement = element();
  liveElement.classList.contains = value => value === 'active';
  const document = { activeElement: null, createElement: element,
    addEventListener() {}, removeEventListener() {},
    getElementById: id => id === 'source-select' ? select : id === 'page-live' ? liveElement : null,
    body: { classList: { contains: () => phone } },
    documentElement: { classList: { contains: () => tv, toggle() {} } },
  };
  const window = { app: { liveGuideFusion: { render() {} } }, API: { isCloudMode: () => false } };
  const API = { proxy: { xtream: { liveStreams: async () => [] } } };
  const context = vm.createContext({ window, document, API,
    console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout,
    localStorage: { getItem: () => null, setItem() {} },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/components/ChannelList.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/components/LiveGuideFusion.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/pages/LivePage.js'), 'utf8')
    + '\nglobalThis.LivePageClass = LivePage;', context);
  const channels = [
    { id: 'dino', streamId: '1284582', sourceId: 1, sourceType: 'xtream', name: 'TF1 Dino', groupTitle: 'France' },
    { id: 'strng', streamId: '985192', sourceId: 2, sourceType: 'xtream', name: 'TF1 Strng', groupTitle: 'France' },
    { id: 'other', streamId: '9', sourceId: 2, sourceType: 'xtream', name: 'Other news', groupTitle: 'News' },
  ];
  const list = Object.create(window.ChannelList.prototype);
  const played = [];
  Object.assign(list, { sourceSelect: select, searchInput: { value: '' }, channels: [], groups: [],
    sources: [{ id: 1, type: 'xtream', enabled: true }, { id: 2, type: 'xtream', enabled: true }],
    container: element(), liveHydrationRunId: 0, _selectRequestSeq: 0, remoteSearchSeq: 0,
    remoteSearchCache: new Map(), visibleFavorites: new Set(), _isTvMode: () => tv,
    isHidden: () => false, getRecentChannels: () => [],
    getLastLiveChannelRecord: () => ({ id: 'dino', sourceId: 1 }),
    hasActiveLivePlayback: () => false,
    selectChannel: async target => { played.push(target); },
    loadSources: async () => {}, consumePendingChannelSelection: async () => {},
    maybeSyncRecentsFromCloud() {}, loadLiveDecorationsAndRefresh() {}, render() {},
    buildSearchResultHtml: channel => `<p>${channel.name}</p>`,
  });
  window.app.channelList = list;
  const page = new context.LivePageClass(window.app);
  return { context, list, page, channels, select, played, API, window };
}

test('source changed during first-page load cannot auto-resume the previously watched provider', async () => {
  const { list, page, channels, select, played } = harness();
  const firstPage = deferred();
  const started = deferred();
  const loaded = [];
  list.loadXtreamChannels = async id => {
    loaded.push(id);
    started.resolve();
    if (id === 1) await firstPage.promise;
    list.channels = channels.filter(channel => channel.sourceId === id);
    return true;
  };
  const showing = page.show();
  await started.promise;
  select.value = 'xtream:2';
  await list.onSourceFilterChange();
  firstPage.resolve();
  await showing;
  assert.deepEqual(loaded, [1, 2]);
  assert.equal(played.length, 0);
  assert.equal(list.getLiveResumeChannel().sourceId, 2);
});

test('typing while catalogue loading cancels automatic resume without erasing the query', async () => {
  const { list, page, channels, played } = harness();
  const firstPage = deferred();
  const started = deferred();
  list.loadXtreamChannels = async () => { started.resolve(); await firstPage.promise; list.channels = [channels[0]]; return true; };
  const showing = page.show();
  await started.promise;
  list.searchInput.value = 'TF1';
  list.onSearchInput();
  firstPage.resolve();
  await showing;
  assert.equal(list.searchInput.value, 'TF1');
  assert.equal(played.length, 0);
});

test('an unchanged web visit still resumes once; phone and TV visits never auto-play', async () => {
  for (const flags of [{}, { phone: true }, { tv: true }]) {
    const { list, page, channels, played } = harness(flags);
    list.channels = channels;
    await page.show();
    assert.equal(played.length, flags.phone || flags.tv ? 0 : 1);
    if (played.length) assert.equal(played[0].channelId, 'dino');
  }
});

test('source scope also excludes a retained currentChannel and colliding source types', () => {
  const { list, channels, select } = harness();
  select.value = 'xtream:2';
  list.currentChannel = channels[0];
  list.channels = [{ ...channels[0], sourceId: 2, sourceType: 'm3u' }, channels[1]];
  assert.equal(list.getLiveResumeChannel().id, 'strng');
});

test('an intervening browse action cannot be undone by returning to the original source', async () => {
  const { list, channels, select, played } = harness();
  list.channels = channels;
  const intent = list.captureLiveBrowseIntent();
  select.value = 'xtream:2'; list.noteLiveBrowseIntent();
  select.value = 'xtream:1'; list.noteLiveBrowseIntent();
  assert.equal(await list.resumeLivePlayback({ intent }), false);
  assert.equal(played.length, 0);
});

test('decorations and progressive catalogue renders retain the actual TF1 search results', async () => {
  const { list, channels, select, context } = harness();
  const prototype = context.window.ChannelList.prototype;
  select.value = 'xtream:2';
  list.channels = [channels[2]];
  list.searchInput.value = 'TF1';
  list.searchMode = true;
  list.render = prototype.render;
  list.loadLiveDecorationsAndRefresh = prototype.loadLiveDecorationsAndRefresh;
  list.loadHiddenItems = list.loadFavorites = list.loadPlaybackStatuses = async () => {};
  list.render();
  assert.equal(list.renderedChannels.length, 0);
  // This is the same refresh path used when a later hydration page arrives.
  list.addChannelsUnique([channels[0], channels[1]]);
  list.renderBrowsePreservingFocus();
  list.loadLiveDecorationsAndRefresh(0);
  await new Promise(setImmediate);
  assert.equal(list.searchMode, true);
  assert.equal(list.searchInput.value, 'TF1');
  assert.deepEqual(Array.from(list.renderedChannels, channel => channel.id), ['strng']);
  assert.match(list.container.innerHTML, /TF1 Strng/);
  assert.doesNotMatch(list.container.innerHTML, /TF1 Dino|Other news/);
});

test('remote results from the old source are discarded even when the search text stays identical', async () => {
  const { list, channels, select, API } = harness();
  const results = deferred();
  list.channels = [channels[1]];
  list.searchInput.value = 'TF1';
  list.searchMode = true;
  list.remoteSearchSeq = 4;
  API.proxy.xtream.liveStreams = () => results.promise;
  const loading = list.loadRemoteSearchResults('TF1', 4);
  select.value = 'xtream:2';
  results.resolve([{ stream_id: 'old', name: 'TF1 old provider' }]);
  await loading;
  assert.deepEqual(Array.from(list.channels, channel => channel.id), ['strng']);
});

test('the phone guide discards a late Dino search after switching to Strng', async () => {
  const { list, channels, select, window } = harness({ phone: true });
  const results = deferred();
  list.channels = [channels[1]];
  const guide = Object.create(window.LiveGuideFusion.prototype);
  Object.assign(guide, { app: window.app, searchQuery: 'TF1', _remoteSearchSeq: 4,
    refreshRows() { throw new Error('Stale source must not refresh rows'); } });
  window.API.proxy = { xtream: { liveStreams: () => results.promise } };
  const loading = guide.loadRemoteSearchResults('TF1', 4);
  select.value = 'xtream:2';
  // The guide has its own search field and sequence. Neither changed here.
  results.resolve([{ stream_id: 'old', name: 'TF1 old provider' }]);
  await loading;
  assert.deepEqual(Array.from(list.channels, channel => channel.id), ['strng']);
});

test('empty-query recents and favorites suggestions respect the current source', () => {
  const { list, channels, select } = harness();
  select.value = 'xtream:2';
  list.channels = channels;
  list.getRecentChannels = () => [{ id: 'dino', sourceId: 1 }, { id: 'strng', sourceId: 2 }];
  list.isFavorite = () => true;
  list.showZeroState();
  assert.deepEqual(Array.from(list.renderedChannels, channel => channel.id), ['strng', 'other']);
  assert.doesNotMatch(list.container.innerHTML, /TF1 Dino/);
});

test('a pending automatic resume is cancelled by browsing but an explicit resolver is preserved', () => {
  const { list } = harness();
  list._selectRequestSeq = 7;
  list._autoResumeSelectionSeq = 7;
  list.pendingLiveResume = true;
  list.noteLiveBrowseIntent();
  assert.equal(list._selectRequestSeq, 8);
  assert.equal(list.pendingLiveResume, false);
  list._autoResumeSelectionSeq = null;
  list.noteLiveBrowseIntent();
  assert.equal(list._selectRequestSeq, 8);
});
