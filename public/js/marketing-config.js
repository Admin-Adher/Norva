window.NORVA_MARKETING_CONFIG = window.NORVA_MARKETING_CONFIG || {
  enabled: true,
  consentMode: 'denied',
  debug: false,
  productAnalytics: {
    schema: 'norva-product-analytics:v2',
    funnelVersion: 'norva-funnel:v2',
    clarity: {
      enabled: true,
      projectId: 'y8fgihobbx',
      allowedPaths: [
        '/', '/landing.html',
        '/account', '/account.html',
        '/subscribe.html', '/paywall.html', '/checkout-revolut.html',
        '/app', '/app.html', '/subscription.html'
      ]
    }
  },
  googleAnalytics: {
    measurementId: 'G-2Z7P4LRR1T',
    sendPageView: true
  },
  googleAds: {
    conversionId: 'AW-18272881286',
    conversions: {
      signup: '68jMCPyoq9AcEIaVmIlE',
      beginCheckout: 'XrgICP-oq9AcEIaVmIlE',
      trialStart: 'zr74CIKpq9AcEIaVmIlE',
      purchase: 'q0O5CIWpq9AcEIaVmIlE'
    }
  },
  meta: {
    pixelId: ''
  }
};

// Product flows can emit before the deferred analytics adapter executes (for
// example an OAuth callback near the end of account.html). Queue only the
// closed event name + privacy-safe dimensions; the adapter validates both
// before sending anything and drops the queue when consent is denied.
window.NorvaProductAnalyticsQueue = window.NorvaProductAnalyticsQueue || [];
window.NorvaTrackProduct = window.NorvaTrackProduct || function (name, params) {
  if (window.NorvaProductAnalytics && typeof window.NorvaProductAnalytics.track === 'function') {
    return window.NorvaProductAnalytics.track(name, params || {});
  }
  window.NorvaProductAnalyticsQueue.push([name, params || {}]);
  return false;
};
