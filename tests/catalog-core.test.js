'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

test('CatalogFilterState preserves pending dynamic values without touching DOM state', () => {
  const CatalogFilterState = require('../public/js/utils/CatalogFilterState.js');

  const state = CatalogFilterState.create({
    kind: 'movies',
    source: 'provider-local',
    sort: 'year',
    liveGenre: '',
    pendingGenre: 'Drama',
    genreHydrated: false,
    year: '2024',
    rating: '7',
    watched: 'inprogress',
    added: '30',
    duration: '120',
    audio: 'fr',
    subtitle: 'en',
    search: 'dante',
    group: false,
    favoritesOnly: true,
    selectedCategories: ['action', 'drame'],
    pendingCategories: ['drame', 'archive'],
    categoriesRestored: false,
  });

  assert.deepEqual(state, {
    source: 'provider-local',
    sort: 'year',
    genre: 'Drama',
    year: '2024',
    rating: '7',
    watched: 'inprogress',
    added: '30',
    duration: '120',
    audio: 'fr',
    subtitle: 'en',
    search: 'dante',
    group: false,
    favoritesOnly: true,
    categories: ['drame', 'archive', 'action'],
  });
  assert.equal(CatalogFilterState.hasActive(state), true);
});

test('CatalogFilterState keeps the Series-only status field and ignores provider scope as a filter', () => {
  const CatalogFilterState = require('../public/js/utils/CatalogFilterState.js');

  const state = CatalogFilterState.create({
    kind: 'series',
    source: 'provider-local',
    sort: 'default',
    status: '',
    group: true,
    favoritesOnly: false,
    categoriesRestored: true,
  });

  assert.equal(Object.hasOwn(state, 'status'), true);
  assert.equal(Object.hasOwn(state, 'duration'), false);
  assert.equal(CatalogFilterState.hasActive(state), false);
});

test('CatalogQueryParams maps catalogue controls to the existing server contract', () => {
  const CatalogQueryParams = require('../public/js/utils/CatalogQueryParams.js');

  assert.deepEqual(CatalogQueryParams.build({
    source: 'cloud-source-uuid',
    audio: 'fr',
    subtitle: 'en',
    year: '2024',
    rating: '7',
    added: '30',
    sort: 'lang-match',
    search: '  dante  ',
    preferences: {
      preferredAudioLanguage: 'fr',
      preferredSubtitleLanguage: 'none',
    },
  }), {
    source: 'cloud-source-uuid',
    audio: 'fr',
    subs: 'en',
    year: '2024',
    minRating: '7',
    addedDays: '30',
    sort: 'lang-match',
    prefAudio: 'fr',
    q: 'dante',
  });
});

test('catalog cores stay pure and contain no native download capability', () => {
  for (const file of [
    'public/js/utils/CatalogFilterState.js',
    'public/js/utils/CatalogQueryParams.js',
  ]) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.doesNotMatch(source, /document|querySelector|addEventListener/);
    assert.doesNotMatch(source, /download|native/i);
  }
});

test('catalog cores load before both page adapters', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public/app.html'), 'utf8');
  const filterCore = app.indexOf('/js/utils/CatalogFilterState.js');
  const queryCore = app.indexOf('/js/utils/CatalogQueryParams.js');
  const movies = app.indexOf('/js/pages/MoviesPage.js');
  const series = app.indexOf('/js/pages/SeriesPage.js');

  assert.ok(filterCore >= 0 && queryCore >= 0);
  assert.ok(filterCore < movies && filterCore < series);
  assert.ok(queryCore < movies && queryCore < series);
});
