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
//
// IDENTITY — Revolut has no notion of our user. The checkout (norva-revolut)
// stamps the order/subscription `metadata` with { user_id, plan, period, kind };
// this webhook reads them back. Events without a resolvable user are ack'd (200)
// and skipped so Revolut doesn't retry forever.
//
// ⚠️ BRING-UP: the exact JSON paths of the Revolut order/subscription payload are
// still being confirmed against real sandbox deliveries — this function LOGS the
// full payload and reads fields from several candidate locations. Once the first
// real event is captured, tighten `pickOrder`/`projectionPatch` (search TODO).
//
// Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, REVOLUT_WEBHOOK_SIGNING_SECRET.
// Optional: NORVA_TRIAL_DAYS (7), NORVA_BILLING_FAIL_OPEN_HOURS (72).

import { createClient } from "npm:@supabase/supabase-js@2";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

type JsonRecord = Record<string, unknown>;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SECRET_KEY") ??
  "";
const SIGNING_SECRET = Deno.env.get("REVOLUT_WEBHOOK_SIGNING_SECRET") ?? "";
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

  // Raw body FIRST — the HMAC is over the exact bytes; parsing then re-serializing
  // would change them and break verification.
  const raw = await req.text();
  if (!(await verifySignature(req, raw))) return json({ error: "Invalid signature" }, 401);

  let body: JsonRecord;
  try { body = JSON.parse(raw) as JsonRecord; } catch (_) { return json({ error: "Invalid JSON" }, 400); }

  const eventType = String(body.event ?? body.type ?? "").toUpperCase();
  // Bring-up observability: log the full payload so the first real delivery pins
  // the exact shape. Bounded so a huge payload can't blow the log line.
  console.log("[norva-revolut-webhook]", eventType, JSON.stringify(body).slice(0, 4000));

  const order = pickOrder(body);
  const meta = recordOrEmpty(order.metadata ?? body.metadata);
  const userId = resolveUserId(meta);
  const eventId =
    stringOrNull(body.id) ?? stringOrNull(order.id) ??
    `${eventType}:${stringOrNull(order.order_id) ?? stringOrNull(order.subscription_id) ?? "?"}`;

  if (!userId) {
    console.warn("[norva-revolut-webhook] no user_id in metadata — needs mapping", { eventType, eventId });
    return json({ ok: true, skipped: "no_user_metadata" });
  }

  try {
    if (eventId && (await alreadyProcessed(admin, eventId))) return json({ ok: true, duplicate: true });

    const patch = projectionPatch(userId, eventType, order, meta);
    if (patch) {
      const { error } = await admin
        .from("cloud_entitlement_projection")
        .upsert(patch, { onConflict: "user_id" });
      if (error) throw new Error(`projection upsert failed: ${error.message}`);
    }

    await recordProcessedEvent(admin, userId, eventId, eventType, body);
    return json({ ok: true, type: eventType, plan: patch?.plan_code ?? null });
  } catch (error) {
    // 5xx → Revolut retries with backoff (3× / 10 min).
    const message = error instanceof Error ? error.message : "Unexpected error";
    console.error("[norva-revolut-webhook]", eventType, message);
    return json({ error: message }, 500);
  }
});

// --- event -> projection mapping --------------------------------------------

function projectionPatch(userId: string, type: string, order: JsonRecord, meta: JsonRecord): JsonRecord | null {
  const status = statusForEvent(type, meta);
  if (!status) return null; // event we don't reconcile (e.g. an intermediate ORDER_AUTHORISED)

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
    // TODO(payload): prefer the subscription's real trial-phase end from the
    // Revolut payload once confirmed; TRIAL_DAYS is the interim source of truth.
    patch.trial_ends_at = new Date(Date.now() + TRIAL_DAYS * 86_400_000).toISOString();
    patch.trial_consumed_at = nowIso;
    patch.current_period_end = patch.trial_ends_at;
  } else if (status === "active") {
    // TODO(payload): prefer the subscription's real next_billing/current_period_end.
    const days = period === "annual" ? 365 : 30;
    patch.current_period_end = new Date(Date.now() + days * 86_400_000).toISOString();
  }

  if (status === "past_due") {
    // Keep access open for a grace window instead of cutting immediately (matches
    // entitlements.ts fail-open behaviour).
    patch.fail_open_until = new Date(Date.now() + FAIL_OPEN_HOURS * 60 * 60 * 1000).toISOString();
  }

  return patch;
}

function statusForEvent(type: string, meta: JsonRecord): string | null {
  const kind = String(meta.kind ?? "").toLowerCase();
  switch (type) {
    case "SUBSCRIPTION_INITIATED":
      return "trialing"; // trial phase starts
    case "ORDER_COMPLETED":
      // trial-setup order (card saved, tiny/zero auth) keeps us trialing; a real
      // charge (first bill after trial, or a renewal) means active.
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
  if (plan === "norva" || plan === "plus") return "plus";
  if (plan.includes("family")) return "family";
  return "plus";
}

// Best-effort locate the order/subscription object in the payload. Revolut delivers
// either the object at the top level or nested under `data`/`order`. TODO(payload):
// collapse to the single confirmed path once a real sandbox delivery is captured.
function pickOrder(body: JsonRecord): JsonRecord {
  for (const c of [body.order, body.data, (recordOrEmpty(body.data)).order, body]) {
    const r = recordOrEmpty(c);
    if (r.metadata || r.id || r.order_id || r.subscription_id || r.customer_id) return r;
  }
  return body;
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
