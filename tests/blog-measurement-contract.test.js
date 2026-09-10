const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/js/marketing.js'), 'utf8');
const KEY = 'norva_blog_context_v1';
const slug = 'resolution-and-bitrate-why-they-are-not-the-same';
const consentSource = fs.readFileSync(path.join(__dirname, '../public/js/consent-banner.js'), 'utf8');

function runtime(options = {}) {
  const listeners = {};
  const scripts = [];
  const storage = options.storage || new Map();
  const storageCalls = [];
  let now = options.now || 1_000_000;
  const location = {
    origin: 'https://norva.tv', hostname: 'norva.tv', pathname: `/blog/${slug}/`,
    search: '?utm_source=google&utm_medium=organic', hash: '', ...options.location,
  };
  const window = {
    NORVA_MARKETING_CONFIG: {
      enabled: options.enabled !== false,
      consentMode: options.consent || 'denied',
      googleAnalytics: { measurementId: options.gaId === undefined ? 'G-TEST' : options.gaId, sendPageView: true },
      googleAds: { conversionId: 'AW-TEST', conversions: { signup: 'SIGNUP', trialStart: 'TRIAL', purchase: 'PURCHASE', beginCheckout: 'CHECKOUT' } },
      meta: { pixelId: '' },
    },
  };
  const document = {
    readyState: 'complete',
    createElement: () => ({ setAttribute() {} }),
    head: { appendChild: script => scripts.push(script) },
    addEventListener: (name, listener) => { listeners[name] = listener; },
    querySelector: () => options.marker === false ? null : ({ getAttribute: name => name === 'data-blog-language' ? (options.language || 'en') : (options.marker || slug) }),
  };
  const sessionStorage = {
    getItem: key => { storageCalls.push(['get', key]); if (options.storageBlocked) throw Error('blocked'); return storage.get(key) || null; },
    setItem: (key, value) => { storageCalls.push(['set', key]); if (options.storageBlocked) throw Error('blocked'); storage.set(key, value); },
    removeItem: key => { storageCalls.push(['remove', key]); if (options.storageBlocked) throw Error('blocked'); storage.delete(key); },
  };
  class Clock extends Date { static now() { return now; } }
  vm.runInNewContext(source, {
    window, document, location, sessionStorage, URL, Date: Clock,
    navigator: { userAgent: options.native ? 'Mozilla NorvaTV-AndroidPhone/1.0' : 'Mozilla/5.0' },
  });
  const events = () => Array.from(window.dataLayer || [], value => Array.from(value))
    .filter(value => value[0] === 'event')
    .map(value => ({ name: value[1], params: JSON.parse(JSON.stringify(value[2])) }));
  function click(attrs = {}) {
    const attributes = { 'data-cta': 'blog-article', 'data-blog-cta': 'primary', href: '/account.html?returnTo=%2Fapp%23home', ...attrs };
    const cta = { getAttribute: name => attributes[name] || null, textContent: 'private@example.test' };
    listeners.click({ target: { closest: () => cta } });
  }
  return { window, events, click, scripts, storage, storageCalls, location, advance: ms => { now += ms; } };
}

test('blog measurement does not load a tag, emit, persist or replay a click before consent', () => {
  const app = runtime();
  app.click();
  assert.deepEqual(app.events(), []);
  assert.deepEqual(app.scripts, []);
  assert.deepEqual(app.storageCalls, []);
  app.window.NorvaMarketing.setConsent('granted');
  assert.equal(app.events().filter(e => e.name === 'blog_view').length, 1);
  assert.equal(app.events().filter(e => e.name === 'blog_cta_click').length, 0);
  app.window.NorvaMarketing.init();
  app.window.NorvaMarketing.setConsent('granted');
  assert.equal(app.events().filter(e => e.name === 'blog_view').length, 1);
});

