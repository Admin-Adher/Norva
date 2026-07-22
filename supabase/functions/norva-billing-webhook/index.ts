// Norva — RevenueCat billing webhook.
//
// RevenueCat is the source of truth for subscriptions across every rail
// (Google Play for the APKs, RevenueCat Web Billing / Stripe for the browser).
// This function receives RevenueCat webhook events and reconciles them into the
// `cloud_entitlement_projection` cache that Norva Cloud reads to make access
// decisions (see ../_shared/entitlements.ts).
//
// Design notes:
//   * App User ID == Supabase auth user id. The app calls Purchases.logIn(userId)
//     so a customer's purchases on phone / tablet / TV / web all aggregate under
//     one account. `event.app_user_id` is therefore our `user_id`.
//   * Idempotency: every event is recorded in `cloud_entitlement_events` keyed by
//     (provider, provider_event_id). RevenueCat may retry, so a duplicate event
//     id is acknowledged with 200 and skipped.
//   * The projection stores no limit overrides; the read path (entitlements.ts)
//     applies the current plan-catalog limits, so catalog changes take effect
//     immediately without the webhook keeping a copy of the catalog.
//
// Configure in the RevenueCat dashboard → Integrations → Webhooks:
//   * URL:    https://<project-ref>.supabase.co/functions/v1/norva-billing-webhook
//   * Header: Authorization: <the secret you also set in NORVA_REVENUECAT_WEBHOOK_AUTH>
//
// Required env / secrets:
//   * SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (standard)
//   * NORVA_REVENUECAT_WEBHOOK_AUTH  — shared secret matched against the
//     Authorization header RevenueCat sends.
// Optional:
//   * NORVA_RC_PRODUCT_MAP — JSON object mapping store product ids -> plan code,
//     e.g. {"norva_family_monthly":"family","norva_family_annual":"family"}.
//     Unknown products are journaled as UNKNOWN_PRODUCT_ID. Only an explicit
//     Plus/Family product token or entitlement is accepted as a safe fallback.
//   * NORVA_BILLING_FAIL_OPEN_HOURS — grace window applied on billing issues
//     (default 72).

import { createClient } from "npm:@supabase/supabase-js@2";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  canGrantRevenueCatAccess,
  isKnownStorePlan,
  isRevenueCatProvider,
  parseRevenueCatProductMap,
  resolveRevenueCatPlan,
  shouldRejectUnmappedRevenueCatEvent,
} from "../_shared/billing-policy.mjs";

