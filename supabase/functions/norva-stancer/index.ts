// Stancer web payment rail — checkout + diagnostics. INERT until STANCER_SECRET_KEY is set AND the
// web is wired (billing-config.stancer.enabled + subscribe.html). See docs/STANCER-BILLING.md.
//
// v2 API schema CONFIRMED against the live test sandbox (2026-07-03):
//   POST /v2/customers/        {name,email} → { id: cust_… }
//   POST /v2/payment_intents/  {amount(cents),currency:"usd",capture,methods_allowed:["card"],
//                               return_url,order_id,customer,metadata,description}
//                               (NB: NO `auth` field here — 422 "extra fields not permitted"; 3DS is
//                               implicit on the hosted page, the response carries threeds:"required")
//     → { id: pi_…, url: "https://payment.stancer.com/[test_]pi_…", status:"require_payment_method",
//         card:null(until paid), threeds:"required" }
//
// Routes:
//   GET  /health    → non-secret config booleans.
//   POST /selftest  → cron-authed, TEST-MODE ONLY: creates a throwaway customer + payment_intent to
//                     re-confirm the schema; returns raw responses. Never runs on a live key.
//   POST /checkout  → user-authed (verifies the Supabase JWT itself): create/reuse the Stancer
//                     customer, open a TRIAL-SETUP payment_intent (capture:false → authorize + tokenize
//                     the card, no debit now), journal it, and return the hosted-page URL to redirect to.
//                     The actual charge at trial-end + renewals is done by the norva-stancer-billing cron.
//
// Prices are resolved SERVER-SIDE (never trust a client-sent amount).

import { createClient } from "npm:@supabase/supabase-js@2";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_KEY") ?? "";
const STANCER_SECRET_KEY = Deno.env.get("STANCER_SECRET_KEY") ?? "";
const STANCER_MODE = (Deno.env.get("NORVA_STANCER_MODE") ?? "test").toLowerCase();
const STANCER_API = "https://api.stancer.com";
const RETURN_BASE = "https://norva.tv";

// Server-side price table (cents). The client only sends {plan, period}.
const PRICES: Record<string, Record<string, number>> = {
  plus:   { monthly: 499, annual: 4199 },
  family: { monthly: 899, annual: 7599 },
};

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function basicAuth(): string { return "Basic " + btoa(`${STANCER_SECRET_KEY}:`); }
function isTestKey(): boolean { return STANCER_MODE === "test" || STANCER_SECRET_KEY.startsWith("stest"); }
// Stancer caps order_id at 36 chars — a dashless uuid is 32, which fits.
function ref(userId: string): string { return userId.replace(/-/g, "").slice(0, 36); }

