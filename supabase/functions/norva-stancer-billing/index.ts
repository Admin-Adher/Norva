// Stancer recurring-billing cron — the ONLY place that charges a saved card. INERT until
// STANCER_SECRET_KEY is set. A pg_cron job POSTs here hourly; this:
//   • TRIAL → FIRST CHARGE: provider='stancer' + status='trialing' + trial_ends_at ≤ now → charge the
//     saved card token for the plan amount; success → 'active' (+ current_period_end); fail → 'past_due'.
//   • RENEWAL: status='active' + current_period_end ≤ now → charge again; extend or → 'past_due'.
// Failures flow to dunning via norva-lifecycle. Idempotency is enforced with Stancer's `unique_id`
// (userId:cycle) so a re-run never double-charges. Charge request CONFIRMED against the test sandbox:
//   POST /v1/checkout/ { amount, currency:"eur", card:"card_…", customer:"cust_…", unique_id } → { status, response }
//   success = status "captured" / response "00".
//
// Cron to register AT/AFTER DEPLOY:
//   select cron.schedule('norva-stancer-billing', '17 * * * *', $$
//     select net.http_post(
//       url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-stancer-billing/cron/run',
//       headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' ||
//         (select decrypted_secret from vault.decrypted_secrets where name = 'norva_cron_shared_secret')),
//       body := '{}'::jsonb, timeout_milliseconds := 60000);
//   $$);

import { createClient } from "npm:@supabase/supabase-js@2";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { renderReceipt } from "../_shared/lifecycle-email.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_KEY") ?? "";
const STANCER_SECRET_KEY = Deno.env.get("STANCER_SECRET_KEY") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const FROM = Deno.env.get("AUTH_EMAIL_FROM") ?? "Norva <noreply@norva.tv>";
const STANCER_API = "https://api.stancer.com";
const BATCH = 100;

// Best-effort payment receipt after a successful charge.
async function sendReceipt(db: SupabaseClient, userId: string, planLabel: string, amountCents: number, periodEnd: string): Promise<void> {
  if (!RESEND_API_KEY) return;
  try {
    const { data: u } = await db.auth.admin.getUserById(userId);
    const email = u?.user?.email;
    if (!email) return;
    const m = u?.user?.user_metadata ?? {};
    const full = String((m as Record<string, unknown>).display_name ?? (m as Record<string, unknown>).name ?? "").trim();
    const first = full ? full.split(/\s+/)[0] : null;
    const r = renderReceipt(first, { planLabel, amount: `€${(amountCents / 100).toFixed(2)}`, periodEnd });
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to: [email], subject: r.subject, html: r.html }),
    });
  } catch (_) { /* best-effort */ }
}

const PRICES: Record<string, Record<string, number>> = {
  plus:   { monthly: 499, annual: 4199 },
  family: { monthly: 899, annual: 7599 },
};

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
function basicAuth(): string { return "Basic " + btoa(`${STANCER_SECRET_KEY}:`); }

function parsePlan(planCode: string | null): { plan: string; period: string; amount: number } | null {
  const [plan, period] = String(planCode ?? "").toLowerCase().split("_");
  const amount = PRICES[plan]?.[period];
  return amount ? { plan, period, amount } : null;
}

function addPeriod(fromIso: string | null, period: string): string {
  const d = fromIso ? new Date(fromIso) : new Date();
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  if (period === "annual") d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString();
}

interface Row { user_id: string; plan_code: string | null; trial_ends_at: string | null; current_period_end: string | null }

// Charge the saved token. Returns 'captured' | 'failed'.
async function chargeToken(cardToken: string, customerId: string | null, amount: number, uniqueId: string, desc: string): Promise<"captured" | "failed"> {
  const res = await fetch(`${STANCER_API}/v1/checkout/`, {
    method: "POST",
    headers: { Authorization: basicAuth(), "Content-Type": "application/json" },
    body: JSON.stringify({ amount, currency: "eur", card: cardToken, customer: customerId ?? undefined, unique_id: uniqueId.slice(0, 36), description: desc }),
  });
  const body = await res.json().catch(() => ({}));
  const ok = res.ok && (String(body.status) === "captured" || String(body.status) === "to_capture" || String(body.response) === "00");
  return ok ? "captured" : "failed";
}

