/**
 * Norva billing client — one abstraction over both rails:
 *   - Native (Android phone / tablet APK): Google Play Billing, driven by
 *     the RevenueCat SDK on the native side and reached through the WebView
 *     bridge (window.NorvaTVCloud / window.NodeCastNative).
 *   - Web (browser): Revolut Merchant (embedded card checkout) is the live rail,
 *     configured via window.NORVA_BILLING_CONFIG; a RevenueCat Web Billing path
 *     remains as an inert fallback (only if webBillingEnabled is turned on).
 *
 * Every native catalog, purchase and restore operation logs RevenueCat into the
 * exact Supabase user id supplied by that operation and verifies the resulting
 * App User ID before continuing.
 *
 * Android TV deliberately uses the external Web subscription path and exposes
 * no native billing channel. Everything here is guarded: with no native bridge and no web key, the calls
 * reject with a clear code instead of throwing at load time.
 */
(function () {
  'use strict';

  const CONFIG = window.NORVA_BILLING_CONFIG || {};
  const pending = new Map();
  let seq = 0;
  // A callback from an old document must never settle a request created by a
  // newly loaded paywall whose numeric sequence happened to restart at 1.
  const pageNonce = (function () {
    try {
      const bytes = new Uint32Array(2);
      window.crypto.getRandomValues(bytes);
      return bytes[0].toString(36) + bytes[1].toString(36);
    } catch (_) {
      return Date.now().toString(36) + Math.random().toString(36).slice(2);
    }
  })();

  function nextRequestId() {
    seq += 1;
    return pageNonce + ':' + seq;
  }

  function isCurrentPageRequest(requestId) {
    return typeof requestId === 'string' && requestId.indexOf(pageNonce + ':') === 0;
  }

  function nativeBridge() {
    return window.NorvaTVCloud || window.NodeCastNative || null;
  }

  function nativeBillingChannel() {
    return window.NorvaBillingNative || null;
  }

  function isNative() {
    const ua = navigator.userAgent || '';
    return /NorvaTV-/i.test(ua) || !!window.NorvaTVCloud || !!window.NodeCastNative
      || /[?&]mobile=1\b/.test(window.location.search || '');
  }

  // TRUE only inside the Android TV APK. A device-paired TV inherits the account's
  // subscription (bought on web/phone) — it never purchases on its own, and Play
  // Billing crashes on some TV boxes that lack proper Play Services, so we keep
  // native billing OFF on TV entirely.
  function isTvShell() {
    return /NorvaTV-AndroidTV/i.test(navigator.userAgent || '');
  }

  function hasNativeBilling() {
    if (isTvShell()) return false;
    const channel = nativeBillingChannel();
    return !!(channel && typeof channel.postMessage === 'function');
  }

  function postNativeBilling(method, args, requestId) {
    const channel = nativeBillingChannel();
    if (!channel || typeof channel.postMessage !== 'function') {
      throw err('Native billing unavailable', 'unavailable');
    }
    channel.postMessage(JSON.stringify({ method: method, args: args, requestId: requestId }));
  }

  function isWebBillingConfigured() {
    return Boolean(CONFIG.webBillingEnabled && CONFIG.revenueCatWebPublicKey);
  }

  // Web payment via Revolut Merchant (embedded RevolutCheckout card field). Enabled per config.
  function isRevolutEnabled() {
    return Boolean(CONFIG.revolut && CONFIG.revolut.enabled);
  }

  function sessionToken() {
    if (window.NorvaAuth && typeof NorvaAuth.getAccessToken === 'function') {
      return Promise.resolve(NorvaAuth.getAccessToken()).catch(function () { return ''; });
    }
    try {
      const s = JSON.parse(localStorage.getItem('norva-cloud-session') || 'null');
      return Promise.resolve((s && s.access_token) || '');
    } catch (_) { return Promise.resolve(''); }
  }

  // ── Revolut Merchant (embedded RevolutCheckout card field) ─────────────────
  // The web checkout stays on norva.tv: subscribe.html routes here, which navigates
  // to the branded checkout-revolut.html page (the widget mounts a PCI-safe card iframe).
  async function revolutCheckout(opts) {
    const token = await sessionToken();
    if (!token) throw err('Please sign in first', 'not_signed_in');
    const plan = opts.planCode === 'family' ? 'family' : 'plus';
    const period = /annual/i.test(String(opts.packageId || '')) ? 'annual' : 'monthly';
    const qs = new URLSearchParams({ plan: plan, period: period });
    if (opts.returnTo) qs.set('returnTo', String(opts.returnTo));
    if (opts.placement === 'locked_profile') qs.set('placement', 'locked_profile');
    else qs.set('placement', 'subscribe_plans');
    window.location.assign('/checkout-revolut.html?' + qs.toString());
    return { status: 'redirect' };
  }

  // Used by checkout-revolut.html: open the trial-setup order and return the widget
  // token (public_id) WITHOUT charging — the embedded card field authorises + saves it.
  async function revolutCreateOrder(opts) {
    const cfg = CONFIG.revolut || {};
    const base = ((window.NorvaAuth && NorvaAuth.supabaseUrl) || 'https://api.norva.tv').replace(/\/+$/, '');
    const apikey = (window.NorvaAuth && NorvaAuth.publishableKey) || '';
    const token = await sessionToken();
    if (!token) throw err('Please sign in first', 'not_signed_in');
    const body = JSON.stringify({
      plan: opts.plan === 'family' ? 'family' : 'plus',
      period: opts.period === 'annual' ? 'annual' : 'monthly',
      returnTo: opts.returnTo || '',
      intent: opts.intent || undefined, // 'update_card' → token swap flow
      placement: opts.placement === 'locked_profile' ? 'locked_profile' : 'subscribe_plans',
    });
    for (let attempt = 0; attempt < 6; attempt++) {
      const res = await fetch(base + (cfg.checkoutUrl || '/functions/v1/norva-revolut/checkout'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': apikey, 'Authorization': 'Bearer ' + token },
        body: body,
      });
      const data = await res.json().catch(function () { return {}; });
      if (res.ok && data.public_id) return data;
      if (data.retryable && attempt < 5) {
        const delay = Math.max(250, Math.min(2500, Number(data.retry_after_ms) || 1000));
        await new Promise(function (resolve) { setTimeout(resolve, delay); });
        continue;
      }
      throw err(data.error || 'Could not start checkout', 'revolut_error', data);
    }
    throw err('Could not start checkout', 'revolut_error');
  }

  // Finalize a Revolut checkout on return (no webhook needed): the edge function
  // re-fetches the order, saves the card and starts the trial. {status:'trialing'|…}.
  async function confirmRevolut(orderId) {
    if (!isRevolutEnabled()) return { skipped: true };
    const cfg = CONFIG.revolut || {};
    const base = ((window.NorvaAuth && NorvaAuth.supabaseUrl) || 'https://api.norva.tv').replace(/\/+$/, '');
    const apikey = (window.NorvaAuth && NorvaAuth.publishableKey) || '';
    const token = await sessionToken();
    if (!token) return { skipped: true };
    try {
      const res = await fetch(base + (cfg.confirmUrl || '/functions/v1/norva-revolut/confirm'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': apikey, 'Authorization': 'Bearer ' + token },
        body: JSON.stringify(orderId ? { order_id: String(orderId) } : {}),
      });
      return await res.json().catch(function () { return {}; });
    } catch (_) { return {}; }
  }

  // POST an account-scoped Revolut action (cancel / resume) and return the response.
  async function revolutAction(action, body) {
    const base = ((window.NorvaAuth && NorvaAuth.supabaseUrl) || 'https://api.norva.tv').replace(/\/+$/, '');
    const apikey = (window.NorvaAuth && NorvaAuth.publishableKey) || '';
    const token = await sessionToken();
    if (!token) throw err('Please sign in first', 'not_signed_in');
    const res = await fetch(base + '/functions/v1/norva-revolut/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': apikey, 'Authorization': 'Bearer ' + token },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw err(data.error || 'Request failed', 'revolut_error', data);
    return data;
  }
  function revolutCancel(reason) { return revolutAction('cancel', reason ? { reason: reason } : null); }
  function revolutResume() { return revolutAction('resume'); }

  // Current web catalog from the single price source (billing_prices, served by
  // norva-revolut GET /prices — public, no auth). NB: any edit here changes the
  // deployed content hash (?v=<sha256>), which is exactly how a stale immutable
  // cached copy gets evicted on every client. Resolves { prices, promos }:
  // `prices` are EFFECTIVE cents (an active promo already applied), `promos`
  // carries the struck-through base + event badge for display. Cached for the
  // page's lifetime; resolves null on failure so callers keep static fallbacks.
  let pricesPromise = null;
  function revolutPrices() {
    if (!isRevolutEnabled()) return Promise.resolve(null);
    if (pricesPromise) return pricesPromise;
    const base = ((window.NorvaAuth && NorvaAuth.supabaseUrl) || 'https://api.norva.tv').replace(/\/+$/, '');
    const apikey = (window.NorvaAuth && NorvaAuth.publishableKey) || '';
    pricesPromise = fetch(base + '/functions/v1/norva-revolut/prices', { headers: { 'apikey': apikey } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!(d && d.ok && d.prices)) return null;
        // Campaign visual: the server sends a bucket PATH (never a URL — on the
        // self-hosted box its SUPABASE_URL is the internal Docker host, useless
        // to a browser). The public URL is assembled here, from the same base
        // the page already uses for every API call.
        var camp = d.campaign || null;
        var bgUrl = null;
        if (camp && camp.bg_path) {
          bgUrl = base + '/storage/v1/object/public/promo-assets/' + String(camp.bg_path).replace(/^\/+/, '');
        } else if (camp && camp.bg_url && /^https:\/\//.test(camp.bg_url)) {
          bgUrl = camp.bg_url; // older edge build — only if publicly resolvable
        }
        return {
          currency: String(d.currency || 'usd').toUpperCase(),
          prices: d.prices,
          promos: d.promos || {},
          campaign: bgUrl ? { bg_url: bgUrl } : null
        };
      })
      .catch(function () { return null; });
    return pricesPromise;
  }

  // Read-only billing profile for display (plan/period + card last4/brand/exp).
  async function revolutProfile() {
    if (!isRevolutEnabled()) return null;
    const cfg = CONFIG.revolut || {};
    const base = ((window.NorvaAuth && NorvaAuth.supabaseUrl) || 'https://api.norva.tv').replace(/\/+$/, '');
    const apikey = (window.NorvaAuth && NorvaAuth.publishableKey) || '';
    const token = await sessionToken();
    if (!token) return null;
    try {
      const res = await fetch(base + (cfg.profileUrl || '/functions/v1/norva-revolut/profile'), {
        headers: { 'apikey': apikey, 'Authorization': 'Bearer ' + token },
      });
      const data = await res.json().catch(function () { return {}; });
      return (data && data.profile) || null;
    } catch (_) { return null; }
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
    if (!key || !isCurrentPageRequest(key)) return;
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

  const nativeOfferRequests = new Map();
  window.__norvaBilling.onOfferings = function (payload) {
    let data;
    try { data = typeof payload === 'string' ? JSON.parse(payload) : payload; }
    catch (_) { data = { status: 'error', error: 'bad_payload' }; }
    const key = data && data.requestId != null ? String(data.requestId) : null;
    if (!key || !isCurrentPageRequest(key)) return;
    const entry = key ? nativeOfferRequests.get(key) : null;
    if (!entry) return;
    nativeOfferRequests.delete(key);
    clearTimeout(entry.timer);
    if (data.status === 'success') entry.resolve(data);
    else entry.reject(err(data.error || 'Google Play prices unavailable', data.status || 'error', data));
  };

  function callNative(method, args, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (!hasNativeBilling()) {
        reject(err('Native billing unavailable', 'unavailable'));
        return;
      }
      const requestId = nextRequestId();
      const timer = setTimeout(function () {
        if (pending.has(requestId)) {
          pending.delete(requestId);
          reject(err('Billing timed out', 'timeout'));
        }
      }, Number(timeoutMs) > 0 ? Number(timeoutMs) : 1000 * 60 * 5);
      pending.set(requestId, { resolve: resolve, reject: reject, timer: timer });
      try {
        postNativeBilling(method, args, requestId);
      } catch (e) {
        pending.delete(requestId);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  // Catalog promises and resolved catalogs are account-scoped. RevenueCat can
  // target a different current offering (and different trial eligibility) per
  // App User ID, so a page must never reuse user A's result for user B.
  const nativeOfferPromisesByUser = new Map();
  const nativeCatalogsByUser = new Map();

  function normalizedUserId(userId) {
    const value = String(userId || '');
    return value.length >= 8 && value.length <= 128 && value === value.trim() ? value : '';
  }

  function validateNativeCatalog(data, userId) {
    if (!data || Number(data.nativeBillingContract) < 2) {
      throw err('Update Norva to load account-bound Google Play prices', 'native_contract_unavailable', data);
    }
    if (String(data.appUserId || '') !== userId) {
      throw err('Google Play returned prices for a different account', 'native_account_mismatch', data);
    }
    const currentOfferingId = String(data.currentOfferingId || '');
    if (!currentOfferingId) {
      throw err('No current Google Play offering is available', 'native_current_offering_missing', data);
    }
    const packages = Array.isArray(data.packages) ? data.packages.slice() : [];
    if (!packages.length) {
      throw err('No Google Play subscription prices are available', 'native_catalog_empty', data);
    }
    packages.forEach(function (pkg) {
      if (!pkg || String(pkg.offeringId || '') !== currentOfferingId
          || !pkg.packageId || !pkg.productId) {
        throw err('Google Play returned an inconsistent current offering', 'native_catalog_invalid', data);
      }
      if (pkg.supported === true && (!pkg.priceString || Number(pkg.priceMicros) <= 0
          || !pkg.currencyCode || !pkg.periodIso8601)) {
        throw err('Google Play returned an incomplete subscription price', 'native_catalog_invalid', data);
      }
    });
    return {
      nativeBillingContract: Number(data.nativeBillingContract),
      appUserId: userId,
      currentOfferingId: currentOfferingId,
      packages: packages
    };
  }

  function nativeOfferings(userId, options) {
    options = options || {};
    if (isTvShell()) return Promise.resolve(null);
    if (!isNative()) return Promise.resolve(null);
    const uid = normalizedUserId(userId);
    if (!uid) return Promise.reject(err('Please sign in before loading Google Play prices', 'native_user_required'));
    if (!hasNativeBilling()) {
      return Promise.reject(err('Update Norva to load current Google Play prices', 'native_contract_unavailable'));
    }
    if (options.refresh === true) {
      nativeOfferPromisesByUser.delete(uid);
      nativeCatalogsByUser.delete(uid);
    }
    if (!nativeOfferPromisesByUser.has(uid)) {
      const promise = new Promise(function (resolve, reject) {
        const requestId = nextRequestId();
        const timer = setTimeout(function () {
          nativeOfferRequests.delete(requestId);
          reject(err('Google Play prices timed out', 'timeout'));
        }, 20000);
        nativeOfferRequests.set(requestId, {
          resolve: resolve, reject: reject, timer: timer, appUserId: uid
        });
        try { postNativeBilling('getOfferingsForUser', [uid], requestId); }
        catch (error) {
          nativeOfferRequests.delete(requestId);
          clearTimeout(timer);
          reject(error);
        }
      }).then(function (data) {
        const catalog = validateNativeCatalog(data, uid);
        nativeCatalogsByUser.set(uid, catalog);
        return catalog;
      }).catch(function (error) {
        nativeOfferPromisesByUser.delete(uid);
        nativeCatalogsByUser.delete(uid);
        throw error;
      });
      nativeOfferPromisesByUser.set(uid, promise);
    }
    return nativeOfferPromisesByUser.get(uid);
  }

  function exactNativeOffer(catalog, opts) {
    if (!catalog || catalog.appUserId !== opts.appUserId
        || catalog.currentOfferingId !== opts.offeringId) return null;
    const matches = catalog.packages.filter(function (pkg) {
      return pkg && pkg.offeringId === opts.offeringId
        && pkg.packageId === opts.packageId
        && pkg.productId === opts.productId;
    });
    return matches.length === 1 && matches[0].supported === true ? matches[0] : null;
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

  // opts: { offeringId, packageId, productId, planCode, appUserId, placement }
  async function purchase(opts) {
    opts = opts || {};
    if (hasNativeBilling()) {
      const uid = normalizedUserId(opts.appUserId);
      const bound = {
        appUserId: uid,
        offeringId: String(opts.offeringId || ''),
        packageId: String(opts.packageId || ''),
        productId: String(opts.productId || ''),
        planCode: String(opts.planCode || ''),
        placement: opts.placement === 'locked_profile' ? 'locked_profile' : 'subscribe_plans'
      };
      const selected = exactNativeOffer(nativeCatalogsByUser.get(uid), bound);
      if (!uid || !selected) {
        throw err('Reload current Google Play prices before purchasing', 'native_offer_not_bound');
      }
      const data = await callNative('purchaseForUser', [
        uid, bound.offeringId, bound.packageId, bound.productId, bound.planCode, bound.placement
      ]);
      // The purchase has already completed at this point. Never turn a missing
      // verification field into a retryable error (which could cause a second
      // charge); instead return a neutral, explicitly unverified result so the UI
      // can say that access is syncing without promising a trial.
      data.purchaseVerified = Boolean(
        Number(data.nativeBillingContract) >= 2
        && data.appUserId === uid
        && data.offeringId === bound.offeringId
        && data.packageId === bound.packageId
        && data.productId === bound.productId
        && data.planCode === bound.planCode
        && data.transactionMatchesProduct === true
      );
      data.displayedOfferTrialEligible = String(selected.trialEligibility || '').toLowerCase() === 'eligible';
      return data;
    }
    if (isNative()) {
      throw err('Update Norva before purchasing with Google Play', 'native_contract_unavailable');
    }
    if (isRevolutEnabled()) {
      return revolutCheckout(opts); // web → Revolut embedded checkout (norva.tv)
    }
    const purchases = await ensureWeb(opts.appUserId);
    const pkg = await webPackage(purchases, opts.packageId, opts.productId);
    if (!pkg) throw err('Plan not available', 'no_package');
    return purchases.purchase({ rcPackage: pkg });
  }

  async function restore(opts) {
    opts = opts || {};
    if (hasNativeBilling()) {
      const uid = normalizedUserId(opts.appUserId);
      if (!uid) throw err('Please sign in before restoring purchases', 'native_user_required');
      return callNative('restoreForUser', [uid]);
    }
    if (isNative()) throw err('Update Norva before restoring Google Play purchases', 'native_contract_unavailable');
    const purchases = await ensureWeb(opts.appUserId);
    if (typeof purchases.restorePurchases === 'function') {
      return purchases.restorePurchases();
    }
    return { status: 'noop' };
  }

  // Kept as a compatibility no-op for callers outside the paywall. Native
  // account selection is intentionally performed only inside each atomic
  // getOfferingsForUser / purchaseForUser / restoreForUser operation.
  function login(userId) {
    return Boolean(normalizedUserId(userId));
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
    isTvShell: isTvShell,
    hasNativeBilling: hasNativeBilling,
    isWebBillingConfigured: isWebBillingConfigured,
    isRevolutEnabled: isRevolutEnabled,
    revolutCreateOrder: revolutCreateOrder,
    confirmRevolut: confirmRevolut,
    revolutProfile: revolutProfile,
    revolutPrices: revolutPrices,
    nativeOfferings: nativeOfferings,
    loadNativeOffers: nativeOfferings,
    revolutCancel: revolutCancel,
    revolutResume: revolutResume,
    purchase: purchase,
    restore: restore,
    login: login,
    manageUrl: manageUrl,
    config: CONFIG,
  };
})();
