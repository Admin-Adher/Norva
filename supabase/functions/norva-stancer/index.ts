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
// One-shot cancel-flow counter-offer: percentage off the NEXT charge (applied once by
// the billing cron, then cleared). 50% mirrors the market's best-accepted save offer.
const SAVE_OFFER_PCT = 50;
const CANCEL_REASONS = new Set(["too_expensive", "not_using", "technical", "other", "skipped"]);

// Cancellation-feedback journal (reasons + saves) — feeds norva_funnel_daily. Best-effort:
// analytics must never block a cancellation.
async function logCancelFeedback(db: SupabaseClient, userId: string, reason: string, action: "cancelled" | "saved", statusAt: string, offer?: string): Promise<void> {
  try {
    await db.from("cloud_cancel_feedback").insert({
      user_id: userId, reason: CANCEL_REASONS.has(reason) ? reason : "skipped",
      action, status_at: statusAt || null, offer: offer ?? null,
    });
  } catch (_) { /* best-effort */ }
}

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

    let payload: { plan?: string; period?: string; returnTo?: string; embed?: boolean; intent?: string } = {};
    try { payload = await req.json(); } catch (_) { /* defaults below */ }
    const plan = payload.plan === "family" ? "family" : "plus";
    const period = payload.period === "annual" ? "annual" : "monthly";
    const amount = PRICES[plan]?.[period];
    if (!amount) return json({ error: "Unknown plan" }, 400);

    // ── Checkout KIND, decided SERVER-SIDE from the account's real state ──────
    // Closes the "re-trial" hole: /confirm applies exactly what the PI's
    // metadata.kind says, and that kind is fixed here — never by the client:
    //   trial_setup — trial never consumed → the ONLY path that grants trial days.
    //   plan_change — trial consumed + live entitlement → swap plan/token, keep
    //                 status & dates (no new trial, no double charge; the new
    //                 amount applies at the next cycle).
    //   resubscribe — trial consumed + no live entitlement → active immediately,
    //                 first charge picked up by the billing cron (period due now).
    //   card_update — explicit intent from the manage page → swap the token only.
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

    const name = String(user.user_metadata?.display_name ?? user.user_metadata?.name ?? "").trim();
    const custId = await ensureCustomer(db, user.id, user.email, name);
    if (!custId) return json({ error: "Could not open a billing profile" }, 502);

    // Record the recurring plan on the mapping row — the billing cron reads amount/period from here
    // (projection.plan_code is constrained to plus/family and can't carry the period).
    // card_update must NOT touch it: the user is only swapping the card, and defaulted
    // plan/period values would corrupt e.g. a family/annual subscriber's mapping.
    if (kind !== "card_update") {
      await db.from("cloud_stancer_customers").upsert({
        user_id: user.id, stancer_customer_id: custId, plan, period, amount_cents: amount, updated_at: new Date().toISOString(),
      });
    }

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
    // Plan charges stay in USD (norva-stancer-billing). Owner asked Stancer support (2026-07-03) to
    // enable USD authorizations AND Apple Pay / Google Pay on the account. Once confirmed:
    //   • flip currency below to "usd" (hold becomes $0.50);
    //   • wallets appear on the hosted page automatically — the checkout iframe already carries
    //     allow="payment", nothing else to change client-side.
    const DESCRIPTIONS: Record<string, string> = {
      trial_setup: `Norva ${plan} ${period} — card validation for 7-day free trial`,
      plan_change: `Norva ${plan} ${period} — plan change (card check, not charged)`,
      resubscribe: `Norva ${plan} ${period} — resubscribe (card check; first charge follows)`,
      card_update: `Norva — payment method update (card check, not charged)`,
    };
    const pi = await stancerPost("/v2/payment_intents/", {
      amount: VALIDATION_CENTS, currency: "eur", capture: false, methods_allowed: ["card"],
      return_url: returnUrl, order_id: ref(user.id), customer: custId,
      description: DESCRIPTIONS[kind],
      metadata: { user_id: user.id, kind, plan, period },
    });
    if (!pi.ok || !pi.body.id || !pi.body.url) {
      console.error("[norva-stancer] payment_intent failed", pi.status, JSON.stringify(pi.body).slice(0, 300));
      return json({ error: "Could not start checkout" }, 502);
    }

    await db.from("cloud_stancer_payments").upsert({
      pi_id: String(pi.body.id), user_id: user.id, kind,
      amount, currency: "usd", status: String(pi.body.status ?? "require_payment_method"),
      order_id: ref(user.id), updated_at: new Date().toISOString(),
    });

    return json({ ok: true, url: String(pi.body.url), pi_id: String(pi.body.id), kind });
  }

  // ── /profile — user-authed: read-only billing profile for display (plan + card) ──
  if (req.method === "GET" && path === "/profile") {
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Not signed in" }, 401);
    const { data: u } = await db.auth.getUser(jwt);
    const user = u?.user;
    if (!user?.id) return json({ error: "Not signed in" }, 401);
    const { data: row } = await db.from("cloud_stancer_customers")
      .select("plan,period,amount_cents,card_last4,card_exp,save_offer_used_at,discount_next_pct")
      .eq("user_id", user.id).maybeSingle();
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
        .select("pi_id").eq("user_id", user.id)
        .in("kind", ["trial_setup", "plan_change", "resubscribe", "card_update"])
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
    const kind = String(meta.kind ?? "trial_setup");
    const custId = pi.customer ? String(pi.customer) : undefined;
    // Display enrichment: the PI usually returns the card as a bare token string, so
    // recover last4/expiry from the card object ("•••• 0077" in the subscription UI).
    let last4 = card.last4;
    let cardExp: string | undefined;
    if (!last4) {
      const info = await fetchCard(card.id);
      if (info) { last4 = info.last4; cardExp = info.exp; }
    }
    // Common to every kind: save/replace the card token.
    // Only touches these columns — plan/period/amount set at /checkout are preserved.
    await db.from("cloud_stancer_customers").upsert({
      user_id: user.id, stancer_customer_id: custId, card_token: card.id,
      card_last4: last4 ?? undefined, card_exp: cardExp ?? undefined, updated_at: nowIso,
    });
    try { await db.from("cloud_stancer_payments").update({ status: pi.status }).eq("pi_id", piId); } catch (_) { /* noop */ }

    const { data: curRow } = await db.from("cloud_entitlement_projection")
      .select("status,trial_ends_at,trial_consumed_at").eq("user_id", user.id).maybeSingle();
    const cur = curRow as { status?: string; trial_ends_at?: string; trial_consumed_at?: string } | null;
    const curStatus = String(cur?.status ?? "");

    if (kind === "card_update") {
      // Token swap only — status and billing dates untouched. If the sub was stuck
      // on a failed payment, requeue it: back to active with the period due NOW so
      // the billing cron retries the charge within the hour on the new card.
      if (curStatus === "past_due" || curStatus === "grace") {
        await db.from("cloud_entitlement_projection").update({
          status: "active", provider: "stancer", current_period_end: nowIso, last_event_at: nowIso,
        }).eq("user_id", user.id);
        return json({ ok: true, status: "retrying", kind });
      }
      return json({ ok: true, status: "updated", kind });
    }

    if (kind === "plan_change") {
      // Live subscriber picked a (possibly different) plan: swap the plan, keep the
      // status and every date — no new trial, no double charge. The new amount was
      // recorded on the mapping row at /checkout and applies at the next cycle.
      const patch: Record<string, unknown> = {
        provider: "stancer", provider_customer_id: custId, plan_code: plan, last_event_at: nowIso,
      };
      if (curStatus === "cancelled_at_period_end") {
        // Picking a plan while a cancellation is pending = resuming.
        patch.status = (cur?.trial_ends_at && new Date(cur.trial_ends_at).getTime() > Date.now()) ? "trialing" : "active";
      }
      await db.from("cloud_entitlement_projection").update(patch).eq("user_id", user.id);
      return json({ ok: true, status: "plan_changed", kind });
    }

    if (kind === "resubscribe") {
      // Trial already consumed and no live entitlement: activate now, first charge
      // is due immediately (the billing cron picks it up on its next run).
      await db.from("cloud_entitlement_projection").upsert({
        user_id: user.id, status: "active", provider: "stancer", provider_customer_id: custId,
        plan_code: plan, current_period_end: nowIso, last_event_at: nowIso,
      });
      return json({ ok: true, status: "active", kind });
    }

    // trial_setup — the ONLY path that grants trial days. Replay-guarded: once the
    // trial has been consumed, re-confirming an old setup PI must never mint fresh
    // days (it would otherwise reset trial_ends_at to now+7d on every call).
    if (cur?.trial_consumed_at) {
      return json({ ok: true, status: curStatus || "trialing", kind, note: "already_confirmed" });
    }
    await db.from("cloud_entitlement_projection").upsert({
      user_id: user.id, status: "trialing", provider: "stancer", provider_customer_id: custId,
      plan_code: plan, trial_ends_at: new Date(Date.now() + TRIAL_DAYS * 86400_000).toISOString(),
      trial_consumed_at: nowIso, last_event_at: nowIso,
    });
    return json({ ok: true, status: "trialing", kind });
  }

  // ── /change-plan — user-authed: ONE-CLICK plan change, no card re-entry ──────
  // The card token is already on file, so an existing subscriber never re-types
  // their card to change plans (upsell-friendly). Money-safe semantics:
  //   upgrade  (new price ≥ current) → applies IMMEDIATELY (limits unlock now),
  //            the new price is charged from the next cycle — no charge today.
  //   downgrade (new price < current) → SCHEDULED for the next cycle: the mapping
  //            row carries the future plan/amount, the projection keeps the paid
  //            plan until renewal (the billing cron syncs plan_code on charge).
  // Falls back to the checkout flow when there is no live sub or no card on file.
  if (req.method === "POST" && path === "/change-plan") {
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Not signed in" }, 401);
    const { data: u } = await db.auth.getUser(jwt);
    const user = u?.user;
    if (!user?.id) return json({ error: "Not signed in" }, 401);

    let payload: { plan?: string; period?: string } = {};
    try { payload = await req.json(); } catch (_) { /* defaults below */ }
    const plan = payload.plan === "family" ? "family" : "plus";
    const period = payload.period === "annual" ? "annual" : "monthly";
    const amount = PRICES[plan]?.[period];
    if (!amount) return json({ error: "Unknown plan" }, 400);

    const { data: projRow } = await db.from("cloud_entitlement_projection")
      .select("status,provider,trial_ends_at,current_period_end,plan_code")
      .eq("user_id", user.id).maybeSingle();
    const proj = projRow as { status?: string; provider?: string; trial_ends_at?: string; current_period_end?: string; plan_code?: string } | null;
    const { data: custRow } = await db.from("cloud_stancer_customers")
      .select("card_token,plan,period,amount_cents").eq("user_id", user.id).maybeSingle();
    const cust = custRow as { card_token?: string; plan?: string; period?: string; amount_cents?: number } | null;

    const nowMs = Date.now();
    const trialEndMs = proj?.trial_ends_at ? new Date(proj.trial_ends_at).getTime() : 0;
    const periodEndMs = proj?.current_period_end ? new Date(proj.current_period_end).getTime() : 0;
    const st = String(proj?.status ?? "");
    const live = String(proj?.provider ?? "") === "stancer" && (
      (st === "trialing" && trialEndMs > nowMs) ||
      (st === "active" && (periodEndMs === 0 || periodEndMs > nowMs)) ||
      (st === "cancelled_at_period_end" && periodEndMs > nowMs)
    );
    if (!live) return json({ ok: false, reason: "no_live_sub" });
    if (!cust?.card_token) return json({ ok: false, reason: "requires_card" });
    if (cust.plan === plan && cust.period === period) return json({ ok: true, status: "unchanged", plan, period });

    const nowIso = new Date().toISOString();
    const currentAmount = cust.amount_cents ?? 0;
    const upgrade = amount >= currentAmount;
    // The mapping row always carries what the NEXT charge should be.
    await db.from("cloud_stancer_customers").upsert({
      user_id: user.id, plan, period, amount_cents: amount, updated_at: nowIso,
    });
    const patch: Record<string, unknown> = { last_event_at: nowIso };
    if (upgrade) patch.plan_code = plan; // limits unlock immediately
    if (st === "cancelled_at_period_end") {
      // Choosing a plan while a cancellation is pending = resuming.
      patch.status = trialEndMs > nowMs ? "trialing" : "active";
    }
    await db.from("cloud_entitlement_projection").update(patch).eq("user_id", user.id);
    return json({ ok: true, status: upgrade ? "plan_changed" : "plan_scheduled", plan, period });
  }

  // ── /cancel — user-authed: stop auto-renewal; access runs to the period end ──
  // Honors the "cancel anytime" promise for the Stancer (web) rail. The billing
  // cron only charges trialing/active rows, so a cancelled row is never charged.
  // Accepts an optional {reason} from the cancel flow — journaled for analytics,
  // never a condition: the cancellation itself always goes through.
  if (req.method === "POST" && path === "/cancel") {
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Not signed in" }, 401);
    const { data: u } = await db.auth.getUser(jwt);
    const user = u?.user;
    if (!user?.id) return json({ error: "Not signed in" }, 401);

    let payload: { reason?: string } = {};
    try { payload = await req.json(); } catch (_) { /* reason is optional */ }
    const reason = String(payload.reason ?? "skipped");

    const { data: row } = await db.from("cloud_entitlement_projection")
      .select("status,provider,trial_ends_at,current_period_end").eq("user_id", user.id).maybeSingle();
    const p = row as { status?: string; provider?: string; trial_ends_at?: string; current_period_end?: string } | null;
    if (!p || String(p.provider ?? "") !== "stancer") {
      return json({ error: "No cancellable Norva plan on this account" }, 400);
    }
    const st = String(p.status ?? "");
    const nowIso = new Date().toISOString();
    if (st === "trialing") {
      // Cancel during the trial: nothing will ever be charged; access runs to the
      // trial end (current_period_end must carry it — the entitlement check for
      // cancelled_at_period_end reads current_period_end, not trial_ends_at).
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
      // Payment already failing — cancelling closes it out cleanly (win-back later).
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

  // ── /save-offer — user-authed: accept the cancel-flow counter-offer ──────────
  // One-shot per customer: 50% off the NEXT charge (trial first charge or renewal),
  // applied by the billing cron then cleared. If a cancellation was already pending,
  // accepting the offer also resumes the plan. Never creates entitlement by itself.
  if (req.method === "POST" && path === "/save-offer") {
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Not signed in" }, 401);
    const { data: u } = await db.auth.getUser(jwt);
    const user = u?.user;
    if (!user?.id) return json({ error: "Not signed in" }, 401);

    let payload: { reason?: string } = {};
    try { payload = await req.json(); } catch (_) { /* reason is optional */ }
    const reason = String(payload.reason ?? "skipped");

    const { data: row } = await db.from("cloud_entitlement_projection")
      .select("status,provider,trial_ends_at,current_period_end").eq("user_id", user.id).maybeSingle();
    const p = row as { status?: string; provider?: string; trial_ends_at?: string; current_period_end?: string } | null;
    const st = String(p?.status ?? "");
    const nowMs = Date.now();
    const periodEndMs = p?.current_period_end ? new Date(p.current_period_end).getTime() : 0;
    const eligibleStatus = st === "trialing" || st === "active" ||
      (st === "cancelled_at_period_end" && periodEndMs > nowMs);
    if (!p || String(p.provider ?? "") !== "stancer" || !eligibleStatus) {
      return json({ ok: false, reason: "not_eligible" });
    }
    const { data: custRow } = await db.from("cloud_stancer_customers")
      .select("save_offer_used_at").eq("user_id", user.id).maybeSingle();
    if ((custRow as { save_offer_used_at?: string } | null)?.save_offer_used_at) {
      return json({ ok: false, reason: "already_used" });
    }

    const nowIso = new Date().toISOString();
    await db.from("cloud_stancer_customers").upsert({
      user_id: user.id, discount_next_pct: SAVE_OFFER_PCT, save_offer_used_at: nowIso, updated_at: nowIso,
    });
    if (st === "cancelled_at_period_end") {
      // Accepting the offer while a cancellation is pending = staying.
      const backTo = (p.trial_ends_at && new Date(p.trial_ends_at).getTime() > nowMs) ? "trialing" : "active";
      await db.from("cloud_entitlement_projection").update({ status: backTo, last_event_at: nowIso }).eq("user_id", user.id);
    }
    await logCancelFeedback(db, user.id, reason, "saved", st, `discount${SAVE_OFFER_PCT}`);
    return json({ ok: true, status: "offer_applied", discount_pct: SAVE_OFFER_PCT });
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
    if (!p || String(p.provider ?? "") !== "stancer" || String(p.status ?? "") !== "cancelled_at_period_end") {
      return json({ error: "No pending cancellation to resume" }, 400);
    }
    const periodEndMs = p.current_period_end ? new Date(p.current_period_end).getTime() : 0;
    if (!periodEndMs || periodEndMs <= Date.now()) {
      return json({ error: "The plan has already ended — resubscribe instead" }, 400);
    }
    const nowIso = new Date().toISOString();
    // Back to where it was: still inside the trial window → trialing (charged at
    // trial end); otherwise a paid period → active (renewed at period end).
    const backTo = (p.trial_ends_at && new Date(p.trial_ends_at).getTime() > Date.now()) ? "trialing" : "active";
    await db.from("cloud_entitlement_projection").update({
      status: backTo, last_event_at: nowIso,
    }).eq("user_id", user.id);
    return json({ ok: true, status: backTo });
  }

  return json({ error: "Not found" }, 404);
});
