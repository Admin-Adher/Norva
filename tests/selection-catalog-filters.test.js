'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');

for (const name of ['MoviesPage', 'SeriesPage']) {
  test(`${name} offers enabled M3U catalogues in cloud mode and restores their source filter`, async () => {
    const cloudId = '898fe2bc-22fa-4067-ae8a-2f77d5bba6ca';
    const sources = [
      { id: 1, type: 'xtream', enabled: true, name: 'Personal' },
      { id: 2, type: 'm3u', enabled: true, name: 'Norva Selection', cloudId },
      { id: 3, type: 'm3u', enabled: false, name: 'Disabled' },
      { id: 4, type: 'xtream', enabled: false, name: 'Disabled personal' },
    ];
    const context = {
      window: {}, console,
      API: { sources: { getAll: async () => sources } },
      document: { createElement: () => ({}) },
    };
    vm.runInNewContext(fs.readFileSync(path.join(root, `public/js/pages/${name}.js`), 'utf8'), context);
    const page = Object.create(context.window[name].prototype);
    page.sourceSelect = {
      options: [], value: '',
      set innerHTML(value) { this.options = [{ value: '', textContent: 'All Sources' }]; this.value = ''; },
      appendChild(option) { this.options.push(option); },
    };
    page.savedFilters = { source: '2' };
    page.isCloudPagedMode = () => true;
    await page.loadSources();
    assert.deepEqual(Array.from(page.sources, s => s.id), [1, 2]);
    assert.equal(page.sourceSelect.options[2].textContent, 'Norva Selection');
    assert.equal(page.selectedCloudSourceId(), cloudId);
    page.sourceSelect.value = '';
    assert.equal(page.selectedCloudSourceId(), '');

    // Local M3U remains live-only; never route it to an Xtream VOD API.
    page.isCloudPagedMode = () => false;
    await page.loadSources();
    assert.deepEqual(Array.from(page.sources, s => s.id), [1]);
    assert.equal(page.sourceSelect.value, '');
  });
}

test('series audio facets use the requested catalogue type and keep the SQL service boundary', () => {
  const edge = fs.readFileSync(path.join(root, 'supabase/functions/norva-catalog/index.ts'), 'utf8');
  const facets = edge.split('async function listLanguageFacets(')[1].split('function normalizeObservedSubtitleTracks')[0];
  assert.match(facets, /const selectionId = await discoverySourceId\(userId\)/);
  assert.match(facets, /p_item_type: itemType/);
  const sql = fs.readFileSync(path.join(root, 'supabase/migrations/20260906191036_selection_series_language_filters.sql'), 'utf8');
  assert.match(sql, /variant\.user_id = p_user_id/);
  assert.match(sql, /variant\.item_type = p_item_type and p_item_type in \('movie', 'series'\)/);
  assert.match(sql, /variant\.item_type = p_item_type/);
  assert.match(sql, /observation\.audio_observed and cardinality\(observation\.audio_languages\) > 0/);
  assert.match(sql, /observation\.subtitle_observed/);
  assert.doesNotMatch(sql, /security definer|p_item_type = 'movie'/);
  assert.match(sql, /cloud_selection_audio_catalog_counts\(uuid, uuid, uuid, text\) from public, anon, authenticated/);
  assert.match(sql, /cloud_selection_audio_catalog_counts\(uuid, uuid, uuid, text\) to service_role/);
});
