'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const { createHash } = require('node:crypto');
const modulePath = '../supabase/functions/_shared/selection-live-rendition.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const base = 'https://provider.example/live/master.m3u8?advertising=public';
const selected = 'https://norva.tv/catalog/test-quality-720.m3u8';
const video = (resolution, uri, codecs = 'avc1.64001f,mp4a.40.2', extra = '') =>
  `#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=${resolution}${codecs ? `,CODECS="${codecs}"` : ''}${extra}\n${uri}\n`;
const master = '#EXTM3U\n' + video('480x270', '270.m3u8') + video('1920x1080', '1080.m3u8') + video('1280x720', '720.m3u8?region=fr&ads=[DEVICE]');
const media = '#EXTM3U\n' + video('1280x720', 'https://provider.example/live/720.m3u8?region=fr&ads=[DEVICE]');
const response = (value, status = 200, location = null) => ({ value, response: new Response('', { status,
  headers: location ? { location } : {} }) });
const auto = () => ({ clientMode: 'transcode', body: { mode: 'transcode', gatewayAutoMode: true,
  playbackHint: { gatewayMode: 'remux' } }, clientMetadata: { clientSurface: 'web', appMode: 'cloud' } });

async function setup({ fetchText, now, content = master, policy = {} } = {}) {
  const { createSelectionLiveRenditionResolver } = await import(modulePath);
  const { discoverySourceId } = await import('../supabase/functions/_shared/discovery-catalog.mjs');
  const externalId = `norva-discovery:live:${sha(`live:${base}`)}`;
  const canary = { externalId, feedId: 'free-tv', discoverySource: 'https://github.com/Free-TV/IPTV',
    targetUrlSha256: sha(base), hosts: ['provider.example'], masterSha256: sha(master), resolvedMasterUrlSha256: sha(base), assetUrl: selected, assetSha256: sha(media), ...policy };
  const input = { sourceId: await discoverySourceId('owner'), userId: 'owner', itemType: 'live', itemId: externalId,
    targetUrl: base, request: auto(), ownedItem: { playback_hint: { sourceType: 'm3u', container: 'm3u8', targetUrl: base },
      metadata: { discoveryFeed: 'free-tv', discoverySource: canary.discoverySource, discoveryMediaKey: base } } };
  const calls = [];
  const resolve = createSelectionLiveRenditionResolver({ canaries: [canary], now, fetchText: async (url, options) => {
    calls.push({ url, options });
    return fetchText ? fetchText(url, options, calls.length) : response(url === base ? content : media);
  } });
  return { resolve, input, calls, canary };
}

test('automatic Selection input chooses 720p before 1080p, preserving original identity and advertising parameters', async () => {
  const { resolve, input, calls } = await setup();
  const before = JSON.stringify(input);
  assert.equal(await resolve(input), selected);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(calls.map(call => call.url), [base, selected]);
  for (const { options } of calls) {
    assert.equal(options.redirect, 'manual');
    assert.equal(options.maxBytes, 65536);
    assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 4000);
    assert.equal(options.headers, undefined);
  }
});

test('every changed master, including a different rendition/audio/codec, keeps the original URL', async () => {
  for (const content of [master + '\n', master.replace('1280x720', '1920x1080'),
    master.replace('720.m3u8?', '720-other.m3u8?'), master.replace('mp4a.40.2', 'ac-3'),
    master.replace('#EXTM3U\n', '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="new"\n')]) {
    const { resolve, input, calls } = await setup({ content });
    assert.equal(await resolve(input), base);
    assert.equal(calls.length, 1, 'unmatched master cannot even select a public canary asset');
  }
});

