'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const api = import('../supabase/functions/_shared/m3u-series-info.mjs');
const targetUrl = 'https://provider.invalid/owned-episode.mp4';
const itemId = 'norva-m3u:episode:' + crypto.createHash('sha256').update(targetUrl).digest('hex');
const parentId = 'norva-m3u:series:' + 'a'.repeat(64);
const metadata = kind => ({ m3uMedia: { version: 1, kind, seriesTitle: 'Fixture', season: 1, episode: 1 } });

function fixture(change = {}) {
  const source = { id: 'source', user_id: 'owner', source_type: 'm3u' };
  const episode = { id: 'episode-row', user_id: 'owner', source_id: 'source', generation_id: 'current',
    available: true, external_id: itemId, item_type: 'episode', parent_external_id: parentId,
    metadata: metadata('episode'), playback_hint: { sourceType: 'm3u', targetUrl }, ...change.episode };
  const parent = { user_id: 'owner', source_id: 'source', generation_id: 'current', available: true,
    external_id: parentId, item_type: 'series', metadata: metadata('series'), ...change.parent };
  const calls = [];
  const db = { from(table) {
    const query = { filters: [], select() { return this; }, eq(key, value) { this.filters.push([key, value]); return this; },
      async maybeSingle() {
        calls.push({ table, filters: this.filters });
        const rows = table === 'cloud_catalog_visible_sources' ? [{ ...source, ...change.source }] : [episode, parent];
        return { data: rows.find(row => this.filters.every(([key, value]) => row[key] === value)) || null,
          error: change.error ? { message: 'synthetic database failure' } : null };
      } };
    return query;
  } };
  return { db, calls, episode };
}

test('owned M3U episode resolves only through visible source and current-generation parent', async () => {
  const { resolveOwnedM3uEpisode } = await api;
  const f = fixture();
  const result = await resolveOwnedM3uEpisode({ db: f.db, userId: 'owner', sourceId: 'source', itemId, parentId });
  assert.equal(result, f.episode);
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls.every(call => call.filters.some(([key, value]) => key === 'user_id' && value === 'owner')));
  assert.ok(f.calls[2].filters.some(([key, value]) => key === 'generation_id' && value === 'current'));
});

test('another owner, source, generation or unavailable parent cannot supply an episode', async () => {
  const { resolveOwnedM3uEpisode } = await api;
  for (const change of [
    { source: { user_id: 'other' } }, { source: { source_type: 'xtream' } },
    { episode: { user_id: 'other' } }, { episode: { source_id: 'other' } },
    { episode: { available: false } }, { episode: { generation_id: 'old' } },
    { parent: { available: false } }, { parent: { user_id: 'other' } },
  ]) {
    const f = fixture(change);
    assert.equal(await resolveOwnedM3uEpisode({ db: f.db, userId: 'owner', sourceId: 'source', itemId }), null);
  }
});

test('URL hash, imported source type and parent binding cannot be replaced by caller hints', async () => {
  const { resolveOwnedM3uEpisode } = await api;
  for (const playback_hint of [
    { sourceType: 'm3u', targetUrl: targetUrl + '?changed=1' },
    { sourceType: 'xtream', targetUrl },
    { sourceType: 'm3u', targetUrl: 'file:///private' },
  ]) {
    const f = fixture({ episode: { playback_hint } });
    assert.equal(await resolveOwnedM3uEpisode({ db: f.db, userId: 'owner', sourceId: 'source', itemId }), null);
  }
  const f = fixture();
  assert.equal(await resolveOwnedM3uEpisode({ db: f.db, userId: 'owner', sourceId: 'source', itemId,
    parentId: 'norva-m3u:series:' + 'b'.repeat(64) }), null);
});

test('database failure fails closed instead of returning an imported URL', async () => {
  const { resolveOwnedM3uEpisode } = await api;
  const f = fixture({ error: true });
  await assert.rejects(resolveOwnedM3uEpisode({ db: f.db, userId: 'owner', sourceId: 'source', itemId }),
    /Unable to verify M3U source/);
});
