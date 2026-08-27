const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

function createCloudApiSandbox(list) {
  const values = new Map([
    ['norva-cloud-session', JSON.stringify({
      access_token: 'test-token',
      user: { id: 'test-user' }
    })]
  ]);
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key)
  };
  const mediaItems = { list };
  const NorvaCloud = {
    mediaItems,
    device: { mediaItems, sources: {}, live: {}, home: {}, playback: {} },
    regions: { resolve: () => ({ region: 'FR', language: 'fr' }) },
    entitlements: {},
    sources: {},
    live: {},
    home: {},
    playback: {}
  };
  const window = {
    location: {
      hostname: 'norva.tv',
      origin: 'https://norva.tv',
      pathname: '/app',
      search: '',
      hash: '#series',
      replace() {}
    },
    NorvaCloud,
    innerWidth: 1920,
    innerHeight: 1080
  };
  return {
    window,
    NorvaCloud,
    localStorage: storage,
    sessionStorage: storage,
    navigator: { userAgent: 'node-test' },
    location: window.location,
    URLSearchParams,
    URL,
    fetch: async () => { throw new Error('unexpected fetch'); },
    console,
    setTimeout,
    clearTimeout,
    AbortController,
    Headers,
    Request,
    Response,
    crypto: globalThis.crypto,
    document: {
      documentElement: { classList: { contains: () => false } },
      body: { classList: { contains: () => false } },
      querySelector: () => null
    }
  };
}

test('media page preserves the server logical-title cursor', async () => {
  const sandbox = createCloudApiSandbox(async () => ({
    items: [
      { source_id: 'source-1', item_type: 'series', external_id: 'variant-1', title_id: 'title-1' },
      { source_id: 'source-2', item_type: 'series', external_id: 'variant-2', title_id: 'title-1' }
    ],
    films: 1,
    count: 4000,
    limit: 120,
    offset: 0,
    hasMore: true
  }));
  vm.createContext(sandbox);
  vm.runInContext(read('public/js/api.js'), sandbox, { filename: 'api.js' });

  const page = await sandbox.window.API.media.page({ type: 'series', limit: 120, offset: 0 });
  assert.equal(page.items.length, 2, 'all provider variants remain available to the title group');
  assert.equal(page.films, 1, 'the adapter must preserve the server logical-title count');
  assert.equal((page.offset || 0) + (page.films ?? page.items.length), 1,
    'the next cursor must advance by titles, not variant rows');
});

test('Series uses the paged grid for a selected provider and preserves multi-genre OR', () => {
  const sandbox = { window: { GenreRails: {} }, console };
  vm.createContext(sandbox);
  vm.runInContext(read('public/js/pages/SeriesPage.js'), sandbox, { filename: 'SeriesPage.js' });
  const page = Object.create(sandbox.window.SeriesPage.prototype);
  Object.assign(page, {
    sourceSelect: { value: '900001' },
    _isTvMode: () => false,
    isCloudPagedMode: () => true,
    hasActiveFilters: () => false
  });
  assert.equal(page.shouldShowRails(), false,
    'a provider-scoped Series view must never fall back to finite global rails');

  let openedBuckets = null;
  Object.assign(page, {
    persistFilters() {},
    renderActiveFilterChips() {},
    categoryMulti: { getSelected: () => new Set(['action', 'drame']) },
    openGenreBucket: (buckets) => { openedBuckets = buckets; },
    isLanguageFilterActive: () => false
  });
  page.onFiltersChanged();
  assert.deepEqual(Array.from(openedBuckets), ['action', 'drame']);
});

