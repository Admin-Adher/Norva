const test = require('node:test');
const assert = require('node:assert/strict');
const { importTypescriptModule } = require('./helpers/import-typescript-module');
const loading = importTypescriptModule('supabase/functions/_shared/live-catalog.ts');

test('worldwide playlists materialize distinct channels with Unicode categories and stable existing identities', async () => {
  const { buildLiveCatalog } = await loading;
  const row = group => ({ source_id: 'source', external_id: group, title: 'Example TV', item_type: 'live', parent_external_id: group, subtitle: group, playback_hint: { sourceType: 'm3u', targetUrl: 'https://tv.example/live.m3u8' } });
  const baseline = buildLiveCatalog([row('Cinema')], { includeVariants: true });
  const international = buildLiveCatalog(['Cinema', '日本', 'العربية', 'Türkiye', 'Ελλάδα'].map(row), { includeVariants: true });
  assert.equal(international.channels.length, 5);
  assert.equal(new Set(international.channels.map(channel => channel.id)).size, 5);
  assert.ok(international.channels.some(channel => channel.id === baseline.channels[0].id));
  assert.ok(international.channels.some(channel => channel.id.startsWith('lc_u8_')));
  assert.deepEqual(buildLiveCatalog(['Cinema', '日本', 'العربية', 'Türkiye', 'Ελλάδα'].map(row), { includeVariants: true }), international);
});
