// Norva — Revolut Merchant webhook.
//
// Receives Revolut Merchant API webhook events and reconciles them into the
// `cloud_entitlement_projection` cache that Norva Cloud reads to decide access
// (see ../_shared/entitlements.ts). Modeled on norva-billing-webhook (RevenueCat):
// the projection is provider-agnostic, so Revolut is just a new writer with
// `provider:"revolut"`.
//
// AUTH — Revolut signs each webhook (HMAC-SHA256). We verify:
//   payload_to_sign = "v1." + Revolut-Request-Timestamp + "." + rawBody
//   expected        = "v1=" + hex(HMAC_SHA256(signing_secret, payload_to_sign))
//   compare (timing-safe) against Revolut-Signature (may hold multiple, space-
//   separated, during key rotation); reject a timestamp older than 5 min (replay).
//   Ref: developer.revolut.com/docs/guides/.../verify-the-payload-signature
//   (confirmed working against a real sandbox delivery on 2026-07-11.)
//
// MINIMAL BODY — Revolut delivers only { event, order_id }. The metadata, amount
// and authoritative state are NOT in the body, so we GET the order from Revolut
// ({REVOLUT_API_BASE}/api/1.0/orders/{id}) and trust the API — the same pattern
// (re-fetch the order and trust the API, not the raw body). The checkout stamps the
// order metadata with { user_id, plan, period, kind }, which we read back here.
// Events whose order has no resolvable user are ack'd (200) and skipped.
//
// Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//   REVOLUT_WEBHOOK_SIGNING_SECRET, REVOLUT_SECRET_KEY.
// Optional: REVOLUT_API_BASE (default sandbox), NORVA_TRIAL_DAYS (7),
//   NORVA_BILLING_FAIL_OPEN_HOURS (72).

import { createClient } from "npm:@supabase/supabase-js@2";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { getPrices } from "../_shared/prices.ts";

type JsonRecord = Record<string, unknown>;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SECRET_KEY") ??
  "";
