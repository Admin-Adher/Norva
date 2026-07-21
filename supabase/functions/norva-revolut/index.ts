// Revolut Merchant web payment rail — checkout + account actions. INERT until
// REVOLUT_SECRET_KEY is set AND the web is wired (billing-config.revolut.enabled +
// checkout-revolut.html). Companion to norva-revolut-webhook (which reconciles the
// authoritative lifecycle); this side OPENS the checkout and can finalize a return
// without waiting for the webhook (belt & braces).
//
// Model — card-upfront 7-day trial (product decision 2026-07-11):
//   /checkout opens a Revolut ORDER with capture_mode:MANUAL and a small validation
//   amount → the RevolutCheckout card field authorises it (card check, nothing
//   captured) and, with savePaymentMethodFor:"merchant", tokenises the card against
//   a Revolut customer for merchant-initiated renewals. metadata carries
//   { user_id, plan, period, kind } — the SAME contract norva-revolut-webhook reads.
//   /confirm re-fetches the order; on AUTHORISED/COMPLETED it captures the saved
//   payment method, voids the validation hold, and writes the entitlement projection.
//
// API — legacy Merchant API (/api/1.0/…, Bearer <sk_…>), the path proven end-to-end
//   against the sandbox on 2026-07-11 (the webhook re-fetches orders the same way).
//   The widget token is the order's `public_id`. Amounts are ALWAYS server-decided.
//
// Routes:
//   GET  /health   → non-secret config booleans.
//   POST /checkout → user-authed: open a trial-setup order, return the widget token.
//   POST /confirm  → user-authed: finalize a returned checkout (no webhook needed).
//   GET  /profile  → user-authed: read-only billing profile (plan + card).
//   POST /cancel   → user-authed: stop auto-renewal (access runs to period end).
//   POST /resume   → user-authed: undo a pending cancellation.

import { createClient } from "npm:@supabase/supabase-js@2";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { getCatalog, getPrices } from "../_shared/prices.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY") ?? "";
const REVOLUT_SECRET_KEY = Deno.env.get("REVOLUT_SECRET_KEY") ?? "";
// Sandbox during dev; set to https://merchant.revolut.com at production cutover.
const REVOLUT_API_BASE = (Deno.env.get("REVOLUT_API_BASE") ?? "https://sandbox-merchant.revolut.com").replace(/\/+$/, "");
const PUBLIC_SITE_ORIGIN = (Deno.env.get("NORVA_PUBLIC_SITE_ORIGIN") ?? "https://norva.tv").replace(/\/+$/, "");
const TRIAL_DAYS = 7;
// Card-validation hold (capture_mode:MANUAL → authorised, never captured, voided on
// confirm). $0.50 keeps the card-validation footprint tiny; bump via env if the sandbox rejects it.
const VALIDATION_CENTS = boundedInt(Deno.env.get("NORVA_REVOLUT_VALIDATION_CENTS"), 50, 1, 5000);
// One-shot cancel-flow counter-offer: % off the NEXT charge (applied once, then cleared).
const SAVE_OFFER_PCT = 50;
const CANCEL_REASONS = new Set(["too_expensive", "not_using", "technical", "other", "skipped"]);

// Prices are SERVER-decided (the client only sends {plan, period}) and live in the
// billing_prices table — single source, read via _shared/prices.ts (60 s cache +
// hard-coded fallback). Promos are a table update, never a code change.