type JsonRecord = Record<string, unknown>;
type ProjectionSnapshot = {
  plan_code?: string;
  provider?: string;
  status?: string;
  current_period_end?: string | null;
  trial_ends_at?: string | null;
  fail_open_until?: string | null;
  last_event_at?: string | null;
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SECRET_KEY") ??
  "";
const WEBHOOK_AUTH = Deno.env.get("NORVA_REVENUECAT_WEBHOOK_AUTH") ?? "";
const FAIL_OPEN_HOURS = boundedInt(Deno.env.get("NORVA_BILLING_FAIL_OPEN_HOURS"), 72, 1, 24 * 14);
const DEFAULT_PRODUCT_MAP = {
  norva_plus_monthly: "plus", norva_plus_annual: "plus",
  norva_family_monthly: "family", norva_family_annual: "family",
  "norva_plus:monthly": "plus", "norva_plus:annual": "plus",
  "norva_family:monthly": "family", "norva_family:annual": "family",
};
const PRODUCT_MAP = parseRevenueCatProductMap(Deno.env.get("NORVA_RC_PRODUCT_MAP"), DEFAULT_PRODUCT_MAP);
const UNKNOWN_PRODUCT_POLICY = (Deno.env.get("NORVA_RC_UNKNOWN_PRODUCT_POLICY") ?? "error").toLowerCase() === "error"
  ? "error"
  : "warn";
const ACCEPT_SANDBOX = (Deno.env.get("NORVA_RC_ACCEPT_SANDBOX") ?? "false").toLowerCase() === "true";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }
  if (!verifyAuth(req)) {
    return json({ error: "Unauthorized" }, 401);
  }

  let body: JsonRecord;
  try {
    body = await req.json();
  } catch (_) {
    return json({ error: "Invalid JSON" }, 400);
  }

  const event = (body?.event ?? {}) as JsonRecord;
  const eventType = String(event.type ?? "").toUpperCase();
  const eventId = stringOrNull(event.id);
  const causalEventId = eventId ?? `${eventType}:${String(event.event_timestamp_ms ?? "missing")}:${String(event.transaction_id ?? "none")}`;

  // RevenueCat "Send test event" — acknowledge so the dashboard goes green.
  if (eventType === "TEST") {
    return json({ ok: true, test: true });
  }

  const purchaseEnvironment = String(event.environment ?? event.purchase_environment ?? "PRODUCTION").toUpperCase();
  if (purchaseEnvironment === "SANDBOX" && !ACCEPT_SANDBOX) {
    console.warn("[norva-billing-webhook] sandbox event ignored", { type: eventType, id: eventId });
    return json({ ok: true, skipped: "sandbox" });
  }

  // App User ID is our Supabase user id. Anything that isn't a known user
  // (anonymous RC ids, $RCAnonymousID:..., aliases before logIn) is ack'd and
  // skipped — returning non-2xx would make RevenueCat retry forever.
  const userId = resolveUserId(event);
  if (!userId) {
    console.warn("[norva-billing-webhook] unmapped app_user_id", {
      type: eventType,
      app_user_id: event.app_user_id,
    });
    return json({ ok: true, skipped: "unmapped_user" });
  }

  try {
    // Idempotency: if this event id is already recorded, ack and skip.
    if (eventId && (await alreadyProcessed(admin, eventId))) {
      return json({ ok: true, duplicate: true });
    }

    // Reconcile the projection first (idempotent upsert keyed by user_id), then
    // record the event as processed. Recording last means a transient failure
    // leaves no event row, so RevenueCat's retry safely reprocesses.
    const effective = effectiveEvent(eventType, event);
    const periodType = String(effective.period_type ?? "").toUpperCase();
    const reconcilesProjection = statusForEvent(
      eventType,
      periodType === "TRIAL" || periodType === "INTRO",
      effective,
    ) !== null;
    let existingProjection: ProjectionSnapshot | null = null;
    if (reconcilesProjection) {
      const { data: existing, error: existingError } = await admin.from("cloud_entitlement_projection")
        .select("plan_code,provider,status,current_period_end,trial_ends_at,fail_open_until,last_event_at")
        .eq("user_id", userId).maybeSingle();
      if (existingError) throw new Error(`existing projection read failed: ${existingError.message}`);
      existingProjection = existing as ProjectionSnapshot | null;
    }
    const resolution = resolveRevenueCatPlan(effective, PRODUCT_MAP);
    let resolvedPlan: string | null = resolution.planCode;
    if (reconcilesProjection && resolution.mapping === "unknown") {
      const currentPlan = String(existingProjection?.plan_code ?? "").toLowerCase();
      const sameRail = isRevenueCatProvider(existingProjection?.provider);
      if (sameRail && isKnownStorePlan(currentPlan)) resolvedPlan = currentPlan;
      const signalId = `${eventId ?? `${eventType}:${userId}:${String(event.event_timestamp_ms ?? "unknown")}`}:unknown_product`;
      await recordProcessedEvent(admin, userId, signalId, "UNKNOWN_PRODUCT_ID", {
        product_id: effective.product_id ?? null,
        new_product_id: event.new_product_id ?? null,
        entitlement_ids: effective.entitlement_ids ?? [],
        preserved_plan: resolvedPlan,
        preserved_existing_plan: sameRail && isKnownStorePlan(currentPlan),
        existing_provider: existingProjection?.provider ?? null,
        source_event_id: eventId,
      });
      console.error("[norva-billing-webhook] UNKNOWN_PRODUCT_ID", {
        product_id: effective.product_id, user_id: userId, preserved_plan: resolvedPlan,
      });
      // Never acknowledge a purchase/grant that cannot be mapped to a safe tier.
      // Throwing before both the payment ledger and the source event marker keeps
      // the original RevenueCat delivery retryable after the product map is fixed.
      // A known projection from this same rail is safe to preserve and may proceed.
      if (shouldRejectUnmappedRevenueCatEvent(eventType, resolvedPlan, UNKNOWN_PRODUCT_POLICY)) {
        throw new Error(`unmapped RevenueCat product: ${resolution.productId || "(missing)"}`);
      }
    }
    const patch = projectionPatch(userId, eventType, event, resolvedPlan);
    let projectionApplied = false;
    if (patch) {
      const { data, error } = await admin.rpc("apply_revenuecat_entitlement_event", {
        p_user_id: userId,
        p_event_at: String(patch.last_event_at),
        p_event_id: causalEventId,
        p_patch: patch,
      });
      if (error) throw new Error(`projection monotonic apply failed: ${error.message}`);
      projectionApplied = Boolean((data as { applied?: boolean }[] | null)?.[0]?.applied);
      if (!projectionApplied && existingProjection && !isRevenueCatProvider(existingProjection.provider)) {
        const signalId = `${eventId ?? `${eventType}:${userId}:${String(event.event_timestamp_ms ?? "unknown")}`}:cross_rail`;
        await recordProcessedEvent(admin, userId, signalId, "CROSS_RAIL_EVENT_IGNORED", {
          source_event_id: eventId,
          event_type: eventType,
          incoming_provider: patch.provider,
          existing_provider: existingProjection.provider ?? null,
          existing_status: existingProjection.status ?? null,
        });
      }
    }

    // Journal the mobile charge into the shared payments ledger (cloud_billing_ledger,
    // rail-tagged) so collected / conversions / recent-payments / by-rail KPIs see
    // Play & Apple revenue alongside the web rail's own order journal.
    await journalRcPayment(admin, userId, eventType, event, resolvedPlan);

    await recordProcessedEvent(admin, userId, eventId, eventType, {
      ...event,
      _norva: {
        projection_applied: projectionApplied,
        plan_mapping: resolution.mapping,
        previous_status: existingProjection?.status ?? null,
        previous_plan: existingProjection?.plan_code ?? null,
        previous_provider: existingProjection?.provider ?? null,
        next_status: patch?.status ?? existingProjection?.status ?? null,
        next_plan: patch?.plan_code ?? existingProjection?.plan_code ?? resolvedPlan ?? null,
        current_period_end: patch?.current_period_end ?? existingProjection?.current_period_end ?? null,
      },
    });
    return json({
      ok: true,
      type: eventType,
      plan: patch?.plan_code ?? null,
      plan_mapping: resolution.mapping,
      projection_applied: projectionApplied,
    });
  } catch (error) {
    // 5xx so RevenueCat retries with backoff.
    const message = error instanceof Error ? error.message : "Unexpected error";
    console.error("[norva-billing-webhook]", eventType, message);
    return json({ error: message }, 500);
  }
});

