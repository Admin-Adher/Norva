const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const groupingSource = fs.readFileSync(
  path.join(__dirname, '..', 'public/js/utils/channelGrouping.js'),
  'utf8',
);
const playerSource = fs.readFileSync(
  path.join(__dirname, '..', 'public/js/components/VideoPlayer.js'),
  'utf8',
);
const channelListSource = fs.readFileSync(
  path.join(__dirname, '..', 'public/js/components/ChannelList.js'),
  'utf8',
);

function loadGrouping() {
  const store = new Map();
  const window = {
    sessionStorage: {
      getItem: (key) => store.get(key) || null,
      setItem: (key, value) => store.set(key, String(value)),
    },
  };
  vm.runInNewContext(groupingSource, { window, console, Date, JSON, Set, Object, String, Number, Array });
  return window.ChannelGrouping;
}

function loadPlayerClass(overrides = {}) {
  const window = overrides.window || {};
  const context = {
    window,
    navigator: { userAgent: '' },
    console,
    setTimeout: overrides.setTimeout || setTimeout,
    clearTimeout: overrides.clearTimeout || clearTimeout,
    requestAnimationFrame: (callback) => callback(),
    CustomEvent: function CustomEvent() {},
    Date,
    URL,
    Promise,
    Map,
    Set,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Math,
    JSON,
  };
  vm.runInNewContext(playerSource, context);
  return { VideoPlayer: window.VideoPlayer, window };
}

function loadChannelListClass(overrides = {}) {
  const window = overrides.window || {};
  const context = {
    window,
    document: overrides.document || {},
    navigator: { language: 'fr-FR' },
    console,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (callback) => callback(),
    Date,
    URL,
    Promise,
    Map,
    Set,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Math,
    JSON,
    API: overrides.API,
    MediaUtils: overrides.MediaUtils || { liveGatewayMode: () => 'transcode' },
  };
  vm.runInNewContext(channelListSource, context);
  return { ChannelList: window.ChannelList, window };
}

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test('runtime failures demote a dead default and a real first frame promotes the healthy sibling', () => {
  const grouping = loadGrouping();
  const hd = { label: 'HD', rank: 2, healthRank: 1, sourceId: 'source-a', streamId: '101' };
  const fhd = { label: 'FHD', rank: 1, healthRank: 1, sourceId: 'source-a', streamId: '102' };

  assert.equal(grouping.pickDefault([fhd, hd]).streamId, '101');
  grouping.recordVariantOutcome(hd, 'failure', { reason: 'manifestLoadTimeOut' });
  assert.equal(grouping.pickDefault([fhd, hd]).streamId, '102');
  grouping.recordVariantOutcome(fhd, 'success', { ttffMs: 4200 });
  assert.equal(grouping.pickDefault([hd, fhd]).streamId, '102');
});

test('same-label provider variants remain separate fallback candidates', () => {
  const grouping = loadGrouping();
  const channels = [
    { id: '1', sourceId: 'source-a', streamId: '201', name: 'FR | TF1 HD' },
    { id: '2', sourceId: 'source-a', streamId: '202', name: 'FR | TF1 HD' },
  ];
  const group = grouping.variantsForChannel(channels[0], channels, 'FR');
  assert.equal(group.variants.length, 2);
  assert.deepEqual(
    Array.from(group.variants, (variant) => String(variant.streamId)).sort(),
    ['201', '202'],
  );
});

test('known-broken catalogue variants are never automatic fallbacks', () => {
  const grouping = loadGrouping();
  const current = { label: 'HD', rank: 2, healthRank: 1, sourceId: 'source-a', streamId: '301' };
  const broken = { label: 'FHD', rank: 1, healthRank: 3, sourceId: 'source-a', streamId: '302' };
  const healthy = { label: 'SD', rank: 3, healthRank: 1, sourceId: 'source-a', streamId: '303' };

  assert.deepEqual(
    Array.from(grouping.fallbackOrder([current, broken, healthy], current.streamId), (variant) => variant.streamId),
    ['303'],
  );
});