const CORS ={ "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
function isTestKey(): boolean { return REVOLUT_SECRET_KEY.startsWith("sk_") && /sandbox/i.test(REVOLUT_API_BASE); }
const CHECKOUT_TTL_SECONDS = boundedInt(Deno.env.get("NORVA_REVOLUT_CHECKOUT_TTL_SECONDS"), 1800, 300, 3600);

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function checkoutIntentKey(
  userId: string,
  kind: string,
  plan: string,
  period: string,
  amount: number,
  promoBase: number | null,
  promoCycles: number | null,
  returnTo: string,
): Promise<string> {
  const fingerprint = ["v2", userId, kind, plan, period, amount, promoBase ?? "", promoCycles ?? "", returnTo].join("|");
  return `rvi_${userId.replace(/-/g, "").slice(0, 16)}_${(await sha256Hex(fingerprint)).slice(0, 24)}`;
}

async function checkoutExtRef(userId: string, intentKey: string, generation: number): Promise<string> {
  const suffix = (await sha256Hex(`${intentKey}|${generation}`)).slice(0, 14);
  return `nrv-${userId.replace(/-/g, "").slice(0, 16)}-${suffix}`;
}

type JsonRecord = Record<string, unknown>;

async function revolut(method: "GET" | "POST", path: string, body?: JsonRecord, extraHeaders?: Record<string, string>) {
  try {
    const res = await fetch(`${REVOLUT_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${REVOLUT_SECRET_KEY}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
        ...(extraHeaders ?? {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(12_000),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch (_) { /* keep raw */ }
    return { ok: res.ok, status: res.status, body: (parsed ?? {}) as JsonRecord };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: { error: "network_error", message: error instanceof Error ? error.message : String(error) } as JsonRecord,
    };
  }
}

type ExpectedCheckoutOrder = {
  extRef: string;
  userId: string;
  intentKey: string;
  kind: string;
  plan: string;
  period: string;
  amountCents: number;
};

function checkoutOrderMatches(order: JsonRecord, expected: ExpectedCheckoutOrder): boolean {
  if (String(order.merchant_order_ext_ref ?? "") !== expected.extRef) return false;
  const meta = (order.metadata && typeof order.metadata === "object") ? order.metadata as JsonRecord : {};
  return String(meta.user_id ?? "") === expected.userId
    && String(meta.intent_key ?? "") === expected.intentKey
    && String(meta.kind ?? "") === expected.kind
    && String(meta.plan ?? "") === expected.plan
    && String(meta.period ?? "") === expected.period
    && Number(meta.amount_cents) === expected.amountCents;
}

async function findOrderByExtRef(expected: ExpectedCheckoutOrder): Promise<JsonRecord | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const found = await revolut("GET", `/api/1.0/orders?merchant_order_ext_ref=${encodeURIComponent(expected.extRef)}`);
    if (found.ok) {
      const list = Array.isArray(found.body)
        ? found.body as JsonRecord[]
        : Array.isArray(found.body.orders) ? found.body.orders as JsonRecord[] : [];
      const match = list.find((o) => String(o.merchant_order_ext_ref ?? "") === expected.extRef);
      if (match?.id) {
        let candidate = match;
        // Some list API generations omit metadata. Re-fetch the exact id before
        // deciding; never fall back to an arbitrary first result.
        if (!candidate.metadata) {
          const full = await revolut("GET", `/api/1.0/orders/${encodeURIComponent(String(match.id))}`);
          if (full.ok) candidate = full.body;
        }
        if (checkoutOrderMatches(candidate, expected)) return candidate;
        console.error("[norva-revolut] ext-ref order failed ownership validation", expected.extRef, String(match.id));
        return null;
      }
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
  }
  return null;
}

// The widget token is the order's public_id (legacy) / token (new) — accept either.
function widgetToken(order: JsonRecord): string {
  return String(order.public_id ?? order.token ?? "");
}
function orderCustomerId(order: JsonRecord): string | null {
  const direct = order.customer_id;
  if (typeof direct === "string" && direct) return direct;
  const cust = order.customer;
  if (cust && typeof cust === "object" && typeof (cust as JsonRecord).id === "string") return String((cust as JsonRecord).id);
  return null;
}

// Card ISSUING country from the order's payment details (ISO alpha-2) — the customer-
// country proxy for the web rail (~95 % for consumer cards; decided 2026-07-17).
// CONFIRMED on live sandbox events (étape 0, 2026-07-17): the field is
// payments[].payment_method.card.card_country. Older candidates kept as fallback
// for other API generations; null when the order carries no payment details yet.
function cardCountryFromOrder(order: JsonRecord): string | null {
  const payments = Array.isArray(order.payments) ? order.payments as JsonRecord[] : [];
  for (const p of payments) {
    const pm = (p.payment_method && typeof p.payment_method === "object") ? p.payment_method as JsonRecord : {};
    const card = (pm.card && typeof pm.card === "object") ? pm.card as JsonRecord : {};
    const raw = card.card_country ?? pm.card_country_code ?? card.card_country_code ?? card.country_code ?? p.card_country_code;
    if (typeof raw === "string" && /^[A-Za-z]{2}$/.test(raw.trim())) return raw.trim().toUpperCase();
  }
  return null;
}

// Retrieve the card the customer just saved (for merchant-initiated renewals) — the
// order carries the customer, the saved token lives on the customer. Best-effort:
// display + renewal enrichment, never blocks starting the trial.
// Confirmed sandbox shape: GET → [{ id, type:"CARD", saved_for:"MERCHANT",
// method_details:{ last4, brand, expiry_month, expiry_year, ... } }]. SINGLE quick
// call — no retry: Revolut attaches the method a moment AFTER the order authorizes,
// so /confirm often misses it; /profile captures it lazily once it's there (off the
// user's critical path, so the edge wall-clock limit is never a factor).
async function savedCard(customerId: string): Promise<{ id?: string; last4?: string; brand?: string; exp?: string; country?: string } | null> {
  if (!customerId) return null;
  const res = await revolut("GET", `/api/1.0/customers/${encodeURIComponent(customerId)}/payment-methods`);
  if (!res.ok) return null;
  const list = Array.isArray(res.body)
    ? res.body as JsonRecord[]
    : (Array.isArray(res.body.payment_methods) ? res.body.payment_methods as JsonRecord[] : []);
  const cards = list.filter((m) => String(m.type ?? m.method_type ?? "").toUpperCase() === "CARD");
  // Prefer a MERCHANT-saved card (reusable for MIT); newest wins.
  const card = cards.reverse().find((m) => String(m.saved_for ?? "").toUpperCase() === "MERCHANT") ?? cards[0];
  if (!card) return null;
  const md = (card.method_details && typeof card.method_details === "object") ? card.method_details as JsonRecord : card;
  const em = md.expiry_month ?? md.exp_month;
  const ey = md.expiry_year ?? md.exp_year;
  // Issuing country if the payment-method shape carries it (field name varies / may be
  // absent — the order's payment details are the primary source, this is a fallback).
  const ccRaw = md.card_country ?? md.card_country_code ?? md.country_code ?? md.country ?? md.issuer_country;
  const country = (typeof ccRaw === "string" && /^[A-Za-z]{2}$/.test(ccRaw.trim())) ? ccRaw.trim().toUpperCase() : undefined;
  return {
    id: card.id ? String(card.id) : undefined,
    last4: md.last4 ? String(md.last4) : undefined,
    brand: md.brand ? String(md.brand).toUpperCase() : undefined,
    exp: (em && ey) ? `${String(em).padStart(2, "0")}/${String(ey).slice(-2)}` : undefined,
    country,
  };
}

// Create-or-reuse the Revolut customer for a user. REQUIRED for saving a card:
// savePaymentMethodFor:"merchant" only attaches the token when the order carries a
// customer_id — customer_email alone leaves the order customer-less (no saved card).
// Returns the id (rev_… ) or null on failure.
async function ensureRevolutCustomer(db: SupabaseClient, userId: string, email: string, name: string): Promise<string | null> {
  const { data: existing } = await db.from("cloud_revolut_customers")
    .select("revolut_customer_id").eq("user_id", userId).maybeSingle();
  const existingId = (existing as { revolut_customer_id?: string } | null)?.revolut_customer_id;
  if (existingId) return existingId;
  const created = await revolut("POST", "/api/1.0/customers", { full_name: name || "Norva member", email });
  const custId = created.ok ? String(created.body.id ?? "") : "";
  if (!custId) {
    console.error("[norva-revolut] create customer failed", created.status, JSON.stringify(created.body).slice(0, 300));
    return null;
  }
  return custId;
}

async function logCancelFeedback(db: SupabaseClient, userId: string, reason: string, action: "cancelled" | "saved", statusAt: string, offer?: string): Promise<void> {
  try {
    await db.from("cloud_cancel_feedback").insert({
      user_id: userId, reason: CANCEL_REASONS.has(reason) ? reason : "skipped",
      action, status_at: statusAt || null, offer: offer ?? null,
    });
  } catch (_) { /* analytics must never block a cancellation */ }
}

async function recordLifecycleBillingEvent(
  db: SupabaseClient,
  userId: string,
  providerEventId: string,
  eventType: string,
  payload: JsonRecord = {},
): Promise<string | null> {
  const { error } = await db.from("cloud_entitlement_events").upsert({
    user_id: userId,
    provider: "revolut",
    provider_event_id: providerEventId,
    event_type: eventType,
    payload,
    processed_at: new Date().toISOString(),
  }, { onConflict: "provider,provider_event_id", ignoreDuplicates: true });
  return error?.message ?? null;
}

// Internal/pilot accounts have included system access and must never enter a
// payment flow.  Fail closed on a registry read error: opening a remote checkout
// while account classification is unknown is strictly worse than asking the user
// to retry.  The database claim/trigger is the final guard; this one prevents even
// card-validation orders and profile enrichment from reaching Revolut.  The
// read-only profile endpoint returns a neutral success for included access so a
// Settings screen never turns this intentional state into a cosmetic error.
async function guardInternalBilling(
  db: SupabaseClient,
  userId: string,
  neutralIncludedProfile = false,
): Promise<Response | null> {
  const { data, error } = await db.from("admin_internal_accounts")
    .select("user_id").eq("user_id", userId).maybeSingle();
  if (error) {
    console.error("[norva-revolut] internal account check failed", userId, error.message);
    return json({ error: "Could not verify billing eligibility", code: "billing_eligibility_unavailable" }, 503);
  }
  if (data) {
    if (neutralIncludedProfile) {
      return json({ ok: true, profile: null, included_access: true });
    }
    return json({
      error: "Billing is not applicable to this included-access account",
      code: "internal_account_not_billable",
    }, 409);
  }
  return null;
}

type RevolutMappingRejection = {
  error: string;
  code: string;
  finalization: string;
};

// The database mapping trigger is the race-safe guard. Route-level checks keep
// the normal path fast and friendly; this decoder turns the trigger's late-race
// decision into the same deterministic 409 instead of a misleading 503.
function revolutMappingRejection(message: string): RevolutMappingRejection | null {
  if (message.includes("internal_account_not_billable")) {
    return {
      error: "Billing is not applicable to this included-access account",
      code: "internal_account_not_billable",
      finalization: "rejected_internal_account",
    };
  }
  if (message.includes("revolut_customer_account_blocked")) {
    return {
      error: "Billing is unavailable while this account is blocked. Contact support.",
      code: "account_billing_blocked",
      finalization: "rejected_account_blocked",
    };
  }
  if (message.includes("revolut_customer_rail_mismatch")) {
    return {
      error: "This subscription is managed by another billing provider",
      code: "billing_rail_mismatch",
      finalization: "rejected_cross_rail",
    };
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/norva-revolut/, "") || "/";

  if (req.method === "GET" && (path === "/health" || path === "/")) {
    // `env` mirrors exactly what the inert guard below checks, as SEEN by this
    // isolate — so /health tells us whether /checkout would fall inert (no values).
    return json({
      ok: true, service: "norva-revolut", configured: Boolean(REVOLUT_SECRET_KEY),
      sandbox: isTestKey(), api_base: REVOLUT_API_BASE,
      env: { url: Boolean(SUPABASE_URL), service_key: Boolean(SERVICE_KEY), revolut_key: Boolean(REVOLUT_SECRET_KEY) },
    });
  }

  if (!REVOLUT_SECRET_KEY || !SUPABASE_URL || !SERVICE_KEY) return json({ ok: false, inert: true, reason: "not_configured" });
  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // ── /prices — PUBLIC: current catalog (cents, USD) for the web pages ───────
  // `prices` are EFFECTIVE (an active promo already applied); `promos` carries the
  // struck-through base + event badge for display. Display only — every order
  // amount is still decided server-side from the same source. The pages keep
  // their static values as fallback when this is down.
  if (req.method === "GET" && path === "/prices") {
    const catalog = await getCatalog(db);
    return json({ ok: true, currency: "usd", prices: catalog.prices, promos: catalog.promos, campaign: catalog.campaign });
  }

  // ── /checkout — user-authed: open a trial-setup order ──────────────────────
  if (req.method === "POST" && path === "/checkout") {
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Not signed in" }, 401);
    const { data: u } = await db.auth.getUser(jwt);
    const user = u?.user;
    if (!user?.id || !user.email) return json({ error: "Not signed in" }, 401);
    const billingGuard = await guardInternalBilling(db, user.id);
    if (billingGuard) return billingGuard;

    let payload: { plan?: string; period?: string; returnTo?: string; intent?: string } = {};
    try { payload = await req.json(); } catch (_) { /* defaults below */ }
    const plan = payload.plan === "family" ? "family" : "plus";
    const period = payload.period === "annual" ? "annual" : "monthly";
    const catalog = await getCatalog(db);
    const amount = catalog.prices[plan]?.[period];
    if (!amount) return json({ error: "Unknown plan" }, 400);
    // Promo « N premières périodes » : le prix de base et le décompte voyagent
    // avec l'engagement (mapping + metadata) — le cron rebascule au prix de base
    // une fois les cycles promo épuisés. cycles null = réduction à vie.
    const promoInfo = catalog.promos[plan]?.[period] ?? null;
    const promoCycles = promoInfo?.cycles ?? null;
    const promoBase = promoCycles ? promoInfo!.base_cents : null;

    // ── Checkout KIND, decided SERVER-SIDE from the account's real state ───────
    // (kind decided server-side): trial_setup grants trial days ONCE;
    // plan_change swaps plan without a new trial; resubscribe reactivates; card_update
    // only swaps the card.
    const { data: projRow, error: projectionReadError } = await db.from("cloud_entitlement_projection")
      .select("status,provider,trial_consumed_at,trial_ends_at,current_period_end")
      .eq("user_id", user.id).maybeSingle();
    if (projectionReadError) return json({ error: "Could not verify current subscription" }, 503);
    const proj = projRow as { status?: string; provider?: string; trial_consumed_at?: string; trial_ends_at?: string; current_period_end?: string } | null;
    const nowMs = Date.now();
    const trialEndMs = proj?.trial_ends_at ? new Date(proj.trial_ends_at).getTime() : 0;
    const periodEndMs = proj?.current_period_end ? new Date(proj.current_period_end).getTime() : 0;
    const projStatus = String(proj?.status ?? "");
    if (new Set(["revoked", "refunded", "fraud"]).has(projStatus)) {
      return json({
        error: "Billing is unavailable while this account is blocked. Contact support.",
        code: "account_billing_blocked",
      }, 409);
    }
    const liveEntitlement =
      (projStatus === "trialing" && trialEndMs > nowMs) ||
      (projStatus === "active" && (periodEndMs === 0 || periodEndMs > nowMs)) ||
      (projStatus === "cancelled_at_period_end" && periodEndMs > nowMs);
    // An account with a LIVE entitlement can never open a trial_setup — whatever
    // the trial history. This covers manually granted accounts (VIP/admin gifts:
    // active until 2099, trial never consumed): before this guard they were
    // classed trial_setup, and paying the card check would have OVERWRITTEN the
    // grant with a 7-day trial in /confirm. plan_change preserves the existing
    // status/period fields by design.
    const currentProvider = String(proj?.provider ?? "");
    const terminalStatus = projStatus === "expired";
    const foreignRailBlocked = Boolean(proj && currentProvider && currentProvider !== "revolut" && !terminalStatus);
    let kind = "trial_setup";
    if (payload.intent === "update_card") {
      if (!proj || currentProvider !== "revolut") {
        return json({ error: "This payment method is managed by another billing provider", code: "billing_rail_mismatch" }, 409);
      }
      kind = "card_update";
    } else if (foreignRailBlocked) {
      return json({ error: "This subscription must be managed through its current billing provider", code: "billing_rail_mismatch" }, 409);
    } else if (liveEntitlement) {
      if (currentProvider !== "revolut") {
        return json({ error: "This subscription must be managed through its current billing provider", code: "billing_rail_mismatch" }, 409);
      }
      kind = "plan_change";
    }
    else if (proj?.trial_consumed_at) kind = "resubscribe";

    const returnTo = (
      typeof payload.returnTo === "string" && /^\/(?!\/)/.test(payload.returnTo) && !payload.returnTo.includes("\\")
    ) ? payload.returnTo : "";
    const intentKey = await checkoutIntentKey(user.id, kind, plan, period, amount, promoBase, promoCycles, returnTo);
    const leaseToken = crypto.randomUUID();
    type CheckoutClaim = {
      action: "create" | "recover" | "reuse" | "wait";
      order_id: string | null;
      public_id: string | null;
      checkout_url: string | null;
      expires_at: string;
      previous_order_id: string | null;
      generation: number;
    };
    const claimIntent = async (): Promise<CheckoutClaim> => {
      const { data, error } = await db.rpc("claim_revolut_checkout_intent", {
        p_intent_key: intentKey,
        p_user_id: user.id,
        p_kind: kind,
        p_plan: plan,
        p_period: period,
        p_amount_cents: amount,
        p_lease_token: leaseToken,
        p_ttl_seconds: CHECKOUT_TTL_SECONDS,
        p_lease_seconds: 180,
      });
      if (error) throw new Error(`checkout intent claim failed: ${error.message}`);
      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.action) throw new Error("checkout intent claim returned no decision");
      return row as CheckoutClaim;
    };

    let intent: CheckoutClaim;
    try { intent = await claimIntent(); }
    catch (error) {
      console.error("[norva-revolut] intent claim failed", error instanceof Error ? error.message : error);
      return json({ error: "Could not reserve checkout" }, 503);
    }

    if (intent.action === "wait") {
      // A different tab/worker owns the short creation lease. Returning 409 makes
      // the page retry the same deterministic intent; it must never POST a second
      // remote order while the winner is still in flight.
      return json({
        error: "checkout_in_progress",
        retryable: true,
        retry_after_ms: 1200,
        expires_at: intent.expires_at,
      }, 409);
    }

    if (intent.action === "reuse" && intent.order_id && intent.public_id) {
      const remote = await revolut("GET", `/api/1.0/orders/${encodeURIComponent(intent.order_id)}`);
      if (remote.ok) {
        const remoteState = String(remote.body.state ?? "PENDING").toUpperCase();
        const nowIso = new Date().toISOString();
        await db.from("cloud_revolut_orders").update({
          state: remoteState,
          last_reconciled_at: nowIso,
          updated_at: nowIso,
        }).eq("order_id", intent.order_id);
        if (["PENDING", "PROCESSING", "AUTHORISED", "COMPLETED"].includes(remoteState)) {
          return json({
            ok: true,
            order_id: intent.order_id,
            public_id: intent.public_id,
            kind,
            checkout_url: intent.checkout_url,
            sandbox: isTestKey(),
            reused: true,
            already_authorized: remoteState === "AUTHORISED" || remoteState === "COMPLETED",
            expires_at: intent.expires_at,
          });
        }
        // The cached order reached a terminal state without a Norva finalization.
        // Expire this intent, then reclaim the same fingerprint as a new generation.
        await db.from("cloud_revolut_checkout_intents")
          .update({ status: "expired", updated_at: nowIso })
          .eq("intent_key", intentKey).eq("order_id", intent.order_id);
        await db.from("cloud_revolut_orders").update({
          expired_at: nowIso, last_reconciled_at: nowIso, updated_at: nowIso,
        }).eq("order_id", intent.order_id).is("finalized_at", null);
        intent = await claimIntent();
        if (intent.action !== "create") {
          return json({ error: "checkout_in_progress", retryable: true, retry_after_ms: 1200 }, 409);
        }
      } else {
        // A transient provider read must not turn a refresh into a duplicate order.
        return json({ error: "checkout_state_unavailable", retryable: true, retry_after_ms: 1500 }, 503);
      }
    }

    // A Revolut customer is needed for the card to be saved (see helper). Create it
    // up front so the order can carry customer_id. Degrade gracefully: if creation
    // fails the trial still starts on customer_email (the card just won't be saved).
    const name = String(user.user_metadata?.display_name ?? user.user_metadata?.name ?? "").trim();
    const custId = await ensureRevolutCustomer(db, user.id, user.email, name);

    // Record the customer id on the mapping row. The recurring plan (plan/period/
    // amount_cents) is what the renewal engine charges, so WHEN it lands here depends
    // on the account's state:
    //   • trial_setup / resubscribe — no live entitlement is armed for renewal, so
    //     staging the plan now is harmless AND required: the hosted-page flow can
    //     convert via the webhook alone (no /confirm), and the cron needs the row.
    //   • plan_change — a live entitlement IS armed for renewal. Writing the new
    //     plan before payment would let an abandoned checkout (this endpoint fires
    //     on page load) reprice the next renewal to an amount the customer never
    //     approved. Staged in the order metadata below instead; committed by
    //     /confirm (or the webhook) once the order is actually paid.
    //   • card_update — must never touch plan/period (would corrupt the mapping).
    const nowIso = new Date().toISOString();
    const custRow: JsonRecord = { user_id: user.id, updated_at: nowIso };
    if (custId) custRow.revolut_customer_id = custId;
    if (kind === "trial_setup" || kind === "resubscribe") {
      custRow.plan = plan; custRow.period = period; custRow.amount_cents = amount;
      // Les nulls explicites effacent un éventuel état promo d'un checkout précédent.
      custRow.base_amount_cents = promoBase;
      custRow.promo_cycles_left = promoCycles;
      custRow.pending_plan = null; custRow.pending_period = null;
      custRow.pending_amount_cents = null; custRow.pending_base_amount_cents = null;
      custRow.pending_promo_cycles = null; custRow.pending_effective_at = null;
      custRow.pending_order_id = null;
    }
    const { error: customerStageError } = await db.from("cloud_revolut_customers").upsert(custRow);
    if (customerStageError) {
      await db.rpc("fail_revolut_checkout_intent", {
        p_intent_key: intentKey, p_lease_token: leaseToken, p_error: customerStageError.message,
      });
      const rejection = revolutMappingRejection(customerStageError.message);
      if (rejection) return json({ error: rejection.error, code: rejection.code }, 409);
      return json({ error: "Could not stage billing profile", retryable: true }, 503);
    }

    const DESCRIPTIONS: Record<string, string> = {
      trial_setup: `Norva ${plan} ${period} — card check for 7-day free trial`,
      plan_change: `Norva ${plan} ${period} — plan change (card check, not charged)`,
      resubscribe: `Norva ${plan} ${period} — resubscribe (card check; first charge follows)`,
      card_update: `Norva — payment method update (card check, not charged)`,
    };
    // capture_mode:MANUAL → authorise a small validation amount (card check), never
    // captured; the saved token (savePaymentMethodFor:"merchant" on the widget) drives
    // renewals. The plan price applies at trial end via a merchant-initiated charge.
    // After a payment on the HOSTED checkout page (the widget's fallback link), Revolut
    // must send the customer back here to finalize (capture card, void hold, start the
    // trial) — else they land on Revolut's own "payment complete" page and never return.
    // The embedded card field returns inline via onSuccess and doesn't use this.
    // Never reflect an arbitrary Origin into Revolut's post-payment redirect.
    const frontOrigin = PUBLIC_SITE_ORIGIN;
    const redirectParams = new URLSearchParams({ revolut_return: "1", plan, period });
    if (payload.intent === "update_card") redirectParams.set("intent", "update_card");
    if (returnTo) redirectParams.set("returnTo", returnTo);
    const redirectUrl = `${frontOrigin}/checkout-revolut.html?${redirectParams.toString()}`;
    const merchantExtRef = await checkoutExtRef(user.id, intentKey, Number(intent.generation || 1));
    const orderBody: JsonRecord = {
      amount: VALIDATION_CENTS,
      currency: "USD",
      capture_mode: "MANUAL",
      // Save the card for merchant-initiated renewals at the ORDER level (not only via
      // the widget submit), so the card is tokenised whichever path the customer takes —
      // the embedded card field OR the hosted checkout_url fallback (which also offers
      // Apple/Google/Revolut Pay). Without this, a payment on the fallback page would
      // leave no saved card and the renewal cron could not charge.
      save_payment_method_for: "merchant",
      redirect_url: redirectUrl,
      merchant_order_ext_ref: merchantExtRef,
      description: DESCRIPTIONS[kind],
      // amount_cents = the catalog price at checkout OPEN — /confirm commits THIS
      // amount, so a promo ending mid-checkout still honors what the page showed.
      // base_amount_cents/promo_cycles carry the « N first periods » promo terms.
      metadata: {
        user_id: user.id, plan, period, kind, amount_cents: amount,
        base_amount_cents: promoBase, promo_cycles: promoCycles,
        intent_key: intentKey, intent_generation: Number(intent.generation || 1),
      },
    };
    // customer_id links the order → customer so the saved card attaches; fall back to
    // customer_email if the customer couldn't be created.
    if (custId) orderBody.customer_id = custId; else orderBody.customer_email = user.email;
    const expectedOrder: ExpectedCheckoutOrder = {
      extRef: merchantExtRef, userId: user.id, intentKey, kind, plan, period, amountCents: amount,
    };
    // The deprecated /api/1.0 order-create contract does not document an
    // Idempotency-Key header. Its supported correlation primitive is
    // merchant_order_ext_ref, so a lease takeover must recover by that exact
    // reference before any second POST.
    let created = intent.action === "recover"
      ? { ok: false, status: 0, body: { error: "recovery_lookup_miss" } as JsonRecord }
      : await revolut("POST", "/api/1.0/orders", orderBody);
    if (intent.action === "recover") {
      const recovered = await findOrderByExtRef(expectedOrder);
      if (recovered) created = { ok: true, status: 200, body: recovered };
      else created = await revolut("POST", "/api/1.0/orders", orderBody);
    }
    if (!created.ok) {
      const recovered = await findOrderByExtRef(expectedOrder);
      if (recovered) created = { ok: true, status: 200, body: recovered };
    }
    // Safety net 1: if this API rejects customer_id on the order, retry with
    // customer_email so the trial still starts (card just won't attach here).
    if (!created.ok && created.status !== 0 && orderBody.customer_id) {
      console.warn("[norva-revolut] order w/ customer_id failed, retrying w/ email", created.status);
      delete orderBody.customer_id;
      orderBody.customer_email = user.email;
      created = await revolut("POST", "/api/1.0/orders", orderBody);
      if (!created.ok) {
        const recovered = await findOrderByExtRef(expectedOrder);
        if (recovered) created = { ok: true, status: 200, body: recovered };
      }
    }
    // Safety net 2: if the order-level save_payment_method_for is rejected, drop it and
    // retry — the widget submit still requests the save, so the card-field path keeps
    // working (only the hosted fallback loses the save). Checkout must never break here.
    if (!created.ok && created.status !== 0 && orderBody.save_payment_method_for) {
      console.warn("[norva-revolut] order w/ save_payment_method_for failed, retrying without", created.status);
      delete orderBody.save_payment_method_for;
      created = await revolut("POST", "/api/1.0/orders", orderBody);
      if (!created.ok) {
        const recovered = await findOrderByExtRef(expectedOrder);
        if (recovered) created = { ok: true, status: 200, body: recovered };
      }
    }
    const orderId = String(created.body.id ?? "");
    const token = widgetToken(created.body);
    if (!created.ok || !orderId || !token) {
      console.error("[norva-revolut] create order failed", created.status, JSON.stringify(created.body).slice(0, 400));
      if (created.status !== 0) {
        await db.rpc("fail_revolut_checkout_intent", {
          p_intent_key: intentKey, p_lease_token: leaseToken,
          p_error: JSON.stringify(created.body).slice(0, 500),
        });
      }
      return json({
        error: created.status === 0 ? "checkout_creation_uncertain" : "Could not start checkout",
        retryable: created.status === 0,
        retry_after_ms: created.status === 0 ? 1500 : undefined,
        detail: created.body,
      }, created.status === 0 ? 503 : 502);
    }

    const expiresAt = intent.expires_at || new Date(Date.now() + CHECKOUT_TTL_SECONDS * 1000).toISOString();
    const checkoutUrl = created.body.checkout_url ? String(created.body.checkout_url) : null;
    const { error: orderWriteError } = await db.from("cloud_revolut_orders").upsert({
      order_id: orderId, public_id: token, user_id: user.id, kind,
      plan, period, requested_amount_cents: amount,
      amount: VALIDATION_CENTS, currency: "USD",
      merchant_ext_ref: String(orderBody.merchant_order_ext_ref),
      intent_key: intentKey, checkout_url: checkoutUrl, expires_at: expiresAt,
      state: String(created.body.state ?? "PENDING").toUpperCase(), updated_at: new Date().toISOString(),
    });
    if (orderWriteError) {
      console.error("[norva-revolut] order journal failed", orderWriteError.message);
      return json({ error: "Could not persist checkout", retryable: true }, 503);
    }
    const { data: completedIntent, error: completeError } = await db.rpc("complete_revolut_checkout_intent", {
      p_intent_key: intentKey, p_lease_token: leaseToken, p_order_id: orderId,
    });
    if (completeError || completedIntent !== true) {
      console.error("[norva-revolut] intent completion failed", completeError?.message ?? completedIntent);
      return json({ error: "Could not finalize checkout reservation", retryable: true }, 503);
    }

    if (intent.previous_order_id && intent.previous_order_id !== orderId) {
      const supersededAt = new Date().toISOString();
      await db.from("cloud_revolut_orders").update({
        superseded_at: supersededAt, updated_at: supersededAt,
      }).eq("order_id", intent.previous_order_id).is("finalized_at", null);
      // Best-effort remote cleanup. The journal is retained for audit.
      const previous = await revolut("GET", `/api/1.0/orders/${encodeURIComponent(intent.previous_order_id)}`);
      const previousState = String(previous.body.state ?? "").toUpperCase();
      if (previous.ok && ["PENDING", "PROCESSING"].includes(previousState)) {
        const cancelled = await revolut("POST", `/api/orders/${encodeURIComponent(intent.previous_order_id)}/cancel`, undefined, { "Revolut-Api-Version": "2024-09-01" });
        await db.from("cloud_revolut_orders").update({
          state: cancelled.ok ? "CANCELLED" : previousState,
          expired_at: cancelled.ok ? supersededAt : null,
          last_reconciled_at: supersededAt,
          updated_at: supersededAt,
        }).eq("order_id", intent.previous_order_id);
      }
    }

    return json({
      ok: true, order_id: orderId, public_id: token, kind,
      checkout_url: checkoutUrl,
      sandbox: isTestKey(), reused: false, expires_at: expiresAt,
    });
  }

  // ── /confirm — user-authed: finalize a returned checkout (no webhook needed) ──
  if (req.method === "POST" && path === "/confirm") {
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Not signed in" }, 401);
    const { data: u } = await db.auth.getUser(jwt);
    const user = u?.user;
    if (!user?.id) return json({ error: "Not signed in" }, 401);
    const billingGuard = await guardInternalBilling(db, user.id);
    if (billingGuard) return billingGuard;

    let payload: { order_id?: string } = {};
    try { payload = await req.json(); } catch (_) { /* optional */ }
    let orderId = String(payload.order_id ?? "");
    if (!orderId) {
      // Hosted-checkout fallback: resolve only the user's single CURRENT intent.
      // Never pick the latest historical order — duplicate legacy rows made that
      // capable of finalizing a different plan than the one the user just paid.
      const { data: currentIntent } = await db.from("cloud_revolut_checkout_intents")
        .select("order_id").eq("user_id", user.id).eq("status", "ready")
        .gt("expires_at", new Date().toISOString()).maybeSingle();
      orderId = String((currentIntent as { order_id?: string } | null)?.order_id ?? "");
    }
    if (!orderId) return json({ ok: false, status: "no_order" });

    type CheckoutJournal = {
      order_id: string;
      kind: string;
      plan?: string | null;
      period?: string | null;
      requested_amount_cents?: number | null;
      merchant_ext_ref?: string | null;
      intent_key?: string | null;
      finalized_at?: string | null;
      expired_at?: string | null;
      superseded_at?: string | null;
      finalization_result?: JsonRecord | null;
    };
    const { data: journalRow, error: journalReadError } = await db.from("cloud_revolut_orders")
      .select("order_id,kind,plan,period,requested_amount_cents,merchant_ext_ref,intent_key,finalized_at,expired_at,superseded_at,finalization_result")
      .eq("order_id", orderId).eq("user_id", user.id).maybeSingle();
    if (journalReadError) return json({ error: "Could not read checkout journal" }, 503);
    const journal = journalRow as CheckoutJournal | null;
    if (!journal) return json({ error: "Checkout order is not owned by this account" }, 403);
    if (journal.finalized_at) {
      const finalized = (journal.finalization_result && typeof journal.finalization_result === "object")
        ? journal.finalization_result as JsonRecord : {};
      const result = String(finalized.result ?? "already_finalized");
      const statusByResult: Record<string, string> = {
        trial_started: "trialing", already_confirmed: "trialing", already_active: "active",
        resubscribed: "active", plan_change_scheduled: "plan_change_scheduled",
        card_updated: "updated", card_updated_retrying: "retrying",
      };
      if (result === "plan_change_scheduled") {
        const eventError = await recordLifecycleBillingEvent(
          db, user.id, `checkout:${orderId}:plan-change-scheduled`, "PLAN_CHANGE_SCHEDULED",
          {
            plan_label: String(journal.plan ?? finalized.pending_plan ?? "plus"),
            effective_at: finalized.effective_at ?? null,
          },
        );
        if (eventError) return json({ error: "Could not queue plan-change confirmation" }, 503);
      }
      if (result.startsWith("rejected_")) {
        return json({ error: "Checkout can no longer be applied to this billing account", code: result }, 409);
      }
      return json({
        ok: true, status: statusByResult[result] ?? "updated",
        kind: String(finalized.kind ?? journal.kind),
        effective_at: finalized.effective_at ?? null,
        idempotent: true,
      });
    }
    if (journal.expired_at || journal.superseded_at) {
      return json({
        error: "This checkout is no longer current",
        code: journal.superseded_at ? "checkout_superseded" : "checkout_expired",
      }, 409);
    }

    const fetched = await revolut("GET", `/api/1.0/orders/${encodeURIComponent(orderId)}`);
    if (!fetched.ok) return json({ ok: false, status: "not_found" });
    const order = fetched.body;
    const meta = (order.metadata && typeof order.metadata === "object") ? order.metadata as JsonRecord : {};
    if (String(meta.user_id ?? "") !== user.id) return json({ error: "Forbidden" }, 403);

    const remoteKind = String(meta.kind ?? "");
    const remotePlan = String(meta.plan ?? "") === "family" ? "family" : "plus";
    const remotePeriod = String(meta.period ?? "") === "annual" ? "annual" : "monthly";
    const remoteAmount = Number(meta.amount_cents);
    const remoteIntent = String(meta.intent_key ?? "");
    const remoteExtRef = String(order.merchant_order_ext_ref ?? "");
    if (journal.kind !== remoteKind
      || (journal.plan && journal.plan !== remotePlan)
      || (journal.period && journal.period !== remotePeriod)
      || (journal.requested_amount_cents != null && journal.requested_amount_cents !== remoteAmount)
      || (journal.intent_key && journal.intent_key !== remoteIntent)
      || (journal.merchant_ext_ref && journal.merchant_ext_ref !== remoteExtRef)) {
      console.error("[norva-revolut] checkout journal/provider mismatch", orderId);
      return json({ error: "Checkout order failed integrity validation" }, 409);
    }

    const state = String(order.state ?? "").toUpperCase();
    const observedIso = new Date().toISOString();
    const { error: observedError } = await db.from("cloud_revolut_orders").update({
      state, last_reconciled_at: observedIso, updated_at: observedIso,
    }).eq("order_id", orderId).eq("user_id", user.id);
    if (observedError) return json({ error: "Could not reconcile order" }, 503);
    const paid = state === "AUTHORISED" || state === "COMPLETED";
    if (!paid) return json({ ok: true, status: order.state, pending: true });

    const nowIso = new Date().toISOString();
    const plan = String(meta.plan ?? "plus") === "family" ? "family" : "plus";
    const kind = String(meta.kind ?? "trial_setup");
    // The order metadata is the contract of what THIS paid order was opened for.
    // The amount was stamped by /checkout at OPEN time (both are server-written —
    // the client never touches metadata), so a promo ending mid-checkout still
    // honors what the customer saw. Catalog fallback for pre-stamp orders.
    const period = String(meta.period ?? "") === "annual" ? "annual" : "monthly";
    const metaAmount = Number(meta.amount_cents);
    const amount = (Number.isFinite(metaAmount) && metaAmount >= 100 && metaAmount <= 99999)
      ? Math.round(metaAmount)
      : ((await getPrices(db))[plan]?.[period] ?? 0);
    // Conditions promo « N périodes » stampées à l'ouverture du checkout (server-
    // written). Absentes (vieil ordre) = réduction à vie, comportement historique.
    const metaBase = Number(meta.base_amount_cents);
    const metaCycles = Number(meta.promo_cycles);
    const promoCycles = (Number.isFinite(metaCycles) && metaCycles >= 1 && metaCycles <= 24) ? Math.round(metaCycles) : null;
    const promoBase = (promoCycles && Number.isFinite(metaBase) && metaBase >= 100 && metaBase <= 99999) ? Math.round(metaBase) : null;
    const allowedKinds = new Set(["trial_setup", "plan_change", "resubscribe", "card_update"]);
    if (!allowedKinds.has(kind)) return json({ error: "Unsupported checkout kind" }, 409);

    const { data: curRow, error: currentProjectionError } = await db.from("cloud_entitlement_projection")
      .select("status,provider,trial_ends_at,trial_consumed_at,current_period_end")
      .eq("user_id", user.id).maybeSingle();
    if (currentProjectionError) return json({ error: "Could not verify current subscription" }, 503);
    const cur = curRow as {
      status?: string; provider?: string; trial_ends_at?: string;
      trial_consumed_at?: string; current_period_end?: string;
    } | null;
    const curStatus = String(cur?.status ?? "");
    const curProvider = String(cur?.provider ?? "");
    const curEndMs = cur?.current_period_end ? new Date(cur.current_period_end).getTime() : 0;
    const curTrialEndMs = cur?.trial_ends_at ? new Date(cur.trial_ends_at).getTime() : 0;
    const curLive = (curStatus === "trialing" && curTrialEndMs > Date.now())
      || (curStatus === "active" && (!curEndMs || curEndMs > Date.now()))
      || (curStatus === "cancelled_at_period_end" && curEndMs > Date.now());
    const curHardBlocked = new Set(["revoked", "refunded", "fraud"]).has(curStatus);
    const curTerminal = curStatus === "expired";
    const foreignRailBlocked = Boolean(cur && curProvider && curProvider !== "revolut" && !curTerminal);
    const planEffectiveAt = curStatus === "trialing"
      ? (cur?.trial_ends_at ?? cur?.current_period_end)
      : cur?.current_period_end;
    const planEffectiveMs = planEffectiveAt ? new Date(planEffectiveAt).getTime() : 0;
    // Prefer the order's customer_id; fall back to the one /checkout stored (the
    // legacy order object doesn't always echo customer_id back).
    let customerId = orderCustomerId(order);
    if (!customerId) {
      const { data: cr } = await db.from("cloud_revolut_customers")
        .select("revolut_customer_id").eq("user_id", user.id).maybeSingle();
      customerId = (cr as { revolut_customer_id?: string } | null)?.revolut_customer_id ?? null;
    }

    // Capture the saved card (display + renewal enrichment). Best-effort.
    let pmId: string | undefined, last4: string | undefined, brand: string | undefined, cardExp: string | undefined;
    if (customerId) {
      const card = await savedCard(customerId);
      if (card) { pmId = card.id; last4 = card.last4; brand = card.brand; cardExp = card.exp; }
    }
    // Country = card issuing country, read on the order we already fetched. Stamped on
    // the mapping (renewal cron copies it onto ledger rows) AND on the projection.
    const cardCountry = cardCountryFromOrder(order);
    // Void the validation hold now that the card is saved — nothing should stay held.
    // The cancel endpoint is on the NEW Merchant API (/api/orders/…), like payments;
    // the legacy /api/1.0 path 404s. Best-effort: a lingering auth auto-expires anyway.
    let holdReleased = state !== "AUTHORISED";
    let journalState = state;
    if (state === "AUTHORISED") {
      const cancelled = await revolut("POST", `/api/orders/${encodeURIComponent(orderId)}/cancel`, undefined, { "Revolut-Api-Version": "2024-09-01" });
      holdReleased = cancelled.ok;
      if (cancelled.ok) journalState = "CANCELLED";
    }

    const stampFinalized = async (result: string, extra: JsonRecord = {}): Promise<string | null> => {
      const finalization = { result, kind, remote_state: state, hold_released: holdReleased, ...extra };
      const { data: outcome, error } = await db.rpc("finalize_revolut_checkout_order", {
        p_order_id: orderId,
        p_user_id: user.id,
        p_state: journalState,
        p_finalization_result: finalization,
      });
      if (error) return error.message;
      if (outcome !== "finalized" && outcome !== "already_finalized") {
        return `order journal ${String(outcome || "finalization failed")}`;
      }
      return null;
    };
    const replaceProjectionWithRailCas = async (patch: JsonRecord): Promise<string | null> => {
      if (!cur) {
        const { error } = await db.from("cloud_entitlement_projection").insert(patch);
        return error?.message ?? null;
      }
      const { data: changed, error } = await db.from("cloud_entitlement_projection")
        .update(patch)
        .eq("user_id", user.id)
        .eq("provider", curProvider)
        .eq("status", curStatus)
        .select("user_id");
      if (error) return error.message;
      return Array.isArray(changed) && changed.length === 1 ? null : "projection rail changed concurrently";
    };

    const crossRail = (kind === "plan_change" || kind === "card_update")
      ? curProvider !== "revolut"
      : foreignRailBlocked;
    if (curHardBlocked) {
      const stampError = await stampFinalized("rejected_account_blocked", { existing_status: curStatus });
      if (stampError) return json({ error: "Could not finalize rejected checkout" }, 503);
      return json({
        error: "Billing is unavailable while this account is blocked. Contact support.",
        code: "account_billing_blocked",
      }, 409);
    }
    if (crossRail) {
      const stampError = await stampFinalized("rejected_cross_rail", { existing_provider: curProvider || null });
      if (stampError) return json({ error: "Could not finalize rejected checkout" }, 503);
      return json({ error: "This subscription is managed by another billing provider", code: "billing_rail_mismatch" }, 409);
    }
    if (kind === "plan_change" && (!planEffectiveAt || planEffectiveMs <= Date.now())) {
      const stampError = await stampFinalized("rejected_plan_not_live");
      if (stampError) return json({ error: "Could not finalize rejected checkout" }, 503);
      return json({ error: "The current billing period has ended; resubscribe instead", code: "plan_not_live" }, 409);
    }

    const willStartTrial = kind === "trial_setup" && !cur?.trial_consumed_at && !curLive;
    const willCommitRecurring = kind === "resubscribe" || willStartTrial;
    const custPatch: JsonRecord = {
      user_id: user.id, revolut_customer_id: customerId ?? undefined, payment_method_id: pmId ?? undefined,
      card_last4: last4 ?? undefined, card_brand: brand ?? undefined, card_exp: cardExp ?? undefined,
      card_country: cardCountry ?? undefined, updated_at: nowIso,
    };
    if (willCommitRecurring && amount) {
      custPatch.plan = plan; custPatch.period = period; custPatch.amount_cents = amount;
      custPatch.base_amount_cents = promoBase && promoBase > amount ? promoBase : null;
      custPatch.promo_cycles_left = promoBase && promoBase > amount ? promoCycles : null;
      // A fresh subscription supersedes any previously scheduled plan change.
      custPatch.pending_plan = null; custPatch.pending_period = null;
      custPatch.pending_amount_cents = null; custPatch.pending_base_amount_cents = null;
      custPatch.pending_promo_cycles = null; custPatch.pending_effective_at = null;
      custPatch.pending_order_id = null;
    } else if (kind === "plan_change" && amount) {
      custPatch.pending_plan = plan; custPatch.pending_period = period;
      custPatch.pending_amount_cents = amount;
      custPatch.pending_base_amount_cents = promoBase && promoBase > amount ? promoBase : null;
      custPatch.pending_promo_cycles = promoBase && promoBase > amount ? promoCycles : null;
      custPatch.pending_effective_at = planEffectiveAt;
      custPatch.pending_order_id = orderId;
    }
    const { error: customerCommitError } = await db.from("cloud_revolut_customers").upsert(custPatch);
    if (customerCommitError) {
      const rejection = revolutMappingRejection(customerCommitError.message);
      if (rejection) {
        const stampError = await stampFinalized(rejection.finalization, {
          mapping_guard: rejection.code,
        });
        if (stampError) return json({ error: "Could not finalize rejected checkout" }, 503);
        return json({ error: rejection.error, code: rejection.code }, 409);
      }
      return json({ error: "Could not save billing profile" }, 503);
    }
    if (cardCountry) {
      const { error: countryError } = await db.from("cloud_entitlement_projection")
        .update({ country_code: cardCountry, country_source: "card" }).eq("user_id", user.id);
      if (countryError) return json({ error: "Could not save billing country" }, 503);
    }

    if (kind === "card_update") {
      if (curStatus === "past_due" || curStatus === "grace") {
        const { error } = await db.from("cloud_entitlement_projection").update({
          status: "active", provider: "revolut", current_period_end: nowIso, last_event_at: nowIso,
        }).eq("user_id", user.id).eq("provider", "revolut");
        if (error) return json({ error: "Could not update entitlement" }, 503);
        const stampError = await stampFinalized("card_updated_retrying");
        if (stampError) return json({ error: "Could not finalize order journal" }, 503);
        return json({ ok: true, status: "retrying", kind });
      }
      const stampError = await stampFinalized("card_updated");
      if (stampError) return json({ error: "Could not finalize order journal" }, 503);
      return json({ ok: true, status: "updated", kind });
    }

    if (kind === "plan_change") {
      const patch: JsonRecord = {
        provider_customer_id: customerId, last_event_at: nowIso, last_verified_at: nowIso,
      };
      // Keep the already-paid plan and its profile limits until the end of the
      // current cycle. The customer mapping carries the pending plan; the billing
      // claim atomically selects it at current_period_end and promotes it only
      // after a COMPLETED charge.
      if (curStatus === "cancelled_at_period_end") {
        patch.status = (cur?.trial_ends_at && new Date(cur.trial_ends_at).getTime() > Date.now()) ? "trialing" : "active";
      }
      const { data: changed, error } = await db.from("cloud_entitlement_projection")
        .update(patch).eq("user_id", user.id).eq("provider", "revolut").eq("status", curStatus).select("user_id");
      if (error) return json({ error: "Could not change plan" }, 503);
      if (!Array.isArray(changed) || changed.length !== 1) return json({ error: "Entitlement changed concurrently" }, 409);
      const stampError = await stampFinalized("plan_change_scheduled", {
        effective_at: planEffectiveAt, pending_plan: plan, pending_period: period,
      });
      if (stampError) return json({ error: "Could not finalize order journal" }, 503);
      const eventError = await recordLifecycleBillingEvent(
        db, user.id, `checkout:${orderId}:plan-change-scheduled`, "PLAN_CHANGE_SCHEDULED",
        { plan_label: plan, effective_at: planEffectiveAt },
      );
      if (eventError) return json({ error: "Could not queue plan-change confirmation" }, 503);
      return json({ ok: true, status: "plan_change_scheduled", kind, effective_at: planEffectiveAt });
    }

    if (kind === "resubscribe") {
      const projectionError = await replaceProjectionWithRailCas({
        user_id: user.id, status: "active", provider: "revolut", provider_customer_id: customerId,
        plan_code: plan, current_period_end: nowIso, last_event_at: nowIso,
      });
      if (projectionError) return json({ error: "Could not reactivate subscription" }, 503);
      const stampError = await stampFinalized("resubscribed");
      if (stampError) return json({ error: "Could not finalize order journal" }, 503);
      return json({ ok: true, status: "active", kind });
    }

    // trial_setup — the ONLY path that grants trial days. Replay-guarded: re-confirming
    // an old setup order after the trial was consumed must not mint fresh days.
    if (cur?.trial_consumed_at) {
      const stampError = await stampFinalized("already_confirmed");
      if (stampError) return json({ error: "Could not finalize order journal" }, 503);
      return json({ ok: true, status: curStatus || "trialing", kind, note: "already_confirmed" });
    }
    // Belt & braces: a live 'active' entitlement (e.g. a manual grant, or a stale
    // trial_setup order minted before /checkout learned to refuse them) must never
    // be downgraded to a 7-day trial. The card was still saved above — harmless.
    if (curStatus === "active" && curEndMs > Date.now()) {
      const stampError = await stampFinalized("already_active");
      if (stampError) return json({ error: "Could not finalize order journal" }, 503);
      return json({ ok: true, status: "active", kind, note: "already_active" });
    }
    const trialError = await replaceProjectionWithRailCas({
      user_id: user.id, status: "trialing", provider: "revolut", provider_customer_id: customerId,
      plan_code: plan, trial_ends_at: new Date(Date.now() + TRIAL_DAYS * 86400_000).toISOString(),
      trial_consumed_at: nowIso, current_period_end: new Date(Date.now() + TRIAL_DAYS * 86400_000).toISOString(),
      last_event_at: nowIso,
      ...(cardCountry ? { country_code: cardCountry, country_source: "card" } : {}),
    });
    if (trialError) return json({ error: "Could not start trial" }, 503);
    const stampError = await stampFinalized("trial_started");
    if (stampError) return json({ error: "Could not finalize order journal" }, 503);
    return json({ ok: true, status: "trialing", kind });
  }

  // ── /profile — user-authed: read-only billing profile for display ──────────
  if (req.method === "GET" && path === "/profile") {
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Not signed in" }, 401);
    const { data: u } = await db.auth.getUser(jwt);
    const user = u?.user;
    if (!user?.id) return json({ error: "Not signed in" }, 401);
    const billingGuard = await guardInternalBilling(db, user.id, true);
    if (billingGuard) return billingGuard;
    const { data: row } = await db.from("cloud_revolut_customers")
      .select("revolut_customer_id,payment_method_id,plan,period,amount_cents,card_last4,card_brand,card_exp,save_offer_used_at,discount_next_pct,pending_plan,pending_period,pending_amount_cents,pending_effective_at")
      .eq("user_id", user.id).maybeSingle();
    let profile = row as JsonRecord | null;
    // Lazy card capture: /confirm may have run before Revolut attached the saved
    // method; by the time the user views their billing, it's there. Fetch + persist
    // it once (off the checkout critical path). Best-effort.
    if (profile && profile.revolut_customer_id && !profile.payment_method_id) {
      const card = await savedCard(String(profile.revolut_customer_id));
      if (card?.id) {
        const patch: JsonRecord = {
          payment_method_id: card.id, card_last4: card.last4 ?? null,
          card_brand: card.brand ?? null, card_exp: card.exp ?? null,
          updated_at: new Date().toISOString(),
        };
        if (card.country) patch.card_country = card.country;
        await db.from("cloud_revolut_customers").update(patch).eq("user_id", user.id);
        if (card.country) {
          try {
            await db.from("cloud_entitlement_projection")
              .update({ country_code: card.country, country_source: "card" }).eq("user_id", user.id);
          } catch (_) { /* best-effort */ }
        }
        profile = { ...profile, ...patch };
      }
    }
    // Don't leak internal ids to the client.
    if (profile) { delete profile.revolut_customer_id; delete profile.payment_method_id; }
    return json({ ok: true, profile });
  }

  // ── /cancel — user-authed: stop auto-renewal; access runs to the period end ──
  if (req.method === "POST" && path === "/cancel") {
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Not signed in" }, 401);
    const { data: u } = await db.auth.getUser(jwt);
    const user = u?.user;
    if (!user?.id) return json({ error: "Not signed in" }, 401);
    const billingGuard = await guardInternalBilling(db, user.id);
    if (billingGuard) return billingGuard;

    let payload: { reason?: string } = {};
    try { payload = await req.json(); } catch (_) { /* reason optional */ }
    const reason = String(payload.reason ?? "skipped");

    const nowIso = new Date().toISOString();
    const { data: actionRows, error: actionError } = await db.rpc("norva_apply_revolut_account_action", {
      p_user_id: user.id, p_action: "cancel",
      p_event_id: `account:cancel:${user.id}:${nowIso}`, p_event_at: nowIso,
    });
    if (actionError) {
      if (/no_revolut_subscription|nothing_to_cancel/.test(actionError.message ?? "")) {
        return json({ error: "No cancellable Norva plan on this account" }, 400);
      }
      return json({ error: "Could not cancel the plan" }, 503);
    }
    const action = (Array.isArray(actionRows) ? actionRows[0] : actionRows) as {
      status?: string; access_until?: string | null; applied?: boolean;
    } | null;
    if (!action?.status) return json({ error: "Could not cancel the plan" }, 503);
    if (action.applied) await logCancelFeedback(db, user.id, reason, "cancelled", action.status);
    return json({ ok: true, status: action.status, access_until: action.access_until ?? null });
  }

  // ── /resume — user-authed: undo a pending cancellation before it takes effect ──
  if (req.method === "POST" && path === "/resume") {
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Not signed in" }, 401);
    const { data: u } = await db.auth.getUser(jwt);
    const user = u?.user;
    if (!user?.id) return json({ error: "Not signed in" }, 401);
    const billingGuard = await guardInternalBilling(db, user.id);
    if (billingGuard) return billingGuard;

    const nowIso = new Date().toISOString();
    const { data: actionRows, error: actionError } = await db.rpc("norva_apply_revolut_account_action", {
      p_user_id: user.id, p_action: "resume",
      p_event_id: `account:resume:${user.id}:${nowIso}`, p_event_at: nowIso,
    });
    if (actionError) {
      const detail = actionError.message ?? "";
      if (/no_pending_cancellation/.test(detail)) return json({ error: "No pending cancellation to resume" }, 400);
      if (/subscription_already_ended/.test(detail)) {
        return json({ error: "The plan has already ended — resubscribe instead" }, 400);
      }
      return json({ error: "Could not resume the plan" }, 503);
    }
    const action = (Array.isArray(actionRows) ? actionRows[0] : actionRows) as { status?: string } | null;
    if (!action?.status) return json({ error: "Could not resume the plan" }, 503);
    return json({ ok: true, status: action.status });
  }

  return json({ error: "Not found" }, 404);
});
