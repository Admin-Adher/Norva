const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

function loadMarketing({ consentMode = 'granted' } = {}) {
  const script = fs.readFileSync(path.join(root, 'public/js/marketing.js'), 'utf8');
  const appendedScripts = [];
  const window = {
    NORVA_MARKETING_CONFIG: {
      enabled: true,
      consentMode,
      debug: false,
      googleAnalytics: { measurementId: 'G-TEST', sendPageView: false },
      googleAds: {
        conversionId: 'AW-TEST',
        conversions: {
          signup: 'SIGNUP-LABEL',
          beginCheckout: 'CHECKOUT-LABEL',
          trialStart: 'TRIAL-LABEL',
          purchase: 'PURCHASE-LABEL',
        },
      },
      meta: { pixelId: '' },
    },
    console,
  };
  const document = {
    readyState: 'complete',
    head: { appendChild(node) { appendedScripts.push(node.src); } },
    documentElement: { appendChild(node) { appendedScripts.push(node.src); } },
    createElement() {
      return { setAttribute() {} };
    },
    addEventListener() {},
  };
  const context = vm.createContext({
    window,
    document,
    location: { search: '', pathname: '/account.html' },
    console,
    Date,
    Object,
    encodeURIComponent,
  });
  vm.runInContext(script, context);
  return { window, appendedScripts };
}

test('completed account signup emits the GA4 sign_up event and the configured Google Ads conversion', () => {
  const { window } = loadMarketing();

  window.NorvaMarketing.track('signup_completed', {
    method: 'google',
    outcome: 'success',
  });

  const calls = window.dataLayer.map((entry) => Array.from(entry));
  const events = calls.filter((entry) => entry[0] === 'event');
  assert.equal(events.filter((entry) => entry[1] === 'sign_up').length, 1);
  assert.equal(events.filter((entry) => entry[1] === 'signup_completed').length, 0,
    'the product-funnel name must be normalized before it reaches GA4');
  assert.equal(events.filter((entry) => entry[1] === 'conversion'
    && entry[2] && entry[2].send_to === 'AW-TEST/SIGNUP-LABEL').length, 1);

  const account = fs.readFileSync(path.join(root, 'public/account.html'), 'utf8');
  assert.match(account, /\/js\/marketing\.js\?v=5/,
    'the account page must invalidate cached marketing adapters');
});

test('Google Consent Mode v2 stays fail-closed until explicit opt-in', () => {
  const { window, appendedScripts } = loadMarketing({ consentMode: 'denied' });
  const initialCalls = window.dataLayer.map((entry) => Array.from(entry));
  const defaultConsent = initialCalls.find((entry) => entry[0] === 'consent' && entry[1] === 'default');

  assert.deepEqual(JSON.parse(JSON.stringify(defaultConsent[2])), {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'denied',
  });
  assert.equal(appendedScripts.length, 0, 'the Google tag must not load before opt-in');

  window.NorvaMarketing.setConsent('granted');
  const calls = window.dataLayer.map((entry) => Array.from(entry));
  const updateConsent = calls.find((entry) => entry[0] === 'consent' && entry[1] === 'update');
  assert.deepEqual(JSON.parse(JSON.stringify(updateConsent[2])), {
    ad_storage: 'granted',
    ad_user_data: 'granted',
    ad_personalization: 'granted',
    analytics_storage: 'granted',
  });
  assert.equal(appendedScripts.length, 1, 'the Google tag should load after explicit opt-in');
});

test('commercial funnel events route to their dedicated Google Ads actions', () => {
  const { window } = loadMarketing();
  const events = [
    ['begin_checkout', 'CHECKOUT-LABEL'],
    ['start_trial', 'TRIAL-LABEL'],
    ['purchase', 'PURCHASE-LABEL'],
  ];

  events.forEach(([name, label]) => {
    window.NorvaMarketing.track(name, {
      currency: 'EUR',
      value: 9.99,
      transaction_id: `test-${name}`,
    });
    const conversions = window.dataLayer
      .map((entry) => Array.from(entry))
      .filter((entry) => entry[0] === 'event'
        && entry[1] === 'conversion'
        && entry[2]
        && entry[2].send_to === `AW-TEST/${label}`);
    assert.equal(conversions.length, 1, `${name} must emit exactly one dedicated Ads conversion`);
  });

  const checkout = fs.readFileSync(path.join(root, 'public/checkout-revolut.html'), 'utf8');
  assert.match(checkout,
    /checkoutKind === 'resubscribe'[\s\S]{0,900}NorvaMarketing\.track\('purchase'/,
    'a server-confirmed immediate resubscribe charge must emit purchase');
  assert.doesNotMatch(checkout,
    /checkoutKind === 'trial_setup'[\s\S]{0,500}NorvaMarketing\.track\('purchase'/,
    'a free-trial card setup must never be counted as a purchase');
});

test('landing acquisition placements survive the bounded analytics allowlist', () => {
  const landing = fs.readFileSync(path.join(root, 'public/js/landing.js'), 'utf8');
  const productAnalytics = fs.readFileSync(path.join(root, 'public/js/product-analytics.js'), 'utf8');
  const nativeAnalytics = fs.readFileSync(path.join(root, 'public/js/native-analytics.js'), 'utf8');

  assert.match(landing, /closest\('\.landing-nav'\) \? 'nav'/,
    'navigation signup intent must use the canonical nav source');
  for (const source of ['nav', 'final_cta', 'footer']) {
    assert.match(productAnalytics, new RegExp(`source:[^\\n]+['\"]${source}['\"]`));
    assert.match(nativeAnalytics, new RegExp(`source:[^\\n]+['\"]${source}['\"]`));
  }
});
