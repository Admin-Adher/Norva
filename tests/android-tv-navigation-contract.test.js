'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
const MOVIE_CATALOG_CARD_SELECTOR =
  '.movie-card, .genre-bucket-grid .dashboard-card';
const CATALOG_CARD_SELECTOR =
  `${MOVIE_CATALOG_CARD_SELECTOR}, .series-card`;

function jsFunction(source, name) {
  const signature = `function ${name}(`;
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `missing JavaScript function: ${name}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(`unterminated JavaScript function: ${name}`);
}

function item(id, x) {
  return {
    id,
    x,
    disabled: false,
    closest: () => null
  };
}

function row(items) {
  return {
    contains: (candidate) => items.includes(candidate),
    querySelectorAll: (selector) => {
      assert.equal(selector, '*');
      return items;
    }
  };
}

function navigationFixture(pageId) {
  const primary = [
    item(`${pageId}-source`, 288),
    item(`${pageId}-category`, 510),
    item(`${pageId}-year`, 711),
    item(`${pageId}-rating`, 880),
    item(`${pageId}-audio`, 1056),
    item(`${pageId}-subtitle`, 1247)
  ];
  const secondary = [
    item(`${pageId}-watched`, 289),
    item(`${pageId}-added`, 477),
    item(`${pageId}-favorites`, 656),
    item(`${pageId}-group`, 862),
    item(`${pageId}-reset`, 1090)
  ];
  const rows = [row(primary), row(secondary)];
  return {
    page: {
      id: `page-${pageId}`,
      querySelectorAll: (selector) => {
        assert.equal(
          selector,
          pageId === 'series' ? '.tv-series-filter-row' : '.tv-movies-filter-row'
        );
        return rows;
      }
    },
    primary,
    secondary
  };
}

function loadCatalogStep(fixture) {
  const source = read('public/js/utils/tvNavigation.js');
  const functions = [
    'catalogFilterRows',
    'nearestCatalogFilterItem',
    'catalogFilterStep'
  ].map((name) => jsFunction(source, name)).join('\n');
  const context = {
    activePage: () => fixture.page,
    isVisible: () => true,
    isRendered: () => true,
    centerOf: (candidate) => ({ x: candidate.x, y: 0 }),
    INTERACTIVE_SELECTOR: '*'
  };
  vm.runInNewContext(`${functions}\nthis.catalogFilterStep = catalogFilterStep;`, context);
  return context.catalogFilterStep;
}

function loadCatalogRegionStep() {
  const source = read('public/js/utils/tvNavigation.js');
  const functions = [
    'nearestCatalogFilterItem',
    'catalogRegionStep'
  ].map((name) => jsFunction(source, name)).join('\n');
  const context = {
    centerOf: (candidate) => ({ x: candidate.x, y: 0 })
  };
  vm.runInNewContext(`${functions}\nthis.catalogRegionStep = catalogRegionStep;`, context);
  return context.catalogRegionStep;
}

function degradedCatalogFixture(pageId, renderedStateSelector, withCard = false) {
  const kind = pageId === 'series' ? 'series' : 'movies';
  const cardSelector = pageId === 'series'
    ? '.series-card'
    : MOVIE_CATALOG_CARD_SELECTOR;
  const stateSelector = pageId === 'series'
    ? '[data-series-retry], #series-empty-reset'
    : '[data-movies-retry], #movies-empty-reset';
  const primary = [item(`${pageId}-source`, 280), item(`${pageId}-category`, 520)];
  const secondary = [item(`${pageId}-watched`, 280), item(`${pageId}-reset`, 1080)];
  const search = item(`${pageId}-search`, 980);
  const toolbarAction = item(`${pageId}-sort`, 1080);
  const stateAction = item(`${pageId}-state-action`, 700);
  const card = item(`${pageId}-card`, 320);
  const rail = item(`${pageId}-rail`, 40);
  const rows = [row(primary), row(secondary)];
  const toolbar = {
    querySelectorAll: (selector) => {
      assert.equal(selector, '*');
      return [toolbarAction];
    }
  };
  const grid = {
    querySelectorAll: (selector) => {
      if (selector === cardSelector) return withCard ? [card] : [];
      if (selector === stateSelector) {
        assert.equal(selector.split(', ').includes(renderedStateSelector), true);
        return [stateAction];
      }
      assert.fail(`unexpected degraded catalogue selector: ${selector}`);
    }
  };
  const page = {
    id: `page-${pageId}`,
    querySelectorAll: (selector) => {
      if (selector === CATALOG_CARD_SELECTOR) {
        return withCard ? [card] : [];
      }
      assert.equal(
        selector,
        pageId === 'series' ? '.tv-series-filter-row' : '.tv-movies-filter-row'
      );
      return rows;
    },
    querySelector: (selector) => {
      if (selector === `#${kind}-search`) return search;
      if (selector === `#${kind}-tv-catalog-head`) return toolbar;
      if (selector === `#${kind}-continue`) return null;
      if (selector === `#${kind}-grid`) return grid;
      assert.fail(`unexpected degraded catalogue host: ${selector}`);
    },
    contains: (candidate) =>
      [search, ...primary, ...secondary, toolbarAction, stateAction, card].includes(candidate)
  };
  return { page, search, primary, secondary, toolbarAction, stateAction, card, rail };
}

