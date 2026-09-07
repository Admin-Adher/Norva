const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

test('only catalogue-validated files import, even when remote catalogues are unavailable', async () => {
  const { SELECTION_TESTED_VOD, SELECTION_TESTED_VOD_HOLDS, testedSelectionVodUrlAllowed } = await import('../supabase/functions/_shared/selection-tested-vod.mjs');
  const { fetchSelectionVod } = await import('../supabase/functions/_shared/selection-vod.mjs');
  const { items, sources } = await fetchSelectionVod({ fetchPlaylist: async () => { throw Error('upstream unavailable'); } });
  const rows = items.map(entry => entry.fields);
  assert.equal(SELECTION_TESTED_VOD.length, 14);
  assert.equal(rows.filter(row => row.item_type === 'movie').length, 10);
  assert.equal(rows.filter(row => row.item_type === 'episode').length, 3);
  assert.equal(rows.filter(row => row.item_type === 'series').length, 3);
  assert.equal(new Set(rows.map(row => row.external_id)).size, 16);
  assert.deepEqual(sources.filter(source => source.status === 'loaded').map(source => source.included), [5, 4, 4]);
  for (const file of SELECTION_TESTED_VOD) {
    assert.equal(createHash('sha256').update(file.url).digest('hex'), file.validation.urlSha256);
    assert.ok(file.validation.continuousSeconds >= 120);
    assert.equal(file.validation.seeksPassed, 2);
  }
  assert.ok(rows.every(row => row.metadata.providerTmdbId));
  assert.ok(!rows.some(row => /pixeldrain|ong-bak/i.test(JSON.stringify(row))));
  const episodes = rows.filter(row => row.item_type === 'episode');
  assert.deepEqual(episodes.map(row => [row.metadata.selectionUnit.baseTitle, row.metadata.selectionUnit.seasons[0], row.metadata.selectionUnit.episode]),
    [['Suits', 4, 12], ['Peaky Blinders', 4, 2], ['Prison Break', 4, 21]]);
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
  for (const { fields: row } of items.filter(entry => entry.fields.item_type !== 'series')) {
    const input = { userId: 'owner', sourceId: await discoverySourceId('owner'), itemId: row.external_id,
      metadata: row.metadata, targetUrl: row.playback_hint.targetUrl, fetchPlaylist: () => { throw Error('a static pin must not fetch its repository'); } };
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
