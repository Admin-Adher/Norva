import {
  clearReferralCookie,
  loadClaimConfig,
  publicHeaders,
  readReferralCookie,
  referralClaimIdempotencyKey,
} from '../../_shared/partners-referral.js';

const BEARER_PATTERN = /^Bearer ([^\s,]{16,8192})$/;

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') {
    return response(405, { claimed: false, state: 'method_not_allowed' }, {
      Allow: 'POST',
    });
  }
  const requestUrl = new URL(request.url);
  if (request.headers.get('Origin') !== requestUrl.origin) {
    return response(403, { claimed: false, state: 'origin_denied' });
  }
  const config = loadClaimConfig(env);
  if (!config) {
    return response(
      503,
      { claimed: false, state: 'temporarily_unavailable' },
      { 'Retry-After': '30' },
    );
  }
  const authorization = request.headers.get('Authorization') || '';
  if (!BEARER_PATTERN.test(authorization)) {
    return response(401, { claimed: false, state: 'authentication_required' });
  }
  const contentType = request.headers.get('Content-Type') || '';
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
    return response(415, { claimed: false, state: 'invalid_request' });
  }
  let input;
  try {
    const text = await request.text();
    if (!text || new TextEncoder().encode(text).byteLength > 128) {
      throw new Error('invalid_request');
    }
    input = JSON.parse(text);
  } catch {
    return response(400, { claimed: false, state: 'invalid_request' });
  }
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).length !== 0
  ) {
    return response(400, { claimed: false, state: 'invalid_request' });
  }

  const cookieHeader = request.headers.get('Cookie');
  const claimToken = readReferralCookie(cookieHeader);
  if (!claimToken) {
    if (
      typeof cookieHeader === 'string' &&
      /(?:^|;\s*)__Host-norva_referral=/.test(cookieHeader)
    ) {
      return response(
        200,
        { claimed: false, state: 'invalid' },
        { 'Set-Cookie': clearReferralCookie() },
      );
    }
    return response(200, { claimed: false, state: 'absent' });
  }

  let upstream;
  try {
    upstream = await fetch(`${config.apiUrl}/referral/claim`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json; charset=utf-8',
        'Idempotency-Key': await referralClaimIdempotencyKey(claimToken),
        Origin: requestUrl.origin,
      },
      body: JSON.stringify({ claimToken }),
      // Keep the bearer token and opaque claim token on the configured
      // origin. Redirect responses are handled as non-success below.
      redirect: 'manual',
    });
  } catch {
    return response(
      503,
      { claimed: false, state: 'temporarily_unavailable' },
      { 'Retry-After': '30' },
    );
  }

  let payload = null;
  const upstreamType = upstream.headers.get('Content-Type') || '';
  if (/^application\/json(?:\s*;|$)/i.test(upstreamType)) {
    try {
      const text = await upstream.text();
      if (new TextEncoder().encode(text).byteLength <= 32_768) {
        payload = JSON.parse(text);
      }
    } catch {
      payload = null;
    }
  } else {
    try {
      await upstream.body?.cancel();
    } catch {
      // Public response remains generic.
    }
  }

  if (upstream.ok) {
    const result = sanitizeClaimResult(payload);
    if (!result) {
      return response(
        503,
        { claimed: false, state: 'temporarily_unavailable' },
        { 'Retry-After': '30' },
      );
    }
    return response(
      200,
      result,
      { 'Set-Cookie': clearReferralCookie() },
    );
  }

  const code = payload?.error?.code;
  if (upstream.status === 400 && code === 'invalid_request') {
    return response(
      200,
      { claimed: false, state: 'invalid' },
      { 'Set-Cookie': clearReferralCookie() },
    );
  }
  if (upstream.status === 401) {
    return response(401, { claimed: false, state: 'authentication_required' });
  }
  return response(
    upstream.status === 429 ? 429 : 503,
    { claimed: false, state: 'temporarily_unavailable' },
    { 'Retry-After': upstream.status === 429 ? '60' : '30' },
  );
}

function sanitizeClaimResult(payload) {
  const data = payload?.data;
  if (
    !data ||
    data.schema_version !== 1 ||
    data.action !== 'referral_claimed' ||
    data.terminal !== true ||
    typeof data.replayed !== 'boolean'
  ) {
    return null;
  }
  if (data.outcome === 'attributed' || data.outcome === 'already_attributed') {
    return {
      claimed: true,
      state: data.outcome === 'attributed' ? 'attributed' : 'already_attributed',
    };
  }
  if (['ineligible', 'expired', 'invalid'].includes(data.outcome)) {
    return { claimed: false, state: data.outcome };
  }
  return null;
}

function response(status, data, extra = {}) {
  return new Response(JSON.stringify({ version: 1, ...data }), {
    status,
    headers: publicHeaders({
      'Content-Type': 'application/json; charset=utf-8',
      ...extra,
    }),
  });
}
