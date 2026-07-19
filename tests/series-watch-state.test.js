const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'pages', 'SeriesPage.js'),
  'utf8'
);
const context = {
  window: {},
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
};
vm.runInNewContext(source, context, { filename: 'SeriesPage.js' });
const SeriesPage = context.window.SeriesPage;

function makePage(series = { sourceId: 'source-a', series_id: 'series-7' }) {
  const page = Object.create(SeriesPage.prototype);
  page.currentSeries = series;
  page.historyItems = [];
  page.startedSeriesIds = new Set();
  return page;
}

function episodeHistory({
  sourceId = 'source-a',
  seriesId = 'series-7',
  episodeId = '42',
  progress = 0,
  duration = 1000,
  completed = false,
  updatedAt = '2026-07-19T12:00:00Z',
} = {}) {
  return {
    source_id: sourceId,
    item_type: 'episode',
    item_id: episodeId,
    progress,
    duration,
    completed,
    updated_at: updatedAt,
    data: { sourceId, seriesId },
  };
}

test('episode progress keys include provider source, series, and episode ids', () => {
  const page = makePage();

  assert.equal(
    page.episodeProgressKey('source-a', 'series-7', '42'),
    'source-a:series-7:42'
  );
  assert.notEqual(
    page.episodeProgressKey('source-a', 'series-7', '42'),
    page.episodeProgressKey('source-b', 'series-7', '42')
  );
});

test('series history cannot borrow a colliding episode id from another source or series', () => {
  const page = makePage();
  const expected = episodeHistory({ progress: 300 });
  page.historyItems = [
    expected,
    episodeHistory({ sourceId: 'source-b', progress: 800 }),
    episodeHistory({ seriesId: 'series-8', progress: 600 }),
  ];

  const map = page.getSeriesHistoryMap();
  assert.equal(map.size, 1);
  assert.equal(page.getEpisodeHistory(map, '42'), map.get('source-a:series-7:42'));
  assert.equal(page.getEpisodeHistory(map, '42').progress, 300);
});

test('In Progress uses the exact resume boundary: 12 seconds through under 95 percent', () => {
  const page = makePage();

  assert.equal(page.isEpisodeInProgress(episodeHistory({ progress: 11, duration: 7200 })), false);
  assert.equal(page.isEpisodeInProgress(episodeHistory({ progress: 12, duration: 7200 })), true);
  assert.equal(page.isEpisodeInProgress(episodeHistory({ progress: 20, duration: 7200 })), true);
  assert.equal(page.isEpisodeInProgress(episodeHistory({ progress: 949, duration: 1000 })), true);
  assert.equal(page.isEpisodeInProgress(episodeHistory({ progress: 950, duration: 1000 })), false);
  assert.equal(page.isEpisodeInProgress(episodeHistory({
    progress: 20,
    duration: 1000,
    completed: true,
  })), false);
});

test('featured episode resumes a short absolute position even below the old two-percent cutoff', () => {
  const page = makePage();
  page.historyItems = [
    episodeHistory({ episodeId: '1', progress: 20, duration: 7200 }),
  ];
  const map = page.getSeriesHistoryMap();
  const featured = page.getFeaturedEpisode([
    { seasonNum: '1', episodeNum: 1, episode: { id: '1' } },
    { seasonNum: '1', episodeNum: 2, episode: { id: '2' } },
  ], map);

  assert.equal(featured.episode.id, '1');
  assert.equal(featured.label, 'Resume S1:E1');
});

test('series-level Watching state is source-aware', () => {
  const page = makePage();
  page.startedSeriesIds = new Set(['source-a:series-7']);

  assert.equal(page.isGroupStarted([{ sourceId: 'source-a', series_id: 'series-7' }]), true);
  assert.equal(page.isGroupStarted([{ sourceId: 'source-b', series_id: 'series-7' }]), false);
});

test('loaded Watching keys include only genuinely resumable episodes', async () => {
  const page = makePage();
  page.sources = [{ id: 'source-a' }, { id: 'source-b' }];
  context.API = {
    history: {
      getAll: async () => [
        episodeHistory({ sourceId: 'source-a', progress: 20, duration: 7200 }),
        episodeHistory({ sourceId: 'source-b', progress: 11, duration: 7200 }),
        episodeHistory({
          sourceId: 'source-b',
          seriesId: 'series-8',
          progress: 950,
          duration: 1000,
        }),
      ],
    },
  };

  await page.loadWatchState();

  assert.deepEqual([...page.startedSeriesIds], ['source-a:series-7']);
});

test('marking an episode unwatched never deletes the same numeric id on another source', async () => {
  const page = makePage();
  page.historyItems = [
    episodeHistory({ sourceId: 'source-a', completed: true, progress: 1000 }),
    episodeHistory({ sourceId: 'source-b', completed: true, progress: 1000 }),
  ];
  const removals = [];
  context.API = {
    history: {
      remove: async (id, options) => removals.push({ id, options }),
    },
  };

  await page.setEpisodeWatched('42', '1', '1', false);

  assert.equal(page.historyItems.length, 1);
  assert.equal(page.historyItems[0].source_id, 'source-b');
  assert.equal(removals[0].options.sourceId, 'source-a');
  assert.equal(removals[0].options.itemType, 'episode');
  assert.equal(removals[0].options.itemId, '42');
});
