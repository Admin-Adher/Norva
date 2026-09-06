'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const root = path.join(__dirname, '..');
const edge = fs.readFileSync(path.join(root, 'supabase/functions/norva-playback/index.ts'), 'utf8').replace(/\r\n/g, '\n');
const policy = import('../supabase/functions/_shared/selection-live-delivery.mjs');
const fixture = (async () => {
  const { readM3uPlaylistStream } = await import('../supabase/functions/_shared/m3u-playlist-stream.mjs');
  const { DISCOVERY_REVIEW_SOURCES, fetchDiscoveryCandidates, discoveryCatalogFields } = await import('../supabase/functions/_shared/discovery-sources.mjs');
  const { discoverySourceId } = await import('../supabase/functions/_shared/discovery-catalog.mjs');
  const parsed = await readM3uPlaylistStream(new Response(fs.readFileSync(path.join(root, 'tests/fixtures/xumo-live.m3u'), 'utf8')).body);
  const selection = await fetchDiscoveryCandidates({
    feeds: DISCOVERY_REVIEW_SOURCES.filter(feed => feed.id === 'xumo-curated'),
    fetchPlaylist: async () => ({ ...parsed, response: { ok: true } }),
  });
  const rows = selection.items.map(item => discoveryCatalogFields('https://norva.tv/catalog/discovery.m3u', item))
    .filter(row => row.metadata.discoveryFeed === 'xumo-curated');
  const userId = 'reviewed-selection-owner';
  return rows.map(row => ({ userId, sourceId: null, itemType: row.item_type, itemId: row.external_id,
    ownedItem: row, targetUrl: row.playback_hint.targetUrl }))
    .map(async input => ({ ...input, sourceId: await discoverySourceId(userId) }));
})().then(inputs => Promise.all(inputs));