test('the two real canary assets retain all AUDIO/CC and global tags, select only720p, and use existing public resources', () => {
  const cases = [
    ['tv5-info', 'quality-tv5-info-720.m3u8', 'd1db551a1f1c376ae139389da45e00e20336a22245603c5475ab8f6b3736183f',
      ['247e4d11968e509e9fe030bc5399971edabaa10eaa25ec34a8b9ad2f9b672572', 'a14958be20975fed8b2cc63cd03283a7fd7c3911d914b00be8854e5f1703cb0f']],
    ['filmrise-roku', 'quality-filmrise-roku-720.m3u8', '8941af5ebfda446b250c57326a945e23cd1dd14fa069e5dd55c168b14386bac8',
      ['dead8956f57abc7af91f08e43d9018baf1dd1c0e3c10ce23fd15b1a1705e77d1']],
  ];
  for (const [fixtureName, assetName, digest, resourceHashes] of cases) {
    const original = fs.readFileSync(path.join(__dirname, 'fixtures/selection-live-rendition', `${fixtureName}.m3u8`), 'utf8');
    const bytes = fs.readFileSync(path.join(__dirname, '../public/catalog', assetName));
    const asset = bytes.toString('utf8');
    assert.equal(sha(bytes), digest);
    const tag = line => line.startsWith('#') && !line.startsWith('#EXT-X-STREAM-INF:');
    const maskUri = line => line.replace(/URI="[^"]+"/g, 'URI="RESOURCE"');
    const globals = text => text.split(/\r?\n/).filter(tag).map(maskUri);
    assert.deepEqual(globals(asset), globals(original), 'all audio/caption metadata and global tags retained');
    const variantLines = asset.split(/\r?\n/).filter(line => line.startsWith('#EXT-X-STREAM-INF:'));
    assert.equal(variantLines.length, 1);
    assert.match(variantLines[0], /RESOLUTION=1280x720/);
    assert.ok(original.includes(variantLines[0]), 'selected attributes are unchanged from provider');
    const urls = [...asset.matchAll(/URI="([^"]+)"/g)].map(match => match[1]);
    urls.push(...asset.split(/\r?\n/).filter(line => line && !line.startsWith('#')));
    assert.deepEqual(urls.map(url => sha(new URL(url).href)).sort(), [...resourceHashes].sort());
    for (const raw of urls) {
      const url = new URL(raw);
      assert.equal(url.protocol, 'https:');
      assert.equal(url.username + url.password, '');
      assert.ok(['ott.tv5monde.com', 'aka-live1050.delivery.roku.com'].includes(url.hostname));
    }
  }
});

test('personal source, foreign owner, VOD, Xumo and forged media metadata cause zero network requests', async () => {
  const changes = [
    value => { value.sourceId = 'personal'; }, value => { value.userId = 'other-owner'; },
    value => { value.itemType = 'movie'; }, value => { value.ownedItem = null; },
    value => { value.ownedItem.metadata.discoveryFeed = 'xumo-curated'; },
    value => { value.ownedItem.metadata.discoverySource = 'https://attacker.example'; },
    value => { value.ownedItem.metadata.discoveryMediaKey += '?forged'; },
    value => { value.itemId += '-forged'; }, value => { value.ownedItem.playback_hint.sourceType = 'xtream'; },
    value => { value.targetUrl += '&unexpected=1'; },
  ];
  for (const change of changes) {
    const { resolve, input, calls } = await setup(); change(input);
    assert.equal(await resolve(input), input.targetUrl);
    assert.equal(calls.length, 0);
  }
});

test('explicit conversion, relay/direct, native clients and track/quality choices cause zero network requests', async () => {
  const changes = [value => { value.request = null; },
    ...['direct', 'relay'].map(mode => value => { value.request.clientMode = mode; }),
    value => { value.request.body.gatewayAutoMode = false; },
    value => { value.request.clientMetadata.clientSurface = 'android-tv'; },
    value => { value.request.clientMetadata.appMode = 'local'; },
    value => { value.request.body.playbackHint.gatewayMode = 'transcode'; },
    value => { value.request.body.playback_hint = { force_video_transcode: true }; },
    value => { value.request.body.nativePlayer = true; },
    value => { value.request.body.quality = '1080p'; },
    value => { value.request.body.audio_track_index = 0; },
    value => { value.ownedItem.playback_hint.requiresRelay = true; },
  ];
  for (const change of changes) {
    const { resolve, input, calls } = await setup(); change(input);
    assert.equal(await resolve(input), base);
    assert.equal(calls.length, 0);
  }
});