test('blog events contain only bounded editorial context, not raw link text or query parameters', () => {
  const app = runtime({ consent: 'granted' });
  app.click({ href: '/account.html?email=private@example.test&token=super-secret&returnTo=%2Fapp%23home' });
  assert.deepEqual(app.events().map(e => e.name), ['blog_view', 'blog_cta_click']);
  assert.deepEqual(app.events()[1].params, {
    send_to: 'G-TEST', event_source: 'blog', content_group: 'blog', measurement_environment: 'production',
    article_slug: slug, article_language: 'en', cta_placement: 'primary', cta_target: 'signup',
  });
  const serialized = JSON.stringify([app.events(), [...app.storage]]);
  for (const secret of ['private@example.test', 'super-secret', 'utm_source', 'returnTo']) assert.equal(serialized.includes(secret), false);
  assert.equal(app.location.search, '?utm_source=google&utm_medium=organic', 'never rewrite acquisition query parameters');
  assert.equal(app.events().some(e => ['select_content', 'sign_up', 'start_trial', 'purchase', 'conversion'].includes(e.name)), false);
});

test('interface source is renamed only at the marketing boundary with a closed vocabulary', () => {
  const app = runtime({ consent: 'granted', location: { pathname: '/' } });
  const params = { source: 'landing', outcome: 'success' };
  app.window.NorvaMarketing.track('landing_view', params);
  assert.deepEqual(app.events().at(-1).params, { event_source: 'landing', outcome: 'success' });
  assert.equal(params.source, 'landing', 'do not mutate caller/native details');
  app.window.NorvaMarketing.track('landing_view', { source: 'private@example.test', event_source: 'credential-dump' });
  assert.deepEqual(app.events().at(-1).params, {});
  app.window.NorvaMarketing.track('landing_view', { source: 'landing', event_source: 'nav' });
  assert.deepEqual(app.events().at(-1).params, { event_source: 'nav' });
});

test('only a real existing funnel event receives same-tab blog context; Ads payload is unchanged', () => {
  const app = runtime({ consent: 'granted' });
  app.click();
  const next = runtime({ consent: 'granted', storage: app.storage, location: { pathname: '/account.html' } });
  assert.deepEqual(next.events(), [], 'remembered click must never synthesize a conversion');
  next.window.NorvaMarketing.track('signup_completed', { method: 'google', outcome: 'success' });
  const signup = next.events().find(e => e.name === 'sign_up');
  assert.equal(signup.params.blog_article_slug, slug);
  assert.equal(signup.params.blog_context_model, 'last_cta_30m');
  assert.equal(signup.params.send_to, 'G-TEST');
  assert.deepEqual(next.events().filter(e => e.name === 'conversion'), [{
    name: 'conversion', params: { send_to: 'AW-TEST/SIGNUP', method: 'google', outcome: 'success' },
  }]);
  next.window.NorvaMarketing.track('journey_error', { outcome: 'error' });
  assert.equal(next.events().at(-1).params.blog_article_slug, undefined);
});

test('context expires strictly at 30 minutes and opt-out removes only its own key', () => {
  const app = runtime({ consent: 'granted' });
  app.click();
  app.storage.set('unrelated', 'keep');
  app.advance(30 * 60 * 1000);
  app.window.NorvaMarketing.track('start_trial', { transaction_id: 'verified-order' });
  assert.equal(app.events().find(e => e.name === 'start_trial').params.blog_article_slug, undefined);
  assert.equal(app.storage.has(KEY), false);
  app.click();
  app.window.NorvaMarketing.setConsent('denied');
  assert.equal(app.storage.has(KEY), false);
  assert.equal(app.storage.get('unrelated'), 'keep');
  const count = app.events().length;
  app.click();
  app.window.NorvaMarketing.track('start_trial', {});
  assert.equal(app.events().length, count);
  assert.match(consentSource, /reset:[\s\S]*apply\('denied'\)/, 'existing Manage cookies reset must revoke the adapter');
});

test('invalid, future and tampered context is removed without transmitting its content', () => {
  const base = { v: 1, slug, placement: 'primary', target: 'signup', at: 999_999 };
  for (const record of [
    'bad json', { ...base, slug: 'person@example.test' }, { ...base, placement: 'private' },
    { ...base, target: 'https://provider.test/password' }, { ...base, at: 2_000_000 },
    { ...base, at: '999999' }, { ...base, v: 2 }, { ...base, at: null },
    { ...base, language: 'private@example.test' },
  ]) {
    const storage = new Map([[KEY, typeof record === 'string' ? record : JSON.stringify(record)]]);
    const app = runtime({ consent: 'granted', storage, location: { pathname: '/account.html' } });
    app.window.NorvaMarketing.track('signup_completed', {});
    assert.equal(app.events().find(e => e.name === 'sign_up').params.blog_article_slug, undefined);
    assert.equal(storage.has(KEY), false);
  }
});

