// Norva — Revolut Merchant webhook.
//
// Receives Revolut Merchant API webhook events and reconciles them into the
// `cloud_entitlement_projection` cache that Norva Cloud reads to decide access
// (see ../_shared/entitlements.ts). Modeled on norva-billing-webhook (RevenueCat):
// the projection is provider-agnostic, so Revolut is just a new writer with
// `provider:"revolut"`.
//
// AUTH — Revolut signs each webhook (HMAC-SHA256). We verify:
//   payload_to_sign = "v1." + Revolut-Request-Timestamp + "." + rawBody
//   expected        = "v1=" + hex(HMAC_SHA256(signing_secret, payload_to_sign))
//   compare (timing-safe) against Revolut-Signature (may hold multiple, space-
//   separated, during key rotation); reject a timestamp older than 5 min (replay).
//   Ref: developer.revolut.com/docs/guides/.../verify-the-payload-signature
//   (confirmed working against a real sandbox delivery on 2026-07-11.)
//
// MINIMAL BODY — Revolut delivers only { event, order_id }. The metadata, amount
// and authoritative state are NOT in the body, so we GET the order from Revolut
// ({REVOLUT_API_BASE}/api/1.0/orders/{id}) and trust the API — the same pattern
// (re-fetch the order and trust the API, not the raw body). The checkout stamps the
// order metadata with { user_id, plan, period, kind }, which we read back here.
// Events whose order has no resolvable user are ack'd (200) and skipped.
//
// Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//   REVOLUT_WEBHOOK_SIGNING_SECRET, REVOLUT_SECRET_KEY.
// Optional: REVOLUT_API_BASE (default sandbox), NORVA_TRIAL_DAYS (7),
//   NORVA_BILLING_FAIL_OPEN_HOURS (72).

import { createClient } from "npm:@supabase/supabase-js@2";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

type JsonRecord = Record<string, unknown>;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SECRET_KEY") ??
  "";
const SIGNING_SECRET = Deno.env.get("REVOLUT_WEBHOOK_SIGNING_SECRET") ?? "";
const REVOLUT_SECRET_KEY = Deno.env.get("REVOLUT_SECRET_KEY") ?? "";
// Sandbox during dev; set to https://merchant.revolut.com at production cutover.
const REVOLUT_API_BASE = (Deno.env.get("REVOLUT_API_BASE") ?? "https://sandbox-merchant.revolut.com").replace(/\/+$/, "");
const TRIAL_DAYS = boundedInt(Deno.env.get("NORVA_TRIAL_DAYS"), 7, 0, 90);
const FAIL_OPEN_HOURS = boundedInt(Deno.env.get("NORVA_BILLING_FAIL_OPEN_HOURS"), 72, 1, 24 * 14);
const TOLERANCE_MS = 5 * 60 * 1000;

const VALID_PLAN_CODES = new Set(["trial", "plus", "family", "premium", "manual", "none"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // Raw body FIRST — the HMAC is over the exact bytes.
  const raw = await req.text();
  if (!(await verifySignature(req, raw))) return json({ error: "Invalid signature" }, 401);

  let body: JsonRecord;
  try { body = JSON.parse(raw) as JsonRecord; } catch (_) { return json({ error: "Invalid JSON" }, 400); }

  const eventType = String(body.event ?? body.type ?? "").toUpperCase();
  const data = recordOrEmpty(body.data);
  const orderId = stringOrNull(body.order_id) ?? stringOrNull(data.order_id) ?? stringOrNull(data.id);
  const subscriptionId = stringOrNull(body.subscription_id) ?? stringOrNull(data.subscription_id);
  const eventId = `${eventType}:${orderId ?? subscriptionId ?? "?"}`;
  console.log("[norva-revolut-webhook]", eventType, eventId);

  try {
    // Idempotency before the API round-trip: Revolut retries, so a duplicate id
    // is ack'd and skipped without re-fetching.
    if (await alreadyProcessed(admin, eventId)) return json({ ok: true, duplicate: true });

    // Authoritative order from Revolut — the body carries no metadata/state.
    // TODO(subscriptions): fetch the subscription object for SUBSCRIPTION_* events.
    const order = orderId ? await fetchOrder(orderId) : {};
    const meta = recordOrEmpty(order.metadata);
    const userId = resolveUserId(meta);
    if (!userId) {
      console.warn("[norva-revolut-webhook] no user_id in order metadata — skipped", { eventType, orderId });
      return json({ ok: true, skipped: "no_user_metadata" });
    }

    const patch = projectionPatch(userId, eventType, order, meta);
    if (patch) {
      const { error } = await admin
        .from("cloud_entitlement_projection")
        .upsert(patch, { onConflict: "user_id" });
      if (error) throw new Error(`projection upsert failed: ${error.message}`);
    }

    await recordProcessedEvent(admin, userId, eventId, eventType, { event: body, order });
    return json({ ok: true, type: eventType, plan: patch?.plan_code ?? null });
  } catch (error) {
    // 5xx → Revolut retries with backoff (3× / 10 min).
    const message = error instanceof Error ? error.message : "Unexpected error";
    console.error("[norva-revolut-webhook]", eventType, message);
    return json({ error: message }, 500);
  }
});

