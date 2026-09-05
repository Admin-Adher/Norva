'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const hash = value => createHash('sha256').update(value).digest('hex');
const modules = Promise.all([
  import('../supabase/functions/_shared/selection-live-delivery.mjs'),
  import('../supabase/functions/_shared/discovery-catalog.mjs'),
  import('../supabase/functions/_shared/selection-live-direct-canaries.mjs'),
]);

async function fixture() {
  const [policy, catalogue] = await modules;
  const userId = 'e442090b-915b-47c4-b549-d36d5cae626c';
  const targetUrl = 'https://public-cdn.example/live/720/playlist.m3u8?channel=public&region=fr';
  const itemId = `norva-discovery:live:${hash(`live:${targetUrl}`)}`;
  const input = { userId, sourceId: await catalogue.discoverySourceId(userId), itemType: 'live', itemId, targetUrl,
    ownedItem: { metadata: { discoveryFeed: 'public-test-feed', discoverySource: 'https://publisher.example/',
      discoveryMediaKey: targetUrl, tvgId: 'public-test-channel' },
    playback_hint: { sourceType: 'm3u', container: 'm3u8', targetUrl } } };
  const entry = { feedId: input.ownedItem.metadata.discoveryFeed, discoverySource: input.ownedItem.metadata.discoverySource,
    tvgId: input.ownedItem.metadata.tvgId, externalId: itemId, targetUrlSha256: hash(targetUrl),
    origin: new URL(targetUrl).origin, pathname: new URL(targetUrl).pathname, ownerUserIdSha256: hash(userId) };
  const manifest = { schemaVersion: 1, entries: [entry] };
  return { policy, catalogue, input, entry, manifest,
    resolver: policy.createSelectionLiveDeliveryResolver({ canaryManifest: manifest }) };
}

const decision = (input, delivery) => ({ delivery, targetUrl: input.targetUrl, itemType: input.itemType, clientMode: 'transcode',
  body: { gatewayAutoMode: true, publicHlsDirectSessionGuard: true, playbackHint: { gatewayMode: 'remux' } },
  clientMetadata: { appMode: 'cloud', clientSurface: 'web' } });

test('the shipped canary registry is immutable, bounded to seven streams and one authorized owner', async () => {
  const { input, policy, manifest } = await fixture();
  const [, , { SELECTION_LIVE_DIRECT_CANARIES }] = await modules;
  const entries = SELECTION_LIVE_DIRECT_CANARIES.entries;
  assert.equal(SELECTION_LIVE_DIRECT_CANARIES.schemaVersion, 1);
  assert.equal(entries.length, 7);
  assert.equal(new Set(entries.map(entry => entry.externalId)).size, 7);
  assert.deepEqual([...new Set(entries.map(entry => entry.ownerUserIdSha256))], ['a7da1be5077b8c10cd7a5c177554d38e9d48bf060d17047e77da02928f011c12']);
  assert.ok(Object.isFrozen(SELECTION_LIVE_DIRECT_CANARIES));
  assert.ok(Object.isFrozen(entries));
  for (const entry of entries) assert.ok(Object.isFrozen(entry));
  input.canaryManifest = manifest;
  input.ownedItem.playback_hint.canaryManifest = manifest;
  assert.equal(await policy.resolveSelectionLiveDelivery(input), null, 'request-shaped injection cannot override the server registry');
});

test('an exact server-authorized owner and imported item get an immutable descriptor using the existing session guard', async () => {
  const { input, resolver, policy } = await fixture();
  const original = JSON.stringify(input);
  const delivery = await resolver(input);
  assert.deepEqual(delivery, { transport: 'public-hls-direct', channelId: 'public-test-channel', targetUrl: input.targetUrl,
    providerAccountScopeSuffix: `public-media:${hash(`live:${input.targetUrl}`)}` });
  assert.ok(Object.isFrozen(delivery));
  assert.equal(policy.shouldUseSelectionLiveDirect(decision(input, delivery)), true);
  assert.equal(JSON.stringify(input), original);
});

