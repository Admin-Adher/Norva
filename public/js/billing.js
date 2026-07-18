/**
 * Norva billing client — one abstraction over both rails:
 *   - Native (Android phone / tablet / TV APK): Google Play Billing, driven by
 *     the RevenueCat SDK on the native side and reached through the WebView
 *     bridge (window.NorvaTVCloud / window.NodeCastNative).
 *   - Web (browser): Revolut Merchant (embedded card checkout) is the live rail,
 *     configured via window.NORVA_BILLING_CONFIG; a RevenueCat Web Billing path
 *     remains as an inert fallback (only if webBillingEnabled is turned on).
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

  // TRUE only inside the Android TV APK. A device-paired TV inherits the account's
  // subscription (bought on web/phone) — it never purchases on its own, and Play
  // Billing crashes on some TV boxes that lack proper Play Services, so we keep
  // native billing OFF on TV entirely.
  function isTvShell() {
    return /NorvaTV-AndroidTV/i.test(navigator.userAgent || '');
  }

  function hasNativeBilling() {
    if (isTvShell()) return false;
    const bridge = nativeBridge();
    return !!(bridge && typeof bridge.purchase === 'function');
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
    const res = await fetch(base + (cfg.checkoutUrl || '/functions/v1/norva-revolut/checkout'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': apikey, 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({
        plan: opts.plan === 'family' ? 'family' : 'plus',
        period: opts.period === 'annual' ? 'annual' : 'monthly',
        returnTo: opts.returnTo || '',
        intent: opts.intent || undefined, // 'update_card' → token swap flow
      }),
    });
    const data = await res.json().catch(function () { return {}; });
    if (!res.ok || !data.public_id) throw err(data.error || 'Could not start checkout', 'revolut_error', data);
    return data; // { order_id, public_id, kind, checkout_url, sandbox }
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
  // norva-revolut GET /prices — public, no auth). Resolves { prices, promos }:
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
        return { prices: d.prices, promos: d.promos || {}, campaign: bgUrl ? { bg_url: bgUrl } : null };
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
    isTvShell: isTvShell,
    hasNativeBilling: hasNativeBilling,
    isWebBillingConfigured: isWebBillingConfigured,
    isRevolutEnabled: isRevolutEnabled,
    revolutCreateOrder: revolutCreateOrder,
    confirmRevolut: confirmRevolut,
    revolutProfile: revolutProfile,
    revolutPrices: revolutPrices,
    revolutCancel: revolutCancel,
    revolutResume: revolutResume,
    purchase: purchase,
    restore: restore,
    login: login,
    manageUrl: manageUrl,
    config: CONFIG,
  };
})();