// --- event -> projection mapping -------------------------------------------

function projectionPatch(
  userId: string,
  type: string,
  rawEvent: JsonRecord,
  resolvedPlan?: string | null,
): JsonRecord | null {
  // PRODUCT_CHANGE is informational: a downgrade can be deferred. The later
  // RENEWAL/INITIAL_PURCHASE is the authoritative event that changes access.
  const event = effectiveEvent(type, rawEvent);
  const periodType = String(event.period_type ?? "").toUpperCase();
  const isTrial = periodType === "TRIAL" || periodType === "INTRO";
  const status = statusForEvent(type, isTrial, event);
  if (!status) return null; // nothing to reconcile (e.g. TRANSFER — TODO below)

  const planCode = isKnownStorePlan(resolvedPlan) ? String(resolvedPlan).toLowerCase() : null;
  if (!planCode) return null;
  if (!canGrantRevenueCatAccess(type, event)) return null;
  const periodEnd = msToIso(event.expiration_at_ms);
  const eventAt = msToIso(event.event_timestamp_ms);
  if (!eventAt) return null;
  const nowIso = new Date().toISOString();

  const patch: JsonRecord = {
    user_id: userId,
    provider: providerForStore(stringOrNull(event.store)),
    provider_customer_id: stringOrNull(event.original_app_user_id) ?? stringOrNull(event.app_user_id),
    plan_code: planCode,
    status,
    // Store no per-user overrides: the read path (entitlements.ts
    // normalizeLimits) always layers the CURRENT plan-catalog limits over this,
    // so catalog changes apply immediately and the webhook keeps no copy of it.
    limits: {},
    last_verified_at: nowIso,
    last_event_at: eventAt,
    fail_open_until: type === "BILLING_ISSUE"
      ? new Date(Date.now() + FAIL_OPEN_HOURS * 60 * 60 * 1000).toISOString()
      : null,
  };

  if (periodEnd) patch.current_period_end = periodEnd;

  // Only stamp the trial fields while actually in a trial period; once the
  // subscription converts we leave the historical trial_ends_at untouched.
  if (isTrial) {
    patch.trial_ends_at = periodEnd;
    patch.trial_consumed_at = msToIso(event.purchased_at_ms) ?? nowIso;
  }

  // Storefront country (RC top-level `country_code`) — high-trust source for the
  // customer's country. Only stamp when present so country-less events (some
  // cancels/expirations) never null an already-known country.
  const country = countryOf(event);
  if (country) {
    patch.country_code = country;
    patch.country_source = "store";
  }

  // Recurring price + cadence for the cross-rail finance rollup. The web rail keeps its
  // own price/cadence separately; this gives the mobile rails
  // (Play/Apple) the equivalent so admin_finance can compute their MRR. Only stamp
  // when a price is present, so price-less events (cancel/expire) never null it.
  const baseCents = basePriceCents(event);
  if (baseCents != null) {
    patch.mrr_cents = baseCents;
    patch.bill_period = billPeriodForEvent(event);
  }

  // TODO(transfer): handle the TRANSFER event by moving the entitlement from
  // the previous app_user_id to the new one (e.g. account merge). Skipped for
  // now — see RevenueCat "transferred_from"/"transferred_to".

  return patch;
}