test('real StreamIndex selectors and TrackIndex aliases preserve explicit zero and positive selections in every hint location', async () => {
  const keys = ['videoStreamIndex', 'video_stream_index', 'audioStreamIndex', 'audio_stream_index',
    'subtitleStreamIndex', 'subtitle_stream_index', 'videoTrackIndex', 'video_track_index',
    'audioTrackIndex', 'audio_track_index', 'subtitleTrackIndex', 'subtitle_track_index'];
  const locations = [input => input.request.body, input => input.request.body.playbackHint,
    input => (input.request.body.playback_hint = {}), input => (input.request.playbackHint = {}),
    input => input.ownedItem.playback_hint];
  for (const key of keys) for (const location of locations) for (const value of [0, 2, '0', '5']) {
    const { resolve, input, calls } = await setup();
    location(input)[key] = value;
    assert.equal(await resolve(input), base, `${key}=${value} preserves its original demux indexes`);
    assert.equal(calls.length, 0);
  }
});

test('negative, null, undefined, empty and auto stream indexes retain automatic quality routing', async () => {
  const keys = ['videoStreamIndex', 'video_stream_index', 'audioStreamIndex', 'audio_stream_index',
    'subtitleStreamIndex', 'subtitle_stream_index', 'videoTrackIndex', 'video_track_index',
    'audioTrackIndex', 'audio_track_index', 'subtitleTrackIndex', 'subtitle_track_index'];
  for (const value of [-1, '-1', null, undefined, '', 'auto']) {
    const { resolve, input, calls } = await setup();
    const absent = Object.fromEntries(keys.map(key => [key, value]));
    Object.assign(input.request.body, absent);
    Object.assign(input.request.body.playbackHint, absent);
    input.request.body.playback_hint = { ...absent };
    input.request.playbackHint = { ...absent };
    Object.assign(input.ownedItem.playback_hint, absent);
    assert.equal(await resolve(input), selected, `${String(value)} is not an explicit index`);
    assert.equal(calls.length, 2);
  }
});

test('manual redirects reject private/credential/foreign targets before requesting them', async () => {
  const denied = ['http://provider.example/master.m3u8', 'https://user:pass@provider.example/master.m3u8',
    'https://provider.example:8443/master.m3u8', 'https://127.0.0.1/master.m3u8', 'https://172.16.0.1/master.m3u8',
    'https://[::1]/master.m3u8', 'https://provider.example.attacker.example/master.m3u8',
    'https://provider.example/master.m3u8?token=private', 'https://provider.example/master.m3u8?X-Plex-Token=private'];
  for (const url of denied) {
    const { resolve, input, calls } = await setup({ fetchText: () => response('', 302, url) });
    assert.equal(await resolve(input), base);
    assert.equal(calls.length, 1);
  }
});

test('relative redirects use their effective master URL and its exact hash; loops and altered destinations fall back', async () => {
  const redirected = 'https://provider.example/redirect/master.m3u8';
  const { resolve, input, calls } = await setup({ policy: { resolvedMasterUrlSha256: sha(redirected) }, fetchText: url => {
    if (url === base) return response('', 302, '../redirect/master.m3u8');
    return response(url === redirected ? master : media);
  } });
  assert.equal(await resolve(input), selected);
  assert.deepEqual(calls.map(call => call.url), [base, redirected, selected]);
  const changed = await setup({ fetchText: url => url === base ? response('', 302, redirected) : response(master) });
  assert.equal(await changed.resolve(changed.input), base);
  assert.equal(changed.calls.length, 2, 'same bytes at an unreviewed resolved master URL do not qualify');
  const loop = await setup({ fetchText: () => response('', 302, base) });
  assert.equal(await loop.resolve(loop.input), base);
  assert.equal(loop.calls.length, 3);
});

