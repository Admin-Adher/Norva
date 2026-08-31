const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'pages', 'MoviesPage.js'),
  'utf8'
);
const context = { window: {}, console, setTimeout, clearTimeout };
vm.runInNewContext(source, context, { filename: 'MoviesPage.js' });
const page = Object.create(context.window.MoviesPage.prototype);

test('movie progress is keyed by provider source and stream id', () => {
  page.watchState = new Map([
    ['source-a:42', { sourceId: 'source-a', progress: 300, duration: 1000, ratio: 0.3 }],
    ['source-b:42', { sourceId: 'source-b', progress: 800, duration: 1000, ratio: 0.8 }],
  ]);

  assert.equal(page._watchStateFor({ sourceId: 'source-a', stream_id: '42' }).progress, 300);
  assert.equal(page._watchStateFor({ sourceId: 'source-b', stream_id: '42' }).progress, 800);
  assert.equal(page._watchStateFor({ sourceId: 'source-c', stream_id: '42' }), null);
});

test('In Progress and Watched use the same 95 percent boundary', () => {
  page.getResumeOffset = context.window.MoviesPage.prototype.getResumeOffset;
  page.watchState = new Map([
    ['source-a:90', { sourceId: 'source-a', progress: 900, duration: 1000, ratio: 0.9, completed: false }],
    ['source-a:95', { sourceId: 'source-a', progress: 950, duration: 1000, ratio: 0.95, completed: false }],
  ]);

  assert.equal(page.getMovieWatchState({ sourceId: 'source-a', stream_id: '90' }).status, 'inprogress');
  assert.equal(page.getMovieWatchState({ sourceId: 'source-a', stream_id: '95' }).status, 'watched');
  assert.equal(page.getWatchStatus([{ sourceId: 'source-a', stream_id: '90' }]).status, 'inprogress');
  assert.equal(page.getWatchStatus([{ sourceId: 'source-a', stream_id: '95' }]).status, 'watched');
});

test('an explicit completed flag wins even with a short progress row', () => {
  page.watchState = new Map([
    ['source-a:7', { sourceId: 'source-a', progress: 30, duration: 1000, ratio: 0.03, completed: true }],
  ]);
  assert.equal(page.getMovieWatchState({ sourceId: 'source-a', stream_id: '7' }).status, 'watched');
});

test('group details and Play select the actually in-progress provider version', () => {
  page.getResumeOffset = context.window.MoviesPage.prototype.getResumeOffset;
  page.watchState = new Map([
    ['source-a:11', {
      sourceId: 'source-a', progress: 400, duration: 1000, ratio: 0.4,
      updatedAt: '2026-07-19T10:00:00Z'
    }],
    ['source-b:22', {
      sourceId: 'source-b', progress: 700, duration: 1000, ratio: 0.7,
      updatedAt: '2026-07-19T11:00:00Z'
    }],
  ]);
  const preferred = { sourceId: 'source-c', stream_id: '33' };
  const older = { sourceId: 'source-a', stream_id: '11' };
  const latest = { sourceId: 'source-b', stream_id: '22' };

  assert.equal(page._selectInProgressVersion([preferred, older, latest]), latest);
});

test('an exit progress capture updates the open movie fiche to Resume immediately', () => {
  const label = { textContent: 'Play' };
  const fill = { style: {} };
  let progressHidden = true;
  let continueRenders = 0;
  Object.assign(page, {
    historyItems: [],
    watchState: new Map(),
    currentMovie: { sourceId: 'source-a', stream_id: '42' },
    primaryActionBtn: {
      querySelector: (selector) => selector === '[data-movie-action-label]' ? label : null,
    },
    detailProgressEl: {
      classList: { toggle: (_name, hidden) => { progressHidden = hidden; } },
      querySelector: () => fill,
    },
    renderContinueWatching: () => { continueRenders += 1; },
  });

  const applied = page.applyPlaybackProgress({
    itemId: '42',
    itemType: 'movie',
    sourceId: 'source-a',
    progress: 120,
    duration: 600,
    watchedAt: '2026-08-31T10:00:00.000Z',
    data: { title: 'Movie' },
  });

  assert.equal(applied, true);
  assert.equal(page.watchState.get('source-a:42').progress, 120);
  assert.equal(page.historyItems[0].progress, 120);
  assert.equal(label.textContent, 'Resume');
  assert.equal(progressHidden, false);
  assert.equal(fill.style.width, '20%');
  assert.equal(continueRenders, 1);
});

