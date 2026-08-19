const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

const expectedWallpapers = Object.freeze({
  black_friday: 'black-friday-v2.png',
  cyber_monday: 'cyber-monday-v2.png',
  winter_sale: 'winter-sale-v2.png',
  summer_sale: 'summer-sale-v2.png',
  christmas: 'christmas-v2.png',
  new_year: 'new-year-v2.png',
  lunar_new_year: 'lunar-new-year-v2.png',
  eid: 'eid-v2.png',
  easter: 'easter-v2.png',
  halloween: 'halloween-v2.png',
  valentines: 'valentines-v2.png',
  back_to_school: 'back-to-school-v2.png',
  birthday: 'birthday-v2.png',
  flash: 'flash-v2.png',
});

test('production commerce pages use the approved shared visual system', () => {
  const subscribe = read('public/subscribe.html');
  const checkout = read('public/checkout-revolut.html');

  for (const [name, source] of [['subscribe', subscribe], ['checkout', checkout]]) {
    assert.match(source, /\/css\/commerce\.css\?v=3/, `${name} loads the shared commerce styles`);
    assert.match(source, /\/js\/promo-ui\.js\?v=1/, `${name} loads the shared campaign contract`);
    assert.match(source, /class="campaign-backdrop"/, `${name} renders campaign art as a page background`);
    assert.match(source, /role="timer"[\s\S]{0,180}aria-live="off"/, `${name} countdown avoids per-second announcements`);
    assert.match(source, /visa-brandmark\.svg/);
    assert.match(source, /mastercard-symbol\.svg/);
  }

  assert.match(subscribe, /id="page-eyebrow"/);
  assert.match(subscribe, /id="page-title"/);
  assert.ok(subscribe.indexOf('let countdownTimer = 0') < subscribe.indexOf('applyPeriod(wantedPeriod)'),
    'the campaign timer is initialized before the initial period render');
  assert.doesNotMatch(subscribe, /const PROMO_ICONS/,
    'campaign identity is expressed by real copy and artwork, not emoji');
});

test('production checkout keeps the real payment action before optional schedule detail', () => {
  const checkout = read('public/checkout-revolut.html');
  const commerceCss = read('public/css/commerce.css');
  const payButtonAt = checkout.indexOf('id="pay-btn"');
  const scheduleAt = checkout.indexOf('<details class="schedule-details"');

  assert.ok(payButtonAt > 0 && scheduleAt > payButtonAt,
    'the real Revolut action precedes the schedule in DOM and reading order');
  assert.match(checkout, /<details class="schedule-details"[\s\S]*?id="bill-breakdown"/);
  assert.match(checkout, /id="card-field"/);
  assert.match(checkout, /revolutCreateOrder\(\{ plan, period, returnTo, intent, placement \}\)/);
  assert.match(checkout, /applyServerCommercialTerms\(data\)/);
  assert.doesNotMatch(checkout, /\.timeline-value\s*\{[^}]*margin-top:\s*-\d/i);
  assert.match(checkout, /toLocaleDateString\('en-US'/,
    'an English checkout must not mix a browser-locale date into its chrome');
  assert.match(commerceCss, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(84px,\s*auto\)/,
    'the price column must not collapse the plan copy on desktop');
  assert.match(commerceCss, /#commercial-terms\s*\{[\s\S]{0,120}max-width:\s*180px/,
    'the commercial terms column stays compact on desktop');
});

test('shared production promo state expires only the selected offer', () => {
  const promoUi = require('../public/js/promo-ui.js');
  assert.deepEqual(Object.fromEntries(Object.entries(promoUi.events).map(([key, value]) => [key, value.filename])),
    expectedWallpapers);

  const now = Date.parse('2026-08-11T12:00:00Z');
  const promos = {
    plus: { monthly: { event: 'black_friday', ends_at: '2026-08-11T12:00:01Z' } },
    family: { monthly: { event: 'summer_sale', ends_at: '2026-08-12T12:00:00Z' } },
  };
  assert.equal(promoUi.selectPromo(promos, 'plus', 'monthly', now).plan, 'plus');
  assert.equal(promoUi.selectPromo(promos, 'plus', 'monthly', now + 1000).plan, 'family',
    'an expired preferred offer falls through without invalidating another live offer');
  assert.equal(promoUi.countdownTo(now + 1, now).text, '00:00:01');
  assert.equal(promoUi.countdownTo(now, now).expired, true);
});

test('all fourteen production campaign wallpapers are deployable assets', () => {
  const assetRoot = path.join(root, 'public', 'img', 'promo-wallpapers');
  for (const filename of Object.values(expectedWallpapers)) {
    const target = path.join(assetRoot, filename);
    assert.ok(fs.existsSync(target), filename);
    assert.ok(fs.statSync(target).size > 1_000_000, `${filename} keeps a full-quality source`);
  }
});

test('catalog region onboarding never interrupts the commerce funnel', () => {
  const cloudApi = read('public/js/cloudApi.js');
  assert.match(cloudApi,
    /login\|cloud\|account\|cloud-pair\|hub-connect\|subscribe\|paywall\|checkout-revolut/,
    'the catalog-only region dialog stays out of plan selection and payment');
});
