(function () {
  'use strict';

  var cfg = window.NORVA_MARKETING_CONFIG || {};
  var analyticsCfg = cfg.productAnalytics || {};
  var clarityCfg = analyticsCfg.clarity || {};
  var CONSENT_KEY = 'norva_consent';
  var consent = readStoredConsent();
  var clarityLoaded = false;
  var clarityScript = null;
  var sentPageEvents = new Set();

  // The raw API vocabulary is intentionally broader than the 20 Smart Events
  // configured in Clarity. The reusable 20-event funnel spine is exported
  // below; supporting events stay available for diagnostics without consuming
  // another Smart Event slot.
  var CLARITY_EVENTS = new Set([
    'app_open', 'landing_view', 'primary_cta_clicked', 'store_cta_clicked',
    'signup_started', 'signup_completed', 'login_started', 'login_completed',
    'pricing_viewed', 'plan_selected', 'checkout_started', 'checkout_completed',
    'provider_connect_started', 'provider_connected', 'provider_access_opened',
    'provider_access_saved', 'provider_action_required', 'provider_repair_started',
    'provider_repair_succeeded', 'catalog_sync_started', 'catalog_ready',
    'content_opened', 'playback_started', 'playback_first_frame',
    'journey_retry', 'journey_error',
    'billing_period_changed', 'faq_opened', 'demo_interaction',
    'context_widget_action', 'context_widget_impression'
  ]);

  var SMART_EVENT_SPINE = Object.freeze([
    'app_open', 'primary_cta_clicked', 'signup_started', 'signup_completed',
    'plan_selected', 'checkout_started', 'checkout_completed',
    'provider_connect_started', 'provider_connected', 'provider_access_saved',
    'provider_action_required', 'provider_repair_started', 'provider_repair_succeeded',
    'catalog_sync_started', 'catalog_ready', 'content_opened',
    'playback_started', 'playback_first_frame', 'journey_retry', 'journey_error'
  ]);

  var EVENT_ALIASES = Object.freeze({
    hero_cta: 'primary_cta_clicked',
    nav_cta: 'primary_cta_clicked',
    context_widget_cta: 'primary_cta_clicked',
    store_cta_click: 'store_cta_clicked',
    pricing_view: 'pricing_viewed',
    plan_cta: 'plan_selected',
    begin_checkout: 'checkout_started',
    start_trial: 'checkout_completed',
    billing_period_change: 'billing_period_changed',
    faq_open: 'faq_opened',
    context_widget_message_view: 'context_widget_impression'
  });

  var TAG_RULES = Object.freeze({
    authenticated: { key: 'visitor_state', values: ['signed_in', 'anonymous'] },
    period: { key: 'billing_period', values: ['monthly', 'annual'] },
    plan: { key: 'selected_plan', values: ['plus', 'family', 'unknown'] },
    source: { key: 'event_source', values: ['landing', 'hero', 'nav', 'pricing', 'context_widget', 'manual', 'automatic', 'settings', 'onboarding', 'player', 'unknown'] },
    target: { key: 'event_target', values: ['signup', 'login', 'pricing', 'android_mobile', 'android_tv', 'app', 'checkout', 'unknown'] },
    state: { key: 'event_state', values: ['started', 'completed', 'ready', 'action_required', 'error', 'cancelled', 'unknown'] },
    method: { key: 'auth_method', values: ['email_password', 'email_magic_link', 'google', 'unknown'] },
    placement: { key: 'journey_entrypoint', values: ['landing', 'account', 'subscribe_plans', 'paywall', 'locked_profile', 'settings', 'onboarding', 'player', 'unknown'] },
    journey: { key: 'journey_name', values: ['acquisition', 'subscription', 'provider_onboarding', 'provider_recovery', 'catalog', 'time_to_value', 'authentication', 'unknown'] },
    step: { key: 'journey_step', values: ['landing', 'signup', 'login', 'pricing', 'checkout', 'provider_connect', 'provider_access', 'provider_repair', 'catalog_sync', 'content', 'playback', 'unknown'] },
    outcome: { key: 'journey_outcome', values: ['success', 'error', 'cancelled', 'pending', 'retry', 'unknown'] },
    failureFamily: { key: 'failure_family', values: ['credentials', 'provider_busy', 'provider_blocked', 'provider_unreachable', 'network', 'timeout', 'format', 'superseded', 'revision_conflict', 'invalid_state', 'billing_unavailable', 'payment_declined', 'entitlement_pending', 'cancelled', 'unknown'] },
    catalogState: { key: 'catalog_state', values: ['none', 'syncing', 'ready', 'error', 'unknown'] },
    providerAccessState: { key: 'provider_access_state', values: ['active', 'expiring', 'expected_expired', 'expired_confirmed', 'access_unavailable_confirmed', 'check_failed_temporary', 'restoring', 'unknown'] },
    subscriptionState: { key: 'subscription_state', values: ['none', 'trialing', 'active', 'past_due', 'cancelled', 'unknown'] },
    releaseChannel: { key: 'release_channel', values: ['production', 'qa', 'preview', 'unknown'] }
  });

  var APP_SCREENS = new Set([
    'home', 'live', 'guide', 'movies', 'series', 'settings', 'partners',
    'search', 'watch', 'pairing', 'error'
  ]);
  var SETTINGS_SCREENS = new Set([
    'account', 'sources', 'profile', 'notifications'
  ]);

  function readStoredConsent() {
    try {
      var parsed = JSON.parse(localStorage.getItem(CONSENT_KEY) || 'null');
      return parsed && parsed.status === 'granted' ? 'granted' : 'denied';
    } catch (_) {
      return 'denied';
    }
  }

  function compactValue(value) {
    if (typeof value === 'boolean') return value ? 'signed_in' : 'anonymous';
    if (typeof value !== 'string' && typeof value !== 'number') return '';
    return String(value).trim().slice(0, 80);
  }

  function normalizeToken(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').slice(0, 48);
  }

  function safeTagValue(rule, value) {
    if (!rule) return '';
    var normalized = typeof value === 'boolean'
      ? (value ? 'signed_in' : 'anonymous')
      : normalizeToken(value);
    return rule.values.indexOf(normalized) !== -1 ? normalized : '';
  }

  function platformContext() {
    var ua = '';
    try { ua = navigator.userAgent || ''; } catch (_) {}
    var androidPhoneShell = /NorvaTV-AndroidPhone/i.test(ua);
    var androidTvShell = /NorvaTV-AndroidTV/i.test(ua);
    var nativeShell = androidPhoneShell || androidTvShell;
    var viewport = 'desktop';
    try {
      if (window.matchMedia('(max-width: 680px)').matches) viewport = 'mobile';
      else if (window.matchMedia('(max-width: 1100px)').matches) viewport = 'tablet';
    } catch (_) {}
    return {
      platform: androidTvShell ? 'tv' : androidPhoneShell ? 'mobile' : 'web',
      runtime: nativeShell ? 'android_webview' : 'browser',
      viewport: viewport,
      nativeShell: nativeShell
    };
  }

  function isAllowedPath() {
    var allowed = Array.isArray(clarityCfg.allowedPaths) ? clarityCfg.allowedPaths : [];
    return allowed.indexOf(location.pathname || '/') !== -1;
  }

  function surfaceContext() {
    var path = String(location.pathname || '/').toLowerCase();
    if (path === '/' || path === '/landing.html') return 'landing';
    if (path === '/account' || path === '/account.html') return 'account';
    if (path === '/subscribe.html' || path === '/paywall.html') return 'pricing';
    if (path === '/checkout-revolut.html') return 'checkout';
    if (path === '/app' || path === '/app.html') return 'app';
    if (path === '/subscription.html') return 'subscription';
    return 'other';
  }

  function currentScreen() {
    var surface = surfaceContext();
    if (surface !== 'app') return surface;
    var raw = String(location.hash || '#home').replace(/^#/, '').split(/[?&]/, 1)[0];
    var parts = raw.split('/').filter(Boolean);
    var page = normalizeToken(parts[0] || 'home');
    if (!APP_SCREENS.has(page)) return 'other';
    if (page !== 'settings') return page;
    var settingsPage = normalizeToken(parts[1] || 'account');
    return SETTINGS_SCREENS.has(settingsPage) ? 'settings_' + settingsPage : 'settings';
  }

  function clarityEligible() {
    var context = platformContext();
    return Boolean(
      cfg.enabled &&
      clarityCfg.enabled !== false &&
      clarityCfg.projectId &&
      isAllowedPath() &&
      !context.nativeShell
    );
  }

  function queueClarity() {
    window.clarity = window.clarity || function () {
      (window.clarity.q = window.clarity.q || []).push(arguments);
    };
  }

  function clarityConsent(status) {
    if (typeof window.clarity !== 'function') return;
    var value = status === 'granted' ? 'granted' : 'denied';
    window.clarity('consentv2', {
      ad_Storage: value,
      analytics_Storage: value
    });
  }

  function setTag(key, value) {
    var safeKey = String(key || '').replace(/[^a-z0-9_]/gi, '_').slice(0, 40);
    var safeValue = compactValue(value);
    if (!safeKey || !safeValue || typeof window.clarity !== 'function') return;
    window.clarity('set', safeKey, safeValue);
  }

  function applyBaseTags() {
    var context = platformContext();
    setTag('norva_schema', analyticsCfg.schema || 'norva-product-analytics:v2');
    setTag('norva_platform', context.platform);
    setTag('norva_runtime', context.runtime);
    setTag('norva_viewport', context.viewport);
    setTag('norva_surface', surfaceContext());
    setTag('norva_screen', currentScreen());
    setTag('funnel_version', analyticsCfg.funnelVersion || 'norva-funnel:v2');
    setTag('release_channel', location.hostname === 'norva.tv' ? 'production' : 'qa');
  }

  function loadClarity() {
    if (clarityLoaded || consent !== 'granted' || !clarityEligible()) return;
    queueClarity();
    clarityConsent('granted');
    applyBaseTags();

    clarityScript = document.createElement('script');
    clarityScript.async = true;
    clarityScript.src = 'https://www.clarity.ms/tag/' + encodeURIComponent(clarityCfg.projectId);
    clarityScript.setAttribute('data-norva-product-analytics', 'clarity');
    clarityScript.referrerPolicy = 'strict-origin-when-cross-origin';
    (document.head || document.documentElement).appendChild(clarityScript);
    clarityLoaded = true;
  }

  function canonicalEvent(name) {
    var raw = normalizeToken(name);
    return EVENT_ALIASES[raw] || raw;
  }

  function safeDetails(details) {
    var safe = {};
    Object.keys(TAG_RULES).forEach(function (key) {
      if (!details || details[key] === undefined) return;
      var value = safeTagValue(TAG_RULES[key], details[key]);
      if (value) safe[key] = value;
    });
    return safe;
  }

  function track(name, params) {
    var originalName = normalizeToken(name);
    var eventName = canonicalEvent(originalName);
    if (!eventName || consent !== 'granted' || !CLARITY_EVENTS.has(eventName)) return false;
    var details = params && typeof params === 'object' ? params : {};
    var safeParams = safeDetails(details);
    if (details.once === 'page' || ['landing_view', 'pricing_viewed', 'app_open'].indexOf(eventName) !== -1) {
      var pageKey = eventName + ':' + surfaceContext();
      if (sentPageEvents.has(pageKey)) return false;
      sentPageEvents.add(pageKey);
    }

    if (window.NorvaMarketing && typeof window.NorvaMarketing.track === 'function') {
      window.NorvaMarketing.track(eventName, safeParams);
    }

    if (platformContext().nativeShell && window.NorvaNativeAnalytics
        && typeof window.NorvaNativeAnalytics.track === 'function') {
      return window.NorvaNativeAnalytics.track(eventName, safeParams);
    }

    loadClarity();
    if (!clarityLoaded || typeof window.clarity !== 'function') return false;

    Object.keys(TAG_RULES).forEach(function (key) {
      if (safeParams[key] === undefined) return;
      var value = safeTagValue(TAG_RULES[key], safeParams[key]);
      if (value) setTag(TAG_RULES[key].key, value);
    });
    setTag('last_product_event', eventName);
    window.clarity('event', eventName);
    return true;
  }

  function setConsent(next) {
    consent = next === 'granted' ? 'granted' : 'denied';
    if (consent === 'granted') {
      loadClarity();
      publishPageLifecycle();
      return;
    }
    if (clarityLoaded) clarityConsent('denied');
  }

  window.addEventListener('norva:landing-event', function (event) {
    var detail = event && event.detail;
    if (!detail || typeof detail.event !== 'string') return;
    track(detail.event, detail);
  });

  window.addEventListener('norva:product-event', function (event) {
    var detail = event && event.detail;
    if (!detail || typeof detail.event !== 'string') return;
    track(detail.event, detail);
  });

  function publishPageLifecycle() {
    if (consent !== 'granted') return;
    var surface = surfaceContext();
    setTag('norva_surface', surface);
    setTag('norva_screen', currentScreen());
    if (surface === 'landing') track('landing_view', { source: 'landing', once: 'page' });
    if (surface === 'pricing') track('pricing_viewed', { journey: 'subscription', step: 'pricing', once: 'page' });
    if (surface === 'app') track('app_open', { placement: 'unknown', once: 'page' });
  }

  function drainQueue() {
    var queue = Array.isArray(window.NorvaProductAnalyticsQueue)
      ? window.NorvaProductAnalyticsQueue.splice(0)
      : [];
    queue.forEach(function (item) {
      if (!Array.isArray(item)) return;
      track(item[0], item[1]);
    });
  }

  window.NorvaProductAnalytics = {
    init: loadClarity,
    track: track,
    setConsent: setConsent,
    context: platformContext,
    isClarityEligible: clarityEligible,
    smartEventSpine: SMART_EVENT_SPINE,
    surface: surfaceContext
  };

  window.NorvaTrackProduct = track;

  window.addEventListener('hashchange', function () {
    if (consent !== 'granted') return;
    setTag('norva_screen', currentScreen());
  });

  if (consent === 'granted') {
    if (window.NorvaMarketing && typeof window.NorvaMarketing.setConsent === 'function') {
      window.NorvaMarketing.setConsent('granted');
    }
    loadClarity();
    drainQueue();
    publishPageLifecycle();
  } else {
    // Interactions that happened before consent are deliberately not replayed.
    window.NorvaProductAnalyticsQueue = [];
  }
}());
