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
    return unavailable('30', request, 'request-signing');
  }

  let upstream;
  try {
    upstream = await fetch(config.edgeUrl, {
      method: 'POST',
      headers: internal.headers,
      body: internal.body,
      redirect: 'error',
    });
  } catch (error) {
    return unavailable('30', request, referralFetchProbe(error));
  }
  if (!upstream.ok) {
    try {
      await upstream.body?.cancel();
    } catch {
      // Public response remains generic.
    }
    return unavailable(
      upstream.status === 429 ? '60' : '30',
      request,
      `upstream-${upstream.status}`,
    );
  }
  const contentType = upstream.headers.get('Content-Type') || '';
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    return unavailable('30', request, 'upstream-content-type');
  }
  let result;
  try {
    const text = await upstream.text();
    if (!text || new TextEncoder().encode(text).byteLength > 16_384) {
      throw new Error('invalid_referral_response');
    }
    result = sanitizeResolveResponse(JSON.parse(text));
  } catch {
    return unavailable('30', request, 'upstream-contract');
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

function unavailable(retryAfter = '30', request = null, reason = '') {
  const extra = { 'Retry-After': retryAfter };
  try {
    const hostname = new URL(request?.url || '').hostname;
    if (/^[a-f0-9]{8}\.norva-web\.pages\.dev$/i.test(hostname)
      && /^[a-z0-9-]{1,32}$/.test(reason)) {
      extra['X-Norva-Referral-Probe'] = reason;
    }
  } catch {
    // Diagnostics are optional and never change the public failure contract.
  }
  return new Response('Referral attribution is temporarily unavailable.', {
    status: 503,
    headers: publicHeaders(extra),
  });
}

function referralFetchProbe(error) {
  const name = String(error?.name || 'error').toLowerCase();
  const message = String(error?.message || '').toLowerCase();
  const cause = String(error?.cause?.code || error?.code || '').toLowerCase();
  const detail = `${name}-${cause}-${message}`;
  const category = [
    ['certificate', 'tls'],
    ['tls', 'tls'],
    ['dns', 'dns'],
    ['resolve', 'dns'],
    ['redirect', 'redirect'],
    ['1042', 'same-zone'],
    ['same zone', 'same-zone'],
    ['cannot load', 'cannot-load'],
    ['network connection lost', 'network-lost'],
    ['fetch failed', 'fetch-failed'],
    ['connection refused', 'refused'],
    ['timed out', 'timeout'],
    ['timeout', 'timeout'],
  ].find(([needle]) => detail.includes(needle))?.[1] || name.replace(/[^a-z0-9-]/g, '').slice(0, 20) || 'error';
  return `upstream-fetch-${category}`;
}