function moviesBucketCatalogFixture() {
  const search = item('movies-search', 980);
  const primary = [item('movies-source', 280), item('movies-category', 520)];
  const secondary = [item('movies-watched', 280), item('movies-added', 480)];
  const resume = item('movies-continue-card', 480);
  const chip = item('movies-category-chip', 480);
  const bucketCard = item('movies-bucket-dashboard-card', 320);
  const rail = item('movies-rail', 40);
  const rows = [row(primary), row(secondary)];
  const toolbar = {
    querySelectorAll: (selector) => {
      assert.equal(selector, '*');
      return [chip];
    }
  };
  const continueRow = {
    querySelectorAll: (selector) => {
      assert.equal(selector, '.continue-card');
      return [resume];
    }
  };
  const grid = {
    querySelectorAll: (selector) => {
      assert.equal(selector, MOVIE_CATALOG_CARD_SELECTOR);
      // This is the exact MoviesPage.openBucket renderer: GenreRails emits a
      // dashboard-card and no flat `.movie-card`.
      return [bucketCard];
    }
  };
  const page = {
    id: 'page-movies',
    querySelectorAll: (selector) => {
      assert.equal(selector, '.tv-movies-filter-row');
      return rows;
    },
    querySelector: (selector) => {
      if (selector === '#movies-search') return search;
      if (selector === '#movies-tv-catalog-head') return toolbar;
      if (selector === '#movies-continue') return continueRow;
      if (selector === '#movies-grid') return grid;
      assert.fail(`unexpected Movies bucket host: ${selector}`);
    },
    contains: (candidate) =>
      [search, ...primary, ...secondary, resume, chip, bucketCard].includes(candidate)
  };
  return { page, search, primary, secondary, resume, chip, bucketCard, rail };
}

function loadCatalogGraph(fixture) {
  const source = read('public/js/utils/tvNavigation.js');
  const functions = [
    'catalogFilterRows',
    'nearestCatalogFilterItem',
    'catalogRegionItems',
    'catalogGraphRegions',
    'catalogRegionStep',
    'catalogGraphMove',
    'catalogSearchVerticalTarget'
  ].map((name) => jsFunction(source, name)).join('\n');
  const context = {
    activePage: () => fixture.page,
    isRendered: () => true,
    centerOf: (candidate) => ({ x: candidate.x, y: 0 }),
    INTERACTIVE_SELECTOR: '*',
    MOVIE_CATALOG_CARD_SELECTOR,
    CATALOG_CARD_SELECTOR,
    catalogHeaderOrigins: new WeakMap(),
    gridCardAbove: () => null,
    gridCardBelow: () => null,
    catalogFilterTarget: () => null,
    activeNavbarTarget: () => fixture.rail
  };
  vm.runInNewContext(
    `${functions}
this.catalogGraphRegions = catalogGraphRegions;
this.catalogGraphMove = catalogGraphMove;
this.catalogSearchVerticalTarget = catalogSearchVerticalTarget;`,
    context
  );
  return context;
}

function loadCatalogPageEntry(fixture) {
  const source = read('public/js/utils/tvNavigation.js');
  const functions = [
    'pageDefaultTarget',
    'rememberedPageTarget',
    'pageEntryTarget'
  ].map((name) => jsFunction(source, name)).join('\n');
  const context = {
    pageFocusMemory: new Map(),
    CATALOG_CARD_SELECTOR,
    isVisible: () => true,
    isRendered: () => true,
    getPageCandidates: () => [fixture.card],
    firstNonTextCandidate: (items) => items[0] || null
  };
  vm.runInNewContext(`${functions}\nthis.pageEntryTarget = pageEntryTarget;`, context);
  return context;
}

for (const pageId of ['movies', 'series']) {
  test(`Android TV ${pageId} filters have deterministic four-way D-pad navigation`, () => {
    const fixture = navigationFixture(pageId);
    const step = loadCatalogStep(fixture);
    const [source, category, year, rating, audio, subtitle] = fixture.primary;
    const [watched, added, favorites, group, reset] = fixture.secondary;

    // Primary row: explicitly guard the user-reported Sources <-> Categories
    // regression, then every adjacent filter in both directions.
    assert.equal(step(source, 'ArrowRight'), category);
    assert.equal(step(category, 'ArrowRight'), year);
    assert.equal(step(year, 'ArrowRight'), rating);
    assert.equal(step(rating, 'ArrowRight'), audio);
    assert.equal(step(audio, 'ArrowRight'), subtitle);
    assert.equal(step(subtitle, 'ArrowLeft'), audio);
    assert.equal(step(audio, 'ArrowLeft'), rating);
    assert.equal(step(rating, 'ArrowLeft'), year);
    assert.equal(step(year, 'ArrowLeft'), category);
    assert.equal(step(category, 'ArrowLeft'), source);

    assert.equal(step(watched, 'ArrowRight'), added);
    assert.equal(step(added, 'ArrowRight'), favorites);
    assert.equal(step(favorites, 'ArrowRight'), group);
    assert.equal(step(group, 'ArrowRight'), reset);
    assert.equal(step(reset, 'ArrowLeft'), group);
    assert.equal(step(group, 'ArrowLeft'), favorites);
    assert.equal(step(favorites, 'ArrowLeft'), added);
    assert.equal(step(added, 'ArrowLeft'), watched);

    assert.equal(step(fixture.primary[0], 'ArrowDown'), watched);
    assert.equal(step(fixture.primary[1], 'ArrowDown'), added);
    assert.equal(step(fixture.primary[2], 'ArrowDown'), favorites);
    assert.equal(step(fixture.primary[3], 'ArrowDown'), group);
    assert.equal(step(fixture.primary[4], 'ArrowDown'), reset);
    assert.equal(step(fixture.primary[5], 'ArrowDown'), reset);
    assert.equal(step(watched, 'ArrowUp'), fixture.primary[0]);
    assert.equal(step(added, 'ArrowUp'), fixture.primary[1]);
    assert.equal(step(favorites, 'ArrowUp'), fixture.primary[2]);
    assert.equal(step(group, 'ArrowUp'), fixture.primary[3]);
    assert.equal(step(reset, 'ArrowUp'), fixture.primary[4]);

    // Boundary nulls intentionally fall through to rail/content/preview rules.
    assert.equal(step(source, 'ArrowLeft'), null);
    assert.equal(step(subtitle, 'ArrowRight'), null);
    assert.equal(step(watched, 'ArrowLeft'), null);
    assert.equal(step(reset, 'ArrowRight'), null);
    assert.equal(step(fixture.primary[0], 'ArrowUp'), null);
    assert.equal(step(reset, 'ArrowDown'), null);
  });
}

