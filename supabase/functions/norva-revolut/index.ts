// Revolut Merchant web payment rail — checkout + account actions. INERT until
// REVOLUT_SECRET_KEY is set AND the web is wired (billing-config.revolut.enabled +
// checkout-revolut.html). Companion to norva-revolut-webhook (which reconciles the
// authoritative lifecycle); this side OPENS the checkout and can finalize a return
// without waiting for the webhook (belt & braces), exactly like norva-stancer.
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

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY") ?? "";
const REVOLUT_SECRET_KEY = Deno.env.get("REVOLUT_SECRET_KEY") ?? "";
// Sandbox during dev; set to https://merchant.revolut.com at production cutover.
const REVOLUT_API_BASE = (Deno.env.get("REVOLUT_API_BASE") ?? "https://sandbox-merchant.revolut.com").replace(/\/+$/, "");
const TRIAL_DAYS = 7;
// Card-validation hold (capture_mode:MANUAL → authorised, never captured, voided on
// confirm). $0.50 mirrors the Stancer footprint; bump via env if the sandbox rejects it.
const VALIDATION_CENTS = boundedInt(Deno.env.get("NORVA_REVOLUT_VALIDATION_CENTS"), 50, 1, 5000);
// One-shot cancel-flow counter-offer: % off the NEXT charge (applied once, then cleared).
const SAVE_OFFER_PCT = 50;
const CANCEL_REASONS = new Set(["too_expensive", "not_using", "technical", "other", "skipped"]);

// Server-side price table (cents, USD). The client only sends {plan, period}.
const PRICES: Record<string, Record<string, number>> = {
  plus:   { monthly: 499, annual: 4199 },
  family: { monthly: 899, annual: 7599 },
};

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
function isTestKey(): boolean { return REVOLUT_SECRET_KEY.startsWith("sk_") && /sandbox/i.test(REVOLUT_API_BASE); }
// A short, unique-per-order external reference (Revolut rejects duplicate ext_refs).
function extRef(userId: string): string { return `${userId.replace(/-/g, "").slice(0, 24)}-${Date.now().toString(36)}`; }

type JsonRecord = Record<string, unknown>;

