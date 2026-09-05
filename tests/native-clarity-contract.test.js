const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

function runNativeAdapter(hash = '#settings/sources', pathname = '/app.html') {
  const messages = [];
  const listeners = {};
  const window = {
    NorvaAnalyticsNative: { postMessage: value => messages.push(JSON.parse(value)) },
    addEventListener: (name, listener) => { listeners[name] = listener; }
  };
  const document = {
    readyState: 'complete',
    addEventListener() {},
    documentElement: {
      attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; }
    }
  };
  vm.runInNewContext(read('public/js/native-analytics.js'), {
    window,
    document,
    location: { hash, pathname },
    JSON,
    Set
  });
  return { window, messages, listeners };
}

test('native adapter sends only a bounded screen and exact consent payload', () => {
  const runtime = runNativeAdapter();
  assert.equal(runtime.window.NorvaNativeAnalytics.available(), true);
  assert.deepEqual(runtime.messages[0], {
    v: 2, type: 'screen', name: 'settings_sources'
  });
  runtime.window.NorvaNativeAnalytics.setConsent('granted');
  assert.deepEqual(runtime.messages[1], {
    v: 2, type: 'consent', status: 'granted'
  });
  assert.deepEqual(runtime.messages[2], {
    v: 2, type: 'screen', name: 'settings_sources'
  });
});

test('native WebView capture preserves geometry but masks all rendered content', () => {
  const runtime = runNativeAdapter('#home');
  assert.equal(runtime.window.NorvaNativeAnalytics.available(), true);
  assert.match(read('public/js/native-analytics.js'),
    /documentElement\.setAttribute\('data-clarity-mask', 'true'\)/);
});

test('first-run account consent is bridged immediately and labelled as account', () => {
  const account = read('public/account.html');
  assert.match(account, /native-analytics\.js\?v=[0-9a-f]+[\s\S]*product-analytics\.js\?v=[0-9a-f]+[\s\S]*consent-banner\.js\?v=[0-9a-f]+/);
  const runtime = runNativeAdapter('', '/account');
  assert.deepEqual(runtime.messages[0], {
    v: 2, type: 'screen', name: 'account'
  });
  runtime.window.NorvaNativeAnalytics.setConsent('denied');
  assert.deepEqual(runtime.messages[1], {
    v: 2, type: 'consent', status: 'denied'
  });
});

test('native adapter rejects arbitrary event names and payload identifiers', () => {
  const runtime = runNativeAdapter('#movies');
  assert.equal(runtime.window.NorvaNativeAnalytics.track('provider_access_saved_user_123'), false);
  assert.equal(runtime.messages.length, 1);
  assert.equal(runtime.window.NorvaNativeAnalytics.track('provider_access_saved'), true);
  assert.deepEqual(runtime.messages[1], {
    v: 2, type: 'event', name: 'provider_access_saved'
  });
  assert.equal(JSON.stringify(runtime.messages).includes('user_123'), false);
});

test('Android shells are analytics-eligible only through the native consent bridge', () => {
  const html = read('public/app.html');
  const consent = read('public/js/consent-banner.js');
  const adapter = read('clients/android-common/src/main/java/tv/norva/analytics/NativeClarity.java');
  const phoneGradle = read('clients/android-phone/app/build.gradle');
  const tvGradle = read('clients/android-tv/app/build.gradle');
  const phoneMain = read('clients/android-phone/app/src/main/java/tv/norva/phone/MainActivity.java');
  assert.match(html, /native-analytics\.js\?v=[0-9a-f]+[\s\S]*product-analytics\.js\?v=[0-9a-f]+[\s\S]*consent-banner\.js\?v=[0-9a-f]+/);
  assert.doesNotMatch(consent, /isTvSurface\(\)\)\s*\{\s*apply\('granted'/);
  assert.match(consent, /NorvaNativeAnalytics\.setConsent\(status\)/);
  assert.match(consent, /if \(nativeSurface\)[\s\S]*NorvaNativeAnalytics\.setConsent\(status\)[\s\S]*NorvaProductAnalytics\.setConsent\(status\)[\s\S]*return/);
  assert.match(adapter, /boolean possible = Clarity\.initialize\(activity,/);
  assert.match(adapter, /Clarity\.setOnSessionStartedCallback/);
  assert.match(adapter, /PENDING_EVENTS\.size\(\) < EVENTS\.size\(\)/);
  assert.match(phoneGradle, /CLARITY_PROJECT_ID[^\n]*y9fagfyr9a/);
  assert.match(tvGradle, /CLARITY_PROJECT_ID[^\n]*y9fxs54jpc/);
  for (const consentType of [
    'ANALYTICS_STORAGE',
    'AD_STORAGE',
    'AD_USER_DATA',
    'AD_PERSONALIZATION'
  ]) {
    assert.match(phoneMain, new RegExp(`ConsentType\\.${consentType}`));
  }
  assert.ok(
    phoneMain.indexOf('analytics.setConsent(settings)')
      < phoneMain.indexOf('analytics.setAnalyticsCollectionEnabled(granted)'),
    'Firebase Consent Mode v2 must be set before collection is enabled'
  );
});

test('native context is split into bounded identifier-free bridge messages', () => {
  const runtime = runNativeAdapter('#movies');
  assert.equal(runtime.window.NorvaNativeAnalytics.track('journey_error', {
    journey: 'time_to_value',
    step: 'playback',
    outcome: 'error',
    failureFamily: 'network',
    providerId: 'source-secret'
  }), true);
  assert.deepEqual(runtime.messages.slice(1), [
    { v: 2, type: 'context', tags: { journey_name: 'time_to_value' } },
    { v: 2, type: 'context', tags: { journey_step: 'playback' } },
    { v: 2, type: 'context', tags: { journey_outcome: 'error' } },
    { v: 2, type: 'context', tags: { failure_family: 'network' } },
    { v: 2, type: 'event', name: 'journey_error' }
  ]);
  assert.equal(JSON.stringify(runtime.messages).includes('source-secret'), false);
});

test('native playback and downloads remain useful but content-masked', () => {
  for (const file of [
    'clients/android-phone/app/src/main/java/tv/norva/phone/PlayerActivity.java',
    'clients/android-tv/app/src/main/java/tv/norva/tv/PlayerActivity.java',
    'clients/android-phone/app/src/main/java/tv/norva/phone/DownloadsActivity.java'
  ]) {
    const source = read(file);
    assert.match(source, /NativeClarity\.registerSensitiveView\(/);
    assert.doesNotMatch(source, /NativeClarity\.(?:event|screen)\([^)]*(?:title|provider|source|url)/i);
  }
});
