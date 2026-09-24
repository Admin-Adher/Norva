'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const {
  classifyM3uItem, buildM3uCatalogRows, m3uCatalogCounts, m3uSemanticSignature,
} = require('../supabase/functions/_shared/m3u-media-classification.mjs');

const hash = async value => createHash('sha256').update(value).digest('hex');
const item = (url, overrides = {}) => ({ title: 'Channel', url, tvgId: '', group: 'General', logo: '', ...overrides });
const rows = async items => buildM3uCatalogRows(items, { userId: 'owner-a', sourceId: 'source-a', hash });

test('a media extension alone does not move a live channel into movies', async () => {
  const source = item('https://provider.example/stream/channel.mp4', { tvgId: 'epg-1' });
  assert.equal(classifyM3uItem(source).kind, 'live');
  const built = await rows([source]);
  assert.equal(built.length, 1);
  assert.equal(built[0].item_type, 'live');
  assert.equal(built[0].external_id, 'epg-1');
});

test('explicit movie and complete Xtream paths classify VOD, while contradictory metadata stays live', async () => {
  assert.equal(classifyM3uItem(item('https://provider.example/stream/42', {
    media: { mediaType: 'movie' },
  })).kind, 'movie');
  assert.equal(classifyM3uItem(item('https://provider.example/movie/u/p/42.mp4')).kind, 'movie');
  assert.equal(classifyM3uItem(item('https://provider.example/movie/u/p/42.mp4', {
    media: { mediaType: 'live', tvgType: 'movie' },
  })).kind, 'live');
});

test('two playable URLs sharing an EPG ID remain separate owner-scoped rows', async () => {
  const built = await rows([
    item('https://provider.example/live/a', { tvgId: 'shared' }),
    item('https://provider.example/live/b', { tvgId: 'shared' }),
  ]);
  assert.equal(built.length, 2);
  assert.equal(new Set(built.map(row => row.external_id)).size, 2);
  assert.ok(built.every(row => row.user_id === 'owner-a' && row.source_id === 'source-a'));
  assert.deepEqual(new Set(built.map(row => row.playback_hint.targetUrl)),
    new Set(['https://provider.example/live/a', 'https://provider.example/live/b']));
});

test('series episodes create one parent and retain distinct playable episode rows', async () => {
  const built = await rows([
    item('https://provider.example/series/u/p/1.mp4', { title: 'Show S01E01', group: 'Drama' }),
    item('https://provider.example/series/u/p/2.mp4', { title: 'Show S01E02', group: 'Drama' }),
  ]);
  const parent = built.filter(row => row.item_type === 'series');
  const episodes = built.filter(row => row.item_type === 'episode');
  assert.equal(parent.length, 1);
  assert.equal(episodes.length, 2);
  assert.ok(episodes.every(row => row.parent_external_id === parent[0].external_id));
  assert.deepEqual(m3uCatalogCounts(built).counts,
    { live: 0, movies: 0, series: 1, episodes: 2, total: 3 });
});

test('conflicting episode identities for one URL cannot create two authoritative episodes', async () => {
  const url = 'https://provider.example/series/u/p/shared.ts';
  const built = await rows([
    item(url, { title: 'Show S01E01', media: { mediaType: 'series' } }),
    item(url, { title: 'Show S01E02', media: { mediaType: 'series' } }),
  ]);
  assert.equal(built.filter(row => row.item_type === 'episode').length, 0);
  assert.equal(built.filter(row => row.item_type === 'series').length, 0);
  assert.equal(built.filter(row => row.item_type === 'movie').length, 1);
  assert.equal(built[0].metadata.m3uMedia.evidence, 'ambiguous_episode_metadata');
});

test('semantic signature ignores playlist order but detects corrected episode metadata', async () => {
  const first = item('https://provider.example/series/u/p/1.ts', { title: 'Show S01E01' });
  const second = item('https://provider.example/movie/u/p/2.mp4', { title: 'Film' });
  const a = await rows([first, second]);
  const reordered = await rows([second, first]);
  const corrected = await rows([{ ...first, title: 'Show S01E02' }, second]);
  assert.deepEqual(await m3uSemanticSignature(a, { hash }),
    await m3uSemanticSignature(reordered, { hash }));
  assert.notDeepEqual(await m3uSemanticSignature(a, { hash }),
    await m3uSemanticSignature(corrected, { hash }));
});
