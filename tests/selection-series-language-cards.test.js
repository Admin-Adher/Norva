const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.join(__dirname, '..');
const mod = name => import(pathToFileURL(path.join(root, 'supabase/functions/_shared', name)));
const win = {};
new Function('window', fs.readFileSync(path.join(root, 'public/js/utils/mediaUtils.js'), 'utf8'))(win);

function database(tables, calls) {
  return { from(table) {
    const filters = [];
    const query = {
      select() { return query; },
      eq(key, value) { filters.push(row => row[key] === value); return query; },
      in(key, values) { filters.push(row => values.includes(row[key])); return query; },
      order() { return query; },
      async range(start, end) {
        calls.push({ table, start, end });
        return { data: (tables[table] || []).filter(row => filters.every(f => f(row))).slice(start, end + 1), error: null };
      },
    };
    return query;
  } };
}

test('series cards union only current owned episode files and never expose ordered tracks', async () => {
  const { discoverySourceId } = await mod('discovery-catalog.mjs');
  const { attachSelectionSeriesLanguages, selectionSeriesLanguageFields } = await mod('selection-series-languages.mjs');
  const userId = 'owner';
  const sourceId = await discoverySourceId(userId);
  const parent = { id: 'v1', user_id: userId, source_id: sourceId, item_type: 'series', external_id: 's1', metadata: { seriesDelivery: 'selection' } };
  const sibling = { ...parent, id: 'v2', external_id: 's2' };
  const otherOwner = { ...parent, id: 'v3', user_id: 'other' };
  const episode = (external_id, available = true) => ({ external_id, parent_external_id: 's1', source_id: sourceId, user_id: userId, item_type: 'episode', available });
  const observation = (file_external_id, audio_languages, extra = {}) => ({ variant_id: 'v1', user_id: userId, file_external_id, audio_languages, subtitle_languages: [], audio_observed: true, subtitle_observed: true, ...extra });
  const calls = [];
  const db = database({
    cloud_catalog_visible_media_items: [episode('e1'), episode('e2'), episode('gone', false)],
    cloud_title_file_language_observations: [
      observation('e1', ['es']), observation('e2', ['en', 'es', 'und'], { subtitle_languages: ['fr'] }),
      observation('gone', ['de']), observation('s1', ['zh']),
      observation('e1', ['it'], { user_id: 'other' }),
      observation('e1', ['pt'], { variant_id: 'v2' }),
    ],
  }, calls);
  await attachSelectionSeriesLanguages(db, [parent, sibling, otherOwner], userId);
  const fields = selectionSeriesLanguageFields(parent.__series_languages);
  assert.deepEqual(fields.audioLanguages, ['en', 'es']);
  assert.deepEqual(fields.subtitleLanguages, ['fr']);
  assert.equal(fields.audioLanguagesScope, 'series');
  assert.equal(fields.audioLanguageValidationStatus, 'probed_union');
  assert.equal('audioTracks' in fields, false);
  assert.equal(sibling.__series_languages, undefined);
  assert.equal(otherOwner.__series_languages, undefined);
  const item = { item_type: 'series', ...fields };
  assert.match(win.MediaUtils.versionLanguageBadge(item), /EN.*ES/);
  assert.match(win.MediaUtils.versionDescriptor(item).headline, /EN.*ES/);
  assert.equal(win.MediaUtils.analyzeLanguageCompatibility(item, { preferredAudioLanguage: 'de' }).audio.state, 'unknown');
  assert.notEqual(win.MediaUtils.analyzeLanguageCompatibility(item, { preferredAudioLanguage: 'es' }).audio.state, 'confirmed');
});

test('episode language reads paginate beyond the PostgREST row cap', async () => {
  const { discoverySourceId } = await mod('discovery-catalog.mjs');
  const { attachSelectionSeriesLanguages } = await mod('selection-series-languages.mjs');
  const userId = 'owner', sourceId = await discoverySourceId(userId);
  const parent = { id: 'v1', user_id: userId, source_id: sourceId, item_type: 'series', external_id: 's1', metadata: { seriesDelivery: 'selection' } };
  const calls = [];
  const db = database({
    cloud_catalog_visible_media_items: Array.from({ length: 1001 }, (_, i) => ({ user_id: userId, source_id: sourceId, item_type: 'episode', available: true, external_id: 'e'+i, parent_external_id: 's1' })),
    cloud_title_file_language_observations: Array.from({ length: 1001 }, (_, i) => ({ user_id: userId, variant_id: 'v1', file_external_id: 'e'+i, audio_observed: true, audio_languages: [i === 1000 ? 'pt' : 'es'] })),
  }, calls);
  await attachSelectionSeriesLanguages(db, [parent], userId);
  assert.deepEqual(parent.__series_languages.audio, ['es', 'pt']);
  assert.equal(calls.filter(call => call.start === 1000).length, 2);
});

test('missing series evidence stays pending and movie cards cannot inherit an episode union', async () => {
  const { selectionSeriesLanguageFields } = await mod('selection-series-languages.mjs');
  assert.deepEqual(selectionSeriesLanguageFields(undefined), {});
  assert.equal(win.MediaUtils.versionLanguageBadge({ item_type: 'series' }), 'Audio pending');
  const movie = { item_type: 'movie', ...selectionSeriesLanguageFields({ audio: ['es'], audioObserved: true }) };
  assert.equal(win.MediaUtils.versionDescriptor(movie).headline, 'Audio unknown');
});

test('re-enrolled series retain their own episode evidence across Selection generations', async () => {
  const { discoverySourceId } = await mod('discovery-catalog.mjs');
  const { attachSelectionSeriesLanguages } = await mod('selection-series-languages.mjs');
  const userId = 'owner';
  const parents = await Promise.all([0, 1, 2].map(async generation => ({
    id: 'variant-' + generation, user_id: userId, source_id: await discoverySourceId(userId, generation),
    item_type: 'series', external_id: 'shared-series', metadata: { seriesDelivery: 'selection' },
  })));
  const db = database({
    cloud_catalog_visible_media_items: parents.map((parent, i) => ({
      user_id: userId, source_id: parent.source_id, item_type: 'episode', available: true,
      parent_external_id: 'shared-series', external_id: 'episode-' + i,
    })),
    cloud_title_file_language_observations: parents.flatMap((parent, i) => [
      { user_id: userId, variant_id: parent.id, file_external_id: 'episode-' + i,
        audio_observed: true, audio_languages: [['fr'], ['en'], ['es']][i] },
      { user_id: userId, variant_id: parent.id, file_external_id: 'episode-' + ((i + 1) % 3),
        audio_observed: true, audio_languages: ['de'] },
    ]),
  }, []);
  await attachSelectionSeriesLanguages(db, parents, userId);
  assert.deepEqual(parents.map(parent => parent.__series_languages.audio), [['fr'], ['en'], ['es']]);
});
