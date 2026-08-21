// =============================================================================
// source-sync-error.mjs — persistable text for cloud_sources.sync_error
// =============================================================================
// The media gateway collapses every upstream provider failure into one generic
// sentence ("Media gateway refused the metadata request"). The HTTP status and
// the gateway's response body ARE captured at the throw site (HttpError carries
// {status, message, details}) but were dropped when persisting, which left
// norva-admin's classifyOpsSourceError() with nothing but "media gateway" to go
// on. It therefore classified EVERY provider problem as `infra` — the one class
// the ops alert does not suppress. Consequences observed 2026-08-21:
//   • an expired provider subscription alerted 4x/day forever, and
//   • a real outage of OUR gateway was indistinguishable from that expiry.
//
// Keeping the status plus a bounded, credential-redacted snippet restores the
// distinction the alert exists to make:
//   403 + "subscription expired"  -> classifier says `expired` -> stays silent
//   502 from our own gateway      -> classifier says `infra`   -> alerts
//
// Redaction is mandatory, not defensive: Xtream panels are addressed as
// `player_api.php?username=...&password=...`, so an echoed request URL would
// otherwise land verbatim in a column the admin dashboard renders and the
// source owner can read.
// =============================================================================

export const MAX_SYNC_ERROR_DETAIL_CHARS = 180;
export const MAX_SYNC_ERROR_CHARS = 300;

const CREDENTIAL_URL = /\b(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi;
const CREDENTIAL_QUERY = /([?&](?:username|user|password|pass|pwd|token|key|api_key)=)[^&\s"'}]*/gi;
const CREDENTIAL_JSON = /("(?:username|user|password|pass|pwd|token|key|api_key)"\s*:\s*")[^"]*/gi;

// Ordered: the userinfo form is rewritten first so the query pass cannot be
// confused by a `user:pass@` prefix that also carries a query string.
export function redactSyncErrorText(value) {
  return String(value ?? "")
    .replace(CREDENTIAL_URL, "$1***:***@")
    .replace(CREDENTIAL_QUERY, "$1***")
    .replace(CREDENTIAL_JSON, "$1***");
}

const DETAIL_KEYS = ["error", "message", "detail", "reason", "error_description", "description"];

function detailText(details) {
  if (details === null || details === undefined) return "";
  if (typeof details === "string") return details;
  if (typeof details === "number" || typeof details === "boolean") return String(details);
  if (typeof details !== "object") return "";
  // Prefer the field a panel actually explains itself in over dumping the blob.
  for (const key of DETAIL_KEYS) {
    const candidate = details[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate;
    if (typeof candidate === "number" && Number.isFinite(candidate)) return String(candidate);
  }
  try {
    return JSON.stringify(details);
  } catch (_) {
    return "";
  }
}

function collapse(value) {
  return String(value ?? "").replace(/[\s\u0000-\u001f]+/g, " ").trim();
}

// error is duck-typed on {message, status, details}: the three edge functions
// each declare their own structurally identical HttpError class.
export function formatSourceSyncError(error, fallback = "Source sync failed") {
  const rawBase = error instanceof Error && typeof error.message === "string" && error.message.trim()
    ? error.message
    : fallback;
  const base = collapse(redactSyncErrorText(rawBase)) || "Source sync failed";

  const rawStatus = error && typeof error === "object" ? error.status : null;
  const status = Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : null;

  const rawDetails = error && typeof error === "object" ? error.details : null;
  let detail = collapse(redactSyncErrorText(detailText(rawDetails))).slice(0, MAX_SYNC_ERROR_DETAIL_CHARS);
  if (detail === base) detail = "";

  let out = base;
  if (status && detail) out = base + " (" + status + ": " + detail + ")";
  else if (status) out = base + " (" + status + ")";
  else if (detail) out = base + " (" + detail + ")";
  return out.slice(0, MAX_SYNC_ERROR_CHARS);
}

// Consumer side of the same contract, moved here from norva-admin so the two
// halves are tested together: norva-admin suppresses `expired`/`auth`/`busy`
// (user-side conditions the owner must fix) and alerts on `infra`/`unknown`.
// Ordering matters — a panel that says "account busy, subscription expired"
// is a busy slot first.
export function classifyOpsSourceError(text) {
  const error = String(text || "").toLowerCase();
  if (/\b(458|user_multi_ip|account[_\s-]*shar|account[_\s-]*busy|already in use|max(?:imum)?[_\s-]*conn|slot[_\s-]*busy)\b/.test(error)) {
    return "busy";
  }
  if (/\b(expired|expire|inactive|disabled|banned|subscription|renew|unpaid|trial ended)\b/.test(error)) {
    return "expired";
  }
  if (/\b(401|403|unauthorized|forbidden|credential|invalid user|invalid pass|auth[_\s-]*fail)\b/.test(error)) {
    return "auth";
  }
  if (/\b(media gateway|gateway refused|502|503|504|timeout|timed out|econn|unreachable)\b/.test(error)) {
    return "infra";
  }
  return "unknown";
}

// The classes norva-admin deliberately does NOT alert on: the source owner has
// to act (renew, fix credentials, close a session), we cannot.
export const SILENT_OPS_SOURCE_ERROR_KINDS = new Set(["expired", "auth", "busy"]);
