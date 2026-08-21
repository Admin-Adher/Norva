'use strict';

// The paywall showed "Google Play price unavailable … (timeout)": the APK had
// received the catalog request and answered nothing at all, and the page had no
// way back. These tests pin the two properties that make that state impossible —
// the bridge always answers, on the channel the caller listens to, and the page
// can always ask again.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const root = path.join(__dirname, '..');
const read = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/\r\n/g, '\n');

const MAIN = 'clients/android-phone/app/src/main/java/tv/norva/phone/MainActivity.java';
const BILLING = 'clients/android-phone/app/src/main/java/tv/norva/phone/NorvaBilling.java';

function block(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `missing marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test('the billing channel never drops a request from our own top-level page', () => {
  const main = read(MAIN);
  const listener = block(main, 'public void onPostMessage(WebView view', 'private void dispatchBillingMessage');

  // A hostile or nested frame is still refused without a word.
  assert.match(listener, /!isMainFrame/);
  assert.match(listener, /!isTrustedCloudUrl\(sourceOrigin\.toString\(\)\)/);
  // The page-level check must NOT silence the request here: a wrong page has to
  // be answered (untrusted_billing_context), never met with silence.
  assert.doesNotMatch(listener, /isTrustedBillingPage/);
  assert.match(main, /!isTrustedBillingPage\(webView\.getUrl\(\)\)/);
  assert.match(main, /callback\.onError\("untrusted_billing_context"\)/);
});

test('an exception on the session path answers instead of escaping', () => {
  const main = read(MAIN);
  const verified = block(main, 'private void withVerifiedBillingUser', 'private void verifyBillingSessionValue');
  const verify = block(main, 'private void verifyBillingSessionValue', 'private static boolean validBillingUserId');

  // The WebView can be gone, and ioPool is shut down with the Activity. Both
  // used to throw straight out of the bridge with no answer posted at all.
  assert.match(verified, /webView\.evaluateJavascript\(/);
  assert.match(verified, /\} catch \(Throwable ignored\) \{\s*\n\s*callback\.onError\("billing_session_missing"\);/);
  assert.match(verify, /try \{\s*\n\s*ioPool\.execute\(verify\);\s*\n\s*\} catch \(Throwable ignored\) \{\s*\n\s*callback\.onError\("billing_session_verification_failed"\);/);
});

test('every billing request is answered exactly once, on its own channel', () => {
  const main = read(MAIN);
  const dispatch = block(main, 'private void dispatchBillingMessage', 'private void finishBillingRequest');

  // One latch guards all four outcomes: catalog, purchase, restore, watchdog.
  assert.equal((dispatch.match(/answered\.compareAndSet\(false, true\)/g) || []).length, 4);
  assert.equal((dispatch.match(/billingHandler\.removeCallbacks\(expire\)/g) || []).length, 3);
  assert.match(dispatch, /"native_timeout_" \+ stage\[0\]/);
  for (const stage of ['session', 'offerings', 'purchase', 'restore']) {
    assert.match(dispatch, new RegExp(`"${stage}"`), `unnamed stage: ${stage}`);
  }

  // A catalog request waits on onOfferings, a purchase or restore on onResult;
  // answering an error on the wrong channel reads to the page as no answer.
  const failure = block(main, 'private void sendBillingFailure', '// ---- Offline downloads');
  assert.match(failure, /if \("getOfferingsForUser"\.equals\(method\)\) \{\s*\n\s*sendBillingOfferingsError\(/);
  assert.match(failure, /\} else \{\s*\n\s*sendBillingResult\(requestId, "error", null, error, null\);/);
});

test('the bridge watchdog covers the catalog and restore, and leaves the Play sheet alone', () => {
  const main = read(MAIN);
  const dispatch = block(main, 'private void dispatchBillingMessage', 'private void finishBillingRequest');

  assert.match(dispatch, /if \("getOfferingsForUser"\.equals\(method\)\) \{\s*\n\s*billingHandler\.postDelayed\(expire, BILLING_CATALOG_REQUEST_TIMEOUT_MS\);/);
  assert.match(dispatch, /\} else if \("restoreForUser"\.equals\(method\)\) \{\s*\n\s*billingHandler\.postDelayed\(expire, BILLING_RESTORE_REQUEST_TIMEOUT_MS\);/);
  // A purchase is paced by the Google Play sheet: arming a deadline on it would
  // report a failure over a checkout that is still open.
  assert.doesNotMatch(dispatch, /purchaseForUser"\.equals\(method\)\) \{\s*\n\s*billingHandler\.postDelayed/);
});

test('each billing deadline answers before the one above it gives up', () => {
  const main = read(MAIN);
  const billing = read(BILLING);
  const web = read('public/js/billing.js');

  const catalogOperation = Number(billing.match(/CATALOG_TIMEOUT_MS = (\d+)L \* 1000L/)[1]) * 1000;
  const restoreOperation = Number(billing.match(/RESTORE_TIMEOUT_MS = (\d+)L \* 1000L/)[1]) * 1000;
  const catalogBridge = Number(main.match(/BILLING_CATALOG_REQUEST_TIMEOUT_MS = ([\d_]+)L/)[1].replace(/_/g, ''));
  const restoreBridge = Number(main.match(/BILLING_RESTORE_REQUEST_TIMEOUT_MS = ([\d_]+)L/)[1].replace(/_/g, ''));
  const pageDeadline = Number(web.match(/Google Play prices timed out[\s\S]{0,120}?\}, (\d+)\);/)[1]);
  const verify = Number(main.match(/connection\.setConnectTimeout\((\d)_000\);\s*\n\s*connection\.setReadTimeout/)[1]) * 1000;

  assert.ok(verify * 2 < catalogBridge, 'session verification must fit inside the bridge deadline');
  assert.ok(catalogOperation < catalogBridge, 'RevenueCat must answer before the bridge watchdog');
  assert.ok(restoreOperation < restoreBridge, 'restore must answer before the bridge watchdog');
  assert.ok(catalogBridge < pageDeadline, 'the bridge must answer before the page gives up');
  assert.ok(restoreBridge < 5 * 60 * 1000, 'restore stays inside the generic native call deadline');
  // A purchase keeps the long watchdog: it waits on a human in the Play sheet.
  assert.match(billing, /OPERATION_TIMEOUT_MS = 6L \* 60L \* 1000L/);
  assert.match(billing, /beginOperation\(userId, OPERATION_TIMEOUT_MS, new Runnable\(\)/);
});

test('a hung catalog lookup frees the account slot long before the page retries', () => {
  const billing = read(BILLING);
  // The slot is process-global, so a six-minute watchdog on a read-only lookup
  // turned every later request — the retry included — into billing_account_busy.
  assert.match(billing, /beginOperation\(userId, CATALOG_TIMEOUT_MS, new Runnable\(\)/);
  assert.match(billing, /beginOperation\(userId, RESTORE_TIMEOUT_MS, new Runnable\(\)/);
  assert.match(billing, /timeoutMs > 0L \? timeoutMs : OPERATION_TIMEOUT_MS/);
  assert.doesNotMatch(billing, /beginOperation\(userId, new Runnable\(\)/);
});

test('the paywall retries a slow store once and then offers the user a retry', () => {
  const subscribe = read('public/subscribe.html');

  assert.match(subscribe, /RETRYABLE_NATIVE_ERRORS = \/\^\(timeout\|billing_timeout\|billing_account_busy\|native_timeout_\)\//);
  assert.match(subscribe, /if \(!opts\.isRetry && RETRYABLE_NATIVE_ERRORS\.test\(nativeOffersError\)\) \{\s*\n\s*return loadNativePrices\(\{ refresh: true, isRetry: true \}\);/);
  // A configuration failure is reported at once — retrying it would only stall
  // the buyer in front of a catalog that will never fill.
  assert.doesNotMatch(subscribe, /RETRYABLE_NATIVE_ERRORS[\s\S]{0,200}native_catalog_empty/);

  assert.match(subscribe, /id="retry-prices"[^>]*hidden/);
  assert.match(subscribe, /if \(retryPricesBtn\) retryPricesBtn\.hidden = false;/);
  assert.match(subscribe, /retryPricesBtn\.addEventListener\('click'/);
  assert.match(subscribe, /await loadNativePrices\(\{ refresh: true \}\)/);
  // The retry must re-ask the store, not replay the cached rejection.
  assert.match(subscribe, /opts\.refresh === true \? \{ refresh: true \} : undefined/);
  // Nothing here weakens the rule that no purchase starts without an exact price.
  assert.match(subscribe, /if \(nativeOffersRequired && !nativeOffersReady\)/);
});

test('a refreshed catalog lookup really re-asks Google Play', async () => {
  const billingSource = read('public/js/billing.js');
  const calls = [];
  let failNext = true;

  const window = {
    NORVA_BILLING_CONFIG: {},
    crypto: webcrypto,
    location: { search: '?mobile=1', assign() {} },
    NorvaTVCloud: {},
  };
  window.NorvaBillingNative = {
    postMessage(raw) {
      const message = JSON.parse(raw);
      calls.push(message.method);
      const failed = failNext;
      failNext = false;
      queueMicrotask(() => window.__norvaBilling.onOfferings(JSON.stringify(failed ? {
        nativeBillingContract: 2,
        requestId: message.requestId,
        appUserId: message.args[0],
        status: 'error',
        error: 'native_timeout_offerings',
        packages: [],
      } : {
        nativeBillingContract: 2,
        requestId: message.requestId,
        appUserId: message.args[0],
        status: 'success',
        currentOfferingId: 'default',
        packages: [{
          offeringId: 'default',
          packageId: '$rc_monthly',
          productId: 'norva_plus',
          priceString: '4,99 €',
          priceMicros: 4990000,
          currencyCode: 'EUR',
          periodIso8601: 'P1M',
          supported: true,
        }],
      })));
    },
  };

  const context = vm.createContext({
    window,
    navigator: { userAgent: 'NorvaTV-AndroidPhone' },
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

  const billing = window.NorvaBilling;
  const userId = 'user-account-aaaaaaaa';
  await assert.rejects(billing.nativeOfferings(userId), (error) => error.code === 'native_timeout_offerings');

  const catalog = await billing.nativeOfferings(userId, { refresh: true });
  assert.equal(catalog.currentOfferingId, 'default');
  assert.equal(calls.length, 2, 'the retry must reach the store again');
});
