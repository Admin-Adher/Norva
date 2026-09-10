(function () {
  'use strict';
  // A deliberate onward click carries the article language into the existing
  // app locale policy. Reading an article or changing its URL saves nothing.
  var language = document.documentElement.getAttribute('data-norva-document-language');
  var supported = ['en', 'fr', 'pt-BR', 'es', 'hi', 'tr', 'bn', 'ar', 'id', 'fil'];
  if (!/^\/blog(?:\/|$)/.test(location.pathname) || supported.indexOf(language) === -1) return;
  document.addEventListener('click', function (event) {
    var anchor = event.target && event.target.closest && event.target.closest('a[href]');
    if (!anchor || event.defaultPrevented || event.button > 0) return;
    try {
      var url = new URL(anchor.getAttribute('href'), location.href);
      if (url.origin !== location.origin || url.username || url.password || /^\/blog(?:\/|$)/.test(url.pathname)) return;
      if (!['/', '/landing.html', '/app', '/app.html', '/account', '/account.html',
        '/subscription', '/subscription.html', '/subscribe.html', '/support', '/support.html',
        '/terms', '/terms.html', '/privacy', '/privacy.html', '/mentions-legales', '/mentions-legales.html'].includes(url.pathname)) return;
      window.NorvaI18n?.setPreference(language);
    } catch (_) { /* An unavailable preference never blocks the original link. */ }
  }, true);
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    document.querySelectorAll('.blog-language-picker[open]').forEach(function (picker) {
      picker.open = false;
      picker.querySelector('summary').focus();
    });
  });
})();
