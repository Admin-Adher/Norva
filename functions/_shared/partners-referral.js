export const REFERRAL_COOKIE_NAME = '__Host-norva_referral';
export const REFERRAL_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const CODE_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const COOKIE_TOKEN_PATTERN = /^v1\.[0-9a-f]{64}\.[0-9a-f]{64}$/;
const CORRELATION_PATTERN = /^prf_[0-9a-f]{24}$/;
const UTF8 = new TextEncoder();

export function parsePublicReferralCode(pathname) {
  if (typeof pathname !== 'string') return null;
  const match = pathname.match(/^\/r\/([A-Za-z0-9_-]{32})\/?$/);
  return match && CODE_PATTERN.test(match[1]) ? match[1] : null;
}

export function loadResolverConfig(env) {
  const edgeUrl = safeHttpsUrl(env?.NORVA_PARTNERS_REFERRAL_EDGE_URL);
  const redirectUrl = safeNorvaRedirect(env?.NORVA_REFERRAL_REDIRECT_URL);
  const edgeHmacSecret = boundedSecret(env?.NORVA_REFERRAL_EDGE_HMAC_SECRET);
  if (
    !edgeUrl ||
    !redirectUrl ||
    !edgeHmacSecret ||
    !edgeUrl.pathname.endsWith(
      '/functions/v1/norva-partners-referral/resolve',
    )
  ) {
    return null;
  }
  return {
    edgeUrl: edgeUrl.href,
    redirectUrl: redirectUrl.href,
    edgeHmacSecret,
  };
}

export function loadClaimConfig(env) {
  const apiUrl = safeHttpsUrl(env?.NORVA_PARTNERS_API_URL);
  if (
    !apiUrl ||
    !apiUrl.pathname.endsWith('/functions/v1/norva-partners') ||
    apiUrl.search ||
    apiUrl.hash
  ) {
    return null;
  }
  return { apiUrl: apiUrl.href.replace(/\/$/, '') };
}

export async function buildInternalResolveRequest({
  code,
  networkValue,
  userAgentValue,
  secret,
  nowEpochSeconds = Math.floor(Date.now() / 1000),
  nonce = randomHex(24),
}) {
  if (!CODE_PATTERN.test(code) || !boundedSecret(secret)) {
    throw new Error('invalid_referral_request');
  }
  const body = JSON.stringify({
    code,
    networkHash: await hmacHex(secret, `network:v1:${networkValue || 'unknown'}`),
    userAgentHash: await hmacHex(
      secret,
      `network-user-agent:v1:${networkValue || 'unknown'}\n${userAgentValue || 'unknown'}`,
    ),
  });
  const timestamp = String(nowEpochSeconds);
  const bodyHash = await sha256Hex(body);
  const canonical = [
    timestamp,
    nonce,
    'POST',
    '/resolve',
    bodyHash,
  ].join('\n');
  return {
    body,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Norva-Timestamp': timestamp,
      'X-Norva-Nonce': nonce,
      'X-Norva-Signature': await hmacHex(secret, canonical),
    },
  };
}

export function sanitizeResolveResponse(raw) {
  if (!isExactRecord(raw, ['version', 'correlationId', 'data'])) {
    throw new Error('invalid_referral_response');
  }
  if (
    raw.version !== '2026-07-29' ||
    typeof raw.correlationId !== 'string' ||
    !CORRELATION_PATTERN.test(raw.correlationId) ||
    !raw.data ||
    typeof raw.data !== 'object' ||
    Array.isArray(raw.data)
  ) {
    throw new Error('invalid_referral_response');
  }
  if (raw.data.accepted === false) {
    if (!isExactRecord(raw.data, ['accepted'])) {
      throw new Error('invalid_referral_response');
    }
    return { accepted: false };
  }
  if (
    !isExactRecord(raw.data, ['accepted', 'cookieToken', 'expiresAt']) ||
    raw.data.accepted !== true ||
    typeof raw.data.cookieToken !== 'string' ||
    !COOKIE_TOKEN_PATTERN.test(raw.data.cookieToken) ||
    typeof raw.data.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(raw.data.expiresAt))
  ) {
    throw new Error('invalid_referral_response');
  }
  const remainingMs = Date.parse(raw.data.expiresAt) - Date.now();
  if (
    remainingMs <= 0 ||
    remainingMs > (REFERRAL_MAX_AGE_SECONDS + 60) * 1000
  ) {
    throw new Error('invalid_referral_response');
  }
  return {
    accepted: true,
    cookieToken: raw.data.cookieToken,
    expiresAt: raw.data.expiresAt,
  };
}

export function referralCookie(value, maxAge = REFERRAL_MAX_AGE_SECONDS) {
  if (!COOKIE_TOKEN_PATTERN.test(value) || !Number.isSafeInteger(maxAge)) {
    throw new Error('invalid_referral_cookie');
  }
  return `${REFERRAL_COOKIE_NAME}=${value}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

export function clearReferralCookie() {
  return `${REFERRAL_COOKIE_NAME}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

export function readReferralCookie(header) {
  if (typeof header !== 'string' || header.length > 8192) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name === REFERRAL_COOKIE_NAME) {
      return COOKIE_TOKEN_PATTERN.test(value) ? value : null;
    }
  }
  return null;
}

export async function referralClaimIdempotencyKey(token) {
  if (!COOKIE_TOKEN_PATTERN.test(token)) {
    throw new Error('invalid_referral_cookie');
  }
  return `refclaim:${(await sha256Hex(token)).slice(0, 48)}`;
}

export function safeReferralRedirect(base, state) {
  const url = safeNorvaRedirect(base);
  if (!url || !['ready', 'unavailable'].includes(state)) {
    throw new Error('invalid_referral_redirect');
  }
  url.searchParams.set('referral', state);
  return url.href;
}

export function publicHeaders(extra = {}) {
  return {
    'Cache-Control': 'private, no-store, max-age=0',
    Pragma: 'no-cache',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  };
}

async function sha256Hex(value) {
  return bytesToHex(await crypto.subtle.digest('SHA-256', UTF8.encode(value)));
}

async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw',
    UTF8.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return bytesToHex(
    await crypto.subtle.sign('HMAC', key, UTF8.encode(value)),
  );
}

function bytesToHex(value) {
  return Array.from(
    new Uint8Array(value),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}

function randomHex(byteLength) {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(byteLength)));
}

function safeHttpsUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function safeNorvaRedirect(value) {
  const url = safeHttpsUrl(value);
  if (
    !url ||
    !['norva.tv', 'www.norva.tv', 'app.norva.tv'].includes(url.hostname)
  ) {
    return null;
  }
  return url;
}

function boundedSecret(value) {
  return (
    typeof value === 'string' &&
    value.length >= 32 &&
    value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  ) ? value : null;
}

function isExactRecord(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}
