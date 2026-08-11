'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function fakeClassList() {
  const values = new Set();
  return {
    add: (...names) => names.forEach((name) => values.add(name)),
    remove: (...names) => names.forEach((name) => values.delete(name)),
    contains: (name) => values.has(name),
  };
}

function datasetFromAttributes(attributes) {
  const dataset = {};
  for (const match of attributes.matchAll(/data-([a-z-]+)="([^"]*)"/g)) {
    const key = match[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    dataset[key] = match[2];
  }
  return dataset;
}

class FakeContinueList {
  constructor() {
    this._html = '';
    this.cards = [];
  }

  set innerHTML(value) {
    this._html = String(value || '');
    this.cards = [...this._html.matchAll(/<div class="continue-card"([^>]*)>/g)]
      .map((match) => {
        const listeners = {};
        const attributes = new Map();
        return {
          dataset: datasetFromAttributes(match[1]),
          addEventListener: (type, listener) => { listeners[type] = listener; },
          click: () => listeners.click?.(),
          keydown: (key) => {
            const event = {
              key,
              defaultPrevented: false,
              preventDefault() { this.defaultPrevented = true; },
            };
            listeners.keydown?.(event);
            return event;
          },
          hasListener: (type) => typeof listeners[type] === 'function',
          querySelector: () => ({ textContent: 'title' }),
          setAttribute: (name, value) => { attributes.set(name, String(value)); },
          getAttribute: (name) => attributes.get(name) ?? null,
          tabIndex: -1,
        };
      });
  }

  get innerHTML() {
    return this._html;
  }

  querySelectorAll(selector) {
    return selector === '.continue-card' ? this.cards : [];
  }
}

function loadPage(file, className) {
  const context = {
    window: {},
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    MediaUtils: {
      cleanReleaseName: (value) => String(value || ''),
      escapeHtml: (value) => String(value ?? ''),
      safeImageUrl: (value, fallback = '') => value || fallback,
    },
  };
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  vm.runInNewContext(source, context, { filename: file });
  return context.window[className];
}

function movieHistory(overrides = {}) {
  return {
    item_type: 'movie',
    item_id: 'movie-1',
    source_id: '1',
    progress: 60,
    duration: 600,
    data: { title: 'Movie', sourceId: '1' },
    ...overrides,
  };
}

function episodeHistory(overrides = {}) {
  return {
    item_type: 'episode',
    item_id: 'episode-1',
    source_id: '1',
    progress: 60,
    duration: 600,
    data: { title: 'Series', sourceId: '1', seriesId: 'series-1' },
    ...overrides,
  };
}

function renderContinue(Page, histories, { isTv = false } = {}) {
  const page = Object.create(Page.prototype);
  const continueList = new FakeContinueList();
  Object.assign(page, {
    historyItems: histories,
    continueList,
    continueRow: { classList: fakeClassList() },
    updateContinueCompact: () => {},
    _isTvMode: () => isTv,
  });
  page.renderContinueWatching();
  return { page, continueList };
}

test('Movies Continue Watching resolves a provider-local item id with its source id', () => {
  const MoviesPage = loadPage('public/js/pages/MoviesPage.js', 'MoviesPage');
  const first = movieHistory({ source_id: '1', data: { title: 'Atlas', sourceId: '1' } });
  const second = movieHistory({ source_id: '2', data: { title: 'Ferran', sourceId: '2' } });
  const { page, continueList } = renderContinue(MoviesPage, [first, second]);
  let resumed = null;
  page.resumeFromHistory = (history) => { resumed = history; };

  continueList.cards[1].click();

  assert.equal(resumed?.source_id, '2');
  assert.equal(resumed?.item_id, 'movie-1');
});

