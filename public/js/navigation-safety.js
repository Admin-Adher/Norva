(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NorvaNavigation = Object.assign(root.NorvaNavigation || {}, api);
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // Return only a path on the current origin. In particular, reject protocol
  // URLs, scheme-relative URLs and backslashes (which browsers can normalize
  // into slashes for special schemes). `fallback` is application-owned and is
  // still normalized to a local path before it is returned.
  function safeLocalPath(value, fallback) {
    const localFallback = (typeof fallback === 'string'
      && /^\/(?!\/)/.test(fallback)
      && !/[\\\u0000-\u001f\u007f]/.test(fallback)) ? fallback : '/';

    if (typeof value !== 'string') return localFallback;
    const candidate = value.trim();
    if (!candidate
      || !/^\/(?!\/)/.test(candidate)
      || /[\\\u0000-\u001f\u007f]/.test(candidate)) return localFallback;

    try {
      const base = 'https://norva.local';
      const parsed = new URL(candidate, base);
      if (parsed.origin !== base) return localFallback;
      return parsed.pathname + parsed.search + parsed.hash;
    } catch (_) {
      return localFallback;
    }
  }

  return { safeLocalPath: safeLocalPath };
});
