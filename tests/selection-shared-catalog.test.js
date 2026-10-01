const { test } = require('node:test');
const assert = require('node:assert/strict');
const api = import('../supabase/functions/_shared/selection-shared-catalog.mjs');
const identities = import('../supabase/functions/_shared/discovery-catalog.mjs');
const userId = '11111111-1111-4111-a111-111111111111';
const fence = { isCatalogVisible: true, generationId: '22222222-2222-4222-a222-222222222222',
  headRevision: '2', configRevision: '3', sourceVisibilityEpoch: '4', userVisibilityEpoch: '5' };
async function context(replies = []) {
  const { discoverySourceId, DISCOVERY_PLAYLIST_URL } = await identities;
  const calls = [];
  return { userId, sourceId: await discoverySourceId(userId, 9), config: { playlistUrl: DISCOVERY_PLAYLIST_URL }, calls,
    db: { async rpc(name, args) { calls.push({ name, args }); return replies.shift() || { data: null, error: null }; } } };
}
test('activation binds the exact public playlist, owner and all current write fences', async () => {
  const ctx = await context([{ data: fence }, { data: { activated: true } }]);
  assert.equal(await (await api).activateSharedSelection(ctx), true);
  assert.equal(ctx.calls.length, 2);
  assert.deepEqual(ctx.calls[1].args, { p_source_id: ctx.sourceId, p_user_id: userId,
    p_revision: await (await import('../supabase/functions/_shared/selection-prepared-catalog.mjs')).selectionPreparedRevision(),
    p_generation_id: fence.generationId, p_head_revision: '2', p_config_revision: '3',
    p_source_visibility_epoch: '4', p_user_visibility_epoch: '5' });
});
test('another playlist or another owner cannot activate the public catalog by naming it Selection', async () => {
  const ctx = await context(); const { activateSharedSelection } = await api;
  assert.equal(await activateSharedSelection({ ...ctx, config: { playlistUrl: 'https://example.invalid/Selection.m3u' } }), false);
  assert.equal(await activateSharedSelection({ ...ctx, userId: '33333333-3333-4333-a333-333333333333' }), false);
  assert.equal(ctx.calls.length, 0);
});
test('unpublished release and rolling schema keep the ordinary import path', async () => {
  for (const reply of [{ data: { activated: false } }, { error: { code: 'PGRST202' } }]) {
    const ctx = await context([{ data: fence }, reply]);
    assert.equal(await (await api).activateSharedSelection(ctx), false);
  }
});
test('hidden sources, stale generations and database failures are not cache misses', async () => {
  const { activateSharedSelection } = await api;
  for (const visible of [false, null, 'false']) {
    const ctx = await context([{ data: { ...fence, isCatalogVisible: visible } }]);
    await assert.rejects(activateSharedSelection(ctx)); assert.equal(ctx.calls.length, 1);
  }
  for (const code of ['PT409', '42501', '57014']) {
    const ctx = await context([{ data: fence }, { error: { code } }]);
    await assert.rejects(activateSharedSelection(ctx), error => error.code === code);
  }
});
test('personal file binding is limited to the requested Selection file', async () => {
  const ctx = await context([{ data: { bound: 1 } }]);
  await (await api).bindSharedSelectionFile({ ...ctx, itemType: 'movie', itemId: 'public-exact-file' });
  assert.deepEqual(ctx.calls, [{ name: 'norva_bind_selection_shared_file', args: {
    p_user_id: userId, p_source_id: ctx.sourceId, p_item_type: 'movie', p_external_id: 'public-exact-file' } }]);
});
test('normal provider playback adds no shared enrollment RPC', async () => {
  const ctx = await context();
  await (await api).bindSharedSelectionFile({ ...ctx, sourceId: '44444444-4444-4444-a444-444444444444', itemType: 'movie', itemId: '12' });
  assert.equal(ctx.calls.length, 0);
});
