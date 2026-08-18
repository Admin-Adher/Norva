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

test('catalog policy never treats discovery counts as browsable rows', () => {
  const health = sourceHealthHarness();
  const summary = health.summarize([{
    id: 'source-1',
    sync_status: 'syncing',
    syncProgress: {
      status: 'syncing',
      counts: { live: 400, movies: 2500, series: 900, total: 3800 },
    },
  }]);

  const availability = health.catalogAvailability(summary);
  assert.equal(availability.gate, true);
  assert.equal(availability.browsable, false);
  assert.equal(health.isCatalogCategoryAvailable(summary, 'movies'), false);
});

test('catalog policy unlocks Live as soon as channels are materialized', () => {
  const health = sourceHealthHarness();
  const summary = health.summarize([{
    id: 'source-1',
    sync_status: 'syncing',
    syncProgress: { status: 'syncing', liveReady: true, counts: { live: 120 } },
  }]);
  const availability = health.catalogAvailability(summary);

  assert.equal(availability.gate, false);
  assert.equal(availability.catalogReady, false);
  assert.equal(availability.categories.live, true);
  assert.equal(availability.categories.movies, false);
  assert.equal(availability.categories.series, false);
});

test('catalog policy unlocks Movies and Series on the first title slice', () => {
  const health = sourceHealthHarness();
  const summary = health.summarize([{
    id: 'source-1',
    sync_status: 'syncing',
    syncProgress: { status: 'syncing', liveReady: true, browseReady: true, counts: { movies: 80 } },
  }]);
  const availability = health.catalogAvailability(summary);

  assert.equal(availability.gate, false);
  assert.equal(availability.categories.live, true);
  assert.equal(availability.categories.movies, true);
  assert.equal(availability.categories.series, true);
});

test('catalog policy unlocks every consumer from the authoritative usable flag', () => {
  const health = sourceHealthHarness();
  const source = {
    id: 'source-1',
    sync_status: 'syncing',
    syncProgress: { status: 'syncing', usable: true, counts: { total: 100 } },
  };
  const summary = health.summarize([source]);
  const sourcePolicy = health.catalogSourcePolicy(source);
  const availability = health.catalogAvailability(summary);

  assert.equal(sourcePolicy.phase, 'ready');
  assert.equal(sourcePolicy.backgrounding, true);
  assert.equal(availability.gate, false);
  assert.equal(availability.categories.live, true);
  assert.equal(availability.categories.movies, true);
  assert.equal(availability.categories.series, true);
});

test('catalog policy keeps a hard login failure actionable even with an older catalog', () => {
  const health = sourceHealthHarness();
  const summary = health.summarize([{
    id: 'source-1',
    sync_status: 'failed',
    sync_error: '401 invalid username',
    configHint: { lastSync: { syncedAt: '2026-08-10T08:00:00.000Z', total: 42 } },
  }]);

  const availability = health.catalogAvailability(summary);
  assert.equal(summary.state, 'auth_failed');
  assert.equal(availability.gate, true);
  assert.equal(availability.browsable, false);
});

test('TV service handoff uses safe public copy and omits provider diagnostics', () => {
  const health = sourceHealthHarness();
  const html = health.cardHtml({
    state: 'auth_failed',
    title: 'Provider rejected private-provider-id',
    message: 'password=secret-token',
    issues: [{ severity: 4, source: { id: 'private-provider-id', type: 'xtream' } }],
    sources: [{ id: 'private-provider-id', type: 'xtream' }],
  }, { hideWhenReady: false, tvHandoff: true, accountSummary: true });

  assert.match(html, /TV service needs attention/);
  assert.match(html, /Some content may be unavailable\. Available titles still play\./);
  assert.match(html, /data-source-health-action="show-instructions"/);
  assert.match(html, /\/img\/icons\/norva-live-tv\.svg/);
  assert.doesNotMatch(html, /private-provider-id|secret-token|xtream|auth_failed|Update login/);
  assert.doesNotMatch(html, /data-source-health-source-(?:id|type)/);
});

test('Account health summary keeps the service price-neutral and secondary', () => {
  const health = sourceHealthHarness();
  const html = health.cardHtml({
    state: 'ready',
    sources: [{ id: 'source-1', lastSync: new Date(Date.now() - 120000).toISOString() }],
  }, { hideWhenReady: false, accountSummary: true });

  assert.match(html, /service-health-account/);
  assert.match(html, /TV service is ready/);
  assert.match(html, /Catalogue updated 2 min ago/);
  assert.match(html, /btn btn-secondary/);
  assert.match(html, /View service/);
  assert.doesNotMatch(html, /price|billing|payment/i);
});

test('TV handoff stays on the ten-foot surface when the product modal is unavailable', () => {
  let announced = '';
  const window = {
    alert(message) { announced = message; },
    location: { search: '', pathname: '/app.html', href: '/app.html#settings' },
  };
  window.window = window;
  const context = {
    window,
    navigator: { userAgent: 'NorvaTV-AndroidTV' },
    document: { documentElement: { classList: { contains: () => true } } },
    console,
  };
  vm.runInNewContext(SETTINGS_SOURCE, context, { filename: 'public/js/pages/Settings.js' });
  const page = Object.create(window.SettingsPage.prototype);

  page.showTvHandoffInstructions(true);

  assert.match(announced, /Open norva\.tv\/account on a phone, tablet or computer/);
  assert.match(announced, /never asks for provider credentials/);
  assert.equal(window.location.href, '/app.html#settings');
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
    document: {
      documentElement: { classList: { contains: () => false } },
      getElementById: (id) => id === 'settings-service-health' ? container : null,
    },
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
    document: {
      documentElement: { classList: { contains: () => false } },
      getElementById: (id) => id === 'settings-service-health' ? container : null,
    },
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

test('SourceManager shares one connection parser for Home and Settings', () => {
  const { manager } = sourceManagerHarness();
  const playlist = manager.buildSourceConnection({
    type: 'auto',
    url: 'https://provider.example/list.m3u?token=abc',
  });
  const xtream = manager.buildSourceConnection({
    type: 'auto',
    url: 'https://provider.example/get.php?username=alex&password=secret&type=m3u_plus',
  });

  assert.equal(playlist.type, 'm3u');
  assert.equal(playlist.url, 'https://provider.example/list.m3u?token=abc');
  assert.equal(xtream.type, 'xtream');
  assert.equal(xtream.url, 'https://provider.example');
  assert.equal(xtream.username, 'alex');
  assert.equal(xtream.password, 'secret');
});

test('terminal provider errors render a truthful recovery state', () => {
  const { manager } = sourceManagerHarness();
  const html = manager.catalogPreparationView({
    id: 'source-1',
    name: 'Family TV',
    sync_status: 'unreachable',
    syncProgress: { status: 'unreachable', counts: {} },
  }).render();

  assert.match(html, /Provider unavailable/);
  assert.match(html, /Needs attention/);
  assert.doesNotMatch(html, /Scanning/);
  assert.doesNotMatch(html, /Repair Login/);
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