function section(start, end) {
  const from = edge.indexOf(start);
  const to = edge.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing Edge section ${start}`);
  return edge.slice(from, to);
}

function decision(input, delivery, overrides = {}) {
  return { delivery, targetUrl: input.targetUrl, itemType: 'live', clientMode: 'transcode',
    body: { mode: 'transcode', requiresTranscode: true, gatewayAutoMode: true, publicHlsDirectSessionGuard: true,
      playbackHint: { gatewayMode: 'remux' } },
    clientMetadata: { clientSurface: 'web', appMode: 'cloud' }, ...overrides };
}

test('both real curated Xumo imports receive a separate immutable public delivery descriptor without changing their URLs', async () => {
  const { resolveSelectionLiveDelivery, shouldUseSelectionLiveDirect } = await policy;
  const inputs = await fixture;
  assert.deepEqual(inputs.map(input => input.ownedItem.metadata.tvgId), ['99951251', '99991638']);
  for (const input of inputs) {
    const before = JSON.stringify(input);
    const delivery = await resolveSelectionLiveDelivery(input);
    assert.equal(delivery.transport, 'public-hls-direct');
    assert.equal(delivery.targetUrl, input.targetUrl);
    assert.ok(Object.isFrozen(delivery));
    assert.equal(shouldUseSelectionLiveDirect(decision(input, delivery)), true);
    assert.equal(JSON.stringify(input), before);
  }
});

test('ownership, deterministic Selection source, feed, exact media and channel are all required', async () => {
  const { resolveSelectionLiveDelivery } = await policy;
  const [input] = await fixture;
  const cases = [
    ['private source', value => { value.sourceId = 'private-playlist'; }],
    ['another owner', value => { value.userId = 'another-owner'; }],
    ['missing owned row', value => { value.ownedItem = null; }],
    ['movie', value => { value.itemType = 'movie'; }],
    ['unreviewed item', value => { value.itemId += '-other'; }],
    ['other feed', value => { value.ownedItem.metadata.discoveryFeed = 'iptv-org'; }],
    ['wrong attribution', value => { value.ownedItem.metadata.discoverySource = 'https://example.org/'; }],
    ['other channel', value => { value.ownedItem.metadata.tvgId = '99991638'; }],
    ['inherited object key', value => { value.ownedItem.metadata.tvgId = '__proto__'; }],
    ['non-string channel', value => { value.ownedItem.metadata.tvgId = 99951251; }],
    ['stale media key', value => { value.ownedItem.metadata.discoveryMediaKey += '#other'; }],
    ['Xtream', value => { value.ownedItem.playback_hint.sourceType = 'xtream'; }],
    ['non-HLS', value => { value.ownedItem.playback_hint.container = 'ts'; }],
    ['global target differs', value => { value.targetUrl += '&other=1'; }],
  ];
  for (const [name, change] of cases) {
    const value = structuredClone(input); change(value);
    assert.equal(await resolveSelectionLiveDelivery(value), null, name);
  }
});

test('provider origin, channel path and full advertising URL are pinned, even if persisted metadata is changed together', async () => {
  const { resolveSelectionLiveDelivery } = await policy;
  const [input] = await fixture;
  const changes = [
    url => { url.protocol = 'http:'; },
    url => { url.hostname += '.attacker.example'; },
    url => { url.hostname = 'another.cloudfront.net'; },
    url => { url.port = '8443'; },
    url => { url.pathname = '/10001/99991638/hls/playlist.m3u8'; },
    url => { url.username = 'account'; url.password = 'secret'; },
    url => { url.hash = 'fragment'; },
    url => { url.search = ''; },
    url => { url.searchParams.set('ads.channelId', 'another'); },
    url => { url.searchParams.set('token', 'credential'); },
  ];
  for (const change of changes) {
    const value = structuredClone(input);
    const url = new URL(value.targetUrl); change(url);
    value.targetUrl = url.href;
    value.ownedItem.playback_hint.targetUrl = url.href;
    value.ownedItem.metadata.discoveryMediaKey = url.href;
    assert.equal(await resolveSelectionLiveDelivery(value), null);
  }
});

test('only automatic cloud web gateway requests with the live-session guard capability are demoted', async () => {
  const { resolveSelectionLiveDelivery, shouldUseSelectionLiveDirect } = await policy;
  const [input] = await fixture;
  const delivery = await resolveSelectionLiveDelivery(input);
  const base = decision(input, delivery);
  for (const clientSurface of ['web', 'mobile-web', 'pwa']) {
    assert.equal(shouldUseSelectionLiveDirect({ ...base, clientMetadata: { clientSurface, appMode: 'cloud' } }), true);
  }
  for (const patch of [
    { itemType: 'movie' }, { itemType: 'series' }, { targetUrl: input.targetUrl + '&other=1' },
    { clientMode: 'direct' }, { clientMode: 'relay' },
    { clientMetadata: { clientSurface: 'android-tv', appMode: 'cloud' } },
    { clientMetadata: { clientSurface: 'android-phone', appMode: 'cloud' } },
    { clientMetadata: { clientSurface: 'web', appMode: 'local' } }, { clientMetadata: {} },
    ...[false, undefined, 'true'].flatMap(value => [
      { body: { ...base.body, gatewayAutoMode: value } },
      { body: { ...base.body, publicHlsDirectSessionGuard: value } },
    ]),
  ]) assert.equal(shouldUseSelectionLiveDirect({ ...base, ...patch }), false, JSON.stringify(patch));
});

test('explicit conversion, audio conversion, relay and either hint alias retain their requested transport', async () => {
  const { resolveSelectionLiveDelivery, shouldUseSelectionLiveDirect } = await policy;
  const [input] = await fixture;
  const base = decision(input, await resolveSelectionLiveDelivery(input));
  for (const force of [
    { gatewayMode: 'transcode' }, { gateway_mode: 'audio-transcode' },
    { liveForceTranscode: true }, { live_force_transcode: '1' },
    { forceVideoTranscode: 1 }, { force_video_transcode: true },
    { enginePipe: true }, { requires_relay: true },
  ]) {
    for (const location of ['body', 'playbackHint', 'playback_hint', 'resolvedHint']) {
      const candidate = { ...base, body: { ...base.body } };
      if (location === 'body') Object.assign(candidate.body, force);
      else if (location === 'resolvedHint') candidate.playbackHint = force;
      else candidate.body[location] = force;
      assert.equal(shouldUseSelectionLiveDirect(candidate), false, `${location}: ${JSON.stringify(force)}`);
    }
  }
});

test('request hints, forged descriptors and JSON copies cannot assert delivery authority', async () => {
  const { resolveSelectionLiveDelivery, shouldUseSelectionLiveDirect } = await policy;
  const [input] = await fixture;
  const delivery = await resolveSelectionLiveDelivery(input);
  for (const forged of [null, {}, structuredClone(delivery), { ...delivery }, JSON.parse(JSON.stringify(delivery))]) {
    const candidate = decision(input, forged);
    candidate.body.playbackHint.selectionLiveDelivery = delivery;
    candidate.body.publicHlsDirect = true;
    assert.equal(shouldUseSelectionLiveDirect(candidate), false);
  }
});

test('new canary track and quality guards do not alter the two existing curated Xumo lanes', async () => {
  const { resolveSelectionLiveDelivery, shouldUseSelectionLiveDirect } = await policy;
  for (const input of await fixture) {
    const delivery = await resolveSelectionLiveDelivery(input);
    const base = decision(input, delivery);
    for (const selection of [{ audioStreamIndex: 0 }, { subtitle_stream_index: '1' },
      { videoTrackIndex: 0 }, { quality: '720p' }, { resolution: '1280x720' }]) {
      assert.equal(shouldUseSelectionLiveDirect({ ...base, body: { ...base.body, ...selection } }), true);
    }
  }
});

test('the actual Edge resolver trusts the visible owner row, never a global mirror or request-hint descriptor', async () => {
  const { resolveSelectionLiveDelivery, shouldUseSelectionLiveDirect } = await policy;
  let [input] = await fixture;
  const calls = [];
  let owned = input.ownedItem;
  const context = vm.createContext({
    resolveSelectionLiveDelivery, resolveDiscoveryTarget: async ({ targetUrl }) => targetUrl,
    resolveObservedVodContainer: async () => null, mediaReadFromCatalog: () => true,
    resolveSourceHost: async () => 'public.example', recordOrEmpty: value => value || {},
    firstUsefulCodecProfile: () => ({}), normalizeMkvH264FastStartProof: () => null,
    hasReliableVodCodecProfile: () => false, hasUsefulCodecProfile: () => false,
    mergePlaybackHints: (a, b) => ({ ...a, ...b }), compactRecord: value => value,
    stringOrNull: value => typeof value === 'string' && value ? value : null,
    HttpError: class HttpError extends Error {},
  });
  vm.runInContext(stripTypeScriptTypes(section('async function resolvePlaybackTarget(', '\n// Series have no directly-playable stream id'), { mode: 'strip' }), context);
  const db = { from(table) {
    const filters = [];
    return { select() { return this; }, eq(key, value) { filters.push([key, value]); return this; },
      async maybeSingle() {
        calls.push({ table, filters });
        return { data: table === 'catalog_media_items' ? input.ownedItem : owned, error: null };
      } };
  } };
  const resolve = () => context.resolvePlaybackTarget(input.sourceId, input.itemType, input.itemId, input.userId, db,
    { selectionLiveDelivery: { transport: 'public-hls-direct' }, targetUrl: input.targetUrl });
  const valid = await resolve();
  assert.equal(shouldUseSelectionLiveDirect(decision(input, valid.selectionLiveDelivery)), true);
  assert.equal(valid.providerAccountScope, `user-source:${input.userId}:${input.sourceId}:public-feed:xumo-curated`);
  assert.equal(valid.playbackHint.selectionLiveDelivery, undefined);
  assert.deepEqual(calls.find(call => call.table === 'cloud_catalog_visible_media_items').filters,
    [['source_id', input.sourceId], ['user_id', input.userId], ['item_type', 'live'], ['external_id', input.itemId]]);
  const xumoScope = valid.providerAccountScope;
  for (const candidate of await fixture) {
    input = candidate; owned = candidate.ownedItem;
    const otherChannel = await resolve();
    assert.equal(otherChannel.providerAccountScope, xumoScope, 'both channels keep the same provider takeover boundary');
    assert.ok(otherChannel.selectionLiveDelivery);
  }
  for (const unowned of [null, { ...input.ownedItem, metadata: {} }]) {
    owned = unowned;
    const result = await resolve();
    assert.equal(result.targetUrl, input.targetUrl);
    assert.equal(result.selectionLiveDelivery, null);
    assert.equal(result.providerAccountScope, `user-source:${input.userId}:${input.sourceId}`);
  }
});

test('the direct public decision runs within existing authorization and session lifecycle, with an exclusive marker', () => {
  const create = section('async function createPlaybackSessionCore(', '\nasync function createPlaybackSession(');
  const routing = create.indexOf('const serverDirectPublicHls =');
  for (const guard of ['await assertOwnedSource(', 'await assertSourceCatalogVisible(', 'await assertOwnedDevice(',
    'await resolvePlaybackTarget(', 'await assertActiveCatalogGenerationCurrent(']) {
    assert.ok(create.indexOf(guard) >= 0 && create.indexOf(guard) < routing, guard);
  }
  const direct = create.indexOf('if (mode === "direct")');
  for (const guard of ['await requirePlaybackEntitlement(', 'await requirePlaybackCapacity(',
    '"claim_cloud_playback_session"', 'await releaseSupersededPlaybackSessions(']) {
    assert.ok(create.indexOf(guard) > routing && create.indexOf(guard) < direct, guard);
  }
  assert.match(create, /const mode = serverDirectPublicHls\s*\? "direct"\s*: serverDemotedAutomaticMp4/);
  assert.match(create.slice(direct), /serverDirectPublicHls \? \{ transport: "public-hls-direct" \} : \{\}/);
  assert.match(create.slice(direct), /session: publicPlaybackSession\(session\)[\s\S]*url: targetUrl,[\s\S]*fallbackUrl: null,[\s\S]*expiresAt,/);
});
