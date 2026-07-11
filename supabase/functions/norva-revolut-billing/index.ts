// Revolut recurring-billing cron — the ONLY place that charges a saved Revolut card.
// INERT until REVOLUT_SECRET_KEY is set. A pg_cron job POSTs here hourly; this:
//   • TRIAL → FIRST CHARGE: provider='revolut' + status='trialing' + trial_ends_at ≤ now →
//     charge the saved payment method for the plan amount; success → 'active'
//     (+ current_period_end); fail → 'past_due'.
//   • RENEWAL: status='active' + current_period_end ≤ now → charge again; extend or → 'past_due'.
//   • cancelled_at_period_end whose period is over → 'expired' (never charged).
//
// MIT charge (merchant-initiated, saved card) — confirmed API shape:
//   1) POST /api/1.0/orders  { amount, currency:"USD", capture_mode:"AUTOMATIC",
//                              merchant_order_ext_ref, description, customer_id } → { id }
//   2) POST /api/1.0/orders/{id}/payments
//        { saved_payment_method: { type:"card", id:<payment_method_id>, initiator:"merchant" } }
//      success = order state COMPLETED.
// Idempotency: the natural state transition de-dupes (a charged row becomes 'active' with a
// future current_period_end, so the queries below stop selecting it), and merchant_order_ext_ref
// is cycle-keyed so a retry within the same cycle reuses the same reference.
//
// Cron to register (self-host) AFTER DEPLOY:
//   select cron.schedule('norva-revolut-billing', '23 * * * *', $$
//     select net.http_post(
//       url := 'https://api.norva.tv/functions/v1/norva-revolut-billing/cron/run',
//       headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' ||
//         (select decrypted_secret from vault.decrypted_secrets where name = 'norva_cron_shared_secret')),
//       body := '{}'::jsonb, timeout_milliseconds := 90000);
//   $$);

import { createClient } from "npm:@supabase/supabase-js@2";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { renderReceipt } from "../_shared/lifecycle-email.ts";

type JsonRecord = Record<string, unknown>;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY") ?? "";
const REVOLUT_SECRET_KEY = Deno.env.get("REVOLUT_SECRET_KEY") ?? "";
const REVOLUT_API_BASE = (Deno.env.get("REVOLUT_API_BASE") ?? "https://sandbox-merchant.revolut.com").replace(/\/+$/, "");
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const FROM = Deno.env.get("AUTH_EMAIL_FROM") ?? "Norva <noreply@norva.tv>";
// Each user does 2-3 Revolut round-trips (create + pay [+ refetch]); keep the batch
// small so a run stays well within the edge wall-clock limit. The cron runs hourly.
const BATCH = 25;

const PRICES: Record<string, Record<string, number>> = {
  plus:   { monthly: 499, annual: 4199 },
  family: { monthly: 899, annual: 7599 },
};

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

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

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function addPeriod(fromIso: string | null, period: string): string {
  const d = fromIso ? new Date(fromIso) : new Date();
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  if (period === "annual") d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString();
}

// Best-effort payment receipt after a successful charge.
async function sendReceipt(db: SupabaseClient, userId: string, planLabel: string, amountCents: number, periodEnd: string): Promise<void> {
  if (!RESEND_API_KEY) return;
  try {
    const { data: u } = await db.auth.admin.getUserById(userId);
    const email = u?.user?.email;
    if (!email) return;
    const m = (u?.user?.user_metadata ?? {}) as Record<string, unknown>;
    const full = String(m.display_name ?? m.name ?? "").trim();
    const first = full ? full.split(/\s+/)[0] : null;
    const r = renderReceipt(first, { planLabel, amount: `$${(amountCents / 100).toFixed(2)}`, periodEnd });
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to: [email], subject: r.subject, html: r.html }),
    });
  } catch (_) { /* best-effort */ }
}