for (const spec of [
  {
    name: 'Movies',
    file: 'public/js/pages/MoviesPage.js',
    className: 'MoviesPage',
    history: movieHistory,
    stableOverrides: (index) => ({
      item_id: `movie-${index}`,
      source_id: String(index),
      data: { title: `Unique ${index}`, sourceId: String(index), titleId: `title-${index}` },
    }),
    legacyOverrides: (index) => ({
      item_id: `legacy-movie-${index}`,
      source_id: '9',
      data: { title: `Legacy ${index}`, sourceId: '9' },
    }),
    resumeMethod: 'resumeFromHistory',
  },
  {
    name: 'Series',
    file: 'public/js/pages/SeriesPage.js',
    className: 'SeriesPage',
    history: episodeHistory,
    stableOverrides: (index) => ({
      item_id: `episode-${index}`,
      source_id: String(index),
      data: {
        title: `Unique ${index}`,
        sourceId: String(index),
        seriesId: `series-${index}`,
        titleId: `title-${index}`,
      },
    }),
    legacyOverrides: (index) => ({
      item_id: `legacy-episode-${index}`,
      source_id: '9',
      data: { title: `Legacy ${index}`, sourceId: '9', seriesId: 'legacy-series' },
    }),
    resumeMethod: 'resumeEpisodeFromHistory',
  },
]) {
  test(`${spec.name} Continue Watching deduplicates stable title ids before the 12-row limit`, () => {
    const Page = loadPage(spec.file, spec.className);
    const duplicateFirst = spec.history({
      ...spec.stableOverrides('first'),
      data: { ...spec.stableOverrides('first').data, title: 'Stable first', titleId: 'stable-title' },
    });
    const duplicateSecond = spec.history({
      ...spec.stableOverrides('second'),
      data: { ...spec.stableOverrides('second').data, title: 'Stable duplicate', titleId: 'stable-title' },
    });
    const unique = Array.from({ length: 11 }, (_, index) =>
      spec.history(spec.stableOverrides(index + 1)));

    const { continueList } = renderContinue(Page, [duplicateFirst, duplicateSecond, ...unique]);

    assert.equal(continueList.cards.length, 12);
    assert.match(continueList.innerHTML, /Unique 11/);
    assert.doesNotMatch(continueList.innerHTML, /Stable duplicate/);
  });

  test(`${spec.name} Continue Watching keeps legacy rows without titleId separate`, () => {
    const Page = loadPage(spec.file, spec.className);
    const histories = [1, 2].map((index) => spec.history(spec.legacyOverrides(index)));

    const { continueList } = renderContinue(Page, histories);

    assert.equal(continueList.cards.length, 2);
    assert.match(continueList.innerHTML, /Legacy 1/);
    assert.match(continueList.innerHTML, /Legacy 2/);
  });

  test(`${spec.name} Continue Watching cards expose one keyboard activation path on Web`, () => {
    const Page = loadPage(spec.file, spec.className);
    const history = spec.history(spec.stableOverrides('keyboard'));
    const { page, continueList } = renderContinue(Page, [history]);
    let resumed = null;
    let activationCount = 0;
    page[spec.resumeMethod] = (value) => {
      resumed = value;
      activationCount += 1;
    };

    const card = continueList.cards[0];
    assert.equal(card.tabIndex, 0);
    assert.equal(card.getAttribute('role'), 'button');
    assert.match(card.getAttribute('aria-label') || '', /Resume/i);

    const enter = card.keydown('Enter');
    assert.equal(enter.defaultPrevented, true);
    assert.equal(activationCount, 1);
    assert.equal(resumed, history);

    const space = card.keydown(' ');
    assert.equal(space.defaultPrevented, true);
    assert.equal(activationCount, 2);

    const arrow = card.keydown('ArrowRight');
    assert.equal(arrow.defaultPrevented, false);
    assert.equal(activationCount, 2);

    const { continueList: tvList } = renderContinue(Page, [history], { isTv: true });
    assert.equal(tvList.cards[0].hasListener('keydown'), false);
  });
}

test('WatchPage persists optional titleId inside rich history metadata', async () => {
  let request = null;
  const source = fs.readFileSync(path.join(ROOT, 'public/js/pages/WatchPage.js'), 'utf8');
  const context = {
    window: {
      API: { request: async (method, url, payload) => { request = { method, url, payload }; } },
    },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  vm.runInNewContext(source, context, { filename: 'public/js/pages/WatchPage.js' });
  const vmPage = Object.create(context.window.WatchPage.prototype);
  Object.assign(vmPage, {
    content: {
      id: 'movie-42',
      type: 'movie',
      sourceId: 'source-7',
      titleId: 'title-stable-42',
      title: 'Localized title',
    },
    video: { paused: false },
    getStablePlaybackDuration: () => 600,
    getDisplayDuration: () => 600,
    getResumeSnapshotPosition: () => 120,
    saveResumeSnapshot: () => {},
    getPlaybackPreferences: () => ({}),
    containerExtension: 'mp4',
    _historyMetaSentFor: null,
  });

  await vmPage.saveProgress({ force: true });

  assert.equal(request?.payload?.data?.titleId, 'title-stable-42');
});
