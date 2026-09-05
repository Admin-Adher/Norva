const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

test('landing exposes both shipped Play Store apps directly below the primary hero actions', () => {
  for (const file of ['public/index.html', 'public/landing.html']) {
    const html = read(file);
    const store = html.indexOf('class="hero-store-access');
    const preview = html.indexOf('class="device-stage');
    assert.ok(store > html.indexOf('class="hero-actions'), `${file}: store actions follow the conversion CTA`);
    assert.ok(store < preview, `${file}: store actions stay above the product preview`);
    assert.match(html, /play\.google\.com\/store\/apps\/details\?id=tv\.norva\.phone/);
    assert.match(html, /play\.google\.com\/store\/apps\/details\?id=tv\.norva\.tv/);
    assert.match(html, /data-store-platform="android_mobile"[\s\S]{0,1800}data-store-platform="android_tv"/);
    assert.match(html, /Google Play \(opens in a new tab\)/);

    const analytics = html.indexOf('/js/product-analytics.js');
    const consent = html.indexOf('/js/consent-banner.js');
    const landing = html.indexOf('/js/landing.js');
    assert.ok(analytics > 0 && analytics < consent && consent < landing,
      `${file}: analytics adapter must be ready before consent and landing events`);
  }
});

test('Play Store affordance has bounded pointer motion and an explicit reduced-motion fallback', () => {
  const css = read('public/css/landing-premium.css');
  const landing = read('public/js/landing.js');
  assert.match(css, /\.play-store-cta\s*\{[\s\S]*?min-height:\s*68px/);
  assert.match(css, /\.hero-store-access\s*\{[\s\S]*?position:\s*relative;[\s\S]*?z-index:\s*1;/,
    'the complete store-card surface must stay above the later product-preview layer');
  assert.match(css, /@media \(hover: hover\) and \(pointer: fine\)[\s\S]*?\.play-store-cta:hover/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.play-store-cta::after\s*\{\s*display:\s*none/);
  assert.match(css, /@media \(max-width: 680px\)[\s\S]*?\.hero-store-buttons\s*\{\s*grid-template-columns:\s*1fr/);
  assert.match(css, /\.norva-guide__launcher\s*\{[\s\S]*?margin-left:\s*auto/);
  assert.match(landing, /compactViewport\.matches[\s\S]*?revealOnScroll\(\)[\s\S]*?REVEAL_DELAY/);
});

function runAnalytics({ consent = 'granted', userAgent = 'Mozilla/5.0', pathname = '/' } = {}) {
  const listeners = {};
  const appended = [];
  const marketing = [];
  const window = {
    NORVA_MARKETING_CONFIG: {
      enabled: true,
      productAnalytics: {
        schema: 'norva-product-analytics:v2',
        funnelVersion: 'norva-funnel:v2',
        clarity: { enabled: true, projectId: 'y8fgihobbx', allowedPaths: ['/', '/landing.html', '/app.html'] }
      }
    },
    NorvaMarketing: {
      setConsent: value => marketing.push(['consent', value]),
      track: (name, params) => marketing.push(['track', name, params])
    },
    addEventListener: (name, listener) => { listeners[name] = listener; },
    matchMedia: query => ({ matches: /max-width: 680px/.test(query) })
  };
  const document = {
    readyState: 'complete',
    createElement: tagName => ({
      tagName,
      setAttribute(name, value) { this[name] = value; }
    }),
    head: { appendChild: node => appended.push(node) },
    documentElement: { appendChild: node => appended.push(node) }
  };
  const context = {
    window,
    document,
    navigator: { userAgent },
    location: { pathname, hostname: 'norva.tv', hash: '' },
    localStorage: { getItem: () => JSON.stringify({ status: consent, v: 1 }) },
    encodeURIComponent,
    Set
  };
  vm.runInNewContext(read('public/js/product-analytics.js'), context);
  return { window, listeners, appended, marketing };
}

test('Clarity starts only after stored consent on an eligible browser landing and receives safe product events', () => {
  const runtime = runAnalytics();
  assert.equal(runtime.appended.length, 1);
  assert.equal(runtime.appended[0].src, 'https://www.clarity.ms/tag/y8fgihobbx');
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.window.NorvaProductAnalytics.context())), {
    platform: 'web', runtime: 'browser', viewport: 'mobile', nativeShell: false
  });

  runtime.listeners['norva:landing-event']({
    detail: {
      event: 'store_cta_click',
      source: 'hero',
      target: 'android_tv',
      authenticated: false,
      question: 'must not become a Clarity tag'
    }
  });

  const calls = (runtime.window.clarity.q || []).map(args => Array.from(args));
  assert.ok(calls.some(args => args[0] === 'consentv2' && args[1].analytics_Storage === 'granted'));
  assert.ok(calls.some(args => args[0] === 'event' && args[1] === 'store_cta_clicked'));
  assert.ok(calls.some(args => args[0] === 'set' && args[1] === 'event_target' && args[2] === 'android_tv'));
  assert.ok(!calls.some(args => args[0] === 'identify'), 'account identity must never be sent to Clarity');
  assert.ok(!calls.some(args => args[0] === 'set' && args[1] === 'question'));
  const marketingTrack = runtime.marketing.find(args => args[0] === 'track' && args[1] === 'store_cta_clicked');
  assert.deepEqual(JSON.parse(JSON.stringify(marketingTrack[2])), {
    authenticated: 'anonymous', source: 'hero', target: 'android_tv'
  });
  assert.equal(Object.hasOwn(marketingTrack[2], 'question'), false);
});

test('Clarity stays fail-closed before consent and inside Android phone or TV shells', () => {
  const denied = runAnalytics({ consent: 'denied' });
  assert.equal(denied.appended.length, 0);
  denied.window.NorvaProductAnalytics.track('store_cta_click', { target: 'android_mobile' });
  assert.equal(denied.appended.length, 0);

  const tv = runAnalytics({ userAgent: 'NorvaTV-AndroidTV/3.1' });
  assert.equal(tv.appended.length, 0);
  assert.equal(tv.window.NorvaProductAnalytics.isClarityEligible(), false);

  const phone = runAnalytics({ userAgent: 'NorvaTV-AndroidPhone/1.0' });
  assert.equal(phone.appended.length, 0);
  assert.equal(phone.window.NorvaProductAnalytics.isClarityEligible(), false);
});

test('landing store clicks emit a dedicated analytics event and privacy disclosure names Clarity', () => {
  const landing = read('public/js/landing.js');
  const privacy = read('public/privacy.html');
  assert.match(landing, /querySelectorAll\('\[data-store-platform\]'\)[\s\S]*?emitLandingEvent\('store_cta_click'/);
  assert.match(privacy, /Microsoft Clarity/);
  assert.match(privacy, /privacy-masked session replay/i);
  assert.match(privacy, /Android mobile and Android TV use separate Clarity projects/i);
  assert.match(privacy, /credential-entry and playback views/i);
});