test('initial live resolution tries the primary then one healthy sibling serially', async () => {
  const attempts = [];
  const lifecycle = [];
  const variants = [
    { label: 'HD', sourceId: 'source-a', streamId: '601', channel: { id: 'tf1-hd', sourceType: 'xtream' } },
    { label: 'FHD', sourceId: 'source-a', streamId: '602', channel: { id: 'tf1-fhd', sourceType: 'xtream' } },
    { label: 'SD', sourceId: 'source-a', streamId: '603', channel: { id: 'tf1-sd', sourceType: 'xtream' } },
  ];
  const window = {
    ChannelGrouping: {
      fallbackOrder: () => variants.slice(1),
      recordVariantOutcome() {},
    },
    app: { player: { canAutoFallbackVariantForReason: () => true } },
  };
  const API = { proxy: { xtream: { getStreamUrl: async (_sourceId, streamId) => {
    attempts.push(String(streamId));
    lifecycle.push(`resolve-${streamId}`);
    if (String(streamId) === '601') {
      lifecycle.push('failed-601');
      const error = new Error('Service temporarily unavailable');
      error.status = 503;
      throw error;
    }
    return { url: `https://example.test/${streamId}.m3u8`, sessionId: `session-${streamId}` };
  } } } };
  const { ChannelList } = loadChannelListClass({ window, API });
  const list = Object.create(ChannelList.prototype);
  Object.assign(list, { _selectRequestSeq: 9, _forceTranscode: new Set() });
  list.expireStaleCloudPlaybackSession = async () => {};
  list.releaseInitialLiveResolveSession = async () => {};
  const switchPlayer = {
    async prepareLiveSwitch() { lifecycle.push('strict-drain'); },
  };
  const channel = {
    id: 'tf1-hd',
    sourceId: 'source-a',
    sourceType: 'xtream',
    streamId: '601',
    name: 'TF1',
    currentVariant: variants[0],
    qualityGroup: { name: 'TF1', variants },
    _norvaSelection: { selectSeq: 9 },
  };

  const resolved = await list.resolveInitialLiveStream(channel, { selectSeq: 9, switchPlayer });

  assert.deepEqual(attempts, ['601', '602']);
  assert.deepEqual(lifecycle, ['resolve-601', 'failed-601', 'strict-drain', 'resolve-602']);
  assert.equal(resolved.channel.streamId, '602');
  assert.equal(resolved.channel.cloudPlaybackSessionId, 'session-602');
  assert.deepEqual(Array.from(resolved.channel._norvaInitialVariantFailures), ['601']);
  assert.equal(resolved.channel._norvaInitialVariantFallbackAttempts, 1);
});

test('dynamic selection preserves an existing logical sibling family', () => {
  const variants = [
    { label: 'HD', sourceId: 'source-a', streamId: '611', channel: { id: 'tf1-hd' } },
    { label: 'FHD', sourceId: 'source-a', streamId: '612', channel: { id: 'tf1-fhd' } },
    { label: 'SD', sourceId: 'source-a', streamId: '613', channel: { id: 'tf1-sd' } },
  ];
  const logicalGroup = { name: 'TF1', variants, defaultVariant: variants[0] };
  let recomputations = 0;
  const window = {
    ChannelGrouping: {
      variantsForChannel() {
        recomputations += 1;
        return { name: 'TF1', variants: [variants[0]] };
      },
      pickDefault: (items) => items[0],
      fallbackOrder: (items, currentStreamId) => items.filter(
        (item) => String(item.streamId) !== String(currentStreamId),
      ),
    },
    app: { player: { getCountry: () => 'FR' } },
  };
  const { ChannelList } = loadChannelListClass({ window });
  const list = Object.create(ChannelList.prototype);
  list.channels = [{ id: 'logical-tf1' }];
  const logical = {
    id: 'logical-tf1',
    sourceId: 'source-a',
    sourceType: 'xtream',
    streamId: '611',
    name: 'TF1',
    qualityGroup: logicalGroup,
    currentVariant: variants[0],
  };

  const selected = list.buildDynamicLiveChannel(logical, {}, 21);

  assert.equal(recomputations, 0);
  assert.equal(selected.qualityGroup, logicalGroup);
  assert.equal(selected.currentVariant, variants[0]);
  assert.equal(selected.sourceType, 'xtream');
  assert.equal(selected.sourceId, 'source-a');
  assert.equal(selected.streamId, '611');
  assert.deepEqual(
    Array.from(list.getInitialLiveResolveCandidates(selected), (candidate) => candidate.streamId),
    ['611', '612', '613'],
  );
});