// Merchant-initiated charge of a saved card: create an auto-capture order, then pay it
// with the saved payment method. Returns the outcome + the Revolut order/payment ids.
async function chargeSavedCard(
  customerId: string, pmId: string, amount: number, extRef: string, desc: string,
): Promise<{ outcome: "captured" | "failed"; orderId: string | null; paymentId: string | null; detail?: unknown }> {
  const order = await revolut("POST", "/api/1.0/orders", {
    amount, currency: "USD", capture_mode: "AUTOMATIC",
    merchant_order_ext_ref: extRef, description: desc, customer_id: customerId,
  });
  const orderId = stringOrNull(order.body.id);
  if (!order.ok || !orderId) {
    console.error("[norva-revolut-billing] create order failed", order.status, JSON.stringify(order.body).slice(0, 300));
    return { outcome: "failed", orderId: null, paymentId: null, detail: order.body };
  }
  const pay = await revolut("POST", `/api/1.0/orders/${encodeURIComponent(orderId)}/payments`, {
    saved_payment_method: { type: "card", id: pmId, initiator: "merchant" },
  });
  let state = String(pay.body.state ?? "").toUpperCase();
  // If the charge is still settling, re-fetch the order once for the authoritative state.
  if (pay.ok && !["COMPLETED", "FAILED", "DECLINED", "CANCELLED"].includes(state)) {
    const refetch = await revolut("GET", `/api/1.0/orders/${encodeURIComponent(orderId)}`);
    state = String(refetch.body.state ?? state).toUpperCase();
  }
  const captured = pay.ok && state === "COMPLETED";
  if (!captured) console.warn("[norva-revolut-billing] charge not captured", pay.status, state, JSON.stringify(pay.body).slice(0, 300));
  return {
    outcome: captured ? "captured" : "failed",
    orderId,
    paymentId: stringOrNull(pay.body.id) ?? orderId,
    detail: captured ? undefined : pay.body,
  };
}

interface Row { user_id: string; plan_code: string | null; trial_ends_at: string | null; current_period_end: string | null }

async function chargeUser(db: SupabaseClient, row: Row, kind: "first_charge" | "renewal", cycleAnchor: string | null, errors: unknown[]): Promise<string> {
  const { data: cust } = await db.from("cloud_revolut_customers")
    .select("revolut_customer_id,payment_method_id,plan,period,amount_cents,discount_next_pct").eq("user_id", row.user_id).maybeSingle();
  const c = cust as {
    revolut_customer_id?: string; payment_method_id?: string; plan?: string; period?: string; amount_cents?: number; discount_next_pct?: number;
  } | null;
  const customerId = c?.revolut_customer_id ?? null;
  const pmId = c?.payment_method_id ?? null;
  const period = c?.period === "annual" ? "annual" : "monthly";
  const amount = c?.amount_cents ?? 0;
  const discountPct = (typeof c?.discount_next_pct === "number" && c.discount_next_pct >= 1 && c.discount_next_pct <= 99) ? c.discount_next_pct : 0;
  const mappedPlan = c?.plan === "family" ? "family" : (c?.plan === "plus" ? "plus" : null);
  const planLabel = (mappedPlan ?? row.plan_code) === "family" ? "Norva Family" : "Norva";
  const nowIso = new Date().toISOString();

  if (!customerId || !pmId || !amount) {
    // No saved card yet (e.g. /profile never captured it) or no amount → can't charge.
    // Fail to past_due so dunning (norva-lifecycle) prompts a card update.
    await db.from("cloud_entitlement_projection").update({ status: "past_due", last_event_at: nowIso, fail_open_until: addHours(nowIso, 72) }).eq("user_id", row.user_id);
    return pmId ? "no_plan" : "no_card";
  }

  // Cycle-keyed reference so a retry in the same cycle reuses it (Revolut caps ext_ref length).
  const cycleDay = Math.floor((Date.parse(String(cycleAnchor ?? "")) || Date.now()) / 86400000).toString(36);
  const extRef = `${row.user_id.replace(/-/g, "").slice(0, 24)}-r${cycleDay}`.slice(0, 40);
  const chargeAmount = discountPct ? Math.max(50, Math.round(amount * (100 - discountPct) / 100)) : amount;
  const desc = `${planLabel} ${period} — ${kind}${discountPct ? ` (${discountPct}% off)` : ""}`;

  const { outcome, orderId, paymentId, detail } = await chargeSavedCard(customerId, pmId, chargeAmount, extRef, desc);
  if (outcome === "failed" && detail && errors.length < 5) {
    errors.push({ user_id: row.user_id, detail: JSON.stringify(detail).slice(0, 400) });
  }

  if (outcome === "captured") {
    const base = kind === "first_charge" ? row.trial_ends_at : row.current_period_end;
    const nextEnd = addPeriod(base, period);
    await db.from("cloud_entitlement_projection").update({
      status: "active", provider: "revolut", current_period_end: nextEnd,
      ...(mappedPlan ? { plan_code: mappedPlan } : {}),
      fail_open_until: null, dunning_stage: 0, dunning_last_at: null,
      last_event_at: nowIso, last_verified_at: nowIso, mrr_cents: chargeAmount,
    }).eq("user_id", row.user_id);
    if (discountPct) {
      try { await db.from("cloud_revolut_customers").update({ discount_next_pct: null, updated_at: nowIso }).eq("user_id", row.user_id); } catch (_) { /* noop */ }
    }
    if (orderId) {
      try {
        await db.from("cloud_revolut_orders").upsert({
          order_id: orderId, public_id: paymentId, user_id: row.user_id, kind,
          amount: chargeAmount, currency: "usd", state: "completed", updated_at: nowIso,
        });
      } catch (_) { /* noop */ }
    }
    await sendReceipt(db, row.user_id, discountPct ? `${planLabel} (${discountPct}% off applied)` : planLabel, chargeAmount, nextEnd);
    return "charged";
  }

  // Failed → past_due (dunning handled by norva-lifecycle), keep a grace window open.
  await db.from("cloud_entitlement_projection").update({ status: "past_due", last_event_at: nowIso, fail_open_until: addHours(nowIso, 72) }).eq("user_id", row.user_id);
  return "failed";
}

