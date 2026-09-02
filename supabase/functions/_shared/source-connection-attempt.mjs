const SOURCE_TYPES = new Set(["m3u", "xtream"]);

export const SOURCE_ATTEMPT_PATH_SHAPES = Object.freeze([
  "root",
  "get.php",
  "player_api.php",
  ".m3u8",
  ".m3u",
  "web_page",
  "other",
  "invalid",
]);

const PATH_SHAPES = new Set(SOURCE_ATTEMPT_PATH_SHAPES);

// A deliberately small, conservative list for the markets Norva currently
// measures. It avoids exposing a provider subdomain while keeping familiar
// registrable roots such as example.co.in and example.com.bd readable.
const MULTI_LABEL_PUBLIC_SUFFIXES = new Set([
  "co.in", "firm.in", "gen.in", "ind.in", "net.in", "org.in",
  "com.bd", "net.bd", "org.bd",
  "com.pk", "net.pk", "org.pk",
  "co.th", "in.th", "or.th",
  "com.vn", "net.vn", "org.vn",
  "co.id", "web.id", "or.id",
  "com.my", "net.my", "org.my",
  "co.ma", "net.ma",
  "com.dz", "org.dz",
  "com.tn", "org.tn",
  "co.uk", "org.uk", "me.uk",
  "com.au", "net.au", "org.au",
  "co.ae", "com.sa",
]);

function parseHttpCandidate(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  try {
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
    const parsed = new URL(candidate);
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isIpv4(hostname) {
  const parts = hostname.split(".");
  return parts.length === 4 && parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const number = Number(part);
    return number >= 0 && number <= 255;
  });
}

function normalizeHostname(hostname) {
  return String(hostname ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

export function normalizeSourceAttemptType(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return SOURCE_TYPES.has(normalized) ? normalized : null;
}

export function normalizeSourceAttemptPathShape(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return PATH_SHAPES.has(normalized) ? normalized : null;
}

export function classifySourceAttemptPath(rawUrl) {
  const parsed = parseHttpCandidate(rawUrl);
  if (!parsed) return "invalid";

  let pathname;
  try {
    pathname = decodeURIComponent(parsed.pathname || "/").toLowerCase().replace(/\/{2,}/g, "/");
  } catch {
    pathname = (parsed.pathname || "/").toLowerCase().replace(/\/{2,}/g, "/");
  }
  const parts = pathname.split("/").filter(Boolean);
  if (!parts.length) return "root";
  if (parts.includes("get.php")) return "get.php";
  if (parts.includes("player_api.php")) return "player_api.php";
  if (pathname.endsWith(".m3u8")) return ".m3u8";
  if (pathname.endsWith(".m3u")) return ".m3u";
  if (/\.(?:html?|xhtml)$/.test(pathname)) return "web_page";
  return "other";
}

export function normalizedSourceAttemptDomain(hostname) {
  const normalized = normalizeHostname(hostname);
  if (!normalized) return null;
  if (isIpv4(normalized) || normalized.includes(":")) return "ip-address";
  if (normalized === "localhost" || normalized.endsWith(".local")) return "local-address";

  const labels = normalized.split(".").filter(Boolean);
  if (labels.length <= 2) return normalized;
  const publicSuffix = labels.slice(-2).join(".");
  return MULTI_LABEL_PUBLIC_SUFFIXES.has(publicSuffix)
    ? labels.slice(-3).join(".")
    : labels.slice(-2).join(".");
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
