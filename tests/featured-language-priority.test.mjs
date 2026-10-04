import test from 'node:test';
import assert from 'node:assert/strict';
import { featuredLanguageTitleIds, scheduleFeaturedLanguagePriority } from '../supabase/functions/_shared/featured-language-priority.mjs';
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const card = (n, type = 'movie') => ({ id: id(n), item_type: type });

test('actual category cards are interleaved, deduplicated and limited to VOD title ids', () => {
  assert.deepEqual(featuredLanguageTitleIds({ rails: [
    { items: [card(1), card(2), { id: 'provider-id', type: 'movie' }] },
    { items: [card(3, 'series'), card(1), card(4, 'live')] },
  ] }), [id(1), id(3), id(2)]);
  assert.deepEqual(featuredLanguageTitleIds({ items: [{ titleId: id(2), type: 'series' }] }), [id(2)]);
  assert.deepEqual(featuredLanguageTitleIds(null), []);
  const rails = Array.from({ length: 10 }, (_, r) => ({ items: Array.from({ length: 100 }, (_, n) => card(r * 100 + n)) }));
  assert.equal(featuredLanguageTitleIds({ rails }).length, 256);
});
test('records authenticated owner in a deferred bounded RPC without provider access', async () => {
  let args, signal, deferred;
  const db = { rpc(name, body) { args = { name, body }; return { abortSignal(s) { signal = s; return Promise.resolve({ error: null }); } }; } };
  assert.equal(scheduleFeaturedLanguagePriority(db, id(8), { items: [card(2)] }, { waitUntil(p) { deferred = p; } }), undefined);
  await deferred;
  assert.deepEqual(args, { name: 'record_catalog_featured_language_titles', body: { p_user: id(8), p_titles: [id(2)] } });
  assert.ok(signal instanceof AbortSignal);
});
test('empty/non VOD responses do not submit priority writes', () => {
  const db = { rpc() { assert.fail('unexpected write'); } };
  scheduleFeaturedLanguagePriority(db, id(8), { items: [card(1, 'live')] });
  scheduleFeaturedLanguagePriority(db, 'invalid', { items: [card(1)] });
});
