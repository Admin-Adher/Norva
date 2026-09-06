const test = require('node:test');
const assert = require('node:assert/strict');
const movie = (title = 'A film', url = 'https://movierulz.babuperumana.workers.dev/proxy?url=https%3A%2F%2Fhls2.vcdnx.com%2Fhls%2FABCDEFGH1234%2Fmanifest&ext=.mp4') => ({
  title, tvgId: title, group: 'Movies / Tamil / 2026', logo: '', url,
});
const dm = token => `https://vod3.cf.dmcdn.net/sec2(${token})/video/123/movie.m3u8`;
const playlist = items => ({ items, response: { ok: true }, headerDetected: true, truncated: false, bytesRead: 100 });

test('Selection imports both approved movie feeds, pins nested hosts, retains SD and preserves Live', async () => {
  const { fetchDiscoverySelection, discoveryCatalogFields } = await import('../supabase/functions/_shared/discovery-sources.mjs');
  const { DISCOVERY_PLAYLIST_URL } = await import('../supabase/functions/_shared/discovery-catalog.mjs');
  const seen = [];
  const data = await fetchDiscoverySelection({ feeds: [{ id: 'untrusted', url: 'https://attacker.test' }], fetchPlaylist: async url => {
    seen.push(url);
    return playlist(url.includes('Babuperumana') ? [movie(), movie(), movie('private', movie().url.replace('hls2.vcdnx.com', '127.0.0.1')),
      movie('youtube', movie().url.replace('hls2.vcdnx.com', 'www.youtube.com'))] : [movie('SD film', dm('current-token') + '#player-fragment')]);
  } });
  assert.equal(seen.length, 2);
  assert.ok(seen.every(url => !url.includes('attacker')));
  const rows = data.items.map(item => discoveryCatalogFields(DISCOVERY_PLAYLIST_URL, item));
  assert.equal(rows.filter(row => row.item_type === 'live').length, 14);
  assert.equal(rows.filter(row => row.item_type === 'movie').length, 2);
  assert.ok(rows.filter(row => row.item_type === 'movie').every(row => row.playback_hint.container === 'm3u8'));
  assert.equal(data.sources.find(source => source.id === 'babuperumana-vod').rejected, 2);
  assert.equal(data.sources.find(source => source.id === 'babuperumana-vod').duplicates, 1);
  assert.equal(rows.find(row => row.title === 'SD film').playback_hint.targetUrl, dm('current-token'));
});

test('one failed movie feed cannot block the other movies or reviewed Live channels', async () => {
  const { fetchDiscoverySelection, discoveryCatalogFields } = await import('../supabase/functions/_shared/discovery-sources.mjs');
  const { DISCOVERY_PLAYLIST_URL } = await import('../supabase/functions/_shared/discovery-catalog.mjs');
  const data = await fetchDiscoverySelection({ fetchPlaylist: async url => {
    if (url.includes('Babuperumana')) throw Error('private diagnostic');
    return playlist([movie('Film', dm('token'))]);
  } });
  assert.equal(data.items.length, 15);
  assert.equal(discoveryCatalogFields(DISCOVERY_PLAYLIST_URL, data.items.at(-1)).item_type, 'movie');
  assert.equal(data.sources.find(source => source.id === 'babuperumana-vod').status, 'unavailable');
  assert.ok(!JSON.stringify(data.sources).includes('private diagnostic'));
});

test('expiring media links refresh by owned stable identity; stale, forged, retired and missing titles fail closed', async () => {
  const { fetchSelectionVod, resolveSelectionVodTarget } = await import('../supabase/functions/_shared/selection-vod.mjs');
  const { resolveDiscoveryTarget } = await import('../supabase/functions/_shared/discovery-sources.mjs');
  const { discoverySourceId, retiredDiscoverySourceId } = await import('../supabase/functions/_shared/discovery-catalog.mjs');
  let token = 'first', reads = 0, missing = false;
  const fetchPlaylist = async url => {
    reads++;
    return playlist(url.includes('Babuperumana') ? [movie()] : [movie(missing ? 'Different film' : 'SD film', dm(token))]);
  };
  const row = (await fetchSelectionVod({ fetchPlaylist })).items.find(entry => entry.fields.title === 'SD film').fields;
  const input = { sourceId: await discoverySourceId('owner'), userId: 'owner', itemId: row.external_id,
    metadata: row.metadata, targetUrl: row.playback_hint.targetUrl, fetchPlaylist, now: 1 };
  token = 'second';
  assert.equal(await resolveDiscoveryTarget(input), dm('second'));
  const afterFirst = reads;
  await resolveDiscoveryTarget({ ...input, now: 2 });
  assert.equal(reads, afterFirst);
  token = 'third';
  assert.equal(await resolveSelectionVodTarget({ ...input, now: 60_002 }), dm('third'));
  for (const changes of [{ itemId: 'fake' }, { metadata: { ...row.metadata, selectionVodTitle: 'forged' } },
    { metadata: { ...row.metadata, discoverySource: 'https://attacker.test' } }, { targetUrl: 'http://127.0.0.1' },
    { sourceId: await retiredDiscoverySourceId('owner') }]) {
    await assert.rejects(resolveDiscoveryTarget({ ...input, ...changes }), /temporarily unavailable/);
  }
  assert.equal(await resolveDiscoveryTarget({ ...input, sourceId: 'personal' }), input.targetUrl);
  missing = true;
  await assert.rejects(resolveSelectionVodTarget({ ...input, now: 120_003 }), /temporarily unavailable/);
});

test('only an owned VOD descriptor grants automatic relay; explicit conversion and personal media retain their routes', async () => {
  const { fetchSelectionVod, resolveSelectionVodDelivery, shouldUseSelectionVodRelay } = await import('../supabase/functions/_shared/selection-vod.mjs');
  const row = (await fetchSelectionVod({ fetchPlaylist: async url => playlist([url.includes('Babuperumana') ? movie() : movie('SD', dm('token'))]) })).items[0].fields;
  const args = { sourceId: 'owned', expectedSourceId: 'owned', itemType: 'movie', itemId: row.external_id,
    ownedItem: row, targetUrl: row.playback_hint.targetUrl };
  const delivery = await resolveSelectionVodDelivery(args);
  const decision = { delivery, targetUrl: args.targetUrl, itemType: 'movie', clientMode: 'transcode', body: { gatewayAutoMode: true } };
  assert.equal(shouldUseSelectionVodRelay(decision), true);
  assert.equal(shouldUseSelectionVodRelay({ ...decision, delivery: { ...delivery } }), false);
  assert.equal(shouldUseSelectionVodRelay({ ...decision, body: { gatewayAutoMode: false } }), false);
  assert.equal(shouldUseSelectionVodRelay({ ...decision, body: { gatewayAutoMode: true, forceVideoTranscode: true } }), false);
  assert.equal(shouldUseSelectionVodRelay({ ...decision, body: { enginePipe: true } }), false);
  for (const changes of [{ sourceId: 'personal' }, { itemType: 'live' }, { itemId: 'spoof' }, { ownedItem: null }, { targetUrl: 'https://attacker.test' }]) {
    assert.equal(await resolveSelectionVodDelivery({ ...args, ...changes }), null);
  }
});
