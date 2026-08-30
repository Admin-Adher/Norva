// Norva — account self-deletion endpoint (Google Play / GDPR requirement).
//
// Account deletion is always the primary action. Its confirmation email uses a
// durable two-phase outbox:
//   1. freeze the exact request while the authenticated email still exists;
//   2. auth.users AFTER DELETE activates it transactionally;
//   3. a dedicated cron claims, sends and acknowledges only a Resend 2xx + id.
// A prepared row can never send a false deletion confirmation, and no retry can
// repeat or roll back the account deletion itself.

import { createClient } from "npm:@supabase/supabase-js@2";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { isStaleDatabaseConflict } from "../_shared/database-conflict.ts";

type JsonRecord = Record<string, unknown>;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SECRET_KEY") ??
  "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const FROM = Deno.env.get("AUTH_EMAIL_FROM") ?? "Norva <support@norva.tv>";
const REPLY_TO = Deno.env.get("AUTH_EMAIL_REPLY_TO") ?? "support@norva.tv";
const DELIVERY_BATCH = 5;
const DELIVERY_SPACING_MS = 250;
const RECENT_AUTH_MAX_AGE_SECONDS = 15 * 60;
const AUTH_CLOCK_SKEW_SECONDS = 60;
const ENV_MEDIA_GATEWAY_URL = (Deno.env.get("NORVA_MEDIA_GATEWAY_URL") ?? "").replace(/\/+$/, "");
const ENV_MEDIA_GATEWAY_TOKEN = Deno.env.get("NORVA_MEDIA_GATEWAY_TOKEN") ?? "";

