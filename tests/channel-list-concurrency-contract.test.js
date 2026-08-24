'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'public/js/components/ChannelList.js'),
  'utf8',
);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createHarness() {
  const state = {
    liveActive: true,
    guideRenders: 0,
    toasts: [],
  };
  const livePage = {
    classList: {
      contains(name) {
        return name === 'active' && state.liveActive;
      },
    },
  };
  const document = {
    getElementById(id) {
      return id === 'page-live' ? livePage : null;
    },
    querySelectorAll() {
      return [];
    },
  };
  const window = {
    API: {
      isCloudMode: () => true,
      catalogVisibilityEpoch: () => 'v2.1.1',
    },
    app: {
      liveGuideFusion: {
        render() {
          state.guideRenders += 1;
        },
      },
      showToast(message) {
        state.toasts.push(message);
      },
    },
  };
  const API = {
    proxy: {
      xtream: {
        liveCategories: async () => [],
        liveStreams: async () => [],
      },
    },
  };
  const context = vm.createContext({
    window,
    document,
    API,
    console: {
      log() {},
      warn() {},
      error() {},
    },
    setTimeout,
    clearTimeout,
    requestAnimationFrame: callback => callback(),
  });
  vm.runInContext(source, context);

  const list = Object.create(context.window.ChannelList.prototype);
  Object.assign(list, {
    channels: [],
    groups: [],
    sources: [],
    liveHydrationRunId: 1,
    pendingChannelSelection: null,
    pendingChannelSelectionSeq: 0,
    _selectRequestSeq: 0,
    remoteSearchInFlight: null,
  });

  return { API, context, list, state, window };
}

function cachedProvider(sourceId, count) {
  return {
    groups: [{
      id: `group-${sourceId}`,
      sourceId,
      sourceType: 'xtream',
      name: `Provider ${sourceId}`,
    }],
    channels: Array.from({ length: count }, (_, index) => ({
      id: `${sourceId}-${index}`,
      streamId: `${sourceId}-${index}`,
      sourceId,
      sourceType: 'xtream',
    })),
  };
}

test('TV All Sources cache preserves one fair resident page per provider', async () => {
  const { list } = createHarness();
  list._isTvMode = () => true;
  list.livePageSize = () => 400;
  list.liveResidentCap = () => 4000;
  list.readLiveCatalogCache = async sourceId => cachedProvider(sourceId, 1800);

  assert.equal(
    await list.loadLiveCatalogFromCache(1, 'xtream', {
      append: true,
      loadRunId: 1,
    }),
    true,
  );
  assert.equal(
    await list.loadLiveCatalogFromCache(2, 'xtream', {
      append: true,
      loadRunId: 1,
    }),
    true,
  );

  assert.equal(list.channels.length, 800);
  assert.equal(list.channels.filter(channel => channel.sourceId === 1).length, 400);
  assert.equal(list.channels.filter(channel => channel.sourceId === 2).length, 400);

  const selected = createHarness().list;
  selected._isTvMode = () => true;
  selected.livePageSize = () => 400;
  selected.liveResidentCap = () => 4000;
  selected.readLiveCatalogCache = async () => cachedProvider(1, 1800);

  assert.equal(
    await selected.loadLiveCatalogFromCache(1, 'xtream', {
      append: false,
      loadRunId: 1,
    }),
    true,
  );
  assert.equal(selected.channels.length, 1800);
});

