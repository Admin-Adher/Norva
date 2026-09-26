'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture(type, fetchPage) {
  const timers = [], displayed = [];
  const context = vm.createContext({
    window: {}, document: { addEventListener() {} },
    setTimeout: callback => timers.push(callback),
    API: { media: { page: fetchPage } },
    // Reverse the versions to expose accidental selection by provider-local ID only.
    MediaUtils: { groupItems: items => [{ items: [...items].reverse(), representative: items[0] }] },
  });
  const className = type === 'movie' ? 'MoviesPage' : 'SeriesPage';
  for (const [file, name] of [['public/js/app.js', 'App'], [`public/js/pages/${className}.js`, className]]) {
    vm.runInContext(fs.readFileSync(file, 'utf8') + `\nthis.Test${name} = ${name};`, context);
  }
  const app = Object.create(context.TestApp.prototype);
  const page = Object.create(context[`Test${className}`].prototype);
  page.openGroup = (group, options) => { displayed.push(options.selectedMovie); return true; };
  page.showSeriesDetailsV2 = async selected => { displayed.push(selected); };
  page.showMovieDetails = () => assert.fail('A saved group must not bypass the catalogue resolver');
  const pageName = type === 'movie' ? 'movies' : 'series';
  app.pages = { [pageName]: page }; app.currentPage = pageName; app._navigationToken = 1;
  let forgotten = 0;
  app.forgetOpenFiche = () => { forgotten++; };
  const saved = { type, sourceId: 'selected-source', id: 'same-provider-id', title: 'Saved title',
    group: { items: [{ sourceId: 'wrong-source', stream_id: 'same-provider-id', audioLanguageValidationStatus: 'pending' }] },
    series: { sourceId: 'wrong-source', series_id: 'same-provider-id', audioLanguages: [] },
    item: { sourceId: 'wrong-source', name: 'Stale metadata' } };
  return { app, page, pageName, saved, timers, displayed, forgotten: () => forgotten };
}

for (const type of ['movie', 'series']) {
  const idField = type === 'movie' ? 'stream_id' : 'series_id';
  test(`${type}: restored fiche resolves fresh evidence and keeps the selected source among colliding IDs`, async () => {
    let calls = 0;
    const f = fixture(type, async params => {
      calls++; assert.equal(params.type, type);
      return { items: [
        { sourceId: 'selected-source', [idField]: 'same-provider-id', name: 'Current title',
          audioLanguageValidationStatus: 'verified', audioLanguages: ['en'] },
        { sourceId: 'other-source', [idField]: 'same-provider-id', name: 'Sibling', audioLanguages: ['fr'] },
      ] };
    });
    f.app.restoreOpenFiche(f.pageName, f.saved);
    assert.equal(f.displayed.length, 0);
    await f.timers.shift()();
    assert.equal(calls, 1);
    assert.equal(f.displayed.length, 1);
    assert.equal(f.displayed[0].sourceId, 'selected-source');
    assert.equal(f.displayed[0].name, 'Current title');
    assert.equal(f.displayed[0].audioLanguageValidationStatus, 'verified');
    assert.deepEqual(Array.from(f.displayed[0].audioLanguages), ['en']);
  });

  test(`${type}: failed lookup never restores the stale saved audio claims`, async () => {
    const f = fixture(type, async () => { throw new Error('offline'); });
    f.app.restoreOpenFiche(f.pageName, f.saved);
    await f.timers.shift()();
    assert.equal(f.displayed.length, 1);
    assert.equal(f.displayed[0].sourceId, 'selected-source');
    assert.equal(f.displayed[0].audioLanguageValidationStatus, undefined);
    assert.equal(f.displayed[0].audioLanguages, undefined);
  });

  test(`${type}: a newer fiche intent wins while restoration is fetching`, async () => {
    let finish;
    const f = fixture(type, () => new Promise(resolve => { finish = resolve; }));
    f.app.restoreOpenFiche(f.pageName, f.saved);
    const pending = f.timers.shift()();
    f.page.beginFicheIntent();
    finish({ items: [] });
    await pending;
    assert.equal(f.displayed.length, 0);
    assert.equal(f.forgotten(), 0);
  });

  test(`${type}: navigation before the delayed restore performs no fetch`, async () => {
    const f = fixture(type, async () => assert.fail('obsolete navigation must not fetch'));
    f.app.restoreOpenFiche(f.pageName, f.saved);
    f.app._navigationToken++;
    await f.timers.shift()();
    assert.equal(f.displayed.length, 0);
  });
}
