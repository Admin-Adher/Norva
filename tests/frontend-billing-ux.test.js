const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const { safeLocalPath } = require('../public/js/navigation-safety.js');

test('edited billing and login pages keep valid inline JavaScript', () => {
  for (const file of [
    'public/paywall.html',
    'public/subscribe.html',
    'public/subscription.html',
    'public/login.html',
  ]) {
    const source = read(file);
    const scripts = Array.from(source.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi));
    assert.ok(scripts.length > 0, `${file} has no inline script to validate`);
    scripts.forEach((match, index) => {
      assert.doesNotThrow(() => new Function(match[1]), `${file} inline script ${index + 1}`);
    });
  }
});

test('safeLocalPath keeps local deep links and normalizes their shape', () => {
  assert.equal(safeLocalPath('/app#movies', '/app#home'), '/app#movies');
  assert.equal(safeLocalPath(' /subscription.html?tab=billing#card ', '/app#home'),
    '/subscription.html?tab=billing#card');
  assert.equal(safeLocalPath('/app/../account.html', '/app#home'), '/account.html');
});

test('safeLocalPath rejects every external or browser-ambiguous redirect form', () => {
  const fallback = '/app#home';
  [
    null,
    '',
    'https://evil.example/steal',
    '//evil.example/steal',
    '///evil.example/steal',
    '/\\evil.example/steal',
    '\\evil.example\\steal',
    'javascript:alert(1)',
    '/app\nhttps://evil.example',
  ].forEach((value) => assert.equal(safeLocalPath(value, fallback), fallback, String(value)));
});

test('paywall and subscribe sanitize returnTo before using it in links or redirects', () => {
  for (const file of ['public/paywall.html', 'public/subscribe.html']) {
    const source = read(file);
    assert.match(source, /navigation-safety\.js/);
    assert.match(source, /function safeLocalPath\(value\)/);
    assert.match(source, /const returnTo = safeLocalPath\(params\.get\('returnTo'\)\)/);
    assert.doesNotMatch(source, /const returnTo = params\.get\('returnTo'\)/);
  }
});

test('subscription, support and TV pairing reject backslash redirect ambiguity', () => {
  const subscription = read('public/subscription.html');
  assert.match(subscription, /navigation-safety\.js/);
  assert.match(subscription, /NorvaNavigation\.safeLocalPath\(v, '\/app#home'\)/);
  for (const file of ['public/support.html', 'public/cloud-pair.html']) {
    const source = read(file);
    assert.match(source, /\\\\\\u0000-\\u001f\\u007f|indexOf\('\\\\'\)/,
      `${file} must reject backslashes/control characters in return targets`);
  }
});

test('subscription exposes an explicit opt-in backed by the authenticated lifecycle endpoint', () => {
  const source = read('public/subscription.html');
  assert.match(source, /id="marketing-email-opt-in" type="checkbox"/);
  assert.match(source, /\/functions\/v1\/norva-lifecycle\/preferences/);
  assert.match(source, /marketing_email: requested/);
  assert.match(source, /source: 'account_settings'/);
  assert.match(source, /Billing and account emails are still sent when needed/);
});