test('initial live resolution is bounded to three total variants', async () => {
  const attempts = [];
  let drains = 0;
  const variants = ['701', '702', '703', '704'].map((streamId, index) => ({
    label: `Variant ${index + 1}`,
    sourceId: 'source-a',
    streamId,
    channel: { id: `tf1-${streamId}`, sourceType: 'xtream' },
  }));
  const window = {
    ChannelGrouping: {
      fallbackOrder: () => variants.slice(1),
      recordVariantOutcome() {},
    },
    app: { player: { canAutoFallbackVariantForReason: () => true } },
  };
  const API = { proxy: { xtream: { getStreamUrl: async (_sourceId, streamId) => {
    attempts.push(String(streamId));
    const error = new Error('gateway refused');
    error.status = 502;
    throw error;
  } } } };
  const { ChannelList } = loadChannelListClass({ window, API });
  const list = Object.create(ChannelList.prototype);
  Object.assign(list, { _selectRequestSeq: 10, _forceTranscode: new Set() });
  list.expireStaleCloudPlaybackSession = async () => {};
  list.releaseInitialLiveResolveSession = async () => {};
  const channel = {
    id: 'tf1-701', sourceId: 'source-a', sourceType: 'xtream', streamId: '701', name: 'TF1',
    currentVariant: variants[0], qualityGroup: { name: 'TF1', variants },
  };

  await assert.rejects(
    list.resolveInitialLiveStream(channel, {
      selectSeq: 10,
      switchPlayer: { async prepareLiveSwitch() { drains += 1; } },
    }),
    /gateway refused/,
  );
  assert.deepEqual(attempts, ['701', '702', '703']);
  assert.equal(drains, 2);
});

function publicHlsPriorityFixture(streamId) {
  const variants = ['default', 'alternate', 'third', streamId].map((id) => ({
    sourceId: 'selection', streamId: id, healthRank: 1,
    channel: { id: `row-${id}`, sourceId: 'selection', streamId: id, sourceType: 'm3u' },
  }));
  const window = {
    app: { player: { supportsPublicHlsDirectSessionGuard: true } },
    ChannelGrouping: {
      pickDefault: items => items[0],
      fallbackOrder: (items, initialId) => items.filter(item => item.streamId !== initialId && item.healthRank < 3),
    },
  };
  const { ChannelList } = loadChannelListClass({ window });
  const list = Object.create(ChannelList.prototype);
  list._forceTranscode = new Set();
  const channel = {
    id: 'logical-row', sourceId: 'selection', streamId: 'default',
    currentVariant: variants[0], qualityGroup: { variants },
    _norvaSelection: { logicalSourceId: 'selection' },
  };
  return { list, window, channel, variants,
    order: () => Array.from(list.getInitialLiveResolveCandidates(channel), candidate => candidate.streamId) };
}

const reviewedPublicLiveIds = fs.readFileSync(path.join(__dirname, '..', 'tests/fixtures/xumo-live.m3u'), 'utf8')
  .split(/\r?\n/).filter(line => line.startsWith('https://')).map(url =>
    'norva-discovery:live:' + require('node:crypto').createHash('sha256').update(`live:${new URL(url).href}`).digest('hex'));

test('guarded web initially prefers either exact reviewed Xumo sibling while keeping the fallback order and three-candidate bound', () => {
  assert.equal(reviewedPublicLiveIds.length, 2);
  for (const streamId of reviewedPublicLiveIds) {
    const fixture = publicHlsPriorityFixture(streamId);
    const before = JSON.stringify(fixture.channel);
    assert.deepEqual(fixture.order(), [streamId, 'default', 'alternate']);
    assert.equal(JSON.stringify(fixture.channel), before, 'ranking must not mutate the logical or explicit current variant');
    fixture.channel.currentVariant = fixture.variants[3];
    fixture.channel.streamId = streamId;
    assert.deepEqual(fixture.order(), [streamId, 'default', 'alternate'], 'the preferred initial variant is not duplicated');
  }
});

