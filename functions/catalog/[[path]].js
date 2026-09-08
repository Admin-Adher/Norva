// Retired operational documents must not fall through to static assets or the SPA.
export function onRequest({ request, next }) {
  const { pathname } = new URL(request.url);
  if (!/^\/catalog\/(?:credits(?:\.html)?|sources(?:\.json)?)\/?$/i.test(pathname)) {
    return next();
  }
  return new Response(request.method === 'HEAD' ? null : 'Page unavailable.', {
    status: 410,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