test('the same Selection item remains ineligible for another authenticated owner despite forged request and stored hints', async () => {
  const { input, resolver, policy, catalogue, manifest } = await fixture();
  const originalOwner = input.userId;
  input.userId = 'e442090b-915b-47c4-b549-d36d5cae626d';
  input.sourceId = await catalogue.discoverySourceId(input.userId);
  input.playbackHint = { userId: originalOwner, ownerUserIdSha256: hash(originalOwner), canaryManifest: manifest };
  Object.assign(input.ownedItem.playback_hint, input.playbackHint);
  assert.equal(await resolver(input), null);
  const forged = { transport: 'public-hls-direct', channelId: 'public-test-channel', targetUrl: input.targetUrl };
  assert.equal(policy.shouldUseSelectionLiveDirect(decision(input, forged)), false);
});

test('canaries require a deterministic owned Selection live HLS row and exact feed/source/media metadata', async () => {
  const { input, resolver } = await fixture();
  for (const [name, change] of [
    ['personal source', value => { value.sourceId = 'a-private-source'; }],
    ['missing row', value => { value.ownedItem = null; }],
    ['missing owner', value => { value.userId = ''; }],
    ['VOD', value => { value.itemType = 'movie'; }],
    ['series', value => { value.itemType = 'series'; }],
    ['different item', value => { value.itemId += '-other'; }],
    ['feed', value => { value.ownedItem.metadata.discoveryFeed = 'another-feed'; }],
    ['source attribution', value => { value.ownedItem.metadata.discoverySource = 'https://another.example/'; }],
    ['tvgId', value => { value.ownedItem.metadata.tvgId = 'another-channel'; }],
    ['media key', value => { value.ownedItem.metadata.discoveryMediaKey += '&changed=1'; }],
    ['owned target', value => { value.ownedItem.playback_hint.targetUrl += '&changed=1'; }],
    ['Xtream', value => { value.ownedItem.playback_hint.sourceType = 'xtream'; }],
    ['not m3u8', value => { value.ownedItem.playback_hint.container = 'ts'; }],
  ]) {
    const value = structuredClone(input); change(value);
    assert.equal(await resolver(value), null, name);
  }
});

test('canonical full URL and external identity pins reject coordinated target, query, host and metadata changes', async () => {
  const { input, resolver } = await fixture();
  for (const change of [
    url => { url.searchParams.set('region', 'us'); },
    url => { url.searchParams.sort(); url.searchParams.append('extra', '1'); },
    url => { url.search = '?region=fr&channel=public'; },
    url => { url.hostname += '.attacker.example'; },
    url => { url.pathname = '/other/playlist.m3u8'; },
    url => { url.protocol = 'http:'; },
    url => { url.username = 'private'; url.password = 'credential'; },
    url => { url.hash = 'fragment'; },
  ]) {
    const value = structuredClone(input), url = new URL(value.targetUrl); change(url);
    value.targetUrl = url.href;
    value.ownedItem.playback_hint.targetUrl = url.href;
    value.ownedItem.metadata.discoveryMediaKey = url.href;
    value.itemId = `norva-discovery:live:${hash(`live:${url.href}`)}`;
    assert.equal(await resolver(value), null);
  }
});

test('native, explicit modes, forced conversion and clients without the heartbeat capability never use a canary direct lane', async () => {
  const { input, resolver, policy } = await fixture();
  const base = decision(input, await resolver(input));
  for (const patch of [
    { clientMetadata: { appMode: 'cloud', clientSurface: 'android-phone' } },
    { clientMetadata: { appMode: 'cloud', clientSurface: 'android-tv' } },
    { clientMetadata: { appMode: 'local', clientSurface: 'web' } },
    { clientMode: 'relay' }, { clientMode: 'direct' },
    { body: { ...base.body, gatewayAutoMode: false } },
    { body: { ...base.body, publicHlsDirectSessionGuard: false } },
    { body: { gatewayAutoMode: true } },
    { body: { ...base.body, playbackHint: { gatewayMode: 'transcode' } } },
    { body: { ...base.body, liveForceTranscode: true } },
    { body: { ...base.body, playback_hint: { requires_relay: true } } },
  ]) assert.equal(policy.shouldUseSelectionLiveDirect({ ...base, ...patch }), false, JSON.stringify(patch));
  assert.equal(policy.shouldUseSelectionLiveDirect({ ...base, delivery: structuredClone(base.delivery) }), false);
});