test('legacy clients, native bridges, private source siblings and unrelated channels retain their initial ordering', () => {
  const expected = ['default', 'alternate', 'third'];
  for (const change of [
    value => { delete value.window.app.player.supportsPublicHlsDirectSessionGuard; },
    value => { value.window.app.player.supportsPublicHlsDirectSessionGuard = false; },
    value => { value.window.NodeCastNative = {}; },
    value => { value.window.NorvaTVCloud = {}; },
    value => { value.window.NorvaAndroidTV = {}; },
    value => { value.variants[3].sourceId = 'private-source'; },
    value => { value.channel._norvaSelection.logicalSourceId = 'other-logical-source'; },
    value => { value.variants[3].streamId = '99951251'; },
    value => { value.variants[3].streamId = 'unreviewed-public-hls'; },
    value => { value.variants[3].healthRank = 3; },
  ]) {
    const fixture = publicHlsPriorityFixture(reviewedPublicLiveIds[0]); change(fixture);
    assert.deepEqual(fixture.order(), expected);
  }
});

test('forced transcode on the logical channel, current version or reviewed sibling prevents public direct prioritization', () => {
  for (const key of ['selection:logical-row', 'selection:row-default', `selection:row-${reviewedPublicLiveIds[0]}`]) {
    const fixture = publicHlsPriorityFixture(reviewedPublicLiveIds[0]);
    fixture.list._forceTranscode.add(key);
    assert.deepEqual(fixture.order(), ['default', 'alternate', 'third'], key);
  }
});

test('manual player version selection stays outside the initial catalogue ranking', () => {
  const switching = section(playerSource, 'async switchVariant(variant', '_clearVariantFallbackTimer()');
  assert.doesNotMatch(switching, /getInitialLiveResolveCandidates|resolveInitialLiveStream/);
  assert.match(switching, /variant\.streamId/);
});

test('live resolution preserves the selected variant container across a mixed-format fallback', async () => {
  const attempts = [];
  const variants = [
    { sourceId: 'selection', streamId: 'hls-channel', container: 'ts', playback_hint: { sourceType: 'm3u', container: 'm3u8' }, channel: {} },
    { sourceId: 'selection', streamId: 'ts-channel', container_extension: 'ts', channel: {} },
  ];
  const window = { ChannelGrouping: { fallbackOrder: () => variants.slice(1), recordVariantOutcome() {} } };
  const API = { proxy: { xtream: { async getStreamUrl(_source, streamId, type, container) {
    attempts.push({ streamId, type, container });
    if (attempts.length === 1) throw Object.assign(new Error('stream unavailable'), { status: 502 });
    return { url: 'https://example.test/play.m3u8', sessionId: 'selected-session' };
  } } } };
  const { ChannelList } = loadChannelListClass({ window, API });
  const list = Object.create(ChannelList.prototype);
  Object.assign(list, { _selectRequestSeq: 11, _forceTranscode: new Set() });
  const channel = {
    id: 'logical-channel', sourceId: 'selection', sourceType: 'm3u', cloudSourceId: 'owned-source',
    streamId: 'hls-channel', container_extension: 'ts', currentVariant: variants[0],
    qualityGroup: { name: 'Public channel', variants },
  };
  const resolved = await list.resolveInitialLiveStream(channel, { selectSeq: 11, switchPlayer: { async prepareLiveSwitch() {} } });
  assert.deepEqual(attempts, [
    { streamId: 'hls-channel', type: 'live', container: 'm3u8' },
    { streamId: 'ts-channel', type: 'live', container: 'ts' },
  ]);
  assert.equal(resolved.channel.streamId, 'ts-channel');
});

test('a lone cloud M3U variant retains its HLS format without a quality group', async () => {
  const attempts = [];
  const API = { proxy: { xtream: { async getStreamUrl(_source, _stream, _type, container) {
    attempts.push(container);
    return { url: 'https://example.test/play.m3u8', sessionId: 'selected-session' };
  } } } };
  const { ChannelList } = loadChannelListClass({ API });
  const list = Object.create(ChannelList.prototype);
  Object.assign(list, { _selectRequestSeq: 11, _forceTranscode: new Set() });
  await list.resolveInitialLiveStream({ sourceId: 'selection', streamId: 'opaque-hls', currentVariant: { containerExtension: 'ts', playbackHint: { sourceType: 'm3u', container: 'm3u8' } } }, { selectSeq: 11 });
  assert.deepEqual(attempts, ['m3u8']);
});

