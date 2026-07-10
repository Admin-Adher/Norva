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

  // Web payment via Stancer (French gateway, hosted payment page). Enabled per config.
  function isStancerEnabled() {
    return Boolean(CONFIG.stancer && CONFIG.stancer.enabled);
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

  // Open a Stancer checkout. The web flow now stays on norva.tv: we navigate to the
  // branded checkout page (checkout.html), which embeds the Stancer card form in an
  // iframe. Plan/period are derived from the same opts subscribe.html already sends.
  async function stancerCheckout(opts) {
    const token = await sessionToken();
    if (!token) throw err('Please sign in first', 'not_signed_in');
    const plan = opts.planCode === 'family' ? 'family' : 'plus';
    const period = /annual/i.test(String(opts.packageId || '')) ? 'annual' : 'monthly';
    // Existing subscriber with a card on file → change the plan in ONE CLICK,
    // no card re-entry. Server decides; anything else falls through to checkout.
    try {
      const change = await stancerChangePlan(plan, period);
      if (change && change.ok && change.status) {
        return { status: change.status, plan: plan, period: period };
      }
    } catch (_) { /* fall through to the checkout flow */ }
    const qs = new URLSearchParams({ plan: plan, period: period });
    if (opts.returnTo) qs.set('returnTo', String(opts.returnTo));
    window.location.assign('/checkout.html?' + qs.toString());
    return { status: 'redirect' };
  }

  // Used by checkout.html: create the payment intent and return the hosted-page URL
  // WITHOUT redirecting (embed:true → the return leg goes through checkout-done.html).
  async function stancerCheckoutUrl(opts) {
    const cfg = CONFIG.stancer || {};
    const base = ((window.NorvaAuth && NorvaAuth.supabaseUrl) || 'https://api.norva.tv').replace(/\/+$/, '');
    const apikey = (window.NorvaAuth && NorvaAuth.publishableKey) || '';
    const token = await sessionToken();
    if (!token) throw err('Please sign in first', 'not_signed_in');
    const res = await fetch(base + (cfg.checkoutUrl || '/functions/v1/norva-stancer/checkout'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': apikey, 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({
        plan: opts.plan === 'family' ? 'family' : 'plus',
        period: opts.period === 'annual' ? 'annual' : 'monthly',
        returnTo: opts.returnTo || '',
        embed: true,
        intent: opts.intent || undefined, // 'update_card' → token swap flow
      }),
    });
    const data = await res.json().catch(function () { return {}; });
    if (!res.ok || !data.url) throw err(data.error || 'Could not start checkout', 'stancer_error', data);
    return data; // { url, pi_id, kind }
  }

  // POST an account-scoped Stancer action (cancel / resume / save-offer) and return the response.
  async function stancerAction(action, body) {
    const base = ((window.NorvaAuth && NorvaAuth.supabaseUrl) || 'https://api.norva.tv').replace(/\/+$/, '');
    const apikey = (window.NorvaAuth && NorvaAuth.publishableKey) || '';
    const token = await sessionToken();
    if (!token) throw err('Please sign in first', 'not_signed_in');
    const res = await fetch(base + '/functions/v1/norva-stancer/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': apikey, 'Authorization': 'Bearer ' + token },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw err(data.error || 'Request failed', 'stancer_error', data);
    return data;
  }
  // Cancel at period end (access continues until then, nothing further is charged).
  // The optional reason comes from the cancel flow — analytics only, never a condition.
  function stancerCancel(reason) { return stancerAction('cancel', reason ? { reason: reason } : null); }
  // Undo a pending cancellation before the period ends.
  function stancerResume() { return stancerAction('resume'); }
  // Accept the cancel-flow counter-offer (50% off the next payment, one-shot).
  // Returns {ok:true, discount_pct} or {ok:false, reason:'already_used'|'not_eligible'}.
  async function stancerSaveOffer(reason) {
    try { return await stancerAction('save-offer', reason ? { reason: reason } : null); }
    catch (e) { return { ok: false, reason: (e && e.code) || 'error' }; }
  }

  // ONE-CLICK plan change for existing subscribers — the card token is already on
  // file, so no card re-entry (upsell without friction). Returns {ok:true, status:
  // 'plan_changed'|'plan_scheduled'|'unchanged'} or {ok:false, reason:'no_live_sub'
  // |'requires_card'} → caller falls back to the checkout flow.
  async function stancerChangePlan(plan, period) {
    const base = ((window.NorvaAuth && NorvaAuth.supabaseUrl) || 'https://api.norva.tv').replace(/\/+$/, '');
    const apikey = (window.NorvaAuth && NorvaAuth.publishableKey) || '';
    const token = await sessionToken();
    if (!token) throw err('Please sign in first', 'not_signed_in');
    const res = await fetch(base + '/functions/v1/norva-stancer/change-plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': apikey, 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ plan: plan, period: period }),
    });
    return await res.json().catch(function () { return { ok: false, reason: 'error' }; });
  }

  // Finalize a Stancer checkout on the return page (no webhook needed): the edge function re-fetches
  // the payment, captures the tokenized card and starts the trial. Returns {status:'trialing'|'pending'|…}.
  async function confirmStancer() {
    if (!isStancerEnabled()) return { skipped: true };
    const cfg = CONFIG.stancer || {};
    const base = ((window.NorvaAuth && NorvaAuth.supabaseUrl) || 'https://api.norva.tv').replace(/\/+$/, '');
    const apikey = (window.NorvaAuth && NorvaAuth.publishableKey) || '';
    const token = await sessionToken();
    if (!token) return { skipped: true };
    try {
      const res = await fetch(base + (cfg.confirmUrl || '/functions/v1/norva-stancer/confirm'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': apikey, 'Authorization': 'Bearer ' + token },
        body: '{}',
      });
      return await res.json().catch(function () { return {}; });
    } catch (_) { return {}; }
  }

  // Read-only billing profile for display (plan/period/amount + card last4/exp).
  // Returns null when not signed in, not enabled, or nothing on file.
  async function stancerProfile() {
    if (!isStancerEnabled()) return null;
    const cfg = CONFIG.stancer || {};
    const base = ((window.NorvaAuth && NorvaAuth.supabaseUrl) || 'https://api.norva.tv').replace(/\/+$/, '');
    const apikey = (window.NorvaAuth && NorvaAuth.publishableKey) || '';
    const token = await sessionToken();
    if (!token) return null;
    try {
      const res = await fetch(base + (cfg.profileUrl || '/functions/v1/norva-stancer/profile'), {
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
    if (isStancerEnabled()) {
      return stancerCheckout(opts); // web → Stancer hosted page (redirects away)
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
    isStancerEnabled: isStancerEnabled,
    confirmStancer: confirmStancer,
    stancerProfile: stancerProfile,
    stancerCheckoutUrl: stancerCheckoutUrl,
    stancerCancel: stancerCancel,
    stancerResume: stancerResume,
    stancerSaveOffer: stancerSaveOffer,
    stancerChangePlan: stancerChangePlan,
    purchase: purchase,
    restore: restore,
    login: login,
    manageUrl: manageUrl,
    config: CONFIG,
  };
})();
