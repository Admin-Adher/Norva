'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

test('the authenticated Revolut quote freezes limited-promotion renewal terms', () => {
  const checkout = read('supabase/functions/norva-revolut/index.ts');

  assert.match(checkout, /version:\s*1,\s*checkoutTermsProtocol:\s*1/,
    'production can verify the commercial-terms protocol after a manual Edge reload');
  assert.match(checkout, /type CheckoutPromotionTerms = \{/);
  assert.match(checkout, /promotion_terms: CheckoutPromotionTerms \| null/);
  assert.match(checkout, /base_amount_minor: number/);
  assert.match(checkout, /billing_cycles: number/);
  assert.match(checkout,
    /\.select\("plan,period,requested_amount_cents,currency,charge_mode,trial_days,first_charge_at,base_amount_cents,promo_cycles"\)/,
    'reused orders must recover promotion terms from the immutable order journal');
  assert.match(checkout, /promotion_terms: promotionTerms/);
  assert.match(checkout, /cachedPromoEndMs > checkoutRequestedAtMs/,
    'an expired cached promotion must be restored to its base price before opening an order');
  assert.match(checkout, /base_amount_cents[\s\S]{0,260}promo_cycles/);
});

test('checkout presentation is reconciled only after the authenticated quote', () => {
  const checkout = read('public/checkout-revolut.html');

  assert.match(checkout, /Object\.prototype\.hasOwnProperty\.call\(payload, 'promotion_terms'\)/);
  assert.match(checkout, /promotionTermsComplete: hasServerPromotionTerms/);
  assert.match(checkout, /return quote\.promotionTermsComplete \|\| \(catalogMatchesQuote && publicPromo == null\)/,
    'an old server is compatible only when the exact catalog slot contains no promotion object');
  assert.doesNotMatch(checkout, /catalogMatchesQuote && !promoUi\.isActive\(publicPromo\)/,
    'client time must never turn a cached promotion into an old-server compatibility path');
  assert.match(checkout, /if \(!reconcileCheckoutPromotion\(catalog, quote\)\)[\s\S]{0,150}commercial_promotion_terms_unavailable/,
    'a promotional or unavailable old-server response must fail closed');
  assert.match(checkout, /function reconcileCheckoutPromotion\(catalog, quote\)/);
  assert.match(checkout, /catalogAmount === quote\.amountMinor/);
  assert.match(checkout, /publicBase === quote\.promotionTerms\.baseAmountMinor/);
  assert.match(checkout, /publicCycles === quote\.promotionTerms\.billingCycles/);

  const boot = checkout.slice(checkout.indexOf('async function bootInner()'));
  const quoteAt = boot.indexOf('applyServerCommercialTerms(data)');
  const promoAt = boot.indexOf('reconcileCheckoutPromotion(catalog, quote)');
  assert.ok(quoteAt >= 0 && promoAt > quoteAt,
    'public campaign data may decorate only an already validated server quote');

  const publicCatalog = checkout.slice(
    checkout.indexOf('let pricePromise'),
    checkout.indexOf('function waitForOptionalCatalog'),
  );
  assert.doesNotMatch(publicCatalog, /renderCheckoutPromo|displayPrice\s*=|sum-amount/,
    'the public catalog must not paint monetary state before authentication');
});

test('card updates suppress plan pricing and every promotional surface', () => {
  const checkout = read('public/checkout-revolut.html');
  const cardUpdate = checkout.slice(
    checkout.indexOf("if (checkoutKind === 'card_update')"),
    checkout.indexOf("} else if (checkoutKind === 'plan_change')"),
  );

  assert.match(cardUpdate, /clearCheckoutPromotion\(\)/);
  assert.match(cardUpdate, /commercialTerms\.hidden = true/);
  assert.match(cardUpdate, /summaryKicker\.textContent = [^;\r\n]*'PAYMENT METHOD'/);
  assert.match(cardUpdate, /sumPlan\.textContent = [^;\r\n]*'Secure card update'/);
  assert.match(cardUpdate, /sumTag\.textContent = [^\n]*'No plan change/);
});

test('the checkout price suffix stays compact in every checkout kind', () => {
  const checkout = read('public/checkout-revolut.html');
  assert.doesNotMatch(checkout, /sumPer\.textContent\s*=.*after your/,
    'trial explanations belong in the schedule and commitment, not the price column');
  assert.match(checkout, /if \(sumPer\) sumPer\.textContent = period === [^;\r\n]*'annual' \? '\/yr' : '\/mo'/);
});

test('subscription removes every expired promotion before painting catalog prices', () => {
  const subscribe = read('public/subscribe.html');

  assert.match(subscribe, /function pruneExpiredPromos\(requestedNowMs\)/);
  assert.match(subscribe, /promoUi\.isActive\(promo, nowMs\)/);
  assert.match(subscribe, /cardEl\.dataset\.annual = \(promo\.base_cents \/ 100\)\.toFixed\(2\)/);
  assert.match(subscribe, /pruneExpiredPromos\(Date\.now\(\)\);[\s\S]{0,100}period = next/,
    'cadence changes and timer expiry share one pruning boundary');
  assert.match(subscribe, /const normalized = normalizeLiveCatalog\(catalog, Date\.now\(\)\)/);
  assert.match(subscribe, /if \(!normalized\) return false/);
});

test('Revolut validation, cancellation and synchronous submit errors always re-arm safely', () => {
  const checkout = read('public/checkout-revolut.html');

  assert.match(checkout, /let cardValid = false/);
  assert.match(checkout, /function syncPayAvailability\(\)/);
  assert.match(checkout, /payBtn\.disabled = submitting \|\| !cardField \|\| !cardValid \|\| !commercialQuote/);
  assert.match(checkout, /onValidation: function \(errors\)[\s\S]{0,500}submitting = false;[\s\S]{0,300}syncPayAvailability\(\)/);
  assert.match(checkout, /onCancel: function \(\)[\s\S]{0,220}submitting = false;[\s\S]{0,180}syncPayAvailability\(\)/);
  assert.match(checkout, /try \{[\s\S]{0,120}cardField\.submit\([\s\S]{0,260}catch \(error\)[\s\S]{0,180}submitting = false/);
});

test('Revolut provider failures are reduced before logs, storage and client responses', () => {
  const edge = read('supabase/functions/norva-revolut/index.ts');
  assert.match(edge, /function revolutFailureDiagnostic\(/);
  assert.match(edge, /\^\[a-z0-9\]\[a-z0-9_-\]\{0,47\}\$/,
    'only a bounded provider code may cross the diagnostic boundary');
  assert.match(edge, /p_error: JSON\.stringify\(providerFailure\)/);
  assert.match(edge, /code: providerFailure\.code/);
  assert.doesNotMatch(edge, /detail:\s*created\.body/,
    'the raw provider payload must never reach the browser');
  assert.doesNotMatch(edge, /create order failed[^\n]*JSON\.stringify\(created\.body\)/,
    'the raw provider payload must never reach operational logs');
});
