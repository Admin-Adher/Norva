'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

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
    centerOf: (candidate) => ({ x: candidate.x, y: 0 }),
    INTERACTIVE_SELECTOR: '*'
  };
  vm.runInNewContext(`${functions}\nthis.catalogFilterStep = catalogFilterStep;`, context);
  return context.catalogFilterStep;
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

  assert.match(source, /heldNavRepeat = isHeldNavRepeat\(/);
  assert.match(source, /if \(isArrow && heldNavRepeat && !isTextField\(focused\)\)/);
  assert.match(source, /if \(e\.key === lastNavDirection\) lastNavDirectionReleased = true;/);
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
    /document\.documentElement\.classList\.contains\('tv-mode'\)[\s\S]*querySelector\('\[data-action="all"\]'\)[\s\S]*firstAction\?\.focus/
  );
  assert.match(read('public/app.html'), /MultiSelect\.js\?v=2/);
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
});

test('Android TV live-data audit assets are opt-in and debug-only', () => {
  const main = read('clients/android-tv/app/src/main/java/tv/norva/tv/MainActivity.java');

  assert.match(
    main,
    /debugBundledDpadAssets =\s*\(getApplicationInfo\(\)\.flags & android\.content\.pm\.ApplicationInfo\.FLAG_DEBUGGABLE\) != 0\s*&& getIntent\(\)\.getBooleanExtra\(EXTRA_DEBUG_BUNDLED_DPAD_ASSETS, false\);/
  );
  assert.match(main, /"\/js\/utils\/tvNavigation\.js"\.equals\(path\)/);
  assert.match(main, /"\/js\/pages\/SeriesPage\.js"\.equals\(path\)/);
  assert.match(main, /"\/js\/components\/MultiSelect\.js"\.equals\(path\)/);
  assert.match(main, /"\/css\/main\.css"\.equals\(path\)/);
});

test('Android TV app shell cache-busts the repaired navigation script', () => {
  assert.match(read('public/app.html'), /tvNavigation\.js\?v=24/);
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
