const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const express = require('express');
const withdrawnCatalog = require('../server/middleware/withdrawnCatalog');

const retiredPaths = [
  '/catalog/credits', '/catalog/credits.html', '/catalog/credits/',
  '/catalog/credits.html?from=old-link', '/catalog/CREDITS.HTML',
  '/catalog/sources', '/catalog/sources.json', '/catalog/sources.json/',
  '/catalog/sources.json?cached=1',
];
const retainedPaths = ['/catalog/discovery.m3u', '/catalog/xumo-live.m3u', '/app.html'];

async function assertWithdrawn(response, method = 'GET') {
  assert.equal(response.status, 410);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.match(response.headers.get('x-robots-tag'), /noindex/);
  assert.equal(await response.text(), method === 'HEAD' ? '' : 'Page unavailable.');
}

test('Pages rejects every retired document alias and leaves playback playlists to static serving', async () => {
  const source = fs.readFileSync('functions/catalog/[[path]].js', 'utf8');
  const { onRequest } = await import('data:text/javascript,' + encodeURIComponent(source));
  for (const method of ['GET', 'HEAD']) {
    for (const path of retiredPaths) {
      await assertWithdrawn(await onRequest({
        request: new Request('https://norva.tv' + path, { method }),
        next() { throw Error('Retired document reached static serving'); },
      }), method);
    }
  }
  for (const path of retainedPaths) {
    const response = new Response('static');
    assert.equal(await onRequest({
      request: new Request('https://norva.tv' + path),
      next: () => response,
    }), response);
  }
});

test('local serving withdraws documents before static files and SPA fallback', async t => {
  const app = express();
  app.use(withdrawnCatalog);
  app.use((req, res) => res.send('static'));
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  for (const method of ['GET', 'HEAD']) {
    for (const path of retiredPaths) await assertWithdrawn(await fetch(origin + path, { method }), method);
  }
  for (const path of retainedPaths) assert.equal(await (await fetch(origin + path)).text(), 'static');
  const serverSource = fs.readFileSync('server/index.js', 'utf8');
  assert.ok(serverSource.indexOf("require('./middleware/withdrawnCatalog')") < serverSource.indexOf('app.use(express.static'));
});

function workerHarness() {
  const handlers = {};
  const stored = new Map();
  const counters = { fetched: 0, claimed: 0 };
  const caches = {
    async keys() { return [...stored.keys()]; },
    async delete(name) { return stored.delete(name); },
    async open(name) {
      if (!stored.has(name)) stored.set(name, new Map());
      const entries = stored.get(name);
      return {
        async keys() { return [...entries.keys()].map(url => ({ url })); },
        async delete(request) { return entries.delete(request.url); },
        async match(request) { return entries.get(request.url || request); },
        async put(request, response) { entries.set(request.url, response); },
      };
    },
  };
  const context = vm.createContext({
    URL, Response, caches,
    fetch() { counters.fetched++; throw Error('offline'); },
    self: {
      location: { origin: 'https://norva.tv' },
      clients: { claim() { counters.claimed++; } },
      addEventListener(name, handler) { handlers[name] = handler; },
    },
  });
  vm.runInContext(fs.readFileSync('public/sw.js', 'utf8'), context);
  return { handlers, stored, counters, context };
}

test('offline navigation never displays a cached retired document', async () => {
  const { handlers, stored, counters, context } = workerHarness();
  stored.set('norva-sw-v11-shell', new Map(retiredPaths.map(path => [
    'https://norva.tv' + path, new Response('Old internal inventory'),
  ])));
  for (const path of retiredPaths) {
    let response;
    const request = { url: 'https://norva.tv' + path, method: 'GET', mode: 'navigate' };
    handlers.fetch({ request, respondWith(value) { response = value; } });
    await assertWithdrawn(await response);
    assert.equal(context.canCacheRequest(request), false);
  }
  assert.equal(counters.fetched, 0);
});

test('worker activation removes retired cached documents while retaining unrelated app content', async () => {
  const { handlers, stored, counters } = workerHarness();
  const retainedUrl = 'https://norva.tv/app.html';
  stored.set('norva-sw-v11-shell', new Map([
    ...retiredPaths.map(path => ['https://norva.tv' + path, new Response('Old internal inventory')]),
    [retainedUrl, new Response('App shell')],
  ]));
  stored.set('norva-sw-v11-assets', new Map([['https://image.tmdb.org/poster.jpg', new Response('Poster')]]));
  let completion;
  handlers.activate({ waitUntil(promise) { completion = promise; } });
  await completion;
  assert.deepEqual([...stored.get('norva-sw-v11-shell').keys()], [retainedUrl]);
  assert.equal(stored.get('norva-sw-v11-assets').size, 1);
  assert.equal(counters.claimed, 1);
});

test('playback and backend requests still bypass the service worker', () => {
  const { handlers } = workerHarness();
  for (const path of ['/catalog/discovery.m3u', '/api/stream', '/sessions/example']) {
    handlers.fetch({
      request: { url: 'https://norva.tv' + path, method: 'GET', mode: 'cors', destination: '' },
      respondWith() { throw Error('Playback or backend request was intercepted'); },
    });
  }
});

test('public inventory files, generators and navigation links stay withdrawn', () => {
  for (const file of ['credits.html', 'sources.json']) assert.equal(fs.existsSync('public/catalog/' + file), false);
  const generator = fs.readFileSync('scripts/build-discovery-catalog.mjs', 'utf8');
  assert.doesNotMatch(generator, /credits\.html|sources\.json|DISCOVERY_RESEARCH|DISCOVERY_REVIEW_SOURCES/);
  for (const file of ['public/app.html', 'public/js/pages/HomePage.js']) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /href=["']\/catalog\/(?:credits|sources)/);
  }
});