test('Xtream keeps its synthetic TS default when the stored HLS hint was not explicit', async () => {
  const attempts = [];
  const API = { proxy: { xtream: { async getStreamUrl(_source, _stream, _type, container) {
    attempts.push(container);
    return { url: 'https://example.test/play.m3u8', sessionId: 'selected-session' };
  } } } };
  const { ChannelList } = loadChannelListClass({ API });
  const list = Object.create(ChannelList.prototype);
  Object.assign(list, { _selectRequestSeq: 11, _forceTranscode: new Set() });
  await list.resolveInitialLiveStream({ sourceId: 'provider', streamId: 'channel', currentVariant: { container: 'ts', playback_hint: { sourceType: 'xtream', container: 'm3u8' } } }, { selectSeq: 11 });
  assert.deepEqual(attempts, ['ts']);
});

test('initial live resolution never retries a shared provider slot failure', async () => {
  const attempts = [];
  const variants = [
    { label: 'HD', sourceId: 'source-a', streamId: '801', channel: { id: 'tf1-hd', sourceType: 'xtream' } },
    { label: 'FHD', sourceId: 'source-a', streamId: '802', channel: { id: 'tf1-fhd', sourceType: 'xtream' } },
  ];
  const window = {
    ChannelGrouping: { fallbackOrder: () => variants.slice(1), recordVariantOutcome() {} },
    app: { player: { canAutoFallbackVariantForReason(reason) { return !/458|provider.?busy|slot/i.test(reason); } } },
  };
  const API = { proxy: { xtream: { getStreamUrl: async (_sourceId, streamId) => {
    attempts.push(String(streamId));
    const error = new Error('This TV service is busy');
    error.status = 458;
    error.code = 'PROVIDER_BUSY';
    throw error;
  } } } };
  const { ChannelList } = loadChannelListClass({ window, API });
  const list = Object.create(ChannelList.prototype);
  Object.assign(list, { _selectRequestSeq: 11, _forceTranscode: new Set() });
  list.expireStaleCloudPlaybackSession = async () => {};
  list.releaseInitialLiveResolveSession = async () => {};
  const channel = {
    id: 'tf1-hd', sourceId: 'source-a', sourceType: 'xtream', streamId: '801', name: 'TF1',
    currentVariant: variants[0], qualityGroup: { name: 'TF1', variants },
  };

  await assert.rejects(
    list.resolveInitialLiveStream(channel, { selectSeq: 11, switchPlayer: { async prepareLiveSwitch() {} } }),
    /busy/,
  );
  assert.deepEqual(attempts, ['801']);
});

test('the player and initial resolver do not retry an account-wide 409 circuit rejection', () => {
  const { VideoPlayer } = loadPlayerClass();
  const player = Object.create(VideoPlayer.prototype);
  const reason = 'http 409 PROVIDER_ACCOUNT_BUSY Provider account is already in use';
  assert.equal(player.canAutoFallbackVariantForReason(reason), false);
  const { ChannelList } = loadChannelListClass();
  const list = Object.create(ChannelList.prototype);
  const error = Object.assign(new Error('Provider account is already in use'), {
    status: 409, code: 'PROVIDER_ACCOUNT_BUSY',
  });
  assert.equal(list.canFallbackInitialLiveVariant(error), false);
});

test('initial live resolution expires a returned session with no playable URL before fallback', async () => {
  const expired = [];
  const events = [];
  const variants = [
    { label: 'HD', sourceId: 'source-a', streamId: '901', channel: { id: 'tf1-hd', sourceType: 'xtream' } },
    { label: 'FHD', sourceId: 'source-a', streamId: '902', channel: { id: 'tf1-fhd', sourceType: 'xtream' } },
  ];
  const window = {
    ChannelGrouping: { fallbackOrder: () => variants.slice(1), recordVariantOutcome() {} },
    app: { player: { canAutoFallbackVariantForReason: () => true } },
  };
  const API = { proxy: { xtream: { getStreamUrl: async (_sourceId, streamId) => {
    events.push(`resolve-${streamId}`);
    return String(streamId) === '901'
      ? { sessionId: 'orphan-session' }
      : { url: 'https://example.test/902.m3u8', sessionId: 'healthy-session' };
  } } } };
  const { ChannelList } = loadChannelListClass({ window, API });
  const list = Object.create(ChannelList.prototype);
  Object.assign(list, { _selectRequestSeq: 12, _forceTranscode: new Set() });
  list.releaseInitialLiveResolveSession = async (sessionId) => {
    expired.push(sessionId);
    events.push(`expire-${sessionId}`);
  };
  const channel = {
    id: 'tf1-hd', sourceId: 'source-a', sourceType: 'xtream', streamId: '901', name: 'TF1',
    currentVariant: variants[0], qualityGroup: { name: 'TF1', variants },
  };

  const resolved = await list.resolveInitialLiveStream(channel, {
    selectSeq: 12,
    switchPlayer: { async prepareLiveSwitch() { events.push('strict-drain'); } },
  });

  assert.equal(resolved.channel.streamId, '902');
  assert.deepEqual(expired, ['orphan-session']);
  assert.deepEqual(events, [
    'resolve-901',
    'expire-orphan-session',
    'strict-drain',
    'resolve-902',
  ]);
});

