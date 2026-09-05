const test = require('node:test');
const assert = require('node:assert/strict');
const modulePath = '../supabase/functions/_shared/discovery-sources.mjs';
const canonical = 'https://norva.tv/catalog/discovery.m3u';
const result = items => ({ response: { ok: true }, headerDetected: true, items, bytesRead: 100, truncated: false });
const entry = (url, title = 'Programme') => ({ url, title, tvgId: 'same-id', logo: '', group: 'Cinema' });

test('M3U titles preserve commas and never include the tail of quoted names or artwork URLs', async () => {
  const { readM3uPlaylistStream } = await import('../supabase/functions/_shared/m3u-playlist-stream.mjs');
  const data = '#EXTM3U\n#EXTINF:-1 tvg-name="10,000 Days",10,000 Days\nhttps://media.example/1\n'
    + '#EXTINF:-1 tvg-logo="https://art.example/4,380,562.jpg",Nosferatu\nhttps://media.example/2\n';
  const playlist = await readM3uPlaylistStream(new Response(data).body);
  assert.deepEqual(playlist.items.map(item => item.title), ['10,000 Days', 'Nosferatu']);
  assert.equal(playlist.items[1].logo, 'https://art.example/4,380,562.jpg');
});

test('selection imports VOD and live in separate sections, deduplicating shared URLs without colliding tvg-ids', async () => {
  const { fetchDiscoverySelection, discoveryCatalogFields } = await import(modulePath);
  const feeds = [
    { id: 'vod', name: 'VOD', kind: 'movie', url: 'vod' },
    { id: 'tv', name: 'TV', kind: 'live', url: 'tv' },
    { id: 'tv-other', name: 'Other', kind: 'live', url: 'other' },
  ];
  const playlist = await fetchDiscoverySelection({ feeds, fetchPlaylist: async url => result(url === 'vod'
    ? [entry('https://media.example/film.mp4')]
    : url === 'tv' ? [entry('https://tv.example/1.m3u8'), entry('https://tv.example/2.m3u8')]
      : [entry('https://tv.example/1.m3u8')]) });
  const rows = playlist.items.map(item => discoveryCatalogFields(canonical, item));
  assert.equal(rows.filter(row => row.item_type === 'movie').length, 6);
  assert.equal(rows.filter(row => row.item_type === 'live').length, 2);
  assert.equal(new Set(rows.map(row => row.external_id)).size, 8);
  assert.equal(playlist.sources[2].duplicates, 1);
  assert.deepEqual(discoveryCatalogFields('https://user.example/playlist.m3u', playlist.items[5]), {});
  assert.throws(() => discoveryCatalogFields(canonical, { url: 'https://fake.example/film.mp4', discoveryFeed: 'vod' }));
});

test('regional Pluto copies and rotating JWTs keep one stable programme identity', async () => {
  const { fetchDiscoverySelection, discoveryCatalogFields } = await import(modulePath);
  const url = 'https://stitch.pluto.tv/v2/stitch/hls/episode/6389ff50753d2100141e055d/master.m3u8';
  const feeds = ['fr', 'us'].map(region => ({ id: `pluto-vod-${region}`, kind: 'movie', name: region, url: region }));
  const load = token => fetchDiscoverySelection({ feeds, fetchPlaylist: async () => result([entry(`${url}?jwt=${token}`)]) });
  const a = await load('first'), b = await load('next');
  assert.equal(a.items.length, 6);
  assert.equal(a.sources[1].duplicates, 1);
  assert.equal(discoveryCatalogFields(canonical, a.items[5]).external_id, discoveryCatalogFields(canonical, b.items[5]).external_id);
  assert.equal(discoveryCatalogFields(canonical, a.items[5]).metadata.container, 'm3u8');
});