test('every server pin is checked independently and noncanonical target spellings are refused', async () => {
  const { input, entry, policy, resolver } = await fixture();
  for (const patch of [
    { targetUrlSha256: hash('another complete URL') }, { ownerUserIdSha256: hash('another authenticated owner') },
    { origin: 'https://other-public.example' }, { pathname: '/other/playlist.m3u8' },
    { feedId: 'other-feed' }, { discoverySource: 'https://other-publisher.example/' }, { tvgId: 'other-channel' },
    { externalId: `norva-discovery:live:${hash('other item')}` },
  ]) {
    const candidate = policy.createSelectionLiveDeliveryResolver({
      canaryManifest: { schemaVersion: 1, entries: [{ ...entry, ...patch }] },
    });
    assert.equal(await candidate(input), null, JSON.stringify(patch));
  }
  const alternate = structuredClone(input);
  // Use an equivalent host spelling with the same WHATWG canonical URL.
  alternate.targetUrl = input.targetUrl.replace('public-cdn.example', 'PUBLIC-CDN.EXAMPLE');
  alternate.ownedItem.playback_hint.targetUrl = alternate.targetUrl;
  assert.equal(new URL(alternate.targetUrl).href, input.targetUrl);
  assert.equal(await resolver(alternate), null);
});

test('new canaries preserve explicit stream, track and quality choices in every real hint location', async () => {
  const { input, resolver, policy } = await fixture();
  const base = decision(input, await resolver(input));
  const fields = ['videoStreamIndex', 'video_stream_index', 'audioStreamIndex', 'audio_stream_index',
    'subtitleStreamIndex', 'subtitle_stream_index', 'videoTrackIndex', 'video_track_index',
    'audioTrackIndex', 'audio_track_index', 'subtitleTrackIndex', 'subtitle_track_index'];
  const selections = fields.flatMap(key => [0, '0', 2, '2'].map(value => [key, value]));
  selections.push(...['quality', 'resolution', 'rendition', 'preferredQuality', 'preferred_quality']
    .flatMap(key => [0, '720p', 'highest'].map(value => [key, value])));
  for (const [key, value] of selections) {
    for (const location of ['body', 'playbackHint', 'playback_hint', 'resolvedHint']) {
      const candidate = { ...base, body: structuredClone(base.body) };
      if (location === 'body') candidate.body[key] = value;
      else if (location === 'resolvedHint') candidate.playbackHint = { [key]: value };
      else candidate.body[location] = { [key]: value };
      assert.equal(policy.shouldUseSelectionLiveDirect(candidate), false, `${location}.${key}=${value}`);
    }
    const owned = structuredClone(input); owned.ownedItem.playback_hint[key] = value;
    assert.equal(await resolver(owned), null, `owned hint ${key}=${value}`);
  }
  for (const key of [...fields, 'quality', 'resolution', 'rendition', 'preferredQuality', 'preferred_quality']) {
    for (const value of [-1, '-1', null, undefined, '', 'auto', ' Auto ']) {
      const candidate = { ...base, body: { ...base.body, [key]: value } };
      assert.equal(policy.shouldUseSelectionLiveDirect(candidate), true, `${key}=${value}`);
      const owned = structuredClone(input); owned.ownedItem.playback_hint[key] = value;
      assert.ok(await resolver(owned), `owned Auto hint ${key}=${value}`);
    }
  }
});

