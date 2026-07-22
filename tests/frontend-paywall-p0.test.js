const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

test('transaction paywalls make the supported-screen value proposition central and keep the media disclaimer', () => {
  for (const file of [
    'public/index.html',
    'public/landing.html',
    'public/subscribe.html',
    'public/paywall.html',
    'public/checkout-revolut.html',
  ]) {
    const source = read(file);
    assert.match(source, /One subscription[\s\S]{0,140}Web[\s\S]{0,80}Android mobile[\s\S]{0,80}Android TV/i, file);
    assert.match(source, /Norva is a media player[\s\S]{0,100}no content or TV subscription is included/i, file);
  }
});

test('connected-product navigation presents the shipped Android apps as available', () => {
  const app = read('public/js/app.js');
  assert.match(app, /Android mobile app/);
  assert.match(app, /Android TV app/);
  assert.match(app, /Available now/);
  assert.doesNotMatch(app, />Coming soon</);
});

test('transaction screens keep terms, privacy and self-service cancellation accessible', () => {
  for (const file of ['public/subscribe.html', 'public/checkout-revolut.html']) {
    const source = read(file);
    assert.match(source, /href="\/terms\.html"/i, file);
    assert.match(source, /href="\/privacy\.html"/i, file);
    assert.match(source, /href="\/subscription\.html">Manage or cancel a subscription</i, file);
  }
  const subscribe = read('public/subscribe.html');
  const noTrialRewrite = subscribe.slice(
    subscribe.indexOf('function applyNoTrialCopy()'),
    subscribe.indexOf('function showTrialConfirmation'),
  );
  assert.match(noTrialRewrite, /note\.innerHTML/);
  assert.match(noTrialRewrite, /Manage or cancel a subscription/,
    'the no-trial state must preserve legal and cancellation links');
});

test('all changed funnel assets use fresh cache keys', () => {
  const appHtml = read('public/app.html');
  const appJs = read('public/js/app.js');
  const subscribe = read('public/subscribe.html');
  assert.match(appHtml, /marketing\.js\?v=2/);
  assert.match(appHtml, /cloudApi\.js\?v=52/);
  assert.match(appHtml, /Settings\.js\?v=44/);
  assert.match(appHtml, /profiles\.js\?v=10/);
  assert.match(appHtml, /billing-config\.js\?v=8/);
  assert.match(appHtml, /billing\.js\?v=17/);
  assert.match(appHtml, /app\.js\?v=48/);
  assert.match(appJs, /AdminPage\.js\?v=84/);
  assert.match(subscribe, /marketing\.js\?v=2/);
  assert.match(subscribe, /cloudApi\.js\?v=52/);
  assert.match(subscribe, /billing-config\.js\?v=8/);
  assert.match(subscribe, /billing\.js\?v=17/);
});

test('trial recap states automatic conversion and links to plan management', () => {
  const app = read('public/js/app.js');
  assert.doesNotMatch(app, /never charged automatically/i);
  assert.match(app, /selected plan starts and renews automatically when the trial ends unless you cancel/i);
  assert.match(app, /managePlanHref = '\/subscription\.html\?returnTo='/);
  assert.match(app, />Manage plan<\/a>/);
});

