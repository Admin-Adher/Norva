const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

function productRuntime({ hash = '#movies' } = {}) {
  const listeners = {};
  const appended = [];
  const window = {
    NORVA_MARKETING_CONFIG: {
      enabled: true,
      productAnalytics: {
        schema: 'norva-product-analytics:v2',
        funnelVersion: 'norva-funnel:v2',
        clarity: { enabled: true, projectId: 'y8fgihobbx', allowedPaths: ['/app.html'] }
      }
    },
    NorvaMarketing: { setConsent() {}, track() {} },
    addEventListener: (name, fn) => { listeners[name] = fn; },
    matchMedia: () => ({ matches: false })
  };
  const document = {
    readyState: 'complete',
    createElement: () => ({ setAttribute() {} }),
    head: { appendChild: node => appended.push(node) },
    documentElement: { appendChild: node => appended.push(node) }
  };
  vm.runInNewContext(read('public/js/product-analytics.js'), {
    window,
    document,
    navigator: { userAgent: 'Mozilla/5.0' },
    location: { pathname: '/app.html', hostname: 'norva.tv', hash },
    localStorage: { getItem: () => JSON.stringify({ status: 'granted', v: 1 }) },
    encodeURIComponent,
    Set
  });
  return { window, listeners, appended };
}

test('Smart Event spine stays exactly at Clarity custom-event capacity', () => {
  const runtime = productRuntime();
  const spine = Array.from(runtime.window.NorvaProductAnalytics.smartEventSpine);
  assert.equal(spine.length, 20);
  assert.equal(new Set(spine).size, 20);
  assert.deepEqual(spine, [
    'app_open', 'primary_cta_clicked', 'signup_started', 'signup_completed',
    'plan_selected', 'checkout_started', 'checkout_completed',
    'provider_connect_started', 'provider_connected', 'provider_access_saved',
    'provider_action_required', 'provider_repair_started', 'provider_repair_succeeded',
    'catalog_sync_started', 'catalog_ready', 'content_opened',
    'playback_started', 'playback_first_frame', 'journey_retry', 'journey_error'
  ]);
});

test('every core product surface loads the common adapters before consent', () => {
  const surfaces = [
    ['public/account.html', 1],
    ['public/app.html', 3],
    ['public/subscribe.html', 1],
    ['public/paywall.html', 1],
    ['public/checkout-revolut.html', 1],
    ['public/subscription.html', 1]
  ];
  for (const [file, consentVersion] of surfaces) {
    const html = read(file);
    const config = html.indexOf('/js/marketing-config.js?v=2');
    const native = html.indexOf('/js/native-analytics.js?v=2');
    const product = html.indexOf('/js/product-analytics.js?v=2');
    const consent = html.indexOf(`/js/consent-banner.js?v=${consentVersion}`);
    assert.ok(config >= 0 && config < native && native < product && product < consent,
      `${file}: common analytics adapters must precede consent`);
  }
});

test('auth, commerce, provider and playback journeys emit the shared funnel vocabulary', () => {
  const account = read('public/account.html');
  const subscribe = read('public/subscribe.html');
  const checkout = read('public/checkout-revolut.html');
  const sources = read('public/js/components/SourceManager.js');
  const watch = read('public/js/pages/WatchPage.js');
  for (const event of ['signup_started', 'login_started']) {
    assert.match(account, new RegExp(event));
  }
  assert.match(account, /trackAuth\(`\$\{intent\}_completed`/);
  assert.match(account, /completeAuthFunnel\('email_password'\)/);
  assert.match(account, /completeAuthFunnel\('google'\)/);
  for (const event of ['plan_selected', 'checkout_started', 'checkout_completed']) {
    assert.match(subscribe, new RegExp(event));
  }
  for (const event of ['checkout_started', 'checkout_completed']) {
    assert.match(checkout, new RegExp(event));
  }
  assert.match(sources, /provider_connect_started[\s\S]*provider_connected/);
  assert.match(sources, /provider_access_saved/);
  assert.match(sources, /catalog_sync_started[\s\S]*catalog_ready/);
  assert.match(sources, /provider_action_required[\s\S]*provider_repair_started[\s\S]*provider_repair_succeeded/);
  assert.match(watch, /content_opened[\s\S]*playback_first_frame/);
  assert.match(watch, /journey_retry/);
});

test('adapter has no identity API and drops arbitrary dimensions before all analytics sinks', () => {
  const runtime = productRuntime();
  runtime.window.NorvaProductAnalytics.track('journey_error', {
    journey: 'time_to_value',
    step: 'playback',
    outcome: 'error',
    failureFamily: 'network',
    email: 'private@example.test',
    sourceId: 'source-secret',
    rawError: 'credential dump'
  });
  const calls = (runtime.window.clarity.q || []).map(args => Array.from(args));
  assert.ok(calls.some(args => args[0] === 'event' && args[1] === 'journey_error'));
  const serialized = JSON.stringify(calls);
  assert.equal(serialized.includes('private@example.test'), false);
  assert.equal(serialized.includes('source-secret'), false);
  assert.equal(serialized.includes('credential dump'), false);
  assert.equal(read('public/js/product-analytics.js').includes("clarity('identify'"), false);
});

test('screen tags reduce dynamic routes to a closed privacy-safe page name', () => {
  const runtime = productRuntime({ hash: '#movies/open:private-title-id' });
  const calls = (runtime.window.clarity.q || []).map(args => Array.from(args));
  const screenTag = calls.find(args => args[0] === 'set' && args[1] === 'norva_screen');
  assert.deepEqual(screenTag, ['set', 'norva_screen', 'movies']);
  assert.equal(JSON.stringify(calls).includes('private-title-id'), false);
});