test('live fallback is bounded and never retries shared mono-session failures', () => {
  const fallback = section(playerSource, '_tryFallback(failed, reason', 'tryCurrentVariantFallback(reason)');
  const reasonGuard = section(playerSource, 'canAutoFallbackVariantForReason(reason', 'isProviderTransientPlaybackError');

  assert.match(fallback, /const maxFallbacks = 2/);
  assert.match(fallback, /this\._variantFallbackAttempts >= maxFallbacks/);
  assert.match(reasonGuard, /\\b458\\b/);
  assert.match(reasonGuard, /playback_superseded/);
  assert.match(reasonGuard, /provider\.\?busy\|slot/);
});

test('duplicate fallback signals share one in-flight sibling resolver', async () => {
  const { VideoPlayer, window } = loadPlayerClass();
  const failed = { label: 'HD', sourceId: 'source-a', streamId: '401' };
  const sibling = { label: 'FHD', sourceId: 'source-a', streamId: '402' };
  window.ChannelGrouping = {
    recordVariantOutcome() {},
    fallbackOrder: () => [sibling],
  };
  const player = Object.create(VideoPlayer.prototype);
  Object.assign(player, {
    _variantSwitchSeq: 7,
    _variantFallbackAttempts: 0,
    _variantFallbackOperationSeq: 0,
    _variantFallbackInFlight: null,
    _variantFailureHandledSwitchSeq: -1,
    _triedVariants: new Set(),
    currentVariant: failed,
    qualityGroup: { name: 'TF1', variants: [failed, sibling] },
  });
  player.shouldAutoFallbackVariants = () => true;
  player.canAutoFallbackVariantForReason = () => true;
  let releaseSwitch;
  let switchCalls = 0;
  player.switchVariant = async () => {
    switchCalls += 1;
    await new Promise((resolve) => { releaseSwitch = resolve; });
  };

  assert.equal(player._tryFallback(failed, 'HTTP 502', 7), true);
  assert.equal(player._tryFallback(failed, 'duplicate media error', 7), true);
  assert.equal(switchCalls, 1);
  assert.equal(player._variantFallbackAttempts, 1);

  const task = player._variantFallbackInFlight.task;
  releaseSwitch();
  await task;
  assert.equal(switchCalls, 1);
  assert.equal(player._variantFallbackInFlight, null);
});

test('a teardown media error that clears during stabilization does not trigger fallback', () => {
  let scheduled = null;
  const { VideoPlayer } = loadPlayerClass({
    setTimeout(callback) { scheduled = callback; return 91; },
    clearTimeout() { scheduled = null; },
  });
  const player = Object.create(VideoPlayer.prototype);
  player.video = { error: { message: 'stale teardown error' }, currentSrc: '', src: '', readyState: 0, currentTime: 0 };
  player._clearingMedia = false;
  player._variantSwitchSeq = 11;
  player._mediaElementErrorTimer = null;
  let errorCalls = 0;
  player.handlePlaybackError = () => { errorCalls += 1; };

  player._scheduleMediaElementError();
  assert.equal(typeof scheduled, 'function');
  player.video.error = null;
  scheduled();
  assert.equal(errorCalls, 0);
});