// Process one due user (trial-first-charge or renewal). `cycleAnchor` keys the idempotent unique_id.
async function chargeUser(db: SupabaseClient, row: Row, kind: "first_charge" | "renewal", cycleAnchor: string | null): Promise<string> {
  const plan = parsePlan(row.plan_code);
  if (!plan) return "no_plan";
  const { data: cust } = await db.from("cloud_stancer_customers")
    .select("stancer_customer_id,card_token").eq("user_id", row.user_id).maybeSingle();
  const cardToken = (cust as { card_token?: string } | null)?.card_token;
  const customerId = (cust as { stancer_customer_id?: string } | null)?.stancer_customer_id ?? null;
  if (!cardToken) {
    // No token on file → cannot charge. Fail to past_due so dunning asks for a card update.
    await db.from("cloud_entitlement_projection").update({ status: "past_due", last_event_at: new Date().toISOString() }).eq("user_id", row.user_id);
    return "no_card";
  }

  // Stancer caps unique_id at 36 chars. Dashless uuid (32) + a compact base36 cycle-day (~4) keeps it
  // globally unique per (user, cycle) so a re-run never double-charges the SAME cycle.
  const cycleDay = Math.floor((Date.parse(String(cycleAnchor ?? "")) || Date.now()) / 86400000).toString(36);
  const uniqueId = (row.user_id.replace(/-/g, "") + cycleDay).slice(0, 36);
  const outcome = await chargeToken(cardToken, customerId, plan.amount, uniqueId, `Norva ${plan.plan} ${plan.period} — ${kind}`);

  const nowIso = new Date().toISOString();
  if (outcome === "captured") {
    const base = kind === "first_charge" ? row.trial_ends_at : row.current_period_end;
    const nextEnd = addPeriod(base, plan.period);
    await db.from("cloud_entitlement_projection").update({
      status: "active", provider: "stancer", current_period_end: nextEnd,
      dunning_stage: 0, dunning_last_at: null, last_event_at: nowIso, last_verified_at: nowIso,
    }).eq("user_id", row.user_id);
    try { await db.from("cloud_stancer_payments").upsert({ pi_id: `charge_${uniqueId}`, user_id: row.user_id, kind, amount: plan.amount, currency: "eur", status: "captured", order_id: uniqueId, updated_at: nowIso }); } catch (_) { /* noop */ }
    await sendReceipt(db, row.user_id, `Norva ${plan.plan === "family" ? "Family" : ""}`.trim(), plan.amount, nextEnd);
    return "charged";
  }
  // Failed → past_due (dunning handled by norva-lifecycle).
  await db.from("cloud_entitlement_projection").update({ status: "past_due", last_event_at: nowIso }).eq("user_id", row.user_id);
  return "failed";
}

async function run(db: SupabaseClient): Promise<Record<string, number>> {
  const nowIso = new Date().toISOString();
  const out = { trial_charged: 0, renew_charged: 0, failed: 0, no_card: 0 };

  // 1) Trials whose 7 days are up.
  const { data: trials } = await db.from("cloud_entitlement_projection")
    .select("user_id,plan_code,trial_ends_at,current_period_end")
    .eq("provider", "stancer").eq("status", "trialing").lte("trial_ends_at", nowIso).limit(BATCH);
  for (const row of (trials ?? []) as Row[]) {
    const r = await chargeUser(db, row, "first_charge", row.trial_ends_at);
    if (r === "charged") out.trial_charged++; else if (r === "no_card") out.no_card++; else if (r === "failed") out.failed++;
  }

  // 2) Active subscriptions due for renewal.
  const { data: renewals } = await db.from("cloud_entitlement_projection")
    .select("user_id,plan_code,trial_ends_at,current_period_end")
    .eq("provider", "stancer").eq("status", "active").lte("current_period_end", nowIso).limit(BATCH);
  for (const row of (renewals ?? []) as Row[]) {
    const r = await chargeUser(db, row, "renewal", row.current_period_end);
    if (r === "charged") out.renew_charged++; else if (r === "no_card") out.no_card++; else if (r === "failed") out.failed++;
  }

  return out;
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
  if (!STANCER_SECRET_KEY) return json({ ok: true, inert: true });

  try {
    const result = await run(db);
    return json({ ok: true, ...result });
  } catch (e) {
    console.error("[norva-stancer-billing] run failed", e instanceof Error ? e.message : e);
    return json({ error: "run failed" }, 500);
  }
});
