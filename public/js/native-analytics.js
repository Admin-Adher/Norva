(function () {
  'use strict';

  var VERSION = 1;
  var SCREENS = new Set([
    'home', 'live', 'guide', 'movies', 'series', 'settings',
    'settings_account', 'settings_sources', 'settings_profile',
    'settings_notifications', 'partners', 'search', 'pairing', 'error'
  ]);
  var EVENTS = new Set([
    'provider_access_opened', 'provider_access_saved',
    'provider_access_action_required', 'provider_access_error',
    'catalog_sync_started', 'catalog_sync_ready', 'catalog_sync_error',
    'login_started', 'login_completed', 'login_error'
  ]);

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

  function track(name) {
    var value = normalize(name);
    if (!EVENTS.has(value)) return false;
    return send({ v: VERSION, type: 'event', name: value });
  }

  function publishScreen() {
    setScreen(currentScreen());
  }

  window.NorvaNativeAnalytics = {
    setConsent: setConsent,
    setScreen: setScreen,
    track: track,
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