function statusForEvent(type: string, isTrial: boolean, event: JsonRecord = {}): string | null {
  switch (type) {
    case "INITIAL_PURCHASE":
    case "RENEWAL":
    case "UNCANCELLATION":
    case "NON_RENEWING_PURCHASE":
    case "SUBSCRIPTION_EXTENDED":
    case "REFUND_REVERSED":
      return isTrial ? "trialing" : "active";
    case "PRODUCT_CHANGE":
      return null;
    case "CANCELLATION":
      // RevenueCat uses CANCELLATION + CUSTOMER_SUPPORT for an issued refund.
      // Its own contract says that this does not prove auto-renewal was disabled,
      // so the refund is journaled and emailed below without mutating access. A
      // later EXPIRATION remains the authoritative revocation signal.
      if (isRefundCancellation(event)) return null;
      // Still entitled until current_period_end; just won't auto-renew.
      return "cancelled_at_period_end";
    case "BILLING_ISSUE":
      return "past_due";
    case "SUBSCRIPTION_PAUSED":
      // Access remains valid until EXPIRATION. Do not label a scheduled pause
      // as a failed-payment grace state.
      return "cancelled_at_period_end";
    case "EXPIRATION":
      return "expired";
    default:
      return null;
  }
}

function isRefundCancellation(event: JsonRecord): boolean {
  return String(event.cancel_reason ?? "").trim().toUpperCase() === "CUSTOMER_SUPPORT";
}