const DEFAULT_ALLOWED_ORIGINS = [
  "https://norva.tv",
  "https://www.norva.tv",
  "http://localhost:3000",
  "http://localhost:5173",
];

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function isLocalOrigin(origin: string): boolean {
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

function corsHeaders(req: Request) {
  const origin = req.headers.get("Origin");
  const configured = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const allowed = configured.length ? configured : DEFAULT_ALLOWED_ORIGINS;
  const allowAll = allowed.includes("*");
  const allowOrigin =
    origin && (allowAll || allowed.includes(origin) || isLocalOrigin(origin))
      ? origin
      : allowed[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(req: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(req),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

interface RenderedDeletionEmail {
  subject: string;
  html: string;
  text: string;
  tags: Array<{ name: "app" | "category" | "flow"; value: string }>;
}

function renderAccountDeleted(): RenderedDeletionEmail {
  const subject = "Your Norva account has been deleted";
  return {
    subject,
    text: `Your Norva account has been deleted

Access to your Norva account is now closed. Data directly associated with the account has been removed or de-identified according to our Privacy Policy. Norva may retain limited records where required by law or for security, fraud prevention and billing.

If you did not request this, contact support@norva.tv right away.

You can create a new account anytime at https://norva.tv.

Privacy Policy: https://norva.tv/privacy.html

© Norva`,
    tags: [
      { name: "app", value: "norva" },
      { name: "category", value: "transactional_auth" },
      { name: "flow", value: "account_deleted" },
    ],
    html: `<!doctype html>
<html lang="en" dir="ltr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="format-detection" content="telephone=no,date=no,address=no,email=no,url=no">
  <meta name="color-scheme" content="dark">
  <meta name="supported-color-schemes" content="dark">
  <title>${subject}</title>
</head>
<body style="margin:0;padding:0;background:#0a0c11;color:#f8fafc;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
  <div data-preheader="true" style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;max-height:0;max-width:0;overflow:hidden;mso-hide:all">Access to your Norva account is now closed.&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
  <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" bgcolor="#0a0c11" style="width:100%;background:#0a0c11;border-collapse:collapse">
    <tr><td align="center" style="padding:32px 16px">
      <table role="presentation" width="500" border="0" cellpadding="0" cellspacing="0" bgcolor="#11151d" style="width:100%;max-width:500px;background:#11151d;border:1px solid #283143;border-radius:16px;border-collapse:separate">
        <tr><td align="center" style="padding:32px 32px 8px">
          <img src="https://norva.tv/img/norva-app-icon.png" width="48" height="48" alt="" aria-hidden="true" style="display:block;width:48px;height:48px;border:0;border-radius:12px;outline:none;text-decoration:none">
          <p style="margin:10px 0 0;color:#ffffff;font-family:'Century Gothic',Arial,Helvetica,sans-serif;font-size:22px;font-weight:600;line-height:1.25">Norva</p>
        </td></tr>
        <tr><td align="center" style="padding:18px 32px 6px">
          <h1 style="margin:0;color:#f8fafc;font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:700;line-height:1.3">Your account has been deleted</h1>
        </td></tr>
        <tr><td style="padding:12px 32px 24px;color:#bcc5d6;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.65;text-align:center">
          Access to your Norva account is now closed. Data directly associated with the account has been removed or de-identified according to our <a href="https://norva.tv/privacy.html" style="color:#b8c8f2;text-decoration:underline">Privacy Policy</a>. Norva may retain limited records where required by law or for security, fraud prevention and billing.<br><br>
          If you did not request this, contact <a href="mailto:support@norva.tv" style="color:#b8c8f2;text-decoration:underline">support@norva.tv</a> right away.
        </td></tr>
        <tr><td style="padding:20px 32px 28px;border-top:1px solid #283143;color:#9ba6ba;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;text-align:center">
          You can create a new account anytime at <a href="https://norva.tv" style="color:#b8c8f2;text-decoration:underline">norva.tv</a>.
        </td></tr>
      </table>
      <p style="margin:16px 0 0;color:#8994a8;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.7;text-align:center">&copy; Norva</p>
    </td></tr>
  </table>
</body>
</html>`,
  };
}

interface DeletionDeliveryClaim {
  delivery_key: string;
  lease_token: string;
  recipient_email: string;
  request_from: string;
  request_reply_to: string;
  request_subject: string;
  request_html: string;
  request_text: string;
  request_tags: Array<{ name: string; value: string }>;
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

function redactDiagnosticText(value: unknown): string {
  let normalized = "";
  if (value instanceof Error) normalized = value.message;
  else if (typeof value === "string") normalized = value;
  else {
    try { normalized = JSON.stringify(value); } catch (_) { normalized = "unknown_error"; }
  }
  return normalized
    .replace(/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/giu, "[redacted-email]")
    .replace(/https?:\/\/\S+/giu, "[redacted-url]")
    .replace(/\b(?:Bearer\s+|re_|whsec_)[A-Za-z0-9._~+\/-]+/giu, "[redacted-secret]")
    .slice(0, 1000);
}

function errorText(value: unknown): string {
  return redactDiagnosticText(value) || "unknown_error";
}

type MediaGatewayConfig = { url: string; token: string };
let mediaGatewayConfigCache: { value: MediaGatewayConfig; expiresAt: number } | null = null;

async function resolveMediaGatewayConfig(db: SupabaseClient): Promise<MediaGatewayConfig> {
  if (ENV_MEDIA_GATEWAY_URL && ENV_MEDIA_GATEWAY_TOKEN) {
    return { url: ENV_MEDIA_GATEWAY_URL, token: ENV_MEDIA_GATEWAY_TOKEN };
  }
  if (mediaGatewayConfigCache && mediaGatewayConfigCache.expiresAt > Date.now()) {
    return mediaGatewayConfigCache.value;
  }

  let url = ENV_MEDIA_GATEWAY_URL;
  let token = ENV_MEDIA_GATEWAY_TOKEN;
  const { data, error } = await db
    .from("cloud_runtime_config")
    .select("key,value")
    .in("key", ["NORVA_MEDIA_GATEWAY_URL", "NORVA_MEDIA_GATEWAY_TOKEN"]);
  if (error) {
    console.error("[norva-account-delete] media gateway config unavailable", errorText(error));
  } else {
    for (const row of data ?? []) {
      if (row.key === "NORVA_MEDIA_GATEWAY_URL" && !url && typeof row.value === "string") {
        url = row.value.replace(/\/+$/, "");
      } else if (row.key === "NORVA_MEDIA_GATEWAY_TOKEN" && !token && typeof row.value === "string") {
        token = row.value;
      }
    }
  }

  const value = { url, token };
  mediaGatewayConfigCache = { value, expiresAt: Date.now() + 30_000 };
  return value;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function resendErrorName(payload: JsonRecord): string {
  const nested = payload.error && typeof payload.error === "object" && !Array.isArray(payload.error)
    ? payload.error as JsonRecord
    : null;
  return String(payload.name ?? payload.type ?? payload.code ?? nested?.name ?? nested?.type ?? nested?.code ?? "")
    .trim().toLowerCase();
}

function retryableResendStatus(status: number | null, payload: JsonRecord = {}): boolean {
  if (status === 409) return resendErrorName(payload) === "concurrent_idempotent_requests";
  return status === null || status === 401 || status === 403 || status === 408 || status === 425 || status === 429 || status >= 500;
}

function retryAfterSeconds(value: string | null): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Math.max(0, Math.min(21600, Number(value.trim())));
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.min(21600, Math.ceil((at - Date.now()) / 1000)));
}

function safeResendResponse(payload: JsonRecord, emailId: string | null): JsonRecord {
  if (emailId) return { id: emailId };
  const nestedError = payload.error && typeof payload.error === "object" && !Array.isArray(payload.error)
    ? payload.error as JsonRecord
    : null;
  const result: JsonRecord = {};
  for (const key of ["name", "type", "code", "statusCode"] as const) {
    const value = payload[key] ?? nestedError?.[key];
    if (typeof value === "string" || typeof value === "number") {
      result[key] = redactDiagnosticText(value).slice(0, 200);
    }
  }
  const message = payload.message ?? nestedError?.message ?? payload.error;
  if (message !== undefined && message !== null) result.message = errorText(message);
  return result;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

type AuthenticationMethod = { method?: unknown; timestamp?: unknown };
type AccountDeletionFinalizationClaim = { user_id?: unknown; finalization_key?: unknown };

async function deletionAuthenticationGuard(token: string): Promise<
  | { ok: true }
  | { ok: false; status: number; code: string; message: string }
> {
  const { data, error } = await admin.auth.mfa.getAuthenticatorAssuranceLevel(token);
  if (error || !data) {
    console.error("[norva-account-delete] authentication assurance unavailable", errorText(error));
    return {
      ok: false,
      status: 503,
      code: "authentication_assurance_unavailable",
      message: "We could not verify your sign-in security. Please try again.",
    };
  }

  if (data.nextLevel === "aal2" && data.currentLevel !== "aal2") {
    return {
      ok: false,
      status: 403,
      code: "mfa_verification_required",
      message: "Complete your second-factor verification before deleting your account.",
    };
  }

  const now = Math.floor(Date.now() / 1000);
  const latestInteractiveAuthentication = ((data.currentAuthenticationMethods ?? []) as AuthenticationMethod[])
    .filter((entry) => {
      const method = typeof entry?.method === "string" ? entry.method.trim().toLowerCase() : "";
      return Boolean(method) && method !== "token_refresh" && method !== "anonymous";
    })
    .map((entry) => Number(entry.timestamp))
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp <= now + AUTH_CLOCK_SKEW_SECONDS)
    .reduce((latest, timestamp) => Math.max(latest, timestamp), 0);

  if (!latestInteractiveAuthentication || now - latestInteractiveAuthentication > RECENT_AUTH_MAX_AGE_SECONDS) {
    return {
      ok: false,
      status: 403,
      code: "reauthentication_required",
      message: "Sign in again before deleting your account.",
    };
  }
  return { ok: true };
}

async function sendDeletionEmail(claim: DeletionDeliveryClaim): Promise<ResendResult> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "User-Agent": "Norva-Account-Delete/2.0",
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
      }),
      signal: AbortSignal.timeout(8_000),
    });
    const raw = await res.text();
    let payload: JsonRecord = {};
    try {
      const parsed = raw ? JSON.parse(raw) : {};
      payload = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as JsonRecord
        : { response: String(parsed).slice(0, 1000) };
    } catch (_) {
      payload = raw ? { response: raw.slice(0, 1000) } : {};
    }
    const emailId = stringOrNull(payload.id);
    const safeResponse = safeResendResponse(payload, emailId);
    return {
      accepted: res.ok && Boolean(emailId),
      status: res.status,
      emailId,
      response: safeResponse,
      error: res.ok && emailId ? "" : errorText(payload.error ?? payload.message ?? `resend_http_${res.status}`),
      retryAfterSeconds: retryAfterSeconds(res.headers.get("retry-after")),
    };
  } catch (error) {
    return {
      accepted: false,
      status: null,
      emailId: null,
      response: {},
      error: errorText(error),
      retryAfterSeconds: null,
    };
  }
}

