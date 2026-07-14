(function () {
  'use strict';

  var cfg = window.NORVA_MARKETING_CONFIG || {};
  var loaded = { google: false, meta: false };
  var consent = cfg.consentMode || 'granted';
  var debug = Boolean(cfg.debug || /[?&]norva_marketing_debug=1\b/.test(location.search));

  function compact(obj) {
    var out = {};
    Object.keys(obj || {}).forEach(function (key) {
      if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') out[key] = obj[key];
    });
    return out;
  }

  function log() {
    if (!debug || !window.console) return;
    console.log.apply(console, ['[NorvaMarketing]'].concat([].slice.call(arguments)));
  }

  function enabled() {
    return Boolean(cfg.enabled && consent === 'granted');
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
    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
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
    params = compact(params || {});
    googleEvent(name, params);
    var metaName = {
      sign_up: 'CompleteRegistration',
      begin_checkout: 'InitiateCheckout',
      start_trial: 'StartTrial',
      purchase: 'Purchase',
      lead: 'Lead'
    }[name];
    if (metaName) metaEvent(metaName, params);
    if (name === 'sign_up') googleConversion('signup', params);
    if (name === 'begin_checkout') googleConversion('beginCheckout', params);
    if (name === 'start_trial') googleConversion('trialStart', params);
    if (name === 'purchase') googleConversion('purchase', params);
    log('track', name, params);
  }

  function inferCta(el) {
    return (el && (el.getAttribute('data-cta') || el.getAttribute('data-plan') || el.textContent || '')).trim().slice(0, 80);
  }

  document.addEventListener('click', function (event) {
    var cta = event.target && event.target.closest && event.target.closest('[data-cta], .buy, [data-auth-action]');
    if (!cta) return;
    track('select_content', {
      content_type: 'cta',
      item_id: inferCta(cta),
      page_path: location.pathname
    });
    if (cta.classList && cta.classList.contains('buy')) {
      var card = cta.closest('[data-plan]');
      track('begin_checkout', {
        currency: 'USD',
        value: card && card.dataset ? Number(card.dataset.monthly || 0) : undefined,
        plan: card && card.dataset ? card.dataset.plan : undefined,
        page_path: location.pathname
      });
    }
  }, true);

  window.NorvaMarketing = {
    init: init,
    track: track,
    setConsent: function (next) { consent = next === 'denied' ? 'denied' : 'granted'; init(); },
    config: cfg
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
}());
