'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('one navigation model owns routes, actions and platform projection order', () => {
  const {
    NavigationModel,
    createDefaultNavigationModel,
  } = require('../public/js/navigation/NavigationModel.js');
  const model = createDefaultNavigationModel();

  assert.ok(model instanceof NavigationModel);
  assert.deepEqual(model.keysFor('web'), [
    'home', 'live', 'movies', 'series', 'downloads',
  ]);
  assert.deepEqual(model.keysFor('phone'), [
    'home', 'live', 'movies', 'series', 'search', 'downloads', 'account',
  ]);
  assert.deepEqual(model.keysFor('tv'), [
    'home', 'live', 'movies', 'series', 'settings', 'logout',
  ]);
  assert.deepEqual(model.catalogPageNames(), ['live', 'movies', 'series']);
  assert.deepEqual(model.continuityPageNames(), [
    'home', 'live', 'movies', 'series', 'settings', 'partners',
  ]);
  assert.deepEqual(model.intentForKey('search'), {
    key: 'search',
    kind: 'action',
    target: 'search',
  });
  assert.deepEqual(model.intentForKey('movies'), {
    key: 'movies',
    kind: 'route',
    target: 'movies',
  });
  assert.equal(model.transitionFor('series').title, 'Opening Series');
  assert.equal(model.isCatalogPage('settings'), false);
  assert.equal(model.allowsPlatform('downloads', 'phone'), true);
  assert.equal(model.allowsPlatform('downloads', 'web'), false);
  assert.equal(model.allowsPlatform('downloads', 'tv'), false);
  assert.equal(model.allowsPlatform('admin', 'web'), true);
  assert.equal(model.allowsPlatform('admin', 'phone'), false);

  assert.throws(
    () => new NavigationModel({
      routes: [{ key: 'home' }, { key: 'home' }],
      actions: [],
      projections: { web: ['home'] },
    }),
    /Duplicate navigation key: home/,
  );
  assert.throws(
    () => new NavigationModel({
      routes: [{ key: 'home' }],
      actions: [],
      projections: { web: ['missing'] },
    }),
    /Unknown navigation key "missing" in web projection/,
  );
});

