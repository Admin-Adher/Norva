// Shared, fail-closed adapter for immutable Norva Partners financial facts.
//
// Provider identifiers are hashed before they cross the public RPC boundary.
// Provider payloads and transport timestamps are never persisted here. A fact
// is complete only when the database can prove every monetary component; this
// module deliberately keeps unknown currency exponents, tax, discount and
// eligible/net amounts as null.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURRENCY_RE = /^[A-Z]{3}$/;
const RAILS = new Set(["web", "google_play", "revenuecat"]);
const EVENT_TYPES = new Set([
  "capture",
  "renewal",
  "refund",
  "chargeback",
  "transfer",
]);
const ENVIRONMENTS = new Set(["production", "sandbox"]);

function textOrNull(value, max = 512) {
  if (typeof value !== "string") return null;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return clean && clean.length <= max ? clean : null;
}

function nonNegativeSafeIntegerOrNull(value) {
  if (value == null || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function boundedIntegerOrNull(value, min, max) {
  if (value == null || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) && number >= min && number <= max
    ? number
    : null;
}

function currencyOrNull(value) {
  const currency = textOrNull(value, 3)?.toUpperCase() ?? null;
  return currency && CURRENCY_RE.test(currency) ? currency : null;
}

function isoOrNow(value, now = new Date()) {
  const raw = textOrNull(value, 80);
  const millis = raw ? new Date(raw).getTime() : Number.NaN;
  return Number.isFinite(millis)
    ? new Date(millis).toISOString()
    : now.toISOString();
}

function isoOrNull(value) {
  const raw = textOrNull(value, 80);
  const millis = raw ? new Date(raw).getTime() : Number.NaN;
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

export function revolutWebhookSignatureMatches(signatureHeader, expected) {
  if (
    typeof signatureHeader !== "string" ||
    signatureHeader.length === 0 ||
    signatureHeader.length > 4096 ||
    typeof expected !== "string" ||
    !/^v1=[0-9a-f]{64}$/.test(expected)
  ) {
    return false;
  }

  // Revolut separates signatures with commas during secret rotation. Accepting
  // ASCII whitespace as an additional delimiter keeps older single-secret
  // deliveries compatible without weakening exact signature comparison.
  const candidates = signatureHeader.split(/[,\s]+/).filter(Boolean);
  let matched = 0;
  for (const candidate of candidates) {
    let mismatch = candidate.length ^ expected.length;
    for (let index = 0; index < expected.length; index += 1) {
      mismatch |= (candidate.charCodeAt(index) || 0) ^
        expected.charCodeAt(index);
    }
    matched |= mismatch === 0 ? 1 : 0;
  }
  return matched === 1;
}

function millisecondsIsoOrNull(value) {
  const millis = typeof value === "number" ? value : Number(value);
  return Number.isFinite(millis) && millis > 0
    ? new Date(millis).toISOString()
    : null;
}

function recordOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function unwrapRpcJson(value) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function bytesForDigest(value) {
  const bytes = new TextEncoder().encode(value);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytesForDigest(String(value)),
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export function revenueCatEnvironment(raw) {
  return String(raw ?? "").trim().toUpperCase() === "SANDBOX"
    ? "sandbox"
    : "production";
}

export function revolutEnvironment(apiBase) {
  return String(apiBase ?? "").toLowerCase().includes("sandbox")
    ? "sandbox"
    : "production";
}

export function revenueCatPartnerObservation(
  eventType,
  rawEvent,
  referredUserId,
  now = new Date(),
) {
  const event = recordOrEmpty(rawEvent);
  const type = String(eventType ?? "").trim().toUpperCase();
  let financialEventType = null;

  if (type === "INITIAL_PURCHASE" || type === "NON_RENEWING_PURCHASE") {
    financialEventType = "capture";
  } else if (type === "RENEWAL") financialEventType = "renewal";
  else if (
    type === "CANCELLATION" &&
    String(event.cancel_reason ?? "").trim().toUpperCase() ===
      "CUSTOMER_SUPPORT"
  ) financialEventType = "refund";
  else if (type === "TRANSFER" || type === "PURCHASE_REDEEMED") {
    financialEventType = "transfer";
  } else return null;

  const transactionId = financialEventType === "transfer"
    ? textOrNull(event.id)
    : financialEventType === "refund"
    ? textOrNull(event.id)
    : textOrNull(event.transaction_id);
  if (!transactionId) throw new Error("partners_fact_missing_transaction");

  // RevenueCat TRANSFER belongs to its own field group: it has the stable
  // webhook `id` and transferred_from/transferred_to arrays, but deliberately
  // no transaction_id/original_transaction_id. Persist it quarantined without
  // manufacturing a parent financial transaction.
  const parentTransactionId = financialEventType === "refund"
    ? textOrNull(event.transaction_id)
    : null;
  if (financialEventType === "refund" && !parentTransactionId) {
    throw new Error("partners_fact_missing_parent");
  }
  const store = String(event.store ?? "").trim().toUpperCase();
  const observedAt = millisecondsIsoOrNull(event.event_timestamp_ms) ??
    millisecondsIsoOrNull(event.purchased_at_ms) ??
    now.toISOString();

  return buildPartnerFinancialObservation({
    referredUserId,
    rail: store === "PLAY_STORE" ? "google_play" : "revenuecat",
    eventType: financialEventType,
    environment: revenueCatEnvironment(
      event.environment ?? event.purchase_environment,
    ),
    transactionId,
    parentTransactionId,
    currency: currencyOrNull(event.currency),
    // RevenueCat reports decimal major-unit prices. Without authoritative ISO
    // exponent + tax/discount components, converting them to minor units would
    // manufacture a commission base. Persist the observation as incomplete.
    currencyExponent: null,
    grossMinor: null,
    discountMinor: null,
    taxMinor: null,
    eligibleMinor: null,
    observedAt,
  });
}

export function revolutPartnerObservation(input, now = new Date()) {
  const order = recordOrEmpty(input?.order);
  const remoteState = String(order.state ?? input?.remoteState ?? "").trim()
    .toUpperCase();
  if (remoteState !== "COMPLETED") return null;

  const orderType = String(order.type ?? input?.orderType ?? "").trim()
    .toLowerCase();
  const kind = String(input?.kind ?? "").trim().toLowerCase();
  let financialEventType = null;
  if (orderType === "refund") financialEventType = "refund";
  else if (orderType === "chargeback") financialEventType = "chargeback";
  else if (kind === "renewal") financialEventType = "renewal";
  else if (kind === "first_charge" || kind === "resubscribe") {
    financialEventType = "capture";
  } else return null;

  const transactionId = textOrNull(order.id) ??
    textOrNull(input?.transactionId);
  if (!transactionId) return null;

  return buildPartnerFinancialObservation({
    referredUserId: input?.referredUserId,
    rail: "web",
    eventType: financialEventType,
    environment: ENVIRONMENTS.has(input?.environment)
      ? input.environment
      : "production",
    transactionId,
    parentTransactionId: textOrNull(order.related_order_id) ??
      textOrNull(input?.parentTransactionId),
    currency: currencyOrNull(order.currency ?? input?.currency),
    // Revolut's order amount is explicitly expressed in minor units. Tax,
    // discounts and the eligible base are not explicit in the order contract,
    // so they remain null and the database blocks commission creation.
    currencyExponent: null,
    grossMinor: nonNegativeSafeIntegerOrNull(order.amount ?? input?.grossMinor),
    discountMinor: null,
    taxMinor: null,
    eligibleMinor: null,
    observedAt: isoOrNow(
      order.updated_at ?? order.created_at ?? input?.observedAt,
      now,
    ),
  });
}

export function revolutDisputePartnerObservation(input, now = new Date()) {
  const dispute = recordOrEmpty(input?.dispute);
  const payment = recordOrEmpty(dispute.payment);
  const state = String(dispute.state ?? "").trim().toUpperCase();
  if (state !== "LOST") return null;

  const transactionId = textOrNull(dispute.id);
  const parentTransactionId = textOrNull(payment.order_id);
  const amount = nonNegativeSafeIntegerOrNull(dispute.amount);
  const currency = currencyOrNull(dispute.currency);
  const paymentCurrency = currencyOrNull(payment.currency);
  if (!transactionId) throw new Error("partners_dispute_missing_id");
  if (!parentTransactionId) {
    throw new Error("partners_dispute_missing_parent_order");
  }
  if (amount == null || amount <= 0) {
    throw new Error("partners_dispute_invalid_amount");
  }
  if (!currency || (paymentCurrency && paymentCurrency !== currency)) {
    throw new Error("partners_dispute_currency_mismatch");
  }

  return buildPartnerFinancialObservation({
    referredUserId: input?.referredUserId,
    rail: "web",
    eventType: "chargeback",
    // The Revolut Disputes API is production-only. Keep the explicit argument
    // validation so a future sandbox fixture can never become commissionable.
    environment: ENVIRONMENTS.has(input?.environment)
      ? input.environment
      : "production",
    transactionId,
    parentTransactionId,
    currency,
    currencyExponent: null,
    grossMinor: amount,
    discountMinor: null,
    taxMinor: null,
    eligibleMinor: null,
    observedAt: isoOrNow(dispute.updated_at ?? dispute.created_at, now),
  });
}

export function revolutDisputeWonPartnerObservation(input, now = new Date()) {
  const dispute = recordOrEmpty(input?.dispute);
  const payment = recordOrEmpty(dispute.payment);
  const state = String(dispute.state ?? "").trim().toUpperCase();
  if (state !== "WON") return null;

  const disputeId = textOrNull(dispute.id);
  const parentOrderId = textOrNull(payment.order_id);
  const amount = nonNegativeSafeIntegerOrNull(dispute.amount);
  const currency = currencyOrNull(dispute.currency);
  const paymentCurrency = currencyOrNull(payment.currency);
  const observedAt = isoOrNull(dispute.updated_at ?? dispute.created_at);
  if (!disputeId) throw new Error("partners_dispute_won_missing_id");
  if (!parentOrderId) {
    throw new Error("partners_dispute_won_missing_parent_order");
  }
  if (amount == null || amount <= 0) {
    throw new Error("partners_dispute_won_invalid_amount");
  }
  if (!currency || (paymentCurrency && paymentCurrency !== currency)) {
    throw new Error("partners_dispute_won_currency_mismatch");
  }
  if (!observedAt) {
    throw new Error("partners_dispute_won_invalid_observed_at");
  }

  const referredUserId = textOrNull(input?.referredUserId, 36);
  if (!referredUserId || !UUID_RE.test(referredUserId)) {
    throw new Error("partners_fact_invalid_user");
  }
  const environment = ENVIRONMENTS.has(input?.environment)
    ? input.environment
    : "production";
  if (environment !== "production") {
    throw new Error("partners_dispute_won_invalid_environment");
  }

  return {
    referredUserId,
    rail: "web",
    eventType: "chargeback_reversal",
    environment,
    transactionId: disputeId,
    parentTransactionId: parentOrderId,
    currency,
    grossMinor: amount,
    observedAt,
  };
}

export async function partnerChargebackReversalRpcArgs(observation) {
  const referredUserId = textOrNull(observation?.referredUserId, 36);
  const disputeId = textOrNull(observation?.transactionId);
  const parentOrderId = textOrNull(observation?.parentTransactionId);
  const currency = currencyOrNull(observation?.currency);
  const grossMinor = nonNegativeSafeIntegerOrNull(observation?.grossMinor);
  const observedAt = textOrNull(observation?.observedAt, 80);
  if (
    observation?.rail !== "web" ||
    observation?.eventType !== "chargeback_reversal" ||
    observation?.environment !== "production" ||
    !referredUserId ||
    !UUID_RE.test(referredUserId) ||
    !disputeId ||
    !parentOrderId ||
    !currency ||
    grossMinor == null ||
    grossMinor <= 0 ||
    !observedAt ||
    !Number.isFinite(new Date(observedAt).getTime())
  ) {
    throw new Error("partners_chargeback_reversal_invalid_envelope");
  }

  const disputeHash = await sha256Hex(disputeId);
  const parentOrderHash = await sha256Hex(parentOrderId);
  const sourceIdentity = [
    "billing:economic:v1",
    "production",
    "web",
    "chargeback_reversal",
    disputeHash,
  ].join(":");
  const payload = JSON.stringify({
    schema_version: 1,
    referred_user_id: referredUserId,
    rail: "web",
    event_type: "chargeback_reversal",
    environment: "production",
    dispute_hash: disputeHash,
    parent_order_hash: parentOrderHash,
    currency,
    gross_minor: grossMinor,
  });

  return {
    p_source_event_hash: await sha256Hex(sourceIdentity),
    p_payload_hash: await sha256Hex(payload),
    p_dispute_hash: disputeHash,
    p_parent_order_hash: parentOrderHash,
    p_referred_user_id: referredUserId,
    p_currency: currency,
    p_gross_minor: grossMinor,
    p_observed_at: new Date(observedAt).toISOString(),
  };
}

export async function enqueuePartnerChargebackReversal(db, observation) {
  const args = await partnerChargebackReversalRpcArgs(observation);
  const { data, error } = await db.rpc(
    "partners_worker_revolut_dispute_won_enqueue",
    args,
  );
  if (error) {
    const code = textOrNull(error.code, 16) ?? "unknown";
    throw new Error(`partners_chargeback_reversal_enqueue_failed:${code}`);
  }

  const result = unwrapRpcJson(data);
  const job = recordOrEmpty(result?.job);
  if (
    Number(result?.schema_version) !== 1 ||
    result?.action !== "chargeback_reversal_queued" ||
    typeof result?.replayed !== "boolean" ||
    typeof result?.conflict !== "boolean" ||
    !/^crw_[0-9a-f]{24}$/.test(String(job.key ?? "")) ||
    !["pending", "leased", "retry", "succeeded", "dead_letter"].includes(
      String(job.status ?? ""),
    )
  ) {
    throw new Error("partners_chargeback_reversal_enqueue_invalid_response");
  }
  if (result.conflict === true) {
    console.error("[partners-finance] dispute-won conflict quarantined", {
      rail: "web",
      event_type: "chargeback_reversal",
    });
  }
  return result;
}

export function buildPartnerFinancialObservation(input) {
  const referredUserId = textOrNull(input?.referredUserId, 36);
  const rail = textOrNull(input?.rail, 32);
  const eventType = textOrNull(input?.eventType, 32);
  const environment = textOrNull(input?.environment, 16);
  const transactionId = textOrNull(input?.transactionId);
  const parentTransactionId = textOrNull(input?.parentTransactionId);
  const observedAt = textOrNull(input?.observedAt, 80);

  if (!referredUserId || !UUID_RE.test(referredUserId)) {
    throw new Error("partners_fact_invalid_user");
  }
  if (!rail || !RAILS.has(rail)) throw new Error("partners_fact_invalid_rail");
  if (!eventType || !EVENT_TYPES.has(eventType)) {
    throw new Error("partners_fact_invalid_event");
  }
  if (!environment || !ENVIRONMENTS.has(environment)) {
    throw new Error("partners_fact_invalid_environment");
  }
  if (!transactionId) throw new Error("partners_fact_missing_transaction");
  if (!observedAt || !Number.isFinite(new Date(observedAt).getTime())) {
    throw new Error("partners_fact_invalid_observed_at");
  }

  return {
    referredUserId,
    rail,
    eventType,
    environment,
    transactionId,
    parentTransactionId,
    currency: currencyOrNull(input?.currency),
    currencyExponent: boundedIntegerOrNull(input?.currencyExponent, 0, 6),
    grossMinor: nonNegativeSafeIntegerOrNull(input?.grossMinor),
    discountMinor: nonNegativeSafeIntegerOrNull(input?.discountMinor),
    taxMinor: nonNegativeSafeIntegerOrNull(input?.taxMinor),
    eligibleMinor: nonNegativeSafeIntegerOrNull(input?.eligibleMinor),
    observedAt: new Date(observedAt).toISOString(),
  };
}

export function canonicalPartnerFactPayload(observation) {
  return JSON.stringify({
    schema_version: 1,
    referred_user_id: observation.referredUserId,
    rail: observation.rail,
    event_type: observation.eventType,
    environment: observation.environment,
    transaction_id_hash_input_version: 1,
    parent_transaction_id_present: Boolean(observation.parentTransactionId),
    currency: observation.currency,
    currency_exponent: observation.currencyExponent,
    gross_minor: observation.grossMinor,
    discount_minor: observation.discountMinor,
    tax_minor: observation.taxMinor,
    eligible_minor: observation.eligibleMinor,
  });
}

export async function partnerFinancialFactRpcArgs(observation) {
  const transactionHash = await sha256Hex(observation.transactionId);
  const parentTransactionHash = observation.parentTransactionId
    ? await sha256Hex(observation.parentTransactionId)
    : null;
  const sourceIdentity = [
    "billing:economic:v1",
    observation.environment,
    observation.rail,
    observation.eventType,
    transactionHash,
  ].join(":");
  const payload = JSON.stringify({
    ...JSON.parse(canonicalPartnerFactPayload(observation)),
    transaction_hash: transactionHash,
    parent_transaction_hash: parentTransactionHash,
  });

  return {
    p_source_event_hash: await sha256Hex(sourceIdentity),
    p_payload_hash: await sha256Hex(payload),
    p_transaction_hash: transactionHash,
    p_parent_transaction_hash: parentTransactionHash,
    p_referred_user_id: observation.referredUserId,
    p_rail: observation.rail,
    p_event_type: observation.eventType,
    p_environment: observation.environment,
    p_currency: observation.currency,
    p_currency_exponent: observation.currencyExponent,
    p_gross_minor: observation.grossMinor,
    p_discount_minor: observation.discountMinor,
    p_tax_minor: observation.taxMinor,
    p_eligible_minor: observation.eligibleMinor,
    p_observed_at: observation.observedAt,
  };
}

export async function ingestPartnerFinancialFact(db, observation) {
  const args = await partnerFinancialFactRpcArgs(observation);
  const { data, error } = await db.rpc(
    "partners_worker_financial_fact_ingest",
    args,
  );
  if (error) {
    const code = textOrNull(error.code, 16) ?? "unknown";
    throw new Error(`partners_fact_ingest_failed:${code}`);
  }

  const result = unwrapRpcJson(data);
  const fact = recordOrEmpty(result?.fact);
  if (
    Number(result?.schema_version) !== 1 ||
    result?.action !== "financial_fact_ingested" ||
    !["complete", "incomplete", "quarantined"].includes(
      String(fact.status ?? ""),
    )
  ) {
    throw new Error("partners_fact_ingest_invalid_response");
  }
  if (result.conflict === true) {
    // PostgreSQL has atomically appended a sanitized conflict observation,
    // quarantined the fact and dead-lettered any pending job. The provider
    // delivery is terminal, while the entitlement path may continue.
    console.error("[partners-finance] economic fact conflict quarantined", {
      rail: observation.rail,
      event_type: observation.eventType,
    });
  }
  return result;
}

export function classifyPartnersWorkerRpcFailure(error) {
  const code = textOrNull(error?.code, 16) ?? "unknown";
  if (
    code === "22023" ||
    code === "23514" ||
    code === "55000" ||
    code === "P0003" ||
    code === "P0006"
  ) {
    return { outcome: "dead_letter", code };
  }
  return { outcome: "retry", code };
}
