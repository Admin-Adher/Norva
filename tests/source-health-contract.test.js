'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

const SOURCE_HEALTH_SOURCE = read('public/js/utils/sourceHealth.js');
const SETTINGS_SOURCE = read('public/js/pages/Settings.js');
const SOURCE_MANAGER_SOURCE = read('public/js/components/SourceManager.js');
const HOME_SOURCE = read('public/js/pages/HomePage.js');

function sourceHealthHarness(sourcesApi = {}) {
  const window = {
    API: {
      sources: {
        getAll: async () => [],
        getStatus: async () => [],
        ...sourcesApi,
      },
    },
  };
  window.window = window;
  vm.runInNewContext(SOURCE_HEALTH_SOURCE, { window, console, setTimeout });
  return window.NorvaSourceHealth;
}

test('source health distinguishes an initial import from a usable background refresh', () => {
  const health = sourceHealthHarness();
  const initial = health.classifySource({ id: 'source-1', sync_status: 'syncing' });
  const refresh = health.classifySource({
    id: 'source-1',
    sync_status: 'syncing',
    configHint: { lastSync: { syncedAt: '2026-08-10T08:00:00.000Z', total: 42 } },
  });

  assert.equal(initial.state, 'syncing');
  assert.equal(initial.refreshing, false);
  assert.equal(refresh.state, 'ready');
  assert.equal(refresh.refreshing, true);
});

test('source health keeps hard account failures actionable but preserves a built catalog on transient errors', () => {
  const health = sourceHealthHarness();
  const completed = { lastSync: { syncedAt: '2026-08-10T08:00:00.000Z', total: 42 } };
  const authFailure = health.classifySource({
    id: 'source-1',
    sync_status: 'failed',
    sync_error: '401 invalid username',
    configHint: completed,
  });
  const timeout = health.classifySource({
    id: 'source-1',
    sync_status: 'failed',
    sync_error: 'provider timeout',
    configHint: completed,
  });

  assert.equal(authFailure.state, 'auth_failed');
  assert.equal(authFailure.isBlocking, true);
  assert.equal(timeout.state, 'ready');
  assert.equal(timeout.refreshing, true);
});

test('source health reports an API outage as unknown instead of not configured', async () => {
  const health = sourceHealthHarness({
    getAll: async () => { throw new Error('offline'); },
    getStatus: async () => [],
  });

  const summary = await health.loadSummary();

  assert.equal(summary.state, 'unknown');
  assert.equal(summary.error, true);
  assert.deepEqual(Array.from(summary.sources), []);
});

test('Settings renders the exact summary returned by the App refresh seam', async () => {
  const container = { innerHTML: '' };
  const sharedSummary = { state: 'ready', sources: [{ source: { id: 'source-1' } }] };
  let renderedSummary = null;
  let directLoads = 0;
  const window = {
    NorvaSourceHealth: {
      async loadSummary() {
        directLoads += 1;
        return { state: 'not_configured' };
      },
      cardHtml(summary) {
        renderedSummary = summary;
        return '<div>shared</div>';
      },
    },
  };
  window.window = window;
  const context = {
    window,
    navigator: { userAgent: '' },
    document: { getElementById: (id) => id === 'settings-service-health' ? container : null },
    console,
  };
  vm.runInNewContext(SETTINGS_SOURCE, context, { filename: 'public/js/pages/Settings.js' });
  const page = Object.create(window.SettingsPage.prototype);
  page.app = { refreshSourceHealth: async () => sharedSummary };

  await page.refreshSourceHealthCard();

  assert.strictEqual(page.lastSourceHealthSummary, sharedSummary);
  assert.strictEqual(renderedSummary, sharedSummary);
  assert.equal(directLoads, 0);
  assert.equal(container.innerHTML, '<div>shared</div>');
});