test('a superseded fallback expires its late cloud session without starting playback', async () => {
  let resolveStream;
  const expired = [];
  const window = {
    API: { proxy: { xtream: { getStreamUrl: () => new Promise((resolve) => { resolveStream = resolve; }) } } },
    NorvaCloud: { playback: { expireSession: async (sessionId) => { expired.push(sessionId); } } },
  };
  const { VideoPlayer } = loadPlayerClass({ window });
  const player = Object.create(VideoPlayer.prototype);
  const sibling = { label: 'FHD', sourceId: 'source-a', streamId: '502', channel: {} };
  Object.assign(player, {
    currentChannel: { name: 'TF1' },
    currentVariant: { streamId: '501' },
    qualityGroup: { name: 'TF1', variants: [sibling] },
    qualityMenu: null,
    video: { readyState: 0 },
    _variantFallbackOperationSeq: 4,
    _variantFallbackAttempts: 1,
    _triedVariants: new Set(),
  });
  player.prepareLiveSwitch = async () => {};
  player.buildVariantChannel = () => ({ name: 'TF1' });
  let playCalls = 0;
  player.play = async () => { playCalls += 1; };

  const switching = player.switchVariant(sibling, {
    automatic: true,
    fallbackOperationSeq: 4,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof resolveStream, 'function');
  player._variantFallbackOperationSeq = 5;
  resolveStream({ url: 'https://example.test/live.m3u8', sessionId: 'late-session' });
  await switching;

  assert.deepEqual(expired, ['late-session']);
  assert.equal(playCalls, 0);
});

test('variant switch releases the old cloud session before resolving a sibling', () => {
  const switching = section(playerSource, 'async switchVariant(variant', '_clearVariantFallbackTimer()');
  const release = switching.indexOf('await this.prepareLiveSwitch({ preserveVariantFallback: options.automatic })');
  const resolve = switching.indexOf('getStreamUrl(variant.sourceId');

  assert.ok(release >= 0, 'strict live teardown is missing');
  assert.ok(resolve > release, 'a sibling must only resolve after provider/session teardown');
});

test('live switching fails closed if the previous cloud session cannot be released', () => {
  const release = section(playerSource, 'async stopCloudPlaybackSessions(options', '    /**');
  const prepare = section(playerSource, 'async prepareLiveSwitch(options = {})', '    /**');
  const select = section(channelListSource, 'async selectChannel(dataset)', 'async expireStaleCloudPlaybackSession');

  assert.match(release, /failedIds\.forEach\(id => this\.activeCloudPlaybackSessionIds\.add\(id\)\)/);
  assert.match(release, /if \(options\.strict && failedIds\.length\)/);
  assert.match(prepare, /await this\.stopCloudPlaybackSessions\(\{ strict: true \}\)/);
  assert.doesNotMatch(select, /prepareLiveSwitch\(\); \} catch/, 'a release failure must stop the next resolver');
});

test('web player recovers a missing positional URL from the authoritative resolver payload', async () => {
  const { VideoPlayer } = loadPlayerClass();
  const player = Object.create(VideoPlayer.prototype);
  Object.assign(player, {
    _playRequestSeq: 0,
    _playQueue: null,
    activeCloudPlaybackSessionIds: new Set(),
  });
  let receivedUrl = null;
  player._playInternal = async (_channel, url) => { receivedUrl = url; };

  await player.play(
    { name: 'France 4', cloudPlaybackSessionId: 'session-france-4' },
    undefined,
    { url: 'https://media.example.test/live/playlist.m3u8', sessionId: 'session-france-4' },
  );

  assert.equal(receivedUrl, 'https://media.example.test/live/playlist.m3u8');
});

test('a superseded queued play expires its unattached cloud session exactly', async () => {
  const { VideoPlayer } = loadPlayerClass();
  const player = Object.create(VideoPlayer.prototype);
  Object.assign(player, {
    _playRequestSeq: 0,
    _playQueue: Promise.resolve(),
    activeCloudPlaybackSessionIds: new Set(),
  });
  const expired = [];
  const played = [];
  player.expireDetachedCloudPlaybackSession = async (sessionId) => { expired.push(sessionId); };
  player._playInternal = async (channel) => { played.push(channel.name); };

  const stale = player.play(
    { name: 'France 2', cloudPlaybackSessionId: 'stale-session' },
    'https://media.example.test/stale.m3u8',
  );
  const current = player.play(
    { name: 'France 3', cloudPlaybackSessionId: 'current-session' },
    'https://media.example.test/current.m3u8',
  );
  await Promise.all([stale, current]);

  assert.deepEqual(expired, ['stale-session']);
  assert.deepEqual(played, ['France 3']);
});

