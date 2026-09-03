const RESEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_TIMEOUT_MS = 8_000;

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function retryAfterSeconds(value, nowMs = Date.now()) {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Math.max(0, Math.min(21_600, Number(value.trim())));
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.min(21_600, Math.ceil((at - nowMs) / 1000)));
}

function redactProviderText(value) {
  const text = stringOrNull(value);
  if (!text) return null;
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\b(?:re_|whsec_)[A-Za-z0-9_-]{12,}\b/g, "[credential]")
    .slice(0, 500);
}

export function safeResendProviderResponse(value) {
  const payload = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const safe = {};
  const id = stringOrNull(payload.id);
  const name = redactProviderText(payload.name);
  const message = redactProviderText(payload.message ?? payload.error);
  const statusCode = typeof payload.statusCode === "number" ? payload.statusCode : null;
  if (id) safe.id = id;
  if (name) safe.name = name;
  if (message) safe.message = message;
  if (statusCode !== null) safe.status_code = statusCode;
  return safe;
}

export function buildResendDeliveryRequest(claim, apiKey, signal) {
  return {
    endpoint: RESEND_ENDPOINT,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "Norva-Branded-Email/2.0",
        "Idempotency-Key": claim.delivery_key,
      },
      body: JSON.stringify({
        from: claim.request_from,
        reply_to: claim.request_reply_to,
        to: [claim.recipient_email],
        subject: claim.request_subject,
        html: claim.request_html,
        text: claim.request_text,
        tags: claim.request_tags,
        ...(claim.request_headers && Object.keys(claim.request_headers).length
          ? { headers: claim.request_headers }
          : {}),
      }),
      signal,
    },
  };
}

export async function sendResendDelivery(
  claim,
  {
    apiKey,
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    nowMs = Date.now(),
  } = {},
) {
  try {
    const timeout = Math.max(1, Math.min(30_000, Math.trunc(Number(timeoutMs) || DEFAULT_TIMEOUT_MS)));
    const request = buildResendDeliveryRequest(claim, apiKey ?? "", AbortSignal.timeout(timeout));
    const res = await fetchImpl(request.endpoint, request.init);
    const raw = (await res.text()).slice(0, 4_000);
    let parsed = {};
    try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) { parsed = {}; }
    const response = safeResendProviderResponse(parsed);
    const emailId = stringOrNull(response.id);
    return {
      accepted: res.ok && Boolean(emailId),
      status: res.status,
      emailId,
      response,
      error: res.ok && emailId ? "" : (res.ok ? "resend_missing_id" : `resend_http_${res.status}`),
      retryAfterSeconds: retryAfterSeconds(res.headers.get("retry-after"), nowMs),
    };
  } catch (error) {
    const timeout = error instanceof DOMException && error.name === "TimeoutError";
    return {
      accepted: false,
      status: null,
      emailId: null,
      response: {},
      error: timeout ? "transport_timeout" : "transport_error",
      retryAfterSeconds: null,
    };
  }
}
