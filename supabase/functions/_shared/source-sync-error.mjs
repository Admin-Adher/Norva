// =============================================================================
// source-sync-error.mjs — cloud_sources.sync_error: what we write, how we read it
// =============================================================================
// AUTHORITATIVE copy. Mirrored in public/js/utils/sourceHealth.js for the
// browser, which cannot import from supabase/functions. Behaviour parity is
// locked by tests/source-error-kind-parity.test.js — same fixtures, same
// verdicts. Change one, change both, or that test fails.
//
// WHY THIS FILE EXISTS
// The media gateway collapses every upstream provider failure into one generic
// sentence. The HTTP status and the gateway's response body ARE captured at the
// throw site (HttpError carries {status, message, details}) but used to be
// dropped when persisting, leaving the classifier with nothing but "media
// gateway" to go on — so every provider problem read as `infra`, the one class
// the ops alert does not suppress. Observed 2026-08-21: an ended subscription
// alerted 4x/day forever, while a real outage of OUR gateway was
// indistinguishable from it.
//
// STATUS GOES FIRST. It is the highest-signal token in the whole string and it
// used to sit at the end, where the admin dashboard's 80-char truncation left
// it two characters from being cut. Leading it survives any truncation, by any
// consumer, present or future.
//
// REDACTION IS MANDATORY, NOT DEFENSIVE. Xtream panels are addressed as
// player_api.php?username=...&password=..., so an echoed request URL would land
// verbatim in a column the admin dashboard renders and the source owner reads.
// Note the consequence for AUTH_PATTERN below.
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

  let out = detail ? base + " (" + detail + ")" : base;
  if (status) out = "[" + status + "] " + out;
  return out.slice(0, MAX_SYNC_ERROR_CHARS);
}

// Discovery watchdogs may resume retryable provider/network failures, but a
// permanent client-side refusal must wait for a new user-initiated sync. In
// particular, leaving a 404/401/403 cursor active makes a one-minute watchdog
// hammer the same provider forever. 408/425/429 are explicitly transient.
export function isTerminalSourceSyncStatus(status) {
  return Number.isInteger(status)
    && status >= 400
    && status < 500
    && status !== 408
    && status !== 425
    && status !== 429;
}

// ---------------------------------------------------------------------------
// Classification — ONE order for both surfaces
// ---------------------------------------------------------------------------
// The browser had auth BEFORE expired while ops had expired BEFORE auth, so a
// panel saying "401 subscription expired" got two different verdicts depending
// on who asked. Canonical order is the ops one: the expiry is the CAUSE and the
// 401 only its symptom, and "renew your subscription" is more actionable than
// "check your credentials".
//
// Each pattern is the UNION of what the two copies used to match, so unifying
// loses no detection on either side. Two deliberate exceptions:
//   - bare `username`/`password`/`login` are NOT in AUTH_PATTERN. Redaction
//     rewrites Xtream URLs to `username=***`, which \busername\b matches, and
//     since auth outranks infra a 502 gateway outage echoing the request URL
//     would have been classified `auth` and silently suppressed. The anchored
//     phrases below keep the intent without that interaction.
//   - `paid` is kept even though it is loose, because the browser copy already
//     matched it in production and dropping it would change user-facing state.
const BUSY_PATTERN = /\b(458|user_multi_ip|account[_\s-]*shar|account[_\s-]*busy|already in use|max(?:imum)?[_\s-]*conn|slot[_\s-]*busy)\b/;
const EXPIRED_PATTERN = /\b(expired|expire|inactive|disabled|banned|subscription|renew|unpaid|paid|trial ended)\b/;
const AUTH_PATTERN = /\b(401|403|unauthorized|forbidden|auth|auth[_\s-]*fail|authentication|credential|credentials|invalid user|invalid pass|invalid password|invalid login|bad password|wrong password)\b/;
const INFRA_PATTERN = /\b(media gateway|gateway refused|refused|500|502|503|504|timeout|timed out|econn|enotfound|dns|network|unreachable|service unavailable|temporarily unavailable)\b/;

export function classifyOpsSourceError(text) {
  const error = String(text || "").toLowerCase();
  if (BUSY_PATTERN.test(error)) return "busy";
  if (EXPIRED_PATTERN.test(error)) return "expired";
  if (AUTH_PATTERN.test(error)) return "auth";
  if (INFRA_PATTERN.test(error)) return "infra";
  return "unknown";
}

// The classes norva-admin deliberately does NOT alert on: the source owner has
// to act (renew, fix credentials, close a session), we cannot.
export const SILENT_OPS_SOURCE_ERROR_KINDS = new Set(["expired", "auth", "busy"]);

// Operator-facing labels for the admin dashboard badge, so nobody has to read a
// raw provider string or interpret an HTTP status by hand.
export const OPS_SOURCE_ERROR_LABELS = {
  busy: "Slot occupé",
  expired: "Abonnement terminé",
  auth: "Identifiants rejetés",
  infra: "Panne passerelle",
  unknown: "Erreur non classée",
};