test('a new xtream selection always cancels pending player fallback state', () => {
  const select = section(channelListSource, 'async selectChannel(dataset)', 'async expireStaleCloudPlaybackSession');
  assert.match(select, /if \(switchPlayer && typeof switchPlayer\.prepareLiveSwitch === 'function'\)/);
  assert.doesNotMatch(select, /switchPlayer\.hls \|\| switchPlayer\.currentUrl/);
});

for (const scenario of [
  { name: 'cloud M3U', sourceType: 'm3u', cloudSourceId: 'owned-source', resolved: true },
  { name: 'Xtream', sourceType: 'xtream', resolved: true },
  { name: 'local M3U', sourceType: 'm3u', resolved: false },
]) {
  test(`${scenario.name} selection uses the correct playback path`, async () => {
    const events = [];
    const channel = {
      id: 'channel-1', sourceId: 'source-1', streamId: 'media-1', name: 'Public channel',
      sourceType: scenario.sourceType, cloudSourceId: scenario.cloudSourceId,
      ...(scenario.resolved ? {} : { url: 'https://local.example.test/live.m3u8' }),
    };
    const window = { app: { player: {
      async prepareLiveSwitch() { events.push('release'); },
      async play(selected, url, payload) {
        events.push('play');
        assert.equal(url, scenario.resolved
          ? 'https://relay.example.test/live.m3u8' : channel.url);
        assert.equal(selected.cloudPlaybackSessionId, scenario.resolved ? 'session-1' : null);
        assert.equal(payload?.sessionId, scenario.resolved ? 'session-1' : undefined);
      },
    } } };
    const API = { proxy: { xtream: { async getStreamUrl(sourceId, streamId, type) {
      events.push('resolve');
      assert.deepEqual([sourceId, streamId, type], ['source-1', 'media-1', 'live']);
      return { url: 'https://relay.example.test/live.m3u8', sessionId: 'session-1' };
    } } } };
    const { ChannelList } = loadChannelListClass({ window, API });
    const list = Object.create(ChannelList.prototype);
    Object.assign(list, {
      channels: [channel], searchMode: true, _selectRequestSeq: 0,
      container: { querySelectorAll: () => [], querySelector: () => null },
    });
    list.buildDynamicLiveChannel = value => ({ ...value });
    await list.selectChannel({ channelId: channel.id });
    assert.deepEqual(events, scenario.resolved ? ['release', 'resolve', 'play'] : ['play']);
  });
}

test('native duplicate intent rejection preserves the already playing channel', () => {
  const select = section(channelListSource, 'async selectChannel(dataset)', 'async expireStaleCloudPlaybackSession');
  assert.match(select, /failPendingPlaybackSelection\(selectSeq, \{ clearCommitted: false \}\)/);
  assert.match(select, /if \(nativeIntentClaim\) this\.commitPlaybackChannel\(playbackChannel\)/);
});

test('web title and playing state commit from a rendered frame, not resolver completion', () => {
  const mark = section(playerSource, 'markPlaybackOnRenderedFrame()', '// ---- Live "behind the edge" badge');
  const select = section(channelListSource, 'async selectChannel(dataset)', 'async expireStaleCloudPlaybackSession');
  const dispatches = playerSource.match(/dispatchEvent\(new CustomEvent\('channelChanged'/g) || [];

  assert.match(mark, /requestVideoFrameCallback/);
  assert.match(mark, /commitPlaybackChannel/);
  assert.equal(dispatches.length, 1, 'channelChanged must be emitted exactly once, after first frame');
  assert.doesNotMatch(select, /classList\.add\('active'/, 'resolver must not claim the channel is already playing');
  assert.match(select, /classList\.add\('pending'/);
});

test('player-level fallback inherits initial resolver failures and the shared three-variant budget', () => {
  const playInternal = section(playerSource, 'async _playInternal(channel', '    hasCurrentMedia()');
  assert.match(playInternal, /_norvaInitialVariantFallbackAttempts/);
  assert.match(playInternal, /_norvaInitialVariantFailures/);
  assert.match(playInternal, /slice\(0, 2\)/);
});
