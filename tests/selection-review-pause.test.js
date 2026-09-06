const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');

test('withdrawn Selection cannot trap onboarding behind an unusable Enable action; personal source names do not affect filtering', async () => {
  const { discoverySourceId, DISCOVERY_SELECTION_ENABLED } = await import('../supabase/functions/_shared/discovery-catalog.mjs');
  const userId = 'review-source-list-owner';
  const archived = { id: await discoverySourceId(userId), name: 'Renamed selection', enabled: false };
  const personal = { id: 'personal-source', name: 'Norva Selection', enabled: false };
  const code = fs.readFileSync('supabase/functions/norva-cloud/index.ts','utf8');
  const from = code.indexOf('async function listSources(');
  const to = code.indexOf('async function listVisibleSources(',from);
  const context = vm.createContext({ DISCOVERY_SELECTION_ENABLED, discoverySourceId,
    SOURCE_MANAGEMENT_PUBLIC_SELECT: 'id', sanitizeSource: row => row,
    throwDb: () => { throw Error('Unexpected database error'); } });
  vm.runInContext(stripTypeScriptTypes(code.slice(from,to),{mode:'strip'}),context);
  let rows = [archived,personal];
  const db = { from: () => ({ select() { return this; }, eq() { return this; }, is() { return this; },
    order: async () => ({ data:rows, error:null }) }) };
  const result = await context.listSources(userId,db);
  assert.equal(result.sources.length,1);
  assert.equal(result.sources[0],personal);
  rows = [archived];
  assert.equal((await context.listSources(userId,db)).sources.length,0);
});

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