test('mobile All Sources cache preserves provider fairness while a selected source reuses its full cache', async () => {
  const { list } = createHarness();
  list._isTvMode = () => false;
  list.livePageSize = () => 400;
  list.liveResidentCap = () => 4000;
  list.readLiveCatalogCache = async sourceId => cachedProvider(sourceId, 1800);

  assert.equal(
    await list.loadLiveCatalogFromCache(1, 'xtream', {
      append: true,
      loadRunId: 1,
    }),
    true,
  );
  assert.equal(
    await list.loadLiveCatalogFromCache(2, 'xtream', {
      append: true,
      loadRunId: 1,
    }),
    true,
  );

  assert.equal(list.channels.length, 800);
  assert.equal(list.channels.filter(channel => channel.sourceId === 1).length, 400);
  assert.equal(list.channels.filter(channel => channel.sourceId === 2).length, 400);

  const selected = createHarness().list;
  selected._isTvMode = () => false;
  selected.livePageSize = () => 400;
  selected.liveResidentCap = () => 4000;
  selected.readLiveCatalogCache = async () => cachedProvider(1, 1800);

  assert.equal(
    await selected.loadLiveCatalogFromCache(1, 'xtream', {
      append: false,
      loadRunId: 1,
    }),
    true,
  );
  assert.equal(selected.channels.length, 1800);
});

test('a cache response invalidated while IndexedDB is pending cannot mutate the catalogue', async () => {
  const { list } = createHarness();
  const cacheRead = deferred();
  list._isTvMode = () => true;
  list.livePageSize = () => 400;
  list.liveResidentCap = () => 4000;
  list.readLiveCatalogCache = () => cacheRead.promise;

  const loading = list.loadLiveCatalogFromCache(1, 'xtream', {
    append: true,
    loadRunId: 1,
  });
  list.liveHydrationRunId = 2;
  cacheRead.resolve(cachedProvider(1, 1800));

  assert.equal(await loading, false);
  assert.equal(list.channels.length, 0);
  assert.equal(list.groups.length, 0);
});

test('pending Home favorite lookup is cancelled by route exit or a newer intent', async () => {
  for (const invalidation of ['route-exit', 'newer-intent']) {
    const { API, list, state } = createHarness();
    const lookup = deferred();
    let mapped = 0;
    let selected = 0;
    let rendered = 0;

    API.proxy.xtream.liveStreams = () => lookup.promise;
    list.mapLiveStreamsToChannels = (sourceId, categories, streams, sourceType) => {
      mapped += 1;
      return streams.map(stream => ({
        id: String(stream.stream_id),
        streamId: String(stream.stream_id),
        sourceId,
        sourceType,
      }));
    };
    list.addChannelsUnique = channels => {
      list.channels.push(...channels);
      return channels.length;
    };
    list.getChannelFamilyKey = value => String(value || '');
    list.renderBrowsePreservingFocus = () => {
      rendered += 1;
    };
    list.selectChannel = async () => {
      selected += 1;
    };

    list.queueChannelSelection({
      sourceId: 7,
      channelId: '42',
      streamId: '42',
      name: 'Premium News',
    });
    const consuming = list.consumePendingChannelSelection();

    if (invalidation === 'route-exit') {
      state.liveActive = false;
      list.pauseLiveHydration();
    } else {
      list.queueChannelSelection({
        sourceId: 8,
        channelId: '84',
        streamId: '84',
        name: 'Newer intent',
      });
    }
    lookup.resolve([{ stream_id: 42 }]);

    assert.equal(await consuming, false, invalidation);
    assert.equal(mapped, 0, invalidation);
    assert.equal(list.channels.length, 0, invalidation);
    assert.equal(rendered, 0, invalidation);
    assert.equal(selected, 0, invalidation);
  }
});

test('current pending selection still renders and selects exactly once', async () => {
  const { list } = createHarness();
  let rendered = 0;
  let selected = 0;
  list.channels = [{
    id: '42',
    streamId: '42',
    sourceId: 7,
    sourceType: 'xtream',
  }];
  list.renderBrowsePreservingFocus = () => {
    rendered += 1;
  };
  list.selectChannel = async dataset => {
    selected += 1;
    assert.equal(dataset.channelId, '42');
  };

  list.queueChannelSelection({
    sourceId: 7,
    channelId: '42',
    streamId: '42',
  });

  assert.equal(await list.consumePendingChannelSelection(), true);
  assert.equal(rendered, 1);
  assert.equal(selected, 1);
});

