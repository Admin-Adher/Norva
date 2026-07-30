// Authoritative Google Play Orders API adapter for Norva Partners.
//
// The Orders response contains purchaseToken and buyerAddress. Callers must
// never persist or log the raw response. This module only returns an allowlist
// of financial fields and emits stable error codes without provider payloads,
// order ids, access tokens or personal data.

const ANDROID_PUBLISHER_SCOPE =
  "https://www.googleapis.com/auth/androidpublisher";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_ORDERS_ORIGIN = "https://androidpublisher.googleapis.com";
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_SAFE_MINOR = BigInt(Number.MAX_SAFE_INTEGER);
const PACKAGE_RE =
  /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const ORDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,255}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const tokenCache = new Map();

function recordOrNull(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function cleanText(value, max = 512) {
  if (typeof value !== "string") return null;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return clean && clean.length <= max ? clean : null;
}

function validIso(value) {
  const clean = cleanText(value, 80);
  return clean && Number.isFinite(new Date(clean).getTime())
    ? new Date(clean).toISOString()
    : null;
}

function stableError(code, options = {}) {
  return new GooglePlayOrdersError(code, options);
}

export class GooglePlayOrdersError extends Error {
  constructor(code, { kind = "data", retryable = false, status = null } = {}) {
    super(code);
    this.name = "GooglePlayOrdersError";
    this.code = code;
    this.kind = kind;
    this.retryable = retryable;
    this.status = status;
  }
}

export function isGooglePlayNonAuthoritative(error) {
  return error instanceof GooglePlayOrdersError &&
    (
      error.kind === "data" ||
      (error.kind === "provider" && [400, 404, 410, 422].includes(error.status))
    );
}

export function googlePlayOrdersConfiguration(input = {}) {
  const serviceAccountJson = typeof input.serviceAccountJson === "string"
    ? input.serviceAccountJson.trim()
    : "";
  const packageName = cleanText(input.packageName, 255);

  if (!serviceAccountJson && !packageName) return null;
  if (!serviceAccountJson || !packageName || !PACKAGE_RE.test(packageName)) {
    throw stableError("google_play_config_incomplete", { kind: "config" });
  }

  let parsed;
  try {
    parsed = JSON.parse(serviceAccountJson);
  } catch {
    throw stableError("google_play_service_account_invalid", {
      kind: "config",
    });
  }
  const account = recordOrNull(parsed);
  const clientEmail = cleanText(account?.client_email, 320);
  const privateKey = typeof account?.private_key === "string"
    ? account.private_key.trim()
    : "";
  const privateKeyId = cleanText(account?.private_key_id, 256);
  const tokenUri = cleanText(account?.token_uri, 256) ?? GOOGLE_TOKEN_URL;
  if (
    String(account?.type ?? "") !== "service_account" ||
    !clientEmail ||
    !EMAIL_RE.test(clientEmail) ||
    !privateKey.startsWith("-----BEGIN PRIVATE KEY-----") ||
    !privateKey.endsWith("-----END PRIVATE KEY-----") ||
    tokenUri !== GOOGLE_TOKEN_URL
  ) {
    throw stableError("google_play_service_account_invalid", {
      kind: "config",
    });
  }

  return {
    packageName,
    serviceAccount: {
      clientEmail,
      privateKey,
      privateKeyId,
    },
  };
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlText(value) {
  return base64Url(new TextEncoder().encode(value));
}

function pemPkcs8Bytes(pem) {
  const body = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  if (!body || !/^[A-Za-z0-9+/=]+$/.test(body)) {
    throw stableError("google_play_private_key_invalid", { kind: "config" });
  }
  try {
    return Uint8Array.from(atob(body), (character) =>
      character.charCodeAt(0)
    );
  } catch {
    throw stableError("google_play_private_key_invalid", { kind: "config" });
  }
}

async function serviceAccountCacheKey(serviceAccount, cryptoImpl) {
  if (serviceAccount.privateKeyId) {
    return `${serviceAccount.clientEmail}:${serviceAccount.privateKeyId}`;
  }
  if (!cryptoImpl?.subtle) {
    throw stableError("google_play_crypto_unavailable", { kind: "config" });
  }
  const digest = await cryptoImpl.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(serviceAccount.privateKey),
  );
  return `${serviceAccount.clientEmail}:${base64Url(new Uint8Array(digest))}`;
}

export async function createGooglePlayServiceAccountJwt(
  serviceAccount,
  options = {},
) {
  const cryptoImpl = options.cryptoImpl ?? globalThis.crypto;
  if (!cryptoImpl?.subtle) {
    throw stableError("google_play_crypto_unavailable", { kind: "config" });
  }
  const nowSeconds = Math.floor(
    Number(options.nowMs ?? Date.now()) / 1000,
  );
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds <= 0) {
    throw stableError("google_play_clock_invalid", { kind: "config" });
  }

  let key;
  try {
    key = await cryptoImpl.subtle.importKey(
      "pkcs8",
      pemPkcs8Bytes(serviceAccount.privateKey),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch (error) {
    if (error instanceof GooglePlayOrdersError) throw error;
    throw stableError("google_play_private_key_invalid", { kind: "config" });
  }

  const header = base64UrlText(JSON.stringify({
    alg: "RS256",
    typ: "JWT",
    ...(serviceAccount.privateKeyId
      ? { kid: serviceAccount.privateKeyId }
      : {}),
  }));
  const claims = base64UrlText(JSON.stringify({
    iss: serviceAccount.clientEmail,
    scope: ANDROID_PUBLISHER_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  }));
  const unsigned = `${header}.${claims}`;
  let signature;
  try {
    signature = await cryptoImpl.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(unsigned),
    );
  } catch {
    throw stableError("google_play_jwt_sign_failed", { kind: "config" });
  }
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

async function boundedFetch(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch {
    throw stableError("google_play_transport_failed", {
      kind: "transport",
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function boundedJson(response) {
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw stableError("google_play_response_too_large", { kind: "data" });
  }
  let text;
  try {
    text = await response.text();
  } catch {
    throw stableError("google_play_response_unreadable", {
      kind: "transport",
      retryable: true,
    });
  }
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw stableError("google_play_response_too_large", { kind: "data" });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw stableError("google_play_response_invalid_json", { kind: "data" });
  }
}

export async function googlePlayAccessToken(configuration, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const cryptoImpl = options.cryptoImpl ?? globalThis.crypto;
  if (typeof fetchImpl !== "function") {
    throw stableError("google_play_fetch_unavailable", { kind: "config" });
  }
  const nowMs = Number(options.nowMs ?? Date.now());
  const cacheKey = await serviceAccountCacheKey(
    configuration.serviceAccount,
    cryptoImpl,
  );
  if (options.useCache !== false) {
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAtMs - 60_000 > nowMs) return cached.token;
  }

  const assertion = await createGooglePlayServiceAccountJwt(
    configuration.serviceAccount,
    { cryptoImpl, nowMs },
  );
  const response = await boundedFetch(
    fetchImpl,
    GOOGLE_TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    },
    Number(options.timeoutMs ?? 10_000),
  );
  if (!response.ok) {
    throw stableError(`google_play_oauth_http_${response.status}`, {
      kind: "auth",
      retryable: response.status === 429 || response.status >= 500,
      status: response.status,
    });
  }
  let oauthPayload;
  try {
    oauthPayload = await boundedJson(response);
  } catch (error) {
    if (
      error instanceof GooglePlayOrdersError &&
      error.kind === "transport"
    ) {
      throw error;
    }
    throw stableError("google_play_oauth_response_invalid", { kind: "auth" });
  }
  const payload = recordOrNull(oauthPayload);
  const token = cleanText(payload?.access_token, 8192);
  const expiresIn = Number(payload?.expires_in ?? 3600);
  if (
    !token ||
    !Number.isFinite(expiresIn) ||
    expiresIn < 60 ||
    expiresIn > 86_400
  ) {
    throw stableError("google_play_oauth_response_invalid", { kind: "auth" });
  }
  if (options.useCache !== false) {
    tokenCache.set(cacheKey, {
      token,
      expiresAtMs: nowMs + Math.floor(expiresIn * 1000),
    });
  }
  return token;
}

export async function fetchGooglePlayOrder(configuration, orderId, options = {}) {
  const cleanOrderId = cleanText(orderId, 256);
  if (!cleanOrderId || !ORDER_ID_RE.test(cleanOrderId)) {
    throw stableError("google_play_order_id_invalid", { kind: "data" });
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const token = options.accessToken ?? await googlePlayAccessToken(
    configuration,
    options,
  );
  const url = `${GOOGLE_ORDERS_ORIGIN}/androidpublisher/v3/applications/${
    encodeURIComponent(configuration.packageName)
  }/orders/${encodeURIComponent(cleanOrderId)}`;
  const response = await boundedFetch(
    fetchImpl,
    url,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    },
    Number(options.timeoutMs ?? 10_000),
  );
  if (!response.ok) {
    throw stableError(`google_play_orders_http_${response.status}`, {
      kind: "provider",
      retryable: response.status === 429 || response.status >= 500,
      status: response.status,
    });
  }
  const order = recordOrNull(await boundedJson(response));
  if (!order || cleanText(order.orderId, 256) !== cleanOrderId) {
    throw stableError("google_play_order_response_invalid", { kind: "data" });
  }
  return order;
}

export function googlePlayMoneyToMinor(rawMoney, exponent) {
  const money = recordOrNull(rawMoney);
  const currency = cleanText(money?.currencyCode, 3)?.toUpperCase() ?? null;
  const unitsRaw = typeof money?.units === "string"
    ? money.units.trim()
    : Number.isSafeInteger(money?.units)
    ? String(money.units)
    : "";
  const nanos = Number(money?.nanos ?? 0);
  if (
    !currency ||
    !CURRENCY_RE.test(currency) ||
    !/^-?(?:0|[1-9][0-9]*)$/.test(unitsRaw) ||
    !Number.isInteger(nanos) ||
    nanos < -999_999_999 ||
    nanos > 999_999_999 ||
    !Number.isInteger(exponent) ||
    exponent < 0 ||
    exponent > 6
  ) {
    throw stableError("google_play_money_invalid", { kind: "data" });
  }
  const units = BigInt(unitsRaw);
  if ((units > 0n && nanos < 0) || (units < 0n && nanos > 0)) {
    throw stableError("google_play_money_sign_invalid", { kind: "data" });
  }
  const nanosTotal = units * 1_000_000_000n + BigInt(nanos);
  const scaled = nanosTotal * (10n ** BigInt(exponent));
  if (scaled % 1_000_000_000n !== 0n) {
    throw stableError("google_play_money_not_minor_exact", { kind: "data" });
  }
  const minor = scaled / 1_000_000_000n;
  if (minor < 0n || minor > MAX_SAFE_MINOR) {
    throw stableError("google_play_money_out_of_range", { kind: "data" });
  }
  return { currency, minor: Number(minor) };
}

function selectedFinancialRecord(order, options) {
  const record = recordOrNull(order);
  const orderId = cleanText(options?.orderId, 256);
  const eventType = cleanText(options?.eventType, 32);
  const expectedProductId = cleanText(options?.expectedProductId, 256);
  if (
    !record ||
    !orderId ||
    cleanText(record.orderId, 256) !== orderId ||
    !["capture", "renewal", "refund"].includes(eventType)
  ) {
    throw stableError("google_play_order_response_invalid", { kind: "data" });
  }

  const lineItems = Array.isArray(record.lineItems) ? record.lineItems : [];
  if (
    !expectedProductId ||
    !lineItems.some((item) =>
      cleanText(recordOrNull(item)?.productId, 256) === expectedProductId
    )
  ) {
    throw stableError("google_play_order_product_mismatch", { kind: "data" });
  }

  if (eventType === "capture" || eventType === "renewal") {
    const processed = recordOrNull(
      recordOrNull(record.orderHistory)?.processedEvent,
    );
    const observedAt = validIso(processed?.eventTime);
    if (
      !observedAt ||
      !["PROCESSED", "PENDING_REFUND", "PARTIALLY_REFUNDED", "REFUNDED"]
        .includes(String(record.state ?? ""))
    ) {
      throw stableError("google_play_order_not_processed", { kind: "data" });
    }
    return {
      eventType,
      total: record.total,
      tax: record.tax,
      observedAt,
    };
  }

  const history = recordOrNull(record.orderHistory);
  const fullRefund = recordOrNull(history?.refundEvent);
  if (fullRefund) {
    const details = recordOrNull(fullRefund.refundDetails);
    const observedAt = validIso(fullRefund.eventTime);
    if (
      !details ||
      !observedAt ||
      String(record.state ?? "") !== "REFUNDED"
    ) {
      throw stableError("google_play_full_refund_invalid", { kind: "data" });
    }
    return {
      eventType: String(fullRefund.refundReason ?? "") === "CHARGEBACK"
        ? "chargeback"
        : "refund",
      total: details.total,
      tax: details.tax,
      observedAt,
    };
  }

  const partialRefunds = Array.isArray(history?.partialRefundEvents)
    ? history.partialRefundEvents
      .map(recordOrNull)
      .filter((item) => item?.state === "PROCESSED_SUCCESSFULLY")
    : [];
  if (partialRefunds.length !== 1) {
    throw stableError(
      partialRefunds.length > 1
        ? "google_play_partial_refund_ambiguous"
        : "google_play_refund_not_authoritative",
      { kind: "data" },
    );
  }
  const partial = partialRefunds[0];
  const details = recordOrNull(partial.refundDetails);
  const observedAt = validIso(partial.processTime);
  if (!details || !observedAt || record.state !== "PARTIALLY_REFUNDED") {
    throw stableError("google_play_partial_refund_invalid", { kind: "data" });
  }
  return {
    eventType: "refund",
    total: details.total,
    tax: details.tax,
    observedAt,
  };
}

export function googlePlayOrderFinancialCurrency(order, options) {
  const selected = selectedFinancialRecord(order, options);
  const totalCurrency = cleanText(
    recordOrNull(selected.total)?.currencyCode,
    3,
  )?.toUpperCase() ?? null;
  const taxCurrency = cleanText(
    recordOrNull(selected.tax)?.currencyCode,
    3,
  )?.toUpperCase() ?? null;
  if (
    !totalCurrency ||
    !CURRENCY_RE.test(totalCurrency) ||
    taxCurrency !== totalCurrency
  ) {
    throw stableError("google_play_money_currency_mismatch", { kind: "data" });
  }
  return totalCurrency;
}

export function normalizeGooglePlayOrderFinancials(order, options) {
  const selected = selectedFinancialRecord(order, options);
  const total = googlePlayMoneyToMinor(selected.total, options.currencyExponent);
  const tax = googlePlayMoneyToMinor(selected.tax, options.currencyExponent);
  if (tax.currency !== total.currency || tax.minor > total.minor) {
    throw stableError("google_play_money_currency_mismatch", { kind: "data" });
  }

  return {
    eventType: selected.eventType,
    currency: total.currency,
    currencyExponent: options.currencyExponent,
    // Google Orders defines total as the final amount actually paid after
    // discounts, including tax. The discount is useful context but is not an
    // authoritative top-level component, so it stays null instead of guessed.
    grossMinor: total.minor,
    discountMinor: null,
    taxMinor: tax.minor,
    eligibleMinor: total.minor - tax.minor,
    observedAt: selected.observedAt,
  };
}