async function drainDeletionEmailOutbox(db: SupabaseClient): Promise<Record<string, number | boolean>> {
  if (!RESEND_API_KEY) {
    return { configured: false, claimed: 0, sent: 0, retry_scheduled: 0, dead_letter: 0, lease_lost: 0 };
  }

  const { data, error } = await db.rpc("claim_account_deletion_email_deliveries", {
    p_batch: DELIVERY_BATCH,
    p_lease_seconds: 90,
    p_max_attempts: 12,
  });
  if (error) throw new Error(`account_deletion_email_claim_failed:${error.message}`);
  const claims = (Array.isArray(data) ? data : []) as DeletionDeliveryClaim[];
  const result = {
    configured: true,
    claimed: claims.length,
    sent: 0,
    retry_scheduled: 0,
    dead_letter: 0,
    lease_lost: 0,
    accepted_unacknowledged: 0,
  };

  let networkAttempts = 0;
  let sharedRetryAfterSeconds: number | null = null;
  for (const claim of claims) {
    let sent: ResendResult;
    if (sharedRetryAfterSeconds !== null) {
      sent = {
        accepted: false,
        status: 429,
        emailId: null,
        response: { code: "resend_team_rate_limited" },
        error: "resend_team_rate_limited_before_send",
        retryAfterSeconds: sharedRetryAfterSeconds,
      };
    } else {
      if (networkAttempts > 0) await sleep(DELIVERY_SPACING_MS);
      sent = await sendDeletionEmail(claim);
      networkAttempts++;
      if (sent.status === 429) {
        // Resend's 5 req/s limit is team-wide. Do not consume the rest of this
        // claimed batch while another Norva sender is throttled.
        sharedRetryAfterSeconds = Math.max(1, sent.retryAfterSeconds ?? 60);
      }
    }
    if (sent.accepted && sent.emailId) {
      const { data: completed, error: completeError } = await db.rpc("complete_account_deletion_email_delivery", {
        p_delivery_key: claim.delivery_key,
        p_lease_token: claim.lease_token,
        p_resend_email_id: sent.emailId,
        p_http_status: sent.status,
        p_response: sent.response,
      });
      if (completeError || completed !== true) {
        // Provider acceptance is immutable. Leave the lease intact so the same
        // Idempotency-Key reconciles within the bounded replay window. SQL
        // quarantines it before the provider's 24-hour idempotency key expires.
        result.accepted_unacknowledged++;
        console.error("[norva-account-delete] accepted delivery acknowledgement failed", claim.delivery_key);
        continue;
      }
      result.sent++;
      continue;
    }

    const { data: failed, error: failError } = await db.rpc("fail_account_deletion_email_delivery", {
      p_delivery_key: claim.delivery_key,
      p_lease_token: claim.lease_token,
      p_http_status: sent.status,
      p_error: sent.error || "resend_delivery_failed",
      p_response: sent.response,
      p_retryable: (sent.status !== null && sent.status >= 200 && sent.status <= 299)
        || retryableResendStatus(sent.status, sent.response),
      p_retry_after_seconds: sent.retryAfterSeconds,
      p_max_attempts: 12,
    });
    if (failError) {
      result.lease_lost++;
      console.error("[norva-account-delete] delivery failure CAS failed", claim.delivery_key, failError.message);
    } else if (failed === "dead_letter") {
      result.dead_letter++;
      console.error("[norva-account-delete] delivery dead-lettered", claim.delivery_key, sent.status);
    } else if (failed === "retry_scheduled") result.retry_scheduled++;
    else result.lease_lost++;
  }

  return result;
}

