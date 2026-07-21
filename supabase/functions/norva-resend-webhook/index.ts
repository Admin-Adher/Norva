/**
 * norva-resend-webhook — signed Resend delivery-event ingestion.
 *
 * Resend retries webhooks and does not guarantee delivery order.  The database
 * RPC uses svix-id as an idempotency key and merges each status timestamp
 * independently.  The function intentionally drops message bodies, click URLs,
 * IP addresses and user-agent data before persistence.
 *
 * Required secret: RESEND_WEBHOOK_SECRET (whsec_... returned when the webhook is
 * created in Resend).  Deploy with verify_jwt=false; authentication is the Svix
 * HMAC signature on the raw request body.
 */

import { createClient } from "npm:@supabase/supabase-js@2";
import {
  eventTypeAllowed,
  norvaEventAllowed,
  normalizedRecipients,
  safeDiagnosticData,
  safeTags,
  shortText,
  verifyWebhookSignature,
} from "../_shared/resend-webhook.mjs";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_KEY") ?? "";
const WEBHOOK_SECRET = Deno.env.get("RESEND_WEBHOOK_SECRET") ?? "";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

export interface ResendWebhookPayload {
  type?: unknown;
  created_at?: unknown;
  data?: unknown;
}

async function handle(req: Request): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!WEBHOOK_SECRET || !SUPABASE_URL || !SERVICE_KEY) {
    console.error("[norva-resend-webhook] required server configuration is missing");
    return json({ error: "not_configured" }, 503);
  }

  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 262_144) {
    return json({ error: "payload_too_large" }, 413);
  }

  const rawBody = await req.text();
  if (rawBody.length > 262_144) return json({ error: "payload_too_large" }, 413);
  if (!await verifyWebhookSignature({ secret: WEBHOOK_SECRET, headers: req.headers, rawBody })) {
    return json({ error: "invalid_signature" }, 401);
  }

  let payload: ResendWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as ResendWebhookPayload;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const eventId = shortText(req.headers.get("svix-id") ?? req.headers.get("webhook-id"), 200);
  const eventType = shortText(payload.type, 100);
  const data = record(payload.data);
  const emailId = shortText(data.email_id, 200);
  const occurredAt = shortText(payload.created_at ?? data.created_at, 100);
  const occurredTimestamp = occurredAt ? Date.parse(occurredAt) : Number.NaN;

  if (!eventId || !eventType || !eventTypeAllowed(eventType)) {
    // A signed event outside the configured email taxonomy is acknowledged so
    // an accidentally expanded Resend subscription cannot create a retry storm.
    return json({ received: true, ignored: "unsupported_event" });
  }
  if (!emailId || !Number.isFinite(occurredTimestamp)) {
    return json({ error: "invalid_event" }, 400);
  }

  const tags = safeTags(data.tags);
  if (!norvaEventAllowed(data.from, tags)) {
    return json({ received: true, ignored: "foreign_application" });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: inserted, error } = await admin.rpc("norva_record_resend_email_event", {
    p_event_id: eventId,
    p_event_type: eventType,
    p_provider_email_id: emailId,
    p_occurred_at: new Date(occurredTimestamp).toISOString(),
    p_from_email: shortText(data.from, 500),
    p_to_emails: normalizedRecipients(data.to),
    p_tags: tags,
    p_diagnostic_data: safeDiagnosticData(eventType, data),
  });
  if (error) {
    console.error("[norva-resend-webhook] durable event write failed", {
      eventType,
      eventId,
      error: error.message,
    });
    return json({ error: "storage_failed" }, 500);
  }

  return json({ received: true, duplicate: inserted === false });
}

if (import.meta.main) Deno.serve(handle);

export { handle };
