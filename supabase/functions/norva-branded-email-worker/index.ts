// Durable sender for DB-originated branded emails (security alerts + trial reminders).
// PostgreSQL owns immutable requests and delivery state; this worker owns only
// authenticated draining and Resend network I/O.

import { createClient } from "npm:@supabase/supabase-js@2";
import { sendFcmPush, fcmConfigured } from "../_shared/fcm.ts";

type JsonRecord = Record<string, unknown>;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SECRET_KEY") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const DELIVERY_BATCH = 4; // below Resend's default five-requests/second limit

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

interface DeliveryClaim {
  id: string;
  delivery_key: string;
  lease_token: string;
  flow: string;
  user_id: string | null;
  is_marketing: boolean;
  marker_kind: string | null;
  marker_reference: string | null;
  marker_stage: number | null;
  recipient_email: string;
  request_from: string;
  request_reply_to: string;
  request_subject: string;
  request_html: string;
  request_text: string;
  request_tags: Array<{ name: string; value: string }>;
  request_headers: Record<string, string>;
  attempt_count: number;
}

interface ResendResult {
  accepted: boolean;
  status: number | null;
  emailId: string | null;
  response: JsonRecord;
  error: string;
  retryAfterSeconds: number | null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function retryableResendStatus(status: number | null, response: JsonRecord): boolean {
  if (status === 409) {
    const name = String(response.name ?? "").trim().toLowerCase();
    if (name === "concurrent_idempotent_requests") return true;
    if (name === "invalid_idempotent_request" || name) return false;
    const detail = String(response.message ?? "").toLowerCase();
    return /concurrent|in.?progress|already processing/.test(detail) &&
      !/invalid|mismatch|different payload|expired/.test(detail);
  }
  return status === null || status === 401 || status === 403 || status === 408 ||
    status === 425 || status === 429 || status >= 500;
}

function ambiguousResendStatus(status: number | null, retryable: boolean): boolean {
  return status === null || status === 408 || status === 425 || status === 429 ||
    (status !== null && status >= 500) || (status === 409 && retryable) ||
    // A successful response without the required id may have accepted the email.
    (status !== null && status >= 200 && status <= 299);
}

function retryAfterSeconds(value: string | null): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Math.max(0, Math.min(21600, Number(value.trim())));
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.min(21600, Math.ceil((at - Date.now()) / 1000)));
}

function redactProviderText(value: unknown): string | null {
  const text = stringOrNull(value);
  if (!text) return null;
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\b(?:re_|whsec_)[A-Za-z0-9_-]{12,}\b/g, "[credential]")
    .slice(0, 500);
}

function safeProviderResponse(value: unknown): JsonRecord {
  const payload = value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
  const safe: JsonRecord = {};
  const id = stringOrNull(payload.id);
  const name = redactProviderText(payload.name);
  const message = redactProviderText(payload.message ?? payload.error);
  const statusCode = typeof payload.statusCode === "number" ? payload.statusCode : null;
  if (id) safe.id = id;
  if (name) safe.name = name;
  if (message) safe.message = message;
  if (statusCode !== null) safe.status_code = statusCode;
  return safe;
}

async function sendDelivery(claim: DeliveryClaim): Promise<ResendResult> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "User-Agent": "Norva-Branded-Email/2.0",
        "Idempotency-Key": claim.delivery_key,
      },
      body: JSON.stringify({
        from: claim.request_from,
        reply_to: claim.request_reply_to,
        to: [claim.recipient_email],
        subject: claim.request_subject,
        html: claim.request_html,
        text: claim.request_text,
        tags: claim.request_tags,
        ...(claim.request_headers && Object.keys(claim.request_headers).length
          ? { headers: claim.request_headers }
          : {}),
      }),
      signal: AbortSignal.timeout(8_000),
    });
    const raw = (await res.text()).slice(0, 4000);
    let parsed: unknown = {};
    try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) { parsed = {}; }
    const response = safeProviderResponse(parsed);
    const emailId = stringOrNull(response.id);
    return {
      accepted: res.ok && Boolean(emailId),
      status: res.status,
      emailId,
      response,
      error: res.ok && emailId ? "" : (res.ok ? "resend_missing_id" : `resend_http_${res.status}`),
      retryAfterSeconds: retryAfterSeconds(res.headers.get("retry-after")),
    };
  } catch (error) {
    const timeout = error instanceof DOMException && error.name === "TimeoutError";
    return {
      accepted: false,
      status: null,
      emailId: null,
      response: {},
      error: timeout ? "transport_timeout" : "transport_error",
      retryAfterSeconds: null,
    };
  }
}

async function pushAfterAcknowledgement(claim: DeliveryClaim): Promise<void> {
  if (!claim.user_id || !fcmConfigured()) return;
  const copy = claim.flow === "payment_failed"
    ? { title: "Payment issue on your Norva plan", body: "We couldn't process your payment — update your card to keep watching.", kind: "payment_failed" }
    : claim.flow === "winback"
    ? { title: "Your Norva catalog is waiting", body: "Pick up right where you left off — reactivate anytime.", kind: "winback" }
    : claim.flow === "checkout_abandoned"
    ? { title: "Your free trial is one step away", body: "Finish the quick card check — no charge today.", kind: "abandoned_checkout" }
    : null;
  if (!copy) return;
  if (claim.is_marketing) {
    const { data: allowed, error } = await admin.rpc("norva_marketing_email_allowed", { p_user_id: claim.user_id });
    if (error || allowed !== true) return;
  }
  try {
    const { data: tokens } = await admin.from("cloud_push_tokens").select("token").eq("user_id", claim.user_id);
    for (const row of (tokens ?? []) as { token: string }[]) {
      const result = await sendFcmPush(row.token, { title: copy.title, body: copy.body, data: { kind: copy.kind } });
      if (result.unregistered) await admin.from("cloud_push_tokens").delete().eq("token", row.token);
    }
  } catch (_) {
    // Push is intentionally best-effort after the durable email acknowledgement.
  }
}