async function drainAccountDeletionFinalizations(db: SupabaseClient) {
  const { data: reconciledData, error: reconciledError } = await db.rpc(
    "norva_reconcile_account_deletion_finalizations",
    { p_batch: 25 },
  );
  if (reconciledError) throw new Error(`account_deletion_finalization_reconcile_failed:${reconciledError.message}`);
  const reconciled = typeof reconciledData === "number" ? reconciledData : 0;
  const { data, error } = await db.rpc("norva_claim_account_deletion_finalizations", {
    p_batch: 5,
    p_lease_seconds: 120,
  });
  if (error) throw new Error(`account_deletion_finalization_claim_failed:${error.message}`);
  const claims = (Array.isArray(data) ? data : []) as AccountDeletionFinalizationClaim[];
  let completed = 0;
  let deferred = 0;
  for (const claim of claims) {
    const userId = typeof claim.user_id === "string" ? claim.user_id : "";
    const finalizationKey = typeof claim.finalization_key === "string" ? claim.finalization_key : "";
    if (!userId || !finalizationKey) {
      deferred++;
      continue;
    }
    // This is the sole Auth delete path.  The SQL claim has already checked
    // READY_TO_FINALIZE and the BEFORE DELETE guard rechecks FINALIZING.
    const { error: deletionError } = await db.auth.admin.deleteUser(userId);
    if (deletionError) {
      console.error("[norva-account-delete] finalization Auth delete deferred", deletionError.message);
      deferred++;
      continue;
    }
    const { data: complete, error: completeError } = await db.rpc(
      "norva_complete_account_deletion_finalization",
      { p_finalization_key: finalizationKey },
    );
    if (completeError || complete !== true) {
      // Auth is already absent. A later reconciliation can complete the
      // tombstone, but must never issue another delete to repair this ack gap.
      console.error("[norva-account-delete] finalization acknowledgement deferred", completeError?.message ?? "not_completed");
      deferred++;
      continue;
    }
    completed++;
  }
  return { reconciled, claimed: claims.length, completed, deferred };
}