function providerForStore(store: string | null): string {
  switch ((store ?? "").toUpperCase()) {
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

// Base (store) price in cents — the recurring price of record for MRR. RC sends
// `price` as a decimal in the product's currency; assume the product is USD-based
// like the web plans. Null when absent (e.g. cancellation/expiration events).
function basePriceCents(event: JsonRecord): number | null {
  const p = Number(event.price);
  return Number.isFinite(p) && p > 0 ? Math.round(p * 100) : null;
}

type RcMoney = { cents: number; currency: string };

function rcCurrency(event: JsonRecord): string | null {
  const value = (stringOrNull(event.currency) ?? "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(value) ? value.toLowerCase() : null;
}

// Prefer the buyer-currency amount only when RevenueCat also supplies its ISO
// currency. Otherwise fall back to RevenueCat's USD `price`; never label an
// unknown local amount as USD. Values are gross of store commission.
function paidMoney(event: JsonRecord): RcMoney | null {
  const local = Number(event.price_in_purchased_currency);
  const localCurrency = rcCurrency(event);
  if (Number.isFinite(local) && local > 0 && localCurrency) {
    return { cents: Math.round(local * 100), currency: localCurrency };
  }
  const usd = Number(event.price);
  return Number.isFinite(usd) && usd > 0
    ? { cents: Math.round(usd * 100), currency: "usd" }
    : null;
}

function refundedMoney(event: JsonRecord): RcMoney | null {
  const local = Number(event.price_in_purchased_currency);
  const localCurrency = rcCurrency(event);
  if (Number.isFinite(local) && local < 0 && localCurrency) {
    return { cents: Math.round(Math.abs(local) * 100), currency: localCurrency };
  }
  const usd = Number(event.price);
  return Number.isFinite(usd) && usd < 0
    ? { cents: Math.round(Math.abs(usd) * 100), currency: "usd" }
    : null;
}

// ISO 3166-1 alpha-2 storefront country of the subscriber, or null.
function countryOf(event: JsonRecord): string | null {
  const c = stringOrNull(event.country_code);
  return c && /^[A-Za-z]{2}$/.test(c) ? c.toUpperCase() : null;
}

// A PRODUCT_CHANGE event's `product_id` is the product being LEFT; the product the
// subscriber switched to arrives in `new_product_id`. Return a view of the event
// where product_id describes the NEW product, so every derivation downstream
// (plan code, billing cadence) follows the switch. All other event types pass through.
function effectiveEvent(type: string, event: JsonRecord): JsonRecord {
  if (type !== "PRODUCT_CHANGE") return event;
  const next = stringOrNull(event.new_product_id);
  return next
    ? { ...event, product_id: next }
    : { ...event, product_id: null, entitlement_ids: [] };
}

// monthly | annual, from the product id, else the purchased→expiration span.
function billPeriodForEvent(event: JsonRecord): string {
  const pid = (stringOrNull(event.product_id) ?? "").toLowerCase();
  if (/(annual|yearly|year|_1y|p1y|yr)/.test(pid)) return "annual";
  if (/(month|_1m|p1m|mo)/.test(pid)) return "monthly";
  const start = Number(event.purchased_at_ms);
  const end = Number(event.expiration_at_ms);
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
    return (end - start) / 86_400_000 > 300 ? "annual" : "monthly";
  }
  return "monthly";
}

// Insert a rail-tagged payment row for a real (non-trial) mobile charge, mirroring
// the web-rail journal. Idempotent on pi_id (`rc_<transaction_id>`), so RC retries
// and the whole-event idempotency guard both no-op safely.
// PRODUCT_CHANGE is deliberately not journaled as cash: it can be deferred and
// RevenueCat does not report the eventual prorated store transaction here.
async function journalRcPayment(
  db: SupabaseClient,
  userId: string,
  type: string,
  rawEvent: JsonRecord,
  resolvedPlan?: string | null,
): Promise<void> {
  const event = effectiveEvent(type, rawEvent);
  if (type === "CANCELLATION" && isRefundCancellation(event)) {
    // CUSTOMER_SUPPORT is authoritative for the fact of a refund, but a missing
    // or zero amount is not enough to create a financial row. The lifecycle
    // event is still recorded later and can produce a confirmation without an
    // amount; finance remains fail-closed rather than inventing money.
    const refund = refundedMoney(event);
    if (!refund || refund.cents <= 0 || refund.cents > 9_999_999) return;
    const eventId = stringOrNull(event.id);
    const txId = stringOrNull(event.transaction_id) ?? stringOrNull(event.original_transaction_id);
    const refundIdentity = eventId ?? txId;
    if (!refundIdentity) return;
    const { error } = await db.from("cloud_billing_ledger").upsert({
      pi_id: `rc_refund_${refundIdentity}`,
      user_id: userId,
      kind: "refund",
      amount: refund.cents,
      currency: refund.currency,
      status: "refunded",
      provider: providerForStore(stringOrNull(event.store)),
      order_id: txId,
      country_code: countryOf(event),
      plan_code: isKnownStorePlan(resolvedPlan) ? String(resolvedPlan).toLowerCase() : null,
      bill_period: billPeriodForEvent(event),
      billing_period_end: msToIso(event.expiration_at_ms),
    }, { onConflict: "pi_id", ignoreDuplicates: true });
    if (error && (error as { code?: string }).code !== "23505") {
      throw new Error(`rc refund journal failed: ${error.message}`);
    }
    return;
  }

  const MONEY = new Set(["INITIAL_PURCHASE", "RENEWAL", "NON_RENEWING_PURCHASE"]);
  if (!MONEY.has(type)) return;
  const periodType = String(event.period_type ?? "").toUpperCase();
  if (periodType === "TRIAL" || periodType === "INTRO") return; // no cash during a trial/intro
  const money = paidMoney(event);
  if (!money || money.cents > 9_999_999) return;
  const txId = stringOrNull(event.transaction_id) ?? stringOrNull(event.id);
  if (!txId) return;

  const { error } = await db.from("cloud_billing_ledger").upsert({
    pi_id: `rc_${txId}`,
    user_id: userId,
    kind: type === "RENEWAL" ? "renewal" : "first_charge",
    amount: money.cents,
    currency: money.currency,
    status: "captured",
    provider: providerForStore(stringOrNull(event.store)),
    order_id: txId,
    // Transaction-time country (VAT/OSS record). NB: for store rails the STORE is the
    // deemed supplier for EU VAT — this is analytics/audit context, not a tax base.
    country_code: countryOf(event),
    plan_code: isKnownStorePlan(resolvedPlan) ? String(resolvedPlan).toLowerCase() : null,
    bill_period: billPeriodForEvent(event),
    billing_period_end: msToIso(event.expiration_at_ms),
  }, { onConflict: "pi_id", ignoreDuplicates: true });
  if (error && (error as { code?: string }).code !== "23505") {
    throw new Error(`rc payment journal failed: ${error.message}`);
  }
}

// --- persistence helpers ----------------------------------------------------

async function alreadyProcessed(db: SupabaseClient, eventId: string): Promise<boolean> {
  const { data, error } = await db
    .from("cloud_entitlement_events")
    .select("id")
    .eq("provider", "revenuecat")
    .eq("provider_event_id", eventId)
    .maybeSingle();
  if (error) return false; // on a read error, fall through and reprocess (idempotent)
  return Boolean(data);
}

async function recordProcessedEvent(
  db: SupabaseClient,
  userId: string,
  eventId: string | null,
  eventType: string,
  event: JsonRecord,
): Promise<void> {
  const { error } = await db.from("cloud_entitlement_events").insert({
    user_id: userId,
    provider: "revenuecat",
    provider_event_id: eventId,
    event_type: eventType || "unknown",
    payload: event,
    processed_at: new Date().toISOString(),
  });
  // 23505 = unique_violation: a concurrent delivery already recorded it. Fine.
  if (error && (error as { code?: string }).code !== "23505") {
    throw new Error(`event insert failed: ${error.message}`);
  }
}

// --- small utilities --------------------------------------------------------

function resolveUserId(event: JsonRecord): string | null {
  const id = stringOrNull(event.app_user_id);
  if (id && UUID_RE.test(id)) return id;
  // RevenueCat may deliver the canonical id under original_app_user_id.
  const original = stringOrNull(event.original_app_user_id);
  if (original && UUID_RE.test(original)) return original;
  return null;
}

function verifyAuth(req: Request): boolean {
  if (!WEBHOOK_AUTH) {
    // Fail closed: never accept unauthenticated webhooks in any environment.
    console.error("[norva-billing-webhook] NORVA_REVENUECAT_WEBHOOK_AUTH is not set");
    return false;
  }
  const header = req.headers.get("Authorization") ?? "";
  const presented = header.replace(/^Bearer\s+/i, "").trim();
  return timingSafeEqual(presented, WEBHOOK_AUTH);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function msToIso(value: unknown): string | null {
  const ms = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