test('Series serializes a multi-genre bucket into the existing genre-items contract', () => {
  const sandbox = {
    window: { GenreTaxonomy: { label: (value) => value.toUpperCase() } },
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(read('public/js/pages/SeriesPage.js'), sandbox, { filename: 'SeriesPage.js' });
  const page = Object.create(sandbox.window.SeriesPage.prototype);
  let opened = null;
  Object.assign(page, {
    activeBucket: null,
    activeBucketLangKey: null,
    currentBucketViewKey: () => 'lang=fr',
    openBucket: (rail) => { opened = rail; }
  });
  page.openGenreBucket(['action', 'drame']);
  assert.equal(opened.curation.bucket, 'action,drame');
  assert.equal(opened.id, 'genre-action,drame');
  assert.equal(opened.title, 'ACTION + DRAME');
});

test('Series grid is bounded by its single visible scroll container', () => {
  const css = read('public/css/main.css');
  const contentStart = css.indexOf('.series-content {');
  const gridStart = css.indexOf('.series-grid {', contentStart);
  const contentRule = css.slice(contentStart, gridStart);
  const gridRule = css.slice(gridStart, css.indexOf('\n}', gridStart) + 2);
  assert.match(contentRule, /display:\s*flex/);
  assert.match(contentRule, /flex-direction:\s*column/);
  assert.match(contentRule, /min-height:\s*0/);
  assert.match(gridRule, /flex:\s*1/);
  assert.match(gridRule, /min-height:\s*0/);
  assert.match(gridRule, /height:\s*auto/);
  assert.doesNotMatch(gridRule, /100d?vh/,
    'the Series scroller must not extend below its clipped parent');
});

test('Series genre summary is provider-scoped and honors the profile genre mask', () => {
  const source = read('public/js/pages/SeriesPage.js');
  const start = source.indexOf('async loadCloudCategories()');
  const end = source.indexOf('async loadSeries()', start);
  const block = source.slice(start, end);
  assert.match(block, /const source = this\.selectedCloudSourceId\(\)/);
  assert.match(block, /genreSummary\(\{ type: 'series', \.\.\.\(source \? \{ source \} : \{\}\) \}\)/);
  assert.match(block, /payload\?\.hidden/);
  assert.match(block, /hiddenBuckets\.has\(String\(g\.bucket\)\)/);
});

test('genre rails keep PostgREST variant queries below proxy URL limits', () => {
  const source = read('supabase/functions/norva-catalog/index.ts');
  assert.match(source, /const TITLE_VARIANT_QUERY_CHUNK = 50;/);
  assert.match(source, /index \+= TITLE_VARIANT_QUERY_CHUNK/);
  assert.match(source, /titleIds\.slice\(index, index \+ TITLE_VARIANT_QUERY_CHUNK\)/);
});

test('Xtream discovery honors the gateway single-flight contract and retries background busy', () => {
  const source = read('supabase/functions/_shared/xtream-sync.ts');
  assert.match(source, /const DISCOVER_CONCURRENCY = 1;/);
  assert.match(source, /isGatewayBackgroundBusy/);
  assert.match(source, /background_busy/);
  assert.match(source, /throw new HttpError\(503, "Media gateway is busy; retry catalog sync"/);

  const detectionStart = source.indexOf('export async function detectXtreamChange');
  const detectionEnd = source.indexOf('export async function driveXtreamSync', detectionStart);
  const detection = source.slice(detectionStart, detectionEnd);
  assert.doesNotMatch(detection, /Promise\.all\(\[\s*fetchCatalog\("get_live_categories"\)/);
  assert.doesNotMatch(detection, /fetchProviderMetadata[\s\S]{0,220}\.catch\(\(\) => \[\]\)/);

  const driveStart = source.indexOf('export async function driveXtreamSync');
  const driveEnd = source.indexOf('// Plain-language', driveStart);
  const drive = source.slice(driveStart, driveEnd);
  assert.doesNotMatch(drive, /Promise\.all\(\[\s*fetchCatalog\("get_live_categories"\)/);
  assert.doesNotMatch(drive, /fetchProviderMetadata[\s\S]{0,260}return \[\]/,
    'a failed category must not be consumed as an empty successful page');
});

test('changed Series assets are cache-busted together', () => {
  const html = read('public/app.html');
  assert.match(html, /main\.css\?v=122/);
  assert.match(html, /api\.js\?v=89/);
  assert.match(html, /SeriesPage\.js\?v=58/);
});
