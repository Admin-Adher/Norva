(function () {
  'use strict';

  var VERSION = 2;
  var SCREENS = new Set([
    'home', 'live', 'guide', 'movies', 'series', 'settings',
    'settings_account', 'settings_sources', 'settings_profile',
    'settings_notifications', 'partners', 'search', 'pairing', 'account',
    'pricing', 'checkout', 'subscription', 'error'
  ]);
  var EVENTS = new Set([
    'app_open', 'landing_view', 'primary_cta_clicked', 'store_cta_clicked',
    'signup_started', 'signup_completed', 'login_started', 'login_completed',
    'pricing_viewed', 'plan_selected', 'checkout_started', 'checkout_completed',
    'provider_connect_started', 'provider_connected', 'provider_access_opened',
    'provider_access_saved', 'provider_action_required', 'provider_repair_started',
    'provider_repair_succeeded', 'catalog_sync_started', 'catalog_ready',
    'content_opened', 'playback_started', 'playback_first_frame',
    'journey_retry', 'journey_error', 'billing_period_changed',
    'faq_opened', 'demo_interaction', 'context_widget_action',
    'context_widget_impression'
  ]);
  var CONTEXT = {
    authenticated: ['visitor_state', ['signed_in', 'anonymous']],
    period: ['billing_period', ['monthly', 'annual']],
    plan: ['selected_plan', ['plus', 'family', 'unknown']],
    source: ['event_source', ['landing', 'hero', 'nav', 'pricing', 'context_widget', 'manual', 'automatic', 'settings', 'onboarding', 'player', 'unknown']],
    target: ['event_target', ['signup', 'login', 'pricing', 'android_mobile', 'android_tv', 'app', 'checkout', 'unknown']],
    state: ['event_state', ['started', 'completed', 'ready', 'action_required', 'error', 'cancelled', 'unknown']],
    method: ['auth_method', ['email_password', 'email_magic_link', 'google', 'unknown']],
    placement: ['journey_entrypoint', ['landing', 'account', 'subscribe_plans', 'paywall', 'locked_profile', 'settings', 'onboarding', 'player', 'unknown']],
    journey: ['journey_name', ['acquisition', 'subscription', 'provider_onboarding', 'provider_recovery', 'catalog', 'time_to_value', 'authentication', 'unknown']],
    step: ['journey_step', ['landing', 'signup', 'login', 'pricing', 'checkout', 'provider_connect', 'provider_access', 'provider_repair', 'catalog_sync', 'content', 'playback', 'unknown']],
    outcome: ['journey_outcome', ['success', 'error', 'cancelled', 'pending', 'retry', 'unknown']],
    failureFamily: ['failure_family', ['credentials', 'provider_busy', 'provider_blocked', 'provider_unreachable', 'network', 'timeout', 'format', 'superseded', 'revision_conflict', 'invalid_state', 'billing_unavailable', 'payment_declined', 'entitlement_pending', 'cancelled', 'unknown']],
    catalogState: ['catalog_state', ['none', 'syncing', 'ready', 'error', 'unknown']],
    providerAccessState: ['provider_access_state', ['active', 'expiring', 'expected_expired', 'expired_confirmed', 'access_unavailable_confirmed', 'check_failed_temporary', 'restoring', 'unknown']],
    subscriptionState: ['subscription_state', ['none', 'trialing', 'active', 'past_due', 'cancelled', 'unknown']]
  };

  function bridge() {
    var value = window.NorvaAnalyticsNative;
    return value && typeof value.postMessage === 'function' ? value : null;
  }

  function maskNativeWebViewContent() {
    if (!bridge() || !document.documentElement || typeof document.documentElement.setAttribute !== 'function') return;
    // Keep DOM geometry and interactions available for friction analysis while
    // preventing catalogue titles, artwork, account data and provider details
    // from being uploaded by native WebView capture.
    document.documentElement.setAttribute('data-clarity-mask', 'true');
  }

  function send(payload) {
    var target = bridge();
    if (!target) return false;
    try {
      target.postMessage(JSON.stringify(payload));
      return true;
    } catch (_) {
      return false;
    }
  }

  function normalize(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').slice(0, 48);
  }

  function currentScreen() {
    var pathname = String(location.pathname || '').toLowerCase();
    if (/(?:^|\/)account(?:\.html)?\/?$/.test(pathname)) return 'account';
    if (/(?:^|\/)(?:subscribe|paywall)(?:\.html)?\/?$/.test(pathname)) return 'pricing';
    if (/(?:^|\/)checkout-revolut(?:\.html)?\/?$/.test(pathname)) return 'checkout';
    if (/(?:^|\/)subscription(?:\.html)?\/?$/.test(pathname)) return 'subscription';
    var raw = String(location.hash || '#home').replace(/^#/, '').split(/[?&]/, 1)[0];
    var parts = raw.split('/').filter(Boolean);
    var page = normalize(parts[0] || 'home');
    if (page === 'tv') page = 'live';
    if (page === 'settings' && parts[1]) page = 'settings_' + normalize(parts[1]);
    return SCREENS.has(page) ? page : 'home';
  }

  function setConsent(status) {
    var value = status === 'granted' ? 'granted' : 'denied';
    var delivered = send({ v: VERSION, type: 'consent', status: value });
    // Consent is delivered first; the native adapter can then buffer this exact
    // screen until Clarity's asynchronous session-start callback is ready.
    if (delivered && value === 'granted') setScreen(currentScreen());
    return delivered;
  }

  function setScreen(name) {
    var value = normalize(name || currentScreen());
    if (!SCREENS.has(value)) return false;
    return send({ v: VERSION, type: 'screen', name: value });
  }

  function context(params) {
    var tags = {};
    Object.keys(CONTEXT).forEach(function (inputKey) {
      if (!params || params[inputKey] === undefined) return;
      var rule = CONTEXT[inputKey];
      var raw = typeof params[inputKey] === 'boolean'
        ? (params[inputKey] ? 'signed_in' : 'anonymous')
        : normalize(params[inputKey]);
      if (rule[1].indexOf(raw) !== -1) tags[rule[0]] = raw;
    });
    var delivered = false;
    // One bounded tag per bridge message guarantees that the native parser's
    // hard payload limit cannot be crossed by a multi-dimensional event.
    Object.keys(tags).forEach(function (key) {
      var item = {};
      item[key] = tags[key];
      if (send({ v: VERSION, type: 'context', tags: item })) delivered = true;
    });
    return delivered;
  }

  function track(name, params) {
    var value = normalize(name);
    if (!EVENTS.has(value)) return false;
    context(params || {});
    return send({ v: VERSION, type: 'event', name: value });
  }

  function publishScreen() {
    setScreen(currentScreen());
  }

  window.NorvaNativeAnalytics = {
    setConsent: setConsent,
    setScreen: setScreen,
    track: track,
    context: context,
    currentScreen: currentScreen,
    available: function () { return Boolean(bridge()); }
  };

  maskNativeWebViewContent();
  window.addEventListener('hashchange', publishScreen);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', publishScreen, { once: true });
  } else {
    publishScreen();
  }
}());