test('plan copy uses exact annual equivalents and an explicit household distinction', () => {
  const subscribe = read('public/subscribe.html');
  const paywall = read('public/paywall.html');

  assert.match(subscribe, /data-annual="41\.99" data-annual-note="That's about \$3\.50\/mo/);
  assert.match(subscribe, /data-annual="74\.99" data-annual-note="That's about \$6\.25\/mo/);
  assert.match(subscribe, /pl\.annual \/ 1200/);
  assert.doesNotMatch(subscribe, /Math\.floor\(pl\.annual \/ 12\)/);
  assert.match(subscribe, />Best for households</);
  assert.match(subscribe, /Up to 2 profiles/);
  assert.match(subscribe, /Up to 5 profiles/);
  assert.match(paywall, /Norva includes 2 profiles;\s*Norva Family includes 5/);
});

test('failed Revolut cancel restores controls and keeps the confirmation open', () => {
  const source = read('public/subscription.html');
  const start = source.indexOf("cancelNow.addEventListener('click', async function () {");
  const end = source.indexOf("const keep = el('button'", start);
  assert.ok(start >= 0 && end > start, 'async cancel handler not found');
  const handler = source.slice(start, end);

  assert.match(source, /let cancelReason = 'skipped'/,
    'cancellation feedback must remain optional by default');
  assert.match(source, /Optional — what is the main reason\?/);
  assert.doesNotMatch(source, /input\.required\s*=\s*true/,
    'the optional reason must never gate cancellation');
  assert.match(handler, /await doCancel\(cancelReason\)/);
  assert.ok(handler.indexOf('cm.close();') < handler.indexOf('location.reload();'),
    'the modal must close only after the API succeeds');
  assert.match(handler, /catch \(e\)/);
  assert.match(handler, /cancelNow\.disabled = false/);
  assert.match(handler, /b\.disabled = false/);
  assert.match(handler, /keep\.disabled = false/);
  assert.match(handler, /modalError\.hidden = false/);

  const doCancelStart = source.indexOf('async function doCancel(reason)');
  const doCancelEnd = source.indexOf('\n      }', doCancelStart);
  const doCancel = source.slice(doCancelStart, doCancelEnd);
  assert.doesNotMatch(doCancel, /catch/,
    'doCancel must not swallow the error before the modal can recover');
  assert.doesNotMatch(doCancel, /location\.reload/,
    'reload belongs to the successful UI branch');
});

test('failed Revolut resume restores its button and exposes an accessible error', () => {
  const source = read('public/subscription.html');
  const start = source.indexOf('function resumeControl(decision)');
  const end = source.indexOf('\n      function detailRows', start);
  const block = source.slice(start, end);

  assert.match(block, /clearActionError\(\)/);
  assert.match(block, /b\.disabled = false; b\.textContent = 'Resume plan'/);
  assert.match(block, /showActionError\('resume', e\)/);
  assert.match(source, /storeNote\.setAttribute\('role', 'alert'\)/);
});

test('an unverified billing record is never presented as an active plan or trial', () => {
  const source = read('public/subscription.html');
  assert.match(source, /const needsVerification = decision\.planCode === 'free'/);
  assert.match(source, /Verification needed/);
  assert.match(source, /Retry verification/);
  assert.ok(source.indexOf('if (needsVerification)') < source.indexOf("if (status === 'trialing')"));
});

test('included system access never exposes payment state or billing controls', () => {
  const subscription = read('public/subscription.html');
  const settings = read('public/js/pages/Settings.js');
  const app = read('public/js/app.js');
  const entitlements = read('supabase/functions/_shared/entitlements.ts');

  assert.match(subscription, /function isIncludedAccess\(decision\)/);
  assert.match(subscription, /if \(isIncludedAccess\(decision\)\) return;/);
  assert.ok(subscription.indexOf('if (isIncludedAccess(decision)) {') <
    subscription.indexOf("if (status === 'past_due'"),
  'included access must be rendered before any payment-issue branch');
  assert.match(subscription, /Nothing renews and there is nothing to pay/);

  assert.match(settings, /provider === 'system' \|\| provider === 'manual'/);
  assert.match(settings, /button\.style\.display = 'none'/);
  assert.match(settings, /Included access/);

  assert.equal((app.match(/this\._maybeShowBillingAlert\(/g) || []).length, 1,
    'the app must render only one global billing warning');
  assert.doesNotMatch(app, /this\.maybeShowBillingIssueBanner\(\)/);
  assert.match(app, /const includedProvider = provider === 'system' \|\| provider === 'manual'/);
  assert.match(app, /https:\/\/apps\.apple\.com\/account\/subscriptions/);

  assert.match(entitlements, /reason: includedAccess \? "included_access" : reason/);
});

test('hard-blocked accounts get support guidance without a billing CTA', () => {
  const subscription = read('public/subscription.html');
  const settings = read('public/js/pages/Settings.js');
  assert.match(subscription, /function isHardBlocked\(decision\)/);
  assert.match(subscription, /This account cannot start or manage a payment/);
  assert.ok(subscription.indexOf('if (isHardBlocked(decision))') <
    subscription.indexOf("if (status === 'past_due'"));
  assert.match(settings, /includedAccess \|\| hardBlocked/);
  assert.match(settings, /Access under review/);
});

test('login separates cloud and local-hub authentication without open redirects', () => {
  const source = read('public/login.html');
  assert.match(source, /navigation-safety\.js/);
  assert.match(source, /window\.__norvaCloudLoginRedirect \? '\/app#home' : '\/'/);
  assert.match(source, /\^\(\?:www\\\.\)\?norva\\\.tv\$/);
  assert.match(source, /location\.replace\('\/account\.html\?returnTo=' \+ encodeURIComponent/);
  assert.match(source, /window\.location\.replace\(window\.__norvaLoginReturnTo \|\| '\/'\)/);
  assert.doesNotMatch(source, /window\.location\.replace\('\/'\);/);
  assert.match(source, /<h1>Norva Hub<\/h1>/);
  assert.match(source, /Looking for your Norva Cloud account/);
});