async function assertLoadCancelledAt(methodName, stage) {
  const { API, list } = createHarness();
  const gate = deferred();
  const reached = deferred();
  let categoriesCalls = 0;
  let firstPageCalls = 0;
  let mapped = 0;
  let hydrated = 0;
  let cacheWrites = 0;

  list._isTvMode = () => true;
  list.livePageSize = () => 400;
  list.liveResidentCap = () => 4000;
  list.mapLiveStreamsToChannels = () => {
    mapped += 1;
    return [{
      id: '42',
      streamId: '42',
      sourceId: 7,
      sourceType: methodName === 'loadXtreamChannels' ? 'xtream' : 'm3u',
    }];
  };
  list.hydrateRemainingLivePages = () => {
    hydrated += 1;
  };
  list.writeLiveCatalogCache = async () => {
    cacheWrites += 1;
    return true;
  };

  if (stage === 'cache') {
    list.loadLiveCatalogFromCache = () => {
      reached.resolve();
      return gate.promise;
    };
  } else {
    list.loadLiveCatalogFromCache = async () => false;
  }
  const stampedRows = rows => Object.assign(rows, {
    _norvaVisibilityEpoch: 'v2.1.1',
  });
  API.proxy.xtream.liveCategories = () => {
    categoriesCalls += 1;
    if (stage === 'categories') {
      reached.resolve();
      return gate.promise;
    }
    return Promise.resolve(stampedRows([{ category_id: '1', category_name: 'News' }]));
  };
  list.loadFirstLivePage = () => {
    firstPageCalls += 1;
    if (stage === 'streams') {
      reached.resolve();
      return gate.promise;
    }
    return Promise.resolve([{ stream_id: '42', category_id: '1' }]);
  };

  const loading = list[methodName](7, true, 1);
  await reached.promise;
  list.liveHydrationRunId = 2;
  if (stage === 'cache') gate.resolve(false);
  else if (stage === 'categories') {
    gate.resolve(stampedRows([{ category_id: '1', category_name: 'News' }]));
  } else {
    gate.resolve(stampedRows([{ stream_id: '42', category_id: '1' }]));
  }

  assert.equal(await loading, false, `${methodName}:${stage}`);
  assert.equal(list.channels.length, 0, `${methodName}:${stage}`);
  assert.equal(list.groups.length, 0, `${methodName}:${stage}`);
  assert.equal(mapped, 0, `${methodName}:${stage}`);
  assert.equal(hydrated, 0, `${methodName}:${stage}`);
  assert.equal(cacheWrites, 0, `${methodName}:${stage}`);
  if (stage === 'cache') assert.equal(categoriesCalls, 0, methodName);
  if (stage === 'categories') assert.equal(firstPageCalls, 0, methodName);
}

test('Xtream and M3U first-page loads honor generation after every await', async () => {
  for (const methodName of ['loadXtreamChannels', 'loadM3uChannels']) {
    for (const stage of ['cache', 'categories', 'streams']) {
      await assertLoadCancelledAt(methodName, stage);
    }
  }
});

test('cache writer rechecks generation after opening IndexedDB', async () => {
  const { list } = createHarness();
  const opening = deferred();
  let transactions = 0;
  list._isTvMode = () => true;
  list.liveResidentCap = () => 4000;
  list.channels = [{
    id: '42',
    streamId: '42',
    sourceId: 7,
    sourceType: 'xtream',
  }];
  list.groups = [{
    id: 'group-7',
    sourceId: 7,
    sourceType: 'xtream',
  }];
  list.openLiveCacheDb = () => opening.promise;

  const writing = list.writeLiveCatalogCache(7, 'xtream', 1);
  list.liveHydrationRunId = 2;
  opening.resolve({
    transaction() {
      transactions += 1;
      throw new Error('stale cache transaction must not start');
    },
  });

  assert.equal(await writing, false);
  assert.equal(transactions, 0);
});