// --- Revolut API ------------------------------------------------------------

async function fetchOrder(orderId: string): Promise<JsonRecord> {
  if (!REVOLUT_SECRET_KEY) {
    console.error("[norva-revolut-webhook] REVOLUT_SECRET_KEY not set — cannot fetch order");
    return {};
  }
  try {
    const resp = await fetch(`${REVOLUT_API_BASE}/api/1.0/orders/${encodeURIComponent(orderId)}`, {
      headers: { "Authorization": `Bearer ${REVOLUT_SECRET_KEY}`, "Accept": "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      console.warn(`[norva-revolut-webhook] fetchOrder ${orderId} → ${resp.status}`);
      return {};
    }
    return recordOrEmpty(await resp.json());
  } catch (e) {
    console.warn("[norva-revolut-webhook] fetchOrder failed", orderId, String((e as Error)?.message || e));
    return {};
  }
}

// --- event -> projection mapping --------------------------------------------

function projectionPatch(userId: string, type: string, order: JsonRecord, meta: JsonRecord): JsonRecord | null {
  const status = statusForEvent(type, meta);
  if (!status) return null;

  const planCode = planForMeta(meta);
  const period = String(meta.period ?? "").toLowerCase() === "annual" ? "annual" : "monthly";
  const nowIso = new Date().toISOString();

  const patch: JsonRecord = {
    user_id: userId,
    provider: "revolut",
    provider_customer_id: stringOrNull(order.customer_id) ?? stringOrNull(meta.customer_id),
    plan_code: planCode,
    status,
    // No per-user limit overrides — entitlements.ts layers the current plan-catalog
    // limits on read, so catalog changes apply without the webhook keeping a copy.
    limits: {},
    last_verified_at: nowIso,
    last_event_at: nowIso,
    bill_period: period,
  };

  if (status === "trialing") {
    // TODO(subscriptions): prefer the subscription's real trial-phase end once we
    // fetch it; TRIAL_DAYS is the interim source of truth.
    patch.trial_ends_at = new Date(Date.now() + TRIAL_DAYS * 86_400_000).toISOString();
    patch.trial_consumed_at = nowIso;
    patch.current_period_end = patch.trial_ends_at;
  } else if (status === "active") {
    // TODO(subscriptions): prefer the subscription's real next_billing/period end.
    const days = period === "annual" ? 365 : 30;
    patch.current_period_end = new Date(Date.now() + days * 86_400_000).toISOString();
    const cents = Number(recordOrEmpty(order.order_amount).value);
    if (Number.isFinite(cents) && cents > 0) patch.mrr_cents = Math.round(cents);
  }

  if (status === "past_due") {
    // Keep access open for a grace window (matches entitlements.ts fail-open).
    patch.fail_open_until = new Date(Date.now() + FAIL_OPEN_HOURS * 60 * 60 * 1000).toISOString();
  }

  // Customer-country proxy for the web rail: the card's ISSUING country, read on the
  // re-fetched order's payment details. Only stamp when present — an event whose order
  // carries no payment details must never null an already-known country.
  const cardCountry = cardCountryFromOrder(order);
  if (cardCountry) {
    patch.country_code = cardCountry;
    patch.country_source = "card";
  }

  return patch;
}

// Card issuing country (ISO alpha-2) from the order's payment details. CONFIRMED on
// live events (étape 0, 2026-07-17): payments[].payment_method.card.card_country.
// Older candidates kept as fallback for other API generations.
function cardCountryFromOrder(order: JsonRecord): string | null {
  const payments = Array.isArray(order.payments) ? order.payments as JsonRecord[] : [];
  for (const p of payments) {
    const pm = recordOrEmpty(p.payment_method);
    const card = recordOrEmpty(pm.card);
    const raw = card.card_country ?? pm.card_country_code ?? card.card_country_code ?? card.country_code ?? p.card_country_code;
    if (typeof raw === "string" && /^[A-Za-z]{2}$/.test(raw.trim())) return raw.trim().toUpperCase();
  }
  return null;
}

function statusForEvent(type: string, meta: JsonRecord): string | null {
  const kind = String(meta.kind ?? "").toLowerCase();
  switch (type) {
    case "SUBSCRIPTION_INITIATED":
      return "trialing"; // trial phase starts
    case "ORDER_COMPLETED":
      // trial-setup order (card saved) keeps us trialing; a real charge → active.
      return kind === "trial_setup" ? "trialing" : "active";
    case "ORDER_PAYMENT_DECLINED":
    case "ORDER_PAYMENT_FAILED":
    case "SUBSCRIPTION_OVERDUE":
      return "past_due";
    case "SUBSCRIPTION_CANCELLED":
      return "cancelled_at_period_end"; // entitled until period end, no auto-renew
    case "SUBSCRIPTION_FINISHED":
      return "expired";
    default:
      return null;
  }
}

function planForMeta(meta: JsonRecord): string {
  const plan = String(meta.plan ?? "").toLowerCase();
  if (VALID_PLAN_CODES.has(plan)) return plan;
  if (plan === "norva") return "plus";
  if (plan.includes("family")) return "family";
  return "plus";
}

// --- signature verification -------------------------------------------------

async function verifySignature(req: Request, raw: string): Promise<boolean> {
  if (!SIGNING_SECRET) {
    console.error("[norva-revolut-webhook] REVOLUT_WEBHOOK_SIGNING_SECRET is not set");
    return false; // fail closed
  }
  const ts = req.headers.get("Revolut-Request-Timestamp") ?? "";
  const sigHeader = req.headers.get("Revolut-Signature") ?? "";
  if (!ts || !sigHeader) return false;
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > TOLERANCE_MS) {
    console.warn("[norva-revolut-webhook] stale or invalid timestamp");
    return false;
  }
  const expected = "v1=" + (await hmacHex(SIGNING_SECRET, `v1.${ts}.${raw}`));
  // The header can carry multiple space-separated signatures during key rotation.
  return sigHeader.split(/\s+/).filter(Boolean).some((s) => timingSafeEqual(s, expected));
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

// --- persistence helpers ----------------------------------------------------

async function alreadyProcessed(db: SupabaseClient, eventId: string): Promise<boolean> {
  const { data, error } = await db
    .from("cloud_entitlement_events")
    .select("id")
    .eq("provider", "revolut")
    .eq("provider_event_id", eventId)
    .maybeSingle();
  if (error) return false; // read error → reprocess (upsert is idempotent)
  return Boolean(data);
}

async function recordProcessedEvent(
  db: SupabaseClient,
  userId: string,
  eventId: string | null,
  eventType: string,
  payload: JsonRecord,
): Promise<void> {
  const { error } = await db.from("cloud_entitlement_events").insert({
    user_id: userId,
    provider: "revolut",
    provider_event_id: eventId,
    event_type: eventType || "unknown",
    payload,
    processed_at: new Date().toISOString(),
  });
  if (error && (error as { code?: string }).code !== "23505") {
    throw new Error(`event insert failed: ${error.message}`);
  }
}

// --- small utilities --------------------------------------------------------

function resolveUserId(meta: JsonRecord): string | null {
  const id = stringOrNull(meta.user_id) ?? stringOrNull(meta.userId);
  return id && UUID_RE.test(id) ? id : null;
}

function recordOrEmpty(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t.length ? t : null;
}

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
