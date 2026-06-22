/**
 * Norva billing client — one abstraction over both rails:
 *   - Native (Android phone / tablet / TV APK): Google Play Billing, driven by
 *     the RevenueCat SDK on the native side and reached through the WebView
 *     bridge (window.NorvaTVCloud / window.NodeCastNative).
 *   - Web (browser): RevenueCat Web Billing (Stripe under the hood), loaded on
 *     demand from window.NORVA_BILLING_CONFIG.
 *
 * Purchases are correlated to the account because the app logs the RevenueCat
 * App User ID in as the Supabase user id (NorvaBilling.login(userId)).
 *
 * Everything here is guarded: with no native bridge and no web key, the calls
 * reject with a clear code instead of throwing at load time.
 */
(function () {
  'use strict';

  const CONFIG = window.NORVA_BILLING_CONFIG || {};
  const pending = new Map();
  let seq = 0;

  function nativeBridge() {
    return window.NorvaTVCloud || window.NodeCastNative || null;
  }

  function isNative() {
    const ua = navigator.userAgent || '';
    return /NorvaTV-/i.test(ua) || !!window.NorvaTVCloud || !!window.NodeCastNative
      || /[?&]mobile=1\b/.test(window.location.search || '');
  }

  function hasNativeBilling() {
    const bridge = nativeBridge();
    return !!(bridge && typeof bridge.purchase === 'function');
  }

  function isWebBillingConfigured() {
    return Boolean(CONFIG.webBillingEnabled && CONFIG.revenueCatWebPublicKey);
  }

  function err(message, code, data) {
    return Object.assign(new Error(message), { code: code || 'error', data: data });
  }

  // --- native result channel (native calls back into here) ------------------

  window.__norvaBilling = window.__norvaBilling || {};
  window.__norvaBilling.onResult = function (payload) {
    let data;
    try { data = typeof payload === 'string' ? JSON.parse(payload) : payload; }
    catch (_) { data = { status: 'error', error: 'bad_payload' }; }

    const key = data && data.requestId != null ? String(data.requestId) : null;
    const entry = key ? pending.get(key) : null;
    if (!entry) return;
    pending.delete(key);
    clearTimeout(entry.timer);

    if (data.status === 'success' || data.status === 'restored') {
      entry.resolve(data);
    } else if (data.status === 'cancelled') {
      entry.reject(err('Purchase cancelled', 'cancelled', data));
    } else {
      entry.reject(err(data.error || 'Billing error', data.status || 'error', data));
    }
  };

  function callNative(method, args) {
    return new Promise(function (resolve, reject) {
      const bridge = nativeBridge();
      if (!bridge || typeof bridge[method] !== 'function') {
        reject(err('Native billing unavailable', 'unavailable'));
        return;
      }
      const requestId = String(++seq);
      const timer = setTimeout(function () {
        if (pending.has(requestId)) {
          pending.delete(requestId);
          reject(err('Billing timed out', 'timeout'));
        }
      }, 1000 * 60 * 5);
      pending.set(requestId, { resolve: resolve, reject: reject, timer: timer });
      try {
        bridge[method].apply(bridge, args.concat([requestId]));
      } catch (e) {
        pending.delete(requestId);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  // --- web (RevenueCat Web Billing) -----------------------------------------

  let webPurchases = null;
  async function ensureWeb(appUserId) {
    if (!isWebBillingConfigured()) {
      throw err('Web billing is not configured', 'not_configured');
    }
    if (webPurchases) return webPurchases;
    // Loaded on demand so the SDK never costs anything until a purchase begins.
    const mod = await import(CONFIG.purchasesJsUrl || 'https://esm.sh/@revenuecat/purchases-js@1');
    const Purchases = mod.Purchases || mod.default;
    webPurchases = Purchases.configure(CONFIG.revenueCatWebPublicKey, appUserId || undefined);
    return webPurchases;
  }

  async function webPackage(purchases, packageId, productId) {
    const offerings = await purchases.getOfferings();
    const offering = offerings.current || (offerings.all && offerings.all[CONFIG.offeringId])
      || (offerings.all && Object.values(offerings.all)[0]);
    const packages = (offering && offering.availablePackages) || [];
    return packages.find(function (p) {
      return p.identifier === packageId
        || (p.webBillingProduct && p.webBillingProduct.identifier === productId)
        || (p.rcBillingProduct && p.rcBillingProduct.identifier === productId);
    });
  }

  // --- public API -----------------------------------------------------------

  // opts: { packageId, productId, planCode, appUserId }
  async function purchase(opts) {
    opts = opts || {};
    if (hasNativeBilling()) {
      return callNative('purchase', [String(opts.packageId || opts.productId || ''), String(opts.planCode || '')]);
    }
    const purchases = await ensureWeb(opts.appUserId);
    const pkg = await webPackage(purchases, opts.packageId, opts.productId);
    if (!pkg) throw err('Plan not available', 'no_package');
    return purchases.purchase({ rcPackage: pkg });
  }

  async function restore(opts) {
    opts = opts || {};
    if (hasNativeBilling()) {
      return callNative('restore', []);
    }
    const purchases = await ensureWeb(opts.appUserId);
    if (typeof purchases.restorePurchases === 'function') {
      return purchases.restorePurchases();
    }
    return { status: 'noop' };
  }

  // Tell the native billing SDK which account is active (App User ID = Supabase
  // user id). Safe no-op on web or when the bridge isn't present.
  function login(userId) {
    if (!userId) return;
    const bridge = nativeBridge();
    if (bridge && typeof bridge.billingLogin === 'function') {
      try { bridge.billingLogin(String(userId)); } catch (_) { /* noop */ }
    }
  }

  // Where to send the user to manage / cancel / update their payment method.
  // Native → the Google Play subscriptions page (Play policy requires management
  // there); web → the configured billing portal ('' until set). Used by the
  // subscription management screen.
  function manageUrl() {
    if (isNative()) return 'https://play.google.com/store/account/subscriptions';
    return CONFIG.webCustomerPortalUrl || '';
  }

  window.NorvaBilling = {
    isNative: isNative,
    hasNativeBilling: hasNativeBilling,
    isWebBillingConfigured: isWebBillingConfigured,
    purchase: purchase,
    restore: restore,
    login: login,
    manageUrl: manageUrl,
    config: CONFIG,
  };
})();
