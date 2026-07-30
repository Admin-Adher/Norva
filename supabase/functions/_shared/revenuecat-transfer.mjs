import { isKnownStorePlan, resolveRevenueCatPlan } from "./billing-policy.mjs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_ID_RE = /^[^\s\u0000-\u001f\u007f]{8,255}$/u;
const APP_ID_RE = /^[^\s\u0000-\u001f\u007f]{3,128}$/u;
const MAX_IDENTIFIERS = 32;
export const REVENUECAT_WEBHOOK_SIGNATURE_MAX_AGE_SECONDS = 5 * 60;
export const REVENUECAT_TRANSFER_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const TRANSFER_STORES = new Set([
  "AMAZON",
  "APP_STORE",
  "MAC_APP_STORE",
  "PADDLE",
  "PLAY_STORE",
  "RC_BILLING",
  "ROKU",
  "STRIPE",
]);

export class RevenueCatTransferError extends Error {
  constructor(code) {
    super(code);
    this.name = "RevenueCatTransferError";
    this.code = code;
  }
}

function recordOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function textOrNull(value, max = 255) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/u.test(text)) {
    return null;
  }
  return text;
}

export function parseRevenueCatAllowedAppIds(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return new Set();
  }
  if (typeof rawValue !== "string") {
    throw new RevenueCatTransferError("transfer_app_allowlist_invalid");
  }
  const values = rawValue.split(",").map((value) => value.trim());
  if (
    values.length < 1 ||
    values.length > 32 ||
    values.some((value) => !APP_ID_RE.test(value))
  ) {
    throw new RevenueCatTransferError("transfer_app_allowlist_invalid");
  }
  return new Set(values);
}

export function revenueCatEventAppAllowed(rawEvent, allowedAppIds) {
  if (!(allowedAppIds instanceof Set) || allowedAppIds.size === 0) return true;
  const appId = textOrNull(recordOrEmpty(rawEvent).app_id, 128);
  return Boolean(appId && allowedAppIds.has(appId));
}

function identifierList(value, code) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_IDENTIFIERS
  ) {
    throw new RevenueCatTransferError(code);
  }
  const normalized = value.map((entry) => textOrNull(entry));
  if (normalized.some((entry) => !entry)) {
    throw new RevenueCatTransferError(code);
  }
  const identifiers = [...new Set(normalized)].sort();
  // RevenueCat's contract is String[]. Silently dropping malformed values or
  // duplicate aliases would make two different deliveries share a fingerprint.
  if (
    identifiers.length < 1 ||
    identifiers.length > MAX_IDENTIFIERS ||
    identifiers.length !== value.length
  ) throw new RevenueCatTransferError(code);
  return identifiers;
}

function isoMilliseconds(value) {
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) return null;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function isoDate(value) {
  const text = textOrNull(value, 64);
  if (!text) return null;
  const milliseconds = Date.parse(text);
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : null;
}

function futureIso(value, nowMs) {
  const iso = isoDate(value);
  return iso && Date.parse(iso) > nowMs ? iso : null;
}

function providerForStore(store) {
  switch (
    String(store ?? "")
      .trim()
      .toUpperCase()
  ) {
    case "PLAY_STORE":
      return "google_play";
    case "APP_STORE":
    case "MAC_APP_STORE":
      return "apple_app_store";
    case "STRIPE":
      return "stripe";
    case "RC_BILLING":
    case "PADDLE":
      return "web";
    default:
      return "revenuecat";
  }
}

function billPeriod(productId, purchaseDate, expirationDate) {
  const product = String(productId ?? "").toLowerCase();
  if (/(annual|yearly|year|_1y|p1y|yr)/.test(product)) return "annual";
  if (/(month|_1m|p1m|mo)/.test(product)) return "monthly";
  const purchaseMs = Date.parse(String(purchaseDate ?? ""));
  const expirationMs = Date.parse(String(expirationDate ?? ""));
  if (
    Number.isFinite(purchaseMs) &&
    Number.isFinite(expirationMs) &&
    expirationMs > purchaseMs
  ) {
    return (expirationMs - purchaseMs) / 86_400_000 > 300
      ? "annual"
      : "monthly";
  }
  return "monthly";
}

/**
 * Parse the dedicated RevenueCat TRANSFER contract. Anonymous aliases are kept
 * only in fingerprintMaterial so the caller can hash them before persistence.
 */