for (const state of [
  { pageId: 'movies', label: 'error', selector: '[data-movies-retry]' },
  { pageId: 'movies', label: 'empty', selector: '#movies-empty-reset' },
  { pageId: 'series', label: 'error', selector: '[data-series-retry]' },
  { pageId: 'series', label: 'empty', selector: '#series-empty-reset' }
]) {
  test(`Android TV ${state.pageId} ${state.label} CTA is a reversible catalogue stop`, () => {
    const fixture = degradedCatalogFixture(state.pageId, state.selector);
    const graph = loadCatalogGraph(fixture);
    const regions = graph.catalogGraphRegions();
    assert.deepEqual(
      Array.from(regions, ({ name }) => name),
      ['header', 'primary', 'secondary', 'toolbar', 'state']
    );
    assert.equal(regions.at(-1).items[0], fixture.stateAction);

    const down = graph.catalogGraphMove(fixture.toolbarAction, 'ArrowDown');
    assert.equal(down.handled, true);
    assert.equal(down.target, fixture.stateAction);

    const up = graph.catalogGraphMove(fixture.stateAction, 'ArrowUp');
    assert.equal(up.handled, true);
    assert.equal(up.target, fixture.toolbarAction);

    for (const direction of ['ArrowLeft', 'ArrowRight', 'ArrowDown']) {
      const boundary = graph.catalogGraphMove(fixture.stateAction, direction);
      assert.equal(boundary.handled, true);
      assert.equal(boundary.target, null);
    }
  });
}

test('Android TV degraded state nodes never replace a populated Movies or Series grid', () => {
  for (const [pageId, selector] of [
    ['movies', '[data-movies-retry]'],
    ['series', '[data-series-retry]']
  ]) {
    const fixture = degradedCatalogFixture(pageId, selector, true);
    const regions = loadCatalogGraph(fixture).catalogGraphRegions();
    assert.equal(regions.some(({ name }) => name === 'state'), false);
    assert.equal(regions.at(-1).name, 'grid');
    assert.equal(regions.at(-1).items[0], fixture.card);
  }
});

test('Android TV Movies category bucket connects Continue and its chip to the dashboard grid', () => {
  const fixture = moviesBucketCatalogFixture();
  const graph = loadCatalogGraph(fixture);
  const regions = graph.catalogGraphRegions();
  assert.deepEqual(
    Array.from(regions, ({ name }) => name),
    ['header', 'primary', 'secondary', 'continue', 'toolbar', 'grid']
  );
  assert.equal(regions.at(-1).items[0], fixture.bucketCard);

  const toChip = graph.catalogGraphMove(fixture.resume, 'ArrowDown');
  assert.equal(toChip.handled, true);
  assert.equal(toChip.target, fixture.chip);

  // Re-evaluating the same physical command must remain deterministic; this is
  // the runtime regression where focus previously stayed on "13 categories".
  for (let press = 0; press < 2; press += 1) {
    const toGrid = graph.catalogGraphMove(fixture.chip, 'ArrowDown');
    assert.equal(toGrid.handled, true);
    assert.equal(toGrid.target, fixture.bucketCard);
  }

  const backToChip = graph.catalogGraphMove(fixture.bucketCard, 'ArrowUp');
  assert.equal(backToChip.handled, true);
  assert.equal(backToChip.target, fixture.chip);
});

for (const [pageId, stateSelector] of [
  ['movies', '[data-movies-retry]'],
  ['series', '[data-series-retry]']
]) {
  test(`Android TV ${pageId} rail/card path reaches Search and returns exactly`, () => {
    const fixture = degradedCatalogFixture(pageId, stateSelector, true);
    const graph = loadCatalogGraph(fixture);
    const entry = loadCatalogPageEntry(fixture);

    // A fresh rail entry keeps the Netflix-style content-first landing.
    assert.equal(entry.pageEntryTarget(fixture.page), fixture.card);

    // Card -> toolbar -> secondary -> primary -> Search is one complete,
    // deterministic upward path.
    let focused = fixture.card;
    const upwardStops = [];
    for (let index = 0; index < 4; index += 1) {
      const move = graph.catalogGraphMove(focused, 'ArrowUp');
      assert.equal(move.handled, true);
      assert.ok(move.target);
      focused = move.target;
      upwardStops.push(focused);
    }
    const primaryOrigin = upwardStops[2];
    assert.equal(focused, fixture.search);

    // Search Up exits to the active rail. Returning from that rail restores the
    // exact Search stop instead of resetting to the first card.
    assert.equal(
      graph.catalogSearchVerticalTarget(fixture.search, 'ArrowUp'),
      fixture.rail
    );
    entry.pageFocusMemory.set(fixture.page.id, { element: fixture.search, key: null });
    assert.equal(entry.pageEntryTarget(fixture.page), fixture.search);

    // Search Down returns to the exact primary filter that opened it, then the
    // semantic graph remains reversible all the way back to the same card.
    focused = graph.catalogSearchVerticalTarget(fixture.search, 'ArrowDown');
    assert.equal(focused, primaryOrigin);
    for (let index = 0; index < 3; index += 1) {
      const move = graph.catalogGraphMove(focused, 'ArrowDown');
      assert.equal(move.handled, true);
      assert.ok(move.target);
      focused = move.target;
    }
    assert.equal(focused, fixture.card);

    // The one-control header never leaks a horizontal press into geometric
    // navigation; the input's caret/boundary rules own Left and Right.
    for (const direction of ['ArrowLeft', 'ArrowRight']) {
      const move = graph.catalogGraphMove(fixture.search, direction);
      assert.equal(move.handled, true);
      assert.equal(move.target, null);
    }
  });
}

