const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function page(name) {
  const window = {};
  const API = { proxy: { xtream: {} } };
  vm.runInNewContext(fs.readFileSync(`public/js/pages/${name}.js`, 'utf8'), {
    window, API, console, MediaUtils: {
      safeImageUrl: value => value, cleanReleaseName: value => value,
      formatEpisodeDisplayLabel: value => value,
      playbackHintFromItem: () => ({})
    }
  });
  return { page: Object.create(window[name].prototype), window, API };
}
const history = { source_id: '17', item_id: 'file', item_type: 'movie', progress: 75, duration: 600,
  data: { title: 'Titre actuel', poster: 'https://norva.tv/poster.jpg',
    description: 'Synopsis français', year: 1997, rating: 4.75,
    titleId: 'owned-title', seriesId: 'series', currentSeason: 1, currentEpisode: 2 } };

test('a movie outside the loaded page resumes with current editorial metadata and the exact file identity', async () => {
  const f = page('MoviesPage'); let played;
  Object.assign(f.page, { movies: [], historySourceId: () => '17', historyTitleId: () => 'owned-title',
    getResumeOffset: value => value, playMovie: async (movie, options) => { played = { movie, options }; } });
  await f.page.resumeFromHistory(history);
  assert.equal(played.movie.stream_id, 'file'); assert.equal(played.movie.sourceId, 17);
  assert.equal(played.movie.plot, 'Synopsis français'); assert.equal(played.movie.year, 1997);
  assert.equal(played.options.resumeTime, 75); assert.equal(played.movie.titleId, 'owned-title');
  assert.equal(played.movie.audioLanguages, undefined, 'editorial history is not audio evidence');
});

test('series history paints its synopsis before any provider request', async () => {
  const f = page('SeriesPage'); let painted;
  Object.assign(f.page, { historySourceId: () => '17', historySeriesId: () => 'series',
    historyTitleId: () => 'owned-title', getResumeOffset: value => value,
    getGatewayResumePlan: value => ({target:value,sessionStart:value}),
    app: { pages: { watch: { play: async content => { painted = content; } } } } });
  await f.page.resumeEpisodeFromHistory({...history,item_type:'episode'});
  assert.equal(painted.description, 'Synopsis français'); assert.equal(painted.year, 1997);
  assert.equal(painted.rating, 4.75); assert.equal(painted.id, 'file');
  assert.equal(painted.seriesId, 'series'); assert.equal(painted.resumeTime, 75);
});

test('Home resume uses the same refreshed editorial snapshot without adding a metadata fetch', async () => {
  const f = page('HomePage'); let painted;
  Object.assign(f.page, { getResumeOffset: value => value, displayTitle: () => 'Titre actuel',
    typeLabel: () => 'Film', descriptionFromItem: item => item.data.description,
    app: { pages: { watch: { play: async content => { painted = content; } } } } });
  await f.page.playItem(history, true);
  assert.equal(painted.description, 'Synopsis français'); assert.equal(painted.year, 1997);
  assert.equal(painted.rating, 4.75); assert.equal(painted.id, 'file');
  assert.equal(painted.sourceId, '17'); assert.equal(painted.resumeTime, 75);
});
