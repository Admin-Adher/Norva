'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '../public/js/utils/catalogCache.js'),
  'utf8',
);

function storage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(String(key)) ?? null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(String(key)); },
    clear() { values.clear(); },
    dump() { return Object.fromEntries(values); },
  };
}

function loadCache(cloudMode) {
  const localStorage = storage();
  localStorage.setItem('norva-cloud-session', JSON.stringify({ user: { id: 'account-cache-owner' } }));
  const window = { API: { isCloudMode: () => cloudMode } };
  new Function('window', 'localStorage', source)(window, localStorage);
  return { cache: window.NorvaCatalogCache, localStorage };
}

test('Cloud persistent catalog cache is unusable without the exact epoch-bearing signature', () => {
  const { cache, localStorage } = loadCache(true);

  cache.write('movies:first', { items: ['unsafe'] });
  assert.equal(Object.keys(localStorage.dump()).filter((key) => key.startsWith('norva-cc:')).length, 0);

  cache.write('movies:first', { items: ['safe'] }, { version: 'catalog:7|visibility:v2.4.9' });
  assert.deepEqual(
    cache.read('movies:first', { version: 'catalog:7|visibility:v2.4.9' })?.data,
    { items: ['safe'] },
  );

  assert.equal(cache.read('movies:first'), null, 'cold time-only reads fail closed in Cloud mode');
  cache.write('movies:first', { items: ['old'] }, { version: 'catalog:7|visibility:v2.4.9' });
  assert.equal(
    cache.read('movies:first', { version: 'catalog:7|visibility:v2.5.9' }),
    null,
    'a global epoch cutover evicts the older persistent snapshot',
  );
});

test('non-Cloud mode retains the bounded time-only cache contract', () => {
  const { cache } = loadCache(false);
  cache.write('movies:first', { items: ['local'] });
  assert.deepEqual(cache.read('movies:first')?.data, { items: ['local'] });
});