test('Android TV catalogue bands form a deterministic premium focus graph', () => {
  const step = loadCatalogRegionStep();
  const header = [item('search', 880)];
  const primary = [item('source', 280), item('category', 520), item('audio', 1080)];
  const secondary = [item('watched', 280), item('favorites', 640), item('reset', 1090)];
  const toolbar = [item('active-filter', 560), item('sort', 1110)];
  const resume = [item('continue-1', 310), item('continue-2', 690)];
  const grid = [item('grid-1', 300), item('grid-2', 540), item('grid-3', 780)];
  const regions = [
    { name: 'header', items: header },
    { name: 'primary', items: primary },
    { name: 'secondary', items: secondary },
    { name: 'continue', items: resume },
    { name: 'toolbar', items: toolbar },
    { name: 'grid', items: grid }
  ];

  // Every semantic band follows its actual top-to-bottom paint order and is
  // reachable in both directions while preserving the nearest visual column.
  assert.equal(step(regions, header[0], 'ArrowDown'), primary[2]);
  assert.equal(step(regions, primary[2], 'ArrowUp'), header[0]);
  assert.equal(step(regions, primary[0], 'ArrowDown'), secondary[0]);
  assert.equal(step(regions, secondary[0], 'ArrowDown'), resume[0]);
  assert.equal(step(regions, resume[0], 'ArrowDown'), toolbar[0]);
  assert.equal(step(regions, toolbar[0], 'ArrowDown'), grid[1]);
  assert.equal(step(regions, grid[1], 'ArrowUp'), toolbar[0]);
  assert.equal(step(regions, toolbar[0], 'ArrowUp'), resume[1]);
  assert.equal(step(regions, resume[1], 'ArrowUp'), secondary[1]);
  assert.equal(step(regions, secondary[1], 'ArrowUp'), primary[1]);

  // Horizontal bands use visual DOM order and stop cleanly at their edges.
  assert.equal(step(regions, toolbar[0], 'ArrowRight'), toolbar[1]);
  assert.equal(step(regions, toolbar[1], 'ArrowLeft'), toolbar[0]);
  assert.equal(step(regions, resume[0], 'ArrowRight'), resume[1]);
  assert.equal(step(regions, resume[1], 'ArrowRight'), null);
  assert.equal(step(regions, header[0], 'ArrowUp'), null);
  assert.equal(step(regions, grid[0], 'ArrowDown'), null);
});

test('Android TV routes grid Up through catalogue bands, never through the global menu', () => {
  const source = read('public/js/utils/tvNavigation.js');
  assert.match(source, /const graphMove = catalogGraphMove\(focused, e\.key\);/);
  assert.match(
    source,
    /region\.name === 'grid'[\s\S]*direction === 'ArrowUp'[\s\S]*gridCardAbove\(focused\)[\s\S]*catalogRegionStep\(regions, focused, direction\)/
  );
  assert.doesNotMatch(source, /UP_DOUBLE_TAP_MS|upFreshCount|prevUpDownAt/);
});

