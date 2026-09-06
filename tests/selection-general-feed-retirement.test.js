const test = require('node:test');
const assert = require('node:assert/strict');
const canonical = 'https://norva.tv/catalog/discovery.m3u';
const modulePath = '../supabase/functions/_shared/discovery-sources.mjs';

test('retiring the general feed preserves Movies and other TV/VOD sources without fetching the retired playlist', async () => {
  const { DISCOVERY_REVIEW_SOURCES, fetchDiscoveryCandidates, discoveryCatalogFields } = await import(modulePath);
  assert.ok(!DISCOVERY_REVIEW_SOURCES.some(feed => feed.id === 'iptv-org'));
  assert.equal(DISCOVERY_REVIEW_SOURCES.find(feed => feed.id === 'iptv-org-movies').kind, 'live');
  const feeds = [
    { id: 'iptv-org', name: 'IPTV-org', kind: 'live', url: 'general' },
    ...['iptv-org-movies', 'free-tv', 'publicdomain'].map(id => DISCOVERY_REVIEW_SOURCES.find(feed => feed.id === id)),
  ];
  const called = [];
  const playlist = await fetchDiscoveryCandidates({ feeds, fetchPlaylist: async url => {
    called.push(url);
    return { response: { ok: true }, headerDetected: true, bytesRead: 100, items: [
      { title: 'Programme', url: 'https://media.example/' + called.length, group: 'Movies' },
    ] };
  } });
  assert.ok(!called.includes('general'));
  assert.deepEqual(playlist.sources.map(feed => feed.id), ['iptv-org-movies', 'free-tv', 'publicdomain']);
  const rows = playlist.items.map(item => discoveryCatalogFields(canonical, item));
  assert.equal(rows.filter(row => row.item_type === 'movie').length, 6);
  assert.equal(rows.filter(row => row.item_type === 'live').length, 2);
  assert.equal(feeds.length, 4, 'caller feed array remains unchanged');
});

test('legacy cinema rows survive retirement despite having been deduplicated into the general feed', async () => {
  const { isRetiredGeneralDiscoveryItem: retired } = await import(modulePath);
  for (const group of ['IPTV-org · Movies', 'IPTV-org · Movies;Series', 'IPTV-org · Family;Movies;General']) {
    assert.equal(retired({ discoveryFeed: 'iptv-org', group }), false);
  }
  for (const group of ['IPTV-org · General', 'IPTV-org · Undefined', 'IPTV-org · NotMovies', 'Other · Movies', '']) {
    assert.equal(retired({ discoveryFeed: 'iptv-org', group, title: 'Movies' }), true);
  }
  assert.equal(retired({ discoveryFeed: 'iptv-org-movies', group: 'IPTV-org Movies · Movies' }), false);
  assert.equal(retired({ discoveryFeed: 'free-tv' }), false);
  assert.equal(retired(undefined), false);
});

test('stale general links are refused only in the owned Selection; cinema and personal playlists still resolve', async () => {
  const { resolveDiscoveryCandidateTarget } = await import(modulePath);
  const { discoverySourceId } = await import('../supabase/functions/_shared/discovery-catalog.mjs');
  const options = { userId: 'retirement-owner', sourceId: await discoverySourceId('retirement-owner'),
    targetUrl: 'https://media.example/channel.m3u8',
    metadata: { discoveryFeed: 'iptv-org', group: 'IPTV-org · General' },
    fetchPlaylist: async () => { throw Error('Unexpected network request'); },
  };
  await assert.rejects(resolveDiscoveryCandidateTarget(options), /unavailable/);
  assert.equal(await resolveDiscoveryCandidateTarget({ ...options, sourceId: 'personal-source' }), options.targetUrl);
  assert.equal(await resolveDiscoveryCandidateTarget({ ...options, userId: 'different-owner' }), options.targetUrl);
  assert.equal(await resolveDiscoveryCandidateTarget({ ...options, metadata: { ...options.metadata, group: 'IPTV-org · Movies;Series' } }), options.targetUrl);
  assert.equal(await resolveDiscoveryCandidateTarget({ ...options, metadata: { discoveryFeed: 'iptv-org-movies' } }), options.targetUrl);
});