const SIGNING_SECRET = Deno.env.get("REVOLUT_WEBHOOK_SIGNING_SECRET") ?? "";
const REVOLUT_SECRET_KEY = Deno.env.get("REVOLUT_SECRET_KEY") ?? "";
// Sandbox during dev; set to https://merchant.revolut.com at production cutover.
const REVOLUT_API_BASE = (Deno.env.get("REVOLUT_API_BASE") ?? "https://sandbox-merchant.revolut.com").replace(/\/+$/, "");
const TRIAL_DAYS = boundedInt(Deno.env.get("NORVA_TRIAL_DAYS"), 7, 0, 90);
const FAIL_OPEN_HOURS = boundedInt(Deno.env.get("NORVA_BILLING_FAIL_OPEN_HOURS"), 72, 1, 24 * 14);
const TOLERANCE_MS = 5 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // Raw body FIRST — the HMAC is over the exact bytes.
  const raw = await req.text();
  if (!(await verifySignature(req, raw))) return json({ error: "Invalid signature" }, 401);

  let body: JsonRecord;
  try { body = JSON.parse(raw) as JsonRecord; } catch (_) { return json({ error: "Invalid JSON" }, 400); }

  const eventType = String(body.event ?? body.type ?? "").toUpperCase();
  const data = recordOrEmpty(body.data);
  const orderId = stringOrNull(body.order_id) ?? stringOrNull(data.order_id) ?? stringOrNull(data.id);
  const subscriptionId = stringOrNull(body.subscription_id) ?? stringOrNull(data.subscription_id);
  const eventId = `${eventType}:${orderId ?? subscriptionId ?? "?"}`;
  console.log("[norva-revolut-webhook]", eventType, eventId);

  try {
    // Idempotency before the API round-trip: Revolut retries, so a duplicate id
    // is ack'd and skipped without re-fetching.
    if (await alreadyProcessed(admin, eventId)) return json({ ok: true, duplicate: true });

    // Authoritative order from Revolut — the body carries no metadata/state.
    // TODO(subscriptions): fetch the subscription object for SUBSCRIPTION_* events.
    const order = orderId ? await fetchOrder(orderId) : {};
    const remoteState = String(order.state ?? "").toUpperCase();
    const { data: refundAttemptRow, error: refundAttemptError } = orderId
      ? await admin.from("cloud_revolut_refund_attempts")
        .select("order_id,user_id,amount_cents,currency,status,provider_refund_id")
        .eq("provider_refund_id", orderId).maybeSingle()
      : { data: null, error: null };
    if (refundAttemptError) throw new Error(`refund attempt lookup failed: ${refundAttemptError.message}`);
    type RefundAttempt = {
      order_id: string; user_id: string; amount_cents: number; currency: string;
      status: string; provider_refund_id: string | null;
    };
    let refundAttempt = refundAttemptRow as RefundAttempt | null;
    // Revolut may deliver the refund webhook before POST /refund returns. The
    // authoritative refund order still carries related_order_id, so correlate
    // it to the unique local reservation instead of acknowledging it as an
    // unrelated checkout event.
    const refundRelatedOrderId = stringOrNull(order.related_order_id);
    if (
      !refundAttempt && orderId
      && String(order.type ?? "").toLowerCase() === "refund"
      && refundRelatedOrderId
    ) {
      const { data: relatedAttempt, error: relatedAttemptError } = await admin
        .from("cloud_revolut_refund_attempts")
        .select("order_id,user_id,amount_cents,currency,status,provider_refund_id")
        .eq("order_id", refundRelatedOrderId)
        .in("status", ["creating", "processing"])
        .maybeSingle();
      if (relatedAttemptError) {
        throw new Error(`related refund attempt lookup failed: ${relatedAttemptError.message}`);
      }
      refundAttempt = relatedAttempt as RefundAttempt | null;
    }
    if (refundAttempt) {
      // Refunds are distinct provider orders. They intentionally do not carry
      // the original checkout metadata; provider_refund_id is the durable local
      // correlation anchor and related_order_id links back to the capture.
      const relatedOrderId = stringOrNull(order.related_order_id);
      const providerAmount = Number(order.amount);
      const providerCurrency = String(order.currency ?? "").toUpperCase();
      const integrityValid = String(order.type ?? "").toLowerCase() === "refund"
        && relatedOrderId === refundAttempt.order_id
        && Number.isFinite(providerAmount)
        && Math.round(providerAmount) === refundAttempt.amount_cents
        && providerCurrency === refundAttempt.currency;
      if (!integrityValid) throw new Error("provider refund order failed integrity validation");
      if (refundAttempt.provider_refund_id !== orderId) {
        const { error: bindError } = await admin.rpc("mark_revolut_full_refund_processing", {
          p_order_id: refundAttempt.order_id,
          p_user_id: refundAttempt.user_id,
          p_lease_token: null,
          p_provider_refund_id: orderId,
          p_provider_response: order,
        });
        if (bindError) throw new Error(`refund order correlation failed: ${bindError.message}`);
        refundAttempt = { ...refundAttempt, status: "processing", provider_refund_id: orderId };
      }

      if (eventType === "ORDER_COMPLETED" && remoteState === "COMPLETED") {
        const { data: completed, error: completeError } = await admin.rpc(
          "complete_revolut_full_refund",
          {
            p_order_id: refundAttempt.order_id,
            p_user_id: refundAttempt.user_id,
            p_provider_refund_id: orderId,
            p_provider_state: remoteState,
            p_related_order_id: relatedOrderId,
            p_provider_amount_cents: Math.round(providerAmount),
            p_provider_currency: providerCurrency,
            p_provider_response: order,
          },
        );
        if (completeError) throw new Error(`refund completion failed: ${completeError.message}`);
        await recordProcessedEvent(admin, refundAttempt.user_id, eventId, eventType, {
          event: body, refund_order: order, refund_result: completed,
        });
        return json({ ok: true, refund: completed, state: remoteState });
      }
      if (
        ["ORDER_PAYMENT_DECLINED", "ORDER_PAYMENT_FAILED", "ORDER_CANCELLED"].includes(eventType)
        || ["FAILED", "DECLINED", "CANCELLED", "REVERSED", "VOIDED"].includes(remoteState)
      ) {
        const failureState = ["FAILED", "DECLINED", "CANCELLED", "REVERSED", "VOIDED"].includes(remoteState)
          ? remoteState
          : eventType.replace(/^ORDER_(?:PAYMENT_)?/, "");
        const { error: failureError } = await admin.rpc("fail_revolut_refund_order", {
          p_provider_refund_id: orderId,
          p_provider_state: failureState,
          p_provider_response: order,
        });
        if (failureError) throw new Error(`refund failure write failed: ${failureError.message}`);
        await recordProcessedEvent(admin, refundAttempt.user_id, eventId, eventType, {
          event: body, refund_order: order, refund_result: "failed",
        });
        return json({ ok: true, refund: "failed", state: failureState });
      }
      // A delivery can race the provider state transition. Do not acknowledge a
      // supposed completion until the authoritative GET is actually COMPLETED.
      if (eventType === "ORDER_COMPLETED") {
        throw new Error(`authoritative refund state not settled: ${remoteState || "missing"}`);
      }
      await recordProcessedEvent(admin, refundAttempt.user_id, eventId, eventType, {
        event: body, refund_order: order, refund_result: "processing",
      });
      return json({ ok: true, refund: "processing", state: remoteState });
    }
    if (String(order.type ?? "").toLowerCase() === "refund") {
      // Never acknowledge an uncorrelated money-out event: a reservation may
      // still be committing in another process, and Revolut retry is what makes
      // that race converge once the local row becomes visible.
      throw new Error("provider refund order has no durable local reservation");
    }
    if (orderId) {
      const reconciledAt = new Date().toISOString();
      const { error: journalError } = await admin.from("cloud_revolut_orders").update({
        ...(remoteState ? { state: remoteState } : {}),
        last_reconciled_at: reconciledAt,
        updated_at: reconciledAt,
      }).eq("order_id", orderId);
      if (journalError) throw new Error(`order journal reconcile failed: ${journalError.message}`);
    }
    // The immutable local journal is the ownership anchor. Provider metadata is
    // still validated below, but missing/corrupted metadata must not make a real
    // COMPLETED resubscribe capture disappear from the ledger/refund queue.
    const { data: journalRow, error: journalReadError } = orderId
      ? await admin.from("cloud_revolut_orders")
        .select("order_id,user_id,kind,plan,period,amount,currency,requested_amount_cents,merchant_ext_ref,intent_key,finalized_at,expired_at,superseded_at,finalization_result,experiment_key,experiment_variant,paywall_placement,paywall_surface")
        .eq("order_id", orderId).maybeSingle()
      : { data: null, error: null };
    if (journalReadError) throw new Error(`order journal read failed: ${journalReadError.message}`);
    const meta = recordOrEmpty(order.metadata);
    const metadataUserId = resolveUserId(meta);
    const journalUserId = stringOrNull((journalRow as JsonRecord | null)?.user_id);
    const userId = journalUserId ?? metadataUserId;
    if (!userId) {
      console.warn("[norva-revolut-webhook] no user_id in order metadata — skipped", { eventType, orderId });
      return json({ ok: true, skipped: "no_user_metadata" });
    }

    const kind = String(meta.kind ?? "").toLowerCase();
    const journal = journalRow as {
      user_id?: string;
      kind?: string | null;
      plan?: string | null;
      period?: string | null;
      requested_amount_cents?: number | null;
      amount?: number | null;
      currency?: string | null;
      merchant_ext_ref?: string | null;
      intent_key?: string | null;
      finalized_at?: string | null;
      expired_at?: string | null;
      superseded_at?: string | null;
      finalization_result?: JsonRecord | null;
      experiment_key?: string | null;
      experiment_variant?: string | null;
      paywall_placement?: string | null;
      paywall_surface?: string | null;
    } | null;
    const anchoredKind = String(journal?.kind ?? kind).toLowerCase();
    const checkoutKind = ["trial_setup", "plan_change", "resubscribe", "card_update"].includes(anchoredKind);
    const checkoutEvent = ["ORDER_AUTHORISED", "ORDER_COMPLETED"].includes(eventType) && checkoutKind;
    // Resubscribe is a real full-price AUTOMATIC purchase. A mere card
    // authorization must never grant access; all other checkout kinds are
    // intentionally uncaptured validation holds where AUTHORISED is success.
    const remoteCheckoutSuccess = anchoredKind === "resubscribe"
      ? remoteState === "COMPLETED"
      : ["AUTHORISED", "COMPLETED"].includes(remoteState);
    if (checkoutEvent && (!journal || journal.user_id !== userId)) {
      throw new Error("checkout order journal missing or ownership mismatch");
    }
    if (checkoutEvent && journal) {
      const remoteExtRef = stringOrNull(order.merchant_order_ext_ref) ?? stringOrNull(order.merchant_ext_ref);
      const remoteAmount = Number(meta.amount_cents);
      const remoteOrderAmount = Number(order.amount);
      const remoteCurrency = String(order.currency ?? meta.price_currency ?? "").toUpperCase();
      const expectedOrderAmount = journal.kind === "resubscribe"
        ? Number(journal.requested_amount_cents)
        : Number(journal.amount);
      const immutableMismatch =
        metadataUserId !== userId ||
        (journal.kind != null && journal.kind !== kind) ||
        (journal.plan != null && journal.plan !== planForMeta(meta)) ||
        (journal.period != null && journal.period !== (String(meta.period ?? "").toLowerCase() === "annual" ? "annual" : "monthly")) ||
        (journal.requested_amount_cents != null && remoteAmount !== journal.requested_amount_cents) ||
        (journal.amount != null && Number.isFinite(expectedOrderAmount) && remoteOrderAmount !== expectedOrderAmount) ||
        (journal.currency != null && remoteCurrency !== journal.currency.toUpperCase()) ||
        (journal.merchant_ext_ref != null && remoteExtRef !== journal.merchant_ext_ref) ||
        (journal.intent_key != null && stringOrNull(meta.intent_key) !== journal.intent_key) ||
        (journal.experiment_key != null && stringOrNull(meta.experiment_key) !== journal.experiment_key) ||
        (journal.experiment_variant != null && stringOrNull(meta.experiment_variant) !== journal.experiment_variant) ||
        (journal.paywall_placement != null && stringOrNull(meta.paywall_placement) !== journal.paywall_placement) ||
        (journal.paywall_surface != null && stringOrNull(meta.paywall_surface) !== journal.paywall_surface);
      if (immutableMismatch) {
        if (journal.kind === "resubscribe" && remoteState === "COMPLETED" && orderId) {
          const payment = paymentSnapshotFromOrder(order);
          const { data: quarantined, error: quarantineError } = await admin.rpc(
            "reconcile_completed_revolut_resubscribe",
            {
              p_order_id: orderId,
              p_user_id: userId,
              p_provider_payment_id: payment.providerPaymentId,
              p_captured_amount_cents: Number.isFinite(remoteOrderAmount) ? Math.round(remoteOrderAmount) : null,
              p_captured_currency: remoteCurrency || null,
              p_provider_integrity_valid: false,
            },
          );
          if (quarantineError) {
            throw new Error(`captured checkout quarantine failed: ${quarantineError.message}`);
          }
          const outcome = Array.isArray(quarantined)
            ? quarantined[0] as JsonRecord | undefined
            : quarantined as JsonRecord | null;
          if (stringOrNull(outcome?.result) === "already_refunded") {
            await recordProcessedEvent(admin, userId, eventId, eventType, {
              event: body, order, already_refunded: true,
            });
            return json({ ok: true, already_refunded: true, state: "REFUNDED" });
          }
          throw new Error(
            `captured checkout integrity mismatch requires refund: ${stringOrNull(outcome?.exception_reason) ?? "commercial_terms_invalid"}`,
          );
        }
        throw new Error("checkout order metadata does not match immutable journal");
      }
    }
    if (checkoutEvent && journal?.finalized_at) {
      await recordProcessedEvent(admin, userId, eventId, eventType, { event: body, order, already_finalized: true });
      return json({ ok: true, duplicate_finalization: true, state: remoteState });
    }
    if (
      checkoutEvent &&
      (journal?.expired_at || journal?.superseded_at) &&
      !(anchoredKind === "resubscribe" && remoteState === "COMPLETED")
    ) {
      const holdReleased = remoteState === "AUTHORISED" ? await cancelValidationHold(String(orderId)) : true;
      await recordProcessedEvent(admin, userId, eventId, eventType, {
        event: body, order, skipped_checkout: journal.superseded_at ? "superseded" : "expired", hold_released: holdReleased,
      });
      return json({ ok: true, skipped: journal.superseded_at ? "superseded_checkout" : "expired_checkout" });
    }
    if (checkoutEvent && !remoteCheckoutSuccess) {
      if (anchoredKind === "resubscribe" && ["AUTHORISED", "AUTHORIZED", "PROCESSING", "PENDING"].includes(remoteState)) {
        await recordProcessedEvent(admin, userId, eventId, eventType, {
          event: body, order, checkout_status: "payment_processing",
        });
        return json({ ok: true, pending: true, status: "payment_processing", state: remoteState });
      }
      if (["CANCELLED", "FAILED", "DECLINED", "REVERSED", "VOIDED", "EXPIRED"].includes(remoteState)) {
        await recordProcessedEvent(admin, userId, eventId, eventType, { event: body, order, skipped_state: remoteState });
        return json({ ok: true, skipped: "authoritative_state_not_successful", state: remoteState });
      }
      // An AUTHORISED event can beat the read replica/API state transition. A 5xx
      // makes Revolut retry rather than permanently acknowledging an unsettled order.
      throw new Error(`authoritative checkout state not settled: ${remoteState || "missing"}`);
    }

    const checkoutSuccess = checkoutEvent && remoteCheckoutSuccess;
    // Checkout/card-validation orders are account mutations, not recurring
    // charges.  Their failure events must never put an existing subscription in
    // past_due; only an authoritative successful state enters finalization.
    const patch = checkoutSuccess || checkoutKind ? null : projectionPatch(userId, eventType, order, meta);
    let checkoutResult: string | null = null;
    if (checkoutSuccess) checkoutResult = await finalizeCheckoutEntitlement(admin, userId, order, meta);
    else if (patch) {
      const projectionResult = await applyNonCheckoutProjectionPatch(admin, userId, eventId, patch);
      if (projectionResult) {
        await recordProcessedEvent(admin, userId, eventId, eventType, {
          event: body, order, skipped_projection_result: projectionResult,
        });
        return json({ ok: true, skipped: "projection_not_applied", result: projectionResult });
      }
    }

    let effectiveAt: string | null = null;
    let firstChargeAt: string | null = null;
    if (checkoutSuccess && ["trial_started", "already_confirmed", "plan_change_scheduled"].includes(String(checkoutResult))) {
      const planCommit = await commitOrderPlan(admin, userId, eventType, meta, orderId);
      effectiveAt = planCommit.effectiveAt;
      // A tag/hard-block/rail move can win after entitlement finalization but
      // before the recurring mapping write. The DB trigger makes that race
      // authoritative; still release the validation hold and journal the
      // rejected checkout instead of relying on a later webhook retry.
      if (planCommit.rejectedAs) checkoutResult = planCommit.rejectedAs;
    }
    if (checkoutSuccess && checkoutResult === "trial_started") {
      const { data: trialProjection } = await admin.from("cloud_entitlement_projection")
        .select("trial_ends_at").eq("user_id", userId).maybeSingle();
      firstChargeAt = stringOrNull((trialProjection as { trial_ends_at?: unknown } | null)?.trial_ends_at);
    }
    if (checkoutSuccess && orderId) {
      let holdReleased = remoteState !== "AUTHORISED";
      let finalState = remoteState || "AUTHORISED";
      if (remoteState === "AUTHORISED") {
        holdReleased = await cancelValidationHold(orderId);
        if (holdReleased) finalState = "CANCELLED";
      }
      const finalizationResult = {
          result: checkoutResult, kind, remote_state: remoteState,
          hold_released: holdReleased, source: "webhook", effective_at: effectiveAt,
          first_charge_at: firstChargeAt, trial_ends_at: firstChargeAt,
        };
      const { data: finalizationOutcome, error: finalizedError } = await admin.rpc(
        "finalize_revolut_checkout_order",
        {
          p_order_id: orderId,
          p_user_id: userId,
          p_state: finalState,
          p_finalization_result: finalizationResult,
        },
      );
      if (finalizedError) throw new Error(`order finalization journal failed: ${finalizedError.message}`);
      if (finalizationOutcome !== "finalized" && finalizationOutcome !== "already_finalized") {
        throw new Error(`order finalization journal rejected: ${String(finalizationOutcome)}`);
      }
    }
    // The processed marker is deliberately last: a 5xx from any mandatory write
    // above must leave the event replayable.
    await recordProcessedEvent(admin, userId, eventId, eventType, { event: body, order });
    return json({ ok: true, type: eventType, plan: checkoutSuccess ? planForMeta(meta) : patch?.plan_code ?? null });
  } catch (error) {
    // 5xx → Revolut retries with backoff (3× / 10 min).
    const message = error instanceof Error ? error.message : "Unexpected error";
    console.error("[norva-revolut-webhook]", eventType, message);
    return json({ error: message }, 500);
  }
});