test('Android TV never throttles a distinct or released D-pad command', () => {
  const source = read('public/js/utils/tvNavigation.js');
  const context = {};
  vm.runInNewContext(
    `${jsFunction(source, 'isHeldNavRepeat')}\nthis.isHeldNavRepeat = isHeldNavRepeat;`,
    context
  );

  // Right then Left rapidly is two commands, even without a keyup between them.
  assert.equal(context.isHeldNavRepeat('ArrowLeft', 'ArrowRight', false, true), false);
  // A released key pressed again is also a distinct command.
  assert.equal(context.isHeldNavRepeat('ArrowRight', 'ArrowRight', true, true), false);
  // Only an unreleased repeat of the same direction in a burst is throttled.
  assert.equal(context.isHeldNavRepeat('ArrowRight', 'ArrowRight', false, true), true);
  assert.equal(context.isHeldNavRepeat('ArrowRight', 'ArrowRight', false, false), false);

  assert.match(source, /heldNavRepeat = !queuedReplay && isHeldNavRepeat\(/);
  assert.match(source, /if \(isArrow && heldNavRepeat && !isTextField\(focused\)\)/);
  assert.match(
    source,
    /queueHeldNavRepeat\(e\.key, NAV_THROTTLE_MS - \(nowMs - lastNavMoveAt\)\)/
  );
  assert.match(source, /Object\.defineProperty\(replay, '__norvaQueuedNav'/);
  assert.match(source, /lastNavDirectionReleased = queuedReplay;/);
  assert.match(
    source,
    /if \(e\.key !== lastNavDirection\) return;\s*lastNavDirectionReleased = true;\s*cancelQueuedNavRepeat\(\);/
  );
});

test('Android TV Live TV always escapes to the rail while loading', () => {
  const source = read('public/js/utils/tvNavigation.js');
  assert.match(
    source,
    /focused\.id === 'channel-search' && e\.key === 'ArrowLeft'[\s\S]*focusActiveNavbar\(\)/
  );
  assert.match(
    source,
    /focused\.closest\('#page-live \.channel-sidebar'\)[\s\S]*focused === controls\[0\][\s\S]*focusActiveNavbar\(\)/
  );
  assert.match(
    source,
    /page\?\.id === 'page-live' && !document\.activeElement\?\.closest\?\.\('\.navbar'\)[\s\S]*focusActiveNavbar\(\)/
  );
});

test('Android TV Settings enters Account instead of a geometrically aligned advanced tab', () => {
  const source = read('public/js/utils/tvNavigation.js');
  assert.match(
    source,
    /page\.id === 'page-settings'[\s\S]*el\.dataset\.tab === 'account'/
  );
  assert.match(
    source,
    /function preparePageEntry\(page\)[\s\S]*tab\[data-tab="account"\][\s\S]*account\.click\(\)[\s\S]*page\.scrollTop = 0/
  );
  assert.match(
    source,
    /focused\.matches\?\.\('\.nav-link\.active'\)[\s\S]*pageEntryTarget\(activePage\(\)\)[\s\S]*focusElement\(entry\)/
  );
});

test('Android TV rail keeps a hard left boundary after Settings tab scrolling', () => {
  const source = read('public/js/utils/tvNavigation.js');
  assert.match(
    source,
    /e\.key === 'ArrowLeft' && focused\.closest\('\.navbar'\)[\s\S]*return;[\s\S]*Right from the rail crosses into the page content/
  );
});

test('Android TV rail re-entry activates the Account panel before focusing its tab', () => {
  const source = read('public/js/utils/tvNavigation.js');
  const functions = [
    'pageDefaultTarget',
    'preparePageEntry',
    'pageEntryTarget'
  ].map((name) => jsFunction(source, name)).join('\n');

  const classList = (...initial) => {
    const values = new Set(initial);
    return {
      contains: (name) => values.has(name),
      toggle: (name, force) => {
        if (force) values.add(name);
        else values.delete(name);
      }
    };
  };
  const tab = (name, active = false) => ({
    dataset: { tab: name },
    classList: classList(...(active ? ['active'] : [])),
    setAttribute(name, value) { this[name] = value; },
    click() { throw new Error('controller path should activate Settings'); }
  });
  const panel = (name, active = false) => ({
    id: `tab-${name}`,
    scrollTop: 420,
    classList: classList(...(active ? ['active'] : [])),
    setAttribute(attribute, value) { this[attribute] = value; }
  });

  const accountTab = tab('account');
  const transcodeTab = tab('transcode', true);
  const accountPanel = panel('account');
  const transcodePanel = panel('transcode', true);
  const tabs = [accountTab, transcodeTab];
  const panels = [accountPanel, transcodePanel];
  const container = { scrollTop: 360 };
  const page = {
    id: 'page-settings',
    scrollTop: 720,
    querySelector: (selector) => {
      if (selector.includes('tab[data-tab="account"]')) return accountTab;
      if (selector === '#tab-account.tab-content') return accountPanel;
      if (selector === '.settings-container') return container;
      return null;
    },
    querySelectorAll: (selector) => selector.includes('.tabs .tab') ? tabs : panels
  };
  const activations = [];
  const context = {
    isRendered: () => true,
    window: {
      app: {
        pages: {
          settings: {
            switchTab: (name) => {
              activations.push(name);
              tabs.forEach((candidate) =>
                candidate.classList.toggle('active', candidate.dataset.tab === name));
              panels.forEach((candidate) =>
                candidate.classList.toggle('active', candidate.id === `tab-${name}`));
            }
          }
        }
      }
    }
  };
  vm.runInNewContext(`${functions}\nthis.pageEntryTarget = pageEntryTarget;`, context);

  const target = context.pageEntryTarget(page);
  assert.equal(target, accountTab);
  assert.deepEqual(activations, ['account']);
  assert.equal(accountTab.classList.contains('active'), true);
  assert.equal(accountPanel.classList.contains('active'), true);
  assert.equal(transcodeTab.classList.contains('active'), false);
  assert.equal(transcodePanel.classList.contains('active'), false);
  assert.equal(page.scrollTop, 0);
  assert.equal(container.scrollTop, 0);
  assert.equal(accountPanel.scrollTop, 0);
});

test('Android TV Settings keeps vertical focus inside its active panel', () => {
  const source = read('public/js/utils/tvNavigation.js');
  assert.match(source, /INTERACTIVE_SELECTOR[\s\S]*\.settings-advanced-summary/);
  const functions = [
    'centerOf',
    'hasMeaningfulVerticalOverlap',
    'settingsPanelCandidates',
    'settingsHorizontalTarget',
    'settingsVerticalTarget',
    'settingsGraphMove'
  ].map((name) => jsFunction(source, name)).join('\n');

  const classList = (...names) => {
    const values = new Set(names);
    return { contains: (name) => values.has(name) };
  };
  const control = (id, left, top, width, height, { tab = false, active = false } = {}) => {
    const element = {
      id,
      classList: classList(...(active ? ['active'] : [])),
      getBoundingClientRect: () => ({
        left,
        top,
        right: left + width,
        bottom: top + height,
        width,
        height
      })
    };
    element.closest = (selector) =>
      tab && selector === '.settings-container > .tabs .tab' ? element : null;
    return element;
  };

  const accountTab = control('account-tab', 140, 80, 120, 40, { tab: true, active: true });
  const screensTab = control('screens-tab', 270, 80, 160, 40, { tab: true });
  const service = control('manage-service', 735, 200, 118, 44);
  const switchProfile = control('switch-profile', 667, 340, 109, 44);
  const signOut = control('sign-out', 784, 340, 77, 44);
  const support = control('support', 740, 480, 123, 44);
  const cookie = control('cookies', 281, 620, 82, 20);
  const privacy = control('privacy', 561, 600, 116, 44);
  const terms = control('terms', 682, 600, 70, 44);
  const legal = control('legal', 757, 600, 105, 44);
  const panelControls = [
    service,
    switchProfile,
    signOut,
    support,
    cookie,
    privacy,
    terms,
    legal
  ];
  const tabs = [accountTab, screensTab];
  const tabsHost = {
    contains: (element) => tabs.includes(element),
    querySelectorAll: (selector) => {
      assert.equal(selector, '.tab');
      return tabs;
    }
  };
  const panel = {
    contains: (element) => panelControls.includes(element),
    querySelectorAll: (selector) => {
      assert.equal(selector, '*');
      return panelControls;
    }
  };
  const page = {
    id: 'page-settings',
    contains: (element) => tabs.includes(element) || panelControls.includes(element),
    querySelector: (selector) => {
      if (selector === '.settings-container > .tabs') return tabsHost;
      if (selector === '.tab-content.active') return panel;
      return null;
    }
  };
  const railBell = control('nav-bell', 22, 680, 38, 38);
  const context = {
    INTERACTIVE_SELECTOR: '*',
    activePage: () => page,
    activeNavbarTarget: () => railBell,
    isRendered: () => true,
    getComputedStyle: () => ({ opacity: '1', visibility: 'visible' })
  };
  vm.runInNewContext(`${functions}\nthis.settingsGraphMove = settingsGraphMove;`, context);

  // The TV settings categories form a vertical rail. Down selects the next
  // category while Right enters the active panel at its semantic first action.
  assert.equal(context.settingsGraphMove(accountTab, 'ArrowDown').target, screensTab);
  assert.equal(context.settingsGraphMove(accountTab, 'ArrowDown').selectTab, true);
  assert.equal(context.settingsGraphMove(accountTab, 'ArrowRight').target, service);
  // Horizontal navigation stays within the visual action row.
  assert.equal(context.settingsGraphMove(signOut, 'ArrowLeft').target, switchProfile);
  assert.equal(context.settingsGraphMove(legal, 'ArrowLeft').target, terms);
  // At the final row, Down is consumed for panel scrolling/no-op and can never
  // choose the geometrically nearby bell/profile in the rail.
  const atEnd = context.settingsGraphMove(legal, 'ArrowDown');
  assert.equal(atEnd.handled, true);
  assert.equal(atEnd.target, null);
  assert.equal(atEnd.scroll, true);
  assert.notEqual(atEnd.target, railBell);
  // Up from the first panel row returns to the selected tab.
  assert.equal(context.settingsGraphMove(service, 'ArrowUp').target, accountTab);
  // Right enters the panel; an actual global rail control remains outside this
  // page-scoped graph so Down -> Logout behavior is untouched.
  const enterPanel = context.settingsGraphMove(accountTab, 'ArrowRight');
  assert.equal(enterPanel.target, service);
  assert.equal(enterPanel.selectTab, false);
  assert.equal(context.settingsGraphMove(railBell, 'ArrowDown').handled, false);
});

test('Android TV web modals trap focus and restore their exact opener', () => {
  const source = read('public/js/utils/tvNavigation.js');
  assert.match(source, /const modalFocusOrigins = new WeakMap\(\);/);
  assert.match(
    source,
    /scope !== document && \(!focused \|\| !scope\.contains\(focused\)\)[\s\S]*scopeEntryTarget\(scope\)/
  );
  assert.match(
    source,
    /event\.target\?\.closest\?\.\(MODAL_SELECTOR\)[\s\S]*rememberModalOrigin\(modal, event\.relatedTarget\)/
  );
  assert.match(source, /scheduleModalFocusRestore\(modal\)/);
  assert.match(
    source,
    /modalObserver\.observe\(document\.body,[\s\S]*childList: true[\s\S]*subtree: true/
  );
});

test('Android TV Back dispatches addEventListener modal close before any class fallback', () => {
  const source = read('public/js/utils/tvNavigation.js');
  const closeTopModalSource = jsFunction(source, 'closeTopModal');

  const run = (closeEffect) => {
    const classes = new Set(['modal-overlay', 'active']);
    const listeners = new Map();
    let fallbackRemovals = 0;
    let restores = 0;
    let clicks = 0;
    const closeButton = {
      onclick: null,
      addEventListener: (type, listener) => listeners.set(type, listener),
      click: () => {
        clicks += 1;
        listeners.get('click')?.();
      }
    };
    const modal = {
      isConnected: true,
      classList: {
        contains: (name) => classes.has(name),
        remove: (name) => {
          fallbackRemovals += 1;
          classes.delete(name);
        }
      },
      querySelector: () => closeButton,
      matches: () => modal.isConnected && classes.has('active')
    };
    closeButton.addEventListener('click', () => closeEffect({ modal, classes }));
    const context = {
      MODAL_SELECTOR: '.modal-overlay.active',
      openModal: () => modal,
      scheduleModalFocusRestore: () => { restores += 1; }
    };
    vm.runInNewContext(`${closeTopModalSource}\nthis.closeTopModal = closeTopModal;`, context);
    assert.equal(context.closeTopModal(), true);
    return { clicks, fallbackRemovals, restores, modal, classes };
  };

  // Notifications: the listener removes its DOM node and has no .onclick property.
  const removed = run(({ modal }) => { modal.isConnected = false; });
  assert.equal(removed.clicks, 1);
  assert.equal(removed.fallbackRemovals, 0);
  assert.equal(removed.restores, 1);

  // A class-deactivating listener is equally final; the fallback must not run twice.
  const deactivated = run(({ classes }) => { classes.delete('active'); });
  assert.equal(deactivated.clicks, 1);
  assert.equal(deactivated.fallbackRemovals, 0);
  assert.equal(deactivated.restores, 1);
});

test('Android TV remembers a content stop per page before opening the rail', () => {
  const source = read('public/js/utils/tvNavigation.js');
  assert.match(source, /const pageFocusMemory = new Map\(\);/);
  assert.match(
    source,
    /pageFocusMemory\.set\(page\.id,[\s\S]*element: el,[\s\S]*key: lastFocusedKey/
  );
  assert.match(
    source,
    /function pageEntryTarget\(page\)[\s\S]*pageDefaultTarget\(page\)[\s\S]*rememberedPageTarget\(page\)/
  );
});

test('Android TV category lists expose one visible D-pad stop per option', () => {
  const navigation = read('public/js/utils/tvNavigation.js');
  const multiSelect = read('public/js/components/MultiSelect.js');
  const css = read('public/css/main.css');

  assert.match(
    navigation,
    /if \(el\.matches\('\.multi-select-item input\[type="checkbox"\]'\)\) continue;/
  );
  assert.match(css, /html\.tv-mode \.multi-select-item:focus/);
  assert.match(
    multiSelect,
    /const avoidAutomaticIme = document\.documentElement\.classList\.contains\('tv-mode'\)[\s\S]*querySelector\([\s\S]*\[data-action="all"\][\s\S]*firstAction\?\.focus/
  );
  assert.match(read('public/app.html'), /MultiSelect\.js\?v=4/);
});

test('Android TV Series keeps Reset visible so the focus graph stays stable', () => {
  const series = read('public/js/pages/SeriesPage.js');

  assert.match(
    series,
    /this\.resetBtn\?\.classList\.toggle\('hidden', !this\._isTvMode\(\) && !this\.hasActiveFilters\(\)\);/
  );
  assert.match(series, /this\.resetBtn\?\.classList\.remove\('hidden'\);/);
});

test('Android TV handles a dead WebView renderer instead of terminating the app', () => {
  const main = read('clients/android-tv/app/src/main/java/tv/norva/tv/MainActivity.java');
  assert.match(main, /boolean onRenderProcessGone\(WebView view, RenderProcessGoneDetail detail\)/);
  assert.match(main, /recoverFromRendererCrash\(view, detail\);\s*return true;/);
  assert.match(main, /root\.removeView\(crashedView\)/);
  assert.match(main, /crashedView\.destroy\(\)/);
  assert.match(
    main,
    /cloudBridgeAdded = false;\s*nativeBridgeAdded = false;\s*showSplash\(\);\s*buildWebView\(\);/
  );
  assert.match(main, /root\.addView\(webView, 0,/);
  assert.match(main, /withShellCacheBust\(markRendererRecovery\(recoveryUrl\)\)/);
});

test('Android TV renderer recovery resumes the valid active profile without a second picker', () => {
  const main = read('clients/android-tv/app/src/main/java/tv/norva/tv/MainActivity.java');
  const app = read('public/js/app.js');
  const profiles = read('public/js/profiles.js');

  assert.match(main, /appendQueryParameter\("_rendererRecovery", "1"\)/);
  assert.match(app, /const continuityRecovery = rendererRecovery \|\| this\._nativeRecovery/);
  assert.match(app, /ensureSelected\(\{ resumeActive: continuityRecovery \}\)/);
  assert.match(app, /cleanUrl\.searchParams\.delete\('_rendererRecovery'\)/);
  assert.match(
    profiles,
    /\(pickedThisSession\(\) \|\| options\.resumeActive === true\) && activeIsUsable/
  );
  assert.match(profiles, /if \(options\.resumeActive === true\) markPickedThisSession\(\)/);
});

test('Android TV audit assets never install a permanent JavaScript bridge', () => {
  const main = read('clients/android-tv/app/src/main/java/tv/norva/tv/MainActivity.java');

  assert.doesNotMatch(main, /addJavascriptInterface\(new DpadAuditBridge/);
  assert.doesNotMatch(main, /__norvaDpadAuditProbe/);
});

test('Android TV live-data audit assets are opt-in and debug-only', () => {
  const main = read('clients/android-tv/app/src/main/java/tv/norva/tv/MainActivity.java');

  assert.match(
    main,
    /debugBundledDpadAssets =\s*\(getApplicationInfo\(\)\.flags & android\.content\.pm\.ApplicationInfo\.FLAG_DEBUGGABLE\) != 0\s*&& getIntent\(\)\.getBooleanExtra\(EXTRA_DEBUG_BUNDLED_DPAD_ASSETS, false\);/
  );
  assert.match(main, /"\/js\/utils\/tvNavigation\.js"\.equals\(path\)/);
  assert.match(main, /"\/js\/utils\/sourceHealth\.js"\.equals\(path\)/);
  assert.match(main, /"\/js\/utils\/GenreRails\.js"\.equals\(path\)/);
  assert.match(main, /"\/js\/pages\/SeriesPage\.js"\.equals\(path\)/);
  assert.match(main, /"\/js\/profiles\.js"\.equals\(path\)/);
  assert.match(main, /"\/js\/components\/MultiSelect\.js"\.equals\(path\)/);
  assert.match(main, /"\/css\/main\.css"\.equals\(path\)/);
  assert.match(main, /"\/img\/icons\/norva-account\.svg"\.equals\(path\)/);
  assert.match(main, /"\/img\/icons\/norva-live-tv\.svg"\.equals\(path\)/);
});

test('Android TV app shell cache-busts the repaired navigation script', () => {
  assert.match(read('public/app.html'), /tvNavigation\.js\?v=32/);
  assert.match(read('public/support.html'), /tvNavigation\.js\?v=31/);
  assert.match(read('public/app.html'), /NavigationModel\.js\?v=b09ff7a7da/);
  assert.match(read('public/app.html'), /NavigationAdapters\.js\?v=1/);
  assert.match(read('public/app.html'), /GenreRails\.js\?v=8/);
});

test('Android TV Settings exposes only read-only ten-foot capabilities', () => {
  const settings = read('public/js/pages/Settings.js');
  const html = read('public/app.html');
  const css = read('public/css/main.css');

  assert.match(settings, /const allowed = new Set\(\['account', 'player', 'sources'\]\)/);
  assert.match(settings, /if \(isTvSettingsShell\(\) && !\['account', 'player', 'sources'\]\.includes\(tabName\)\)/);
  assert.match(settings, /action === 'show-instructions'[\s\S]*showTvHandoffInstructions\(true\)[\s\S]*return;/);
  assert.match(settings, /This TV never asks for provider credentials/);
  assert.match(settings, /title\.textContent = 'Continue on phone or web'/);
  assert.match(settings, /Valid via cloud synchronization/);
  assert.match(html, /id="settings-tv-signout-btn"/);
  assert.match(html, /id="settings-tv-legal-btn"/);
  assert.match(css, /html\.tv-mode #page-settings \.settings-source-management[\s\S]*display: none !important/);
  assert.match(css, /html\.tv-mode #page-settings #settings-tv-handoff-btn[\s\S]*display: none/);
  assert.match(css, /html\.tv-mode #page-settings \.settings-container > \.tab-content[\s\S]*max-width: 1216px/);
});

test('Android TV Movies dashboard cards restore the lightweight preview after Back', () => {
  const movies = read('public/js/pages/MoviesPage.js');
  const navigation = read('public/js/utils/tvNavigation.js');
  const genreRails = read('public/js/utils/GenreRails.js');

  assert.match(genreRails, /card\.__norvaItem = item \|\| null/);
  assert.match(movies, /closest\?\.\('\.movie-card, \.dashboard-card'\)/);
  assert.match(movies, /const group = this\._tvPreviewGroupForCard\(card\)/);
  assert.match(movies, /\.dashboard-card\.tv-preview-active/);
  assert.match(
    movies,
    /card === this\._lastPreviewCard && this\._extrasLoadedFor === null/,
    'returning laterally from a committed panel must rebuild the lightweight preview',
  );
  assert.doesNotMatch(
    movies,
    /if \(card === this\._lastPreviewCard\) return;/,
    'the same-card shortcut must not leave committed rating controls visible',
  );
  assert.match(navigation, /#movies-grid \.dashboard-card\.tv-preview-active/);
  assert.match(navigation, /\.dashboard-card\.tv-preview-active,/);
  assert.ok(
    (navigation.match(/\.dashboard-card\.tv-preview-active/g) || []).length >= 3,
    'entry, Back and ArrowLeft all preserve the active dashboard-card preview',
  );
});

test('Android TV keeps the standard cloud pairing flow separate from advanced setup', () => {
  const main = read('clients/android-tv/app/src/main/java/tv/norva/tv/MainActivity.java');

  assert.match(
    main,
    /CLOUD_PAIR_URL = "https:\/\/norva\.tv\/cloud-pair\.html\?device=tv&returnTo=%2Fapp\.html%3Fpaired%3D1%23home";/
  );
  assert.match(main, /private void connectCloudPairing\(\) \{[\s\S]*connect\(CLOUD_PAIR_URL\);/);
  assert.match(main, /advancedPanel\.setVisibility\(View\.GONE\);/);
});

test('Android TV Back closes MultiSelect through its complete disclosure state transition', () => {
  const navigation = read('public/js/utils/tvNavigation.js');
  const multiSelect = read('public/js/components/MultiSelect.js');
  const closeTransientSource = jsFunction(navigation, 'closeTransient');
  const trigger = {};
  let closeOptions = null;
  let focused = null;
  const panel = {
    __norvaMultiSelectClose: (options) => { closeOptions = options; },
    closest: () => ({ querySelector: () => trigger })
  };
  const context = {
    lastVisible: (selector) => {
      assert.equal(selector, '.multi-select-panel:not(.hidden)');
      return panel;
    },
    focusElement: (element) => { focused = element; }
  };
  vm.runInNewContext(`${closeTransientSource}\nthis.closeTransient = closeTransient;`, context);

  assert.equal(context.closeTransient(), true);
  assert.equal(closeOptions?.restoreFocus, false);
  assert.deepEqual(Object.keys(closeOptions || {}), ['restoreFocus']);
  assert.equal(focused, trigger);
  assert.match(multiSelect, /this\.panel\.__norvaMultiSelectClose/);
  assert.match(multiSelect, /this\.setOpen\(false, \{ restoreFocus \}\)/);
  assert.match(navigation, /panel\.setAttribute\('aria-hidden', 'true'\)/);
  assert.match(navigation, /panel\.inert = true/);
  assert.match(navigation, /btn\?\.setAttribute\('aria-expanded', 'false'\)/);
});
