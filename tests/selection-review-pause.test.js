const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('withdrawn Selection publishes no active provider or bundled media', async () => {
  const { DISCOVERY_SELECTION_ENABLED, discoveryPlaylist } = await import('../supabase/functions/_shared/discovery-catalog.mjs');
  const { DISCOVERY_SOURCES } = await import('../supabase/functions/_shared/discovery-sources.mjs');
  assert.equal(DISCOVERY_SELECTION_ENABLED, false);
  assert.deepEqual(DISCOVERY_SOURCES, []);
  const publicRegistry = JSON.parse(fs.readFileSync('public/catalog/sources.json', 'utf8'));
  assert.equal(publicRegistry.status, 'under_review');
  assert.deepEqual(publicRegistry.sources, []);
  assert.equal(discoveryPlaylist(), '#EXTM3U\n');
  for (const file of ['discovery.m3u', 'xumo-live.m3u']) {
    assert.equal(fs.readFileSync('public/catalog/' + file, 'utf8').replace(/\r\n/g, '\n'), '#EXTM3U\n');
  }
  assert.doesNotMatch(fs.readFileSync('public/js/pages/HomePage.js', 'utf8'), /<button[^>]+id="home-discovery-start"/);
});

test('a stale automatic import cannot fetch or publish any withdrawn feed', async () => {
  const { fetchDiscoverySelection } = await import('../supabase/functions/_shared/discovery-sources.mjs');
  let fetches = 0;
  await assert.rejects(fetchDiscoverySelection({
    feeds: [{ id: 'custom', kind: 'movie', url: 'https://media.example/list.m3u' }],
    fetchPlaylist: async () => { fetches++; throw Error('must not fetch'); },
  }), /Selection is temporarily unavailable/);
  assert.equal(fetches, 0);
});

test('all owned Selection playback is withdrawn, including cinema, VOD and stale entries without feed metadata', async () => {
  const { discoverySourceId } = await import('../supabase/functions/_shared/discovery-catalog.mjs');
  const { resolveDiscoveryTarget } = await import('../supabase/functions/_shared/discovery-sources.mjs');
  const userId = 'selection-review-owner';
  const sourceId = await discoverySourceId(userId);
  const targetUrl = 'https://media.example/programme.m3u8';
  let fetches = 0;
  for (const metadata of [undefined, {}, { discoveryId: 'sintel' }, { discoveryFeed: 'iptv-org-movies' }, { discoveryFeed: 'pluto-vod-fr' }, { discoveryFeed: 'xumo-curated' }]) {
    const options = { userId, sourceId, metadata, targetUrl, fetchPlaylist: async () => { fetches++; } };
    await assert.rejects(resolveDiscoveryTarget(options), /Selection is temporarily unavailable/);
    assert.equal(await resolveDiscoveryTarget({ ...options, sourceId: 'personal-source' }), targetUrl);
    assert.equal(await resolveDiscoveryTarget({ ...options, userId: 'another-owner' }), targetUrl);
  }
  assert.equal(fetches, 0);
});