async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function drainProviderTransportStop(db: SupabaseClient, userId: string) {
  // Self-hosted Edge intentionally keeps these environment variables empty;
  // cloud_runtime_config is the established secret-backed runtime fallback.
  // Resolve it before claiming so a transient configuration read cannot strand
  // an action under a processing lease.
  const mediaGateway = await resolveMediaGatewayConfig(db);
  const worker = "norva-account-delete-cron-v1";
  const { data, error } = await db.rpc("norva_claim_account_deletion_transport_stop", {
    p_user_id: userId, p_worker: worker, p_lease_seconds: 120,
  });
  if (error) {
    if (isStaleDatabaseConflict(error)) return "stale";
    throw new Error(`account_deletion_transport_claim_failed:${error.message}`);
  }
  const claim = (data && typeof data === "object" ? data : {}) as JsonRecord;
  if (claim.state === "completed") return "completed";
  const leaseSequence = typeof claim.leaseSequence === "number" ? claim.leaseSequence : -1;
  const revision = typeof claim.revision === "number" ? claim.revision : -1;
  const epoch = typeof claim.deletionEpoch === "number" ? claim.deletionEpoch : -1;
  if (claim.state !== "processing" || leaseSequence < 0 || revision < 0 || epoch < 0) return "stale";
  if (!mediaGateway.url || !mediaGateway.token) {
    await db.rpc("norva_settle_provider_transport_stop_action", {
      p_user_id: userId, p_worker: worker, p_expected_lease_sequence: leaseSequence,
      p_expected_revision: revision, p_outcome: "retry", p_error_code: "gateway_unconfigured", p_retry_after_seconds: 60,
    });
    return "deferred";
  }
  // Claiming only grants permission to try. Revalidate under the durable
  // account/transport fences immediately before the gateway effect so an old
  // worker cannot stop anything after an epoch, lease, revision, or state bump.
  const { data: revalidatedData, error: revalidateError } = await db.rpc(
    "norva_revalidate_account_deletion_transport_stop",
    {
      p_user_id: userId, p_worker: worker, p_expected_deletion_epoch: epoch,
      p_expected_lease_sequence: leaseSequence, p_expected_revision: revision,
    },
  );
  if (isStaleDatabaseConflict(revalidateError)) return "stale";
  if (revalidateError) throw new Error(`account_deletion_transport_revalidate_failed:${revalidateError.message}`);
  const revalidated = (revalidatedData && typeof revalidatedData === "object" ? revalidatedData : {}) as JsonRecord;
  const revalidatedAffinities = Array.isArray(revalidated.affinityHashes)
    ? revalidated.affinityHashes.filter((value): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))
    : [];
  if (revalidated.state !== "processing"
      || revalidated.deletionEpoch !== epoch
      || revalidated.leaseSequence !== leaseSequence
      || revalidated.revision !== revision) return "stale";
  // No persisted affinity means this account owns no gateway-addressable
  // provider transport. The SQL settle still proves that no live capability
  // exists before completing; do not send an invalid empty gateway request.
  if (revalidatedAffinities.length === 0) {
    const receipt = await sha256Hex(`provider-transport-stop:v1:${userId}:${epoch}:${leaseSequence}:${revision}`);
    const { error: settleError } = await db.rpc("norva_settle_provider_transport_stop_action", {
      p_user_id: userId, p_worker: worker, p_expected_lease_sequence: leaseSequence,
      p_expected_revision: revision, p_outcome: "completed", p_transport_stop_receipt_hash: receipt,
      p_error_code: null, p_retry_after_seconds: 0,
    });
    if (isStaleDatabaseConflict(settleError)) return "stale";
    if (settleError) throw new Error(`account_deletion_transport_settle_failed:${settleError.message}`);
    return "completed";
  }
  const response = await fetch(`${mediaGateway.url}/sessions/stop-provider-affinities`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${mediaGateway.token}` },
    body: JSON.stringify({ affinityHashes: revalidatedAffinities }),
  });
  const result = await response.json().catch(() => ({})) as JsonRecord;
  if (!response.ok || result.providerDrained !== true) {
    await db.rpc("norva_settle_provider_transport_stop_action", {
      p_user_id: userId, p_worker: worker, p_expected_lease_sequence: leaseSequence,
      p_expected_revision: revision, p_outcome: "retry", p_error_code: "gateway_stop_deferred", p_retry_after_seconds: 15,
    });
    return "deferred";
  }
  const receipt = await sha256Hex(`provider-transport-stop:v1:${userId}:${epoch}:${leaseSequence}:${revision}`);
  const { error: settleError } = await db.rpc("norva_settle_provider_transport_stop_action", {
    p_user_id: userId, p_worker: worker, p_expected_lease_sequence: leaseSequence,
    p_expected_revision: revision, p_outcome: "completed", p_transport_stop_receipt_hash: receipt,
    p_error_code: null, p_retry_after_seconds: 0,
  });
  if (isStaleDatabaseConflict(settleError)) return "stale";
  if (settleError) throw new Error(`account_deletion_transport_settle_failed:${settleError.message}`);
  return "completed";
}

async function drainProviderAccountDeletionPreparation(db: SupabaseClient, userId: string) {
  const worker = "norva-account-delete-cron-v1";
  const { data, error } = await db.rpc("norva_claim_provider_account_deletion_prepare", {
    p_user_id: userId,
    p_worker: worker,
    p_lease_seconds: 120,
  });
  if (error) {
    if (isStaleDatabaseConflict(error)) return "stale";
    throw new Error(`account_deletion_provider_prepare_claim_failed:${error.message}`);
  }
  const claim = (data && typeof data === "object" ? data : {}) as JsonRecord;
  if (claim.state === "ready" && claim.ready === true) return "completed";
  const leaseSequence = typeof claim.leaseSequence === "number" ? claim.leaseSequence : -1;
  const revision = typeof claim.revision === "number" ? claim.revision : -1;
  if (claim.state !== "processing" || leaseSequence < 0 || revision < 0) return "stale";

  const { data: batchData, error: batchError } = await db.rpc(
    "norva_run_provider_account_deletion_prepare_batch",
    {
      p_user_id: userId,
      p_worker: worker,
      p_expected_lease_sequence: leaseSequence,
      p_expected_revision: revision,
      p_limit: 500,
    },
  );
  if (batchError) {
    if (isStaleDatabaseConflict(batchError)) return "stale";
    throw new Error(`account_deletion_provider_prepare_batch_failed:${batchError.message}`);
  }
  const batch = (batchData && typeof batchData === "object" ? batchData : {}) as JsonRecord;
  if (batch.state === "ready" && batch.ready === true) return "completed";
  const nextRevision = typeof batch.revision === "number" ? batch.revision : -1;
  if (batch.state !== "processing" || nextRevision < 0) return "stale";

  // Release the lease after exactly one bounded batch. A later cron tick can
  // resume from the durable cursor without waiting for lease expiry.
  const { error: checkpointError } = await db.rpc(
    "norva_checkpoint_provider_account_deletion_prepare",
    {
      p_user_id: userId,
      p_worker: worker,
      p_expected_lease_sequence: leaseSequence,
      p_expected_revision: nextRevision,
      p_retry_after_seconds: 0,
    },
  );
  if (checkpointError) {
    if (isStaleDatabaseConflict(checkpointError)) return "stale";
    throw new Error(`account_deletion_provider_prepare_checkpoint_failed:${checkpointError.message}`);
  }
  return "advanced";
}

// Drive exactly one durable, bounded DB step for each account.  Provider
// transport-stop execution and provider-subgraph cleanup each retain their own
// claim/CAS protocol. Until both durable proofs exist the account stays in
// DRAINING and cannot advance to any account purge or Auth-finalization step.
async function drainAccountDeletionWorkflows(db: SupabaseClient) {
  const { data, error } = await db.rpc("norva_claim_account_deletion_workflows", {
    p_batch: 10,
  });
  if (error) throw new Error(`account_deletion_workflow_claim_failed:${error.message}`);
  const claims = (Array.isArray(data) ? data : []) as Array<{
    user_id?: unknown;
    revision?: unknown;
  }>;
  let advanced = 0;
  let batches = 0;
  let transportStops = 0;
  let providerBatches = 0;
  let stale = 0;
  for (const claim of claims) {
    const userId = typeof claim.user_id === "string" ? claim.user_id : "";
    const revision = typeof claim.revision === "number" ? claim.revision : -1;
    if (!userId || !Number.isSafeInteger(revision) || revision < 0) {
      stale++;
      continue;
    }
    const { data: nextData, error: nextError } = await db.rpc(
      "norva_advance_account_deletion_workflow",
      { p_user_id: userId, p_expected_revision: revision, p_batch_size: 500 },
    );
    // Revision CAS failures are expected under duplicate schedulers. They are
    // STALE/no-op, never an invitation to retry with a guessed revision.
    if (nextError) {
      if (isStaleDatabaseConflict(nextError)) stale++;
      else throw new Error(`account_deletion_workflow_advance_failed:${nextError.message}`);
      continue;
    }
    if (!nextData || typeof nextData !== "object") {
      stale++;
      continue;
    }
    if ((nextData as JsonRecord).nextAction === "provider_drain") {
      const transport = await drainProviderTransportStop(db, userId);
      if (transport === "completed") {
        transportStops++;
        const preparation = await drainProviderAccountDeletionPreparation(db, userId);
        if (preparation === "completed" || preparation === "advanced") providerBatches++;
        else if (preparation === "stale") stale++;
      }
    }
    advanced++;
    const next = nextData as JsonRecord;
    const nextRevision = typeof next.revision === "number" ? next.revision : -1;
    const action = typeof next.nextAction === "string" ? next.nextAction : "";
    if (!Number.isSafeInteger(nextRevision) || nextRevision < 0) {
      stale++;
      continue;
    }
    if (action === "purge_paywall_events") {
      const { error: batchError } = await db.rpc(
        "norva_purge_account_deletion_paywall_batch",
        { p_user_id: userId, p_expected_revision: nextRevision, p_limit: 500 },
      );
      if (batchError) {
        if (isStaleDatabaseConflict(batchError)) stale++;
        else throw new Error(`account_deletion_paywall_batch_failed:${batchError.message}`);
      } else batches++;
    } else if (action === "purge_product") {
      const { error: batchError } = await db.rpc(
        "norva_purge_account_deletion_product_batch",
        { p_user_id: userId, p_expected_revision: nextRevision, p_limit: 500 },
      );
      if (batchError) {
        if (isStaleDatabaseConflict(batchError)) stale++;
        else throw new Error(`account_deletion_product_batch_failed:${batchError.message}`);
      } else batches++;
    }
  }
  return { claimed: claims.length, advanced, batches, transportStops, providerBatches, stale };
}

async function cronAuthorized(req: Request): Promise<boolean> {
  const token = (req.headers.get("Authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  if (!token) return false;
  const { data, error } = await admin.rpc("norva_verify_cron_secret", { presented: token });
  return !error && data === true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }
  if (req.method !== "POST") {
    return json(req, { error: "Method not allowed" }, 405);
  }

  const isCron = new URL(req.url).pathname.endsWith("/cron/run");
  if (isCron) {
    if (!(await cronAuthorized(req))) return json(req, { error: "Unauthorized" }, 403);
    try {
      const [email, finalization] = await Promise.all([
        drainDeletionEmailOutbox(admin),
        drainAccountDeletionFinalizations(admin),
      ]);
      const workflow = await drainAccountDeletionWorkflows(admin);
      return json(req, { ok: true, email, workflow, finalization });
    } catch (error) {
      console.error("[norva-account-delete] delivery worker failed", errorText(error));
      return json(req, { error: "Delivery worker failed" }, 500);
    }
  }

  // Authenticate the caller from their Supabase JWT.
  const token = (req.headers.get("Authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return json(req, { error: "Missing bearer token" }, 401);

  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData.user) {
    return json(req, { error: "Invalid or expired session" }, 401);
  }
  const user = userData.user;

  // Require explicit confirmation so a stray POST can never wipe an account.
  let confirm = "";
  try {
    const body = await req.json();
    confirm = typeof body?.confirm === "string" ? body.confirm.trim() : "";
  } catch (_) {
    // The validation below returns the public 400 response.
  }
  const email = (user.email ?? "").trim().toLowerCase();
  if (confirm !== "DELETE" && (!email || confirm.toLowerCase() !== email)) {
    return json(req, {
      error: "Confirmation required",
      hint: 'POST { "confirm": "DELETE" } or { "confirm": "<your account email>" }',
    }, 400);
  }

  const authenticationGuard = await deletionAuthenticationGuard(token);
  if (!authenticationGuard.ok) {
    return json(req, {
      error: authenticationGuard.message,
      code: authenticationGuard.code,
    }, authenticationGuard.status);
  }

  // Email infrastructure never blocks the primary deletion. When available, the
  // exact payload is frozen first but remains non-deliverable until auth deletion.
  let deliveryKey: string | null = null;
  if (email) {
    const rendered = renderAccountDeleted();
    const { data, error } = await admin.rpc("prepare_account_deletion_email", {
      p_user_id: user.id,
      p_recipient_email: email,
      p_request_from: FROM,
      p_request_reply_to: REPLY_TO,
      p_request_subject: rendered.subject,
      p_request_html: rendered.html,
      p_request_text: rendered.text,
      p_request_tags: rendered.tags,
    });
    if (error || typeof data !== "string" || !data) {
      console.error("[norva-account-delete] confirmation preparation unavailable", error?.message ?? "empty_result");
    } else {
      deliveryKey = data;
    }
  }

  // Partners has legally retained attribution/financial records that cannot
  // cascade. Minimize and unlink them atomically through the server-only RPC.
  // This step is fail-closed and idempotent: auth deletion never starts unless
  // the database confirms that every direct user/device reference is gone.
  const {
    data: partnersPreparationData,
    error: partnersPreparationError,
  } = await admin.rpc("partners_service_prepare_account_deletion", {
    p_user_id: user.id,
  });
  const partnersPreparation =
    (partnersPreparationData ?? {}) as JsonRecord;
  if (
    !partnersPreparationError
    && partnersPreparation.action
      === "partners_account_deletion_pending_financial_closure"
    && partnersPreparation.ready === false
  ) {
    if (deliveryKey) {
      const { error: cancelError } = await admin.rpc(
        "cancel_prepared_account_deletion_email",
        { p_delivery_key: deliveryKey },
      );
      if (cancelError) {
        console.error(
          "[norva-account-delete] prepared confirmation cleanup failed",
          cancelError.message,
        );
      }
    }
    return json(req, {
      error:
        "Account deletion is pending completion of required financial operations",
      code: "partners_financial_closure_pending",
      nextAction: "contact_support",
    }, 409);
  }
  if (
    partnersPreparationError
    || partnersPreparation.action !== "partners_account_deletion_prepared"
    || partnersPreparation.ready !== true
  ) {
    console.error(
      "[norva-account-delete] Partners deletion preparation failed",
      partnersPreparationError?.message ?? "invalid_preparation_envelope",
    );
    if (deliveryKey) {
      const { error: cancelError } = await admin.rpc(
        "cancel_prepared_account_deletion_email",
        { p_delivery_key: deliveryKey },
      );
      if (cancelError) {
        console.error(
          "[norva-account-delete] prepared confirmation cleanup failed",
          cancelError.message,
        );
      }
    }
    return json(req, { error: "Deletion preparation failed" }, 500);
  }

  // The Auth row is deliberately retained here.  This request only enters the
  // durable deletion machine: it raises the account/source provider fences and
  // creates the transport-stop action.  A later bounded worker must prove
  // drain, analytics purge, legal archival and product purge before the final
  // Auth delete can be attempted.
  const { data: deletionData, error: deletionError } = await admin.rpc(
    "norva_begin_account_deletion_workflow",
    { p_user_id: user.id },
  );
  if (deletionError || !deletionData || typeof deletionData !== "object") {
    console.error(
      "[norva-account-delete] durable deletion begin failed",
      deletionError?.message ?? "invalid_begin_envelope",
    );
    return json(req, { error: "Deletion preparation failed" }, 500);
  }

  const deletion = deletionData as JsonRecord;
  // No deleted UUID/email is echoed or retained in the API response.  The
  // client can safely retry this request: begin is idempotent for one account.
  return json(req, {
    ok: true,
    deletionPending: true,
    state: deletion.state,
    providerState: deletion.providerState,
    providerPhase: deletion.providerPhase,
    readyToFinalize: deletion.readyToFinalize === true,
  }, 202);
});
