const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('a curated home rail resolves the full owned film even when it has a playback variant', async () => {
  const callbacks = [];
  const context = vm.createContext({ window: {}, setTimeout: callback => callbacks.push(callback) });
  vm.runInContext(fs.readFileSync('public/js/pages/HomePage.js', 'utf8') + '\nthis.TestHomePage = HomePage;', context);
  let resolved;
  const page = Object.create(context.TestHomePage.prototype);
  page.buildHomeMediaGroup = () => ({ items: [] });
  page.displayTitle = item => item.title;
  page.app = { navigateTo() {}, pages: { movies: {
    beginFicheIntent: () => 1, isFicheIntentCurrent: () => true,
    openByItem: async item => { resolved = item; return true; },
    showMovieDetails: () => { throw Error('Must not use incomplete rail metadata'); },
  } } };
  page.navigateToMovie({ item_id: 'norva-discovery:sintel', source_id: 'owned-source', title: 'Sintel', variants: [{}] });
  await callbacks[0]();
  assert.equal(resolved.stream_id, 'norva-discovery:sintel');
  assert.equal(resolved.sourceId, 'owned-source');
});

test('movie details retain the synopsis and attribution of a raw M3U film', () => {
  const context = vm.createContext({ window: {} });
  vm.runInContext(fs.readFileSync('public/js/pages/MoviesPage.js', 'utf8') + '\nthis.TestMoviesPage = MoviesPage;', context);
  const overview = 'A film synopsis. Blender Foundation · CC BY 3.0';
  assert.equal(context.TestMoviesPage.prototype.getMovieOverview({ metadata: { plot: overview } }), overview);
  assert.equal(context.TestMoviesPage.prototype.getMovieOverview({ data: { plot: overview } }), overview);
  assert.equal(context.TestMoviesPage.prototype.getMovieOverview({ titleId: 'title', overview: 'Localized synopsis', metadata: { plot: overview } }), 'Localized synopsis');
});

test('curated films are VOD only for the exact selection URL and retain attribution', async () => {
  const { DISCOVERY_FILMS, DISCOVERY_PLAYLIST_URL, discoveryMovieFields } = await import('../supabase/functions/_shared/discovery-catalog.mjs');
  for (const film of DISCOVERY_FILMS) {
    const row = discoveryMovieFields(DISCOVERY_PLAYLIST_URL, film.url);
    assert.equal(row.item_type, 'movie');
    assert.equal(row.playback_hint.targetUrl, film.url);
    assert.ok(row.metadata.plot.includes(film.credit));
    assert.ok(row.metadata.plot.includes(film.licenceUrl));
    assert.deepEqual(discoveryMovieFields('https://provider.example/live.m3u', film.url), {});
  }
  assert.throws(() => discoveryMovieFields(DISCOVERY_PLAYLIST_URL, 'https://unknown.example/movie.mp4'));
  assert.deepEqual(discoveryMovieFields(DISCOVERY_PLAYLIST_URL + '?spoof=1', DISCOVERY_FILMS[0].url), {});
});

test('selection retries reuse one source identity without sharing it across accounts', async () => {
  const { discoverySourceId } = await import('../supabase/functions/_shared/discovery-catalog.mjs');
  const first = await discoverySourceId('account-a');
  assert.equal(await discoverySourceId('account-a'), first);
  assert.notEqual(await discoverySourceId('account-b'), first);
  assert.match(first, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/);
});

test('published playlist exactly matches the reviewed registry', async () => {
  const { DISCOVERY_FILMS, discoveryPlaylist } = await import('../supabase/functions/_shared/discovery-catalog.mjs');
  assert.equal(fs.readFileSync('public/catalog/discovery.m3u', 'utf8').replace(/\r\n/g, '\n'), discoveryPlaylist());
  const credits = fs.readFileSync('public/catalog/credits.html', 'utf8');
  for (const film of DISCOVERY_FILMS) {
    assert.ok(credits.includes(film.rights));
    assert.ok(credits.includes(film.licenceUrl));
  }
});