export function inspectRevenueCatTransferEvidence(
  rawEvent,
  now = new Date(),
) {
  const event = recordOrEmpty(rawEvent);
  const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(nowMs)) {
    throw new RevenueCatTransferError("transfer_invalid_clock");
  }
  const eventId = textOrNull(event.id, 255);
  if (!eventId || !EVENT_ID_RE.test(eventId)) {
    throw new RevenueCatTransferError("transfer_missing_event_id");
  }
  const eventAt = isoMilliseconds(event.event_timestamp_ms);
  if (!eventAt) {
    throw new RevenueCatTransferError("transfer_missing_event_timestamp");
  }
  if (Date.parse(eventAt) > nowMs + REVENUECAT_TRANSFER_MAX_FUTURE_SKEW_MS) {
    throw new RevenueCatTransferError("transfer_event_timestamp_in_future");
  }

  const transferredFrom = identifierList(
    event.transferred_from,
    "transfer_invalid_source_identifiers",
  );
  const transferredTo = identifierList(
    event.transferred_to,
    "transfer_invalid_destination_identifiers",
  );
  const canonicalTargets = transferredTo.filter((value) => UUID_RE.test(value));
  const uniqueTargets = [
    ...new Set(canonicalTargets.map((value) => value.toLowerCase())),
  ];
  const destinationUserId = uniqueTargets.length === 1
    ? uniqueTargets[0]
    : null;
  const sourceUserIds = [
    ...new Set(
      transferredFrom
        .filter((value) => UUID_RE.test(value))
        .map((value) => value.toLowerCase())
        .filter((value) => value !== destinationUserId),
    ),
  ].sort();

  const environmentText = textOrNull(event.environment, 32);
  const environment = environmentText ? environmentText.toUpperCase() : null;
  if (environment && !["PRODUCTION", "SANDBOX"].includes(environment)) {
    throw new RevenueCatTransferError("transfer_invalid_environment");
  }
  const store = textOrNull(event.store, 32)?.toUpperCase() ?? null;
  if (store && !TRANSFER_STORES.has(store)) {
    throw new RevenueCatTransferError("transfer_invalid_store");
  }
  const appId = textOrNull(event.app_id, 128);
  if (event.app_id !== undefined && (!appId || !APP_ID_RE.test(appId))) {
    throw new RevenueCatTransferError("transfer_invalid_app_id");
  }

  return {
    eventId,
    eventAt,
    destinationUserId,
    sourceUserIds,
    sourceIdentifierCount: transferredFrom.length,
    destinationIdentifierCount: transferredTo.length,
    environment,
    store,
    appId,
    fingerprintMaterial: JSON.stringify({
      version: 2,
      event_id: eventId,
      event_at: eventAt,
      app_id: appId,
      transferred_from: transferredFrom,
      transferred_to: transferredTo,
      environment,
      store,
    }),
  };
}

export function parseRevenueCatTransferEvent(rawEvent, now = new Date()) {
  const evidence = inspectRevenueCatTransferEvidence(rawEvent, now);
  if (!evidence.destinationUserId) {
    throw new RevenueCatTransferError("transfer_destination_not_unique");
  }
  return evidence;
}

function entitlementConfirmsProduct(entitlements, productId, nowMs) {
  return Object.values(entitlements).some((rawEntitlement) => {
    const entitlement = recordOrEmpty(rawEntitlement);
    if (textOrNull(entitlement.product_identifier) !== productId) return false;
    return Boolean(
      futureIso(entitlement.expires_date, nowMs) ||
        futureIso(entitlement.grace_period_expires_date, nowMs),
    );
  });
}

/**
 * Turn a freshly fetched RevenueCat v1 CustomerInfo response into the only
 * entitlement patch that may be applied for a transfer. The function rejects
 * expired, unentitled, cross-environment and mixed-tier customer states.
 */