async function stancerPost(path: string, body: Record<string, unknown>) {
  const res = await fetch(`${STANCER_API}${path}`, {
    method: "POST",
    headers: { Authorization: basicAuth(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch (_) { /* keep raw */ }
  return { ok: res.ok, status: res.status, body: parsed as Record<string, unknown> };
}

// Create-or-reuse the Stancer customer for a user; returns cust_… (or null on failure).
async function ensureCustomer(db: SupabaseClient, userId: string, email: string, name: string): Promise<string | null> {
  const { data: existing } = await db.from("cloud_stancer_customers").select("stancer_customer_id").eq("user_id", userId).maybeSingle();
  const existingId = (existing as { stancer_customer_id?: string } | null)?.stancer_customer_id;
  if (existingId) return existingId;
  const created = await stancerPost("/v2/customers/", { name: name || "Norva member", email });
  const custId = created.ok ? String(created.body.id ?? "") : "";
  if (!custId) return null;
  await db.from("cloud_stancer_customers").upsert({ user_id: userId, stancer_customer_id: custId, updated_at: new Date().toISOString() });
  return custId;
}

const TRIAL_DAYS = 7;

// Retrieve a payment_intent (PLURAL endpoint) — the authoritative status + card token.
async function fetchPI(piId: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${STANCER_API}/v2/payment_intents/${encodeURIComponent(piId)}`, { headers: { Authorization: basicAuth() } });
  if (!res.ok) return null;
  return await res.json().catch(() => null);
}

// Fetch a card object — the payment_intent often returns the card as a bare
// "card_…" string, so this recovers last4/expiry. Best-effort, display-only.
async function fetchCard(cardId: string): Promise<{ last4?: string; exp?: string } | null> {
  const res = await fetch(`${STANCER_API}/v1/cards/${encodeURIComponent(cardId)}`, { headers: { Authorization: basicAuth() } });
  if (!res.ok) return null;
  const c = await res.json().catch(() => null) as Record<string, unknown> | null;
  if (!c) return null;
  const last4 = c.last4 ? String(c.last4) : undefined;
  const exp = (c.exp_month && c.exp_year)
    ? `${String(c.exp_month).padStart(2, "0")}/${String(c.exp_year).slice(-2)}`
    : undefined;
  return { last4, exp };
}

// The card comes back as a string ("card_…") or an object {id,last4,…}.
function cardFrom(card: unknown): { id: string; last4?: string } | null {
  if (!card) return null;
  if (typeof card === "string") return card.startsWith("card_") ? { id: card } : null;
  const c = card as Record<string, unknown>;
  const id = String(c.id ?? "");
  if (!id.startsWith("card_")) return null;
  return { id, last4: c.last4 ? String(c.last4) : undefined };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/norva-stancer/, "") || "/";

  if (req.method === "GET" && (path === "/health" || path === "/")) {
    return json({ ok: true, service: "norva-stancer", configured: Boolean(STANCER_SECRET_KEY), mode: STANCER_MODE, test_key: isTestKey() });
  }

  if (!STANCER_SECRET_KEY || !SUPABASE_URL || !SERVICE_KEY) return json({ ok: false, inert: true, reason: "not_configured" });
  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // ── /selftest — cron-authed, test only ────────────────────────────────────
  if (req.method === "POST" && path === "/selftest") {
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: ok } = await db.rpc("norva_verify_cron_secret", { presented: token });
    if (ok !== true) return json({ error: "Unauthorized" }, 403);
    if (!isTestKey()) return json({ error: "selftest refuses to run on a non-test key" }, 400);
    const returnUrl = `${RETURN_BASE}/subscription.html?stancer=selftest`;
    const cust = await stancerPost("/v2/customers/", { name: "Norva Test", email: "test@norva.tv" });
    // Optional matrix: {"cases":[{currency,amount,capture}]} — diagnoses hosted-page behaviour per
    // currency/amount/capture (e.g. "not ready for authorization" seen on USD checkouts).
    let payload: {
      cases?: { currency?: string; amount?: number; capture?: boolean }[];
      charge?: { pi?: string; amount?: number; currency?: string };
    } = {};
    try { payload = await req.json(); } catch (_) { /* default single case below */ }

    // Optional charge probe: {"charge":{pi,amount,currency}} — reuses the card token saved on an
    // existing TEST payment intent to exercise the /v1/checkout token-charge rail per currency
    // (validates the recurring USD charge before a real trial reaches its end).
    if (payload.charge?.pi) {
      const src = await fetchPI(String(payload.charge.pi));
      const card = src ? cardFrom(src.card) : null;
      if (!card) return json({ ok: false, error: "charge probe: no card token on that payment intent", pi_status: src?.status ?? null });
      const res = await fetch(`${STANCER_API}/v1/checkout/`, {
        method: "POST",
        headers: { Authorization: basicAuth(), "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: payload.charge.amount ?? 100, currency: payload.charge.currency ?? "usd",
          card: card.id, customer: src?.customer ? String(src.customer) : undefined,
          unique_id: `selftest${Date.now().toString(36)}`.slice(0, 36), description: "selftest charge probe",
        }),
      });
      const body = await res.json().catch(() => ({}));
      return json({ ok: true, charge_probe: { currency: payload.charge.currency ?? "usd", amount: payload.charge.amount ?? 100, http: res.status, body } });
    }
    const cases = (payload.cases?.length ? payload.cases : [{ currency: "usd", amount: 499, capture: false }]).slice(0, 6);
    const results: Record<string, unknown>[] = [];
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      const pi = await stancerPost("/v2/payment_intents/", {
        amount: c.amount ?? 499, currency: c.currency ?? "usd", capture: c.capture ?? false, methods_allowed: ["card"],
        return_url: returnUrl, order_id: `selftest${Date.now().toString(36)}${i}`.slice(0, 36),
        customer: cust.ok ? cust.body.id : undefined,
      });
      results.push({
        currency: c.currency ?? "usd", amount: c.amount ?? 499, capture: c.capture ?? false,
        ok: pi.ok, http: pi.status, id: pi.body?.id, url: pi.body?.url, status: pi.body?.status,
        error: pi.ok ? undefined : pi.body,
      });
    }
    return json({ ok: true, mode: STANCER_MODE, customer: cust.ok ? cust.body.id : cust, results });
  }

  // ── /checkout — user-authed: open a trial-setup hosted payment ─────────────
  if (req.method === "POST" && path === "/checkout") {
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Not signed in" }, 401);
    const { data: u } = await db.auth.getUser(jwt);
    const user = u?.user;
    if (!user?.id || !user.email) return json({ error: "Not signed in" }, 401);

    let payload: { plan?: string; period?: string; returnTo?: string; embed?: boolean } = {};
    try { payload = await req.json(); } catch (_) { /* defaults below */ }
    const plan = payload.plan === "family" ? "family" : "plus";
    const period = payload.period === "annual" ? "annual" : "monthly";
    const amount = PRICES[plan]?.[period];
    if (!amount) return json({ error: "Unknown plan" }, 400);

    const name = String(user.user_metadata?.display_name ?? user.user_metadata?.name ?? "").trim();
    const custId = await ensureCustomer(db, user.id, user.email, name);
    if (!custId) return json({ error: "Could not open a billing profile" }, 502);

    // Record the recurring plan on the mapping row — the billing cron reads amount/period from here
    // (projection.plan_code is constrained to plus/family and can't carry the period).
    await db.from("cloud_stancer_customers").upsert({
      user_id: user.id, stancer_customer_id: custId, plan, period, amount_cents: amount, updated_at: new Date().toISOString(),
    });

    // Carry the caller's origin so the return page can send the user back where they
    // started (e.g. Settings). Only a same-site path is accepted — never an absolute
    // or protocol-relative URL — so this can't become an open redirect.
    const rawReturn = typeof payload.returnTo === "string" ? payload.returnTo : "";
    const safeReturn = /^\/(?!\/)/.test(rawReturn) ? rawReturn.slice(0, 512) : "";
    // embed:true → the checkout runs inside checkout.html (Stancer form in an iframe);
    // the payment then returns to the tiny bridge page, which postMessages the parent
    // (or, if opened top-level, forwards to the classic subscription.html?stancer=done).
    const returnUrl = payload.embed === true
      ? `${RETURN_BASE}/checkout-done.html${safeReturn ? `?returnTo=${encodeURIComponent(safeReturn)}` : ""}`
      : `${RETURN_BASE}/subscription.html?stancer=done` +
        (safeReturn ? `&returnTo=${encodeURIComponent(safeReturn)}` : "");
    // Trial setup (Option B — minimal footprint): authorize a small validation amount (€0.50) with
    // capture:false → validates + tokenizes the card, NO plan charge now. The hold auto-releases; the
    // real plan amount (from plan_code) is charged at trial end by norva-stancer-billing. `amount`
    // above is only used by the cron's price table via plan_code, not here.
    const VALIDATION_CENTS = 50;
    // Validation hold in EUR: authorization-only (capture:false) is enabled on this Stancer account
    // for EUR but NOT USD — a USD auth-only card payment comes back "not ready for authorization" on
    // the hosted page, while USD captures work fine (matrix selftest + manual test, 2026-07-03).
    // Plan charges stay in USD (norva-stancer-billing). Flip to "usd" once Stancer support enables
    // USD authorizations on the account.
    const pi = await stancerPost("/v2/payment_intents/", {
      amount: VALIDATION_CENTS, currency: "eur", capture: false, methods_allowed: ["card"],
      return_url: returnUrl, order_id: ref(user.id), customer: custId,
      description: `Norva ${plan} ${period} — card validation for 7-day free trial`,
      metadata: { user_id: user.id, kind: "trial_setup", plan, period },
    });
    if (!pi.ok || !pi.body.id || !pi.body.url) {
      console.error("[norva-stancer] payment_intent failed", pi.status, JSON.stringify(pi.body).slice(0, 300));
      return json({ error: "Could not start checkout" }, 502);
    }

    await db.from("cloud_stancer_payments").upsert({
      pi_id: String(pi.body.id), user_id: user.id, kind: "trial_setup",
      amount, currency: "usd", status: String(pi.body.status ?? "require_payment_method"),
      order_id: ref(user.id), updated_at: new Date().toISOString(),
    });

    return json({ ok: true, url: String(pi.body.url), pi_id: String(pi.body.id) });
  }

  // ── /profile — user-authed: read-only billing profile for display (plan + card) ──
  if (req.method === "GET" && path === "/profile") {
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Not signed in" }, 401);
    const { data: u } = await db.auth.getUser(jwt);
    const user = u?.user;
    if (!user?.id) return json({ error: "Not signed in" }, 401);
    const { data: row } = await db.from("cloud_stancer_customers")
      .select("plan,period,amount_cents,card_last4,card_exp").eq("user_id", user.id).maybeSingle();
    return json({ ok: true, profile: row ?? null });
  }

  // ── /confirm — user-authed: finalize a completed checkout (no webhook needed) ──
  // The return page (/subscription.html?stancer=done) calls this. Re-fetches the payment_intent,
  // captures the tokenized card, and moves the projection to a Stancer trial. Idempotent and safe:
  // only confirms a payment whose metadata.user_id matches the authenticated caller.
  if (req.method === "POST" && path === "/confirm") {
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Not signed in" }, 401);
    const { data: u } = await db.auth.getUser(jwt);
    const user = u?.user;
    if (!user?.id) return json({ error: "Not signed in" }, 401);

    let payload: { pi_id?: string } = {};
    try { payload = await req.json(); } catch (_) { /* optional */ }
    let piId = String(payload.pi_id ?? "");
    if (!piId) {
      const { data: last } = await db.from("cloud_stancer_payments")
        .select("pi_id").eq("user_id", user.id).eq("kind", "trial_setup")
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      piId = String((last as { pi_id?: string } | null)?.pi_id ?? "");
    }
    if (!piId) return json({ ok: false, status: "no_payment" });

    const pi = await fetchPI(piId);
    if (!pi) return json({ ok: false, status: "not_found" });
    const meta = (pi.metadata && typeof pi.metadata === "object") ? pi.metadata as Record<string, unknown> : {};
    if (String(meta.user_id ?? "") !== user.id) return json({ error: "Forbidden" }, 403);

    const s = String(pi.status ?? "").toLowerCase();
    const paid = s === "authorized" || s === "captured" || s === "to_capture";
    const card = cardFrom(pi.card);
    if (!paid || !card) return json({ ok: true, status: pi.status, pending: true });

    const nowIso = new Date().toISOString();
    const plan = String(meta.plan ?? "plus") === "family" ? "family" : "plus";
    const custId = pi.customer ? String(pi.customer) : undefined;
    // Display enrichment: the PI usually returns the card as a bare token string, so
    // recover last4/expiry from the card object ("•••• 0077" in the subscription UI).
    let last4 = card.last4;
    let cardExp: string | undefined;
    if (!last4) {
      const info = await fetchCard(card.id);
      if (info) { last4 = info.last4; cardExp = info.exp; }
    }
    // Only touches these columns — plan/period/amount set at /checkout are preserved.
    await db.from("cloud_stancer_customers").upsert({
      user_id: user.id, stancer_customer_id: custId, card_token: card.id,
      card_last4: last4 ?? undefined, card_exp: cardExp ?? undefined, updated_at: nowIso,
    });
    await db.from("cloud_entitlement_projection").upsert({
      user_id: user.id, status: "trialing", provider: "stancer", provider_customer_id: custId,
      plan_code: plan, trial_ends_at: new Date(Date.now() + TRIAL_DAYS * 86400_000).toISOString(),
      trial_consumed_at: nowIso, last_event_at: nowIso,
    });
    try { await db.from("cloud_stancer_payments").update({ status: pi.status }).eq("pi_id", piId); } catch (_) { /* noop */ }
    return json({ ok: true, status: "trialing" });
  }

  return json({ error: "Not found" }, 404);
});
