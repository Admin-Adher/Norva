const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

test('qualified server snapshots import beyond playback samples while preserving exact-file exclusions', async () => {
  const { SELECTION_TESTED_VOD, SELECTION_TESTED_VOD_HOLDS, testedSelectionVodUrlAllowed } = await import('../supabase/functions/_shared/selection-tested-vod.mjs');
  const { fetchSelectionVod } = await import('../supabase/functions/_shared/selection-vod.mjs');
  const { SELECTION_QUALIFIED_VOD } = await import('../supabase/functions/_shared/selection-qualified-vod.mjs');
  const { items, sources } = await fetchSelectionVod({ fetchPlaylist: async () => { throw Error('upstream unavailable'); } });
  const rows = items.map(entry => entry.fields);
  assert.equal(SELECTION_TESTED_VOD.length, 14);
  assert.equal(rows.filter(row => row.item_type === 'movie').length, 2104);
  assert.equal(rows.filter(row => row.item_type === 'episode').length, 225);
  assert.equal(rows.filter(row => row.item_type === 'series').length, 7);
  assert.equal(new Set(rows.map(row => row.external_id)).size, rows.length);
  assert.equal(sources.filter(source => source.status === 'loaded').reduce((n, source) => n + source.included, 0), 2329);
  for (const file of SELECTION_TESTED_VOD) {
    assert.equal(createHash('sha256').update(file.url).digest('hex'), file.validation.urlSha256);
    assert.ok(file.validation.continuousSeconds >= 120);
    assert.equal(file.validation.seeksPassed, 2);
  }
  for (const file of SELECTION_QUALIFIED_VOD) {
    assert.equal(createHash('sha256').update(file.url).digest('hex'), file.validation.urlSha256);
    assert.equal(file.validation.method, 'server-sampling-and-file-access');
    assert.equal(file.validation.continuousSeconds, undefined, 'sampling must not claim every file was played');
    assert.ok([200, 206].includes(file.validation.fileHttpStatus));
    assert.ok(['mp4', 'mkv'].includes(file.containerExtension));
  }
  assert.ok(!rows.some(row => /pixeldrain/.test(row.playback_hint?.targetUrl || '')));
  const episodes = rows.filter(row => row.item_type === 'episode');
  const expectedSeasons = {
    'Suits': { 2: 16, 3: 16, 4: 16, 5: 16, 6: 16 },
    'Peaky Blinders': { 1: 6, 2: 6, 3: 6, 4: 6, 5: 6, 6: 6 },
    'Prison Break': { 1: 22, 2: 22, 3: 13 },
    'Game of Thrones': { 1: 10, 2: 10 },
    'Spartacus': { 1: 13, 2: 10 },
    'Jesus of Nazareth': { 1: 4 },
    'Trump An American Dream': { 1: 4 },
  };
  for (const [title, seasons] of Object.entries(expectedSeasons)) {
    for (const [season, count] of Object.entries(seasons)) {
      const group = episodes.filter(row => row.metadata.selectionUnit.baseTitle === title && row.metadata.selectionUnit.seasons[0] === Number(season));
      assert.deepEqual(group.map(row => row.metadata.selectionUnit.episode).sort((a, b) => a - b), Array.from({ length: count }, (_, i) => i + 1), `${title} S${season}`);
      assert.equal(new Set(group.map(row => row.playback_hint.targetUrl)).size, count, 'one distinct file per episode');
    }
  }
  assert.ok(!episodes.some(row => row.metadata.selectionUnit.baseTitle === 'Suits' && row.metadata.selectionUnit.seasons[0] === 1));
  assert.ok(!episodes.some(row => row.metadata.selectionUnit.baseTitle === 'Spartacus' && row.metadata.selectionUnit.seasons[0] === 3));
  assert.ok(!episodes.some(row => /Chernobyl/i.test(row.title)));
  assert.ok(!rows.some(row => /COBRA KAI T5 SERIE|\(CAM\)/i.test(row.title)));
  assert.ok(rows.some(row => row.item_type === 'movie' && row.title === 'Chernobyl O Filme'));
  for (const row of episodes) {
    assert.equal(rows.find(parent => parent.external_id === row.parent_external_id)?.item_type, 'series');
    assert.equal(row.playback_hint.container, 'mp4');
  }
  const held = SELECTION_TESTED_VOD.filter(file => SELECTION_TESTED_VOD_HOLDS[file.tvgId]);
  assert.equal(held.length, 1);
  for (const file of held) {
    assert.equal(testedSelectionVodUrlAllowed(file.feedId, file.url), false);
    assert.ok(!rows.some(row => row.playback_hint?.targetUrl === file.url));
  }
  assert.equal(SELECTION_TESTED_VOD.find(file => file.title === 'Nobody (2021)').containerExtension, 'mkv');
  assert.equal(rows.find(row => row.title === 'The Karate Kid (1984)').playback_hint.container, 'mkv');
  assert.deepEqual(rows.find(row => row.title === 'Aquaman (2018)').metadata.audioLanguages, ['pt']);
  assert.equal(rows.find(row => row.title === 'Black Widow (2021)').metadata.codecProfile.audioTracks[0].language, 'pt');
  assert.equal(rows.find(row => row.title === 'Black Panther: Wakanda Forever (2022)').metadata.audioLanguages, undefined);
});

test('tested media remain exact URL pins with owned resolution and never use the HLS-only relay', async () => {
  const vod = await import('../supabase/functions/_shared/selection-vod.mjs');
  const { resolveDiscoveryTarget } = await import('../supabase/functions/_shared/discovery-sources.mjs');
  const { discoverySourceId } = await import('../supabase/functions/_shared/discovery-catalog.mjs');
  const { items } = await vod.fetchSelectionVod({ fetchPlaylist: async () => { throw Error('unavailable'); } });
  const neverFetch = () => { throw Error('a static pin must not fetch its repository'); };
  for (const { fields: row } of items.filter(entry => entry.fields.item_type !== 'series')) {
    const input = { userId: 'owner', sourceId: await discoverySourceId('owner'), itemId: row.external_id,
      metadata: row.metadata, targetUrl: row.playback_hint.targetUrl, fetchPlaylist: neverFetch };
    assert.equal(await resolveDiscoveryTarget(input), input.targetUrl);
    for (const targetUrl of [input.targetUrl + '?unreviewed=1', input.targetUrl.replace('https:', 'http:'), 'https://127.0.0.1/private']) {
      await assert.rejects(resolveDiscoveryTarget({ ...input, targetUrl }), /temporarily unavailable/);
    }
    await assert.rejects(resolveDiscoveryTarget({ ...input, metadata: { ...row.metadata, selectionVodId: 'forged' } }));
    const itemType = row.item_type === 'episode' ? 'series' : 'movie';
    const delivery = await vod.resolveSelectionVodDelivery({ ...input, expectedSourceId: input.sourceId, itemType, ownedItem: row });
    assert.ok(delivery);
    assert.equal(vod.shouldUseSelectionVodRelay({ delivery, targetUrl: input.targetUrl, itemType, clientMode: 'direct', body: {} }), false);
  }
});