test('the actual Edge resolver isolates canary circuits by exact public media while retaining owner/source takeover boundaries', async () => {
  const { input, entry, manifest, policy, catalogue } = await fixture();
  const second = structuredClone(input);
  second.targetUrl = second.targetUrl.replace('/720/', '/1080/');
  second.itemId = `norva-discovery:live:${hash(`live:${second.targetUrl}`)}`;
  second.ownedItem.playback_hint.targetUrl = second.targetUrl;
  second.ownedItem.metadata.discoveryMediaKey = second.targetUrl;
  manifest.entries.push({ ...entry, externalId: second.itemId, targetUrlSha256: hash(second.targetUrl),
    pathname: new URL(second.targetUrl).pathname });
  const resolver = policy.createSelectionLiveDeliveryResolver({ canaryManifest: manifest });
  const edge = fs.readFileSync(path.join(__dirname, '../supabase/functions/norva-playback/index.ts'), 'utf8').replace(/\r\n/g, '\n');
  const start = edge.indexOf('async function resolvePlaybackTarget(');
  const end = edge.indexOf('\n// Series have no directly-playable stream id', start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({
    resolveSelectionLiveDelivery: resolver, resolveDiscoveryTarget: async ({ targetUrl }) => targetUrl,
    resolveObservedVodContainer: async () => null, mediaReadFromCatalog: () => true,
    resolveSourceHost: async () => 'public.example', recordOrEmpty: value => value || {},
    firstUsefulCodecProfile: () => ({}), normalizeMkvH264FastStartProof: () => null,
    hasReliableVodCodecProfile: () => false, hasUsefulCodecProfile: () => false,
    mergePlaybackHints: (a, b) => ({ ...a, ...b }), compactRecord: value => value,
    stringOrNull: value => typeof value === 'string' && value ? value : null,
    HttpError: class HttpError extends Error {},
  });
  vm.runInContext(stripTypeScriptTypes(edge.slice(start, end), { mode: 'strip' }), context);
  async function resolve(value) {
    const calls = [];
    const db = { from(table) {
      const filters = [];
      return { select() { return this; }, eq(key, val) { filters.push([key, val]); return this; },
        async maybeSingle() { calls.push({ table, filters }); return { data: value.ownedItem, error: null }; } };
    } };
    const result = await context.resolvePlaybackTarget(value.sourceId, value.itemType, value.itemId, value.userId, db,
      { providerAccountScopeSuffix: 'public-feed:xumo-curated', providerAccountScope: 'forged-scope',
        selectionLiveDelivery: { providerAccountScopeSuffix: 'forged-scope' } });
    assert.deepEqual(calls.find(call => call.table === 'cloud_catalog_visible_media_items').filters,
      [['source_id', value.sourceId], ['user_id', value.userId], ['item_type', 'live'], ['external_id', value.itemId]]);
    return result;
  }
  const first = await resolve(input), again = await resolve(input), other = await resolve(second);
  const prefix = `user-source:${input.userId}:${input.sourceId}`;
  assert.equal(first.providerAccountScope, `${prefix}:public-media:${hash(`live:${input.targetUrl}`)}`);
  assert.equal(again.providerAccountScope, first.providerAccountScope, 'same public media retains the takeover identity');
  assert.notEqual(other.providerAccountScope, first.providerAccountScope, 'same feed, different media keeps an independent circuit');
  assert.ok(!first.providerAccountScope.includes('xumo-curated'));
  const unapprovedOwner = structuredClone(input);
  unapprovedOwner.userId = 'e442090b-915b-47c4-b549-d36d5cae626d';
  unapprovedOwner.sourceId = await catalogue.discoverySourceId(unapprovedOwner.userId);
  const unapproved = await resolve(unapprovedOwner);
  assert.equal(unapproved.selectionLiveDelivery, null);
  assert.equal(unapproved.providerAccountScope, `user-source:${unapprovedOwner.userId}:${unapprovedOwner.sourceId}`);
});

test('a malformed or ambiguous server canary manifest stays closed and does not grant a lane through later mutation', async () => {
  const { input, entry, manifest, policy } = await fixture();
  for (const invalid of [
    { ...manifest, schemaVersion: 2 }, { entries: [entry] }, { schemaVersion: 1, entries: {} },
    { schemaVersion: 1, entries: Array.from({ length: 17 }, () => entry) },
    { schemaVersion: 1, entries: [entry, { ...entry }] },
    ...[
      { ownerUserIdSha256: input.userId }, { targetUrlSha256: 'invalid' },
      { origin: 'https://public-cdn.example/' }, { pathname: '/file.mp4' },
      { tvgId: '' }, { feedId: 123 }, { discoverySource: 'http://publisher.example/' },
      { userId: input.userId },
    ].map(patch => ({ schemaVersion: 1, entries: [{ ...entry, ...patch }] })),
  ]) assert.equal(await policy.createSelectionLiveDeliveryResolver({ canaryManifest: invalid })(input), null);
  const resolver = policy.createSelectionLiveDeliveryResolver({ canaryManifest: manifest });
  manifest.entries.length = 0;
  entry.ownerUserIdSha256 = hash('different-owner');
  assert.ok(await resolver(input), 'an initialized resolver retains its server snapshot');
  const empty = { schemaVersion: 1, entries: [] };
  const closed = policy.createSelectionLiveDeliveryResolver({ canaryManifest: empty });
  empty.entries.push(entry);
  assert.equal(await closed(input), null, 'post-initialization additions do not grant authority');
});
