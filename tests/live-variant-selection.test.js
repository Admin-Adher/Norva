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

test('live fallback is bounded and never retries shared mono-session failures', () => {
  const fallback = section(playerSource, '_tryFallback(failed, reason', 'tryCurrentVariantFallback(reason)');
  const reasonGuard = section(playerSource, 'canAutoFallbackVariantForReason(reason', 'isProviderTransientPlaybackError');

  assert.match(fallback, /const maxFallbacks = 2/);
  assert.match(fallback, /this\._variantFallbackAttempts >= maxFallbacks/);
  assert.match(reasonGuard, /\\b458\\b/);
  assert.match(reasonGuard, /playback_superseded/);
  assert.match(reasonGuard, /provider\.\?busy\|slot/);
});

test('variant switch releases the old cloud session before resolving a sibling', () => {
  const switching = section(playerSource, 'async switchVariant(variant', '_clearVariantFallbackTimer()');
  const release = switching.indexOf('await this.prepareLiveSwitch()');
  const resolve = switching.indexOf('getStreamUrl(variant.sourceId');

  assert.ok(release >= 0, 'strict live teardown is missing');
  assert.ok(resolve > release, 'a sibling must only resolve after provider/session teardown');
});

test('live switching fails closed if the previous cloud session cannot be released', () => {
  const release = section(playerSource, 'async stopCloudPlaybackSessions(options', '    /**');
  const prepare = section(playerSource, 'async prepareLiveSwitch()', '    /**');
  const select = section(channelListSource, 'async selectChannel(dataset)', 'async expireStaleCloudPlaybackSession');

  assert.match(release, /failedIds\.forEach\(id => this\.activeCloudPlaybackSessionIds\.add\(id\)\)/);
  assert.match(release, /if \(options\.strict && failedIds\.length\)/);
  assert.match(prepare, /await this\.stopCloudPlaybackSessions\(\{ strict: true \}\)/);
  assert.doesNotMatch(select, /prepareLiveSwitch\(\); \} catch/, 'a release failure must stop the next resolver');
});

test('native duplicate intent rejection preserves the already playing channel', () => {
  const select = section(channelListSource, 'async selectChannel(dataset)', 'async expireStaleCloudPlaybackSession');
  assert.match(select, /failPendingPlaybackSelection\(selectSeq, \{ clearCommitted: false \}\)/);
  assert.match(select, /if \(nativeIntentClaim\) this\.commitPlaybackChannel\(channel\)/);
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
