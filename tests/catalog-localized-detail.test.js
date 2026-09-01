'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

function loadPage(file, className) {
  const context = {
    window: {},
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    MediaUtils: {
      cleanReleaseName: (value) => String(value || '').replace(/^MULTI ▎\s*/, ''),
    },
  };
  vm.runInNewContext(read(file), context, { filename: file });
  return context.window[className];
}

for (const spec of [
  {
    label: 'movie',
    file: 'public/js/pages/MoviesPage.js',
    className: 'MoviesPage',
    titleMethod: 'getMovieDisplayTitle',
    overviewMethod: 'getMovieOverview',
    detailPattern: /plotEl\.textContent = this\.getMovieOverview\(displayMovie\)/,
  },
  {
    label: 'series',
    file: 'public/js/pages/SeriesPage.js',
    className: 'SeriesPage',
    titleMethod: 'getSeriesDisplayTitle',
    overviewMethod: 'getSeriesOverview',
    detailPattern: /getElementById\('series-plot'\)\.textContent = this\.getSeriesOverview\(series\)/,
  },
]) {
  test(`${spec.label} rail text remains localized when opening its detail`, () => {
    const Page = loadPage(spec.file, spec.className);
    const page = Object.create(Page.prototype);
    const item = {
      titleId: 'stable-title-id',
      title: 'Titre localisé',
      name: 'Titre localisé',
      overview: 'Synopsis localisé',
      tmdb: {
        title: 'English title',
        name: 'English title',
        overview: 'English synopsis',
      },
    };

    assert.equal(page[spec.titleMethod](item), 'Titre localisé');
    assert.equal(typeof page[spec.overviewMethod], 'function');
    assert.equal(page[spec.overviewMethod](item), 'Synopsis localisé');
    assert.match(read(spec.file), spec.detailPattern);

    const legacyProviderItem = { ...item };
    delete legacyProviderItem.titleId;
    assert.equal(page[spec.titleMethod](legacyProviderItem), 'English title');
    assert.equal(page[spec.overviewMethod](legacyProviderItem), 'English synopsis');

    if (spec.label === 'series') {
      assert.equal(page[spec.titleMethod]({
        titleId: 'promax-series',
        title: 'MULTI ▎ Badly in Love',
        name: 'MULTI ▎ Badly in Love',
      }), 'Badly in Love');
    }
  });
}
