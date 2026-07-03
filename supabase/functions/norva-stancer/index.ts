// Stancer web payment rail — checkout + diagnostics. INERT until STANCER_SECRET_KEY is set AND the
// web is wired (billing-config.stancer.enabled + subscribe.html). See docs/STANCER-BILLING.md.
//
// v2 API schema CONFIRMED against the live test sandbox (2026-07-03):
//   POST /v2/customers/        {name,email} → { id: cust_… }
//   POST /v2/payment_intents/  {amount(cents),currency:"eur",capture,methods_allowed:["card"],
//                               return_url,order_id,customer,metadata,description}
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

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function basicAuth(): string { return "Basic " + btoa(`${STANCER_SECRET_KEY}:`); }
function isTestKey(): boolean { return STANCER_MODE === "test" || STANCER_SECRET_KEY.startsWith("stest"); }

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
    const pi = await stancerPost("/v2/payment_intents/", {
      amount: 499, currency: "eur", capture: false, methods_allowed: ["card"],
      return_url: returnUrl, order_id: "selftest", customer: cust.ok ? cust.body.id : undefined,
    });
    return json({ ok: true, mode: STANCER_MODE, customer: cust, payment_intent: pi });
  }

  // ── /checkout — user-authed: open a trial-setup hosted payment ─────────────
  if (req.method === "POST" && path === "/checkout") {
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Not signed in" }, 401);
    const { data: u } = await db.auth.getUser(jwt);
    const user = u?.user;
    if (!user?.id || !user.email) return json({ error: "Not signed in" }, 401);

    let payload: { plan?: string; period?: string } = {};
    try { payload = await req.json(); } catch (_) { /* defaults below */ }
    const plan = payload.plan === "family" ? "family" : "plus";
    const period = payload.period === "annual" ? "annual" : "monthly";
    const amount = PRICES[plan]?.[period];
    if (!amount) return json({ error: "Unknown plan" }, 400);

    const name = String(user.user_metadata?.display_name ?? user.user_metadata?.name ?? "").trim();
    const custId = await ensureCustomer(db, user.id, user.email, name);
    if (!custId) return json({ error: "Could not open a billing profile" }, 502);

    const returnUrl = `${RETURN_BASE}/subscription.html?stancer=done`;
    // Trial setup: authorize (capture:false) → validates + tokenizes the card, no debit now.
    const pi = await stancerPost("/v2/payment_intents/", {
      amount, currency: "eur", capture: false, methods_allowed: ["card"],
      return_url: returnUrl, order_id: `${user.id}:trial`, customer: custId,
      description: `Norva ${plan} ${period} — 7-day trial setup`,
      metadata: { user_id: user.id, kind: "trial_setup", plan, period },
    });
    if (!pi.ok || !pi.body.id || !pi.body.url) {
      console.error("[norva-stancer] payment_intent failed", pi.status, JSON.stringify(pi.body).slice(0, 300));
      return json({ error: "Could not start checkout" }, 502);
    }

    await db.from("cloud_stancer_payments").upsert({
      pi_id: String(pi.body.id), user_id: user.id, kind: "trial_setup",
      amount, currency: "eur", status: String(pi.body.status ?? "require_payment_method"),
      order_id: `${user.id}:trial`, updated_at: new Date().toISOString(),
    });

    return json({ ok: true, url: String(pi.body.url), pi_id: String(pi.body.id) });
  }

  return json({ error: "Not found" }, 404);
});
