import {
  SOURCE_ATTEMPT_PATH_SHAPES, classifySourceAttemptPath,
  normalizedSourceAttemptDomain, normalizeSourceInputHostname as normalizeHostname,
  parseSourceInputUrl as parseHttpCandidate,
} from "./source-input-policy.mjs";
export { SOURCE_ATTEMPT_PATH_SHAPES, classifySourceAttemptPath, normalizedSourceAttemptDomain };

const SOURCE_TYPES = new Set(["m3u", "xtream"]);
const PATH_SHAPES = new Set(SOURCE_ATTEMPT_PATH_SHAPES);

export function normalizeSourceAttemptType(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return SOURCE_TYPES.has(normalized) ? normalized : null;
}

export function normalizeSourceAttemptPathShape(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return PATH_SHAPES.has(normalized) ? normalized : null;
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function summarizeSourceConnectionAttempt({ sourceType, url, inputPathShape } = {}) {
  const normalizedType = normalizeSourceAttemptType(sourceType);
  if (!normalizedType) return null;

  const parsed = parseHttpCandidate(url);
  const hostname = parsed ? normalizeHostname(parsed.hostname) : "";
  const clientShape = normalizeSourceAttemptPathShape(inputPathShape);
  const derivedShape = classifySourceAttemptPath(url);
  // The browser override is needed only after it has deliberately collapsed a
  // full Xtream link to the server root. A non-root server value remains the
  // source of truth, so a caller cannot relabel an observable path shape.
  const pathShape = clientShape && derivedShape === "root" ? clientShape : derivedShape;
  let hostHash = null;
  if (hostname) {
    try {
      hostHash = await sha256Hex(hostname);
    } catch {
      // Telemetry must never prevent a source connection attempt.
    }
  }

  return Object.freeze({
    sourceType: normalizedType,
    domainNormalized: normalizedSourceAttemptDomain(hostname),
    hostHash,
    pathShape,
  });
}

export function sourceAttemptClientContext(userAgent) {
  const value = String(userAgent ?? "").slice(0, 1024);
  const phone = value.match(/NorvaTV-AndroidPhone\/([A-Za-z0-9][A-Za-z0-9._+-]{0,39})/i);
  if (phone) return Object.freeze({ platform: "mobile_android", appVersion: phone[1] });
  const tv = value.match(/NorvaTV-AndroidTV\/([A-Za-z0-9][A-Za-z0-9._+-]{0,39})/i);
  if (tv) return Object.freeze({ platform: "android_tv", appVersion: tv[1] });
  if (/Android/i.test(value)) {
    return Object.freeze({ platform: /\bTV\b|AndroidTV/i.test(value) ? "android_tv" : "mobile_android", appVersion: null });
  }
  if (/Mozilla|Chrome|Safari|Firefox|Edg\//i.test(value)) {
    return Object.freeze({ platform: "web", appVersion: null });
  }
  return Object.freeze({ platform: "unknown", appVersion: null });
}

export function normalizeSourceAttemptCountry(value) {
  const normalized = String(value ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(normalized) ? normalized : null;
}

export function classifySourceAttemptFailure({ status, code, message } = {}) {
  const numericStatus = Number(status);
  const normalizedCode = String(code ?? "").trim().toUpperCase();
  const normalizedMessage = String(message ?? "").trim().toLowerCase();

  if (normalizedCode === "MISSING_CREDENTIALS") return "missing_credentials";
  if (numericStatus === 401 || numericStatus === 403 || /CREDENTIAL|AUTH/.test(normalizedCode)) return "credentials";
  if (numericStatus === 404) return "endpoint_not_found";
  if (numericStatus === 413 || /PAYLOAD_TOO_LARGE|RESPONSE_TOO_LARGE/.test(normalizedCode)) return "payload_too_large";
  if (numericStatus === 408 || numericStatus === 504 || /TIMEOUT|DEADLINE/.test(normalizedCode)) return "timeout";
  if (numericStatus === 458 || /BUSY|MULTI_IP/.test(normalizedCode)) return "provider_busy";
  if (numericStatus === 429) return "rate_limited";
  if (/does not look like a valid m3u|#extm3u/.test(normalizedMessage)) return "playlist_format";
  if (numericStatus === 400 || numericStatus === 422 || normalizedCode === "INVALID_REQUEST") return "invalid_input";
  if (
    numericStatus === 502 || numericStatus === 503 ||
    /DNS|NETWORK|TLS|CONNECTION|REQUEST_FAILED|UNREACHABLE|RESET/.test(normalizedCode)
  ) return "provider_unreachable";
  if (numericStatus >= 500 && numericStatus <= 599) return "infrastructure";
  return "unknown";
}