async function drain(): Promise<Record<string, unknown>> {
  if (!RESEND_API_KEY) {
    const { data: health, error: healthError } = await admin.rpc(
      "branded_email_delivery_health",
    );
    return {
      configured: false,
      claimed: 0,
      sent: 0,
      retry_scheduled: 0,
      dead_letter: 0,
      lease_lost: 0,
      accepted_unacknowledged: 0,
      canceled: 0,
      ...(healthError ? {} : { health }),
    };
  }

  const { data, error } = await admin.rpc("claim_branded_email_deliveries", {
    p_batch: DELIVERY_BATCH,
    p_lease_seconds: 90,
    p_max_attempts: 12,
  });
  if (error) throw new Error(`branded_email_claim_failed:${error.code ?? "db_error"}`);
  const claims = (Array.isArray(data) ? data : []) as DeliveryClaim[];
  const result = {
    configured: true,
    claimed: claims.length,
    sent: 0,
    retry_scheduled: 0,
    dead_letter: 0,
    lease_lost: 0,
    accepted_unacknowledged: 0,
    canceled: 0,
  };

  for (let claimIndex = 0; claimIndex < claims.length; claimIndex++) {
    const claim = claims[claimIndex];
    const { data: authorized, error: authorizeError } = await admin.rpc(
      "authorize_branded_email_delivery",
      { p_id: claim.id, p_delivery_key: claim.delivery_key, p_lease_token: claim.lease_token },
    );
    if (authorizeError) {
      result.lease_lost++;
      console.error(`[norva-branded-email-worker] authorization CAS failed delivery=${claim.delivery_key}`);
      continue;
    }
    if (authorized !== true) {
      result.canceled++;
      continue;
    }
    const sent = await sendDelivery(claim);
    if (sent.accepted && sent.emailId) {
      const { data: completed, error: completeError } = await admin.rpc(
        "complete_branded_email_delivery",
        {
          p_id: claim.id,
          p_delivery_key: claim.delivery_key,
          p_lease_token: claim.lease_token,
          p_resend_email_id: sent.emailId,
          p_http_status: sent.status,
          p_response: sent.response,
        },
      );
      if (completeError || completed !== true) {
        // Never overwrite an accepted provider result with a failure. The lease
        // expires and the immutable Idempotency-Key safely reconciles it.
        result.accepted_unacknowledged++;
        console.error(`[norva-branded-email-worker] ack failed delivery=${claim.delivery_key}`);
        if (claimIndex < claims.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        continue;
      }
      result.sent++;
      await pushAfterAcknowledgement(claim);
      if (claimIndex < claims.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      continue;
    }

    const retryable = (sent.status !== null && sent.status >= 200 && sent.status <= 299) ||
      retryableResendStatus(sent.status, sent.response);
    const { data: failure, error: failError } = await admin.rpc(
      "fail_branded_email_delivery",
      {
        p_id: claim.id,
        p_delivery_key: claim.delivery_key,
        p_lease_token: claim.lease_token,
        p_http_status: sent.status,
        p_error: sent.error || "resend_delivery_failed",
        p_response: sent.response,
        // A 2xx response without an id is ambiguous and must remain replayable.
        p_retryable: retryable,
        p_ambiguous: ambiguousResendStatus(sent.status, retryable),
        p_retry_after_seconds: sent.retryAfterSeconds,
        p_max_attempts: 12,
      },
    );
    if (failError) {
      result.lease_lost++;
      console.error(`[norva-branded-email-worker] failure CAS failed delivery=${claim.delivery_key}`);
      if (claimIndex < claims.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      continue;
    }
    if (failure === "retry_scheduled") result.retry_scheduled++;
    else if (failure === "dead_letter") result.dead_letter++;
    else result.lease_lost++;
    if (sent.status === 429 && claimIndex < claims.length - 1) {
      const retryAfter = sent.retryAfterSeconds ?? 60;
      for (const deferred of claims.slice(claimIndex + 1)) {
        await admin.rpc("defer_branded_email_delivery", {
          p_id: deferred.id,
          p_delivery_key: deferred.delivery_key,
          p_lease_token: deferred.lease_token,
          p_retry_after_seconds: retryAfter,
        });
      }
      break;
    }
    // Resend's default limit is shared by every key in the team. Keep this
    // worker under four requests/second so auth/support traffic retains headroom.
    if (claimIndex < claims.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  const { data: health, error: healthError } = await admin.rpc("branded_email_delivery_health");
  return healthError ? result : { ...result, health };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "Service not configured" }, 500);
  const path = new URL(req.url).pathname.replace(/^.*\/norva-branded-email-worker/, "") || "/";
  if (path !== "/cron/drain") return json({ error: "Not found" }, 404);

  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: authorized, error: authError } = await admin.rpc("norva_verify_cron_secret", {
    presented: token,
  });
  if (authError || authorized !== true) return json({ error: "Unauthorized" }, 403);

  try {
    return json({ ok: true, ...(await drain()) });
  } catch (error) {
    console.error(
      "[norva-branded-email-worker] drain failed",
      error instanceof Error ? error.message.slice(0, 300) : "unknown_error",
    );
    return json({ error: "Drain failed" }, 500);
  }
});