async function revolut(method: "GET" | "POST", path: string, body?: JsonRecord) {
  const res = await fetch(`${REVOLUT_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${REVOLUT_SECRET_KEY}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(12_000),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch (_) { /* keep raw */ }
  return { ok: res.ok, status: res.status, body: (parsed ?? {}) as JsonRecord };
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

// Retrieve the card the customer just saved (for merchant-initiated renewals) — the
// order carries the customer, the saved token lives on the customer. Best-effort:
// display + renewal enrichment, never blocks starting the trial.
// Confirmed sandbox shape: GET → [{ id, type:"CARD", saved_for:"MERCHANT",
// method_details:{ last4, brand, expiry_month, expiry_year, ... } }]. SINGLE quick
// call — no retry: Revolut attaches the method a moment AFTER the order authorizes,
// so /confirm often misses it; /profile captures it lazily once it's there (off the
// user's critical path, so the edge wall-clock limit is never a factor).
async function savedCard(customerId: string): Promise<{ id?: string; last4?: string; brand?: string; exp?: string } | null> {
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
  return {
    id: card.id ? String(card.id) : undefined,
    last4: md.last4 ? String(md.last4) : undefined,
    brand: md.brand ? String(md.brand).toUpperCase() : undefined,
    exp: (em && ey) ? `${String(em).padStart(2, "0")}/${String(ey).slice(-2)}` : undefined,
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

  // ── /checkout — user-authed: open a trial-setup order ──────────────────────
  if (req.method === "POST" && path === "/checkout") {
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Not signed in" }, 401);
    const { data: u } = await db.auth.getUser(jwt);
    const user = u?.user;
    if (!user?.id || !user.email) return json({ error: "Not signed in" }, 401);

    let payload: { plan?: string; period?: string; returnTo?: string; intent?: string } = {};
    try { payload = await req.json(); } catch (_) { /* defaults below */ }
    const plan = payload.plan === "family" ? "family" : "plus";
    const period = payload.period === "annual" ? "annual" : "monthly";
    const amount = PRICES[plan]?.[period];
    if (!amount) return json({ error: "Unknown plan" }, 400);

    // ── Checkout KIND, decided SERVER-SIDE from the account's real state ───────
    // (identical semantics to norva-stancer): trial_setup grants trial days ONCE;
    // plan_change swaps plan without a new trial; resubscribe reactivates; card_update
    // only swaps the card.
    const { data: projRow } = await db.from("cloud_entitlement_projection")
      .select("status,trial_consumed_at,trial_ends_at,current_period_end")
      .eq("user_id", user.id).maybeSingle();
    const proj = projRow as { status?: string; trial_consumed_at?: string; trial_ends_at?: string; current_period_end?: string } | null;
    const nowMs = Date.now();
    const trialEndMs = proj?.trial_ends_at ? new Date(proj.trial_ends_at).getTime() : 0;
    const periodEndMs = proj?.current_period_end ? new Date(proj.current_period_end).getTime() : 0;
    const projStatus = String(proj?.status ?? "");
    const liveEntitlement =
      (projStatus === "trialing" && trialEndMs > nowMs) ||
      (projStatus === "active" && (periodEndMs === 0 || periodEndMs > nowMs)) ||
      (projStatus === "cancelled_at_period_end" && periodEndMs > nowMs);
    let kind = "trial_setup";
    if (payload.intent === "update_card") kind = "card_update";
    else if (proj?.trial_consumed_at) kind = liveEntitlement ? "plan_change" : "resubscribe";

    // A Revolut customer is needed for the card to be saved (see helper). Create it
    // up front so the order can carry customer_id. Degrade gracefully: if creation
    // fails the trial still starts on customer_email (the card just won't be saved).
    const name = String(user.user_metadata?.display_name ?? user.user_metadata?.name ?? "").trim();
    const custId = await ensureRevolutCustomer(db, user.id, user.email, name);

    // Record the customer id + recurring plan on the mapping row — the renewal engine
    // reads amount/period from here (projection.plan_code can't carry the period).
    // card_update must NOT touch plan/period (would corrupt a family/annual mapping).
    const nowIso = new Date().toISOString();
    const custRow: JsonRecord = { user_id: user.id, updated_at: nowIso };
    if (custId) custRow.revolut_customer_id = custId;
    if (kind !== "card_update") { custRow.plan = plan; custRow.period = period; custRow.amount_cents = amount; }
    await db.from("cloud_revolut_customers").upsert(custRow);

    const DESCRIPTIONS: Record<string, string> = {
      trial_setup: `Norva ${plan} ${period} — card check for 7-day free trial`,
      plan_change: `Norva ${plan} ${period} — plan change (card check, not charged)`,
      resubscribe: `Norva ${plan} ${period} — resubscribe (card check; first charge follows)`,
      card_update: `Norva — payment method update (card check, not charged)`,
    };
    // capture_mode:MANUAL → authorise a small validation amount (card check), never
    // captured; the saved token (savePaymentMethodFor:"merchant" on the widget) drives
    // renewals. The plan price applies at trial end via a merchant-initiated charge.
    const orderBody: JsonRecord = {
      amount: VALIDATION_CENTS,
      currency: "USD",
      capture_mode: "MANUAL",
      merchant_order_ext_ref: extRef(user.id),
      description: DESCRIPTIONS[kind],
      metadata: { user_id: user.id, plan, period, kind },
    };
    // customer_id links the order → customer so savePaymentMethodFor:merchant attaches
    // the card; fall back to customer_email if the customer couldn't be created.
    if (custId) orderBody.customer_id = custId; else orderBody.customer_email = user.email;
    let created = await revolut("POST", "/api/1.0/orders", orderBody);
    // Safety net: if this API rejects customer_id on the order, retry with
    // customer_email so the trial still starts (card just won't attach here).
    if (!created.ok && orderBody.customer_id) {
      console.warn("[norva-revolut] order w/ customer_id failed, retrying w/ email", created.status);
      delete orderBody.customer_id;
      orderBody.customer_email = user.email;
      created = await revolut("POST", "/api/1.0/orders", orderBody);
    }
    const orderId = String(created.body.id ?? "");
    const token = widgetToken(created.body);
    if (!created.ok || !orderId || !token) {
      console.error("[norva-revolut] create order failed", created.status, JSON.stringify(created.body).slice(0, 400));
      return json({ error: "Could not start checkout", detail: created.body }, 502);
    }

    await db.from("cloud_revolut_orders").upsert({
      order_id: orderId, public_id: token, user_id: user.id, kind,
      amount: VALIDATION_CENTS, currency: "usd",
      state: String(created.body.state ?? "pending"), updated_at: new Date().toISOString(),
    });

    return json({
      ok: true, order_id: orderId, public_id: token, kind,
      checkout_url: created.body.checkout_url ? String(created.body.checkout_url) : null,
      sandbox: isTestKey(),
    });
  }

  // ── /confirm — user-authed: finalize a returned checkout (no webhook needed) ──
  if (req.method === "POST" && path === "/confirm") {
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Not signed in" }, 401);
    const { data: u } = await db.auth.getUser(jwt);
    const user = u?.user;
    if (!user?.id) return json({ error: "Not signed in" }, 401);

    let payload: { order_id?: string } = {};
    try { payload = await req.json(); } catch (_) { /* optional */ }
    let orderId = String(payload.order_id ?? "");
    if (!orderId) {
      const { data: last } = await db.from("cloud_revolut_orders")
        .select("order_id").eq("user_id", user.id)
        .in("kind", ["trial_setup", "plan_change", "resubscribe", "card_update"])
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      orderId = String((last as { order_id?: string } | null)?.order_id ?? "");
    }
    if (!orderId) return json({ ok: false, status: "no_order" });

    const fetched = await revolut("GET", `/api/1.0/orders/${encodeURIComponent(orderId)}`);
    if (!fetched.ok) return json({ ok: false, status: "not_found" });
    const order = fetched.body;
    const meta = (order.metadata && typeof order.metadata === "object") ? order.metadata as JsonRecord : {};
    if (String(meta.user_id ?? "") !== user.id) return json({ error: "Forbidden" }, 403);

    const state = String(order.state ?? "").toUpperCase();
    const paid = state === "AUTHORISED" || state === "COMPLETED";
    if (!paid) return json({ ok: true, status: order.state, pending: true });

    const nowIso = new Date().toISOString();
    const plan = String(meta.plan ?? "plus") === "family" ? "family" : "plus";
    const kind = String(meta.kind ?? "trial_setup");
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
    await db.from("cloud_revolut_customers").upsert({
      user_id: user.id, revolut_customer_id: customerId ?? undefined, payment_method_id: pmId ?? undefined,
      card_last4: last4 ?? undefined, card_brand: brand ?? undefined, card_exp: cardExp ?? undefined,
      updated_at: nowIso,
    });
    try { await db.from("cloud_revolut_orders").update({ state: order.state }).eq("order_id", orderId); } catch (_) { /* noop */ }

    // Void the validation hold now that the card is saved — nothing should stay held.
    // Best-effort: a lingering MANUAL auth auto-expires anyway.
    if (state === "AUTHORISED") {
      try { await revolut("POST", `/api/1.0/orders/${encodeURIComponent(orderId)}/cancel`); } catch (_) { /* noop */ }
    }

    const { data: curRow } = await db.from("cloud_entitlement_projection")
      .select("status,trial_ends_at,trial_consumed_at").eq("user_id", user.id).maybeSingle();
    const cur = curRow as { status?: string; trial_ends_at?: string; trial_consumed_at?: string } | null;
    const curStatus = String(cur?.status ?? "");

    if (kind === "card_update") {
      if (curStatus === "past_due" || curStatus === "grace") {
        await db.from("cloud_entitlement_projection").update({
          status: "active", provider: "revolut", current_period_end: nowIso, last_event_at: nowIso,
        }).eq("user_id", user.id);
        return json({ ok: true, status: "retrying", kind });
      }
      return json({ ok: true, status: "updated", kind });
    }

    if (kind === "plan_change") {
      const patch: JsonRecord = {
        provider: "revolut", provider_customer_id: customerId, plan_code: plan, last_event_at: nowIso,
      };
      if (curStatus === "cancelled_at_period_end") {
        patch.status = (cur?.trial_ends_at && new Date(cur.trial_ends_at).getTime() > Date.now()) ? "trialing" : "active";
      }
      await db.from("cloud_entitlement_projection").update(patch).eq("user_id", user.id);
      return json({ ok: true, status: "plan_changed", kind });
    }

    if (kind === "resubscribe") {
      await db.from("cloud_entitlement_projection").upsert({
        user_id: user.id, status: "active", provider: "revolut", provider_customer_id: customerId,
        plan_code: plan, current_period_end: nowIso, last_event_at: nowIso,
      });
      return json({ ok: true, status: "active", kind });
    }

    // trial_setup — the ONLY path that grants trial days. Replay-guarded: re-confirming
    // an old setup order after the trial was consumed must not mint fresh days.
    if (cur?.trial_consumed_at) {
      return json({ ok: true, status: curStatus || "trialing", kind, note: "already_confirmed" });
    }
    await db.from("cloud_entitlement_projection").upsert({
      user_id: user.id, status: "trialing", provider: "revolut", provider_customer_id: customerId,
      plan_code: plan, trial_ends_at: new Date(Date.now() + TRIAL_DAYS * 86400_000).toISOString(),
      trial_consumed_at: nowIso, current_period_end: new Date(Date.now() + TRIAL_DAYS * 86400_000).toISOString(),
      last_event_at: nowIso,
    });
    return json({ ok: true, status: "trialing", kind });
  }

  // ── /profile — user-authed: read-only billing profile for display ──────────
  if (req.method === "GET" && path === "/profile") {
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Not signed in" }, 401);
    const { data: u } = await db.auth.getUser(jwt);
    const user = u?.user;
    if (!user?.id) return json({ error: "Not signed in" }, 401);
    const { data: row } = await db.from("cloud_revolut_customers")
      .select("revolut_customer_id,payment_method_id,plan,period,amount_cents,card_last4,card_brand,card_exp,save_offer_used_at,discount_next_pct")
      .eq("user_id", user.id).maybeSingle();
    let profile = row as JsonRecord | null;
    // Lazy card capture: /confirm may have run before Revolut attached the saved
    // method; by the time the user views their billing, it's there. Fetch + persist
    // it once (off the checkout critical path). Best-effort.
    if (profile && profile.revolut_customer_id && !profile.payment_method_id) {
      const card = await savedCard(String(profile.revolut_customer_id));
      if (card?.id) {
        const patch = {
          payment_method_id: card.id, card_last4: card.last4 ?? null,
          card_brand: card.brand ?? null, card_exp: card.exp ?? null,
          updated_at: new Date().toISOString(),
        };
        await db.from("cloud_revolut_customers").update(patch).eq("user_id", user.id);
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

    let payload: { reason?: string } = {};
    try { payload = await req.json(); } catch (_) { /* reason optional */ }
    const reason = String(payload.reason ?? "skipped");

    const { data: row } = await db.from("cloud_entitlement_projection")
      .select("status,provider,trial_ends_at,current_period_end").eq("user_id", user.id).maybeSingle();
    const p = row as { status?: string; provider?: string; trial_ends_at?: string; current_period_end?: string } | null;
    if (!p || String(p.provider ?? "") !== "revolut") {
      return json({ error: "No cancellable Norva plan on this account" }, 400);
    }
    const st = String(p.status ?? "");
    const nowIso = new Date().toISOString();
    if (st === "trialing") {
      const accessUntil = p.trial_ends_at ?? nowIso;
      await db.from("cloud_entitlement_projection").update({
        status: "cancelled_at_period_end", current_period_end: accessUntil, last_event_at: nowIso,
      }).eq("user_id", user.id);
      await logCancelFeedback(db, user.id, reason, "cancelled", st);
      return json({ ok: true, status: "cancelled_at_period_end", access_until: accessUntil });
    }
    if (st === "active") {
      await db.from("cloud_entitlement_projection").update({
        status: "cancelled_at_period_end", last_event_at: nowIso,
      }).eq("user_id", user.id);
      await logCancelFeedback(db, user.id, reason, "cancelled", st);
      return json({ ok: true, status: "cancelled_at_period_end", access_until: p.current_period_end ?? null });
    }
    if (st === "past_due" || st === "grace") {
      await db.from("cloud_entitlement_projection").update({
        status: "expired", last_event_at: nowIso,
      }).eq("user_id", user.id);
      await logCancelFeedback(db, user.id, reason, "cancelled", st);
      return json({ ok: true, status: "expired" });
    }
    if (st === "cancelled_at_period_end") {
      return json({ ok: true, status: st, access_until: p.current_period_end ?? null });
    }
    return json({ error: "Nothing to cancel" }, 400);
  }

  // ── /resume — user-authed: undo a pending cancellation before it takes effect ──
  if (req.method === "POST" && path === "/resume") {
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Not signed in" }, 401);
    const { data: u } = await db.auth.getUser(jwt);
    const user = u?.user;
    if (!user?.id) return json({ error: "Not signed in" }, 401);

    const { data: row } = await db.from("cloud_entitlement_projection")
      .select("status,provider,trial_ends_at,current_period_end").eq("user_id", user.id).maybeSingle();
    const p = row as { status?: string; provider?: string; trial_ends_at?: string; current_period_end?: string } | null;
    if (!p || String(p.provider ?? "") !== "revolut" || String(p.status ?? "") !== "cancelled_at_period_end") {
      return json({ error: "No pending cancellation to resume" }, 400);
    }
    const periodEndMs = p.current_period_end ? new Date(p.current_period_end).getTime() : 0;
    if (!periodEndMs || periodEndMs <= Date.now()) {
      return json({ error: "The plan has already ended — resubscribe instead" }, 400);
    }
    const nowIso = new Date().toISOString();
    const backTo = (p.trial_ends_at && new Date(p.trial_ends_at).getTime() > Date.now()) ? "trialing" : "active";
    await db.from("cloud_entitlement_projection").update({
      status: backTo, last_event_at: nowIso,
    }).eq("user_id", user.id);
    return json({ ok: true, status: backTo });
  }

  return json({ error: "Not found" }, 404);
});
