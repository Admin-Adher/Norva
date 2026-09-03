const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

function nativeAccountRuntime(storedConsent = null) {
  const messages = [];
  const appendedScripts = [];
  const storage = new Map();
  const windowListeners = new Map();
  if (storedConsent) {
    storage.set('norva_consent', JSON.stringify({ status: storedConsent, v: 1, ts: 1 }));
  }

  function element(tagName) {
    const listeners = new Map();
    return {
      tagName,
      attributes: {},
      children: [],
      parentNode: null,
      className: '',
      setAttribute(name, value) { this.attributes[name] = value; },
      getAttribute(name) { return this.attributes[name]; },
      addEventListener(name, listener) { listeners.set(name, listener); },
      appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        if (child.src) appendedScripts.push(child.src);
        return child;
      },
      removeChild(child) {
        this.children = this.children.filter(item => item !== child);
        child.parentNode = null;
      },
      querySelector() { return null; },
      listeners,
    };
  }

  const head = element('head');
  const body = element('body');
  const documentElement = element('html');
  const document = {
    readyState: 'complete',
    head,
    body,
    documentElement,
    createElement: tagName => element(tagName),
    getElementById(id) {
      return [...head.children, ...body.children, ...documentElement.children]
        .find(node => node.id === id || node.attributes.id === id) || null;
    },
    addEventListener() {},
  };
  const localStorage = {
    getItem: key => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
  };
  const window = {
    NORVA_MARKETING_CONFIG: {
      enabled: true,
      consentMode: 'denied',
      debug: false,
      googleAnalytics: { measurementId: 'G-TEST', sendPageView: false },
      googleAds: { conversionId: 'AW-TEST', conversions: { signup: 'SIGNUP-LABEL' } },
      meta: { pixelId: 'META-TEST' },
      productAnalytics: {
        schema: 'norva-product-analytics:v2',
        funnelVersion: 'norva-funnel:v2',
        clarity: { enabled: true, projectId: 'clarity-test', allowedPaths: ['/account'] },
      },
    },
    NorvaAnalyticsNative: { postMessage: raw => messages.push(JSON.parse(raw)) },
    addEventListener(name, listener) {
      const current = windowListeners.get(name) || [];
      current.push(listener);
      windowListeners.set(name, current);
    },
    matchMedia: () => ({ matches: false }),
    console,
  };
  const context = vm.createContext({
    window,
    document,
    navigator: { userAgent: 'Mozilla/5.0 NorvaTV-AndroidPhone/1.0' },
    location: { pathname: '/account', hostname: 'norva.tv', hash: '', search: '' },
    localStorage,
    console,
    Date,
    JSON,
    Object,
    Set,
    encodeURIComponent,
  });

  for (const script of [
    'public/js/marketing.js',
    'public/js/native-analytics.js',
    'public/js/product-analytics.js',
    'public/js/consent-banner.js',
  ]) {
    vm.runInContext(read(script), context, { filename: script });
  }

  return { window, body, messages, appendedScripts, storage };
}

function acceptVisibleBanner(runtime) {
  const banner = runtime.body.children.find(node => node.className === 'norva-consent');
  assert.ok(banner, 'the first-run consent banner should be visible');
  const listener = banner.listeners.get('click');
  assert.equal(typeof listener, 'function');
  listener({
    target: {
      closest: selector => selector === '[data-consent]'
        ? { getAttribute: name => name === 'data-consent' ? 'granted' : null }
        : null,
    },
  });
}

test('Android first-run Accept then same-page signup reaches the native bridge', () => {
  const runtime = nativeAccountRuntime();
  acceptVisibleBanner(runtime);
  assert.equal(runtime.window.NorvaTrackProduct('signup_completed', {
    method: 'google',
    journey: 'acquisition',
    step: 'signup',
    outcome: 'success',
  }), true);

  const consentIndex = runtime.messages.findIndex(message =>
    message.type === 'consent' && message.status === 'granted');
  const signupIndex = runtime.messages.findIndex(message =>
    message.type === 'event' && message.name === 'signup_completed');
  assert.ok(consentIndex >= 0, 'native consent must be delivered');
  assert.ok(signupIndex > consentIndex,
    'Firebase must be enabled before the same-page signup event crosses the bridge');
  assert.equal(runtime.storage.get('norva_consent').includes('granted'), true);
  assert.equal(runtime.window.gtag, undefined, 'gtag must not be created in the Android WebView');
  assert.equal(runtime.window.fbq, undefined, 'Meta Pixel must not be created in the Android WebView');
  assert.deepEqual(runtime.appendedScripts, [], 'no browser analytics tag may load in the Android WebView');
});

test('saved consent still cannot bootstrap browser tags after Android reload', () => {
  const runtime = nativeAccountRuntime('granted');
  runtime.window.NorvaMarketing.setConsent('granted');
  assert.equal(runtime.window.NorvaTrackProduct('login_completed', {
    method: 'email_password',
    outcome: 'success',
  }), true);

  assert.ok(runtime.messages.some(message =>
    message.type === 'event' && message.name === 'login_completed'));
  assert.equal(runtime.window.gtag, undefined);
  assert.equal(runtime.window.fbq, undefined);
  assert.deepEqual(runtime.appendedScripts, []);
});

test('native callback is allowlisted and maps only signup_completed to GA4 sign_up', () => {
  const adapter = read('clients/android-common/src/main/java/tv/norva/analytics/NativeClarity.java');
  const phone = read('clients/android-phone/app/src/main/java/tv/norva/phone/MainActivity.java');

  assert.match(adapter, /interface EventListener[\s\S]*void onEvent\(String eventName\)/);
  assert.match(adapter,
    /if \(!EVENTS\.contains\(eventName\)\) return;[\s\S]{0,500}eventListener\.onEvent\(eventName\)/,
    'only the shared closed vocabulary may reach Firebase');
  assert.match(phone, /MainActivity\.this::logFirebaseProductEvent/);
  assert.match(phone,
    /"signup_completed"\.equals\(eventName\)[\s\S]{0,120}FirebaseAnalytics\.Event\.SIGN_UP/);
  assert.doesNotMatch(phone,
    /"checkout_started"\.equals\(eventName\)[\s\S]{0,120}BEGIN_CHECKOUT/,
    'native Play billing already owns the canonical begin_checkout event');
});
