const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const cloudSource = fs.readFileSync(path.join(ROOT, 'public/js/cloudApi.js'), 'utf8');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => String(name).toLowerCase() === 'content-type' ? 'application/json' : null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test('history mutation prevents an older in-flight GET from rejoining or repopulating cache', async () => {
  const firstGet = deferred();
  const secondGet = deferred();
  let historyGets = 0;
  const values = new Map([['norva-cloud-token', 'test-token']]);
  const window = { location: { origin: 'https://norva.tv', search: '' } };
  const context = vm.createContext({
    window,
    localStorage: {
      getItem: (key) => values.get(key) || null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
    },
    navigator: { userAgent: 'Mozilla/5.0', language: 'en-US', languages: ['en-US'] },
    document: { readyState: 'loading', addEventListener() {} },
    fetch: async (url, options = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/history') && (options.method || 'GET') === 'GET') {
        historyGets += 1;
        return historyGets === 1 ? firstGet.promise : secondGet.promise;
      }
      if (parsed.pathname.endsWith('/history') && options.method === 'POST') {
        return jsonResponse({ item: { item_id: 'movie-42', item_type: 'movie', progress_seconds: 181, duration_seconds: 7450 } });
      }
      return jsonResponse({});
    },
    URL,
    URLSearchParams,
    AbortController,
    Intl,
    Date,
    Map,
    Set,
    WeakMap,
    Promise,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    JSON,
    Math,
    console: { log() {}, warn() {}, debug() {}, error() {} },
    performance: { now: () => 0 },
    setTimeout,
    clearTimeout,
  });
  window.window = window;
  vm.runInContext(cloudSource, context, { filename: 'public/js/cloudApi.js' });

  const staleRead = window.NorvaCloud.history.list({ limit: 5000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(historyGets, 1);

  await window.NorvaCloud.history.save({
    sourceId: 'source-a', itemId: 'movie-42', itemType: 'movie',
    progressSeconds: 181, durationSeconds: 7450,
  });

  const freshRead = window.NorvaCloud.history.list({ limit: 5000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(historyGets, 2, 'post-save refresh must not join the pre-save GET');

  secondGet.resolve(jsonResponse({ history: [{ item_id: 'movie-42', progress_seconds: 181 }] }));
  assert.equal((await freshRead).history[0].progress_seconds, 181);

  firstGet.resolve(jsonResponse({ history: [{ item_id: 'movie-42', progress_seconds: 0 }] }));
  assert.equal((await staleRead).history[0].progress_seconds, 0, 'the original caller may finish normally');

  const cachedRead = await window.NorvaCloud.history.list({ limit: 5000 });
  assert.equal(historyGets, 2, 'the fresh response remains cached');
  assert.equal(cachedRead.history[0].progress_seconds, 181, 'stale completion cannot repopulate the cache');
});