test('the curated Xumo feed imports only its two reviewed channels as live TV and retains provider parameters', async () => {
  const { readFileSync } = require('node:fs');
  const { DISCOVERY_SOURCES, fetchDiscoverySelection, discoveryCatalogFields } = await import(modulePath);
  const { readM3uPlaylistStream } = await import('../supabase/functions/_shared/m3u-playlist-stream.mjs');
  const feed = DISCOVERY_SOURCES.find(source => source.id === 'xumo-curated');
  assert.ok(feed);
  const text = readFileSync('public/catalog/xumo-live.m3u', 'utf8');
  const urls = text.split(/\r?\n/).filter(line => line.startsWith('https://'));
  const parsed = await readM3uPlaylistStream(new Response(text).body);
  const selection = await fetchDiscoverySelection({ feeds: [feed], fetchPlaylist: async url => {
    assert.equal(url, 'https://norva.tv/catalog/xumo-live.m3u');
    return { ...parsed, response: { ok: true } };
  } });
  const channels = selection.items.map(item => discoveryCatalogFields(canonical, item))
    .filter(row => row.metadata.discoveryFeed === feed.id);
  assert.deepEqual(channels.map(row => [row.metadata.tvgId, row.title, row.item_type]), [
    ['99951251', 'MovieSphere by Lionsgate', 'live'],
    ['99991638', 'DOCUMENTARY+', 'live'],
  ]);
  assert.deepEqual(channels.map(row => row.playback_hint.targetUrl), urls);
  for (const row of channels) {
    assert.equal(row.metadata.discoverySource, 'https://play.xumo.com/');
    assert.equal(row.metadata.container, 'm3u8');
    assert.ok(row.playback_hint.targetUrl.includes('ads.xumo_platform=[PLATFORM]'));
    assert.ok(row.playback_hint.targetUrl.includes('ads._fw_did=[IFA]'));
  }
  assert.equal(selection.sources[0].included, 2);
});

test('a failing playlist is visible in the report and cannot prevent other feeds importing', async () => {
  const { fetchDiscoverySelection } = await import(modulePath);
  let active = 0, peak = 0;
  const feeds = Array.from({ length: 9 }, (_, i) => ({ id: `test-${i}`, name: 'Test', kind: 'live', url: String(i) }));
  const playlist = await fetchDiscoverySelection({ feeds, fetchPlaylist: async url => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve)); active--;
    if (url === '2') throw new Error('network details must not escape');
    return result([entry(`https://tv.example/${url}.m3u8`)]);
  } });
  assert.equal(peak, 4);
  assert.equal(playlist.items.length, 13);
  assert.equal(playlist.sources[2].status, 'unavailable');
  assert.ok(!JSON.stringify(playlist.sources).includes('network details'));
});

test('credential-bearing and private links are rejected; Pluto identity is restricted to its media host', async () => {
  const { discoveryMediaKey } = await import(modulePath);
  for (const url of ['http://localhost/file', 'http://127.0.0.1/file', 'https://user:pass@example.com/live', 'https://example.com/get.php?username=leaked&password=secret']) {
    assert.equal(discoveryMediaKey({ id: 'tv' }, url), null);
  }
  assert.equal(discoveryMediaKey({ id: 'pluto-vod-fr' }, 'https://evil.example/v2/stitch/hls/episode/6389ff50753d2100141e055d/master.m3u8'), null);
});

test('Samsung is removed from Selection and its delivery URLs cannot return through aggregate feeds', async () => {
  const { DISCOVERY_SOURCES, discoveryMediaKey, isSamsungTvPlusUrl } = await import(modulePath);
  assert.ok(!DISCOVERY_SOURCES.some(feed => feed.id === 'samsungtvplus'));
  const samsungUrls = [
    'https://jmp2.uk/stvp-FRAJ4000015CZ.m3u8',
    'https://jmp2.uk/stvp-FRAJ4000015CZ',
    'http://JMP2.UK/stvp-FRAJ4000015CZ?device=browser',
    'https://samsung.wurl.tv/playlist.m3u8',
    'https://travelxp-4k.samsung.wurl.tv/playlist.m3u8',
    'https://amg00106-france24-france24-samsunguk-qvpp8.amagi.tv/playlist.m3u8',
    'https://delivery.amagi.tv/linear/samsung-fr/channel/master.m3u8',
    'https://delivery.amagi.tv/linear/samsungus/channel/master.m3u8',
  ];
  for (const url of samsungUrls) {
    assert.equal(isSamsungTvPlusUrl(url), true, url);
    for (const id of ['iptv-org', 'iptv-org-movies', 'free-tv']) {
      assert.equal(discoveryMediaKey({ id }, url), null, `${id}: ${url}`);
    }
  }
  assert.equal(discoveryMediaKey({ id: 'samsungtvplus' }, 'https://other-cdn.example/channel.m3u8'), null);
});

