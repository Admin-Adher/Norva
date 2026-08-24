// Pure, side-effect free interpretation of an Xtream `account_info` payload.
//
// This module deliberately separates observation from policy.  In particular,
// an incoherent provider response is never allowed to become a catalogue-hide
// decision.  PostgreSQL remains the authority that applies the returned state.

export const PROVIDER_ACCESS_DETECTION_VERSION = 1;

const DAY_MS = 86_400_000;
const ACTIVE = new Set(["active", "enabled"]);
const UNAVAILABLE = new Set(["expired", "disabled", "banned"]);

export function extractProviderAccessState(accountInfo, options = {}) {
  const now = normalizeNow(options.now);
  const warningDays = normalizeWarningDays(options.warningDays);
  const account = record(accountInfo?.user_info) ?? record(accountInfo) ?? {};
  const providerStatus = cleanString(account.status)?.toLowerCase() ?? null;
  const authenticated = parseBoolean(account.auth);
  const trial = parseBoolean(account.is_trial);
  const activeConnections = parseNonNegativeInteger(account.active_cons);
  const maxConnections = parseNonNegativeInteger(account.max_connections);
  const expiry = parseXtreamExpiry(account.exp_date);
  const today = utcDateKey(now);
  const warningBoundary = utcDateKey(new Date(now.getTime() + warningDays * DAY_MS));
  const contradictions = [];

  if (expiry.invalid) contradictions.push("INVALID_EXPIRY");
  if (activeConnections.invalid) contradictions.push("INVALID_ACTIVE_CONNECTIONS");
  if (maxConnections.invalid) contradictions.push("INVALID_MAX_CONNECTIONS");
  if (activeConnections.value !== null && maxConnections.value !== null
      && activeConnections.value > maxConnections.value) {
    contradictions.push("ACTIVE_CONNECTIONS_EXCEED_MAXIMUM");
  }
  if (ACTIVE.has(providerStatus) && expiry.dateKey !== null && expiry.dateKey < today) {
    contradictions.push("ACTIVE_WITH_PAST_EXPIRY");
  }
  if (UNAVAILABLE.has(providerStatus) && expiry.dateKey !== null && expiry.dateKey >= today) {
    contradictions.push("UNAVAILABLE_WITH_FUTURE_EXPIRY");
  }
  if (authenticated === true && UNAVAILABLE.has(providerStatus)) {
    contradictions.push("AUTHENTICATED_BUT_UNAVAILABLE");
  }
  if (authenticated === false && ACTIVE.has(providerStatus)) {
    contradictions.push("UNAUTHENTICATED_BUT_ACTIVE");
  }

  const base = {
    detectionVersion: PROVIDER_ACCESS_DETECTION_VERSION,
    providerStatus,
    authenticated,
    isTrial: trial,
    activeConnections: activeConnections.value,
    maxConnections: maxConnections.value,
    expiresOn: expiry.dateKey,
    expirySource: expiry.dateKey === null ? null : "provider_reported",
    contradictions,
  };

  if (contradictions.length > 0) {
    return Object.freeze({
      ...base,
      status: "check_failed_temporary",
      reasonCode: "PROVIDER_RESPONSE_INCONSISTENT",
      hideEligible: false,
      restorationConfirmed: false,
    });
  }

  if (UNAVAILABLE.has(providerStatus) || authenticated === false) {
    const expired = providerStatus === "expired"
      || (expiry.dateKey !== null && expiry.dateKey < today);
    return Object.freeze({
      ...base,
      status: expired ? "expired_confirmed" : "access_unavailable_confirmed",
      reasonCode: expired ? "PROVIDER_CONFIRMED_EXPIRED" : "PROVIDER_CONFIRMED_UNAVAILABLE",
      hideEligible: true,
      restorationConfirmed: false,
    });
  }

  if (ACTIVE.has(providerStatus) || authenticated === true) {
    const status = expiry.dateKey !== null && expiry.dateKey <= warningBoundary
      ? "expiring"
      : "active";
    return Object.freeze({
      ...base,
      status,
      reasonCode: status === "expiring" ? "PROVIDER_EXPIRY_APPROACHING" : "PROVIDER_CONFIRMED_ACTIVE",
      hideEligible: false,
      restorationConfirmed: true,
    });
  }

  if (expiry.dateKey !== null && expiry.dateKey < today) {
    return Object.freeze({
      ...base,
      status: "expected_expired",
      reasonCode: "PROVIDER_DATE_PASSED_UNCONFIRMED",
      hideEligible: false,
      restorationConfirmed: false,
    });
  }

  return Object.freeze({
    ...base,
    status: "unknown",
    reasonCode: expiry.empty ? "PROVIDER_EXPIRY_UNAVAILABLE" : "PROVIDER_STATE_UNKNOWN",
    hideEligible: false,
    restorationConfirmed: false,
  });
}

function parseXtreamExpiry(value) {
  if (value === null || value === undefined || value === "" || value === 0 || value === "0") {
    return { dateKey: null, empty: true, invalid: false };
  }
  const text = String(value).trim();
  if (!/^\d{1,12}$/.test(text)) return { dateKey: null, empty: false, invalid: true };
  const seconds = Number(text);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    return { dateKey: null, empty: false, invalid: true };
  }
  const date = new Date(seconds * 1000);
  const year = date.getUTCFullYear();
  if (!Number.isFinite(date.getTime()) || year < 2000 || year > 2200) {
    return { dateKey: null, empty: false, invalid: true };
  }
  return { dateKey: utcDateKey(date), empty: false, invalid: false };
}

function parseNonNegativeInteger(value) {
  if (value === null || value === undefined || value === "") return { value: null, invalid: false };
  const text = String(value).trim();
  if (!/^\d{1,9}$/.test(text)) return { value: null, invalid: true };
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? { value: parsed, invalid: false } : { value: null, invalid: true };
}

function parseBoolean(value) {
  if ([true, 1, "1", "true"].includes(value)) return true;
  if ([false, 0, "0", "false"].includes(value)) return false;
  return null;
}

function normalizeNow(value) {
  const date = value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("options.now must be a valid date");
  return date;
}

function normalizeWarningDays(value) {
  if (value === undefined) return 7;
  if (!Number.isInteger(value) || value < 0 || value > 90) {
    throw new TypeError("options.warningDays must be an integer between 0 and 90");
  }
  return value;
}

function utcDateKey(date) {
  return date.toISOString().slice(0, 10);
}

function cleanString(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).normalize("NFC").trim();
  return text && text.length <= 120 && !/[\u0000-\u001f\u007f]/u.test(text) ? text : null;
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
