(function () {
  'use strict';

  var cfg = window.NORVA_MARKETING_CONFIG || {};
  var loaded = { google: false, meta: false };
  var consent = cfg.consentMode || 'granted';
  var googleConsentDefaulted = false;
  var debug = Boolean(cfg.debug || /[?&]norva_marketing_debug=1\b/.test(location.search));
  var blogViewSent = false;
  var BLOG_CONTEXT_KEY = 'norva_blog_context_v1';
  var BLOG_CONTEXT_TTL_MS = 30 * 60 * 1000;
  var EVENT_SOURCES = ['landing', 'hero', 'nav', 'pricing', 'context_widget', 'final_cta',
    'footer', 'manual', 'automatic', 'settings', 'onboarding', 'player', 'consent', 'blog', 'unknown'];
  var BLOG_PLACEMENTS = ['nav', 'primary', 'inline', 'footer'];
  var BLOG_TARGETS = ['signup', 'app', 'source_settings', 'pricing', 'features',
    'how_it_works', 'product_preview', 'support', 'legal', 'blog', 'home', 'other'];
  var BLOG_FUNNEL_EVENTS = ['signup_started', 'sign_up', 'login_started', 'login_completed',
    'pricing_viewed', 'plan_selected', 'checkout_started', 'begin_checkout',
    'checkout_completed', 'start_trial', 'purchase', 'provider_connect_started',
    'provider_connected', 'catalog_ready', 'playback_first_frame'];

  function nativeSurface() {
    try {
      if (/NorvaTV-Android(?:Phone|TV)/i.test(navigator.userAgent || '')) return true;
      return Boolean(window.NorvaNativeAnalytics
        && typeof window.NorvaNativeAnalytics.available === 'function'
        && window.NorvaNativeAnalytics.available());
    } catch (_) {
      return false;
    }
  }

  function compact(obj) {
    var out = {};
    Object.keys(obj || {}).forEach(function (key) {
      if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') out[key] = obj[key];
    });
    return out;
  }

  function marketingParams(params) {
    var out = compact(params);
    // Product "source" describes an interface placement, never acquisition.
    // Keep the original product/native vocabulary outside this web boundary.
    var source = out.event_source !== undefined ? out.event_source : out.source;
    delete out.source;
    delete out.event_source;
    if (EVENT_SOURCES.indexOf(source) !== -1) out.event_source = source;
    return out;
  }

  function validBlogSlug(value) {
    return typeof value === 'string' && value.length <= 100
      && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
  }

  function blogArticle() {
    var path = String(location.pathname || '');
    if (path === '/blog/' || path === '/blog') return 'blog_index';
    var match = /^\/blog\/([a-z0-9-]+)\/?$/.exec(path);
    if (!match || !validBlogSlug(match[1]) || typeof document.querySelector !== 'function') return '';
    var article = document.querySelector('[data-blog-article]');
    // A template-owned marker must agree with the canonical path. Do not read
    // slugs, account identifiers, or arbitrary labels from query strings.
    return article && article.getAttribute('data-blog-article') === match[1] ? match[1] : '';
  }

  function measurementEnvironment() {
    return location.hostname === 'norva.tv' ? 'production' : 'qa';
  }

  function blogTarget(el) {
    try {
      var origin = location.origin;
      var url = new URL(el.getAttribute('href'), origin + (location.pathname || '/'));
      if (!/^https?:$/.test(url.protocol) || url.origin !== origin || url.username || url.password) return 'other';
      var path = url.pathname;
      if (path === '/account' || path === '/account.html') return 'signup';
      if (path === '/app' || path === '/app.html') return url.hash === '#settings/sources' ? 'source_settings' : 'app';
      if (['/subscribe.html', '/subscription', '/subscription.html', '/paywall.html'].indexOf(path) !== -1) return 'pricing';
      if (path === '/support' || path === '/support.html') return 'support';
      if (['/privacy.html', '/terms.html', '/mentions-legales.html'].indexOf(path) !== -1) return 'legal';
      if (path === '/blog' || path.indexOf('/blog/') === 0) return 'blog';
      if (path === '/' || path === '/landing.html') {
        return ({ '#features': 'features', '#how-it-works': 'how_it_works',
          '#product-preview': 'product_preview', '#pricing': 'pricing' })[url.hash] || 'home';
      }
    } catch (_) { /* Invalid destinations never leak into analytics. */ }
    return 'other';
  }

  function clearBlogContext() {
    try { sessionStorage.removeItem(BLOG_CONTEXT_KEY); } catch (_) {}
  }

  function rememberBlogClick(params) {
    if (!enabled() || params.cta_target === 'other' || params.article_slug === 'blog_index') return;
    try {
      sessionStorage.setItem(BLOG_CONTEXT_KEY, JSON.stringify({
        v: 1, slug: params.article_slug, placement: params.cta_placement,
        target: params.cta_target, at: Date.now()
      }));
    } catch (_) { /* Storage unavailable: retain event-only measurement. */ }
  }

  function recentBlogContext() {
    if (!enabled()) return {};
    try {
      var record = JSON.parse(sessionStorage.getItem(BLOG_CONTEXT_KEY) || 'null');
      if (!record) return {};
      var age = Date.now() - record.at;
      if (record.v !== 1 || !validBlogSlug(record.slug)
          || BLOG_PLACEMENTS.indexOf(record.placement) === -1
          || BLOG_TARGETS.indexOf(record.target) === -1 || record.target === 'other'
          || typeof record.at !== 'number' || !Number.isFinite(age)
          || age < 0 || age >= BLOG_CONTEXT_TTL_MS) {
        clearBlogContext();
        return {};
      }
      return {
        blog_article_slug: record.slug,
        blog_cta_placement: record.placement,
        blog_cta_target: record.target,
        blog_context_model: 'last_cta_30m',
        measurement_environment: measurementEnvironment()
      };
    } catch (_) {
      clearBlogContext();
      return {};
    }
  }

  function blogEvent(name, params) {
    var gaId = cfg.googleAnalytics && cfg.googleAnalytics.measurementId;
    if (!enabled() || !gaId) return false;
    // Blog diagnostics are GA4 events only, not Ads actions or Meta events.
    googleEvent(name, Object.assign({ send_to: gaId, event_source: 'blog',
      content_group: 'blog', measurement_environment: measurementEnvironment() }, params));
    return true;
  }

  function publishBlogView() {
    if (blogViewSent || !enabled()) return;
    var slug = blogArticle();
    if (slug) blogViewSent = blogEvent('blog_view', { article_slug: slug });
  }

  function log() {
    if (!debug || !window.console) return;
    console.log.apply(console, ['[NorvaMarketing]'].concat([].slice.call(arguments)));
  }

  function enabled() {
    return Boolean(cfg.enabled && consent === 'granted' && !nativeSurface());
  }

  function ensureGoogleCommandQueue() {
    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
  }

  function googleConsentState(status) {
    var value = status === 'granted' ? 'granted' : 'denied';
    return {
      ad_storage: value,
      ad_user_data: value,
      ad_personalization: value,
      analytics_storage: value
    };
  }

  function ensureGoogleConsentDefault() {
    if (googleConsentDefaulted) return;
    ensureGoogleCommandQueue();
    window.gtag('consent', 'default', googleConsentState('denied'));
    googleConsentDefaulted = true;
  }

  function updateGoogleConsent(status) {
    ensureGoogleConsentDefault();
    window.gtag('consent', 'update', googleConsentState(status));
  }

  function appendScript(src, attrs) {
    if (!src) return;
    var s = document.createElement('script');
    s.async = true;
    s.src = src;
    Object.keys(attrs || {}).forEach(function (k) { s.setAttribute(k, attrs[k]); });
    (document.head || document.documentElement).appendChild(s);
  }

  function initGoogle() {
    if (loaded.google || !enabled()) return;
    var gaId = cfg.googleAnalytics && cfg.googleAnalytics.measurementId;
    var adsId = cfg.googleAds && cfg.googleAds.conversionId;
    var id = gaId || adsId;
    if (!id) return;
    ensureGoogleConsentDefault();
    updateGoogleConsent('granted');
    window.gtag('js', new Date());
    if (gaId) window.gtag('config', gaId, { send_page_view: cfg.googleAnalytics.sendPageView !== false });
    if (adsId && adsId !== gaId) window.gtag('config', adsId, { send_page_view: false });
    appendScript('https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(id));
    loaded.google = true;
  }

  function initMeta() {
    if (loaded.meta || !enabled()) return;
    var pixelId = cfg.meta && cfg.meta.pixelId;
    if (!pixelId) return;
    /* Meta Pixel bootstrap, intentionally loaded only after config+consent are enabled. */
    !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
    n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
    n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
    t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window, document,'script',
    'https://connect.facebook.net/en_US/fbevents.js');
    window.fbq('init', pixelId);
    window.fbq('track', 'PageView');
    loaded.meta = true;
  }

  function init() {
    initGoogle();
    initMeta();
    publishBlogView();
    log('init', { enabled: enabled(), cfg: cfg });
  }

  function googleEvent(name, params) {
    initGoogle();
    if (typeof window.gtag === 'function') window.gtag('event', name, compact(params));
  }

  function googleConversion(label, params) {
    var ads = cfg.googleAds || {};
    var conversionId = ads.conversionId;
    var conversionLabel = ads.conversions && ads.conversions[label];
    if (!conversionId || !conversionLabel) return;
    googleEvent('conversion', Object.assign({ send_to: conversionId + '/' + conversionLabel }, compact(params)));
  }

  function metaEvent(name, params) {
    initMeta();
    if (typeof window.fbq === 'function') window.fbq('track', name, compact(params));
  }

  function track(name, params) {
    if (!enabled()) return;
    params = marketingParams(params || {});
    // Product analytics keeps a platform-neutral funnel vocabulary for Clarity
    // and native telemetry. Normalize only at the marketing boundary so GA4
    // and Google Ads receive their canonical registration event.
    var marketingName = name === 'signup_completed' ? 'sign_up' : name;
    // This is a short-lived, same-tab click association, not a replacement for
    // GA4 acquisition or evidence of a commercial outcome. Never emit a funnel
    // event here: decorate only real events already produced by product flows.
    var blogContext = BLOG_FUNNEL_EVENTS.indexOf(marketingName) !== -1 ? recentBlogContext() : {};
    var gaId = cfg.googleAnalytics && cfg.googleAnalytics.measurementId;
    var googleParams = blogContext.blog_article_slug && gaId
      ? Object.assign({}, params, blogContext, { send_to: gaId }) : params;
    googleEvent(marketingName, googleParams);
    var metaName = {
      sign_up: 'CompleteRegistration',
      begin_checkout: 'InitiateCheckout',
      start_trial: 'StartTrial',
      purchase: 'Purchase',
      lead: 'Lead'
    }[marketingName];
    if (metaName) metaEvent(metaName, params);
    if (marketingName === 'sign_up') googleConversion('signup', params);
    if (marketingName === 'begin_checkout') googleConversion('beginCheckout', params);
    if (marketingName === 'start_trial') googleConversion('trialStart', params);
    if (marketingName === 'purchase') googleConversion('purchase', params);
    log('track', name, marketingName, params);
  }

  function inferCta(el) {
    return (el && (el.getAttribute('data-cta') || el.getAttribute('data-plan') || el.textContent || '')).trim().slice(0, 80);
  }

  document.addEventListener('click', function (event) {
    var cta = event.target && event.target.closest && event.target.closest('[data-blog-cta], [data-cta], .buy, [data-auth-action]');
    if (!cta) return;
    var slug = blogArticle();
    if (slug) {
      var placement = cta.getAttribute('data-blog-cta')
        || ({ 'blog-nav': 'nav', 'blog-article': 'primary' })[cta.getAttribute('data-cta')];
      if (BLOG_PLACEMENTS.indexOf(placement) !== -1) {
        var blogParams = { article_slug: slug, cta_placement: placement, cta_target: blogTarget(cta) };
        if (blogEvent('blog_cta_click', blogParams)) rememberBlogClick(blogParams);
      }
      // Do not duplicate the blog click as an indistinguishable select_content
      // or forward link text, query strings, or private destination parameters.
      return;
    }
    track('select_content', {
      content_type: 'cta',
      item_id: inferCta(cta),
      page_path: location.pathname
    });
    // begin_checkout is emitted by the billing flow only after the selected
    // cadence and authoritative store/server price are known. Emitting it here
    // used to double-count web checkouts and always attached the monthly USD
    // fallback, even when the visitor had selected annual or another currency.
  }, true);

  window.NorvaMarketing = {
    init: init,
    track: track,
    setConsent: function (next) {
      consent = next === 'denied' ? 'denied' : 'granted';
      // Native Firebase/Clarity own Android telemetry. Never bootstrap gtag or
      // Meta inside Norva's WebView, even after a saved-consent page reload.
      if (nativeSurface()) return;
      if (consent === 'denied') clearBlogContext();
      updateGoogleConsent(consent);
      init();
    },
    config: cfg
  };

  // Basic consent mode: queue a denied default immediately, but keep the
  // network tag itself unloaded until the visitor explicitly opts in.
  if (!nativeSurface()) ensureGoogleConsentDefault();

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
}());