test('Samsung exclusion uses provider boundaries and preserves alternate providers and personal playlists', async () => {
  const { fetchDiscoverySelection, discoveryCatalogFields, isSamsungTvPlusUrl } = await import(modulePath);
  const { readM3uPlaylistStream } = await import('../supabase/functions/_shared/m3u-playlist-stream.mjs');
  const retained = [
    'https://jmp2.uk/rok-example',
    'https://jmp2.uk/plu-example',
    'https://jmp2.uk/channel?source=stvp-samsung',
    'https://jmp2.uk.evil.example/stvp-example',
    'https://samsung.wurl.tv.evil.example/playlist.m3u8',
    'https://notsamsung.wurl.tv/playlist.m3u8',
    'https://france24-vidaa.amagi.tv/playlist.m3u8',
    'https://france24-roku.amagi.tv/playlist.m3u8?samsung=1',
    'https://notsamsung.amagi.tv/playlist.m3u8',
    'https://samsunguk.amagi.tv.evil.example/playlist.m3u8',
    'https://media.example/samsung/channel.m3u8',
  ];
  for (const url of retained) assert.equal(isSamsungTvPlusUrl(url), false, url);
  assert.equal(isSamsungTvPlusUrl('not a URL'), false);
  const excluded = 'https://jmp2.uk/stvp-FRAJ4000015CZ';
  const playlist = await fetchDiscoverySelection({
    feeds: [{ id: 'free-tv', kind: 'live', name: 'Free-TV', url: 'aggregate' }],
    fetchPlaylist: async () => result([entry(excluded, 'France 24'), ...retained.map(url => entry(url, 'France 24'))]),
  });
  const live = playlist.items.filter(item => discoveryCatalogFields(canonical, item).item_type === 'live');
  assert.deepEqual(live.map(item => item.url), retained);
  assert.equal(playlist.sources[0].rejected, 1);
  assert.equal(playlist.sources[0].included, retained.length);

  const personal = await readM3uPlaylistStream(new Response(`#EXTM3U\n#EXTINF:-1,France 24\n${excluded}\n`).body);
  assert.equal(personal.items[0].url, excluded);
  assert.deepEqual(discoveryCatalogFields('https://user.example/playlist.m3u', personal.items[0]), {});
});

test('expiring playback URLs refresh only for the owned selection and exact persisted media identity', async () => {
  const { resolveDiscoveryTarget, discoveryMediaKey } = await import(modulePath);
  const { discoverySourceId } = await import('../supabase/functions/_shared/discovery-catalog.mjs');
  const targetUrl = 'https://stitch.pluto.tv/v2/stitch/hls/episode/6389ff50753d2100141e055d/master.m3u8?jwt=old';
  const renewed = targetUrl.replace('old', 'new');
  const metadata = { discoveryFeed: 'pluto-vod-fr', discoveryMediaKey: discoveryMediaKey({ id: 'pluto-vod-fr' }, targetUrl) };
  let calls = 0;
  const options = { userId: 'owner', sourceId: await discoverySourceId('owner'), targetUrl, metadata, fetchPlaylist: async () => { calls++; return result([entry(renewed)]); }, now: 1000 };
  assert.equal(await resolveDiscoveryTarget({ ...options, sourceId: 'unrelated' }), targetUrl);
  assert.equal(calls, 0);
  assert.equal(await resolveDiscoveryTarget(options), renewed);
  assert.equal(await resolveDiscoveryTarget({ ...options, now: 1001 }), renewed);
  assert.equal(calls, 1);
  await assert.rejects(resolveDiscoveryTarget({ ...options, metadata: { ...metadata, discoveryMediaKey: 'forged' } }), /identity/);
  await assert.rejects(resolveDiscoveryTarget({ ...options, now: 100000, fetchPlaylist: async () => result([entry('https://other.example/file')]) }), /no longer/);
});