test('Settings keeps a compatible direct loader fallback when no App seam exists', async () => {
  const container = { innerHTML: '' };
  const fallbackSummary = { state: 'syncing' };
  const window = {
    NorvaSourceHealth: {
      loadSummary: async () => fallbackSummary,
      cardHtml: (summary) => `<div>${summary.state}</div>`,
    },
  };
  window.window = window;
  const context = {
    window,
    navigator: { userAgent: '' },
    document: { getElementById: (id) => id === 'settings-service-health' ? container : null },
    console,
  };
  vm.runInNewContext(SETTINGS_SOURCE, context, { filename: 'public/js/pages/Settings.js' });
  const page = Object.create(window.SettingsPage.prototype);
  page.app = {};

  await page.refreshSourceHealthCard();

  assert.strictEqual(page.lastSourceHealthSummary, fallbackSummary);
  assert.equal(container.innerHTML, '<div>syncing</div>');
});

function sourceManagerHarness() {
  const storage = new Map();
  const api = {
    sources: {
      finalize: async () => ({ done: true, nextPhase: 'complete' }),
      getById: async () => null,
    },
  };
  const window = {
    API: api,
    localStorage: {
      getItem(key) { return storage.get(key) || null; },
      setItem(key, value) { storage.set(key, String(value)); },
      removeItem(key) { storage.delete(key); },
    },
  };
  window.window = window;
  const context = { window, API: api, console, URL, setTimeout, clearTimeout, setInterval, clearInterval };
  vm.runInNewContext(SOURCE_MANAGER_SOURCE, context, { filename: 'public/js/components/SourceManager.js' });
  const manager = Object.create(window.SourceManager.prototype);
  manager.sourceStatuses = [];
  return { manager, api };
}

test('SourceManager exposes one preparation view instead of leaking rendering internals', () => {
  const { manager } = sourceManagerHarness();
  const view = manager.catalogPreparationView({
    id: 'source-1',
    name: 'Living room',
    sync_status: 'syncing',
    syncProgress: {
      status: 'syncing',
      percent: 35,
      counts: { live: 5, movies: 7, series: 2, total: 14 },
    },
  }, 'xtream');

  assert.equal(view.sourceId, 'source-1');
  assert.equal(view.type, 'xtream');
  assert.equal(view.phase, 'syncing');
  assert.equal(view.progress.percent, 35);
  assert.equal(view.counts.movies, 7);
  assert.equal(view.formatCount(7), '7');
  assert.equal(typeof view.render, 'function');
  assert.equal('html' in view, false, 'progress markup must stay lazy on patch-only ticks');
  assert.match(view.render(), /Living room/);
  assert.equal(typeof view.patch, 'function');
});

test('SourceManager recovery sessions own and release their cancellation token', async () => {
  const { manager } = sourceManagerHarness();
  const rendered = [];
  let observedSourceId = null;
  manager.shouldRecoverCatalogFinalization = () => true;
  manager.recoverCatalogFinalization = async (sourceId, _token, render) => {
    observedSourceId = sourceId;
    render({ id: sourceId, sync_status: 'ready' });
  };

  const session = manager.startCatalogPreparationRecovery(
    { id: 'source-1', sync_status: 'syncing' },
    { onProgress: (source) => rendered.push(source.id) },
  );

  assert.ok(session);
  assert.equal(session.sourceId, 'source-1');
  assert.equal(session.isActive(), true);
  await session.promise;
  assert.equal(observedSourceId, 'source-1');
  assert.deepEqual(rendered, ['source-1']);
  assert.equal(session.isActive(), false);
});

test('Home consumes the SourceManager preparation facade without touching its mutable token', () => {
  assert.match(HOME_SOURCE, /catalogPreparationView/);
  assert.match(HOME_SOURCE, /startCatalogPreparationRecovery/);
  assert.doesNotMatch(HOME_SOURCE, /catalogPreparationToken/);
  assert.doesNotMatch(HOME_SOURCE, /manager\?\.renderCatalogPreparation|manager\.renderCatalogPreparation/);
  assert.doesNotMatch(HOME_SOURCE, /manager\?\.patchCatalogPreparation|manager\.patchCatalogPreparation/);
  assert.doesNotMatch(HOME_SOURCE, /manager\?\.recoverCatalogFinalization|manager\.recoverCatalogFinalization/);
});