test('web checkout emits begin_checkout once from the authenticated order snapshot', () => {
  const marketing = read('public/js/marketing.js');
  const checkout = read('public/checkout-revolut.html');
  const clickHandler = marketing.slice(
    marketing.indexOf("document.addEventListener('click'"),
    marketing.indexOf('window.NorvaMarketing ='),
  );
  assert.doesNotMatch(clickHandler, /track\('begin_checkout'/,
    'generic CTA tracking must not invent a monthly checkout');
  assert.equal((checkout.match(/NorvaMarketing\.track\('begin_checkout'/g) || []).length, 1);
  assert.match(checkout, /revolutCreateOrder[\s\S]{0,320}applyServerCommercialTerms\(data\)/);
  assert.match(checkout, /currency: quote\.currency/);
  assert.match(checkout, /value: quote\.amountMinor \/ 100/);
  assert.match(checkout, /period: quote\.period/);
  assert.match(checkout, /const orderId = String\(\(data && data\.order_id\) \|\| ''\)/);
  assert.match(checkout, /transaction_id: orderId/);
  assert.match(checkout, /price_source: 'revolut_order_snapshot'/);
  assert.match(checkout, /function trackBeginCheckoutOnce\(data, quote\)/);
  assert.match(checkout, /norva-marketing-begin-checkout:' \+ orderId/);
  assert.match(checkout, /localStorage\.getItem\(dedupeKey\)/);
  assert.match(checkout, /localStorage\.setItem\(dedupeKey/,
    'the same server order must not emit another marketing checkout after reload/reuse');
});

test('native billing reads localized RevenueCat offers and fails closed without them', () => {
  const billing = read('public/js/billing.js');
  const subscribe = read('public/subscribe.html');
  assert.match(billing, /__norvaBilling\.onOfferings/);
  assert.match(billing, /postNativeBilling\('getOfferingsForUser', \[uid\], requestId\)/);
  assert.match(billing, /NorvaBillingNative/);
  assert.match(billing, /channel\.postMessage\(JSON\.stringify/);
  assert.match(billing, /nativeOfferings: nativeOfferings/);
  assert.match(billing, /loadNativeOffers: nativeOfferings/);
  assert.match(billing, /pkg\.priceString[\s\S]{0,180}pkg\.priceMicros[\s\S]{0,180}pkg\.currencyCode/);
  assert.match(billing, /nativeOfferPromisesByUser = new Map\(\)/);
  assert.match(billing, /pageNonce/);
  assert.match(subscribe, /native-prices-pending/);
  assert.match(subscribe, /Both cadences for both plans must be known/);
  assert.match(subscribe, /offer\.priceString/);
  assert.match(subscribe, /Number\(offer\.priceMicros\) \/ 1000000/);
  assert.match(subscribe, /No purchase can start until the exact store price is available/);
  assert.match(subscribe, /if \(nativeOffersRequired && !nativeOffersReady\)/);
  assert.match(subscribe, /offer\.trialEligibility/);
  assert.match(subscribe, /offer && offer\.trialPeriodIso8601/);
  assert.match(subscribe, /offer && offer\.trialPriceString/);
  assert.match(subscribe, /nativeOffersRequired \? 'Subscribe with Google Play' : 'Subscribe'/);
  assert.match(subscribe, /nativeAnyTrial = nativeOffers\.some/);
  assert.match(subscribe, /if \(!nativeAnyTrial\) applyNoTrialCopy\(\)/);
  assert.match(subscribe, /String\(offer\.periodIso8601 \|\| ''\)\.toUpperCase\(\) !== expectedPeriod/);
  assert.match(subscribe, /offer\.supported !== true/);
  assert.match(subscribe, /offeringId: selectedOffer \? selectedOffer\.offeringId/);
  assert.match(subscribe, /nativeCurrencies\.size !== 1/);
  assert.match(subscribe, /annual \/ \(monthly \* 12\)/,
    'native savings must be recomputed from exact Google Play prices');
  assert.match(subscribe, /nativeSaveBadge\.textContent = minSaving === maxSaving/);
});

test('Android TV has one external purchase path and native prices cannot be overwritten by web prices', () => {
  const subscribe = read('public/subscribe.html');
  const checkout = read('public/checkout-revolut.html');
  assert.match(subscribe, /id="tv-purchase-path"/);
  assert.match(subscribe, /Open norva\.tv, sign in with this same Norva account, then choose your plan/i);
  assert.match(subscribe, /if \(tvPurchaseOnly\)[\s\S]{0,120}b\.disabled = true;[\s\S]{0,80}b\.hidden = true/);
  assert.match(subscribe, /if \(!window\.NorvaBilling\.isNative\(\) && window\.NorvaBilling\.revolutPrices\)/);
  assert.match(subscribe, /b\.isRevolutEnabled\(\) && !b\.hasNativeBilling\(\) && !b\.isNative\(\)/);
  assert.match(checkout, /NorvaBilling\.isTvShell\(\)[\s\S]{0,180}location\.replace\('\/subscribe\.html/);
});

test('checkout shows a calendar first-charge date and blocks stale price fallbacks', () => {
  const checkout = read('public/checkout-revolut.html');
  assert.match(checkout, /id="bd-first-date"/);
  assert.match(checkout, /payload\.first_charge_at \|\| payload\.trial_ends_at/);
  assert.match(checkout, /Number\(payload\.trial_days\)/);
  assert.match(checkout, /applyServerCommercialTerms\(data\)/);
  assert.match(checkout, /applyServerTrialSchedule\(r\)/);
  assert.doesNotMatch(checkout, /FALLBACK_TRIAL_DAYS/);
  assert.match(checkout, /First payment on/);
  assert.match(checkout, /if \(!serverFirstChargeAt\) return '—'/,
    'the UI must never manufacture a first-charge date locally');
  assert.match(checkout, /first payment is scheduled for '[\s\S]{0,100}trialChargeDate\(\)/i);
  assert.match(checkout, /id="sum-amount">—<\/span>/);
  assert.match(checkout, /class="quote-pending"/);
  assert.match(checkout, /id="commercial-terms"/);
  assert.match(checkout, /applyServerCommercialTerms/);
  assert.match(checkout, /commercial_terms_invalid/);
  assert.match(checkout, /document\.documentElement\.classList\.remove\('quote-pending'\)/);
  assert.match(checkout, /The exact plan, price and renewal terms could not be verified/);
  assert.doesNotMatch(checkout, /const prices = \(cfg\.plans/,
    'checkout must not paint an independently maintained fallback price');
  assert.doesNotMatch(checkout, /<h1>Start your free trial<\/h1>/,
    'trial copy must not be painted before the server decides checkout kind');
  assert.match(checkout, /function waitForOptionalCatalog\(\)/);
  assert.match(checkout, /const timeoutMs = 1200/);
  assert.match(checkout, /Promise\.all\(\[pendingOrder, waitForOptionalCatalog\(\)\]\)/,
    'the authenticated quote must start in parallel with the bounded optional catalog');
  assert.doesNotMatch(checkout, /await pricePromise;/,
    'the optional public catalog must never block checkout indefinitely');
  assert.match(checkout, /if \(publicCatalogAbandoned \|\| commercialQuote\) return false/,
    'a late public response must never repaint the authenticated quote');
});

test('resubscribe copy reflects an immediate captured payment without false reassurance', () => {
  const checkout = read('public/checkout-revolut.html');
  assert.match(checkout, /your plan starts only after today\\'s payment is confirmed/i);
  assert.match(checkout, /Billed today:[\s\S]{0,180}displayMoney\(displayPrice\)/);
  assert.match(checkout, /Today\\'s payment was confirmed/);
  assert.match(checkout, /Your payment may still be processing[\s\S]{0,160}Don't submit it again/);
});

test('paywall_exposed is recorded only for a visible offer and never blocks the UI', () => {
  const subscribe = read('public/subscribe.html');
  const gate = read('public/paywall.html');
  for (const [source, placement] of [[subscribe, 'paywallPlacement'], [gate, "'access_gate'"]]) {
    assert.match(source, /new IntersectionObserver/);
    assert.match(source, /entry\.isIntersecting && entry\.intersectionRatio > 0/);
    assert.match(source, /recordPaywallExposure\(\{/);
    assert.match(source, new RegExp('placement: ' + placement));
    assert.match(source, /let confirmed = false/);
    assert.match(source, /scheduleRetry/);
    assert.match(source, /recordPaywallExposure\([\s\S]{0,260}\)\.then\(/,
      placement + ' analytics must be non-blocking');
    assert.match(source, /window\.addEventListener\('online'/,
      placement + ' must retry an unacknowledged exposure after connectivity returns');
  }
  assert.match(subscribe, /appUserId\(\)[\s\S]{0,160}norva-cloud-device-token/);
  assert.match(subscribe, /if \(nativeOffersRequired && !nativeOffersReady\) return/);
  assert.match(subscribe, /if \(!entitlementResolved \|\| hasLivePlan\) return/);
  assert.match(subscribe, /entitlementResolved = true/);
  assert.match(subscribe, /async function initializeCommercialPaywall\(\)[\s\S]{0,120}await checkExisting\(\);[\s\S]{0,80}if \(includedAccess\) return;/,
    'the commercial paywall must resolve included access before loading or exposing offers');
  const initializer = subscribe.slice(subscribe.indexOf('async function initializeCommercialPaywall()'));
  assert.ok(initializer.indexOf('await checkExisting();') < initializer.indexOf('loadNativePrices()'),
    'authoritative account eligibility must resolve before native prices are requested');
  assert.ok(initializer.indexOf('if (includedAccess) return;') < initializer.indexOf('observePaywallExposure();'),
    'included accounts must exit before a commercial exposure can be recorded');
  assert.doesNotMatch(subscribe, /nativeOffersReady = true;[\s\S]{0,180}observePaywallExposure\(\)/,
    'native pricing alone is not enough to count an exposure before entitlement resolves');
  assert.match(gate, /showDenied\(decision\);\s*observeDeniedPaywallExposure\(\);/);
});

test('web plan selector fails closed when exact prices are unavailable', () => {
  const subscribe = read('public/subscribe.html');
  assert.match(subscribe, /class="prices-pending"/);
  assert.match(subscribe, /webPricesRequired && !webPricesReady/);
  assert.match(subscribe, /Current price unavailable/);
  assert.match(subscribe, /markWebPricesUnavailable/);
  assert.match(subscribe, /if \(!applyLivePrices\(catalog\)\) markWebPricesUnavailable\(\)/);
});

test('locked profile placement is allowlisted end to end', () => {
  const subscribe = read('public/subscribe.html');
  const billing = read('public/js/billing.js');
  const checkout = read('public/checkout-revolut.html');
  const revolut = read('supabase/functions/norva-revolut/index.ts');
  assert.match(subscribe, /params\.get\('context'\) === 'locked_profile'/);
  assert.match(subscribe, /placement: paywallPlacement/);
  assert.match(billing, /opts\.placement === 'locked_profile'/);
  assert.match(checkout, /params\.get\('placement'\) === 'locked_profile'/);
  assert.match(checkout, /revolutCreateOrder\(\{ plan, period, returnTo, intent, placement \}\)/);
  assert.match(revolut, /if \(!selectedExperiment\)[\s\S]{0,100}Unsupported paywall placement/);
});

test('plan changes disclose the exact server next-cycle date', () => {
  const checkout = read('public/checkout-revolut.html');
  assert.match(checkout, /kind === 'plan_change' && !serverFirstChargeAt/);
  assert.match(checkout, /firstLabel\.textContent = 'New plan starts on'/);
  assert.match(checkout, /finalValue\.textContent = 'Current plan stays active'/);
  assert.match(checkout, /const special = \(checkoutKind === 'card_update' \|\| checkoutKind === 'resubscribe'\)/);
});

test('Family annual fallbacks match the production catalog snapshot', () => {
  for (const file of [
    'public/index.html',
    'public/landing.html',
    'public/subscribe.html',
    'public/js/billing-config.js',
  ]) {
    const source = read(file);
    assert.doesNotMatch(source, /75\.99|6\.33/, file);
    assert.match(source, /74\.99/, file);
  }
  assert.match(read('public/subscribe.html'), /That's about \$6\.25\/mo/);
});

test('edited checkout inline module remains valid JavaScript', () => {
  const source = read('public/checkout-revolut.html');
  const scripts = Array.from(source.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi));
  assert.ok(scripts.length > 0);
  scripts.forEach((match, index) => {
    assert.doesNotThrow(() => new Function(match[1]), `checkout inline script ${index + 1}`);
  });
});