export function resolveRevenueCatTransferAuthority(
  rawCustomerInfo,
  transfer,
  productMap,
  now = new Date(),
) {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new RevenueCatTransferError("transfer_invalid_clock");
  }
  const root = recordOrEmpty(rawCustomerInfo);
  const requestMs = Number(root.request_date_ms);
  if (
    !Number.isSafeInteger(requestMs) ||
    Math.abs(nowMs - requestMs) > 10 * 60 * 1000
  ) {
    throw new RevenueCatTransferError("transfer_stale_authority_response");
  }
  const subscriber = recordOrEmpty(root.subscriber);
  const subscriptions = recordOrEmpty(subscriber.subscriptions);
  const entitlements = recordOrEmpty(subscriber.entitlements);
  const candidates = [];

  for (const [rawProductId, rawSubscription] of Object.entries(subscriptions)) {
    const productId = textOrNull(rawProductId);
    const subscription = recordOrEmpty(rawSubscription);
    if (!productId || textOrNull(subscription.refunded_at, 64)) continue;

    const expiration = futureIso(subscription.expires_date, nowMs);
    const graceExpiration = futureIso(
      subscription.grace_period_expires_date,
      nowMs,
    );
    if (!expiration && !graceExpiration) continue;
    if (!entitlementConfirmsProduct(entitlements, productId, nowMs)) continue;

    if (typeof subscription.is_sandbox !== "boolean") continue;
    const isSandbox = subscription.is_sandbox;
    if (
      (transfer.environment === "PRODUCTION" && isSandbox) ||
      (transfer.environment === "SANDBOX" && !isSandbox)
    ) {
      continue;
    }
    const store = textOrNull(subscription.store, 32)?.toUpperCase() ?? null;
    if (!store || !TRANSFER_STORES.has(store)) continue;
    if (transfer.store && transfer.store !== store) continue;

    const plan = resolveRevenueCatPlan({ product_id: productId }, productMap);
    if (!isKnownStorePlan(plan.planCode)) continue;
    const periodType = String(subscription.period_type ?? "")
      .trim()
      .toUpperCase();
    const billingIssue = Boolean(
      textOrNull(subscription.billing_issues_detected_at, 64),
    );
    const unsubscribed = Boolean(
      textOrNull(subscription.unsubscribe_detected_at, 64),
    );
    const status = billingIssue
      ? "past_due"
      : periodType === "TRIAL"
      ? "trialing"
      : unsubscribed
      ? "cancelled_at_period_end"
      : "active";
    const currentPeriodEnd = expiration ?? graceExpiration;
    candidates.push({
      productId,
      planCode: plan.planCode,
      planMapping: plan.mapping,
      status,
      store,
      provider: providerForStore(store),
      environment: isSandbox ? "SANDBOX" : "PRODUCTION",
      currentPeriodEnd,
      graceExpiration,
      purchaseDate: isoDate(subscription.purchase_date),
      isSandbox,
      periodType,
    });
  }

  if (!candidates.length) {
    throw new RevenueCatTransferError("transfer_no_active_entitlement");
  }
  const plans = [...new Set(candidates.map((candidate) => candidate.planCode))];
  if (plans.length !== 1) {
    throw new RevenueCatTransferError("transfer_ambiguous_active_plan");
  }
  const environments = [
    ...new Set(candidates.map((candidate) => candidate.environment)),
  ];
  if (environments.length !== 1) {
    throw new RevenueCatTransferError("transfer_ambiguous_environment");
  }
  const stores = [...new Set(candidates.map((candidate) => candidate.store))];
  if (stores.length !== 1) {
    throw new RevenueCatTransferError("transfer_ambiguous_store");
  }
  const statuses = [
    ...new Set(candidates.map((candidate) => candidate.status)),
  ];
  if (statuses.length !== 1) {
    throw new RevenueCatTransferError("transfer_ambiguous_active_status");
  }
  candidates.sort((left, right) => {
    const time = Date.parse(right.currentPeriodEnd) -
      Date.parse(left.currentPeriodEnd);
    return time || left.productId.localeCompare(right.productId);
  });
  const selected = candidates[0];
  const lastVerifiedAt = now.toISOString();
  const patch = {
    user_id: transfer.destinationUserId,
    provider: selected.provider,
    provider_customer_id: transfer.destinationUserId,
    plan_code: selected.planCode,
    status: selected.status,
    limits: {},
    current_period_end: selected.currentPeriodEnd,
    last_verified_at: lastVerifiedAt,
    last_event_at: transfer.eventAt,
    fail_open_until: selected.status === "past_due"
      ? (selected.graceExpiration ?? selected.currentPeriodEnd)
      : null,
    // CustomerInfo proves the product and access state, not the transaction
    // amount/currency. Clear any stale destination commercial amount instead
    // of carrying it across an account merge.
    mrr_cents: null,
    billing_currency: null,
    billing_product_id: selected.productId,
    billing_package_id: null,
    bill_period: billPeriod(
      selected.productId,
      selected.purchaseDate,
      selected.currentPeriodEnd,
    ),
    billing_terms_source: "revenuecat_transfer_refetch",
  };
  if (selected.status === "trialing") {
    patch.trial_ends_at = selected.currentPeriodEnd;
    patch.trial_consumed_at = selected.purchaseDate ?? lastVerifiedAt;
  }

  return {
    patch,
    planMapping: selected.planMapping,
    selectedProductId: selected.productId,
    resolvedEnvironment: selected.environment,
    resolvedStore: selected.store,
    authorityFingerprintMaterial: JSON.stringify({
      version: 1,
      destination_user_id: transfer.destinationUserId,
      product_id: selected.productId,
      plan_code: selected.planCode,
      status: selected.status,
      store: selected.store,
      environment: selected.environment,
      current_period_end: selected.currentPeriodEnd,
      grace_period_end: selected.graceExpiration,
      sandbox: selected.isSandbox,
      authority_request_at: new Date(requestMs).toISOString(),
    }),
  };
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(value)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqualText(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const length = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

/**
 * RevenueCat signs `${timestamp}.${rawBody}` with HMAC-SHA256. Verification must
 * happen before JSON parsing so the exact delivered bytes remain authoritative.
 */
export async function verifyRevenueCatWebhookSignature({
  rawBody,
  signatureHeader,
  secret,
  now = new Date(),
}) {
  if (
    typeof rawBody !== "string" ||
    typeof signatureHeader !== "string" ||
    typeof secret !== "string" ||
    !secret
  ) return false;
  const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(nowMs)) return false;

  let timestamp = null;
  const signatures = [];
  for (const component of signatureHeader.split(",")) {
    const [rawKey, ...rawValue] = component.trim().split("=");
    const key = rawKey?.trim().toLowerCase();
    const value = rawValue.join("=").trim().toLowerCase();
    if (key === "t" && /^\d{10,13}$/.test(value)) {
      timestamp = Number(value);
    } else if (key === "v1" && /^[0-9a-f]{64}$/.test(value)) {
      signatures.push(value);
    }
  }
  if (!Number.isSafeInteger(timestamp) || !signatures.length) return false;
  const timestampSeconds = timestamp > 9_999_999_999
    ? Math.floor(timestamp / 1000)
    : timestamp;
  if (
    Math.abs(Math.floor(nowMs / 1000) - timestampSeconds) >
      REVENUECAT_WEBHOOK_SIGNATURE_MAX_AGE_SECONDS
  ) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`),
  );
  const expected = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return signatures.some((signature) =>
    timingSafeEqualText(signature, expected)
  );
}

export function revenueCatTransferEvidenceFromStored(rawRow) {
  const row = recordOrEmpty(rawRow);
  const eventId = textOrNull(row.event_id, 255);
  const eventAt = isoDate(row.event_at);
  const destinationUserId = textOrNull(row.destination_user_id, 64);
  const sourceUserIds = Array.isArray(row.source_user_ids)
    ? row.source_user_ids.map((value) => textOrNull(value, 64))
    : null;
  const sourceIdentifierCount = Number(row.source_identifier_count);
  const destinationIdentifierCount = Number(row.destination_identifier_count);
  const environmentText = textOrNull(row.environment, 32);
  const environment = environmentText?.toUpperCase() ?? null;
  const store = textOrNull(row.store, 32)?.toUpperCase() ?? null;
  if (
    !eventId ||
    !EVENT_ID_RE.test(eventId) ||
    !eventAt ||
    !destinationUserId ||
    !UUID_RE.test(destinationUserId) ||
    !sourceUserIds ||
    sourceUserIds.some((value) => !value || !UUID_RE.test(value)) ||
    !Number.isInteger(sourceIdentifierCount) ||
    sourceIdentifierCount < 1 ||
    sourceIdentifierCount > MAX_IDENTIFIERS ||
    !Number.isInteger(destinationIdentifierCount) ||
    destinationIdentifierCount < 1 ||
    destinationIdentifierCount > MAX_IDENTIFIERS ||
    (environment && !["PRODUCTION", "SANDBOX"].includes(environment)) ||
    (store && !TRANSFER_STORES.has(store))
  ) {
    throw new RevenueCatTransferError("transfer_stored_evidence_invalid");
  }
  return {
    eventId,
    eventAt,
    destinationUserId: destinationUserId.toLowerCase(),
    sourceUserIds: [
      ...new Set(sourceUserIds.map((value) => value.toLowerCase())),
    ].sort(),
    sourceIdentifierCount,
    destinationIdentifierCount,
    environment,
    store,
  };
}

export function minimizedRevenueCatTransferPayload(transfer, result) {
  return {
    source_identifier_count: transfer.sourceIdentifierCount,
    destination_identifier_count: transfer.destinationIdentifierCount,
    canonical_source_count: transfer.sourceUserIds.length,
    environment: String(
      result.resolvedEnvironment ?? transfer.environment ?? "unknown",
    ).toLowerCase(),
    store:
      String(result.resolvedStore ?? transfer.store ?? "")?.toLowerCase() ||
      null,
    _norva: {
      projection_applied: result.applied === true,
      disposition: String(result.disposition ?? "unknown"),
      source_projections_expired: Number(result.sourceExpiredCount ?? 0),
      authority: "revenuecat_customer_info_refetch",
    },
  };
}
