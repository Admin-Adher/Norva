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
//     Set this once the Play / Web products exist. Until then a best-effort
//     name heuristic is used.
//   * NORVA_BILLING_FAIL_OPEN_HOURS — grace window applied on billing issues
//     (default 72).

import { createClient } from "npm:@supabase/supabase-js@2";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

type JsonRecord = Record<string, unknown>;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SECRET_KEY") ??
  "";
const WEBHOOK_AUTH = Deno.env.get("NORVA_REVENUECAT_WEBHOOK_AUTH") ?? "";
const FAIL_OPEN_HOURS = boundedInt(Deno.env.get("NORVA_BILLING_FAIL_OPEN_HOURS"), 72, 1, 24 * 14);
const PRODUCT_MAP = parseProductMap(Deno.env.get("NORVA_RC_PRODUCT_MAP"));

const VALID_PLAN_CODES = new Set(["trial", "plus", "family", "premium", "manual", "none"]);
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

  // RevenueCat "Send test event" — acknowledge so the dashboard goes green.
  if (eventType === "TEST") {
    return json({ ok: true, test: true });
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
    const patch = projectionPatch(userId, eventType, event);
    if (patch) {
      const { error } = await admin
        .from("cloud_entitlement_projection")
        .upsert(patch, { onConflict: "user_id" });
      if (error) throw new Error(`projection upsert failed: ${error.message}`);
    }

    // Journal the mobile charge into the shared payments ledger (cloud_stancer_payments,
    // rail-tagged) so collected / conversions / recent-payments / by-rail KPIs see
    // Play & Apple revenue — Stancer already journals its own charges.
    await journalRcPayment(admin, userId, eventType, event);

    await recordProcessedEvent(admin, userId, eventId, eventType, event);
    return json({ ok: true, type: eventType, plan: patch?.plan_code ?? null });
  } catch (error) {
    // 5xx so RevenueCat retries with backoff.
    const message = error instanceof Error ? error.message : "Unexpected error";
    console.error("[norva-billing-webhook]", eventType, message);
    return json({ error: message }, 500);
  }
});

// --- event -> projection mapping -------------------------------------------

function projectionPatch(userId: string, type: string, event: JsonRecord): JsonRecord | null {
  const periodType = String(event.period_type ?? "").toUpperCase();
  const isTrial = periodType === "TRIAL" || periodType === "INTRO";
  const status = statusForEvent(type, isTrial);
  if (!status) return null; // nothing to reconcile (e.g. TRANSFER — TODO below)

  const planCode = planForEvent(event);
  const periodEnd = msToIso(event.expiration_at_ms);
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
    current_period_end: periodEnd,
    last_verified_at: nowIso,
    last_event_at: msToIso(event.event_timestamp_ms) ?? nowIso,
  };

  // Only stamp the trial fields while actually in a trial period; once the
  // subscription converts we leave the historical trial_ends_at untouched.
  if (isTrial) {
    patch.trial_ends_at = periodEnd;
    patch.trial_consumed_at = msToIso(event.purchased_at_ms) ?? nowIso;
  }

  // A billing issue keeps access open for a grace window instead of cutting it
  // off immediately (matches the fail-open behaviour in entitlements.ts).
  if (type === "BILLING_ISSUE") {
    patch.fail_open_until = new Date(Date.now() + FAIL_OPEN_HOURS * 60 * 60 * 1000).toISOString();
  }

  // Recurring price + cadence for the cross-rail finance rollup. Stancer keeps its
  // own in cloud_stancer_customers.amount_cents/period; this gives the mobile rails
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

function statusForEvent(type: string, isTrial: boolean): string | null {
  switch (type) {
    case "INITIAL_PURCHASE":
    case "RENEWAL":
    case "UNCANCELLATION":
    case "PRODUCT_CHANGE":
    case "NON_RENEWING_PURCHASE":
      return isTrial ? "trialing" : "active";
    case "CANCELLATION":
      // Still entitled until current_period_end; just won't auto-renew.
      return "cancelled_at_period_end";
    case "BILLING_ISSUE":
      return "past_due";
    case "SUBSCRIPTION_PAUSED":
      return "grace";
    case "EXPIRATION":
      return "expired";
    default:
      return null;
  }
}

// Map a RevenueCat event to a Norva plan code.
//   1. Exact product id match from NORVA_RC_PRODUCT_MAP (set this in prod).
//   2. Entitlement id (if you name entitlements "plus"/"family").
//   3. Best-effort substring heuristic on the product id.
// Falls back to "plus" (entry plan) rather than blocking a paying customer.
function planForEvent(event: JsonRecord): string {
  const productId = stringOrNull(event.product_id)?.toLowerCase() ?? "";
  const mapped = productId ? PRODUCT_MAP[productId] : undefined;
  if (mapped && VALID_PLAN_CODES.has(mapped)) {
    return mapped;
  }

  const entitlements = Array.isArray(event.entitlement_ids)
    ? (event.entitlement_ids as unknown[]).map((e) => String(e).toLowerCase())
    : [];
  if (entitlements.includes("family")) return "family";
  if (entitlements.includes("plus")) return "plus";

  if (productId.includes("family")) return "family";
  if (productId.includes("plus")) return "plus";

  console.warn("[norva-billing-webhook] unmapped product, defaulting to plus", {
    product_id: event.product_id,
    entitlement_ids: event.entitlement_ids,
  });
  return "plus";
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
// like the Stancer plans. Null when absent (e.g. cancellation/expiration events).
function basePriceCents(event: JsonRecord): number | null {
  const p = Number(event.price);
  return Number.isFinite(p) && p > 0 ? Math.round(p * 100) : null;
}

// Cash actually collected for this transaction (buyer's currency). NOTE: this is
// GROSS of the 15–30% store commission; net proceeds = amount × takehome_percentage.
function paidCents(event: JsonRecord): number | null {
  const raw = event.price_in_purchased_currency ?? event.price;
  const p = Number(raw);
  return Number.isFinite(p) && p > 0 ? Math.round(p * 100) : null;
}

function currencyOf(event: JsonRecord): string {
  const c = stringOrNull(event.currency);
  return c ? c.toLowerCase() : "usd";
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
// the Stancer journal. Idempotent on pi_id (`rc_<transaction_id>`), so RC retries
// and the whole-event idempotency guard both no-op safely.
async function journalRcPayment(
  db: SupabaseClient,
  userId: string,
  type: string,
  event: JsonRecord,
): Promise<void> {
  const MONEY = new Set(["INITIAL_PURCHASE", "RENEWAL", "NON_RENEWING_PURCHASE", "PRODUCT_CHANGE"]);
  if (!MONEY.has(type)) return;
  const periodType = String(event.period_type ?? "").toUpperCase();
  if (periodType === "TRIAL" || periodType === "INTRO") return; // no cash during a trial/intro
  const cents = paidCents(event);
  if (cents == null) return;
  const txId = stringOrNull(event.transaction_id) ?? stringOrNull(event.id);
  if (!txId) return;

  const { error } = await db.from("cloud_stancer_payments").upsert({
    pi_id: `rc_${txId}`,
    user_id: userId,
    kind: type === "RENEWAL" ? "renewal" : "first_charge",
    amount: cents,
    currency: currencyOf(event),
    status: "captured",
    provider: providerForStore(stringOrNull(event.store)),
    order_id: txId,
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

function parseProductMap(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[String(k).toLowerCase()] = String(v);
    }
    return out;
  } catch (_) {
    console.error("[norva-billing-webhook] NORVA_RC_PRODUCT_MAP is not valid JSON");
    return {};
  }
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
