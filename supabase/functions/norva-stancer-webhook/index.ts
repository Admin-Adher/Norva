// Stancer (web payment rail) webhook — INERT until STANCER_SECRET_KEY is set. Stancer has no native
// subscription object, so Norva orchestrates the trial/recurring itself (see docs/STANCER-BILLING.md).
// This endpoint receives payment notifications and, because Stancer's signature scheme isn't publicly
// documented, TRUSTS ONLY the re-fetched payment: it reads the payment_intent id from the body, then
// GETs it back from the Stancer API (Basic auth with our secret key) and acts on the AUTHORITATIVE
// status — never on the raw webhook body. An optional URL token (?t=) filters noise before the fetch.
//
// Maps authoritative status → cloud_entitlement_projection for the mapped user. The user mapping
// (cloud_stancer_payments / cloud_stancer_customers) is created by the checkout slice; until then this
// safely no-ops. Nothing here CHARGES a card — charging lives in the norva-stancer-billing cron.
//
// Stancer dashboard → Webhooks URL:
//   https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-stancer-webhook?t=<STANCER_WEBHOOK_TOKEN>

import { createClient } from "npm:@supabase/supabase-js@2";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_KEY") ?? "";
const STANCER_SECRET_KEY = Deno.env.get("STANCER_SECRET_KEY") ?? "";           // sprod_… / stest_…  (absent → inert)
const STANCER_WEBHOOK_TOKEN = Deno.env.get("STANCER_WEBHOOK_TOKEN") ?? "";     // optional ?t= url filter
const STANCER_API = "https://api.stancer.com";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// HTTP Basic with the API key as username, empty password (Stancer convention).
function basicAuth(): string {
  return "Basic " + btoa(`${STANCER_SECRET_KEY}:`);
}

// Pull a payment_intent id (pi_…) out of whatever shape Stancer posts.
function extractPaymentIntentId(body: Record<string, unknown>): string | null {
  const direct = String(body.payment_intent ?? body.id ?? "");
  if (direct.startsWith("pi_")) return direct;
  const nested = body.data && typeof body.data === "object" ? (body.data as Record<string, unknown>) : null;
  const nid = String(nested?.id ?? nested?.payment_intent ?? "");
  return nid.startsWith("pi_") ? nid : null;
}

// Re-fetch the authoritative payment_intent from Stancer.
async function fetchPaymentIntent(piId: string): Promise<{ id: string; status: string; customer?: string; metadata?: Record<string, unknown> } | null> {
  const res = await fetch(`${STANCER_API}/v2/payment_intent/${encodeURIComponent(piId)}`, {
    headers: { Authorization: basicAuth(), "Content-Type": "application/json" },
  });
  if (!res.ok) { console.error("[stancer-webhook] re-fetch failed", piId, res.status); return null; }
  return await res.json().catch(() => null);
}

// Authoritative Stancer status → projection status (trial vs paid distinction is set by the
// billing cron / metadata; here we only reflect success/failure of a charge).
function projectionStatusFor(stancerStatus: string, kind: string): string | null {
  const s = stancerStatus.toLowerCase();
  if (s === "captured" || s === "to_capture" || s === "authorized") {
    return kind === "trial_setup" ? "trialing" : "active";
  }
  if (s === "failed" || s === "refused") return "past_due";
  if (s === "expired" || s === "cancelled") return "expired";
  return null; // disputed / unknown → leave to manual / cron
}

// Resolve which user a payment belongs to. Prefers the checkout-populated journal; falls back to the
// payment metadata (order_id / user_id) the checkout stamps. No-ops safely if the tables don't exist yet.
async function resolveUser(db: SupabaseClient, pi: { id: string; customer?: string; metadata?: Record<string, unknown> }): Promise<{ userId: string; kind: string } | null> {
  try {
    const { data } = await db.from("cloud_stancer_payments").select("user_id,kind").eq("pi_id", pi.id).maybeSingle();
    if (data?.user_id) return { userId: String(data.user_id), kind: String(data.kind ?? "renewal") };
  } catch (_) { /* table not created yet → fall through */ }
  const metaUser = pi.metadata && typeof pi.metadata === "object" ? String((pi.metadata as Record<string, unknown>).user_id ?? "") : "";
  if (metaUser) return { userId: metaUser, kind: String((pi.metadata as Record<string, unknown>).kind ?? "renewal") };
  return null;
}

async function handle(db: SupabaseClient, piId: string): Promise<Record<string, unknown>> {
  const pi = await fetchPaymentIntent(piId);
  if (!pi) return { handled: false, reason: "refetch_failed" };
  const who = await resolveUser(db, pi);
  if (!who) return { handled: false, reason: "user_unresolved", status: pi.status };

  const next = projectionStatusFor(String(pi.status ?? ""), who.kind);
  if (!next) return { handled: false, reason: `no_mapping_for_${pi.status}` };

  // Idempotent journal update (best-effort; table arrives with the checkout slice).
  try {
    await db.from("cloud_stancer_payments").update({ status: pi.status }).eq("pi_id", pi.id);
  } catch (_) { /* noop */ }

  const patch: Record<string, unknown> = { status: next, provider: "stancer", last_event_at: new Date().toISOString() };
  if (pi.customer) patch.provider_customer_id = pi.customer;
  const { error } = await db.from("cloud_entitlement_projection").update(patch).eq("user_id", who.userId);
  if (error) return { handled: false, reason: "projection_update_failed" };
  return { handled: true, user: who.userId, status: pi.status, projection: next };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // Inert until configured — ack so Stancer doesn't retry-storm, but do nothing.
  if (!STANCER_SECRET_KEY || !SUPABASE_URL || !SERVICE_KEY) return json({ ok: true, inert: true });

  // Optional URL-token filter.
  if (STANCER_WEBHOOK_TOKEN) {
    const t = new URL(req.url).searchParams.get("t") ?? "";
    if (t !== STANCER_WEBHOOK_TOKEN) return json({ error: "Unauthorized" }, 403);
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_) { /* tolerate empty/non-json pings */ }
  const piId = extractPaymentIntentId(body);
  if (!piId) return json({ ok: true, ignored: "no_payment_intent_id" });

  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  try {
    const result = await handle(db, piId);
    return json({ ok: true, ...result });
  } catch (e) {
    console.error("[stancer-webhook] failed", e instanceof Error ? e.message : e);
    return json({ error: "handler failed" }, 500);
  }
});