test('localized articles retain canonical slug and bounded language through the real GA4 funnel only', () => {
  for (const language of ['fr', 'pt-BR', 'es', 'hi', 'tr', 'bn', 'ar', 'id', 'fil']) {
    const app = runtime({ consent: 'granted', language, location: { pathname: `/blog/${language}/${slug}/` } });
    app.click();
    assert.equal(app.events()[0].params.article_language, language);
    assert.equal(app.events()[1].params.article_slug, slug);
    const next = runtime({ consent: 'granted', storage: app.storage, location: { pathname: '/account.html' } });
    next.window.NorvaMarketing.track('signup_completed', { method: 'email' });
    assert.equal(next.events().find(e => e.name === 'sign_up').params.blog_article_language, language);
    assert.equal(next.events().find(e => e.name === 'conversion').params.blog_article_language, undefined);
  }
  const mismatch = runtime({ consent: 'granted', language: 'ar', location: { pathname: `/blog/fr/${slug}/` } });
  assert.deepEqual(mismatch.events(), []);
  const query = runtime({ consent: 'granted', location: { search: '?article_language=ar&email=private' } });
  assert.equal(query.events()[0].params.article_language, 'en');
});

test('blocked storage falls back to event-only collection without breaking a CTA', () => {
  const app = runtime({ consent: 'granted', storageBlocked: true });
  assert.doesNotThrow(() => app.click());
  assert.equal(app.events().filter(e => e.name === 'blog_cta_click').length, 1);
  assert.doesNotThrow(() => app.window.NorvaMarketing.track('signup_completed', {}));
  assert.equal(app.events().find(e => e.name === 'sign_up').params.blog_article_slug, undefined);
});

test('native, disabled and missing-GA configurations do not emit or persist blog context', () => {
  for (const options of [{ native: true }, { enabled: false }, { gaId: '' }]) {
    const app = runtime({ consent: 'granted', ...options });
    app.click();
    assert.deepEqual(app.events(), []);
    assert.deepEqual(app.storageCalls, []);
    if (options.native) assert.equal(app.window.gtag, undefined);
  }
});

test('article marker must agree with pathname and queries cannot create an article identity', () => {
  for (const options of [{ marker: false }, { marker: 'wrong-slug' }, { location: { pathname: '/blog/person%40example.test/' } }]) {
    const app = runtime({ consent: 'granted', ...options });
    assert.equal(app.events().some(e => e.name === 'blog_view'), false);
  }
  const index = runtime({ consent: 'granted', location: { pathname: '/blog/' } });
  index.click({ 'data-blog-cta': 'nav' });
  assert.equal(index.events()[0].params.article_slug, 'blog_index');
  assert.equal(index.storage.has(KEY), false);
});

test('CTA destinations and placements are classified without forwarding arbitrary destinations', () => {
  const app = runtime({ consent: 'granted' });
  for (const [href, expected] of [
    ['/#features', 'features'], ['/#how-it-works', 'how_it_works'], ['/#product-preview', 'product_preview'],
    ['/#pricing', 'pricing'], ['/app#settings/sources', 'source_settings'], ['/app#movies', 'app'],
    ['/support.html', 'support'], ['/terms.html', 'legal'], ['/blog/another-post/', 'blog'],
    ['https://evil.test/account.html', 'other'], ['javascript:alert(1)', 'other'],
    ['https://secret@norva.tv/account.html', 'other'], ['/unknown?secret=1', 'other'],
  ]) {
    app.click({ href });
    assert.equal(app.events().at(-1).params.cta_target, expected, href);
  }
  const before = app.events().length;
  app.click({ 'data-blog-cta': 'email@example.test' });
  assert.equal(app.events().length, before);
  app.click({ 'data-cta': 'blog-nav', 'data-blog-cta': '' });
  assert.equal(app.events().at(-1).params.cta_placement, 'nav');
});

test('preview measurements are labeled QA without touching production settings', () => {
  const app = runtime({ consent: 'granted', location: { hostname: 'localhost', origin: 'http://localhost:8080' } });
  assert.equal(app.events()[0].params.measurement_environment, 'qa');
});
