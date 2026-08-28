(function () {
  'use strict';

  var cfg = window.NORVA_MARKETING_CONFIG || {};
  var analyticsCfg = cfg.productAnalytics || {};
  var clarityCfg = analyticsCfg.clarity || {};
  var CONSENT_KEY = 'norva_consent';
  var consent = readStoredConsent();
  var clarityLoaded = false;
  var clarityScript = null;
  var landingViewSent = false;

  var CLARITY_EVENTS = new Set([
    'landing_view',
    'hero_cta',
    'nav_cta',
    'store_cta_click',
    'signup_started',
    'pricing_view',
    'billing_period_change',
    'plan_cta',
    'faq_open',
    'demo_interaction',
    'context_widget_cta',
    'context_widget_action'
  ]);

  var SAFE_TAGS = {
    authenticated: 'visitor_state',
    period: 'billing_period',
    plan: 'selected_plan',
    source: 'event_source',
    target: 'event_target',
    state: 'event_state'
  };

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
    setTag('norva_schema', analyticsCfg.schema || 'norva-product-analytics:v1');
    setTag('norva_platform', context.platform);
    setTag('norva_runtime', context.runtime);
    setTag('norva_viewport', context.viewport);
    setTag('norva_surface', 'landing');
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

  function track(name, params) {
    var eventName = String(name || '').trim().slice(0, 64);
    if (!eventName || consent !== 'granted') return;
    if (eventName === 'landing_view') {
      if (landingViewSent) return;
      landingViewSent = true;
    }

    if (window.NorvaMarketing && typeof window.NorvaMarketing.track === 'function') {
      window.NorvaMarketing.track(eventName, params || {});
    }

    if (!CLARITY_EVENTS.has(eventName)) return;
    loadClarity();
    if (!clarityLoaded || typeof window.clarity !== 'function') return;

    Object.keys(SAFE_TAGS).forEach(function (key) {
      if (!params || params[key] === undefined) return;
      setTag(SAFE_TAGS[key], params[key]);
    });
    setTag('last_product_event', eventName);
    window.clarity('event', eventName);
  }

  function setConsent(next) {
    consent = next === 'granted' ? 'granted' : 'denied';
    if (consent === 'granted') {
      loadClarity();
      if (!landingViewSent && document.readyState !== 'loading') {
        track('landing_view', { source: 'consent' });
      }
      return;
    }
    if (clarityLoaded) clarityConsent('denied');
  }

  window.addEventListener('norva:landing-event', function (event) {
    var detail = event && event.detail;
    if (!detail || typeof detail.event !== 'string') return;
    track(detail.event, detail);
  });

  window.NorvaProductAnalytics = {
    init: loadClarity,
    track: track,
    setConsent: setConsent,
    context: platformContext,
    isClarityEligible: clarityEligible
  };

  if (consent === 'granted') {
    if (window.NorvaMarketing && typeof window.NorvaMarketing.setConsent === 'function') {
      window.NorvaMarketing.setConsent('granted');
    }
    loadClarity();
  }
}());
