const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const targets = [
  {
    name: 'Android phone',
    billing: 'clients/android-phone/app/src/main/java/tv/norva/phone/NorvaBilling.java',
    main: 'clients/android-phone/app/src/main/java/tv/norva/phone/MainActivity.java',
    manifest: 'clients/android-phone/app/src/main/AndroidManifest.xml',
    gradle: 'clients/android-phone/app/build.gradle',
    versionCode: 17,
    versionName: '1.3.4',
    bridgeCount: 0,
  },
];

const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

for (const target of targets) {
  test(`${target.name}: catalog and purchase bridges are account-bound`, () => {
    const billing = read(target.billing);
    const main = read(target.main);

    assert.match(billing, /static void getOfferingsForUser\(final String userId, final String requestId,/);
    assert.match(billing, /static void purchaseForUser\(final Activity activity, final String userId,/);
    assert.match(billing, /userId\.equals\(purchases\.getAppUserID\(\)\)/);
    assert.match(billing, /purchases\.logIn\(userId, new LogInCallback\(\)/);
    assert.match(billing, /billing_account_mismatch/);
    assert.match(billing, /billing_account_busy/);

    assert.equal((main.match(/public void getOfferingsForUser\(/g) || []).length, target.bridgeCount);
    assert.equal((main.match(/public void purchaseForUser\(/g) || []).length, target.bridgeCount);
    assert.equal((main.match(/public void restoreForUser\(/g) || []).length, target.bridgeCount);
    assert.doesNotMatch(main, /public void getOfferings\(final String requestId\)/);
    assert.doesNotMatch(main, /public void purchase\(final String packageId/);
    assert.doesNotMatch(main, /public void billingLogin\(/);
    assert.match(main, /WebViewCompat\.addWebMessageListener/);
    assert.match(main, /Collections\.singleton\("https:\/\/norva\.tv"\)/);
    assert.match(main, /!isMainFrame/);
    assert.match(main, /args\.length\(\) == 6/);
    assert.match(main, /final String placement = args\.optString\(5, ""\)/);
    assert.match(billing, /NativeBillingTelemetry\.recordCheckoutStarted/);
    assert.match(billing, /"locked_profile"\.equals\(placement\).*"subscribe_plans"\.equals\(placement\)/s);
  });

  test(`${target.name}: only the exact current offering can be purchased`, () => {
    const source = read(target.billing);
    const catalogStart = source.indexOf('static void getOfferingsForUser');
    const purchaseStart = source.indexOf('static void purchaseForUser');
    const catalog = source.slice(catalogStart, purchaseStart);

    assert.match(catalog, /offerings\.getCurrent\(\)/);
    assert.doesNotMatch(catalog, /offerings\.getAll\(\)/);
    assert.match(source, /!offeringId\.equals\(current\.getIdentifier\(\)\)/);
    assert.match(source, /findExactPackage\(current, packageId, productId\)/);
    assert.match(source, /return matches == 1 \? match : null/);
    assert.match(source, /plan_product_mismatch/);
    assert.match(source, /"P1M"\.equals\(periodIso\) \|\| "P1Y"\.equals\(periodIso\)/);
  });

  test(`${target.name}: serializes store truth and fails closed on paid intro phases`, () => {
    const source = read(target.billing);
    for (const field of [
      'nativeBillingContract', 'appUserId', 'currentOfferingId', 'offeringId',
      'packageId', 'packageType', 'productId', 'priceString', 'priceMicros',
      'currencyCode', 'supported', 'unsupportedReason',
      'trialEligibility', 'trialBillingCycles', 'selectedOfferTrialEligible',
      'transactionMatchesProduct', 'entitlementActive', 'trialActive',
    ]) assert.match(source, new RegExp(`"${field}"`), `missing ${field}`);
    assert.match(source, /appendPeriod\(out, "period", period\)/);
    assert.match(source, /appendPeriod\(out, "trialPeriod", free\.getBillingPeriod\(\)\)/);
    assert.match(source, /prefix \+ "Iso8601"/);

    assert.match(source, /PricingPhase paidIntro = option\.getIntroPhase\(\)/);
    assert.match(source, /paidIntro != null\) return PackageSupport\.no\("paid_introductory_phase"\)/);
    assert.match(source, /freePrice\.getAmountMicros\(\) != 0/);
    assert.match(source, /PeriodType\.TRIAL/);
    assert.doesNotMatch(source, /\$4\.99|\$8\.99|\$41\.99|\$74\.99|\$75\.99/);
  });

  test(`${target.name}: MainActivity uses singleTop for safe WebView callbacks`, () => {
    const manifest = read(target.manifest);
    assert.match(manifest, /android:name="\.MainActivity"[\s\S]{0,260}android:launchMode="singleTop"/);
    assert.doesNotMatch(manifest, /android:name="\.MainActivity"[\s\S]{0,260}android:launchMode="singleTask"/);
  });

  test(`${target.name}: release version is bumped for the hardened native contract`, () => {
    const gradle = read(target.gradle);
    assert.match(gradle, new RegExp(`versionCode\\s+${target.versionCode}\\b`));
    assert.match(gradle, new RegExp(`versionName\\s+"${target.versionName.replace('.', '\\.')}"`));
  });
}

test('Android TV delegates purchases to the web and ships no native billing surface', () => {
  const main = read('clients/android-tv/app/src/main/java/tv/norva/tv/MainActivity.java');
  const gradle = read('clients/android-tv/app/build.gradle');
  const manifest = read('clients/android-tv/app/src/main/AndroidManifest.xml');
  const subscribe = read('public/subscribe.html');

  assert.equal(fs.existsSync(path.join(root,
    'clients/android-tv/app/src/main/java/tv/norva/tv/NorvaBilling.java')), false);
  assert.equal(fs.existsSync(path.join(root,
    'clients/android-tv/app/src/main/java/tv/norva/tv/NorvaApplication.java')), false);
  assert.doesNotMatch(main, /getOfferingsForUser|purchaseForUser|restoreForUser/);
  assert.doesNotMatch(gradle, /com\.revenuecat\.purchases|REVENUECAT_API_KEY/);
  assert.doesNotMatch(manifest, /NorvaApplication/);
  assert.match(subscribe, /id="tv-purchase-path"/);
  assert.match(subscribe, /Open norva\.tv, sign in with this same Norva account/i);
});

test('RevenueCat 9 maps all four paywall packages to bare and store product ids', () => {
  const gradle = read('clients/android-phone/app/build.gradle');
  const billing = read('clients/android-phone/app/src/main/java/tv/norva/phone/NorvaBilling.java');
  const subscribe = read('public/subscribe.html');

  assert.match(gradle, /com\.revenuecat\.purchases:purchases:9\.23\.1/);
  for (const [packageId, productId] of [
    ['$rc_monthly', 'norva_plus'],
    ['$rc_annual', 'norva_plus'],
    ['family_monthly', 'norva_family'],
    ['family_annual', 'norva_family'],
  ]) {
    assert.match(subscribe, new RegExp(packageId.replace('$', '\\$')),
      `missing ${packageId}`);
    assert.match(subscribe, new RegExp(productId), `missing ${productId}`);
  }
  assert.match(billing, /out\.put\("productId", baseProductId\(product\.getId\(\)\)\)/);
  assert.match(billing, /out\.put\("storeProductId", product\.getId\(\)\)/);
  assert.match(billing, /exactStoreProductRequested/);
  assert.match(billing, /baseProductId\(productId\)\.equals\(baseProductId\(storeProductId\)\)/);
});

test('native billing globally serializes operations with a tokenized watchdog', () => {
  const billing = read('clients/android-phone/app/src/main/java/tv/norva/phone/NorvaBilling.java');
  assert.match(billing, /activeOperationToken/);
  assert.match(billing, /OPERATION_TIMEOUT_MS/);
  assert.match(billing, /if \(activeOperationToken != 0L\) return 0L/);
  assert.match(billing, /completeOperation\(token\)/);
  assert.match(billing, /activeOperationToken != token/);
  assert.match(billing, /billing_timeout/);
  assert.doesNotMatch(billing, /operationCount/);
});

test('native cloud bridges fail closed and authenticate billing and first-frame truth', () => {
  const phone = read('clients/android-phone/app/src/main/java/tv/norva/phone/MainActivity.java');
  const tv = read('clients/android-tv/app/src/main/java/tv/norva/tv/MainActivity.java');
  const phoneTelemetry = read('clients/android-phone/app/src/main/java/tv/norva/phone/NativePlaybackTelemetry.java');
  const tvTelemetry = read('clients/android-tv/app/src/main/java/tv/norva/tv/NativePlaybackTelemetry.java');
  const phonePlayer = read('clients/android-phone/app/src/main/java/tv/norva/phone/PlayerActivity.java');
  const tvPlayer = read('clients/android-tv/app/src/main/java/tv/norva/tv/PlayerActivity.java');

  for (const source of [phone, tv]) {
    assert.match(source, /MIXED_CONTENT_NEVER_ALLOW/);
    assert.match(source, /handler\.cancel\(\)/);
    assert.match(source, /shouldOverrideUrlLoading/);
    assert.match(source, /removeJavascriptInterface/);
    assert.match(source, /norva-cloud-device-token/);
    assert.match(source, /EXTRA_PLAYBACK_AUTH_TOKEN/);
  }
  assert.match(phone, /SUPABASE_USER_URL/);
  assert.match(phone, /Authorization", "Bearer " \+ accessToken/);
  assert.match(phone, /isTrustedBillingPage\(webView\.getUrl\(\)\)/);
  assert.match(phone, /WebMessageListener/);
  assert.doesNotMatch(phone, /@android\.webkit\.JavascriptInterface[\s\S]{0,120}purchaseForUser/);
  for (const telemetry of [phoneTelemetry, tvTelemetry]) {
    assert.match(telemetry, /norva-playback\/playback\/events/);
    assert.match(telemetry, /body\.put\("eventType", "first_frame"\)/);
    assert.match(telemetry, /Authorization", "Bearer " \+ authToken/);
    assert.match(telemetry, /setInstanceFollowRedirects\(false\)/);
    assert.doesNotMatch(telemetry, /Log\.|System\.out|printStackTrace/);
  }
  for (const player of [phonePlayer, tvPlayer]) {
    assert.match(player, /if \(!firstFrameRendered\)/);
    assert.match(player, /removeExtra\(EXTRA_PLAYBACK_AUTH_TOKEN\)/);
    assert.match(player, /NativePlaybackTelemetry\.recordFirstFrame/);
  }
});

test('Android TV release version remains explicit after billing removal', () => {
  const gradle = read('clients/android-tv/app/build.gradle');
  assert.match(gradle, /versionCode\s+21\b/);
  assert.match(gradle, /versionName\s+"3\.8\.8-hybrid"/);
});
