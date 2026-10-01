const { test } = require('node:test');
const assert = require('node:assert/strict');
const userId = '11111111-1111-4111-a111-111111111111';
async function fixture() {
  const { discoverySourceId } = await import('../supabase/functions/_shared/discovery-catalog.mjs');
  const v = { id: 'variant', user_id: userId, source_id: await discoverySourceId(userId, 9),
    item_type: 'movie', external_id: 'exact-file', __selection_audio_url_sha256: 'abc' };
  const row = { variantId: v.id, userId, sourceId: v.source_id, itemType: 'movie', externalId: 'exact-file',
    urlSha256: 'abc', fileTags: { probedAt: '2026-10-01T00:00:00Z', verified: true,
      audioTracks: [{ index: 1, language: 'pt' }], subtitleTracks: [] } };
  const { attachSharedSelectionFileFacts: attach } = await import('../supabase/functions/_shared/selection-shared-file-facts.mjs');
  return { v, row, attach };
}
test('shared exact-file tags label unbound movie cards without writes', async () => {
  const { v, row, attach } = await fixture(); const calls = [];
  await attach({ rpc: async (name, args) => { calls.push({ name, args }); return { data: [row] }; } }, [v], userId);
  assert.deepEqual(v.__file_audio_languages, ['pt']);
  assert.deepEqual(v.__file_audio_tracks, [{ index: 1, language: 'pt' }]);
  assert.equal(v.__file_audio_validation_status, 'verified');
  assert.equal(calls[0].name, 'norva_selection_shared_file_facts');
});
test('foreign owner, source, file, variant and changed URL evidence is rejected', async () => {
  for (const field of ['userId', 'sourceId', 'itemType', 'externalId', 'variantId', 'urlSha256']) {
    const { v, row, attach } = await fixture(); row[field] = 'foreign';
    await attach({ rpc: async () => ({ data: [row] }) }, [v], userId);
    assert.equal(v.__file_audio_languages, undefined, field);
  }
});
test('unidentified tracks remain unidentified and provider declarations are not certified', async () => {
  const { v, row, attach } = await fixture();
  row.fileTags.audioTracks = [{ index: 1, language: 'und' }];
  await attach({ rpc: async () => ({ data: [row] }) }, [v], userId);
  assert.deepEqual(v.__file_audio_languages, []);
  assert.equal(v.__file_audio_validation_status, 'pending');
  assert.equal(v.__file_audio_verified_at, undefined);
});
test('series uses a language union, never a file track map', async () => {
  const { v, row, attach } = await fixture(); v.item_type = row.itemType = 'series';
  row.seriesLanguages = { audio: ['pt'], subtitles: ['en'] };
  await attach({ rpc: async () => ({ data: [row] }) }, [v], userId);
  assert.deepEqual(v.__series_languages.audio, ['pt']);
  assert.equal(v.__file_audio_tracks, undefined);
});
test('ordinary providers do not call the shared facts RPC', async () => {
  const { v, attach } = await fixture(); v.source_id = '22222222-2222-4222-a222-222222222222';
  await attach({ rpc: async () => { assert.fail('ordinary provider RPC'); } }, [v], userId);
});