// --- Revolut API ------------------------------------------------------------

async function fetchOrder(orderId: string): Promise<JsonRecord> {
  if (!REVOLUT_SECRET_KEY) {
    throw new Error("REVOLUT_SECRET_KEY not set — cannot fetch order");
  }
  try {
    const resp = await fetch(`${REVOLUT_API_BASE}/api/1.0/orders/${encodeURIComponent(orderId)}`, {
      headers: { "Authorization": `Bearer ${REVOLUT_SECRET_KEY}`, "Accept": "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      throw new Error(`fetchOrder ${orderId} returned ${resp.status}`);
    }
    return recordOrEmpty(await resp.json());
  } catch (e) {
    const message = String((e as Error)?.message || e);
    console.warn("[norva-revolut-webhook] fetchOrder failed", orderId, message);
    throw new Error(`provider order unavailable: ${message}`);
  }
}

async function cancelValidationHold(orderId: string): Promise<boolean> {
  if (!REVOLUT_SECRET_KEY) return false;
  try {
    const resp = await fetch(`${REVOLUT_API_BASE}/api/orders/${encodeURIComponent(orderId)}/cancel`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${REVOLUT_SECRET_KEY}`,
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Revolut-Api-Version": "2024-09-01",
      },
      signal: AbortSignal.timeout(10_000),
    });
    return resp.ok;
  } catch (error) {
    console.warn("[norva-revolut-webhook] validation hold cancel failed", orderId, String((error as Error)?.message ?? error));
    return false;
  }
}

// --- event -> projection mapping --------------------------------------------

function projectionPatch(userId: string, type: string, order: JsonRecord, meta: JsonRecord): JsonRecord | null {
  const status = statusForEvent(type, meta, String(order.state ?? "").toUpperCase());
  if (!status) return null;

  const planCode = planForMeta(meta);
  const period = String(meta.period ?? "").toLowerCase() === "annual" ? "annual" : "monthly";
  const eventAt = authoritativeOrderEventAt(order);
  const eventMs = new Date(eventAt).getTime();
  const verifiedAt = new Date().toISOString();

  const patch: JsonRecord = {
    user_id: userId,
    provider: "revolut",
    provider_customer_id: stringOrNull(order.customer_id) ?? stringOrNull(meta.customer_id),
    plan_code: planCode,
    status,
    // No per-user limit overrides — entitlements.ts layers the current plan-catalog
    // limits on read, so catalog changes apply without the webhook keeping a copy.
    limits: {},
    last_verified_at: verifiedAt,
    last_event_at: eventAt,
    bill_period: period,
  };

  if (status === "trialing") {
    // TODO(subscriptions): prefer the subscription's real trial-phase end once we
    // fetch it; TRIAL_DAYS is the interim source of truth.
    patch.trial_ends_at = new Date(eventMs + TRIAL_DAYS * 86_400_000).toISOString();
    patch.trial_consumed_at = eventAt;
    patch.current_period_end = patch.trial_ends_at;
  } else if (status === "active") {
    // TODO(subscriptions): prefer the subscription's real next_billing/period end.
    const days = period === "annual" ? 365 : 30;
    patch.current_period_end = new Date(eventMs + days * 86_400_000).toISOString();
    const cents = Number(recordOrEmpty(order.order_amount).value);
    if (Number.isFinite(cents) && cents > 0) patch.mrr_cents = Math.round(cents);
  }

  if (status === "past_due") {
    // Keep access open for a grace window (matches entitlements.ts fail-open).
    patch.fail_open_until = new Date(eventMs + FAIL_OPEN_HOURS * 60 * 60 * 1000).toISOString();
  }

  // Customer-country proxy for the web rail: the card's ISSUING country, read on the
  // re-fetched order's payment details. Only stamp when present — an event whose order
  // carries no payment details must never null an already-known country.
  const cardCountry = cardCountryFromOrder(order);
  if (cardCountry) {
    patch.country_code = cardCountry;
    patch.country_source = "card";
  }

  return patch;
}

// The fetched Order is authoritative and exposes the instant of its latest
// state transition.  Webhook delivery time is not a causal clock: delayed
// deliveries would otherwise be able to overwrite a newer entitlement.
function authoritativeOrderEventAt(order: JsonRecord): string {
  const raw = stringOrNull(order.updated_at);
  const ms = raw ? new Date(raw).getTime() : Number.NaN;
  if (!Number.isFinite(ms)) throw new Error("authoritative order updated_at is missing or invalid");
  return new Date(ms).toISOString();
}

// AUTHORISED is the successful final state of Norva's MANUAL card-check order.
// It is not a captured subscription charge: apply the requested account mutation
// once, then the caller releases the tiny validation hold. This mirrors /confirm
// so a hosted checkout remains correct even when the browser never returns.
async function finalizeCheckoutEntitlement(
  db: SupabaseClient,
  userId: string,
  order: JsonRecord,
  meta: JsonRecord,
): Promise<string> {
  const kind = String(meta.kind ?? "trial_setup").toLowerCase();
  const plan = planForMeta(meta);
  const period = String(meta.period ?? "").toLowerCase() === "annual" ? "annual" : "monthly";
  const nowIso = new Date().toISOString();
  const customerId = stringOrNull(order.customer_id) ?? stringOrNull(meta.customer_id);
  const { data: internalAccount, error: internalError } = await db.from("admin_internal_accounts")
    .select("user_id").eq("user_id", userId).maybeSingle();
  if (internalError) throw new Error(`internal account lookup failed: ${internalError.message}`);
  // A checkout may complete after an administrator converted an account to an
  // included pilot.  The order is still finalized/released by the caller, but it
  // cannot create a paid plan or a recurring-customer mapping.
  if (internalAccount && kind !== "resubscribe") return "rejected_internal_account";
  const { data: current, error: currentError } = await db.from("cloud_entitlement_projection")
    .select("status,provider,trial_ends_at,trial_consumed_at,current_period_end,fail_open_until")
    .eq("user_id", userId).maybeSingle();
  if (currentError) throw new Error(`projection read failed: ${currentError.message}`);
  const cur = current as {
    status?: string;
    provider?: string;
    trial_ends_at?: string;
    trial_consumed_at?: string;
    current_period_end?: string;
    fail_open_until?: string;
  } | null;
  const curStatus = String(cur?.status ?? "");
  const curProvider = String(cur?.provider ?? "").toLowerCase();
  const hardBlocked = new Set(["revoked", "refunded", "fraud"]).has(curStatus);
  // A checkout opened before a security/refund decision may return through the
  // webhook after that decision. Journal it and release its validation hold, but
  // never replace the authoritative hard block or commit a recurring plan.
  if (hardBlocked && kind !== "resubscribe") return "rejected_account_blocked";
  const currentEndMs = cur?.current_period_end ? new Date(cur.current_period_end).getTime() : 0;
  const trialEndMs = cur?.trial_ends_at ? new Date(cur.trial_ends_at).getTime() : 0;
  const failOpenMs = cur?.fail_open_until ? new Date(cur.fail_open_until).getTime() : 0;
  const isLive = ["trialing", "active", "past_due", "grace", "cancelled_at_period_end"].includes(curStatus) &&
    Math.max(currentEndMs, trialEndMs, failOpenMs) > Date.now();
  const terminalStatus = curStatus === "expired";
  const foreignRailBlocked = Boolean(cur && curProvider && curProvider !== "revolut" && !terminalStatus);
  const planEffectiveAt = curStatus === "trialing"
    ? (cur?.trial_ends_at ?? cur?.current_period_end)
    : cur?.current_period_end;
  const cardCountry = cardCountryFromOrder(order);
  const replaceProjectionWithRailCas = async (patch: JsonRecord): Promise<void> => {
    if (!cur) {
      const { error } = await db.from("cloud_entitlement_projection").insert(patch);
      if (error) throw new Error(`projection insert failed: ${error.message}`);
      return;
    }
    const { data: changed, error } = await db.from("cloud_entitlement_projection")
      .update(patch)
      .eq("user_id", userId)
      .eq("provider", curProvider)
      .eq("status", curStatus)
      .select("user_id");
    if (error) throw new Error(`projection replacement failed: ${error.message}`);
    if (!Array.isArray(changed) || changed.length !== 1) throw new Error("projection rail changed concurrently");
  };

  if (kind === "card_update") {
    if (curProvider !== "revolut") return "rejected_cross_rail";
    if (curStatus === "past_due" || curStatus === "grace") {
      const { data: changed, error } = await db.from("cloud_entitlement_projection").update({
        status: "active", provider: "revolut", current_period_end: nowIso,
        last_event_at: nowIso, last_verified_at: nowIso,
        ...(cardCountry ? { country_code: cardCountry, country_source: "card" } : {}),
      }).eq("user_id", userId).eq("provider", "revolut").in("status", ["past_due", "grace"]).select("user_id");
      if (error) throw new Error(`card recovery failed: ${error.message}`);
      if (!Array.isArray(changed) || changed.length !== 1) return "card_already_recovered";
      return "card_updated_retrying";
    }
    return "card_updated";
  }

  const metaAmount = Number(meta.amount_cents);
  const amount = Number.isFinite(metaAmount) && metaAmount >= 100 && metaAmount <= 99999
    ? Math.round(metaAmount)
    : (await getPrices(db))[plan]?.[period];

  if (kind === "plan_change") {
    if (curProvider !== "revolut") return "rejected_cross_rail";
    if (!isLive || !planEffectiveAt || new Date(planEffectiveAt).getTime() <= Date.now()) return "rejected_plan_not_live";
    const change: JsonRecord = {
      provider: "revolut", provider_customer_id: customerId,
      last_event_at: nowIso, last_verified_at: nowIso,
      ...(cardCountry ? { country_code: cardCountry, country_source: "card" } : {}),
    };
    if (curStatus === "cancelled_at_period_end") {
      change.status = cur?.trial_ends_at && new Date(cur.trial_ends_at).getTime() > Date.now() ? "trialing" : "active";
    }
    const { data: changed, error } = await db.from("cloud_entitlement_projection")
      .update(change).eq("user_id", userId).eq("provider", "revolut").eq("status", curStatus).select("user_id");
    if (error) throw new Error(`plan change failed: ${error.message}`);
    if (!Array.isArray(changed) || changed.length !== 1) throw new Error("plan change projection missing");
    return "plan_change_scheduled";
  }

  if (kind === "resubscribe") {
    const orderId = stringOrNull(order.id);
    if (!orderId || String(order.state ?? "").toUpperCase() !== "COMPLETED") {
      return "payment_processing";
    }
    const payment = paymentSnapshotFromOrder(order);
    const { data: reconciled, error: reconcileError } = await db.rpc(
      "reconcile_completed_revolut_resubscribe",
      {
        p_order_id: orderId,
        p_user_id: userId,
        p_provider_payment_id: payment.providerPaymentId,
        p_captured_amount_cents: Number.isFinite(Number(order.amount)) ? Math.round(Number(order.amount)) : null,
        p_captured_currency: String(order.currency ?? meta.price_currency ?? "").toUpperCase() || null,
        p_provider_integrity_valid: true,
        p_customer_id: customerId,
        p_payment_method_id: payment.paymentMethodId,
        p_card_last4: payment.cardLast4,
        p_card_brand: payment.cardBrand,
        p_card_exp: payment.cardExp,
        p_card_country: cardCountry,
      },
    );
    if (reconcileError) {
      throw new Error(`resubscribe terminal reconciliation failed: ${reconcileError.message}`);
    }
    const outcome = Array.isArray(reconciled) ? reconciled[0] as JsonRecord | undefined : reconciled as JsonRecord | null;
    const result = stringOrNull(outcome?.result);
    if (result === "refund_required") {
      throw new Error(`captured resubscribe requires refund: ${stringOrNull(outcome?.exception_reason) ?? "manual_review"}`);
    }
    if (result !== "applied" && result !== "already_applied") {
      throw new Error(`resubscribe terminal reconciliation returned ${result ?? "no_result"}`);
    }
    return "resubscribed";
  }

  if (foreignRailBlocked) return "rejected_cross_rail";
  if (cur?.trial_consumed_at) return "already_confirmed";
  if (isLive) return "already_active";
  // New checkout orders freeze the exact first debit date in server metadata;
  // the calculated fallback is retained only for pre-contract legacy orders.
  const trialEnd = isoTimestampOrNull(meta.first_charge_at)
    ?? new Date(Date.now() + TRIAL_DAYS * 86_400_000).toISOString();
  const trialOrderId = stringOrNull(order.id);
  if (trialOrderId) {
    const { error: lifecycleError } = await db.from("cloud_entitlement_events").upsert({
      user_id: userId,
      provider: "revolut",
      provider_event_id: `checkout:${trialOrderId}:trial-started`,
      event_type: "TRIAL_STARTED",
      payload: { order_id: trialOrderId, plan_label: plan, bill_period: period, first_charge_at: trialEnd },
      processed_at: nowIso,
    }, { onConflict: "provider,provider_event_id", ignoreDuplicates: true });
    if (lifecycleError) throw new Error(`trial lifecycle write failed: ${lifecycleError.message}`);
  }
  await replaceProjectionWithRailCas({
    user_id: userId, status: "trialing", provider: "revolut", provider_customer_id: customerId,
    plan_code: plan, trial_ends_at: trialEnd, trial_consumed_at: nowIso,
    current_period_end: trialEnd, last_event_at: nowIso, last_verified_at: nowIso,
    ...(amount ? {
      // mrr_cents stores the full billed-period amount. Annual normalization is
      // performed exactly once by the reporting views.
      mrr_cents: amount,
      bill_period: period,
      billing_currency: "USD",
      billing_product_id: null,
      billing_package_id: null,
      billing_terms_source: "revolut_order_snapshot",
    } : {}),
    ...(cardCountry ? { country_code: cardCountry, country_source: "card" } : {}),
  });
  return "trial_started";
}

// Card issuing country (ISO alpha-2) from the order's payment details. CONFIRMED on
// live events (étape 0, 2026-07-17): payments[].payment_method.card.card_country.
// Older candidates kept as fallback for other API generations.
function cardCountryFromOrder(order: JsonRecord): string | null {
  const payments = Array.isArray(order.payments) ? order.payments as JsonRecord[] : [];
  for (const p of payments) {
    const pm = recordOrEmpty(p.payment_method);
    const card = recordOrEmpty(pm.card);
    const raw = card.card_country ?? pm.card_country_code ?? card.card_country_code ?? card.country_code ?? p.card_country_code;
    if (typeof raw === "string" && /^[A-Za-z]{2}$/.test(raw.trim())) return raw.trim().toUpperCase();
  }
  return null;
}

function statusForEvent(type: string, meta: JsonRecord, authoritativeOrderState: string): string | null {
  const kind = String(meta.kind ?? "").toLowerCase();
  switch (type) {
    case "ORDER_COMPLETED":
      // A delayed failure delivery may be fetched after the same Order recovered
      // to COMPLETED. Conversely, a completion notification can beat the Order
      // read. Only the current authoritative state is allowed to mutate access.
      if (authoritativeOrderState !== "COMPLETED") return null;
      // trial-setup order (card saved) keeps us trialing; a real charge → active.
      return kind === "trial_setup" ? "trialing" : "active";
    case "ORDER_PAYMENT_DECLINED":
    case "ORDER_PAYMENT_FAILED":
      return ["FAILED", "DECLINED", "CANCELLED"].includes(authoritativeOrderState)
        ? "past_due"
        : null;
    // Subscription notifications need the authoritative Subscription object,
    // which this legacy endpoint does not fetch yet. They remain journalled but
    // cannot project a status from an unrelated/stale Order snapshot.
    case "SUBSCRIPTION_INITIATED":
    case "SUBSCRIPTION_OVERDUE":
    case "SUBSCRIPTION_CANCELLED":
    case "SUBSCRIPTION_FINISHED":
      return null;
    default:
      return null;
  }
}

function planForMeta(meta: JsonRecord): string {
  const plan = String(meta.plan ?? "").toLowerCase();
  if (plan === "plus" || plan === "family") return plan;
  if (plan === "norva") return "plus";
  if (plan.includes("family")) return "family";
  return "plus";
}

// Commit the recurring plan of a PAID checkout order onto cloud_revolut_customers.
// Only checkout-created orders carry a kind in metadata (the renewal cron's orders
// have no metadata and never reach this — resolveUserId already skipped them).
// Best-effort: the projection reconciliation above must never fail on this.
// Amount: the metadata's amount_cents (stamped server-side at checkout OPEN, so a
// promo ending mid-checkout still honors what the customer saw), else the current
// catalog from billing_prices (single source, _shared/prices.ts).
type OrderPlanCommitResult = {
  effectiveAt: string | null;
  rejectedAs: string | null;
};

function mappingGuardFinalization(message: string): string | null {
  if (message.includes("internal_account_not_billable")) return "rejected_internal_account";
  if (message.includes("revolut_customer_account_blocked")) return "rejected_account_blocked";
  if (message.includes("revolut_customer_rail_mismatch")) return "rejected_cross_rail";
  return null;
}

function paymentSnapshotFromOrder(order: JsonRecord): {
  providerPaymentId: string | null;
  paymentMethodId: string | null;
  cardLast4: string | null;
  cardBrand: string | null;
  cardExp: string | null;
} {
  const payments = Array.isArray(order.payments) ? order.payments as JsonRecord[] : [];
  const payment = payments.length ? payments[payments.length - 1] : {};
  const method = recordOrEmpty(payment.payment_method);
  const card = recordOrEmpty(method.card);
  const expMonth = stringOrNull(card.expiry_month) ?? stringOrNull(card.exp_month);
  const expYear = stringOrNull(card.expiry_year) ?? stringOrNull(card.exp_year);
  const cardExp = expMonth && expYear
    ? `${expMonth.padStart(2, "0")}/${expYear.length === 4 ? expYear.slice(-2) : expYear}`
    : stringOrNull(card.expiry);
  return {
    providerPaymentId: stringOrNull(payment.id),
    paymentMethodId: stringOrNull(method.id) ?? stringOrNull(payment.payment_method_id),
    cardLast4: stringOrNull(card.last4) ?? stringOrNull(method.last4),
    cardBrand: stringOrNull(card.brand) ?? stringOrNull(method.brand),
    cardExp,
  };
}

async function commitOrderPlan(
  db: SupabaseClient,
  userId: string,
  eventType: string,
  meta: JsonRecord,
  orderId: string | null,
): Promise<OrderPlanCommitResult> {
  if (eventType !== "ORDER_COMPLETED" && eventType !== "ORDER_AUTHORISED") {
    return { effectiveAt: null, rejectedAs: null };
  }
  const kind = String(meta.kind ?? "").toLowerCase();
  // Resubscribe recurring terms are committed only by the locked terminal
  // reconciliation RPC after a real capture. This helper handles validation-
  // hold checkouts only.
  if (kind !== "trial_setup" && kind !== "plan_change") {
    return { effectiveAt: null, rejectedAs: null };
  }
  const plan = planForMeta(meta);
  const period = String(meta.period ?? "").toLowerCase() === "annual" ? "annual" : "monthly";
  const metaAmount = Number(meta.amount_cents);
  const amount = (Number.isFinite(metaAmount) && metaAmount >= 100 && metaAmount <= 99999)
    ? Math.round(metaAmount)
    : (await getPrices(db))[plan]?.[period];
  if (!amount) throw new Error("checkout plan amount is not committable");
  // Conditions promo « N périodes » stampées à l'ouverture du checkout —
  // absentes (vieil ordre) = réduction à vie, comportement historique.
  const metaBase = Number(meta.base_amount_cents);
  const metaCycles = Number(meta.promo_cycles);
  const promoCycles = (Number.isFinite(metaCycles) && metaCycles >= 1 && metaCycles <= 24) ? Math.round(metaCycles) : null;
  const promoBase = (promoCycles && Number.isFinite(metaBase) && metaBase > amount && metaBase <= 99999) ? Math.round(metaBase) : null;
  const nowIso = new Date().toISOString();
  if (kind === "plan_change") {
    const { data: current, error: currentError } = await db.from("cloud_entitlement_projection")
      .select("status,provider,trial_ends_at,current_period_end")
      .eq("user_id", userId).maybeSingle();
    if (currentError) throw new Error(`plan change projection read failed: ${currentError.message}`);
    const provider = String((current as { provider?: string } | null)?.provider ?? "").toLowerCase();
    const currentProjection = current as { status?: string; trial_ends_at?: string; current_period_end?: string } | null;
    const effectiveAt = stringOrNull(currentProjection?.status === "trialing"
      ? (currentProjection?.trial_ends_at ?? currentProjection?.current_period_end)
      : currentProjection?.current_period_end);
    if (provider !== "revolut" || !effectiveAt || new Date(effectiveAt).getTime() <= Date.now()) {
      throw new Error("plan change is not eligible for the next Revolut cycle");
    }
    const { error } = await db.from("cloud_revolut_customers").upsert({
      user_id: userId,
      pending_plan: plan,
      pending_period: period,
      pending_amount_cents: amount,
      pending_base_amount_cents: promoBase,
      pending_promo_cycles: promoBase ? promoCycles : null,
      pending_effective_at: effectiveAt,
      pending_order_id: orderId,
      updated_at: nowIso,
    }, { onConflict: "user_id" });
    if (error) {
      const rejectedAs = mappingGuardFinalization(error.message);
      if (rejectedAs) return { effectiveAt: null, rejectedAs };
      throw new Error(`pending plan commit failed: ${error.message}`);
    }
    return { effectiveAt, rejectedAs: null };
  }
  const { error } = await db.from("cloud_revolut_customers").upsert({
    user_id: userId, plan, period, amount_cents: amount,
    base_amount_cents: promoBase, promo_cycles_left: promoBase ? promoCycles : null,
    pending_plan: null, pending_period: null, pending_amount_cents: null,
    pending_base_amount_cents: null, pending_promo_cycles: null,
    pending_effective_at: null, pending_order_id: null,
    updated_at: nowIso,
  }, { onConflict: "user_id" });
  if (error) {
    const rejectedAs = mappingGuardFinalization(error.message);
    if (rejectedAs) return { effectiveAt: null, rejectedAs };
    throw new Error(`plan commit failed: ${error.message}`);
  }
  return { effectiveAt: null, rejectedAs: null };
}

// --- signature verification -------------------------------------------------

async function verifySignature(req: Request, raw: string): Promise<boolean> {
  if (!SIGNING_SECRET) {
    console.error("[norva-revolut-webhook] REVOLUT_WEBHOOK_SIGNING_SECRET is not set");
    return false; // fail closed
  }
  const ts = req.headers.get("Revolut-Request-Timestamp") ?? "";
  const sigHeader = req.headers.get("Revolut-Signature") ?? "";
  if (!ts || !sigHeader) return false;
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > TOLERANCE_MS) {
    console.warn("[norva-revolut-webhook] stale or invalid timestamp");
    return false;
  }
  const expected = "v1=" + (await hmacHex(SIGNING_SECRET, `v1.${ts}.${raw}`));
  // The header can carry multiple space-separated signatures during key rotation.
  return sigHeader.split(/\s+/).filter(Boolean).some((s) => timingSafeEqual(s, expected));
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

// --- persistence helpers ----------------------------------------------------

async function applyNonCheckoutProjectionPatch(
  db: SupabaseClient,
  userId: string,
  eventId: string,
  patch: JsonRecord,
): Promise<string | null> {
  const eventAt = stringOrNull(patch.last_event_at);
  if (!eventAt) throw new Error("non-checkout projection has no authoritative event time");
  const { data, error } = await db.rpc("apply_revolut_entitlement_event", {
    p_user_id: userId,
    p_event_at: eventAt,
    p_event_id: eventId,
    p_patch: patch,
  });
  if (error) throw new Error(`projection causal apply failed: ${error.message}`);
  const outcome = (Array.isArray(data) ? data[0] : data) as {
    applied?: boolean;
    result?: string;
  } | null;
  if (outcome?.applied) return null;
  return stringOrNull(outcome?.result) ?? "not_applied";
}

async function alreadyProcessed(db: SupabaseClient, eventId: string): Promise<boolean> {
  const { data, error } = await db
    .from("cloud_entitlement_events")
    .select("id")
    .eq("provider", "revolut")
    .eq("provider_event_id", eventId)
    .maybeSingle();
  if (error) return false; // read error → reprocess (upsert is idempotent)
  return Boolean(data);
}

async function recordProcessedEvent(
  db: SupabaseClient,
  userId: string,
  eventId: string | null,
  eventType: string,
  payload: JsonRecord,
): Promise<void> {
  const { error } = await db.from("cloud_entitlement_events").insert({
    user_id: userId,
    provider: "revolut",
    provider_event_id: eventId,
    event_type: eventType || "unknown",
    payload,
    processed_at: new Date().toISOString(),
  });
  if (error && (error as { code?: string }).code !== "23505") {
    throw new Error(`event insert failed: ${error.message}`);
  }
}

// --- small utilities --------------------------------------------------------

function resolveUserId(meta: JsonRecord): string | null {
  const id = stringOrNull(meta.user_id) ?? stringOrNull(meta.userId);
  return id && UUID_RE.test(id) ? id : null;
}

function recordOrEmpty(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t.length ? t : null;
}

function isoTimestampOrNull(value: unknown): string | null {
  const raw = stringOrNull(value);
  if (!raw) return null;
  const millis = new Date(raw).getTime();
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
