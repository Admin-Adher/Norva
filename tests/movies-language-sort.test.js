const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('Movies language bucket forwards explicit sort filters to the server', () => {
  const src = read('public/js/pages/MoviesPage.js');
  assert.match(src, /const sort = this\.sortSelect\?\.value \|\| '';/);
  assert.match(src, /if \(sort && sort !== 'default'\) params\.sort = sort;/);
  assert.match(src, /if \(this\.addedSelect\?\.value\) params\.addedDays = this\.addedSelect\.value;/);
  assert.match(src, /const langKey = this\.currentBucketViewKey\(\);/);
  assert.match(src, /this\.activeBucketLangKey = this\.currentBucketViewKey\(\);/);
});

test('Newest + French requests the all-language bucket with sort=year', async () => {
  const src = read('public/js/pages/MoviesPage.js');
  let captured;
  const sandbox = {
    window: { GenreRails: { appendCards() {} } },
    console,
    API: {
      media: {
        genreItems: async (params) => {
          captured = params;
          return { items: [], count: 0, hasMore: false };
        }
      }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'MoviesPage.js' });

  const page = Object.create(sandbox.window.MoviesPage.prototype);
  Object.assign(page, {
    activeBucket: 'all',
    bucketLoading: false,
    bucketHasMore: true,
    bucketOffset: 0,
    bucketRequestId: 1,
    bucketGridEl: { isConnected: true },
    bucketSeen: new Set(),
    audioSelect: { value: 'fr' },
    subtitleSelect: { value: '' },
    yearSelect: { value: '' },
    ratingSelect: { value: '' },
    addedSelect: { value: '' },
    sortSelect: { value: 'year' },
    searchInput: { value: '' },
    watchedSelect: { value: '' },
    showFavoritesOnly: false,
    groupDuplicates: true,
    getPreferences: () => ({})
  });

  await page.loadBucketPage();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(captured)), {
    type: 'movie',
    bucket: 'all',
    limit: 36,
    offset: 0,
    audio: 'fr',
    sort: 'year'
  });
});

test('Movies API relay preserves Added to catalog with language filters', () => {
  const src = read('public/js/api.js');
  const adapterStart = src.indexOf('async function getGenreItems');
  const adapterEnd = src.indexOf('async function getGenreSummary', adapterStart);
  const adapterBlock = src.slice(adapterStart, adapterEnd);
  assert.match(adapterBlock, /addedDays = ''/);
  assert.match(adapterBlock, /minRating, addedDays/);

  const handlerStart = src.indexOf("if (method === 'GET' && path === '/media/genre-items')");
  const handlerEnd = src.indexOf("if (method === 'GET' && path === '/media/genre-summary')", handlerStart);
  const handlerBlock = src.slice(handlerStart, handlerEnd);
  assert.match(handlerBlock, /addedDays: query\.get\('addedDays'\) \|\| ''/);
});

test('API adapter retains Newest, French, and Added to catalog parameters', async () => {
  const src = read('public/js/api.js');
  let captured;
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
  const home = {
    genreItems: async (params) => {
      captured = params;
      return { items: [], count: 0, hasMore: false };
    }
  };
  const NorvaCloud = {
    home,
    device: { home },
    regions: { resolve: () => ({ region: 'FR', language: 'fr' }) },
    entitlements: {},
    sources: {},
    mediaItems: {},
    live: {},
    playback: {}
  };
  const window = {
    location: {
      hostname: 'norva.tv',
      origin: 'https://norva.tv',
      pathname: '/app',
      search: '',
      hash: '#movies',
      replace() {}
    },
    NorvaCloud,
    innerWidth: 1920,
    innerHeight: 1080
  };
  const sandbox = {
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
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'api.js' });

  await sandbox.window.API.media.genreItems({
    type: 'movie',
    bucket: 'all',
    limit: 36,
    offset: 0,
    audio: 'fr',
    sort: 'year',
    addedDays: '30'
  });

  assert.equal(captured.bucket, 'all');
  assert.equal(captured.audio, 'fr');
  assert.equal(captured.sort, 'year');
  assert.equal(captured.addedDays, '30');
});

test('genre-items respects explicit Newest/Recently Added ordering instead of poster-first order', () => {
  const src = read('supabase/functions/norva-catalog/index.ts');
  assert.match(src, /const sort = \(url\.searchParams\.get\("sort"\) \|\| "default"\)/);
  assert.match(src, /sort === "year" \? "release_year"/);
  assert.match(src, /sort === "added" \? "created_at"/);
  assert.match(src, /sort === "name" \? "title"/);
  assert.match(src, /Only the default grid prioritises artwork before recency/);
  const orderBlock = src.slice(src.indexOf('const { data, count, error }'), src.indexOf('.range(offset, offset + limit - 1);'));
  const posterOrder = orderBlock.indexOf('"poster_url"');
  const sortOrder = orderBlock.indexOf('sort === "year-asc" ? "release_year"');
  assert.ok(sortOrder !== -1 && posterOrder !== -1 && sortOrder < posterOrder,
    'explicit sort selection must be evaluated before falling back to poster_url');
});

test('self-host deploy restarts every configured edge-runtime replica', () => {
  const src = read('ops/hetzner/scripts/04-deploy-edge-functions.sh');
  assert.match(src, /docker compose -f "\$COMPOSE" config --services/);
  assert.ok(src.includes("grep -E '^functions[0-9]*$'"));
  assert.match(src, /restart "\$\{function_services\[@\]\}"/);
});
