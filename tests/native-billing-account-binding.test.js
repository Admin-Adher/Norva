const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const billingSource = fs.readFileSync(path.join(__dirname, '..', 'public/js/billing.js'), 'utf8');

function supportedPackage(overrides = {}) {
  return {
    offeringId: 'current-main',
    packageId: '$rc_monthly',
    productId: 'norva_plus',
    packageType: 'monthly',
    priceString: '4,99 €',
    priceMicros: 4990000,
    currencyCode: 'EUR',
    periodIso8601: 'P1M',
    supported: true,
    trialEligibility: 'eligible',
    trialPeriodIso8601: 'P7D',
    trialBillingCycles: 1,
    ...overrides,
  };
}

function loadBilling({ packageFactory = supportedPackage, legacy = false, userAgent = 'NorvaTV-AndroidPhone' } = {}) {
  const calls = { offerings: [], purchases: [], restores: [] };
  const window = {
    NORVA_BILLING_CONFIG: {},
    crypto: webcrypto,
    location: { search: '?mobile=1', assign() {} },
  };

  const bridge = legacy ? {
    getOfferings() {},
    purchase() {},
    restore() {},
  } : {
    getOfferingsForUser(userId, requestId) {
      calls.offerings.push({ userId, requestId });
      queueMicrotask(() => window.__norvaBilling.onOfferings(JSON.stringify({
        nativeBillingContract: 2,
        requestId,
        appUserId: userId,
        status: 'success',
        currentOfferingId: 'current-main',
        packages: [packageFactory()],
      })));
    },
    purchaseForUser(userId, offeringId, packageId, productId, planCode, placement, requestId) {
      calls.purchases.push({ userId, offeringId, packageId, productId, planCode, placement, requestId });
      queueMicrotask(() => window.__norvaBilling.onResult(JSON.stringify({
        nativeBillingContract: 2,
        requestId,
        status: 'success',
        appUserId: userId,
        offeringId,
        packageId,
        productId,
        planCode,
        selectedOfferTrialEligible: true,
        transactionMatchesProduct: true,
        entitlementActive: true,
        trialActive: true,
      })));
    },
    restoreForUser(userId, requestId) {
      calls.restores.push({ userId, requestId });
      queueMicrotask(() => window.__norvaBilling.onResult(JSON.stringify({
        requestId, status: 'restored', appUserId: userId,
      })));
    },
  };
  window.NorvaTVCloud = {};
  if (!legacy) {
    window.NorvaBillingNative = {
      postMessage(raw) {
        const message = JSON.parse(raw);
        const args = message.args.concat([message.requestId]);
        bridge[message.method].apply(bridge, args);
      },
    };
  }

  const context = vm.createContext({
    window,
    navigator: { userAgent },
    localStorage: { getItem() { return null; } },
    URLSearchParams,
    setTimeout,
    clearTimeout,
    console,
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    queueMicrotask,
    Math,
    Date,
    Uint32Array,
  });
  vm.runInContext(billingSource, context, { filename: 'billing.js' });
  return { billing: window.NorvaBilling, calls };
}

test('retention requires the shipped fresh-subscription-state fix before native purchase', async () => {
  for (const version of ['1.3.23', '1.3.24', '1.3.28']) {
    const { billing, calls } = loadBilling({ userAgent: `NorvaTV-AndroidPhone/${version}` });
    assert.equal(billing.hasPlayRetention(), false);
    assert.equal(await billing.playRetentionOffer('user-account-aaaaaaaa'), null);
    await assert.rejects(billing.purchasePlayRetention('user-account-aaaaaaaa', { id: 'offer' }),
      error => error.code === 'retention_unavailable');
    assert.equal(calls.purchases.length, 0);
  }
  for (const version of ['1.3.29', '1.3.30', '1.4.0', '2.0.0']) {
    assert.equal(loadBilling({ userAgent: `NorvaTV-AndroidPhone/${version}` }).billing.hasPlayRetention(), true);
  }
  assert.equal(loadBilling({ userAgent: 'NorvaTV-AndroidTV/3.8.22' }).billing.hasPlayRetention(), false);
  assert.equal(loadBilling({ legacy: true, userAgent: 'NorvaTV-AndroidPhone/1.3.29' }).billing.hasPlayRetention(), false);
});

test('native offerings are cached per account and use page-scoped request ids', async () => {
  const { billing, calls } = loadBilling();
  const userA = 'user-account-aaaaaaaa';
  const userB = 'user-account-bbbbbbbb';

  const [first, repeated] = await Promise.all([
    billing.nativeOfferings(userA),
    billing.nativeOfferings(userA),
  ]);
  assert.equal(first, repeated);
  assert.equal(calls.offerings.length, 1);

  await billing.nativeOfferings(userB);
  assert.equal(calls.offerings.length, 2);
  assert.notEqual(calls.offerings[0].requestId, calls.offerings[1].requestId);
  assert.match(calls.offerings[0].requestId, /^[a-z0-9]+:[1-9][0-9]*$/i);
});

test('native purchase is bound to the catalog user and exact current tuple', async () => {
  const { billing, calls } = loadBilling();
  const userId = 'user-account-aaaaaaaa';
  await billing.nativeOfferings(userId);

  const result = await billing.purchase({
    appUserId: userId,
    offeringId: 'current-main',
    packageId: '$rc_monthly',
    productId: 'norva_plus',
    planCode: 'plus',
    placement: 'locked_profile',
  });
  assert.equal(calls.purchases.length, 1);
  assert.deepEqual(
    Object.values(calls.purchases[0]).slice(0, 5),
    [userId, 'current-main', '$rc_monthly', 'norva_plus', 'plus'],
  );
  assert.equal(calls.purchases[0].placement, 'locked_profile');
  assert.equal(result.purchaseVerified, true);
  assert.equal(result.displayedOfferTrialEligible, true);

  await assert.rejects(
    billing.purchase({
      appUserId: userId,
      offeringId: 'stale-offering',
      packageId: '$rc_monthly',
      productId: 'norva_plus',
      planCode: 'plus',
    }),
    (error) => error && error.code === 'native_offer_not_bound',
  );
  assert.equal(calls.purchases.length, 1, 'a stale offer must fail before the native bridge');
});

test('old native shells and unsupported intro offers fail closed', async () => {
  const old = loadBilling({ legacy: true });
  assert.equal(old.billing.hasNativeBilling(), false);
  await assert.rejects(
    old.billing.nativeOfferings('user-account-aaaaaaaa'),
    (error) => error && error.code === 'native_contract_unavailable',
  );

  const paidIntro = loadBilling({
    packageFactory: () => supportedPackage({
      supported: false,
      unsupportedReason: 'paid_introductory_phase',
      trialEligibility: 'ineligible',
    }),
  });
  const userId = 'user-account-aaaaaaaa';
  await paidIntro.billing.nativeOfferings(userId);
  await assert.rejects(
    paidIntro.billing.purchase({
      appUserId: userId,
      offeringId: 'current-main',
      packageId: '$rc_monthly',
      productId: 'norva_plus',
      planCode: 'plus',
    }),
    (error) => error && error.code === 'native_offer_not_bound',
  );
  assert.equal(paidIntro.calls.purchases.length, 0);
});
