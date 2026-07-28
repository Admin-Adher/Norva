'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

function method(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `missing method: ${signature}`);
  const open = source.indexOf('{', start);
  assert.ok(open >= 0, `missing method body: ${signature}`);
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
  assert.fail(`unterminated method: ${signature}`);
}

const main = read('clients/android-phone/app/src/main/java/tv/norva/phone/MainActivity.java');
const player = read('clients/android-phone/app/src/main/java/tv/norva/phone/PlayerActivity.java');
const manifest = read('clients/android-phone/app/src/main/AndroidManifest.xml');
const app = read('public/js/app.js');
const profiles = read('public/js/profiles.js');
const standalone = read('public/js/utils/standalone.js');
const movies = read('public/js/pages/MoviesPage.js');
const series = read('public/js/pages/SeriesPage.js');

test('phone recovery binds every fresh URL to the exact native retry token', () => {
  const request = method(player, 'private void requestFreshStream(String reason)');
  const bridge = method(main, 'private void registerPlayerRecoveryBridge()');
  const deliver = method(main, 'private boolean deliverRecoveredStreamToPlayer(');

  assert.match(request, /recoveryToken\s*=\s*UUID\.randomUUID\(\)\.toString\(\)/);
  assert.match(request, /putExtra\(EXTRA_RECOVERY_TOKEN,\s*recoveryToken\)/);
  assert.match(
    bridge,
    /window\.__norvaNative\.retryPlayback\([\s\S]{0,260}jsStr\(token\)/,
    'the token must enter the WebView resolver',
  );
  assert.match(standalone, /\.\.\.\(recoveryToken\s*\?\s*\{\s*recoveryToken\s*\}\s*:\s*\{\}\)/);
  assert.match(deliver, /optString\("recoveryToken"\)/);
  assert.match(deliver, /if \(responseToken == null\) return false;/);
  assert.match(deliver, /if \(token == null \|\| expectedKey == null\) return true;/);
  assert.match(
    deliver,
    /if \(!token\.equals\(responseToken\)\) return true;/,
    'a stale response for the same title must be consumed, not launched',
  );
  assert.match(deliver, /SystemClock\.elapsedRealtime\(\)/);
  assert.match(deliver, /clearPendingPlayerRecovery\(token\)/);
});

test('phone recovery is retired on host timeout, Back, player close and variant change', () => {
  const bridge = method(main, 'private void registerPlayerRecoveryBridge()');
  const back = method(main, 'private void handleBackPressed()');
  const result = method(main, 'protected void onActivityResult(');
  const openSimple = method(
    main,
    'final String fallbackUrl) {',
  );

  assert.match(bridge, /pendingPlayerRecoveryExpiresAtElapsedMs\s*=/);
  assert.match(bridge, /postDelayed\([\s\S]{0,420}clearPendingPlayerRecovery\(token\)/);
  assert.match(back, /clearPendingPlayerRecovery\(null\)/);
  assert.match(result, /getStringExtra\(PlayerActivity\.EXTRA_RECOVERY_TOKEN\)/);
  assert.match(result, /clearPendingPlayerRecovery\(null\)/);
  assert.match(result, /selectedVariantStreamId/);
  assert.doesNotMatch(
    result,
    /window\.__norvaNative[\s\S]{0,100}\.retryPlayback\(/,
    'Back must not relaunch the player through an unbound legacy retry',
  );
  assert.match(openSimple, /clearPendingPlayerRecovery\(null\)/);
});

test('phone Activity recreation restores route, scroll, filters and an active valid profile', () => {
  const save = method(main, 'protected void onSaveInstanceState(Bundle outState)');
  const restore = method(main, 'private boolean restoreCloudContinuity(Bundle savedInstanceState)');
  const persist = method(app, 'persistNativeContinuity()');
  const readContinuity = method(app, 'readNativeContinuity() {');
  const applyPage = method(app, 'applyPage(pageName) {');

  assert.match(save, /STATE_CLOUD_ROUTE/);
  assert.match(save, /persistNativeContinuity/);
  assert.doesNotMatch(save, /access[_-]?token|bearer|password|credential/i);
  assert.match(restore, /cloudContinuityUrl\(fragment\)/);
  assert.match(main, /appendQueryParameter\("_nativeRecovery",\s*"1"\)/);
  assert.match(app, /NORVA_NATIVE_CONTINUITY_KEY/);
  assert.match(persist, /pageScroll/);
  assert.match(persist, /gridScroll/);
  assert.doesNotMatch(persist, /email|profile|token|credential|password/i);
  assert.match(readContinuity, /NORVA_NATIVE_CONTINUITY_TTL_MS/);
  assert.match(app, /restoreNativeGridScroll/);
  assert.match(app, /_pageScroll/);
  assert.match(movies, /MediaUtils\.loadFilters\('movies'\)/);
  assert.match(movies, /MediaUtils\.saveFilters\('movies',\s*filters\)/);
  assert.match(series, /MediaUtils\.loadFilters\('series'\)/);
  assert.match(series, /MediaUtils\.saveFilters\('series',\s*filters\)/);
  assert.match(profiles, /async function ensureSelected\(options = \{\}\)/);
  assert.match(profiles, /options\.resumeActive === true/);
  assert.match(profiles, /activeIsUsable/);
  assert.match(app, /searchParams\.delete\('_nativeRecovery'\)/);
  assert.match(applyPage, /const navigationToken = \(this\._navigationToken \|\| 0\) \+ 1/);
  assert.match(
    applyPage,
    /if \(navigationToken !== this\._navigationToken\) return;/,
    'a late page preparation must not commit restored scroll/state over a newer route',
  );
});

test('native fiche continuity stores only bounded identity, never a provider payload', () => {
  const remember = method(app, 'rememberOpenFiche(fiche)');
  const nativeWriteAt = remember.indexOf('localStorage.setItem(NORVA_NATIVE_FICHE_KEY');
  assert.ok(nativeWriteAt >= 0, 'missing native fiche snapshot');
  const nativeWrite = remember.slice(nativeWriteAt, nativeWriteAt + 500);

  for (const field of ['type', 'sourceId', 'id', 'title', 'updatedAt']) {
    assert.match(nativeWrite, new RegExp(`\\b${field}\\b`));
  }
  assert.doesNotMatch(
    nativeWrite,
    /\b(group|series|item|url|token|credential|password|username)\s*:/i,
    'persistent native continuity must not copy the full provider/version object',
  );
});

test('/t/* App Links are canonicalized into the existing movies or series fiche route', () => {
  const deepLink = method(main, 'private boolean handleDeepLink(Intent intent)');
  const destination = method(main, 'private static String appLinkDestination(Uri data)');

  assert.match(manifest, /android:pathPrefix="\/t\/"/);
  assert.match(deepLink, /appLinkDestination\(data\)/);
  assert.match(destination, /getPath\(\)\.startsWith\("\/t\/"\)/);
  assert.match(destination, /page \+ "\/open:"/);
  assert.match(destination, /Uri\.encode\(sourceId\)/);
  assert.match(destination, /Uri\.encode\(itemId\)/);
  assert.match(main, /"movie"[\s\S]{0,180}return "movies"/);
  assert.match(main, /"series"[\s\S]{0,180}return "series"/);
});