test('a newer watch-state read cannot be overwritten by an older in-flight response', async () => {
  const resolvers = [];
  context.API = {
    history: {
      getAll: () => new Promise(resolve => resolvers.push(resolve)),
    },
  };
  const racePage = Object.create(context.window.MoviesPage.prototype);
  Object.assign(racePage, {
    sources: [{ id: 'source-a' }],
    watchState: new Map(),
    historyItems: [],
    _watchStateRequestId: 0,
  });

  const older = racePage.loadWatchState();
  const newer = racePage.loadWatchState();
  resolvers[1]([{
    item_type: 'movie', item_id: '42', source_id: 'source-a',
    progress: 180, duration: 600, updated_at: '2026-08-31T10:01:00.000Z', data: {},
  }]);
  assert.equal(await newer, true);
  resolvers[0]([]);
  assert.equal(await older, false);

  assert.equal(racePage.watchState.get('source-a:42').progress, 180);
  assert.equal(racePage.historyItems.length, 1);
});

test('pending audio metadata stays out of the consumer catalogue', () => {
  assert.equal(page.displayLanguageStatus('Audio pending'), '');
  assert.equal(page.displayLanguageStatus('Identifying audio'), '');
  assert.equal(page.displayLanguageStatus('French'), 'French');
});

test('movie playback never turns a missing saved audio index into stream zero', async () => {
  const playbackHints = [];
  context.MediaUtils = {
    playbackHintFromItem: (_movie, { container }) => ({ container }),
    versionLabel: () => 'Test version',
    safeImageUrl: (value) => value,
    tmdbPosterUrl: () => null,
    normalizeLanguagePreference: (value) => value,
  };
  context.API = {
    proxy: {
      xtream: {
        getStreamUrl: async (_sourceId, _streamId, _type, _container, hint) => {
          playbackHints.push(hint);
          return { url: 'https://gateway.test/session/playlist.m3u8' };
        },
      },
    },
  };

  const moviePage = Object.create(context.window.MoviesPage.prototype);
  const watch = {
    play: async (_content, resolver) => resolver(),
  };
  moviePage.app = { pages: { watch } };
  moviePage.prepareForPlaybackSession = async () => {};
  moviePage.getMovieDisplayTitle = (movie) => movie.name;
  moviePage.getItemYear = () => 2026;
  moviePage.getSourceName = () => 'Test source';

  const movie = {
    sourceId: 'source-1',
    stream_id: 'movie-1',
    container_extension: 'mkv',
    stream_icon: 'poster.jpg',
    name: 'Test movie',
  };

  for (const missingIndex of [null, undefined]) {
    await moviePage.playMovie(movie, {
      playbackPreferences: { audio: { streamIndex: missingIndex } },
    });
    assert.equal(Object.hasOwn(playbackHints.at(-1), 'audioStreamIndex'), false);
  }

  await moviePage.playMovie(movie, {
    playbackPreferences: { audio: { streamIndex: 0 } },
  });
  assert.equal(playbackHints.at(-1).audioStreamIndex, 0,
    'a real stream index zero must remain selectable');
});

test('movie playback passes the normalized catalogue duration to the watch timeline', async () => {
  let watchContent = null;
  context.MediaUtils = {
    playbackHintFromItem: (_movie, { container }) => ({ container, durationSeconds: 5820 }),
    versionLabel: () => 'Test version',
    safeImageUrl: (value) => value,
    tmdbPosterUrl: () => null,
    normalizeLanguagePreference: (value) => value,
  };
  context.API = {
    proxy: {
      xtream: {
        getStreamUrl: async () => ({ url: 'https://gateway.test/session/playlist.m3u8' }),
      },
    },
  };

  const moviePage = Object.create(context.window.MoviesPage.prototype);
  const watch = {
    play: async (content, resolver) => {
      watchContent = content;
      await resolver();
    },
  };
  moviePage.app = { pages: { watch } };
  moviePage.prepareForPlaybackSession = async () => {};
  moviePage.getMovieDisplayTitle = (movie) => movie.name;
  moviePage.getItemYear = () => 2026;
  moviePage.getSourceName = () => 'Test source';

  await moviePage.playMovie({
    sourceId: 'source-1',
    stream_id: 'movie-1',
    container_extension: 'mkv',
    stream_icon: 'poster.jpg',
    name: 'Test movie',
    tmdb: { runtime: 12 },
  });

  assert.equal(watchContent.durationHint, 5820,
    'the provider/codec duration must win over an unrelated TMDB fallback');
});