function addHours(fromIso: string, hours: number): string {
  return new Date(new Date(fromIso).getTime() + hours * 3600_000).toISOString();
}

async function run(db: SupabaseClient): Promise<Record<string, unknown>> {
  const nowIso = new Date().toISOString();
  const out = { trial_charged: 0, renew_charged: 0, failed: 0, no_card: 0, ended: 0 };
  const errors: unknown[] = [];

  // 1) Trials whose free days are up → first charge.
  const { data: trials } = await db.from("cloud_entitlement_projection")
    .select("user_id,plan_code,trial_ends_at,current_period_end")
    .eq("provider", "revolut").eq("status", "trialing").lte("trial_ends_at", nowIso).limit(BATCH);
  for (const row of (trials ?? []) as Row[]) {
    const r = await chargeUser(db, row, "first_charge", row.trial_ends_at, errors);
    if (r === "charged") out.trial_charged++; else if (r === "no_card") out.no_card++; else if (r === "failed") out.failed++;
  }

  // 2) Active subscriptions due for renewal.
  const { data: renewals } = await db.from("cloud_entitlement_projection")
    .select("user_id,plan_code,trial_ends_at,current_period_end")
    .eq("provider", "revolut").eq("status", "active").lte("current_period_end", nowIso).limit(BATCH);
  for (const row of (renewals ?? []) as Row[]) {
    const r = await chargeUser(db, row, "renewal", row.current_period_end, errors);
    if (r === "charged") out.renew_charged++; else if (r === "no_card") out.no_card++; else if (r === "failed") out.failed++;
  }

  // 3) Cancelled plans whose paid/trial period is over → expired (never charged).
  const { data: ended } = await db.from("cloud_entitlement_projection")
    .select("user_id")
    .eq("provider", "revolut").eq("status", "cancelled_at_period_end").lte("current_period_end", nowIso).limit(BATCH);
  for (const row of (ended ?? []) as { user_id: string }[]) {
    await db.from("cloud_entitlement_projection").update({ status: "expired", last_event_at: nowIso }).eq("user_id", row.user_id);
    out.ended++;
  }

  return errors.length ? { ...out, errors } : out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "Service not configured" }, 500);
  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: ok } = await db.rpc("norva_verify_cron_secret", { presented: token });
  if (ok !== true) return json({ error: "Unauthorized" }, 403);

  // Inert until the rail is configured — nothing charges without a key.
  if (!REVOLUT_SECRET_KEY) return json({ ok: true, inert: true });

  try {
    const result = await run(db);
    return json({ ok: true, ...result });
  } catch (e) {
    console.error("[norva-revolut-billing] run failed", e instanceof Error ? e.message : e);
    return json({ error: "run failed" }, 500);
  }
});