test('the model renders accessible web, phone and TV projections without markup duplication', () => {
  const { createDefaultNavigationModel } = require('../public/js/navigation/NavigationModel.js');
  const model = createDefaultNavigationModel();
  const web = model.renderProjection('web');
  const phone = model.renderProjection('phone');
  const tv = model.renderProjection('tv');

  for (const html of [web, phone, tv]) {
    assert.match(html, /data-nav-key="home"/);
    assert.match(html, /data-page="home"/);
    assert.match(html, /aria-label="Home"/);
    assert.match(html, /aria-current="page"/);
  }

  assert.equal((web.match(/class="nav-link/g) || []).length, 5);
  assert.equal((phone.match(/class="nav-link/g) || []).length, 7);
  assert.equal((tv.match(/class="nav-link/g) || []).length, 6);
  assert.match(phone, /id="nav-search-bottom"[^>]*data-action="search"/);
  assert.match(phone, /id="nav-downloads-bottom"[^>]*data-action="downloads"/);
  assert.match(phone, /id="nav-account"[^>]*aria-label="Account and settings"/);
  assert.doesNotMatch(web, /data-nav-key="admin"|data-nav-key="settings"|data-nav-key="logout"/);
  assert.match(tv, /id="logout-btn"/);
  assert.doesNotMatch(tv, /data-nav-key="admin"|data-nav-key="downloads"/);

  for (const key of ['live', 'movies', 'series']) {
    assert.match(
      phone,
      new RegExp(`data-nav-key="${key}"[^>]*catalog-nav-hidden[^>]*hidden`),
      `${key} is fail-closed before catalogue health resolves`,
    );
  }
});

test('web, phone and TV adapters expose one stable projection interface', () => {
  const { createDefaultNavigationModel } = require('../public/js/navigation/NavigationModel.js');
  const {
    WebNavigationAdapter,
    PhoneNavigationAdapter,
    TvNavigationAdapter,
  } = require('../public/js/navigation/NavigationAdapters.js');
  const model = createDefaultNavigationModel();

  assert.equal(new WebNavigationAdapter(null, model).projection, 'web');
  assert.equal(new PhoneNavigationAdapter(null, model).projection, 'phone');
  assert.equal(new TvNavigationAdapter(null, model).projection, 'tv');
  for (const Adapter of [WebNavigationAdapter, PhoneNavigationAdapter, TvNavigationAdapter]) {
    const adapter = new Adapter(null, model);
    assert.equal(typeof adapter.mount, 'function');
    assert.equal(typeof adapter.bind, 'function');
    assert.equal(typeof adapter.setVisible, 'function');
    assert.equal(typeof adapter.syncCurrent, 'function');
    assert.equal(typeof adapter.findByKey, 'function');
  }
});

test('Downloads stays exclusive to the native phone and tablet shell', () => {
  const { createDefaultNavigationModel } = require('../public/js/navigation/NavigationModel.js');
  const { NavigationController } = require('../public/js/navigation/NavigationAdapters.js');
  const model = createDefaultNavigationModel();
  const cases = [
    { userAgent: 'Mozilla/5.0', search: '', expected: false, platform: 'web' },
    { userAgent: 'Mozilla/5.0 NorvaTV-AndroidTV', search: '', expected: false, platform: 'tv' },
    { userAgent: 'Mozilla/5.0', search: '?tv=1', expected: false, platform: 'tv' },
    { userAgent: 'Mozilla/5.0 NorvaTV-AndroidPhone', search: '', expected: true, platform: 'phone' },
  ];

  for (const scenario of cases) {
    const controller = new NavigationController({ model, ...scenario });
    let projectedVisibility = null;
    controller._adapters.set('probe', {
      setVisible(key, visible) {
        assert.equal(key, 'downloads');
        projectedVisibility = visible;
        return true;
      },
    });

    controller.setVisible('downloads', true);
    assert.equal(controller.platform, scenario.platform);
    assert.equal(projectedVisibility, scenario.expected);
  }
});

test('app shell delegates navigation policy and removes the retired hamburger path', () => {
  const html = read('public/app.html');
  const app = read('public/js/app.js');
  const standalone = read('public/js/utils/standalone.js');
  const tvNavigation = read('public/js/utils/tvNavigation.js');
  const css = read('public/css/main.css');
  const tvMain = read('clients/android-tv/app/src/main/java/tv/norva/tv/MainActivity.java');

  const modelScript = html.indexOf('/js/navigation/NavigationModel.js?v=b09ff7a7da');
  const adaptersScript = html.indexOf('/js/navigation/NavigationAdapters.js?v=1');
  const bootstrapScript = html.indexOf('/js/navigation/navigationBootstrap.js?v=1');
  const tvScript = html.indexOf('/js/utils/tvNavigation.js?v=32');
  const appScript = html.indexOf('/js/app.js?v=6eb27a7a9b');
  assert.ok(modelScript > 0 && modelScript < adaptersScript);
  assert.ok(adaptersScript < bootstrapScript && bootstrapScript < tvScript && tvScript < appScript);

  assert.match(html, /<div class="navbar-menu" id="navbar-menu" data-navigation-root="primary"><\/div>/);
  assert.match(html, /<nav class="bottom-nav" id="bottom-nav" aria-label="Primary" data-navigation-root="phone"><\/nav>/);
  assert.doesNotMatch(html, /data-page="(?:home|live|movies|series|admin|settings)"/);
  assert.doesNotMatch(html, /mobile-menu-toggle/);
  assert.doesNotMatch(css, /\.mobile-menu-toggle|\.navbar-menu\.active/);
  assert.doesNotMatch(app, /mobileMenuToggle|mobile-menu-toggle/);
  assert.doesNotMatch(standalone, /mobile-menu-toggle|navigation menu/);

  assert.match(app, /this\.navigation = window\.NorvaNavigation/);
  assert.match(app, /this\.navigation\?\.bind\(\(intent\) => this\.handleNavigationIntent\(intent\)\)/);
  assert.match(app, /this\.navigation\?\.syncCurrent\(pageName\)/);
  assert.match(app, /this\.navigation\?\.setCatalogAvailability/);
  assert.match(
    read('public/js/navigation/NavigationAdapters.js'),
    /this\.model\.allowsPlatform\(key, this\.platform\)/,
  );
  assert.match(tvNavigation, /const tvNavigationAdapter = window\.NorvaNavigation\?\.getAdapter\?\.\('tv'\)/);
  assert.match(tvNavigation, /function railNavLinks\(\)/);

  for (const asset of [
    '/js/navigation/NavigationModel.js',
    '/js/navigation/NavigationAdapters.js',
    '/js/navigation/navigationBootstrap.js',
  ]) {
    assert.ok(tvMain.includes(`"${asset}".equals(path)`), `TV bundled mapping missing ${asset}`);
  }
});
