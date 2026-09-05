const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

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
