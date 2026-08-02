import {
  buildInternalResolveRequest,
  loadResolverConfig,
  parsePublicReferralCode,
  publicHeaders,
  referralCookie,
  safeReferralRedirect,
  sanitizeResolveResponse,
} from '../_shared/partners-referral.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'GET') {
    return new Response('Method not allowed', {
      status: 405,
      headers: publicHeaders({ Allow: 'GET' }),
    });
  }
  const config = loadResolverConfig(env);
  if (!config) {
    return new Response('Referral attribution is temporarily unavailable.', {
      status: 503,
      headers: publicHeaders({ 'Retry-After': '60' }),
    });
  }
  const code = parsePublicReferralCode(new URL(request.url).pathname);
  if (!code) {
    return redirect(config.redirectUrl, 'unavailable');
  }

  let internal;
  try {
    internal = await buildInternalResolveRequest({
      code,
      networkValue: request.headers.get('CF-Connecting-IP') || '',
      userAgentValue: request.headers.get('User-Agent') || '',
      secret: config.edgeHmacSecret,
    });
  } catch {
    return unavailable('30');
  }

  let upstream;
  try {
    upstream = await fetch(config.edgeUrl, {
      method: 'POST',
      headers: internal.headers,
      body: internal.body,
      // Never forward the internal HMAC headers across a redirect. A manual
      // response keeps every redirect fail-closed at the response boundary.
      redirect: 'manual',
    });
  } catch {
    return unavailable('30');
  }
  if (!upstream.ok) {
    try {
      await upstream.body?.cancel();
    } catch {
      // Public response remains generic.
    }
    return unavailable(upstream.status === 429 ? '60' : '30');
  }
  const contentType = upstream.headers.get('Content-Type') || '';
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    return unavailable('30');
  }
  let result;
  try {
    const text = await upstream.text();
    if (!text || new TextEncoder().encode(text).byteLength > 16_384) {
      throw new Error('invalid_referral_response');
    }
    result = sanitizeResolveResponse(JSON.parse(text));
  } catch {
    return unavailable('30');
  }
  if (!result.accepted) {
    return redirect(config.redirectUrl, 'unavailable');
  }
  return redirect(config.redirectUrl, 'ready', {
    'Set-Cookie': referralCookie(result.cookieToken),
  });
}

function redirect(base, state, extra = {}) {
  return new Response(null, {
    status: 303,
    headers: publicHeaders({
      Location: safeReferralRedirect(base, state),
      ...extra,
    }),
  });
}

function unavailable(retryAfter = '30') {
  return new Response('Referral attribution is temporarily unavailable.', {
    status: 503,
    headers: publicHeaders({ 'Retry-After': retryAfter }),
  });
}