test('one total deadline, no credential headers, and short deduplicated cache bound provider calls', async () => {
  let clock = 0;
  const { resolve, input, calls } = await setup({ now: () => clock,
    fetchText: (url) => { clock += 100; return response(url === base ? master : media); } });
  assert.deepEqual(await Promise.all([resolve(input), resolve(input)]), [selected, selected]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call.options.timeoutMs), [4000, 3900]);
  clock = 16000;
  assert.equal(await resolve(input), selected);
  assert.equal(calls.length, 4);
  clock = 0;
  const timeout = await setup({ now: () => clock, fetchText: () => { clock = 4001; return response(master); } });
  assert.equal(await timeout.resolve(timeout.input), base);
  assert.equal(timeout.calls.length, 1);
});

test('provider errors, oversize responses, hidden redirects and unavailable or altered public assets preserve original input', async () => {
  for (const fail of [() => { throw new Error('secret URL must not escape'); }, () => response('', 403),
    () => response('a'.repeat(65537)), () => ({ value: master, response: { ok: true, status: 200, url: 'https://unexpected.example/' } })]) {
    const { resolve, input } = await setup({ fetchText: fail });
    assert.equal(await resolve(input), base);
  }
  for (const changedAsset of [response('', 404), response(media + '\n'), response(master),
    response('', 302, 'https://norva.tv/catalog/another.m3u8')]) {
    const { resolve, input } = await setup({ fetchText: url => url === base ? response(master) : changedAsset });
    assert.equal(await resolve(input), base);
  }
});

test('actual Edge resolver passes only the owned row and session context; all other resolution calls skip quality routing', async () => {
  const edge = fs.readFileSync(path.join(__dirname, '../supabase/functions/norva-playback/index.ts'), 'utf8').replace(/\r\n/g, '\n');
  const start = edge.indexOf('async function resolvePlaybackTarget('), end = edge.indexOf('\n// Series have no directly-playable stream id', start);
  const { input } = await setup();
  let owned = input.ownedItem;
  const routed = [];
  const context = vm.createContext({ resolveSelectionLiveDelivery: async () => null,
    resolveSelectionLiveRendition: async value => { routed.push(value); return value.ownedItem ? selected : value.targetUrl; },
    resolveDiscoveryTarget: async ({ targetUrl }) => targetUrl, resolveObservedVodContainer: async () => null,
    mediaReadFromCatalog: () => true, resolveSourceHost: async () => 'public.example', recordOrEmpty: value => value || {},
    firstUsefulCodecProfile: () => ({}), normalizeMkvH264FastStartProof: () => null,
    hasReliableVodCodecProfile: () => false, hasUsefulCodecProfile: () => false,
    mergePlaybackHints: (a, b) => ({ ...a, ...b }), compactRecord: value => value,
    stringOrNull: value => typeof value === 'string' && value ? value : null, HttpError: class extends Error {} });
  vm.runInContext(stripTypeScriptTypes(edge.slice(start, end), { mode: 'strip' }), context);
  const db = { from(table) { return { select() { return this; }, eq() { return this; },
    async maybeSingle() { return { data: table === 'catalog_media_items' ? input.ownedItem : owned }; } }; } };
  const args = [input.sourceId, 'live', input.itemId, input.userId, db, { forged: 'request' }];
  assert.equal((await context.resolvePlaybackTarget(...args)).targetUrl, base);
  assert.equal(routed.length, 0);
  assert.equal((await context.resolvePlaybackTarget(...args, input.request)).targetUrl, selected);
  assert.equal(routed[0].ownedItem, owned);
  assert.equal(routed[0].request, input.request);
  owned = null;
  assert.equal((await context.resolvePlaybackTarget(...args, input.request)).targetUrl, base);
  const create = edge.slice(edge.indexOf('async function createPlaybackSessionCore('), edge.indexOf('\nasync function createPlaybackSession('));
  assert.match(create, /clientMode: choosePlaybackMode\(requestedMode, body\),\s*body,\s*clientMetadata,/);
  assert.ok(create.indexOf('await assertOwnedSource(') < create.indexOf('await resolvePlaybackTarget('));
  assert.ok(create.indexOf('await resolvePlaybackTarget(') < create.indexOf('await assertActiveCatalogGenerationCurrent('));
});
