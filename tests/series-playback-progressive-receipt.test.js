'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');

const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/norva-playback/index.ts'), 'utf8');
const proofSource = source.slice(
  source.indexOf('function seriesInfoPayloadContainsEpisode('),
  source.indexOf('\nasync function resolveExactEpisodePlaybackTarget(', source.indexOf('function seriesInfoPayloadContainsEpisode(')),
);

function proofHarness({ parent = true, cache = true, registered = false, payload, selection = false, selectionEpisode = null } = {}) {
  const calls = [];
  const query = (table) => ({
    select() { return this; },
    eq(key, value) { calls.push([table, key, value]); return this; },
    async limit() { return { data: parent ? [{ id: 'owned-parent' }] : [], error: null }; },
    async maybeSingle() { return { data: cache ? { payload: payload || { episodes: { 1: [{ id: 'episode-1' }] } } } : null, error: null }; },
  });
  const context = {
    Object,
    recordOrEmpty: value => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
    isRecord: value => value && typeof value === 'object' && !Array.isArray(value),
    stringOr: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
    resolveCatalogSeriesEpisodeCoordinates: async () => registered ? { episode_id: 'episode-1' } : null,
    resolveSourceHost: async () => 'provider.example',
    isDiscoverySourceId: async () => selection,
    resolveOwnedSelectionEpisode: async args => {
      calls.push(['selection-proof', args.userId, args.sourceId, args.parentId, args.itemId]);
      return selectionEpisode;
    },
  };
  const executable = stripTypeScriptTypes(proofSource, { mode: 'strip' });
  const proof = vm.runInNewContext(
    `(() => { ${executable}; return hasVisibleSeriesEpisodeReceiptProof; })()`, context,
  );
  return { proof, db: { from: query }, calls };
}

test('a visible parent and server-owned cached episode prove a progressive series receipt', async () => {
  const { proof, db, calls } = proofHarness();
  assert.equal(await proof(db, 'source-1', 'owner-1', 'series-1', 'episode-1'), true);
  assert.ok(calls.some(call => call.join(':') === 'cloud_catalog_visible_title_variants:user_id:owner-1'));
  assert.ok(calls.some(call => call.join(':') === 'cloud_series_info_cache:series_id:series-1'));
});

test('a missing parent, missing cache or different episode cannot prove the receipt', async () => {
  for (const settings of [{ parent: false }, { cache: false }, {}]) {
    const { proof, db } = proofHarness(settings);
    assert.equal(await proof(db, 'source-1', 'owner-1', 'series-1', 'other-episode'), false);
  }
});

test('a registered episode still needs its currently visible owned parent', async () => {
  const valid = proofHarness({ registered: true, cache: false });
  assert.equal(await valid.proof(valid.db, 'source-1', 'owner-1', 'series-1', 'episode-1'), true);
  const hidden = proofHarness({ registered: true, parent: false });
  assert.equal(await hidden.proof(hidden.db, 'source-1', 'owner-1', 'series-1', 'episode-1'), false);
});

test('a Selection file and parent prove the receipt without an Xtream cache', async () => {
  const h = proofHarness({ selection: true, cache: false, selectionEpisode: { id: 'owned-file', generation_id: 'current-generation' } });
  assert.equal(await h.proof(h.db, 'source-1', 'owner-1', 'series-1', 'episode-1'), true);
  assert.ok(h.calls.some(c => c.join(':') === 'selection-proof:owner-1:source-1:series-1:episode-1'));
  assert.equal(h.calls.some(c => c[0] === 'cloud_series_info_cache'), false);
});

test('missing or hidden Selection authority never falls back to a provider cache', async () => {
  for (const settings of [{ selectionEpisode: null }, { selectionEpisode: { id: 'file' } },
    { parent: false, selectionEpisode: { id: 'file', generation_id: 'generation' } }]) {
    const h = proofHarness({ selection: true, cache: true, ...settings });
    assert.equal(await h.proof(h.db, 'source-1', 'owner-1', 'series-1', 'episode-1'), false);
    assert.equal(h.calls.some(c => c[0] === 'cloud_series_info_cache'), false);
  }
});

test('series receipts recheck authority and exact target after a visibility advance', () => {
  assert.match(source, /await adoptActiveCatalogUserVisibilityEpoch\(db, sourceId, userId, playbackGeneration\);\s*await assertActiveCatalogGenerationCurrent\(db, sourceId, userId, playbackGeneration\);\s*markStartup\("targetResolutionMs"\)/);
  assert.match(source, /const bindPreparedPlaybackReceipt = async[\s\S]*hasVisibleSeriesEpisodeReceiptProof[\s\S]*bindCompletedPlaybackReceipt/);
  assert.match(source, /assertSourceCurrent: async \(\) => \{[\s\S]*assertSourceCatalogVisible[\s\S]*hasVisibleSeriesEpisodeReceiptProof[\s\S]*currentTarget\.targetUrl[\s\S]*targetUrlHash/);
  assert.match(source, /finalizePlaybackReceiptResponse\(req, async \(\) => finalizeCatalogVisibilityResponse/);
  // Native recovery shares the opaque session's existing bound receipt path.
  assert.equal((source.match(/await bindPreparedPlaybackReceipt\(/g) || []).length, 5);
});
